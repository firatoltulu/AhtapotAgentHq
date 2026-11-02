import { and, desc, eq } from "drizzle-orm";

import {
  BRAND,
  ProjectProfileSchema,
  type ProjectProfile,
  scrubSecrets,
  type JobState,
  type ServerEvent,
} from "@ahtapot/shared";

import { activeProfile } from "../analyst/analyst.js";
import { newId, schema, type Db } from "../db/index.js";
import type { EventHub } from "../ws/hub.js";
import { renderWorkedTime, workedTime } from "./duration.js";
import { stageOf } from "./stages.js";
import { SYNC_MARKER, type ExternalRef, type IssueTracker, type VerdictLabels } from "./types.js";

export interface TrackerSyncOptions {
  /** Ahtapot UI kökü — yorumlardaki iş linki ve rozet buradan kurulur. */
  publicUrl?: string | undefined;
  log: (obj: Record<string, unknown>, msg: string) => void;
}

type Job = typeof schema.jobs.$inferSelect;
type TrackerCfg = ProjectProfile["tracker"];

/** Motorun kapı kararı — senkron motoru bilmez, uygulama bağlar. */
export type VerdictDecider = (gateId: string, decision: "approve" | "reject", comment: string, actor: string) => void;

/**
 * İşi, açıldığı takip kaydıyla (issue) senkron tutar.
 *
 * Bildirimle aynı desen: tetikler hub olaylarından türer, motor takipçiyi
 * bilmez. Yan etkiler dış bir servise gider ve yavaştır; iş akışını asla
 * bekletmez, hatası işe taşmaz — yalnız loglanır ve sonraki olayda yeniden
 * denenir (anahtar yalnız başarıda yazılır, bkz. `external_sync`).
 *
 * Olaylar iş başına SIRAYLA işlenir: etiket değiştirme oku-yaz yapıyor, iki
 * geçiş yarışırsa eski aşamanın etiketi kalırdı.
 */
export class TrackerSync {
  private readonly bySource: Map<string, IssueTracker>;
  private readonly chains = new Map<string, Promise<void>>();
  private warnedNoUrl = false;
  private polling = false;

  constructor(
    private readonly db: Db,
    trackers: IssueTracker[],
    private readonly opts: TrackerSyncOptions,
  ) {
    this.bySource = new Map(trackers.map((t) => [t.source, t]));
  }

  attach(hub: EventHub): () => void {
    return hub.onEmit((e) => {
      const relevant =
        e.type === "job.state" ||
        (e.type === "approval.required" && e.kind === "live_test") ||
        // PR açılışının kendi olayı yok; motor ardından sistem notu düşüyor.
        (e.type === "agent.message" && e.role === "system");
      if (relevant) this.enqueue(e.jobId, () => this.handle(e));
    });
  }

