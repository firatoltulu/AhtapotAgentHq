import { and, eq, sql } from "drizzle-orm";
import webpush from "web-push";

import {
  BRAND,
  scrubSecrets,
  type ApprovalKind,
  type PushPayload,
  type PushSubscriptionBody,
  type ServerEvent,
} from "@ahtapot/shared";

import { newId, schema, type Db } from "../db/index.js";
import type { EventHub } from "../ws/hub.js";

/**
 * İnsan-bekleme bildirimi — telefon ekranına düşen "sıra sende".
 *
 * Agent'lar dakikalarca, bazen saatlerce koşuyor; operatör ekranın başında
 * beklemiyor. Bir kapı açıldığında ya da agent soru sorduğunda iş o ana dek
 * DURUR ve `askTimeoutMinutes` dolunca agent varsayımla devam eder — yani
 * görülmeyen bir soru, insanın istemediği bir kararın alınması demek.
 *
 * Tetikleyiciler hub olaylarından türer (tek kaynak): motorun her kapı
 * noktasına ayrı bildirim çağrısı serpiştirmek, yeni bir kapı eklendiğinde
 * bildirimin unutulması demekti.
 *
 * İki kanal, ikisi de isteğe bağlı:
 *  - Web Push (VAPID): UI'dan "bildirimleri aç" ile cihaz kaydolur. Android
 *    Chrome'da doğrudan, iOS'ta (16.4+) yalnız ana ekrana eklenmiş PWA'da.
 *  - ntfy: `AHTAPOT_NTFY_URL` tanımlıysa düz HTTP POST — HTTPS'siz kurulumda
 *    da (Web Push güvenli bağlam ister) telefona ulaşmanın yolu.
 */

export interface NotifierOptions {
  /** `mailto:` ya da `https:` — push servisleri VAPID iletişim adresi ister. */
  vapidSubject: string;
  /** ntfy konu adresi, ör. `https://ntfy.sh/benim-konum`. */
  ntfyUrl?: string | undefined;
  /** ntfy erişim token'ı (korumalı konu). */
  ntfyToken?: string | undefined;
  /** Bildirim tıklamasının açacağı mutlak kök (ntfy için; Web Push göreli yol kullanır). */
  publicUrl?: string | undefined;
  log: (obj: Record<string, unknown>, msg: string) => void;
  /** Test: gerçek ağ yerine. */
  send?: (sub: PushSubscriptionBody, payload: string) => Promise<void>;
  fetch?: typeof fetch;
  /** Otopilotun safha kapısını çözmesi için beklenen süre (ms). Test kısaltır. */
  autopilotGraceMs?: number;
}

/**
 * Otopilot kapıyı yayından hemen sonra, aynı akışta onaylıyor; başarısız olursa
 * kapı insanda kalır. Bu süre o başarısızlığı yakalamak için — bekleyen kapı
 * hâlâ `pending`se bildirim yine gider.
 */
const AUTOPILOT_GRACE_MS = 30_000;

const KIND_LABEL: Record<ApprovalKind, string> = {
  profile: "Profil onayı",
  plan: "Plan onayı",
  phase: "Safha onayı",
  live_test: "Canlı test",
  qa_cases: "Test senaryoları onayı",
  pr_open: "PR açma onayı",
  pr_merge: "Merge onayı",
  blocked: "Engel kararı",
  review_round: "İnceleme turu kararı",
  security: "Güvenlik bulguları kararı",
};

const VAPID_KEY = "vapid";
const MAX_BODY = 180;
/** Ardışık bu kadar hatadan sonra abonelik bırakılır (404/410 beklemeden). */
const MAX_FAILURES = 5;

