import { existsSync } from "node:fs";
import { join } from "node:path";

import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import {
  ProjectProfileSchema,
  scrubSecrets,
  type ProjectProfile,
  type ReleaseBump,
  type ReleaseStatus,
  type ReleaseTrigger,
} from "@ahtapot/shared";

import { isoNow, newId, schema, type Db } from "../db/index.js";
import { execGit, type CommandExecutor } from "../build/executor.js";
import { repoSlugFromRemote, type CommitCiStatus, type GitHubClient, type WorkflowRunRef } from "../git/github.js";
import { bumpVersion, formatVersion, inferBump, latestVersion, parseVersion, renderTag, tagPrefix, type Version } from "./semver.js";
import { lastSlotAtOrBefore, nextSlotAfter } from "./schedule.js";

/**
 * Hedef repodaki release workflow'unu tetikleme ve izleme.
 *
 * Release'in KENDİSİ (tag, dosya bump'ı, Release sayfası) workflow'un işi;
 * burada yalnız "ne zaman, hangi bump'la" kararı ve sonucun izi var.
 */

export type ReleaseRow = typeof schema.projectReleases.$inferSelect;

export class ReleaseError extends Error {
  constructor(readonly code: "not_found" | "disabled" | "busy" | "unsupported", message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** Uçuşta sayılan durumlar: aynı projede ikinci bir yayın başlatılmaz. */
const IN_FLIGHT: ReleaseStatus[] = ["starting", "dispatched", "running"];

/**
 * Dispatch ile koşunun GitHub'da görünmesi arasındaki pay. Saat farkı ve
 * kuyruk gecikmesi için; daha geniş pencere başkasının koşusunu yakalar.
 */
const MATCH_SLACK_MS = 15_000;
/** Bu kadar sürede koşu görünmezse eşleme bırakılır (`unknown`). */
const MATCH_GIVE_UP_MS = 10 * 60_000;

/** Proje listesinde ve başlıkta görünen güncel sürüm. Tag yoksa `tag` null. */
export interface ProjectVersion {
  repo: string;
  tag: string | null;
  version: string | null;
}

/**
 * Sürüm rozetinin önbelleği. Liste her açılışta tüm projeler için `gh api`
 * çağırırdı; tag dakikada bir değişmez, yayın bitince ayrıca silinir.
 */
const VERSION_TTL_MS = 5 * 60_000;

/** Bir turun ne yapacağı — dry-run da gerçek tetik de bunu hesaplar. */
export interface ReleasePlan {
  repo: string;
  ref: string;
  workflowFile: string;
  fromTag: string | null;
  fromVersion: string | null;
  bump: ReleaseBump;
  toVersion: string;
  /** `versionInput` yoksa sürümü workflow belirler; `toVersion` yalnız tahmin. */
  estimated: boolean;
  inputs: Record<string, string>;
  /** Son tag'den beri commit sayısı; tag yoksa ya da bakılmadıysa null. */
  commits: number | null;
  ci: CommitCiStatus | null;
  skipReason: string | null;
}

export interface ReleaseServiceDeps {
  db: Db;
  github: GitHubClient;
  hostExec: CommandExecutor;
  log: (obj: object, msg: string) => void;
}

export class ReleaseService {
  /** Aynı satırın iki yoklaması üst üste binmesin (GET + zamanlayıcı). */
  private readonly refreshing = new Set<string>();
  /** Söz saklanır: aynı anda gelen iki istek tek `gh` çağrısı paylaşır. */
  private readonly versions = new Map<string, { at: number; value: Promise<ProjectVersion | null> }>();

  constructor(private readonly deps: ReleaseServiceDeps) {}

  // ── Okuma ────────────────────────────────────────────────────────────────

  /** Onaylı profil + onay anı. Taslak profil burada da yok sayılır (kural 8). */
  activeProfile(projectId: string): { profile: ProjectProfile; approvedAt: string | null } | null {
    const row = this.deps.db
      .select({ document: schema.projectProfiles.document, approvedAt: schema.projectProfiles.approvedAt })
      .from(schema.projects)
      .innerJoin(schema.projectProfiles, eq(schema.projects.activeProfileId, schema.projectProfiles.id))
      .where(eq(schema.projects.id, projectId))
      .get();
    if (!row) return null;
    const parsed = ProjectProfileSchema.safeParse(row.document);
    return parsed.success ? { profile: parsed.data, approvedAt: row.approvedAt } : null;
  }

  history(projectId: string, limit = 20): ReleaseRow[] {
    return this.deps.db
      .select()
      .from(schema.projectReleases)
      .where(eq(schema.projectReleases.projectId, projectId))
      .orderBy(desc(schema.projectReleases.createdAt))
      .limit(limit)
      .all();
  }

  inFlight(projectId: string): ReleaseRow | null {
    return this.deps.db
      .select()
      .from(schema.projectReleases)
      .where(and(eq(schema.projectReleases.projectId, projectId), inArray(schema.projectReleases.status, IN_FLIGHT)))
      .orderBy(desc(schema.projectReleases.createdAt))
      .get() ?? null;
  }

  /** Takvimin bir sonraki yuvası; duraklatma süresine düşen yuvalar atlanır. */
  nextRunAt(projectId: string, now = new Date()): string | null {
    const active = this.activeProfile(projectId);
    if (!active?.profile.release.enabled) return null;
    const paused = this.project(projectId).releasePausedUntil;
    let at: Date | null = now;
    // Duraklatma birkaç dönem sürebilir; yuva yuva ilerle.
    for (let i = 0; i < 60 && at; i++) {
      at = nextSlotAfter(active.profile.release.schedule, at);
      if (at && (!paused || at.toISOString() >= paused)) return at.toISOString();
    }
    return null;
  }

  // ── Plan ─────────────────────────────────────────────────────────────────

  /**
   * Turun ne yapacağını hesaplar; hiçbir şey yazmaz ve tetiklemez.
   * `bump` verilmezse zamanlı tur kuralları (auto, değişiklik yok, CI) geçerli.
   */
  async plan(projectId: string, opts: { bump?: ReleaseBump } = {}): Promise<ReleasePlan> {
    const project = this.project(projectId);
    const active = this.activeProfile(projectId);
    if (!active) throw new ReleaseError("disabled", "projenin onaylı profili yok");
    const { profile } = active;
    const rel = profile.release;
    const gh = this.deps.github;
    if (!gh.listTags || !gh.dispatchWorkflow || !gh.defaultBranch) {
      throw new ReleaseError("unsupported", "GitHub istemcisi release çağrılarını desteklemiyor");
    }

    const target = releaseTarget(profile);
    if (!target) throw new ReleaseError("disabled", `release.repo bulunamadı: ${rel.repo ?? "(birincil)"}`);
    const repo = await this.resolveRepo(project, target);
    if (!repo) throw new ReleaseError("unsupported", `${target.name} reposu GitHub'da değil ya da remote'u yok`);

    const defaultBranch = target.defaultBranch || (await gh.defaultBranch(repo));
    const ref = rel.workflow.ref.replaceAll("{defaultBranch}", defaultBranch);

    const latest = latestVersion(await gh.listTags(repo, tagPrefix(rel.tagPattern)), rel.tagPattern);
    const scheduled = opts.bump === undefined;

    let commits: number | null = null;
    let messages: string[] = [];
    if (latest && gh.compareCommits) {
      const cmp = await gh.compareCommits(repo, latest.tag, ref);
      commits = cmp.total;
      messages = cmp.messages;
    }

    let ci: CommitCiStatus | null = null;
    if (scheduled && rel.schedule.requireGreenCi && gh.commitCiStatus) ci = await gh.commitCiStatus(repo, ref);

    // Tag yoksa ilk sürüm: auto'da minor (0.1.0) — 0.0.1 ile başlamak alışılmış değil.
    const bump: ReleaseBump = opts.bump
      ?? (rel.schedule.bump === "auto" ? (latest ? inferBump(messages) : "minor") : rel.schedule.bump);
    const from: Version = latest?.version ?? { major: 0, minor: 0, patch: 0 };
    const toVersion = formatVersion(bumpVersion(from, bump));

    let skipReason: string | null = null;
    if (scheduled) {
      if (rel.schedule.skipIfNoChanges && commits === 0) skipReason = `${latest?.tag ?? ""} sonrası değişiklik yok`;
      else if (ci === "failure") skipReason = `${ref} ucunda CI kırmızı`;
      else if (ci === "pending") skipReason = `${ref} ucunda CI sürüyor`;
    }

    const inputs: Record<string, string> = { ...rel.workflow.extraInputs };
    if (rel.workflow.bumpInput) inputs[rel.workflow.bumpInput] = bump;
    if (rel.workflow.versionInput) inputs[rel.workflow.versionInput] = toVersion;

    return {
      repo, ref, workflowFile: rel.workflow.file,
      fromTag: latest?.tag ?? null,
      fromVersion: latest ? formatVersion(latest.version) : null,
      bump, toVersion,
      estimated: !rel.workflow.versionInput,
      inputs, commits, ci, skipReason,
    };
  }

  // ── Güncel sürüm ─────────────────────────────────────────────────────────

  /**
   * Hedef reponun en büyük kararlı sürüm tag'i. Release kapalı ya da profil
   * yokken de çalışır (desen `v{version}`, repo klon kaynağı ya da `origin`):
   * sürümü görmek yayın açmaya bağlı olmamalı. Hata null döner — rozet
   * görünmez, sayfa düşmez.
   */
  currentVersion(projectId: string): Promise<ProjectVersion | null> {
    const hit = this.versions.get(projectId);
    if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.value;
    const value = this.readVersion(projectId).catch((err: unknown) => {
      this.deps.log({ projectId, err: scrubSecrets(err instanceof Error ? err.message : String(err)) }, "güncel sürüm okunamadı");
      return null;
    });
    this.versions.set(projectId, { at: Date.now(), value });
    return value;
  }

  private async readVersion(projectId: string): Promise<ProjectVersion | null> {
    const gh = this.deps.github;
    if (!gh.listTags) return null;
    const project = this.project(projectId);
    const profile = this.activeProfile(projectId)?.profile ?? null;
    const pattern = profile?.release.tagPattern ?? "v{version}";
    const repo = await this.resolveRepo(project, profile ? releaseTarget(profile) ?? null : null);
    if (!repo) return null;
    const latest = latestVersion(await gh.listTags(repo, tagPrefix(pattern)), pattern);
    return { repo, tag: latest?.tag ?? null, version: latest ? formatVersion(latest.version) : null };
  }

  // ── Tetikleme ────────────────────────────────────────────────────────────

  /**
   * Niyeti `starting` olarak YAZAR ve satır kimliğini hemen döner; GitHub
   * çağrıları `done`da sürer (REST 202 döner, UI yoklar).
   *
   * Zamanlı turda yuva zaten alınmışsa (unique index) null döner — aynı tur
   * iki kez tetiklenmez, süreç dispatch ortasında ölmüş olsa bile.
   */
  start(
    projectId: string,
    opts: { trigger: ReleaseTrigger; actor: string; bump?: ReleaseBump; scheduledFor?: string },
  ): { id: string; done: Promise<void> } | null {
    const active = this.activeProfile(projectId);
    if (!active) throw new ReleaseError("disabled", "projenin onaylı profili yok");
    if (!active.profile.release.enabled) throw new ReleaseError("disabled", "profilde release kapalı");

    const id = newId();
    // Uçuş denetimi ile rezervasyon TEK yazma kilidi altında: `immediate`
    // kilidi BEGIN'de alır, aynı DB'yi açan ikinci bir süreç arada kendi
    // `starting` satırını yazıp ikinci bir workflow tetikleyemez.
    let busy: boolean;
    try {
      busy = this.deps.db.transaction((tx) => {
        const inFlight = tx
          .select({ id: schema.projectReleases.id })
          .from(schema.projectReleases)
          .where(and(eq(schema.projectReleases.projectId, projectId), inArray(schema.projectReleases.status, IN_FLIGHT)))
          .get();
        if (inFlight && opts.trigger === "manual") throw new ReleaseError("busy", "bu projede süren bir yayın var");
        tx.insert(schema.projectReleases).values({
          id, projectId, trigger: opts.trigger, requestedBy: opts.actor,
          scheduledFor: opts.scheduledFor ?? null,
          // Zamanlı turda süren yayın varsa yuva yine harcanır, ama atlanmış olarak.
          status: (inFlight ? "skipped" : "starting") satisfies ReleaseStatus,
          skipReason: inFlight ? "başka bir yayın sürüyor" : null,
          ...(opts.bump ? { bump: opts.bump } : {}),
          ...(inFlight ? { finishedAt: isoNow() } : {}),
        }).run();
        return Boolean(inFlight);
      }, { behavior: "immediate" });
    } catch (err) {
      if (opts.scheduledFor && /UNIQUE/i.test(String(err))) return null;
      throw err;
    }
    this.audit(opts.actor, busy ? "release.skipped" : "release.start", projectId, { releaseId: id, trigger: opts.trigger });
    if (busy) return { id, done: Promise.resolve() };

    const done = this.dispatch(id, projectId, opts.bump).catch((err: unknown) => {
      const error = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 2000);
      this.update(id, { status: "failed", error, finishedAt: isoNow() });
      this.audit("system", "release.failed", projectId, { releaseId: id, error });
    });
    return { id, done };
  }

  private async dispatch(id: string, projectId: string, bump: ReleaseBump | undefined): Promise<void> {
    const plan = await this.plan(projectId, bump ? { bump } : {});
    const common = {
      repo: plan.repo, ref: plan.ref, workflowFile: plan.workflowFile, bump: plan.bump,
      fromVersion: plan.fromVersion, toVersion: plan.toVersion,
    };
    if (plan.skipReason) {
      this.update(id, { ...common, status: "skipped", skipReason: plan.skipReason, finishedAt: isoNow() });
      this.audit("system", "release.skipped", projectId, { releaseId: id, reason: plan.skipReason });
      return;
    }
    // Korelasyon kimliği = satır kimliği: workflow onu `run-name`e yazarsa
    // koşu zamana değil kimliğe göre eşlenir.
    const corrInput = this.activeProfile(projectId)?.profile.release.workflow.correlationInput;
    const inputs = corrInput ? { ...plan.inputs, [corrInput]: id } : plan.inputs;
    // Eşleme penceresi dispatch'ten ÖNCE yazılır: koşu dispatch dönmeden başlayabilir.
    this.update(id, { ...common, dispatchedAt: isoNow(), correlationId: corrInput ? id : null });
    await this.deps.github.dispatchWorkflow!(plan.repo, plan.workflowFile, plan.ref, inputs);
    this.update(id, { status: "dispatched" });
    this.audit("system", "release.dispatched", projectId, { releaseId: id, ...common });
  }

  // ── İzleme ───────────────────────────────────────────────────────────────

  /** Uçuştaki satırı GitHub'dan günceller. Hata yutulur: bir sonraki yoklama dener. */
  async refresh(row: ReleaseRow): Promise<void> {
    if (row.status !== "dispatched" && row.status !== "running") return;
    if (this.refreshing.has(row.id)) return;
    this.refreshing.add(row.id);
    try {
      await this.refreshOnce(row);
    } catch (err) {
      this.deps.log({ releaseId: row.id, err: scrubSecrets(err instanceof Error ? err.message : String(err)) }, "release durumu okunamadı");
    } finally {
      this.refreshing.delete(row.id);
    }
  }

  private async refreshOnce(row: ReleaseRow): Promise<void> {
    const gh = this.deps.github;
    if (!row.repo || !row.workflowFile || !gh.listWorkflowRuns || !gh.workflowRun) return;

    let run: WorkflowRunRef | null = null;
    if (row.runId) {
      run = await gh.workflowRun(row.repo, row.runId);
    } else {
      const since = new Date(row.dispatchedAt ?? row.createdAt).getTime() - MATCH_SLACK_MS;
      const claimed = new Set(
        this.deps.db
          .select({ runId: schema.projectReleases.runId })
          .from(schema.projectReleases)
          .where(and(eq(schema.projectReleases.projectId, row.projectId), isNotNull(schema.projectReleases.runId)))
          .all()
          .map((r) => r.runId),
      );
      const runs = await gh.listWorkflowRuns(row.repo, row.workflowFile, new Date(since).toISOString());
      const corr = row.correlationId;
      // Korelasyon varsa YALNIZ kimlik eşler; zaman/dal yalnız korelasyonsuz
      // kurulumun geri dönüşü — orada da birden çok aday `unknown` olur.
      const candidates = corr
        ? runs.filter((r) => r.title.includes(corr))
        : runs.filter(
          (r) => new Date(r.createdAt).getTime() >= since && (!row.ref || r.headBranch === row.ref) && !claimed.has(r.id),
        );
      if (candidates.length > 1) {
        // Aynı pencerede başkası da tetiklemiş: rastgele seçmek yanlış koşuyu izletir.
        this.update(row.id, { status: "unknown", error: `${candidates.length} koşu eşleşti; hangisinin bu yayın olduğu bilinmiyor`, finishedAt: isoNow() });
        return;
      }
      run = candidates[0] ?? null;
      if (!run) {
        if (Date.now() - since > MATCH_GIVE_UP_MS) {
          this.update(row.id, { status: "unknown", error: "workflow koşusu görünmedi", finishedAt: isoNow() });
        }
        return;
      }
      this.update(row.id, { runId: run.id, runUrl: run.url });
    }

    if (run.status !== "completed") {
      if (row.status !== "running") this.update(row.id, { status: "running" });
      return;
    }
    const ok = run.conclusion === "success";
    const tag = ok ? await this.producedTag(row) : null;
    // Yeni tag rozette hemen görünsün; önbellek beş dakika eskiyi gösterirdi.
    if (ok) this.versions.delete(row.projectId);
    this.update(row.id, { status: ok ? "succeeded" : "failed", tag, finishedAt: isoNow(), ...(ok ? {} : { error: `workflow sonucu: ${run.conclusion ?? "?"}` }) });
    this.audit("system", ok ? "release.succeeded" : "release.failed", row.projectId, { releaseId: row.id, runUrl: run.url, tag });
  }

  /**
   * Koşunun gerçekte ürettiği tag. Önce beklenen sürüm aranır; workflow
   * sürümü kendisi belirliyorsa (`versionInput` yok) başlangıçtan büyük en
   * son tag alınır. Hiçbiri yoksa null: workflow tag atmıyor olabilir.
   */
  private async producedTag(row: ReleaseRow): Promise<string | null> {
    const active = this.activeProfile(row.projectId);
    const gh = this.deps.github;
    if (!active || !row.repo || !gh.listTags) return null;
    const pattern = active.profile.release.tagPattern;
    const tags = await gh.listTags(row.repo, tagPrefix(pattern));
    const expected = row.toVersion ? parseVersion(row.toVersion) : null;
    if (expected && tags.includes(renderTag(pattern, expected))) return renderTag(pattern, expected);
    const latest = latestVersion(tags, pattern);
    const from = row.fromVersion ? parseVersion(row.fromVersion) : null;
    if (latest && (!from || formatVersion(latest.version) !== formatVersion(from))) return latest.tag;
    return null;
  }

  /** Uçuştaki tüm satırları yoklar — zamanlayıcının her turu çağırır. */
  async refreshAll(): Promise<void> {
    const rows = this.deps.db
      .select()
      .from(schema.projectReleases)
      .where(inArray(schema.projectReleases.status, ["dispatched", "running"]))
      .all();
    for (const row of rows) await this.refresh(row);
  }

  // ── Zamanlama ────────────────────────────────────────────────────────────

  /**
   * Zamanı gelmiş yuvayı tetikler. Kaçırılmış yuvalardan yalnız EN SONUNCUSU
   * yakalanır (sunucu bir ay kapalı kaldıysa dört yayın değil, bir).
   * Release'in etkinleştirilmesinden (profil onayı) önceki yuva tetiklenmez:
   * aksi hâlde onay anında geçen haftanın yayını çıkardı.
   */
  tickProject(projectId: string, now = new Date()): Promise<void> | null {
    const active = this.activeProfile(projectId);
    if (!active?.profile.release.enabled) return null;
    const slot = lastSlotAtOrBefore(active.profile.release.schedule, now);
    if (!slot) return null;
    const slotIso = slot.toISOString();
    if (active.approvedAt && slotIso < active.approvedAt) return null;
    const paused = this.project(projectId).releasePausedUntil;
    if (paused && slotIso < paused) return null;

    const taken = this.deps.db
      .select({ id: schema.projectReleases.id })
      .from(schema.projectReleases)
      .where(and(eq(schema.projectReleases.projectId, projectId), eq(schema.projectReleases.scheduledFor, slotIso)))
      .get();
    if (taken) return null;
    return this.start(projectId, { trigger: "schedule", actor: "system", scheduledFor: slotIso })?.done ?? null;
  }

  setPause(projectId: string, until: string | null, actor: string): void {
    this.project(projectId);
    this.deps.db.update(schema.projects).set({ releasePausedUntil: until }).where(eq(schema.projects.id, projectId)).run();
    this.audit(actor, until ? "release.paused" : "release.resumed", projectId, { until });
  }

  // ── Yardımcılar ──────────────────────────────────────────────────────────

  private project(id: string): typeof schema.projects.$inferSelect {
    const p = this.deps.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!p) throw new ReleaseError("not_found", `proje bulunamadı: ${id}`);
    return p;
  }