  /**
   * Canlı test kapısında bekleyen işlerin issue'larını karar etiketi için yoklar.
   *
   * Webhook yerine yoklama: webhook sunucunun dışarı açık olmasını istiyor,
   * Ahtapot çoğu kurulumda iç ağda. Yalnız bekleyen `live_test` kapıları
   * yoklandığı için tur başına birkaç `gh` çağrısı. Dönen fonksiyon durdurur.
   */
  watchVerdicts(decide: VerdictDecider, intervalMs = 45_000): () => void {
    const timer = setInterval(() => void this.pollVerdicts(decide), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Tek yoklama turu — test de bunu doğrudan çağırır. */
  async pollVerdicts(decide: VerdictDecider): Promise<void> {
    // Önceki tur `gh` bekliyorsa üst üste binmesin.
    if (this.polling) return;
    this.polling = true;
    try {
      const gates = this.db
        .select({ id: schema.approvals.id, jobId: schema.approvals.jobId, requestedAt: schema.approvals.requestedAt })
        .from(schema.approvals)
        .where(and(eq(schema.approvals.kind, "live_test"), eq(schema.approvals.status, "pending")))
        .all();
      for (const g of gates) {
        if (!g.jobId) continue;
        const jobId = g.jobId;
        // İşin diğer senkronlarıyla aynı sıraya: etiket sökme ile kapı hazırlığı yarışmasın.
        this.enqueue(jobId, () => this.verdict(jobId, g.id, g.requestedAt, decide));
      }
      await this.idle();
    } finally {
      this.polling = false;
    }
  }

  private async verdict(jobId: string, gateId: string, since: string, decide: VerdictDecider): Promise<void> {
    const job = this.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    if (!job) return;
    const tracker = this.bySource.get(job.source);
    const cfg = this.profileOf(job)?.tracker;
    if (!tracker?.readVerdict || !cfg?.enabled || !cfg.verdictLabels) return;
    // Kuyrukta beklerken UI'dan karar verilmiş olabilir.
    const gate = this.db.select({ status: schema.approvals.status }).from(schema.approvals).where(eq(schema.approvals.id, gateId)).get();
    if (gate?.status !== "pending") return;

    const ref = this.refOf(job);
    const labels = verdictLabels(cfg);
    const r = await tracker.readVerdict(ref, labels, since);
    if (!r.approve && !r.fix) return;
    if (r.approve && r.fix) {
      await this.once(jobId, `verdict-both:${gateId}`, () =>
        tracker.comment(ref, this.body(jobId, `⚠️ Hem \`${labels.approve}\` hem \`${labels.fix}\` etiketi var — birini kaldırın.`)),
      );
      return;
    }
    if (r.approve) {
      decide(gateId, "approve", `GitHub etiketi: ${labels.approve}`, "github-label");
    } else {
      // Notsuz red Developer'a "(gerekçe verilmedi)" gönderir — bir tur boşa gider.
      if (r.notes.length === 0) {
        await this.once(jobId, `verdict-note:${gateId}`, () =>
          tracker.comment(ref, this.body(jobId, `✍️ \`${labels.fix}\` etiketi görüldü. Neyin düzeltileceğini bu issue'ya yorum olarak yazın; yorum gelince geliştirmeye dönülür.`)),
        );
        return;
      }
      decide(gateId, "reject", r.notes.join("\n\n"), "github-label");
    }
    // Karar verildi; etiket sökülemezse bir sonraki kapının hazırlığı söker.
    await tracker.clearVerdict?.(ref, labels);
  }

  private refOf(job: Job): ExternalRef {
    return { jobId: job.id, projectId: job.projectId, externalRef: job.externalRef, externalUrl: job.externalUrl };
  }

  /** Test ve kapanış için: bekleyen tüm senkronlar bitsin. */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private enqueue(jobId: string, fn: () => Promise<void>): void {
    const prev = this.chains.get(jobId) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch((err: unknown) => {
        this.opts.log({ jobId, err: err instanceof Error ? err.message : String(err) }, "issue senkronu başarısız");
      })
      .finally(() => {
        if (this.chains.get(jobId) === next) this.chains.delete(jobId);
      });
    this.chains.set(jobId, next);
  }

  private async handle(e: ServerEvent): Promise<void> {
    const job = this.db.select().from(schema.jobs).where(eq(schema.jobs.id, e.jobId)).get();
    if (!job) return;
    const tracker = this.bySource.get(job.source);
    if (!tracker) return;
    const cfg = this.profileOf(job)?.tracker;
    if (!cfg?.enabled) return;
    const ref = this.refOf(job);

    if (e.type === "job.state") {
      const tr = this.db
        .select()
        .from(schema.jobTransitions)
        // OLAYIN durumuna giren son geçiş — işin en son geçişi değil. Senkron
        // kuyrukta sonradan koşar; motor aynı tick'te iki `move` yapabiliyor
        // (`enterQa`: QACases → QA) ve ilk olay ikinci geçişi okuyup atlanıyordu.
        .where(and(eq(schema.jobTransitions.jobId, job.id), eq(schema.jobTransitions.toState, e.state)))
        .orderBy(desc(schema.jobTransitions.createdAt), desc(schema.jobTransitions.id))
        .get();
      // Faz değişimi de `job.state` yayınlar; aynı geçişi bulur ve `once`
      // anahtarı (`tr.id`) yan etkiyi tekrarlatmaz.
      if (!tr) return;
      const to = tr.toState as JobState;
      if (tr.fromState === "Draft" && cfg.assignOnStart) {
        await this.once(job.id, "assign:self", () => tracker.assignToSelf(ref));
      }
      if (cfg.statusLabels) {
        await this.once(job.id, `stage:${tr.id}`, () => tracker.setStage(ref, stageOf(to), cfg.labelPrefix));
      }
      const text = cfg.comments ? this.transitionText(job, tr.fromState, to, tr.reason) : null;
      if (text) await this.once(job.id, `transition:${tr.id}`, () => tracker.comment(ref, this.body(job.id, text)));
      if (to === "Done" && cfg.closeOnMerge && this.mergedPr(job.id)) {
        await this.once(job.id, "close", () => tracker.close(ref));
      }
      if (to === "CIWatch") await this.prOpened(job, ref, tracker, cfg.comments);
      return;
    }

    if (e.type === "approval.required") {
      const p = (e.payload ?? {}) as { appUrl?: string; publicUrl?: string; round?: number };
      if (cfg.reassignOnLiveTest) {
        await this.once(job.id, `live-assign:${e.gateId}`, () => tracker.assignToReporter(ref));
      }
      const byLabel = cfg.verdictLabels && !!tracker.prepareVerdict;
      if (byLabel) {
        await this.once(job.id, `verdict-prep:${e.gateId}`, () => tracker.prepareVerdict!(ref, verdictLabels(cfg)));
      }
      if (cfg.comments) {
        await this.once(job.id, `live:${e.gateId}`, () =>
          tracker.comment(ref, this.body(job.id, this.liveText(job.id, p, byLabel ? verdictLabels(cfg) : null))),
        );
      }
      return;
    }

    if (job.state === "CIWatch") await this.prOpened(job, ref, tracker, cfg.comments);
  }

  private async prOpened(job: Job, ref: ExternalRef, tracker: IssueTracker, comments: boolean): Promise<void> {
    if (!comments) return;
    const pr = this.db
      .select({ id: schema.pullRequests.id, url: schema.pullRequests.url, number: schema.pullRequests.number })
      .from(schema.pullRequests)
      .where(eq(schema.pullRequests.jobId, job.id))
      .orderBy(desc(schema.pullRequests.createdAt))
      .get();
    if (!pr) return;
    await this.once(job.id, `pr:${pr.id}`, () =>
      tracker.comment(ref, this.body(job.id, `🚀 PR açıldı: ${pr.url} — CI izleniyor.`)),
    );
  }

  /** Yan etkiyi bir kez uygular; anahtar yalnız başarıda yazılır. */
  private async once(jobId: string, key: string, fn: () => Promise<void>): Promise<void> {
    const done = this.db
      .select({ id: schema.externalSync.id })
      .from(schema.externalSync)
      .where(and(eq(schema.externalSync.jobId, jobId), eq(schema.externalSync.key, key)))
      .get();
    if (done) return;
    await fn();
    this.db.insert(schema.externalSync).values({ id: newId(), jobId, key }).onConflictDoNothing().run();
  }

  /** İş KENDİ profil sürümüyle koşar; sürüm çözülemezse yürürlüktekine düşülür. */
  private profileOf(job: Job) {
    if (job.profileId) {
      const row = this.db
        .select({ document: schema.projectProfiles.document })
        .from(schema.projectProfiles)
        .where(eq(schema.projectProfiles.id, job.profileId))
        .get();
      const parsed = ProjectProfileSchema.safeParse(row?.document);
      if (parsed.success) return parsed.data;
    }
    return activeProfile(this.db, job.projectId);
  }

  private mergedPr(jobId: string): boolean {
    return !!this.db
      .select({ id: schema.pullRequests.id })
      .from(schema.pullRequests)
      .where(and(eq(schema.pullRequests.jobId, jobId), eq(schema.pullRequests.state, "merged")))
      .get();
  }

  private jobLink(jobId: string): string | null {
    if (!this.opts.publicUrl) {
      if (!this.warnedNoUrl) {
        this.warnedNoUrl = true;
        this.opts.log({}, "AHTAPOT_PUBLIC_URL tanımsız — issue yorumlarına iş linki ve durum rozeti eklenmiyor");
      }
      return null;
    }
    return new URL(`/jobs/${jobId}`, this.opts.publicUrl).toString();
  }

  /** Her yorumun altına canlı durum rozeti + iş linki; gövde maskelenir (kural 4). */
  private body(jobId: string, text: string): string {
    const link = this.jobLink(jobId);
    const footer = link
      ? `\n\n---\n[![${BRAND.displayName} durumu](${new URL(`/badge/jobs/${jobId}.svg`, this.opts.publicUrl).toString()})](${link}) · [${BRAND.displayName}'ta aç](${link})`
      : "";
    return scrubSecrets(`${text}${footer}\n\n${SYNC_MARKER}`);
  }

  private transitionText(job: Job, from: string, to: JobState, reason: string): string | null {
    const why = reason ? `\n\n> ${reason}` : "";
    switch (to) {
      case "Planning":
        if (from === "Draft") return `🐙 **${BRAND.displayName} işi aldı** — plan hazırlanıyor.`;
        if (from === "PlanReview") return `↩️ Plan reddedildi, yeniden planlanıyor.${why}`;
        return null;
      case "PlanReview":
        return "📝 Plan hazır, onay bekliyor.";
      case "Developing":
        if (from === "PlanReview") return "✅ **Plan onaylandı** — geliştirme başladı.";
        if (from === "LiveTest") return `↩️ Canlı testte düzeltme istendi; geliştirmeye dönüldü.${why}`;
        if (from === "PRReview") return `↩️ PR incelemesinde düzeltme istendi.${why}`;
        return null;
      case "QACases":
        return from === "LiveTest" ? "✅ **Canlı test onaylandı** — QA başladı." : null;
      case "PRReview":
        // Gerekçe PR onayı mı beklendiğini yoksa PR'ın açıldığını söylüyor
        // (`git.pr.openApproval`).
        return `🔍 QA tamamlandı.${why}`;
      case "Done": {
        const t = workedTime(this.db, job.id);
        return `🏁 **İş tamamlandı.**${why}${t ? `\n\n${renderWorkedTime(t)}` : ""}`;
      }
      case "NeedsAttention":
        return `⚠️ **Dikkat gerekiyor** — iş durdu, insan kararı bekleniyor.\n\n> ${job.errorMessage ?? reason}`;
      case "Cancelled":
        return "🛑 İş iptal edildi.";
      default:
        // Building/LiveTest(hazırlık)/QA/CIWatch: döngü ya da ayrı notu olan adımlar.
        return null;
    }
  }

  private liveText(jobId: string, p: { appUrl?: string; publicUrl?: string; round?: number }, labels: VerdictLabels | null): string {
    const link = this.jobLink(jobId);
    const lines = [`🧪 **Canlı test hazır**${p.round && p.round > 1 ? ` (tur ${p.round})` : ""} — sıra sizde.`, ""];
    if (p.publicUrl) {
      lines.push(`**Test adresi:** ${p.publicUrl}`);
    } else {
      lines.push(
        link
          ? `Canlı ortam dışarıya açık değil; [${BRAND.displayName} iş sayfasından](${link}) erişin.`
          : "Canlı ortam dışarıya açık değil.",
      );
      if (p.appUrl) lines.push(`Sunucudaki adres (yalnız sunucudan erişilir): \`${p.appUrl}\``);
    }
    lines.push("", `Test ettikten sonra ${BRAND.displayName}'ta onaylayın ya da düzeltme isteyin.`);
    if (labels) {
      lines.push(
        "",
        "Ya da buradan, etiketle:",
        `- \`${labels.approve}\` → test geçti, QA'ya geçilir`,
        `- \`${labels.fix}\` → düzeltme; neyin düzeltileceğini yorum olarak yazın`,
      );
    }
    const t = workedTime(this.db, jobId);
    if (t) lines.push("", "**Şimdiye kadar:**", "", renderWorkedTime(t));
    return lines.join("\n");
  }
}

function verdictLabels(cfg: TrackerCfg): VerdictLabels {
  return { approve: cfg.approveLabel, fix: cfg.fixLabel };
}