function clip(text: string): string {
  const flat = scrubSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1)}…` : flat;
}

export class Notifier {
  private vapid: { publicKey: string; privateKey: string } | null = null;
  /**
   * Aynı kapı/soru için tek bildirim. Motor bazı olayları yeniden yayınlıyor
   * (açılış uzlaştırması, devralma); insan aynı soruyu iki kez duymamalı.
   * Süreç ömrü boyunca tutulur — yeniden başlatmadan sonra bir kez daha
   * hatırlatmak zararlı değil.
   */
  private readonly seen = new Set<string>();

  constructor(private readonly db: Db, private readonly opts: NotifierOptions) {}

  get ntfyEnabled(): boolean {
    return Boolean(this.opts.ntfyUrl);
  }

  /** VAPID anahtarı ilk kullanımda üretilir ve SAKLANIR (bkz. `appSettings`). */
  vapidKeys(): { publicKey: string; privateKey: string } {
    if (this.vapid) return this.vapid;
    const row = this.db.select().from(schema.appSettings).where(eq(schema.appSettings.key, VAPID_KEY)).get();
    const stored = row?.value as { publicKey?: unknown; privateKey?: unknown } | undefined;
    if (typeof stored?.publicKey === "string" && typeof stored.privateKey === "string") {
      this.vapid = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    } else {
      const keys = webpush.generateVAPIDKeys();
      this.db.insert(schema.appSettings).values({ key: VAPID_KEY, value: keys }).run();
      this.vapid = keys;
    }
    return this.vapid;
  }

  subscriptionCount(): number {
    const row = this.db.select({ n: sql<number>`count(*)` }).from(schema.pushSubscriptions).get();
    return row?.n ?? 0;
  }

  subscribe(body: PushSubscriptionBody, userAgent: string): void {
    this.db
      .insert(schema.pushSubscriptions)
      .values({ id: newId(), endpoint: body.endpoint, keys: body.keys, userAgent: userAgent.slice(0, 300) })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: { keys: body.keys, failures: 0, userAgent: userAgent.slice(0, 300) },
      })
      .run();
  }

  unsubscribe(endpoint: string): void {
    this.db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint)).run();
  }

  /** Hub'a bağlanır; dönen fonksiyon bağı çözer. */
  attach(hub: EventHub): () => void {
    this.recoverAutopilotGates();
    return hub.onEmit((e) => {
      const payload = this.fromEvent(e);
      if (!payload) return;
      void this.notify(payload);
    });
  }

  /** Hangi olay insanı bekletir — geri kalanı sessiz. */
  fromEvent(e: ServerEvent): PushPayload | null {
    // İş başlığı YALNIZ bildirim üretilecekse okunur: bu fonksiyon her olayda
    // (delta ve build satırları dahil) çağrılıyor.
    const title = () => this.jobTitle(e.jobId);
    const url = `/jobs/${e.jobId}`;
    switch (e.type) {
      case "approval.required": {
        if (this.seen.has(`gate:${e.gateId}`)) return null;
        // Otopilotlu işte safha kapısını kimse beklemiyor:
        // kapı yayınlanır, otopilot hemen onaylar — bildirim ise yayına
        // bağlı olduğu için her safhada telefona düşüyordu. Kapı süre sonunda
        // hâlâ açıksa otopilot onu çözememiştir; o zaman insan duyar.
        if (e.kind === "phase" && this.autopilotActive(e.jobId)) {
          this.notifyIfStillPending(e.gateId, () => this.gatePayload(e.kind, title(), url, e.jobId));
          return null;
        }
        this.seen.add(`gate:${e.gateId}`);
        return this.gatePayload(e.kind, title(), url, e.jobId);
      }
      case "agent.question": {
        if (this.seen.has(`q:${e.questionId}`)) return null;
        // Otopilotta soru insana gitmez, motor anında "kendin karar ver" der;
        // olay yine de UI için yayınlanıyor. Koşul motorun `autopilotActive`iyle
        // aynı ve aynı anda okunuyor — ikisi ayrışmaz.
        if (this.autopilotActive(e.jobId)) return null;
        this.seen.add(`q:${e.questionId}`);
        return { title: `Agent soruyor — ${clip(title())}`, body: clip(e.text), url, tag: `job:${e.jobId}` };
      }
      case "job.state": {
        if (e.state !== "NeedsAttention") {
          this.seen.delete(`attn:${e.jobId}`);
          return null;
        }
        // Aynı iş art arda NeedsAttention yayınlayabilir (uzlaştırma + hata);
        // anahtar olay sırasına değil işe bağlı, yeni bir duruma geçince sıfırlanır.
        const key = `attn:${e.jobId}`;
        if (this.seen.has(key)) return null;
        this.seen.add(key);
        const err = this.jobError(e.jobId);
        return { title: `Dikkat gerekiyor — ${clip(title())}`, body: clip(err ?? "İş durdu, insan kararı bekleniyor"), url, tag: `job:${e.jobId}` };
      }
      default:
        return null;
    }
  }

  private gatePayload(kind: ApprovalKind, jobTitle: string, url: string, jobId: string): PushPayload {
    return { title: `${KIND_LABEL[kind]} bekleniyor`, body: clip(jobTitle), url, tag: `job:${jobId}` };
  }

  /** Motorun `autopilotActive`i ile aynı koşul: bayrak açık ve iş geliştirme adımında. */
  private autopilotActive(jobId: string): boolean {
    const row = this.db
      .select({ autopilot: schema.jobs.autopilot, state: schema.jobs.state })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .get();
    return !!row?.autopilot && (row.state === "Developing" || row.state === "Building");
  }

  /**
   * Bekleme süresi içinde sunucu yeniden başlarsa zamanlayıcı kaybolur ve
   * kapıyı kimse yeniden yayınlamaz: `reconcile` bekleyen kapılı işe
   * dokunmuyor, otopilot da yalnız yayın anında ya da bayrak açılınca onaylıyor.
   * Kapı açık kalır, insan duymaz — iş sessizce bekler. Açılışta otopilotlu
   * işin açık safha kapısı aynı süreyle yeniden planlanır.
   */
  private recoverAutopilotGates(): void {
    const rows = this.db
      .select({ id: schema.approvals.id, jobId: schema.approvals.jobId })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.kind, "phase"), eq(schema.approvals.status, "pending")))
      .all();
    for (const r of rows) {
      const jobId = r.jobId;
      if (!jobId || !this.autopilotActive(jobId)) continue;
      this.notifyIfStillPending(r.id, () => this.gatePayload("phase", this.jobTitle(jobId), `/jobs/${jobId}`, jobId));
    }
  }

  private notifyIfStillPending(gateId: string, payload: () => PushPayload): void {
    const timer = setTimeout(() => {
      if (this.seen.has(`gate:${gateId}`)) return;
      const row = this.db
        .select({ status: schema.approvals.status })
        .from(schema.approvals)
        .where(eq(schema.approvals.id, gateId))
        .get();
      if (row?.status !== "pending") return;
      this.seen.add(`gate:${gateId}`);
      void this.notify(payload());
    }, this.opts.autopilotGraceMs ?? AUTOPILOT_GRACE_MS);
    timer.unref?.();
  }

  /** Analyst taslak profil üretti; onay bekleniyor (iş değil, proje düzeyi). */
  profileDraft(projectId: string, profileId: string): void {
    if (this.seen.has(`profile:${profileId}`)) return;
    this.seen.add(`profile:${profileId}`);
    const row = this.db
      .select({ name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    void this.notify({
      title: `${KIND_LABEL.profile} bekleniyor`,
      body: clip(`${row?.name ?? projectId} — analiz bitti, taslak profil incelemenizi bekliyor`),
      url: `/projects/${projectId}`,
      tag: `project:${projectId}`,
    });
  }

  private jobTitle(jobId: string): string {
    const row = this.db.select({ title: schema.jobs.title }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    return row?.title ?? jobId;
  }

  private jobError(jobId: string): string | null {
    const row = this.db
      .select({ message: schema.jobs.errorMessage })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .get();
    return row?.message ?? null;
  }

  /** Tüm kanallara gönderir; hiçbir hata çağırana taşmaz. */
  async notify(payload: PushPayload): Promise<void> {
    await Promise.all([this.sendWebPush(payload), this.sendNtfy(payload)]);
  }

  private async sendWebPush(payload: PushPayload): Promise<void> {
    const subs = this.db.select().from(schema.pushSubscriptions).all();
    if (subs.length === 0) return;
    const body = JSON.stringify(payload);
    const send =
      this.opts.send ??
      (async (sub: PushSubscriptionBody, data: string) => {
        const keys = this.vapidKeys();
        await webpush.sendNotification(sub, data, {
          vapidDetails: { subject: this.opts.vapidSubject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          // Bir saatten eski "onay bekleniyor" artık bilgi değil gürültü.
          TTL: 3600,
          urgency: "high",
        });
      });

    await Promise.all(
      subs.map(async (s) => {
        try {
          await send({ endpoint: s.endpoint, keys: s.keys }, body);
          this.db
            .update(schema.pushSubscriptions)
            .set({ failures: 0, lastSentAt: new Date().toISOString() })
            .where(eq(schema.pushSubscriptions.id, s.id))
            .run();
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410: tarayıcı aboneliği bıraktı (izin geri alındı, uygulama silindi).
          if (status === 404 || status === 410 || s.failures + 1 >= MAX_FAILURES) {
            this.unsubscribe(s.endpoint);
            this.opts.log({ status, endpoint: new URL(s.endpoint).host }, "push aboneliği kaldırıldı");
            return;
          }
          this.db
            .update(schema.pushSubscriptions)
            .set({ failures: s.failures + 1 })
            .where(eq(schema.pushSubscriptions.id, s.id))
            .run();
          this.opts.log({ status, err: err instanceof Error ? err.message : String(err) }, "push gönderilemedi");
        }
      }),
    );
  }

  private async sendNtfy(payload: PushPayload): Promise<void> {
    if (!this.opts.ntfyUrl) return;
    const doFetch = this.opts.fetch ?? fetch;
    const click = this.opts.publicUrl ? new URL(payload.url, this.opts.publicUrl).toString() : undefined;
    try {
      // HTTP başlıkları ASCII dışını taşıyamaz; Türkçe başlık gövdede,
      // ntfy'nin JSON yayını ile gider.
      // Konu adresin son parçası; JSON yayını sunucu köküne gider (alt yolda
      // kurulu ntfy için kök = son parçadan öncesi).
      const u = new URL(this.opts.ntfyUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      const topic = parts.pop() ?? "";
      const res = await doFetch(`${u.origin}/${parts.map((p) => `${p}/`).join("")}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.ntfyToken ? { authorization: `Bearer ${this.opts.ntfyToken}` } : {}),
        },
        body: JSON.stringify({
          topic,
          title: `${BRAND.displayName}: ${payload.title}`,
          message: payload.body || payload.title,
          priority: 4,
          tags: ["octopus"],
          ...(click ? { click } : {}),
        }),
      });
      if (!res.ok) this.opts.log({ status: res.status }, "ntfy bildirimi reddedildi");
    } catch (err) {
      this.opts.log({ err: err instanceof Error ? err.message : String(err) }, "ntfy bildirimi gönderilemedi");
    }
  }
}