  /**
   * Repo'nun GitHub adı: profildeki remote → (birincil repoda) klon kaynağı
   * → diskteki `origin`. Profil remote'u boş bırakılabiliyor (analist
   * bulamadıysa), o yüzden zincir.
   */
  private async resolveRepo(
    project: typeof schema.projects.$inferSelect,
    /** null: profil yok — workspace kökü birincil repo sayılır. */
    target: ProjectProfile["workspace"]["repos"][number] | null,
  ): Promise<string | null> {
    const fromProfile = target?.remote ? repoSlugFromRemote(target.remote) : null;
    if (fromProfile) return fromProfile;
    if ((!target || target.primary) && project.sourceGitUrl) {
      const slug = repoSlugFromRemote(project.sourceGitUrl);
      if (slug) return slug;
    }
    const dir = join(project.workspaceRoot, target?.path ?? ".");
    if (!existsSync(dir)) return null;
    const remote = await execGit(this.deps.hostExec, dir, ["remote", "get-url", "origin"], { allowFailure: true });
    return repoSlugFromRemote(remote.trim());
  }

  private update(id: string, set: Partial<typeof schema.projectReleases.$inferInsert>): void {
    this.deps.db.update(schema.projectReleases).set(set).where(eq(schema.projectReleases.id, id)).run();
  }

  private audit(actor: string, action: string, projectId: string, detail: Record<string, unknown>): void {
    this.deps.db.insert(schema.auditLog)
      .values({ id: newId(), actor, action, subjectType: "project", subjectId: projectId, detail: detail as never })
      .run();
  }
}

/** `release.repo` ya da birincil repo; çok repolu workspace'te tahmin edilmez. */
function releaseTarget(profile: ProjectProfile): ProjectProfile["workspace"]["repos"][number] | undefined {
  const repos = profile.workspace.repos;
  const name = profile.release.repo;
  return name ? repos.find((r) => r.name === name) : repos.find((r) => r.primary) ?? repos[0];
}

/**
 * Açılışta `starting`te kalan satırlar: dispatch yapılıp yapılmadığı
 * BİLİNMİYOR. `failed` değil `unknown` — workflow koşmuş olabilir; yeniden
 * denemek ikinci bir yayın çıkarabilir. Yuva harcanmış sayılır.
 */
export function reconcileInterruptedReleases(db: Db): number {
  const stuck = db
    .select({ id: schema.projectReleases.id })
    .from(schema.projectReleases)
    .where(eq(schema.projectReleases.status, "starting"))
    .all();
  for (const s of stuck) {
    db.update(schema.projectReleases)
      .set({ status: "unknown", error: "sunucu yeniden başladı; workflow tetiklenmiş olabilir", finishedAt: isoNow() })
      .where(eq(schema.projectReleases.id, s.id))
      .run();
  }
  return stuck.length;
}

/**
 * Zamanlayıcı: dakikada bir yuvaları ve uçuştaki koşuları yoklar.
 *
 * `TrackerSync.watchVerdicts` kalıbı: `unref` (süreci açık tutmaz), önceki
 * tur `gh` bekliyorsa yenisi binmez. Webhook değil yoklama: Ahtapot çoğu
 * kurulumda iç ağda, GitHub ona ulaşamaz.
 */
export function watchReleases(service: ReleaseService, db: Db, intervalMs = 60_000): () => void {
  let polling = false;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      await service.refreshAll();
      const projects = db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(isNotNull(schema.projects.activeProfileId), isNull(schema.projects.archivedAt)))
        .all();
      for (const p of projects) {
        try {
          await service.tickProject(p.id);
        } catch {
          // Tek projenin hatası (profil bozuk, proje silinmiş) diğerlerini durdurmasın;
          // `start` kendi hatasını satıra yazıyor.
        }
      }
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

