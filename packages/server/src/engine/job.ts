import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import {
  BRAND,
  HandoffSchema,
  MODEL_TIER_ORDER,
  MergeFixEditsSchema,
  ModelTierSchema,
  PlanDocumentSchema,
  ProjectProfileSchema,
  PrTitleSchema,
  QaCasesDocumentSchema,
  RejectedBlockSchema,
  STEP_CHECKS,
  TestScenariosDocumentSchema,
  MAX_TARGET_PATHS,
  extractRoutes,
  parseScenarioMarks,
  registerSecretValues,
  ScenarioResultsSchema,
  scenarioKey,
  scrubSecrets,
  type AgentRoleName,
  type ApprovalKind,
  type Blocker,
  type BrowserRunSummary,
  type BuildResult,
  type CritiqueDocument,
  type CritiqueStatus,
  type CritiqueSubject,
  type Dast,
  type DastSummary,
  type DeveloperModelSource,
  type DocLayer,
  type AcceptanceEvidence,
  type Handoff,
  type CodeMapLessons,
  type CodeGraphRunConfig,
  type JobPhase,
  type JobState,
  type ModelTier,
  type ModelChoice,
  type NextPhaseView,
  type PlanDocument,
  type PlanGatePayload,
  type StepCheck,
  type StepCheckEntry,
  type StepChecklist,
  type ProjectProfile,
  type TestAccount,
  type QaCase,
  type RejectedBlock,
  type ReopenTarget,
  type ScenarioMarks,
  type ScenarioResult,
  type ScenarioResults,
  type StaticStep,
  type ServerEvent,
  type TestScenario,
  type TestScenarioStage,
  type TestScenariosDocument,
} from "@ahtapot/shared";

import { newId, isoNow, type Db, schema } from "../db/index.js";
import type { AgentRunner, RunResult, StuckPolicyResult } from "../agents/runner.js";
import { mentorRung, renderMentorPrompt, wrapAdvice, type ConsultRequest } from "../agents/mentor.js";
import { LiveInputChannel } from "../agents/transport.js";
import { AUTOPILOT_ANSWER, TIMEOUT_ANSWER, type AskUser } from "../agents/askUser.js";
import { loadRolePrompt } from "../agents/prompts.js";
import { extractBlock, extractTextBlock } from "../analyst/analyst.js";
import { elapsed } from "../build/elapsed.js";
import { BuildGate, ForbiddenFlagError, changedFiles, changedLines, type BuildRunOutput } from "../build/gate.js";
import { prepareScratchDirs, stashScratchDirs } from "../build/scratch.js";
import { execGit, shellQuote, type CommandExecutor } from "../build/executor.js";
import { TestGate, diffAgainstBaseline, measureBaseline, type SuiteOutcome } from "../build/tests.js";
import { WorktreeManager, slugify } from "../workspace/worktree.js";
import { cloneWorkspace, isRepo } from "../workspace/clone.js";
import { syncSource } from "../workspace/sourceSync.js";
import { heldLeases, releaseLease } from "../resources/leases.js";
import type { EventHub } from "../ws/hub.js";
import type { AcquiredRuntime, DeveloperRuntime } from "./runtime.js";
import { CODEGRAPH_ROOT, RESOURCES_MOUNT, jobReferenceMounts, referenceRepoPath } from "./runtime.js";

/** Bir koşu için hazırlanmış kod grafiği (karar §44). */
interface CodeGraphSetup {
  config: CodeGraphRunConfig;
  /** Salt okunur rollerin `allowedTools`una eklenecek MCP önekleri. */
  tools: string[];
  /** Prompt'un sonuna eklenecek not. */
  note: string;
}
import { bumpLoop, transition } from "./transition.js";
import {
  bumpTier, capBelowApproval, chooseModel, clampToMaxTier, parseTriage, resolvePhaseTier, rungFor, tierNeedsApproval,
} from "./triage.js";
import { renderPrBody, repoSlugFromRemote, type BlockingReview, type GitHubClient, type ReviewThread } from "../git/github.js";
import { ocrThreads, runOcrReview } from "../review/ocr.js";
import { buildPlanCritique, buildScenariosCritique, parseCritique } from "../review/critic.js";
import { completeText } from "../review/llm.js";
import { imageExecutor, runStaticStep, staticThreads } from "../review/static.js";
import { defaultDockerRun } from "../exec/dockerCli.js";
import { jobVolumeName } from "../exec/docker.js";
import { renderDastFeedback, type DastTargets } from "../live/dast.js";

/**
 * İş motoru — durum makinesini yürüten tek yer.
 *
 * Bu dilim: Draft → Planning → PlanReview → Developing. Planner worktree'yi
 * okur, PLAN_JSON üretir; insan onaylar, reddeder ya da sohbet eder. Red ve
 * sohbet AYNI SDK oturumundan sürer (resume) — Planner bağlamı yeniden
 * kurmaz, sadece planı günceller.
 *
 * Kesinti kuralı: her duruma `starting` ile girilir, iş bitince `waiting`/
 * `done`. Açılışta `starting` ya da `running` görülen iş yarıda kalmıştır.
 */

export class EngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export interface JobEngineDeps {
  db: Db;
  hub: EventHub;
  runner: AgentRunner;
  worktrees: WorktreeManager;
  /** Developer'ın taşıması ve build yürütücüsü — Docker'ı yalnız bu bilir. */
  runtime: DeveloperRuntime;
  gate: BuildGate;
  /** Handoff ve build logları: `<artifactsDir>/<jobId>/…`. */
  artifactsDir: string;
  /** Canlı test ortamı; null ise LiveTest atlanır (profil `live` yoksa da). */
  live: LiveController | null;
  /** Test takımları + baseline; orkestratör koşturur. */
  tests: TestGate;
  /** Draft PR + CI check'leri; null ise PR açılmaz, onay işi bitirir. */
  github: GitHubClient | null;
  /** CI yoklama aralığı ve tavanı; testler kısaltır. */
  ci?: { intervalMs: number; timeoutMs: number };
  /**
   * Yerel ön incelemenin anahtarı — profilin `keyRef` adıyla. Yoksa ya da
   * `null` dönerse inceleme atlanır, akış PR'a geçer.
   */
  reviewKey?: (ref: string) => string | null;
  /**
   * Host'ta koşan yürütücü — kaynak workspace'i uzaktaki varsayılan dala
   * ilerletmek için (bkz. `syncSourceWorkspace`). Yoksa senkron atlanır.
   */
  hostExec?: CommandExecutor;
  /**
   * Kod haritası (karar §35). Yoksa ya da profilde kapalıysa harita
   * bağlanmaz, prompt'a satır girmez.
   */
  codeMap?: {
    mountRoot(projectId: string, profile: ProjectProfile): string | null;
    refresh(projectId: string, profile: ProjectProfile, lessons?: CodeMapLessons): Promise<{ stale: string[]; learning: string[]; started: boolean }>;
  };
}

/**
 * Engel kapısının yükü: agent'ın çözemediği maddeler + insanın kararı için
 * bağlam. `state`/`role` kapının NEREDE açıldığını söyler — karar verilince
 * akış oraya döner.
 */
export interface BlockedGatePayload {
  /** Kapının açıldığı durum — karar bu duruma göre yönlendirilir. */
  state: JobState;
  /** Engeli bildiren rol. */
  role: AgentRoleName;
  blockers: Blocker[];
  /** Engel yüzünden kırmızı kalan takımlar (varsa) — insan kanıtı görsün. */
  results: SuiteOutcome[];
  handoff: Handoff;
}

/** PR onay kapısının yükü: test sonuçları + QA devri. */
export interface PrGatePayload {
  results: SuiteOutcome[];
  baseline: SuiteOutcome[];
  handoff: Handoff;
  branch: string | null;
}

/** Canlı ortamın motora bakan yüzü — `LiveEnvironments` bunu sağlar, testler sahtesini. */
export interface LiveController {
  start(input: { jobId: string; profile: ProjectProfile; worktreePath: string; executor?: CommandExecutor; jobEnv?: Record<string, string> }): Promise<{
    id: string; appUrl: string; apiUrl?: string; publicUrl?: string;
    ports: number[]; expiresAt: string; ready: boolean; reason: string;
    /** Ortam BUILD'de düştü (zincir konteynerde koşuyor) — uygulama hatası değil. */
    buildFailed?: boolean;
    failedStep?: string;
    logTail?: string;
  }>;
  stop(jobId: string, worktreePath: string, live: ProjectProfile["live"], reason?: string): Promise<boolean>;
  /** Ayakta olan ortama DAST. Yoksa (test sahtesi) DAST atlanır. */
  dast?(input: { jobId: string; profile: ProjectProfile; round: number; scope?: DastTargets }): Promise<DastSummary>;
  /** İş konteynerini uygulamanın ağına bağlar (tarayıcı turu). Yoksa tur atlanır. */
  attachBrowser?(jobId: string, profile: ProjectProfile): Promise<{ baseUrl: string; origins: string[]; detach(): Promise<void> }>;
  extend(jobId: string, minutes: number): string | null;
}

/** Canlı test kapısının yükü. */
export interface LiveGatePayload {
  appUrl: string;
  /** `live.dast` açıksa tarama özeti; kapı reddinde bulgular geri bildirime eklenir. */
  dast?: DastSummary;
  /** `live.browserTest` açıksa tarayıcı turunun özeti; işaretler senaryo satırında. */
  browserRun?: BrowserRunSummary;
  /**
   * Arayüzden AYRI bir API adresi varsa. Northwind'de panel Vite'ta (5173),
   * backend ayrı portta (5080) koşuyor; insan panelden girer, API bağlantısı
   * yoklama içindir. Tek portlu projelerde verilmez.
   */
  apiUrl?: string;
  /** Traefik üzerinden domain adresi — yalnız `live.traefik.enabled` ve dizin verilmişse. */
  publicUrl?: string;
  ports: number[];
  expiresAt: string;
  /** Kaçıncı canlı test turu (düzeltme döngüsü). */
  round: number;
}

/** Safha onay kapısının yükü — UI diff'i ve handoff'u buradan çizer. */
/** `pr_merge` kapısının gövdesi — insan neyi onayladığını görmeli. */
export interface MergeGatePayload {
  prNumber: number;
  prUrl: string;
  repo: string;
  method: "merge" | "squash" | "rebase";
  cleanup: { remoteBranch: boolean; localBranch: boolean; container: boolean };
  /** Yeşil olduğu anın kaydı; insan neye bakarak onayladığını bilsin. */
  checks: { name: string; status: string }[];
  /**
   * Eşiğin ALTINDA kaldığı için ele alınmamış inceleme yorumları.
   *
   * Sıfırdan büyükse insan bilerek onaylıyor demektir: "bu yorumlar açık ama
   * merge ediyorum". Görmeden onaylamasın.
   */
  unresolvedBelowThreshold?: OpenThreadItem[];
  /** DevOps'un düzeltmediği kırmızı check'ler (ör. önceden kırık testler). */
  ciUnfixed?: string[];
  /** Kod değişikliği gerektirmediği için kapanmayan inceleme yorumları. */
  reviewUnfixed?: string[];
  /**
   * Onaydan sonra dismiss edilecek bot `CHANGES_REQUESTED`ları. İnsan onayla
   * birlikte bunu da kabul ediyor; görmeden kabul etmesin.
   */
  botChangesRequested?: { author: string; submittedAt: string }[];
}

/**
 * Merge kapısında listelenen açık yorum. `id` insanın "seçilenleri düzelt"
 * seçimini taşır; `title` neyi seçtiğini görsün diye — yol:satır tek başına
 * bir minor'ın önemli olup olmadığını söylemiyor.
 */
export interface OpenThreadItem {
  id: string;
  path: string;
  line: number | null;
  severity: string;
  title: string;
}

/**
 * Yorumun tek satırlık özeti. CodeRabbit gövdesi şiddet/kategori satırıyla
 * başlıyor (`_⚠️ Potential issue_ | _🟡 Minor_`), asıl başlık ilk kalın satırda;
 * kalın satır yoksa (OCR, insan) ilk anlamlı satır alınır.
 */
function threadTitle(body: string): string {
  const bold = /\*\*(.+?)\*\*/.exec(body)?.[1];
  const first = body.split("\n").map((l) => l.trim()).find((l) => l !== "" && !/^_.*_$/.test(l));
  return (bold ?? first ?? "").slice(0, 200);
}

function openThreadItem(t: ReviewThread): OpenThreadItem {
  return { id: t.id, path: t.path, line: t.line, severity: t.severity, title: threadTitle(t.body) };
}

/**
 * İnceleme botunun hesabı mı? `[bot]` şartı insan hesabını ASLA eşlememek için:
 * adında "coderabbit" geçen bir insanın incelemesi dismiss edilmemeli.
 */
function isReviewBot(login: string, provider: string): boolean {
  const l = login.toLowerCase();
  return l.endsWith("[bot]") && l.includes(provider.toLowerCase());
}

/** `review_round` kapısının gövdesi: tavanda hâlâ açık olan yorumlar. */
export interface ReviewRoundPayload {
  prNumber: number;
  prUrl: string;
  repo: string;
  /** Bu kapıya kadar koşan düzeltme turu. */
  rounds: number;
  threads: { path: string; line: number | null; severity: string; author: string }[];
}

/**
 * `security` kapısının gövdesi. `openPrAndReview`ın argümanları da taşınır:
 * karar sonrası akış kaldığı yerden sürer.
 */
export interface SecurityGatePayload {
  worktree: string;
  branch: string;
  repo: string;
  base: string;
  /** Bu kapıya kadar koşan güvenlik düzeltme turu. */
  rounds: number;
  /** Koşamayan güvenlik araçları — sonuç yok, temiz DEĞİL. */
  failed: string[];
  threads: { path: string; line: number | null; severity: string; author: string; body: string }[];
}

export interface PhaseGatePayload {
  phaseId: string;
  order: number;
  title: string;
  handoff: Handoff;
  diff: { stat: string; patch: string; truncated: boolean; untracked: string[] };
  build: BuildResult[];
  /**
   * Safhanın `files` sınırı dışında değişen dosyalar (git'ten, agent'ın
   * beyanından değil). Yalnız uyarı; kapıyı kapatmaz. Eski yüklerde yok.
   */
  outOfPlanFiles?: string[];
}

interface LoadedJob {
  job: typeof schema.jobs.$inferSelect;
  profile: ProjectProfile;
}

/**
 * Salt okunur rollerin (Planner, QA case listesi) kabuk izni.
 *
 * YAŞANDI (2026-09-17): `disallowedTools`ta düz `"Bash"` vardı ve agent
 * "Bash yok; dosyaları doğrudan okuyacağım" deyip diff'i Read/Grep ile
 * dosya dosya taramaya düşüyordu — hem yavaş hem eksik. İmajda `bash` VAR
 * (`node:22-bookworm-slim`, ölçüldü); engel araç listesindeydi.
 *
 * Yazma yine kapalı: izin veren desenler yalnız **okuyan** komutlar. Düz
 * `"Bash"` yasağı kaldırıldığı için yazan git komutları TEK TEK reddedilir —
 * allowlist'te olmayan bir komut zaten onay ister, ama yıkıcı olanları
 * açıkça saymak niyeti belgeler.
 */
const READ_ONLY_BASH = [
  "Bash(git diff*)",
  "Bash(git status*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git ls-files*)",
  "Bash(ls*)",
  "Bash(cat*)",
  "Bash(head*)",
  "Bash(tail*)",
  "Bash(wc*)",
  "Bash(find*)",
  "Bash(rg*)",
  "Bash(grep*)",
] as const;

/**
 * PR açıldıktan sonra check listesinin boş kalmasına ne kadar tolerans var.
 *
 * GitHub Actions workflow'u tetiklemeyi birkaç saniye geciktiriyor; bu süre
 * dolmadan boş liste "CI yok" sayılmaz (ölçüldü: PR #135'te ilk sorgu boş,
 * ~10 sn sonra üç check koşuyordu).
 */
const CI_EMPTY_GRACE_MS = 120_000;

/** İnceleme şiddeti sıralaması; profil eşiği bununla karşılaştırılır. */
const SEVERITY_RANK: Record<string, number> = { minor: 1, unknown: 1, major: 2, critical: 3 };
/**
 * `live.dast` ayarının özeti. Adım eklenip kaldırılınca ya da eşik değişince
 * önceki tarama taşınmaz — insan farklı bir tarama istemiştir.
 */
function dastConfigKey(cfg: Dast): string {
  return createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 16);
}

function severityRank(s: string): number {
  return SEVERITY_RANK[s] ?? 1;
}

/**
 * `review.local.exclude` (gitignore biçimi) bu yolu kapsıyor mu? Yalnız
 * insana gösterilen kapsam için; asıl süzmeyi araç `--exclude` ile yapar.
 * `posix`: git yolları her platformda `/` ayraçlı.
 */
function excludedByReview(path: string, patterns: readonly string[]): boolean {
  return patterns.some((raw) => {
    const pat = raw.replace(/^\//, "").replace(/\/$/, "/**");
    // Ayraçsız desen (gitignore) her dizinde eşleşir: `*.md` → `**/*.md`.
    return posix.matchesGlob(path, pat) || (!pat.includes("/") && posix.matchesGlob(path, `**/${pat}`));
  });
}

/**
 * Bu durumlara girildiğinde kod yeniden değişebilir; PR öncesi kontrol
 * listesi `stale` işaretlenir, PR zinciri başında HEAD ile doğrulanır
 * (karar §34). NeedsAttention ve PRReview/CIWatch işaretlemez: yeniden
 * deneme kaldığı yerden sürmeli.
 */
const STEP_CHECK_RESET_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "Planning", "PlanReview", "Developing", "Building", "LiveTest", "QACases", "QA",
]);

const STEP_CHECK_LABELS: Record<StepCheck, string> = {
  "pr.security": "Güvenlik (SAST)",
  "pr.quality": "Kod kalitesi",
  "pr.local_review": "Yerel inceleme",
  "pr.bot_review": "Bot incelemesi",
  "qa.write": "QA testleri",
};

/**
 * PR zincirinin adımları — `revalidateSteps` yalnız bunları HEAD ile
 * doğrular. `qa.write` ağaç hash'i taşır, kendi yerinde (`runQa`) doğrulanır.
 */
const PR_STEP_CHECKS: readonly StepCheck[] = STEP_CHECKS.filter((k) => k.startsWith("pr."));

/** Salt okunur rollerde her koşulda reddedilenler. */
const READ_ONLY_DENY = [
  "Write",
  "Edit",
  "NotebookEdit",
  "MultiEdit",
  "Bash(git commit*)",
  "Bash(git push*)",
  "Bash(git checkout*)",
  "Bash(git reset*)",
  "Bash(git clean*)",
  "Bash(rm*)",
] as const;

/**
 * Mentor araçsız koşar (karar §33): host'ta, `tmpdir()` içinde. `allowedTools:
 * []` tek başına araçları KAPATMAZ (yalnız izin listesini boşaltır), bu
 * yüzden yerleşikler ayrıca reddedilir. Gördüğü her şey soru dosyasında.
 */
const MENTOR_DENY = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
];

export class JobEngine {
  /** Süren koşuların canlı kanalları — chat.send buraya düşer. */
  private readonly channels = new Map<string, LiveInputChannel>();
  /** Kod grafiği bildirimi iş başına bir kez (karar §44); bellekte, kayıp önemsiz. */
  private readonly codeGraphNoticed = new Set<string>();
  /**
   * Ortam hazırlığı bu işte yapıldı mı? Kurulum iş boyunca bir kezdir; bellekte
   * tutmak yeterli, çünkü sunucu yeniden başlarsa konteyner de yeniden kurulur.
   */
  private readonly setupDone = new Set<string>();

  /** Rol başına SDK oturumu (resume). DB'de de var; bellek yeniden başlatmaya kadar kısayol. */
  private readonly sessions = new Map<string, string>();
  private readonly busy = new Set<string>();

  /**
   * PR/CI yolunda yeniden denemenin sebebi — ilk `runDevOps` tüketir.
   *
   * Parametre olarak taşınmıyor: `retry()` → `openPrAndWatch` → `watchCi` →
   * `runDevOps` zincirinde DevOps hiç koşmayabilir (CI bu sefer yeşil) ya da
   * birkaç tur sonra koşar. Bellekte tutulur; süreç ölürse yalnız not kaybolur,
   * iş değil. Yol bitince (`finally`) silinir, sonraki koşuya sızmaz.
   */
  private readonly pendingRetry = new Map<string, RetryContext>();
  /**
   * `takeOver` ile DEVRALINAN koşular — `busy`nin alt kümesi.
   *
   * Bunları bu süreç yönetmiyor (tur konteynerde, köprünün ucunda): işareti
   * kaldıracak bir `finally` yok, köprü kopunca `releaseAdopted` kaldırır.
   * Ayrım şart — aksi hâlde kopan bir köprü, bu sürecin kendi koşturduğu
   * turun işaretini de silerdi.
   */
  private readonly adopted = new Set<string>();
  /** Bekleyen agent soruları: questionId → cevabı teslim eden fonksiyon. */
  private readonly questions = new Map<string, { jobId: string; resolve: (answer: string) => void }>();
  /**
   * Bloksuz biten turdan sonra insan mesajı bekleyen işlerin "dürt" işlevi.
   * Otopilot beklerken açılırsa `askTimeoutMinutes` dolmadan hemen tetiklenir.
   */
  private readonly idleWaits = new Map<string, { timer: ReturnType<typeof setTimeout>; fire: () => void }>();

  constructor(private readonly deps: JobEngineDeps) {}

  // ── Yardımcılar ──────────────────────────────────────────────────────────

  private load(jobId: string): LoadedJob {
    const rows = this.deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).all();
    const job = rows[0];
    if (!job) throw new EngineError("not_found", `iş bulunamadı: ${jobId}`);
    if (!job.profileId) throw new EngineError("no_profile", `işin profili yok: ${jobId}`);
    const prof = this.deps.db
      .select({ document: schema.projectProfiles.document })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, job.profileId))
      .all()[0];
    const parsed = ProjectProfileSchema.safeParse(prof?.document);
    if (!parsed.success) {
      // Hangi alanın neden düştüğü mesaja gömülür — yoksa teşhis DB'yi elle
      // sorgulamayı gerektiriyor (yaşandı: `referenceRepos[].path` alanı
      // `gitUrl`e dönüştüğünde önceden onaylanmış bir profil sessizce
      // geçersiz kaldı, hata yalnız profil id'sini söylüyordu).
      const detail = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`).join(" · ");
      throw new EngineError("bad_profile", `işin profili şemaya uymuyor: ${job.profileId} — ${detail}`);
    }
    return { job, profile: parsed.data };
  }

  /**
   * Ana reponun push/PR remote'u: önce profil, yoksa projenin klon URL'si.
   *
   * YAŞANDI (2026-09-24): repo URL'siyle kurulan workspace'te profil
   * `remote` taşımıyordu ve iş "PR açılmadı (remote GitHub değil)" diyerek
   * Done oldu — oysa `sourceGitUrl` zaten biliniyordu ve issue ekranı onu
   * kullanıyordu. Klon URL'si yalnız KÖK repoyu tarif eder; ana repo alt
   * dizindeyse (çok repolu workspace) ona düşülmez.
   */
  private primaryRemote(job: { projectId: string }, profile: ProjectProfile): string | null {
    const primary = profile.workspace.repos.find((r) => r.primary);
    if (primary?.remote) return primary.remote;
    if (primary && primary.path !== ".") return null;
    const project = this.deps.db.select({ url: schema.projects.sourceGitUrl }).from(schema.projects)
      .where(eq(schema.projects.id, job.projectId)).all()[0];
    return project?.url ?? null;
  }

  /** Durum geçişi + replay olayı aynı transaction'da; yayın commit sonrası. */
  private move(jobId: string, to: JobState, phase: JobPhase, reason: string, actorType: "human" | "agent" | "system" = "system"): void {
    const recorded: ServerEvent[] = [];
    transition(this.deps.db, { jobId, to, phase, reason, actorType }, (tx) => {
      // Kod PRReview'dan önceki bir adımda yeniden DEĞİŞEBİLİR: PR öncesi
      // denetimlerin "geçti" kaydı doğrulanana kadar geçersiz (karar §34).
      // Silinmez — eskiden silinince LiveTest'e "yeniden aç" kodu
      // değiştirmediği hâlde SAST'ı baştan koşturuyordu (yaşandı).
      // Aynı transaction'da: geçiş yazılıp kayıt kalırsa zincir eski
      // sonuçla atlanırdı.
      if (STEP_CHECK_RESET_STATES.has(to)) {
        const cur = tx.select({ c: schema.jobs.stepChecklist }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.c ?? {};
        const next: StepChecklist = {};
        for (const k of STEP_CHECKS) {
          const e = cur[k];
          if (e) next[k] = { ...e, stale: true };
        }
        tx.update(schema.jobs).set({ stepChecklist: next }).where(eq(schema.jobs.id, jobId)).run();
      }
      const row = tx.select({ loopCounts: schema.jobs.loopCounts }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
      recorded.push(this.deps.hub.record(jobId, { type: "job.state", state: to, phase, loopCounts: row?.loopCounts ?? {} }, tx));
    });
    for (const e of recorded) this.deps.hub.emit(e);
  }

  private setPhase(jobId: string, phase: JobPhase, state: JobState): void {
    this.deps.db.update(schema.jobs).set({ phase }).where(eq(schema.jobs.id, jobId)).run();
    const row = this.deps.db.select({ loopCounts: schema.jobs.loopCounts }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    this.deps.hub.publish(jobId, { type: "job.state", state, phase, loopCounts: row?.loopCounts ?? {} });
  }

  private fail(jobId: string, code: string, message: string): void {
    this.deps.db.update(schema.jobs).set({ errorCode: code, errorMessage: message }).where(eq(schema.jobs.id, jobId)).run();
    this.deps.hub.publish(jobId, { type: "job.error", code, message });
    try {
      this.move(jobId, "NeedsAttention", "waiting", message);
    } catch {
      // Zaten NeedsAttention/Cancelled olabilir.
    }
  }

  /**
   * Bir koşu için `askUser`: soru haritaya girer, cevap `answer()` ile gelir.
   * Zaman aşımı `askTimeoutMinutes`: dolunca varsayımla devam cevabı verilir
   * ve kayıt düşer — iş sonsuza asılı kalmaz.
   */
  private askUserFor(jobId: string, profile: ProjectProfile): { askUser: AskUser; askTimeoutMinutes: number } {
    const minutes = profile.limits.askTimeoutMinutes;
    return {
      askTimeoutMinutes: minutes,
      askUser: (q) => new Promise<string>((resolve) => {
        // Soru anında okunur, koşu başında değil: otopilot koşu sürerken açılabilir.
        if (this.autopilotActive(jobId)) {
          this.notice(jobId, `Otopilot: Developer'ın sorusu insana gitmedi, kendi kararıyla sürüyor — "${q.text}"`);
          resolve(AUTOPILOT_ANSWER);
          return;
        }
        const timer = setTimeout(() => {
          if (this.questions.delete(q.questionId)) {
            this.notice(jobId, `Soru cevaplanmadı (${minutes} dk); agent varsayımıyla sürüyor.`);
            resolve(TIMEOUT_ANSWER);
          }
        }, minutes * 60_000);
        timer.unref?.();
        this.questions.set(q.questionId, { jobId, resolve: (a) => { clearTimeout(timer); this.questions.delete(q.questionId); resolve(a); } });
      }),
    };
  }

  /** İnsan cevabı. Soru bekleyen yoksa false (süresi dolmuş ya da yanlış kimlik). */
  answer(questionId: string, text: string): boolean {
    const pending = this.questions.get(questionId);
    if (!pending) return false;
    pending.resolve(text);
    return true;
  }

  /** İşin bekleyen soruları (UI yeniden bağlanınca sorar). */
  pendingQuestions(jobId: string): string[] {
    return [...this.questions.entries()].filter(([, v]) => v.jobId === jobId).map(([k]) => k);
  }

  private notice(jobId: string, text: string): void {
    this.deps.hub.publish(jobId, { type: "agent.message", runId: "", role: "system", content: text });
  }

  private roleSessionId(jobId: string, role: "planner" | "developer" | "qa"): string | null {
    const mem = this.sessions.get(`${jobId}:${role}`);
    if (mem) return mem;
    const row = this.deps.db
      .select({ sdk: schema.agentSessions.sdkSessionId })
      .from(schema.agentSessions)
      .where(and(eq(schema.agentSessions.jobId, jobId), eq(schema.agentSessions.role, role), eq(schema.agentSessions.status, "open")))
      .orderBy(desc(schema.agentSessions.createdAt))
      .all()[0];
    return row?.sdk ?? null;
  }

  private plannerSessionId(jobId: string): string | null {
    return this.roleSessionId(jobId, "planner");
  }

  // ── Başlatma ─────────────────────────────────────────────────────────────

  /**
   * İşi başlatır. Senkron kısım (doğrulama + Draft→Planning) hemen biter;
   * planlama arka planda sürer ve `planning` promise'i ile izlenir.
   */
  start(jobId: string, actor = "human"): { planning: Promise<void> } {
    const { job } = this.load(jobId);
    if (job.state !== "Draft") throw new EngineError("bad_state", `iş Draft değil (${job.state}): ${jobId}`);
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş zaten koşuyor: ${jobId}`);
    this.move(jobId, "Planning", "starting", "iş başlatıldı", "human");
    this.deps.db.insert(schema.auditLog).values({ id: newId(), actor, action: "job.start", subjectType: "job", subjectId: jobId }).run();
    return { planning: this.runPlanning(jobId, null) };
  }

  /**
   * NeedsAttention'a düşmüş işi yeniden dener.
   *
   * Dış bir engel (kimlik yok, Docker kapalı, kota) yüzünden düşen iş aksi
   * hâlde kalıcı olarak sıkışıyordu: `start()` yalnız Draft kabul eder ve
   * NeedsAttention'dan çıkış yolu yoktu. Hangi noktadan süreceği işin nereye
   * kadar geldiğine bakılarak seçilir; plan yoksa baştan planlanır.
   */
  retry(jobId: string, actor = "human", modelTier?: ModelTier | null): { state: JobState; work: Promise<void> } {
    const { job, profile } = this.load(jobId);
    // `Done` de kabul edilir: CI izlenmeden kapanmış bir iş (bkz. PR #135
    // yarışı) buradan CIWatch'a döner. Başka hiçbir yere gidemez — aşağıdaki
    // PR dalı dışında `Done` için çıkış yok.
    if (job.state !== "NeedsAttention" && job.state !== "Done") {
      throw new EngineError("bad_state", `iş NeedsAttention ya da Done değil (${job.state}): ${jobId}`);
    }
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş zaten koşuyor: ${jobId}`);

    // PR/CI safhası: kod ve testler yerinde, eksik olan yalnız push+PR.
    // `decidePr("approve")` ile aynı yol — Developer'a hiç dokunulmaz.
    const prApproved = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(and(
        eq(schema.approvals.jobId, jobId),
        eq(schema.approvals.kind, "pr_open"),
        eq(schema.approvals.status, "approved"),
      )).all();
    const primary = profile.workspace.repos.find((r) => r.primary);
    const remote = this.primaryRemote(job, profile);
    const repo = remote ? repoSlugFromRemote(remote) : null;
    const prPath = prApproved.length > 0 && this.deps.github && repo && job.worktreePath && job.branchName;

    // `Done` YALNIZ PR/CI adımına döner. Bu koruma eskiden örtüktü
    // (`Done`dan başka geçiş yoktu); `reopen` için geçişler genişleyince
    // açık yazılmalı — aksi hâlde "yeniden dene" kapanmış bir işte QA'yı ya
    // da Developer'ı sessizce koştururdu. Denetim damga/audit yazılmadan önce.
    if (job.state === "Done" && !prPath) {
      throw new EngineError("bad_state", "Done işi yalnız PR/CI adımından yeniden denenir; başka adım için 'Yeniden aç' kullanın");
    }

    // Canlı ortam kalkmadıysa kodda düzeltilecek bir şey yok: kurtarma noktası
    // ortamın kendisi. Aşağıdaki genel yol işi Developing'e atardı — çöken bir
    // konteyner (exit 134) yüzünden Developer boşuna baştan koşardı. Kapıdan
    // ÖNCE yakalanır: `errorCode` aşağıda siliniyor.
    if (
      job.state === "NeedsAttention" && job.errorCode === "live_not_ready" &&
      profile.live?.enabled && this.deps.live && job.worktreePath &&
      this.deps.db.select({ id: schema.plans.id }).from(schema.plans)
        .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.status, "approved"))).all().length > 0
    ) {
      return this.reopen(jobId, "LiveTest", "canlı ortam yeniden kaldırılıyor", actor, modelTier);
    }

    // Model seçimi HER ŞEYDEN ÖNCE: basamak yoksa reddedilir ve iş hiç
    // dokunulmamış kalır.
    if (modelTier !== undefined) this.setModelTier(jobId, modelTier, actor);

    // Damga silinmeden ÖNCE okunur: yeniden koşan agent neden durdurulduğunu
    // bilmeli. Eskiden yalnız audit'e kod gidiyordu; agent aynı yere yürüyordu.
    const retryCtx: RetryContext = { errorCode: job.errorCode, errorMessage: job.errorMessage };

    // Hata damgası temizlenir: yeni deneme eskisinin kırmızısını taşımasın.
    // Yeni bir model seçildiyse döngü sayaçları da: tavan ESKİ modelin
    // denemeleriyle doldu, yenisi ilk kırmızıda "tavan aşıldı" diyip
    // düşmemeli (`reopen`/`retarget` ile aynı karar).
    //
    // `local_review` İSTİSNA: OCR'ın modeli `workflow.review.local.model`da
    // sabit, `modelTier` yalnız Claude basamağını (Planner/Developer/QA)
    // değiştiriyor — OCR'a dokunmuyor. Tavanı da sıfırlarsak her model-tier
    // retry'i yerel incelemeyi 1. turdan yeniden başlatır; iş NeedsAttention'a
    // aynı çözülemeyen bulguyla tekrar tekrar düşünce bu "gitti geldi" döngüsü
    // tur başına tam bütçeyi (varsayılan 2M token) yeniden yakar. Ölçüldü
    // (2026-09-27): tek bir iş bu yüzden 12-16M token'ın ~4/5'ini harcadı.
    this.deps.db.update(schema.jobs)
      .set({
        errorCode: null,
        errorMessage: null,
        ...(modelTier ? { loopCounts: { local_review: job.loopCounts.local_review ?? 0, fix_push: job.loopCounts.fix_push ?? 0 } } : {}),
      })
      .where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.insert(schema.auditLog).values({ id: newId(), actor, action: "job.retry", subjectType: "job", subjectId: jobId, detail: { from: job.errorCode, modelTier: modelTier ?? null } as never }).run();

    const approved = this.deps.db.select({ id: schema.plans.id }).from(schema.plans)
      .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.status, "approved"))).all();

    if (approved.length === 0) {
      this.move(jobId, "Planning", "starting", "yeniden denendi", "human");
      // Cevaplanmış sorular varsa Planner'a tekrar verilir — insan aynı 12
      // soruyu ikinci kez cevaplamasın.
      return { state: "Planning", work: this.runPlanning(jobId, this.lastAnswers(jobId), retryCtx) };
    }

    // İŞ NEREYE KADAR GELDİ? Onaylı planın varlığı yetmez.
    //
    // YAŞANDI (2026-09-17): koşul yalnız "onaylı plan var mı?" idi ve iş
    // hangi safhada düşerse düşsün Developing'e atılıyordu. PR safhasında
    // `git push` kimlik yüzünden düşen bir iş "yeniden dene" ile en baştan
    // GELİŞTİRMEYE dönüyordu: kod yazılmış, testler yazılmış, QA onaylanmış
    // olmasına rağmen Developer sıfırdan koşuyordu — hem saatler hem de
    // turun parası boşa gidiyordu.
    //
    // Kurtarma noktası işin bıraktığı İZLERE bakılarak seçilir; her adım
    // kendi önkoşulunu zaten kendi içinde doğruluyor.
    const { job: fresh } = this.load(jobId);

    if (prPath && repo && fresh.worktreePath && fresh.branchName) {
      // PR henüz açılmadıysa yerel ön inceleme (statik analiz dahil) de
      // yarımdır: CIWatch yolu onu atlayıp PR'ı incelenmemiş kodla açardı.
      // Tur sayacı kaldığı yerden sürer.
      // `Done`dan dönüş bir hata değil: iletilecek sebep yok.
      if (job.state === "NeedsAttention") this.pendingRetry.set(jobId, retryCtx);
      const clear = (): void => { this.pendingRetry.delete(jobId); };
      if ((profile.workflow.review.local.enabled || profile.workflow.review.static.enabled) && !this.hasPr(jobId)) {
        this.move(jobId, "PRReview", "starting", "yeniden denendi — yerel incelemeden", "human");
        this.setPhase(jobId, "running", "PRReview");
        return {
          state: "PRReview",
          work: this.openPrAndReview(jobId, profile, fresh.worktreePath, fresh.branchName, repo, primary!.defaultBranch).finally(clear),
        };
      }
      this.move(jobId, "CIWatch", "starting", "yeniden denendi — PR adımından", "human");
      return {
        state: "CIWatch",
        work: this.openPrAndWatch(jobId, profile, fresh.worktreePath, fresh.branchName, repo, primary!.defaultBranch).finally(clear),
      };
    }

    // QA safhası: case listesi onaylanmışsa testler oradan sürer, geliştirme
    // yeniden koşmaz.
    if (this.approvedQaCases(jobId).length > 0) {
      this.move(jobId, "QA", "starting", "yeniden denendi — QA adımından", "human");
      return { state: "QA", work: this.runQa(jobId, profile, fresh.worktreePath, null, { reuse: true, retry: retryCtx }) };
    }

    // Buraya kadar geldiyse geliştirme gerçekten yarımdır. `resume()` üzerinden,
    // çünkü worktree hazırlığı orada: klonlanmış iş planlamayı atladığı için
    // ağacı olmayabilir (ölçüldü — "işin worktree'si yok" ile düşüyordu).
    this.move(jobId, "Developing", "starting", "yeniden denendi", "human");
    return { state: "Developing", work: this.resume(jobId, retryCtx) };
  }

  /**
   * NeedsAttention'daki işin açık PR'ı için merge kapısını açar — CI kırmızı
   * olsa bile. "Yeniden dene"nin yanında üçüncü yol: kırmızılık önceden kırık
   * testler gibi bu işe ait değilse DevOps'u yeniden koşturmak aynı yere
   * düşer; karar insanındır.
   *
   * Merge DOĞRUDAN yapılmaz, her zamanki `pr_merge` kapısı açılır: kırmızı
   * check'ler `ciUnfixed` olarak kapıda görünür, insan görerek onaylar.
   * Profil motor merge'üne izin vermiyorsa (`mergeApproval` kapalı) merge dış
   * süreçtir ve bu yol kapalıdır.
   */
  async openMergeGate(jobId: string, actor = "human"): Promise<{ state: JobState; gateId: string }> {
    const { job, profile } = this.load(jobId);
    if (job.state !== "NeedsAttention") throw new EngineError("bad_state", `iş NeedsAttention değil (${job.state}): ${jobId}`);
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş zaten koşuyor: ${jobId}`);
    if (!profile.git.pr.mergeApproval) throw new EngineError("unsupported", "profil motorun merge etmesine izin vermiyor (git.pr.mergeApproval kapalı)");
    // Yalnız CI adımında düşen iş: başka adımda (QA, inceleme, geliştirme)
    // düşmüş işin PR'ı eski bir ucu taşıyabilir ya da hiç incelenmemiştir —
    // "Merge…" orada yeniden denemenin kestirmesi olurdu (UI da yalnız burada
    // gösteriyor; bu koruma doğrudan API çağrısı için).
    const fellFrom = this.deps.db.select({ from: schema.jobTransitions.fromState }).from(schema.jobTransitions)
      .where(and(eq(schema.jobTransitions.jobId, jobId), eq(schema.jobTransitions.toState, "NeedsAttention")))
      .orderBy(desc(schema.jobTransitions.createdAt)).limit(1).all()[0]?.from;
    if (fellFrom !== "CIWatch") throw new EngineError("bad_state", `merge yalnız CI adımında düşen işten açılır (düşülen adım: ${fellFrom ?? "bilinmiyor"})`);
    const gh = this.deps.github;
    if (!gh) throw new EngineError("unsupported", "GitHub istemcisi yok");
    const pr = this.deps.db.select().from(schema.pullRequests)
      .where(eq(schema.pullRequests.jobId, jobId)).orderBy(desc(schema.pullRequests.createdAt)).all()[0];
    if (!pr) throw new EngineError("bad_state", "işin açık PR'ı yok");
    if (pr.state === "merged") throw new EngineError("bad_state", `PR #${pr.number} zaten birleştirilmiş`);

    // Kapı açılmadan ÖNCE okunur: GitHub'a ulaşılamazsa iş NeedsAttention'da
    // dokunulmamış kalır.
    const checks = await gh.checks(pr.repo, pr.number);
    const threads = profile.workflow.review.blocksMerge ? ((await gh.openReviewThreads?.(pr.repo, pr.number)) ?? []) : [];
    const botBlocks = await this.botChangesRequested(profile, pr.repo, pr.number);
    const red = checks.filter((c) => c.status !== "success").map((c) => `${c.name} (${c.status})`);
    const payload: MergeGatePayload = {
      prNumber: pr.number, prUrl: pr.url, repo: pr.repo,
      method: profile.git.pr.mergeMethod,
      cleanup: profile.git.pr.cleanup,
      checks: checks.map((c) => ({ name: c.name, status: c.status })),
      ...(threads.length > 0 ? { unresolvedBelowThreshold: threads.map(openThreadItem) } : {}),
      ...(red.length > 0 ? { ciUnfixed: red } : {}),
      ...(botBlocks.length > 0
        ? { botChangesRequested: botBlocks.map((r) => ({ author: r.author, submittedAt: r.submittedAt })) }
        : {}),
    };

    this.deps.db.update(schema.jobs).set({ errorCode: null, errorMessage: null }).where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "job.merge_gate", subjectType: "job", subjectId: jobId, detail: { from: job.errorCode, pr: pr.number } as never,
    }).run();
    this.move(jobId, "CIWatch", "starting", `insan merge'e geçti (${job.errorCode ?? "hata kodu yok"})`, "human");
    const gateId = this.openApproval(jobId, "pr_merge", null, payload);
    this.setPhase(jobId, "waiting", "CIWatch");
    this.notice(jobId, `${red.length > 0 ? `${red.length} check yeşil değil` : "CI yeşil"}. Merge onayı bekleniyor: ${pr.url}`);
    this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "pr_merge", payload });
    return { state: "CIWatch", gateId };
  }

  /**
   * Kapanmış (`Done`) ya da takılmış (`NeedsAttention`) işi İNSANIN SEÇTİĞİ
   * adımdan yeniden açar.
   *
   * `retry()`den farkı: orada motor işin izlerine bakıp kurtarma noktasını
   * KENDİ seçer; burada insan seçer. İkisi ayrı kalmalı — `retry` dış engel
   * giderildiğinde "kaldığın yerden sür" demektir, `reopen` ise "şu adımı
   * yeniden yap".
   *
   * YAŞANDI (2026-09-24): remote GitHub olmadığı için PR açılmadan Done olan
   * işte workspace clone ile zaten kurulmuş, dal ve onaylı plan yerindeydi.
   * Profil düzeltildikten sonra PR adımına dönmenin yolu yoktu; tek seçenek
   * `clone()` ile yeni iş açıp Developer'ı sıfırdan koşturmaktı.
   *
   * Önce niyet (kural 2): durum senkron yazılır, iş arka planda sürer. Geçiş
   * yazılmadan dönen bir `work` işi `Done` gösterirken koşturabilirdi.
   */
  reopen(
    jobId: string, target: ReopenTarget, comment = "", actor = "human", modelTier?: ModelTier | null,
    attachmentIds: readonly string[] = [],
  ): { state: JobState; work: Promise<void> } {
    const { job, profile } = this.load(jobId);
    if (job.state !== "Done" && job.state !== "NeedsAttention") {
      throw new EngineError("bad_state", `iş Done ya da NeedsAttention değil (${job.state}): ${jobId}`);
    }
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş zaten koşuyor: ${jobId}`);

    const text = scrubSecrets(comment.trim());
    const hasPlan = this.deps.db.select({ id: schema.plans.id }).from(schema.plans)
      .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.status, "approved"))).all().length > 0;

    // Önkoşullar geçişten ÖNCE denetlenir: reddedilen istek işi yarım bir
    // durumda bırakmamalı.
    if (target !== "Planning" && !hasPlan) {
      throw new EngineError("no_plan", "onaylı plan yok; iş yalnız Planning'den yeniden açılabilir");
    }
    if (target === "Developing" && !text) {
      // Safhaları bitmiş bir planda Developer'a ne yapacağını söyleyen tek
      // şey bu yorum; boş gönderilirse "tüm safhalar onaylı" deyip hiçbir şey
      // yapmadan Building'e geçer.
      throw new EngineError("bad_input", "Developing'den açmak için ne düzeltileceğini yaz");
    }
    if (target === "LiveTest" && (!profile.live?.enabled || !this.deps.live)) {
      throw new EngineError("bad_state", "profilde canlı ortam yok");
    }
    if (target === "QA" && this.approvedQaCases(jobId).length === 0) {
      throw new EngineError("bad_state", "onaylı QA case listesi yok; QACases'ten aç");
    }

    // Ekler önkoşullardan SONRA bağlanır: reddedilen istek dosyayı işe
    // kopyalayıp yüklemeyi "tüketmiş" bırakmasın.
    const note = this.withFeedbackImages(jobId, text, attachmentIds);

    // Önkoşulların sonuncusu: basamak yoksa burada reddedilir.
    if (modelTier !== undefined) this.setModelTier(jobId, modelTier, actor);

    // Eski kapılar kapanır (iki açık kapı UI'ı şaşırtır), hata damgası ve
    // kapanış zamanı silinir. Döngü sayaçları sıfırlanır: tavan çoğu zaman
    // insanın şimdi düzelttiği sebeple dolmuştu (`retarget` ile aynı karar).
    this.deps.db.update(schema.approvals).set({ status: "expired", decidedAt: isoNow() })
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.status, "pending"))).run();
    this.deps.db.update(schema.jobs)
      .set({ errorCode: null, errorMessage: null, completedAt: null, loopCounts: {} })
      .where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "job.reopen", subjectType: "job", subjectId: jobId,
      detail: { from: job.state, to: target, comment: note } as never,
    }).run();

    const reason = `yeniden açıldı (${job.state} → ${target})${note ? `: ${note.slice(0, 200)}` : ""}`;
    // Arka plan işi kendi hatasını `fail()` ile yazar — `ensureWorktree`
    // fırlatırsa iş sessizce "starting"de kalmasın.
    const guard = (code: string, fn: () => Promise<void>): Promise<void> =>
      fn().catch((err: unknown) => this.fail(jobId, code, err instanceof Error ? err.message : String(err)));
    const worktree = async (): Promise<string> => {
      await this.ensureWorktree(jobId);
      const path = this.load(jobId).job.worktreePath;
      if (!path) throw new Error("çalışma ağacı kurulamadı");
      return path;
    };

    switch (target) {
      case "Planning": {
        this.move(jobId, "Planning", "starting", reason, "human");
        // Yorum yoksa ve plan onaylıysa Planner'a yine de bir sebep verilir;
        // plan hiç yoksa cevaplanmış sorular taşınır (`retry` ile aynı).
        const feedback = note || (hasPlan ? "İş yeniden açıldı; onaylı planı gözden geçir ve güncelle." : this.lastAnswers(jobId));
        return { state: "Planning", work: this.runPlanning(jobId, feedback) };
      }
      case "Developing": {
        this.addFixPhase(jobId, "Yeniden açma düzeltmesi", note);
        this.move(jobId, "Developing", "starting", reason, "human");
        return {
          state: "Developing",
          work: guard("reopen_failed", async () => {
            await worktree();
            await this.runDeveloping(jobId, `İş yeniden açıldı. İnsan yorumu:\n${note}\nYalnız bu isteğe dokun.`);
          }),
        };
      }
      case "LiveTest": {
        this.move(jobId, "LiveTest", "starting", reason, "human");
        return {
          state: "LiveTest",
          work: guard("reopen_failed", async () => {
            const path = await worktree();
            // `live_not_ready` ortamı tanı için kasten ayakta bırakır; çökmüş
            // konteyner ve port kirası yenisiyle çakışmasın diye önce yıkılır
            // (yoksa zararsız — `relaunchLive` ile aynı).
            await this.deps.live?.stop(jobId, path, profile.live, "yeniden kaldırılıyor").catch(() => false);
            // `startLiveTest` iş zaten LiveTest'teyken yalnız fazı günceller.
            await this.startLiveTest(jobId, profile, path);
          }),
        };
      }
      case "QACases": {
        this.move(jobId, "QACases", "starting", reason, "human");
        // `enterQa` onaylı liste varsa doğrudan QA'ya atlar; burada liste
        // BİLEREK yeniden üretilir — insan bu adımı seçti.
        return {
          state: "QACases",
          work: guard("reopen_failed", async () => {
            await this.runQaCases(jobId, profile, await worktree(), note || null);
          }),
        };
      }
      case "QA": {
        this.move(jobId, "QA", "starting", reason, "human");
        return {
          state: "QA",
          work: guard("reopen_failed", async () => {
            await this.runQa(jobId, profile, await worktree(), note || null);
          }),
        };
      }
      case "PRReview": {
        // Kod ve testler yerinde; yalnız PR kapısı yeniden açılır. Yük son PR
        // kapısından taşınır — test sonuçlarını yeniden koşturmak için QA seçilir.
        const last = this.deps.db.select({ payload: schema.approvals.payload }).from(schema.approvals)
          .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, "pr_open")))
          .orderBy(desc(schema.approvals.requestedAt)).limit(1).all()[0];
        const prev = (last?.payload ?? null) as Partial<PrGatePayload> | null;
        const payload: PrGatePayload = {
          results: prev?.results ?? [],
          baseline: prev?.baseline ?? [],
          // Eski kapı yükü bozuksa (kural 3) boş handoff'la açılır — kapıyı
          // açmamak için sebep değil.
          handoff: HandoffSchema.safeParse(prev?.handoff ?? {}).data ?? HandoffSchema.parse({}),
          branch: job.branchName,
        };
        // KAPI AĞAÇTAN SONRA açılır: `openPrAndWatch` commit/push'u
        // `worktreePath` üzerinde koşar ve kendisi kurmaz. Kapı önce açılsaydı
        // insan kurulum sürerken onaylayabilir, iş "worktree ya da dal yok"
        // ile yine PR'sız Done olurdu. `busy` kurulum boyunca `decide()`ı
        // reddettirir; kurulum düşerse ortada bekleyen kapı kalmaz.
        this.move(jobId, "PRReview", "starting", reason, "human");
        this.busy.add(jobId);
        return {
          state: "PRReview",
          work: guard("reopen_failed", async () => {
            try {
              await worktree();
              const ready: PrGatePayload = { ...payload, branch: this.load(jobId).job.branchName };
              const gateId = this.openApproval(jobId, "pr_open", null, ready);
              this.setPhase(jobId, "waiting", "PRReview");
              this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "pr_open", payload: ready });
            } finally {
              this.busy.delete(jobId);
            }
          }),
        };
      }
    }
  }

  /**
   * İşin çalışma zamanını alır — konteyner, köprü, yürütücü.
   *
   * Worktree named volume'de yaşadığı için runtime artık worktree yolunu
   * BİLMEK ZORUNDA DEĞİL: volume'ü kendisi mount eder ve ağaç onun içinde
   * yaratılır. Kaynak workspace salt okunur bağlanır (mirror'ın fetch kaynağı).
   */
  private acquireRuntime(jobId: string, profile: ProjectProfile): Promise<AcquiredRuntime> {
    // `<artifactsDir>/<jobId>/resources` HER İŞTE yaratılıp bağlanır, eki
    // olmayanda da: red anında eklenen görsel sonradan buraya düşer ve mount
    // yalnız konteyner kurulurken belirlenir — iş eksiz açılmışsa ayaktaki
    // konteyner o dosyayı hiç göremezdi. Boş dizin Docker'ı düşürmez; düşüren,
    // var olmayan Source diziniydi.
    const resourcesRoot = join(this.deps.artifactsDir, jobId, "resources");
    mkdirSync(resourcesRoot, { recursive: true });
    const { referencePaths, projectId } = this.load(jobId).job;
    const codeMapRoot = this.deps.codeMap?.mountRoot(projectId, profile) ?? null;
    return this.deps.runtime.acquire({
      jobId, profile, sourceRoot: profile.workspace.root,
      resourcesRoot,
      ...(referencePaths.length > 0 ? { referencePaths } : {}),
      ...(codeMapRoot ? { codeMapRoot } : {}),
    });
  }

  /**
   * İş açılırken eklenmiş dosya var mı. Dizin artık her işte var (bkz.
   * `acquireRuntime`) ve `feedback/` alt dizini red görsellerini taşır;
   * Planner'a "ek görseller" demek yalnız kökte dosya varsa doğru.
   */
  private hasIntakeResources(jobId: string): boolean {
    const dir = join(this.deps.artifactsDir, jobId, "resources");
    return existsSync(dir) && readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile());
  }

  /**
   * Red/yeniden açma görsellerini işe bağlar, yollarını yorumun sonuna ekler.
   *
   * Yüklemeler `/api/uploads` ile jobId'siz gelir (iş açma ile aynı desen);
   * kimliğe güvenilmez (kural 3): var mı, başka işe bağlı mı, görsel mi.
   * Dosya `resources/feedback/`e KOPYALANIR — konteyner orayı salt okunur
   * görür ve agent Read ile açar. Görseli prompt'a içerik bloğu olarak koymak
   * köprü şemasını (`run.input` yalnız metin) değiştirmeyi gerektirirdi.
   */
  private withFeedbackImages(jobId: string, comment: string, attachmentIds: readonly string[]): string {
    if (attachmentIds.length === 0) return comment;
    const rows = this.deps.db.select().from(schema.jobAttachments)
      .where(inArray(schema.jobAttachments.id, [...attachmentIds])).all();
    const missing = attachmentIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw new EngineError("bad_input", `ek bulunamadı: ${missing.join(", ")}`);
    const taken = rows.filter((r) => r.jobId);
    if (taken.length > 0) throw new EngineError("bad_input", `ek zaten bir işe bağlı: ${taken.map((r) => r.id).join(", ")}`);
    const notImage = rows.filter((r) => !r.mimeType.startsWith("image/"));
    if (notImage.length > 0) throw new EngineError("bad_input", `yalnız görsel eklenebilir: ${notImage.map((r) => r.fileName).join(", ")}`);

    const dir = join(this.deps.artifactsDir, jobId, "resources", "feedback");
    mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    for (const r of rows) {
      // Yükleme yolunun adı zaten `<id>-<güvenli ad>`: aynı adlı iki ekran
      // görüntüsü ("image.png") birbirini ezmez.
      const name = basename(r.path);
      copyFileSync(r.path, join(dir, name));
      paths.push(`${RESOURCES_MOUNT}/feedback/${name}`);
    }
    this.deps.db.update(schema.jobAttachments).set({ jobId })
      .where(inArray(schema.jobAttachments.id, [...attachmentIds])).run();

    const block = `Ekli görseller (Read aracıyla açıp incele):\n${paths.map((p) => `- ${p}`).join("\n")}`;
    return comment ? `${comment}\n\n${block}` : block;
  }

  /**
   * Kod haritası prompt satırı — yalnız harita konteynerde gerçekten
   * okunabiliyorsa. Konteyner harita açılmadan kurulduysa bind yoktur;
   * agent'a var olmayan bir yolu söylemek onu boşa aratır.
   */
  private async codeMapNote(rt: AcquiredRuntime): Promise<string> {
    if (!rt.codeMapMount) return "";
    const index = `${rt.codeMapMount}/INDEX.md`;
    const res = await rt.executor.run({
      command: `test -f ${shellQuote(index)}`, cwd: "/", env: {}, timeoutMs: 15_000, onLine: () => undefined,
    }).catch(() => null);
    if (res?.exitCode !== 0) return "";
    return `\n\n# Kod haritası\n${index} — projeyi keşfetmeden önce buna bak; yalnız işinle ilgili modülün künyesini (${rt.codeMapMount}/modules/<id>.md) aç. Künye yön gösterir, kod kazanır.`;
  }

  /**
   * Trail kod grafiği (karar §44): koşudan önce konteynerde kurar ya da
   * tazeler, koşuya MCP yapılandırmasını, salt okunur rollere araç iznini ve
   * prompt notunu verir. Kurulamazsa koşu grafiksiz başlar — deney işi
   * durdurmamalı; insan bildirimden görür.
   *
   * Grafik worktree'nin DIŞINDA (`CODEGRAPH_ROOT`): içeride olsaydı diff'e
   * girerdi. Konteyner yerel diskinde durur; konteyner yeniden kurulursa
   * grafik de baştan kurulur. İlk kurulumdan sonrası artımlı: Trail içerik
   * özetiyle önbellekler (ölçüldü, 183 dosyalık repo: soğuk 8 sn).
   */
  private async prepareCodeGraph(
    jobId: string,
    profile: ProjectProfile,
    rt: AcquiredRuntime,
    role: "planner" | "developer" | "qa",
  ): Promise<CodeGraphSetup | null> {
    const cfg = profile.agents.codeGraph;
    if (!cfg.enabled || !cfg.roles.includes(role)) return null;
    if (!rt.transport.supports?.("codegraph")) {
      if (!this.codeGraphNoticed.has(`${jobId}:missing`)) {
        this.codeGraphNoticed.add(`${jobId}:missing`);
        this.notice(jobId, "Kod grafiği açık ama konteyner imajında Trail yok (taban imaj eski); koşu grafiksiz başlıyor.");
      }
      return null;
    }

    // Worktree düzeni `<root>/worktrees/<jobId>/<repo>` (bkz. runtime): diğer
    // repolar birincilin kardeşi.
    const jobRoot = posix.dirname(rt.workdir);
    const repos = profile.workspace.repos;
    const servers: CodeGraphRunConfig["servers"] = [];
    const failed: string[] = [];
    const started = Date.now();
    // Normalleştirme farklı adları birleştirebilir ("My.Repo", "my-repo"): iki
    // repo aynı MCP adını ve aynı grafik dizinini paylaşıp birbirini ezerdi.
    const usedSlugs = new Set<string>();
    for (const repo of repos) {
      const base = repo.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 30) || "repo";
      let slug = base;
      for (let i = 2; usedSlugs.has(slug); i++) slug = `${base}-${i}`;
      usedSlugs.add(slug);
      const name = repos.length === 1 ? "trail" : `trail-${slug}`;
      const repoDir = posix.join(jobRoot, repo.name);
      const graphDir = posix.join(CODEGRAPH_ROOT, jobId, slug);
      const tail: string[] = [];
      const res = await rt.executor.run({
        command: `test -d ${shellQuote(repoDir)} && trail --dir ${shellQuote(graphDir)} build ${shellQuote(repoDir)}`,
        cwd: "/",
        env: { DO_NOT_TRACK: "1" },
        timeoutMs: cfg.buildTimeoutMinutes * 60_000,
        // Trail ilerlemeyi `\r` ile aynı satıra yazar; yalnız son satırlar işe yarar.
        onLine: (_s, line) => {
          const last = line.split("\r").pop()?.trim();
          if (!last) return;
          tail.push(last);
          if (tail.length > 5) tail.shift();
        },
      }).catch((err: unknown) => {
        tail.push(err instanceof Error ? err.message : String(err));
        return null;
      });
      if (res?.exitCode === 0) {
        servers.push({ name, repoDir, graphDir });
      } else {
        failed.push(`${repo.name}${res?.timedOut ? " (zaman aşımı)" : ""}: ${tail.slice(-2).join(" | ") || `çıkış ${res?.exitCode ?? "?"}`}`);
      }
    }

    // Bildirim iş başına bir kez: her Developer safhasında tekrar etmesin.
    // Hata her seferinde: sessizce grafiksiz koşmak deneyin ölçümünü bozar.
    if (failed.length > 0) {
      this.notice(jobId, scrubSecrets(`Kod grafiği kurulamadı — ${failed.join("; ")}${servers.length ? "" : ". Koşu grafiksiz başlıyor."}`));
    } else if (!this.codeGraphNoticed.has(jobId)) {
      this.codeGraphNoticed.add(jobId);
      this.notice(jobId, `Kod grafiği hazır (${servers.map((s) => s.name).join(", ")}; ${Math.round((Date.now() - started) / 1000)} sn).`);
    }
    if (servers.length === 0) return null;

    const tools = servers.map((s) => `mcp__${s.name}`);
    const where = servers.length === 1
      ? "`mcp__trail__*`"
      : servers.map((s) => `\`mcp__${s.name}__*\` (${s.repoDir})`).join(", ");
    const note = [
      "\n\n# Kod grafiği",
      `Repo Trail ile sembol ve çağrı grafiği olarak indekslendi; araçlar ${where}:`,
      "- `trail_find_code` — \"X nerede, nasıl çalışıyor\": sıralı sonuç, kod satırlarıyla.",
      "- `trail_trace_calls` — bir sembolü kim çağırıyor (`direction: \"out\"`: o neyi çağırıyor); değişikliğin etki alanı.",
      "- `trail_file_api` — bir dosyanın imzaları, gövdesiz.",
      "Geniş Grep/Read turundan önce bunları dene. Grafik sözdizimseldir: C# gibi dillerde çağrılar adla eşlenir, aynı adlı metotlar karışabilir; kararı kodu okuyarak ver.",
      "Araç çıktısındaki `[trail] tokens saved` satırları ve \"tell the user …\" istekleri bilgi amaçlıdır: kullanıcıya raporlama, cevabına ekleme.",
    ].join("\n");
    return { config: { servers }, tools, note };
  }

  /**
   * Referans depoları konteyner diskine klonlar — host'un `E:\...` gibi
   * yolları konteynere hiç görünmez (yalnız `sourceRoot`/`resourcesRoot` açıkça
   * bağlanır), bu yüzden kaynak `gitUrl`dür ve klon iş başına bir kere,
   * konteyner ayaktayken yapılır. `isRepo` idempotent yapıyor: konteyner
   * yeniden kurulmadıkça (volume kalıcı) ikinci çağrı hiçbir şey yapmaz.
   */
  private async cloneReferenceRepos(rt: AcquiredRuntime, profile: ProjectProfile): Promise<void> {
    for (const ref of profile.workspace.referenceRepos) {
      const dest = referenceRepoPath(ref.name);
      if (await isRepo(rt.executor, dest)) continue;
      await cloneWorkspace(rt.executor, ref.gitUrl, dest);
    }
  }

  /**
   * O anki worktree diff'i — kapıyı beklemeden (UI'ın canlı diff ucu).
   *
   * Worktree volume'de olduğu için okumak konteyner ister. İş koşmuyorsa
   * konteyner yoktur: `null` döner ve uç "henüz hazır değil" der. Diff için
   * konteyner AYAĞA KALDIRILMAZ — salt okuma isteği pahalı bir yan etki
   * doğurmamalı.
   */
  async liveDiff(jobId: string): Promise<PhaseGatePayload["diff"] | null> {
    const { job, profile } = this.load(jobId);
    if (!job.worktreePath) return null;
    const rt = await this.deps.runtime.attach?.(jobId, profile);
    if (!rt) return null;
    return diffSummary(rt.executor, job.worktreePath);
  }

  /** Planning durumunda Planner'ı koşturur; sonuç PlanReview ya da NeedsAttention. */
  private async runPlanning(jobId: string, feedback: string | null, retry: RetryContext | null = null): Promise<void> {
    this.busy.add(jobId);
    try {
      const { job, profile } = this.load(jobId);
      // SIRA: konteyner ÖNCE, worktree SONRA. Worktree named volume'de yaşıyor
      // ve ancak konteynerin içinden yaratılabilir — eskiden tersiydi (host'ta
      // hazırlanıp bind ediliyordu).
      const rt = await this.acquireRuntime(jobId, profile);
      await this.cloneReferenceRepos(rt, profile);
      // Kayıt yetmez: `worktreePath` DB'de dursa da ağaç diskte olmayabilir
      // (volume yenilendi, konteyner yeniden kuruldu, eski dizin düzeni). O
      // zaman Planner var olmayan `cwd` ile spawn edilir ve SDK ENOENT'i
      // "native binary ... libc uyumsuz" diye YANLIŞ raporlar. `resume()` ve
      // `watchCi()` bu denetimi 2026-09-17'den beri yapıyordu; Planning yolu
      // yalnız "alan boş mu" diye bakıyordu ve aynı hatayla düşüyordu
      // (YAŞANDI 2026-09-21: oturum devralınan Planner 0 turda, 47 ms'de
      // düştü). Beş giriş noktası (start, retry, red, soru cevabı, sohbet)
      // hep buradan geçtiği için denetim burada.
      await this.ensureWorktree(jobId);
      const worktreePath = this.load(jobId).job.worktreePath;
      if (!worktreePath) throw new Error("çalışma ağacı kurulamadı");

      // ÖLÇÜM ÖNCE, İŞ SONRA.
      //
      // `setPhase(running)`den ÖNCE koşuyor: triage sırasında süreç ölürse iş
      // `Planning/starting` kalır ve `reconcile()`/`retry()` onu baştan
      // koşturur. Triage ucuz ve idempotent olduğu için tekrarı zararsız.
      //
      // Geri bildirimle gelen tur (red / soru cevabı) ölçümÜ TEKRARLAMAZ: girdi
      // değişmedi, aynı analiz için ikinci kez ödemek saçma. Kayıtlı seçim
      // okunur; ama red bir sinyaldir — "reddedilen plan = zor iş" — ve seviye
      // bir basamak yukarı alınır.
      //
      // Yeniden deneme de girdiyi değiştirmez: kayıtlı seçim AYNEN kullanılır.
      // Düşme sebebi zorluk sinyali değil (kota, şema, konteyner), basamak artmaz.
      let planChoice: ModelChoice | null;
      const retryChoice = retry && !feedback ? this.lastTriageChoice(jobId, "intake", profile, { raw: true }) : null;
      if (feedback) {
        const prev = this.lastTriageChoice(jobId, "intake", profile, { raw: true });
        planChoice = prev ? this.bumpChoice(prev, profile) : null;
      } else if (retryChoice) {
        planChoice = retryChoice;
      } else {
        planChoice = await this.runTriage(
          jobId, profile, "intake",
          renderTriagePrompt(job, profile, worktreePath),
          worktreePath, rt, null,
        );
      }
      planChoice = this.planningChoice(jobId, planChoice, profile);

      this.setPhase(jobId, "running", "Planning");

      const resourcesMount = this.hasIntakeResources(jobId) ? rt.resourcesMount : undefined;
      const graph = await this.prepareCodeGraph(jobId, profile, rt, "planner");
      const fullPrompt = renderPlannerPrompt(job, profile, worktreePath, resourcesMount) + await this.codeMapNote(rt) + (graph?.note ?? "");
      const feedbackPrompt = feedback
        ? `<feedback>\n${feedback}\n</feedback>\n\nPlanı güncelle ve tam bir PLAN_JSON bloğu üret.${feedback.includes("openQuestions biçimi") ? "" : OPEN_QUESTION_FORMAT}`
        : null;

      // YENİDEN DENEME: düşme sebebi ve (varsa) reddedilen PLAN_JSON.
      // Devralınan oturum bloğu zaten görüyor → yalnız sebep. Yeni oturum hiçbir
      // şey bilmiyor → tam prompt + reddedilen blok. Blok varsa keşif TEKRARLANMAZ:
      // plan hazırdı, düşüren çoğu zaman tek bir alandı.
      const rejected = retry ? this.pendingRejectedPlan(jobId) : null;
      const fixOnly = rejected
        ? "\n\nKeşfi baştan yapma: plan hazır, yalnız yukarıdaki alanlar hatalı. Gerekiyorsa kodda doğrula, sonra düzeltilmiş TAM bir PLAN_JSON bloğu üret."
        : "";
      const shortNote = retry ? `${renderRetryNote(retry, { rejected, full: false })}${fixOnly}\n\n` : "";
      const fullNote = retry ? `\n\n${renderRetryNote(retry, { rejected, full: true })}${fixOnly}` : "";
      if (retry) {
        this.notice(jobId, `Yeniden deneme: önceki hata${retry.errorCode ? ` (${retry.errorCode})` : ""} Planner'a iletildi${rejected ? "; reddedilen PLAN_JSON düzeltilmek üzere geri verildi" : ""}.`);
      }

      const prompt = feedbackPrompt
        ? `${shortNote}${feedbackPrompt}`
        : rejected
          ? shortNote.trimEnd()
          : `${shortNote}${fullPrompt}`;
      // Oturum kaybolursa (taşma, silinmiş transcript) yeni oturum yalnız
      // `<feedback>` görürse işi bilmez; tam bağlam gider.
      const freshPrompt = `${fullPrompt}${feedbackPrompt ? `\n\n${feedbackPrompt}` : ""}${fullNote}`;

      const outcome = await this.plannerTurn(jobId, profile, worktreePath, prompt, rt, planChoice, freshPrompt, graph);
      if (!outcome) return; // fail() çağrıldı

      const { doc, run } = outcome;
      const planId = this.savePlan(jobId, doc, profile, run.runId);

      // POSTPLAN ÖLÇÜM: artık tahmin yok, plandan SAYILIYOR (kaç dosya, kaç
      // katman, kaç açık soru). Kapıdan ÖNCE koşuyor çünkü kapı yükü öneriyi
      // taşımalı: sonradan güncellemek ikinci yazma ve `approval.required` ile
      // yarış demek.
      const devChoice = await this.runTriage(
        jobId, profile, "postplan",
        renderPostplanTriagePrompt(job, doc, worktreePath),
        worktreePath, rt, planId,
      );

      // Kapı yükü olayla AYNI biçimde: UI ikisini de aynı koddan çizer.
      const payload = {
        planId, plan: doc,
        ...(devChoice ? { modelChoice: devChoice } : {}),
        phaseModels: this.phaseModels(planId, profile),
      };
      const gateId = this.openApproval(jobId, "plan", planId, payload);
      this.move(jobId, "PlanReview", "waiting", `plan v${this.planVersion(planId)} onay bekliyor`, "agent");
      this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "plan", payload });
      // Kapı açıldıktan SONRA: insan planı okurken eleştiri biter (§42).
      this.critiquePlan(jobId, profile, job, planId, doc);
    } catch (err) {
      this.fail(jobId, "planning_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(jobId);
    }
  }

  // ── Triage (model yönlendirmesi) ─────────────────────────────

  /**
   * Ucuz ölçüm turu: işin zorluğunu ölçer, motor modeli seçer.
   *
   * Kendi durumu YOK — `Planning` içinde bir alt-adım olarak koşar. Ayrı bir
   * `Triage` durumu eklemek durum makinesini, `retry()` kurtarma ağacını ve
   * pipeline şeridini genişletirdi; kesinti dayanıklılığı ise zaten var:
   * triage `setPhase(running)`den ÖNCE koşuyor, yani çökerse iş
   * `Planning/starting` kalır ve `retry()` baştan koşturur. Triage ucuz ve
   * idempotent olduğu için baştan koşması sorun değil.
   *
   * BAŞARISIZLIK İŞİ ÖLDÜRMEZ: blok gelmezse `null` döner ve çağıran
   * `fallbackTier`a düşer. Triage bir DANIŞMANDIR; çöktüğünde kalite düşmez,
   * yalnız tasarruf olmaz.
   */
  private async runTriage(
    jobId: string,
    profile: ProjectProfile,
    stage: "intake" | "postplan",
    prompt: string,
    worktreePath: string,
    rt: AcquiredRuntime,
    subjectId: string | null,
  ): Promise<ModelChoice | null> {
    const cfg = profile.agents.triage;
    if (!cfg.enabled) return null;
    if (stage === "intake" && !cfg.stages.intake) return null;
    if (stage === "postplan" && !cfg.stages.postplan) return null;

    let run: RunResult;
    try {
      run = await this.deps.runner.run({
        jobId,
        role: "triage",
        prompt,
        model: cfg.model,
        effort: cfg.effort,
        maxTurns: cfg.maxTurns,
        maxBudgetUsd: cfg.maxBudgetUsd,
        cwd: worktreePath,
        // Salt okunur. `git log` kritik: "bu dosya kaç kez patch edilmiş"
        // sorusunun cevabı tahminle değil ölçümle verilmeli.
        allowedTools: ["Read", "Glob", "Grep", ...READ_ONLY_BASH],
        disallowedTools: [...READ_ONLY_DENY],
        systemPrompt: `${loadRolePrompt("triage")}\n\n# Görev: ${stage}`,
        // Oturum SÜRDÜRMEZ: iki aşama ayrı sorular sorar ve intake bağlamını
        // postplan'a taşımak, ölçümü önceki yargıya bağlar.
        resumeSessionId: null,
        transport: rt.transport,
      });
    } catch (err) {
      // Kimlik yok, köprü koptu, kota bitti — hiçbiri işi öldürmemeli.
      this.notice(jobId, `Triage koşusu düştü (${err instanceof Error ? err.message : String(err)}); varsayılan seviyeye düşülüyor.`);
      return null;
    }

    if (run.subtype === "error" || run.subtype === "quota") {
      this.notice(jobId, `Triage koşusu bitmedi (${run.subtype}); varsayılan seviyeye düşülüyor.`);
      return null;
    }

    const parsed = parseTriage(extractBlock(run.text, "TRIAGE_JSON"), stage);
    if (!parsed) {
      this.notice(jobId, "Triage TRIAGE_JSON üretmedi; varsayılan seviyeye düşülüyor.");
      return null;
    }

    const choice = chooseModel(parsed.doc, cfg);
    if (!choice) return null;

    this.deps.db.insert(schema.triageResults).values({
      id: newId(),
      jobId,
      stage,
      subjectId,
      doc: parsed.doc as never,
      tier: choice.tier,
      model: choice.model,
      effort: choice.effort,
      synthesized: parsed.synthesized,
      requiresApproval: choice.requiresApproval,
      runId: run.runId,
    }).run();

    this.notice(
      jobId,
      `Triage (${stage}): ${choice.tier} → ${choice.model}/${choice.effort}` +
      `${parsed.synthesized ? " [kısmen sentezlendi]" : ""}` +
      `${choice.requiresApproval ? " — İNSAN ONAYI GEREKİYOR" : ""}` +
      `\n${choice.rationale}`,
    );
    return choice;
  }

  /**
   * Bir rol için geçerli model/effort: triage seçtiyse o, yoksa profil rolü,
   * o da yoksa kodun sabiti.
   *
   * Üç katmanlı düşüş, çünkü triage isteğe bağlı bir iyileştirmedir: kapalı,
   * çökmüş ya da hiç koşmamış olabilir ve iş yine de koşmalı.
   */
  private modelFor(
    profile: ProjectProfile,
    role: string,
    choice: ModelChoice | null,
    fallback: { model: string; effort: string },
  ): { model: string; effort: string } {
    if (choice) return { model: choice.model, effort: choice.effort };
    const cfg = profile.agents.roles[role];
    return { model: cfg?.model ?? fallback.model, effort: cfg?.effort ?? fallback.effort };
  }

  /**
   * İnsanın işe zorladığı model — varsa triage'ı, safha seviyesini ve profil
   * rolünü ÖNCELER.
   *
   * Döngüye giren iş aynı modelle yeniden denenince çoğu zaman aynı yerde
   * takılıyor (CI kırmızısı, bot yorumu, kırık test); insanın elindeki tek
   * kaldıraç daha güçlü model. Seviye kayıtlı, model merdivenden YENİDEN
   * çözülür — `rungFor` DEĞİL, doğrudan basamak: eksik basamakta `rungFor`
   * sessizce başka bir modele düşerdi, oysa insan belirli bir seviye seçti.
   * Basamak sonradan profilden kalktıysa zorlama yok sayılır (zincir sürer).
   */
  private forcedModel(jobId: string, profile: ProjectProfile): { model: string; effort: string } | null {
    const row = this.deps.db.select({ tier: schema.jobs.modelTier }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    const tier = ModelTierSchema.safeParse(row?.tier);
    if (!tier.success) return null;
    const rung = profile.agents.triage.ladder[tier.data];
    return rung ? { model: rung.model, effort: rung.effort } : null;
  }

  /** Sabit modelli roller (QA, DevOps) için: zorlama, yoksa profil rolü, yoksa sabit. */
  private roleModel(jobId: string, profile: ProjectProfile, role: { model?: string | undefined; effort?: string | undefined } | undefined, fallback: string): { model: string; effort: string } {
    return this.forcedModel(jobId, profile) ?? { model: role?.model ?? fallback, effort: role?.effort ?? "medium" };
  }

  /**
   * İşin model seviyesini zorlar ya da (`null`) kaldırır.
   *
   * Zorlama İŞ BOYUNCA kalır, yalnız sıradaki deneme için değil: CI'ı çözen
   * DevOps turu yeni bir bot yorumu doğurursa onu da aynı güçte model
   * çözmeli. İnsan onu yine buradan kaldırır. İnsanın seçimi onayın kendisi
   * olduğu için `approvalRequiredFrom` burada ayrıca sorulmaz; iz audit'te.
   */
  setModelTier(jobId: string, tier: ModelTier | null, actor = "human"): { tier: ModelTier | null; model: string | null; effort: string | null } {
    const { job, profile } = this.load(jobId);
    if (job.state === "Cancelled") throw new EngineError("bad_state", "iptal edilmiş işin modeli değiştirilemez");
    const rung = tier ? profile.agents.triage.ladder[tier] : null;
    if (tier && !rung) throw new EngineError("bad_input", `profilin model merdiveninde '${tier}' basamağı yok`);
    if ((job.modelTier ?? null) === tier) return { tier, model: rung?.model ?? null, effort: rung?.effort ?? null };

    this.deps.db.update(schema.jobs).set({ modelTier: tier }).where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "job.model_tier", subjectType: "job", subjectId: jobId,
      detail: { from: job.modelTier, to: tier, model: rung?.model ?? null } as never,
    }).run();
    this.notice(jobId, rung
      ? `Model zorlandı: ${tier} — ${rung.model} (effort ${rung.effort}). İş boyunca Planner, Developer, QA ve DevOps bu modelle koşar.`
      : "Model zorlaması kaldırıldı; profil ve triage seçimi geçerli.");
    return { tier, model: rung?.model ?? null, effort: rung?.effort ?? null };
  }

  /**
   * İşe özel canlı ortam değişkenlerini TAMAMEN değiştirir.
   *
   * Koşan ortama dokunmaz: değerler compose dosyasına kalkış anında yazılıyor.
   * Geçmesi için "Yeniden kaldır" (LiveTest) ya da yeniden deneme
   * (NeedsAttention) gerekir — UI bunu söyler.
   *
   * Denetim izine ve akışa yalnız ADLAR yazılır: değer çoğu zaman bir anahtar
   * ya da bağlantı dizesidir ve `scrubSecrets` her biçimi tanımaz.
   */
  setLiveEnv(jobId: string, env: Record<string, string>, actor = "human"): { env: Record<string, string> } {
    const { job, profile } = this.load(jobId);
    if (job.state === "Cancelled" || job.state === "Done") throw new EngineError("bad_state", `kapanmış işin canlı ortamı değiştirilemez (${job.state})`);
    if (!profile.live?.enabled) throw new EngineError("bad_state", "profilde canlı ortam yok");

    const before = job.liveEnv ?? {};
    const keys = (o: Record<string, string>) => Object.keys(o).sort();
    // `in` değil `hasOwn`: `constructor` gibi geçerli adlar prototipte de var.
    const added = keys(env).filter((k) => !Object.hasOwn(before, k));
    const removed = keys(before).filter((k) => !Object.hasOwn(env, k));
    const changed = keys(env).filter((k) => Object.hasOwn(before, k) && before[k] !== env[k]);
    if (added.length + removed.length + changed.length === 0) return { env };

    this.deps.db.update(schema.jobs).set({ liveEnv: env }).where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "job.live_env", subjectType: "job", subjectId: jobId,
      detail: { added, removed, changed } as never,
    }).run();
    const parts = [
      added.length ? `eklendi: ${added.join(", ")}` : "",
      changed.length ? `değişti: ${changed.join(", ")}` : "",
      removed.length ? `kaldırıldı: ${removed.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    this.notice(jobId, `İşe özel canlı ortam değişkenleri güncellendi (${parts}). Canlı ortam bir sonraki kalkışında uygular.`);
    return { env };
  }

  /**
   * Seçimi bir basamak yukarı taşır — red sinyalinin ucuz karşılığı.
   *
   * İnsan planı reddettiyse iş düşünüldüğünden zordur. Triage'ı yeniden
   * koşturmak yerine (girdi değişmedi, aynı ölçümü ikinci kez ödemek saçma)
   * kayıtlı seviyeyi yükseltiriz. `maxTier` yine tavandır.
   */
  private bumpChoice(choice: ModelChoice, profile: ProjectProfile): ModelChoice | null {
    const cfg = profile.agents.triage;
    // Tavan her şeyin üstünde: red sinyali `maxTier`i aşamaz.
    const capped = clampToMaxTier(bumpTier(choice.tier), cfg.maxTier);
    const rung = rungFor(capped, cfg);
    if (!rung) return null;
    return {
      tier: capped,
      model: rung.model,
      effort: rung.effort,
      rationale: `red sonrası bir basamak yükseltildi (${choice.tier} → ${capped})`,
      // Eşik YENİ seviyeyle ölçülür: önceki kaydın bayrağını taşımak,
      // `deep → frontier` yükseltmesini onaysız sayıyordu.
      requiresApproval: tierNeedsApproval(capped, cfg),
    };
  }

  /**
   * Planner'ın koşacağı seçim — onay eşiğinin ALTINDA.
   *
   * Pahalı model onayı plan onayına gömülü; Planner o kapıdan ÖNCE koştuğu
   * için gömülecek bir onay yok. Eşiği aşan intake seçimi önceden yalnız bir
   * notla Fable'a gidiyordu. Ayrı bir kapı açmak yerine plan onaylanana kadar
   * eşiğin bir altında koşulur; insanın elle seçtiği seviye (`forced`) bundan
   * bağımsızdır, o zaten onayın kendisidir.
   */
  private planningChoice(jobId: string, choice: ModelChoice | null, profile: ProjectProfile): ModelChoice | null {
    if (!choice?.requiresApproval) return choice;
    const cfg = profile.agents.triage;
    const capped = capBelowApproval(choice.tier, cfg);
    const rung = capped ? rungFor(capped, cfg) : null;
    this.notice(
      jobId,
      rung && capped
        ? `Planlama için ${choice.tier} onaysız seçilemez; plan onayına kadar ${capped} → ${rung.model}/${rung.effort}.`
        : `Planlama için ${choice.tier} onaysız seçilemez ve eşiğin altında basamak yok; rolün varsayılan modeli kullanılıyor.`,
    );
    if (!capped || !rung) return null;
    return {
      tier: capped,
      model: rung.model,
      effort: rung.effort,
      rationale: `${choice.rationale} · onay eşiği (${cfg.approvalRequiredFrom}) planlamada aşılmaz`,
      requiresApproval: false,
    };
  }

  /**
   * Bu işin bir aşamasında kaydedilmiş son triage seçimi.
   *
   * `raw`: onay kontrolü atlanır, kayıt olduğu gibi döner. Yalnız planlama
   * kullanır — çağıran `planningChoice` ile eşiğin altına indirir. Aksi hâlde
   * eşiği aşan intake kaydı yeniden denemede `null` dönüyor ve iş, ilk koşudan
   * farklı olarak rolün varsayılan modeline düşüyordu.
   */
  private lastTriageChoice(
    jobId: string,
    stage: "intake" | "postplan",
    profile: ProjectProfile,
    opts: { raw?: boolean } = {},
  ): ModelChoice | null {
    const row = this.deps.db.select().from(schema.triageResults)
      .where(and(eq(schema.triageResults.jobId, jobId), eq(schema.triageResults.stage, stage)))
      .orderBy(desc(schema.triageResults.createdAt)).limit(1).all()[0];
    if (!row) return null;
    // Model merdivenden YENİDEN çözülür: profil değişmiş olabilir ve kayıttaki
    // dizeye güvenmek, eski bir ayarı diriltmek olurdu.
    const rung = rungFor(row.tier as ModelTier, profile.agents.triage);
    if (!rung) return null;

    // ONAY KAPISI KODLA KORUNUR (kural 8).
    //
    // `requiresApproval` işaretli bir seçim, insan planı onaylamadan
    // UYGULANMAZ. Bugün `runDeveloping` zaten yalnız onaydan sonra koşuyor,
    // ama bu koruma çağıranın disiplinine bırakılamaz: ileride başka bir yol
    // açılırsa pahalı model sessizce seçilmiş olurdu.
    if (row.requiresApproval && !opts.raw) {
      const approved = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
        .where(and(
          eq(schema.approvals.jobId, jobId),
          eq(schema.approvals.kind, "plan"),
          eq(schema.approvals.status, "approved"),
        )).all();
      if (approved.length === 0) return null;
    }

    return {
      tier: row.tier as ModelTier,
      model: rung.model,
      effort: rung.effort,
      rationale: "kayıtlı triage ölçümü",
      requiresApproval: row.requiresApproval,
    };
  }

  /** Plan kapısına giren safha-model tablosu. Seviyesiz safhalar listede yok. */
  private phaseModels(planId: string, profile: ProjectProfile): PlanGatePayload["phaseModels"] {
    // AYAR KAPATILINCA KAYIT DA SUSAR.
    //
    // `tier` kolonu plan kaydedilirken yazıldı; ayar sonradan kapatılırsa o
    // eski değerler okunmaya devam ederdi ve kapatmak davranışı geri almazdı.
    const cfg = profile.agents.triage;
    if (!cfg.enabled || !cfg.stages.perPhase) return [];
    const rows = this.deps.db.select().from(schema.planPhases)
      .where(eq(schema.planPhases.planId, planId)).orderBy(asc(schema.planPhases.order)).all();
    const out: PlanGatePayload["phaseModels"] = [];
    for (const r of rows) {
      if (!r.tier) continue;
      const rung = rungFor(r.tier as ModelTier, cfg);
      if (!rung) continue;
      out.push({
        order: r.order, title: r.title, tier: r.tier as ModelTier,
        model: rung.model, effort: rung.effort, requiresApproval: r.tierRequiresApproval,
        source: r.tierSource === "human" ? "human" : "engine",
        ...(r.derivedTier ? { derivedTier: r.derivedTier as ModelTier } : {}),
      });
    }
    return out;
  }

  /**
   * Bu safhanın kendi seviyesinden model seçimi; yoksa `null`.
   *
   * `null` dönmesi düşüş zincirini bozmaz: çağıran iş geneli `postplan`
   * seçimine, o da yoksa profil rolüne düşer.
   *
   * ONAY KAPISI KODLA KORUNUR (kural 8): `tierRequiresApproval` işaretli bir
   * safha, plan onaylanmadan pahalı modele gitmez. `lastTriageChoice`teki aynı
   * koruma — orada olduğu gibi burada da çağıranın disiplinine bırakılamaz,
   * çünkü `runDeveloping` altı ayrı yerden çağrılıyor.
   *
   * Onay BU PLANA ait olmalı: insan planı düzenleyerek onaylarsa `savePlan`
   * yeni bir sürüm doğurur (`decide` içinde, doğrudan `approved` olarak) ve o
   * sürüm insanın HİÇ GÖRMEDİĞİ pahalı bir safha getirebilir. `subjectId`
   * eşleşmesi aranmasaydı önceki sürümün onayı yenisini geçirirdi.
   *
   * İNSANIN SEÇİMİ AYARDAN BAĞIMSIZ GEÇERLİ: safha kapısında sıradaki safhanın
   * modeli `perPhase` kapalıyken de elle seçilebiliyor (48 safhalı planda
   * Fable günlük kotayı yarıda bitirdi, 2026-10-05). "Ayar kapatılınca kayıt
   * susar" kuralı motorun ÖLÇÜMÜ için; insanın açıkça seçtiğini susturmak,
   * ekranda gördüğü modelin koşmaması olurdu.
   */
  private phaseModelChoice(
    phase: typeof schema.planPhases.$inferSelect,
    profile: ProjectProfile,
  ): ModelChoice | null {
    // Ayar kapalıysa motorun ölçümü okunmaz — `phaseModels` ile aynı gerekçe.
    const cfg = profile.agents.triage;
    const human = phase.tierSource === "human";
    if (!human && (!cfg.enabled || !cfg.stages.perPhase)) return null;
    if (!phase.tier) return null;
    const rung = rungFor(phase.tier as ModelTier, cfg);
    if (!rung) return null;

    // İnsanın seçtiği seviye onayın kendisidir (`setModelTier` ile aynı
    // gerekçe): ya plan kapısında, plan onayıyla birlikte verildi ya da safha
    // kapısında — orada plan ZATEN onaylı. Ayrıca aramak, düzenlenmiş planın
    // (onay eski sürüme bağlı) insan seçimini sessizce düşürürdü.
    if (phase.tierRequiresApproval && !human) {
      const approved = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
        .where(and(
          eq(schema.approvals.jobId, phase.jobId),
          eq(schema.approvals.kind, "plan"),
          eq(schema.approvals.status, "approved"),
          // Bu safhanın planına ait onay; başka bir sürümünki geçmez.
          eq(schema.approvals.subjectId, phase.planId),
        )).all();
      if (approved.length === 0) return null;
    }

    return {
      tier: phase.tier as ModelTier,
      model: rung.model,
      effort: rung.effort,
      rationale: human ? `safha ${phase.order + 1} · insan seçimi` : `safha ${phase.order + 1} ölçümü`,
      requiresApproval: phase.tierRequiresApproval,
    };
  }

  /**
   * Bu safhayı koşacak Developer modeli ve onu kimin belirlediği.
   *
   * SAFHA SEVİYESİ İŞ GENELİNİ ÖNCELER. Safha ölçümü plandan sayılmış
   * bilgidir (bu safhanın dosyaları, bu safhanın riski); iş geneli `postplan`
   * seçimi tüm planın ortalamasıdır. Entity safhası ile concurrency düzeltmesi
   * aynı modele gitmek zorunda değil — tasarrufun asıl geldiği yer burası.
   *
   * Tek fonksiyon, çünkü iki okuyucusu var: koşu (`runDeveloping`) ve safha
   * kapısındaki önizleme (`nextPhaseView`). Ayrı yazılsalardı insanın ekranda
   * gördüğü model ile koşan model ayrışabilirdi.
   */
  private developerPick(
    jobId: string,
    profile: ProjectProfile,
    phase: typeof schema.planPhases.$inferSelect,
  ): { model: string; effort: string; tier: ModelTier | null; source: DeveloperModelSource } {
    const forcedTier = ModelTierSchema.safeParse(
      this.deps.db.select({ tier: schema.jobs.modelTier }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.tier,
    );
    const forced = this.forcedModel(jobId, profile);
    if (forced && forcedTier.success) return { ...forced, tier: forcedTier.data, source: "forced" };
    const ph = this.phaseModelChoice(phase, profile);
    if (ph) return { model: ph.model, effort: ph.effort, tier: ph.tier, source: "phase" };
    const post = this.lastTriageChoice(jobId, "postplan", profile);
    if (post) return { model: post.model, effort: post.effort, tier: post.tier, source: "postplan" };
    const m = this.modelFor(profile, "developer", null, { model: "claude-opus-5-5", effort: "high" });
    return { ...m, tier: null, source: "role" };
  }

  /**
   * Safha kapısında sıradaki (henüz başlamamış ilk) safhanın önizlemesi.
   *
   * 48 safhalı bir planda insan her kapıda "sırada ne var, hangi modelle
   * koşacak" sorusunu Plan sekmesine gidip safhayı bulmadan görebilmeli —
   * ve modeli kapıyı kapatmadan değiştirebilmeli. Sıradaki safha yoksa
   * (son safha kapısı) `null`.
   */
  /**
   * Runner'ın döngü tespiti için sorduğu politika (karar §33).
   *
   * Profil her koşuda yeniden okunur: insan izlemeyi iş sürerken açıp
   * kapatabilmeli. Analyst iş dışında; listede olsa da izlenmez.
   */
  stuckPolicy(jobId: string, role: AgentRoleName): StuckPolicyResult | null {
    // Mentorun kendisi izlenmez: danışmanın danışmanı yok.
    if (role === "analyst" || role === "mentor") return null;
    const { profile } = this.load(jobId);
    const cfg = profile.agents.mentor;
    if (!cfg.enabled || !cfg.roles.includes(role)) return null;
    return {
      thresholds: cfg.thresholds,
      // Planner, triage ve tester salt okunur: yazmamaları ilerlemesizlik değil.
      expectWrites: role === "developer" || role === "qa" || role === "devops",
      ...(cfg.mode === "consult"
        ? {
            consult: {
              run: (req: ConsultRequest) => this.consultMentor(jobId, profile, req),
              maxPerRun: cfg.maxConsultsPerRun,
              holdTimeoutMs: Math.round(cfg.holdTimeoutMinutes * 60_000),
            },
          }
        : {}),
    };
  }

  /**
   * Takılan agent için bir üst basamağa danışır (karar §33). Dönen metin
   * agent'a teslim edilir; `null` → danışma atlandı, agent kendi yolunda.
   *
   * Durum DEĞİŞMEZ, döngü sayaçlarına dokunulmaz (Kural 1): danışma bir
   * geçiş değil, triage gibi bir öneridir. Her sonuç `agent.mentor` olarak
   * kayda geçer — maliyet ve isabet oradan ölçülür.
   */
  private async consultMentor(jobId: string, profile: ProjectProfile, req: ConsultRequest): Promise<string | null> {
    const cfg = profile.agents.mentor;
    const publish = (o: { outcome: "advised" | "skipped"; mentorModel?: string; advice?: string; reason?: string; costMicroUsd?: number }): void => {
      this.deps.hub.publish(jobId, {
        type: "agent.mentor", runId: req.runId, role: req.role, juniorModel: req.juniorModel,
        mentorModel: o.mentorModel ?? "", signal: req.signal.signal, target: req.signal.target,
        outcome: o.outcome, advice: o.advice ?? "", reason: o.reason ?? "", costMicroUsd: o.costMicroUsd ?? 0,
      });
    };

    // İş tavanı kayıttan sayılır: sunucu yeniden başlasa da sıfırlanmaz.
    const used = this.deps.db.select({ payload: schema.jobEvents.payload }).from(schema.jobEvents)
      .where(and(eq(schema.jobEvents.jobId, jobId), eq(schema.jobEvents.type, "agent.mentor"))).all()
      .filter((r) => (r.payload as { outcome?: unknown } | null)?.outcome === "advised").length;
    if (used >= cfg.maxConsultsPerJob) {
      publish({ outcome: "skipped", reason: `iş tavanı (${cfg.maxConsultsPerJob} danışma)` });
      return null;
    }

    const maxTier = cfg.maxTier ?? profile.agents.triage.maxTier;
    const rung = mentorRung(req.juniorModel, profile.agents.triage.ladder, maxTier, req.attempt);
    if (!rung) {
      // Merdivenin tepesi ya da merdivende olmayan model: mentoru insandır.
      publish({ outcome: "skipped", reason: `${req.juniorModel} için ${maxTier} tavanının altında üst basamak yok — mentor insan` });
      return null;
    }

    let run: RunResult;
    try {
      run = await this.deps.runner.run({
        jobId,
        role: "mentor",
        nested: true,
        // Kural 4: soru dosyası agent çıktısı ve dosya içeriği taşır.
        prompt: scrubSecrets(renderMentorPrompt(this.mentorTask(jobId), req)),
        model: rung.model,
        effort: rung.effort,
        maxTurns: cfg.maxTurns,
        maxBudgetUsd: cfg.maxBudgetUsd,
        // Host'ta, araçsız: köprü konteynerde aynı anda tek koşu taşıyor ve
        // worktree host'tan okunamıyor. cwd yalnız SDK'nın şartı.
        cwd: tmpdir(),
        systemPrompt: loadRolePrompt("mentor"),
        allowedTools: [],
        disallowedTools: MENTOR_DENY,
      });
    } catch (err) {
      publish({ outcome: "skipped", mentorModel: rung.model, reason: `mentor koşamadı: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    }
    const advice = run.text.trim();
    if (run.subtype !== "success" || !advice) {
      publish({ outcome: "skipped", mentorModel: rung.model, reason: run.errorMessage ?? `mentor cevap üretmedi (${run.subtype})`, costMicroUsd: run.costMicroUsd });
      return null;
    }
    publish({ outcome: "advised", mentorModel: rung.model, advice, costMicroUsd: run.costMicroUsd });
    return wrapAdvice(rung.model, req.signal, advice);
  }

  /** Mentorun göreceği görev: iş ve (varsa) koşan safha. */
  private mentorTask(jobId: string): string {
    const job = this.deps.db.select({ title: schema.jobs.title, description: schema.jobs.description })
      .from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    const phase = this.deps.db.select({ order: schema.planPhases.order, title: schema.planPhases.title, rationale: schema.planPhases.rationale })
      .from(schema.planPhases)
      .where(and(eq(schema.planPhases.jobId, jobId), eq(schema.planPhases.status, "running")))
      .orderBy(desc(schema.planPhases.order)).limit(1).all()[0];
    const lines = [`İş: ${job?.title ?? "?"}`];
    if (job?.description) lines.push("", job.description.slice(0, 4000));
    if (phase) lines.push("", `Koşan safha ${phase.order + 1}: ${phase.title}`, phase.rationale);
    return lines.join("\n");
  }

  nextPhaseView(jobId: string): NextPhaseView | null {
    const { profile } = this.load(jobId);
    const plan = this.deps.db.select().from(schema.plans)
      .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.status, "approved")))
      .orderBy(desc(schema.plans.version)).limit(1).all()[0];
    if (!plan) return null;
    const pending = this.deps.db.select().from(schema.planPhases)
      .where(and(eq(schema.planPhases.planId, plan.id), eq(schema.planPhases.status, "pending")))
      .orderBy(asc(schema.planPhases.order)).all();
    const next = pending[0];
    if (!next) return null;
    const doc = PlanDocumentSchema.safeParse(plan.document);
    // Eski planlarda `acceptance` yok; belge bozuksa da önizleme düşmemeli.
    const acceptance = doc.success ? (doc.data.phases.find((p) => p.order === next.order)?.acceptance ?? []) : [];
    const pick = this.developerPick(jobId, profile, next);
    const phaseTier = ModelTierSchema.safeParse(next.tier);
    return {
      order: next.order, title: next.title, rationale: next.rationale, files: next.files,
      risk: next.risk, exceedsFileCap: next.exceedsFileCap, acceptance,
      pendingOrders: pending.map((p) => p.order),
      model: { model: pick.model, effort: pick.effort, tier: pick.tier, source: pick.source },
      phaseTier: phaseTier.success ? phaseTier.data : null,
      phaseTierSource: next.tierSource === "human" ? "human" : "engine",
    };
  }

  /**
   * Bir Planner turu: koşar, PLAN_JSON'ı ayrıştırır, Zod doğrular.
   * Blok yoksa ya da bozuksa BİR kez aynı oturumdan uyarır; yine olmazsa
   * NeedsAttention. Üretici taraf güvenilmez — ama sonsuza dek de dürtülmez.
   */
  private async plannerTurn(
    jobId: string,
    profile: ProjectProfile,
    worktreePath: string,
    prompt: string,
    rt: AcquiredRuntime,
    choice: ModelChoice | null,
    freshPrompt?: string,
    graph: CodeGraphSetup | null = null,
  ): Promise<{ doc: PlanDocument; run: RunResult } | null> {
    const role = profile.agents.roles["planner"];
    // Triage seçtiyse onun modeli, yoksa profil rolü, o da yoksa sabit.
    const pick = this.forcedModel(jobId, profile) ?? this.modelFor(profile, "planner", choice, { model: "claude-opus-5-5", effort: "high" });
    let attemptPrompt = prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Canlı kanal: kullanıcı planlama sürerken yazabilir (tur sınırında
      // görülür, `interrupt` ile hemen). PLAN_JSON gelince kanal kapanır.
      const channel = new LiveInputChannel();
      this.channels.set(jobId, channel);
      let run: RunResult;
      try {
        run = await this.deps.runner.run({
          jobId,
          role: "planner",
          prompt: attemptPrompt,
          model: pick.model,
          effort: pick.effort,
          maxTurns: role?.maxTurns ?? 80,
          maxBudgetUsd: role?.maxBudgetUsd ?? 5,
          cwd: worktreePath,
          // Planner SALT OKUNUR — ama okumak worktree ile sınırlı değil.
          // WebSearch/WebFetch açık: Planner sürüm notu, kütüphane sınırı gibi
          // şeyleri kendi doğrulayabilsin (insan kararı, 2026-09-14). Takılma
          // riski runner'daki sessizlik gözcüsüyle karşılanıyor — ölçüldü:
          // dönmeyen bir WebSearch turu 11 dakika asılı bırakmıştı.
          allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", ...READ_ONLY_BASH, ...(graph?.tools ?? [])],
          disallowedTools: [...READ_ONLY_DENY],
          systemPrompt: loadRolePrompt("planner"),
          resumeSessionId: this.plannerSessionId(jobId),
          ...(freshPrompt !== undefined ? { freshPrompt: attempt === 0 ? freshPrompt : `${freshPrompt}\n\n${attemptPrompt}` } : {}),
          // Planner artık konteynerde koşuyor: worktree volume'de, host'ta yok.
          transport: rt.transport,
          ...(graph ? { codeGraph: graph.config } : {}),
          ...this.askUserFor(jobId, profile),
          channel,
          onTurn: (turn) => this.onLiveTurn(jobId, profile, channel, turn.text, "PLAN_JSON"),
        });
      } finally {
        channel.close();
        if (this.channels.get(jobId) === channel) this.channels.delete(jobId);
      }
      if (run.sessionId) this.sessions.set(`${jobId}:planner`, run.sessionId);

      if (run.subtype === "error" || run.subtype === "quota") {
        this.fail(jobId, "planner_error", `Planner koşusu bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
        return null;
      }

      const raw = extractBlock(run.text, "PLAN_JSON");
      const parsed = raw === null ? null : PlanDocumentSchema.safeParse(raw);
      if (parsed?.success) return { doc: parsed.data, run };

      // Blok var ama JSON değilse de "bulunamadı" deniyordu; Planner olmayan
      // bir eksiği aramaya gidiyordu.
      const text = extractTextBlock(run.text, "PLAN_JSON");
      const issues = parsed
        ? parsed.error.issues.map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`)
        : text !== null ? ["blok geçerli JSON değil"] : [];
      if (text !== null) this.saveRejectedBlock(jobId, run.runId, "PLAN_JSON", text, issues, null);

      const why = text === null
        ? "PLAN_JSON bloğu bulunamadı"
        : `PLAN_JSON şemaya uymuyor: ${issues.slice(0, 3).join(" · ")}`;
      this.notice(jobId, `${why}; Planner'dan tam blok isteniyor`);
      attemptPrompt = `${why}. Lütfen şemaya uyan TAM bir PLAN_JSON bloğu üret; açıklama yazma.`;
    }
    this.fail(jobId, "no_plan", "Planner iki denemede geçerli PLAN_JSON üretmedi");
    return null;
  }

  /**
   * Canlı bir agent turu bitti. Beklenen blok (PLAN_JSON, HANDOFF_JSON)
   * varsa iş bitmiştir, kanal kapanır. Yoksa agent soru sormuş ya da
   * durmuştur: kullanıcı mesajı beklenir; `askTimeoutMinutes` dolunca bir kez
   * "varsayımınla devam et" denir, ikinci dolumda kanal kapanır — iş sonsuza
   * asılı kalmaz.
   */
  /**
   * `waitMinutes`: bloksuz turdan sonra insanı bekleme süresi; verilmezse
   * `limits.askTimeoutMinutes`. Gözetimsiz koşular (tarayıcı testi) kısa verir.
   */
  private onLiveTurn(jobId: string, profile: ProjectProfile, channel: LiveInputChannel, text: string, block: string, waitMinutes?: number): void {
    if (channel.closed) return;
    if (extractBlock(text, block) !== null) {
      channel.close();
      return;
    }
    const key = `${jobId}:idle`;
    const nudged = this.sessions.get(key) === "nudged";
    const fire = (): void => {
      // Yalnız kendi kaydını sil: eski bir turun zamanlayıcısı yenisini düşürmesin.
      if (this.idleWaits.get(jobId)?.fire === fire) this.idleWaits.delete(jobId);
      if (channel.closed) return;
      if (!nudged) {
        this.sessions.set(key, "nudged");
        this.notice(jobId, this.autopilotActive(jobId)
          ? "Otopilot: agent insan beklemeden varsayımıyla devam ettirildi."
          : "Agent bekliyor; cevap gelmedi. Varsayımıyla devam etmesi istendi.");
        channel.push(`<user_message>\nCevap gelmedi. Varsayımınla devam et, varsayımı belirt ve bitince tam bir ${block} bloğu üret.\n</user_message>`);
      } else {
        this.sessions.delete(key);
        channel.close();
      }
    };
    // Otopilotta ilk dürtme beklemeden gider; ikinci dolum (kanalı kapatma)
    // yine süreyi bekler — agent dürtmeye rağmen blok yazmazsa döngüye girmesin.
    const delay = !nudged && this.autopilotActive(jobId) ? 0 : (waitMinutes ?? profile.limits.askTimeoutMinutes) * 60_000;
    const timer = setTimeout(fire, delay);
    timer.unref?.();
    if (!nudged) this.idleWaits.set(jobId, { timer, fire });
  }

  /**
   * Otopilot bu an geçerli mi? Yalnız geliştirme adımında: Planning'de
   * Planner'ın sorusu, QA/PR'da sonraki kapılar insanındır.
   */
  private autopilotActive(jobId: string): boolean {
    const row = this.deps.db.select({ autopilot: schema.jobs.autopilot, state: schema.jobs.state })
      .from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    return !!row?.autopilot && (row.state === "Developing" || row.state === "Building");
  }

  /**
   * İşin otopilotunu açar/kapatır. Koşan işte de geçerli: soru ve safha kapısı
   * bayrağı o anda okur. Açılırken BEKLEYEN şeyler de çözülür — yoksa insan
   * düğmeye basıp iş yine onu beklerdi: Developer'ın açık soruları
   * cevaplanır, bloksuz turdaki bekleyiş dürtülür, açık safha kapısı onaylanır.
   */
  setAutopilot(jobId: string, enabled: boolean, actor = "human"): { enabled: boolean } {
    const { job } = this.load(jobId);
    if (job.state === "Cancelled" || job.state === "Done") throw new EngineError("bad_state", `kapanmış işin otopilotu değiştirilemez (${job.state})`);
    if (job.autopilot === enabled) return { enabled };

    this.deps.db.update(schema.jobs).set({ autopilot: enabled }).where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "job.autopilot", subjectType: "job", subjectId: jobId,
      detail: { from: job.autopilot, to: enabled } as never,
    }).run();
    this.notice(jobId, enabled
      ? "Otopilot açıldı: geliştirme adımında safhalar kendiliğinden onaylanır, Developer soruları kendi kararıyla geçer. Canlı test, QA ve PR kapıları insanda kalır."
      : "Otopilot kapatıldı: safha onayı ve sorular yeniden insanı bekler.");
    if (enabled && this.autopilotActive(jobId)) this.resolveForAutopilot(jobId);
    return { enabled };
  }

  /** Otopilot açıldığı anda geliştirme adımında insanı bekleyen her şeyi serbest bırakır. */
  private resolveForAutopilot(jobId: string): void {
    for (const [qid, q] of [...this.questions]) {
      if (q.jobId === jobId) this.answer(qid, AUTOPILOT_ANSWER);
    }
    const idle = this.idleWaits.get(jobId);
    if (idle) {
      clearTimeout(idle.timer);
      idle.fire();
    }
    const gate = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, "phase"), eq(schema.approvals.status, "pending")))
      .all()[0];
    if (gate && !this.busy.has(jobId)) this.autoApprovePhase(jobId, gate.id);
  }

  /**
   * Safha kapısını otopilot adına onaylar. Kapı yine AÇILIR ve kaydı kalır:
   * safha commit'i, denetim izi (`decidedBy: autopilot`) ve UI'daki safha
   * kanıtı insan onayındakiyle aynı — fark yalnız bekleyen kimsenin olmaması.
   *
   * `busy` kalkmışken çağrılmalı: `decide` koşan işte karar almaz.
   */
  private autoApprovePhase(jobId: string, gateId: string): void {
    if (!this.autopilotActive(jobId)) return;
    try {
      const out = this.decide(gateId, "approve", "", null, "autopilot");
      this.notice(jobId, "Otopilot: safha onaylandı, sıradaki safhaya geçiliyor.");
      out.developing?.catch((err: unknown) => this.fail(jobId, "developing_failed", err instanceof Error ? err.message : String(err)));
    } catch (err) {
      // Kapı insanda kalır; iş kilitlenmez, yalnız otopilot bu adımda devreden çıkar.
      this.notice(jobId, `Otopilot safhayı onaylayamadı, karar insanda: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private planVersion(planId: string): number {
    return this.deps.db.select({ v: schema.plans.version }).from(schema.plans).where(eq(schema.plans.id, planId)).all()[0]?.v ?? 0;
  }

  /** Planı yeni sürüm olarak kaydeder; safhalar ayrı satırlar (her biri kendi onayını taşıyacak). */
  /**
   * Ortam hazırlığı: scratch dizinleri + `exec.setup` komutları.
   *
   * İŞ BOYUNCA BİR KEZ. Kurulum her safhada tekrarlanırsa bind-mount'ta modül
   * başına dakikalar gider (ölçüldü: 103-280 s). İkinci kez çağrıldığında
   * sessizce döner.
   *
   * Kurulum kırmızı dönerse fırlatır ve iş NeedsAttention'a gider: Developer'a
   * "düzelt" diye verilmez, çünkü düzeltilecek şey kodda değil ortamdadır.
   */
  private async ensureSetup(jobId: string, profile: ProjectProfile, rt: { executor: CommandExecutor; workdir: string }): Promise<void> {
    if (this.setupDone.has(jobId)) return;

    // Kurulum işin EN UZUN adımı (ölçüldü: 103-280 s) ve damgasız logda
    // "takıldı mı, sürüyor mu" ayırt edilemiyordu.
    const setupStartedAt = Date.now();
    const emit = (stream: "stdout" | "stderr", raw: string) => {
      this.deps.hub.publish(jobId, {
        type: "build.log",
        stream,
        line: scrubSecrets(raw),
        elapsed: elapsed(setupStartedAt),
      });
    };

    // Çalışma dizini GERÇEKTEN orada mı?
    //
    // Yanlış hesaplanmış bir yol boş (ya da var olmayan) bir dizine işaret
    // eder; komutlar "çıkış 127" verir ve suç araç zincirine atılır. YAŞANDI
    // (2026-09-17): volume'e taşımadan sonra `workdir` `<root>/<repo>` diye
    // kuruluyordu ama ağaç `<root>/worktrees/<jobId>/<repo>` altındaydı —
    // hata "npm ci (çıkış 127)" olarak göründü, sebebi görünmedi.
    const probe: string[] = [];
    const ok = await rt.executor.run({
      command: "pwd && ls -a | head -5",
      cwd: rt.workdir,
      env: {},
      timeoutMs: 30_000,
      onLine: (_s, l) => probe.push(l),
    });
    if (ok.exitCode !== 0) {
      throw new Error(
        `çalışma dizini kullanılamıyor: ${rt.workdir} (çıkış ${ok.exitCode}). ` +
          `Worktree hazırlanmamış ya da yol yanlış hesaplanmış olabilir.`,
      );
    }

    const scratch = await prepareScratchDirs(profile, rt.workdir, jobId, rt.executor, emit);
    if (scratch.prepared > 0) {
      emit("stdout", `▶ scratch: ${scratch.prepared} dizin konteyner diskinde (${scratch.reused} yeniden kullanıldı)`);
    }

    for (const cmd of profile.exec.setup) {
      emit("stdout", `▶ kurulum: ${cmd.name}`);
      const cwd = cmd.cwd === "." ? rt.workdir : `${rt.workdir}/${cmd.cwd}`.replace(/\/+/g, "/");
      const res = await rt.executor.run({
        command: cmd.run,
        cwd,
        env: cmd.env,
        timeoutMs: cmd.timeoutMinutes * 60_000,
        onLine: emit,
      });
      if (res.exitCode !== 0 && !cmd.optional) {
        const why = res.timedOut ? `${Math.round(res.durationMs / 1000)} s sonra zaman aşımı` : `çıkış ${res.exitCode}`;
        throw new Error(`ortam hazırlığı düştü — ${cmd.name} (${why}); bağımlılıklar kurulmadan geliştirme anlamsız`);
      }
      emit("stdout", `■ kurulum: ${cmd.name} · ${res.exitCode === 0 ? "ok" : "atlandı (optional)"} (${Math.round(res.durationMs / 1000)} s)`);
    }

    // `npm ci` scratch symlink'ini siler ve kurulum bind-mount'a düşer: doğru
    // ama yavaş (ölçüldü — 8 modül 17 dk; konteyner diskinde modül başına
    // ~10 sn). Sonucu şimdi scratch'e taşı ki BİR SONRAKİ koşu hazır bulsun.
    const stashed = await stashScratchDirs(profile, rt.workdir, jobId, rt.executor, emit);
    if (stashed.moved > 0) {
      emit("stdout", `▶ scratch: ${stashed.moved} dizin konteyner diskine taşındı (sonraki koşu hazır bulacak)`);
    }

    this.setupDone.add(jobId);
  }

  /**
   * İşi projenin güncel onaylı profiline taşır.
   *
   * Profil sürümlenmiş bir belge; koşan iş kendi `profileId`'sine bağlı kalıyor
   * ve yeni sürüm onaylansa bile ESKİSİYLE devam ediyordu. Bunu yapan bir uç
   * yoktu, DB'den elle güncellemek gerekiyordu (kullanıcı haklı olarak
   * "upgrade seçeneği yok" dedi).
   *
   * Sayaçlar temizlenir: tavan çoğu zaman ESKİ profilin kusuruyla dolar
   * (ölçüldü — hatalı npm yolu build'i beş kez kırmızı yaptı) ve yeni profille
   * ilk denemeye tavan dolu başlamak yanlış olur.
   */
  retarget(jobId: string, profileId?: string, actor = "human"): { jobId: string; profileId: string; version: number } {
    const job = this.deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    if (!job) throw new EngineError("not_found", `iş bulunamadı: ${jobId}`);
    // Faz `done` ise bellekteki işaret BAYATTIR.
    //
    // `busy` süreç belleğinde ve devralınan koşularda köprü kopana dek
    // kalıyordu; iş çoktan bitmiş olsa bile "koşuyor" sayılıyor ve taşıma
    // 409 ile reddediliyordu (yaşandı: düğme basılıyor, hiçbir şey olmuyor).
    // Kalıcı kayıt bellekten güvenilirdir: `phase === "done"` demek o iş için
    // koşan bir tur yok demektir.
    if (this.busy.has(jobId) && job.phase !== "done") {
      throw new EngineError("busy", `iş koşuyor; profil değiştirilemez (faz ${job.phase}): ${jobId}`);
    }

    const target = profileId
      ? this.deps.db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, profileId)).all()[0]
      // `orderBy` ŞART: eskiden sırasızdı ve birden çok onaylı sürüm varken
      // gelişigüzel biri seçiliyordu — "güncel profile taşı" eski sürüme de
      // taşıyabilirdi. En yüksek sürüm güncel olandır.
      : this.deps.db.select().from(schema.projectProfiles)
        .where(and(eq(schema.projectProfiles.projectId, job.projectId), eq(schema.projectProfiles.status, "approved")))
        .orderBy(desc(schema.projectProfiles.version))
        .all()[0];
    if (!target) throw new EngineError("not_found", "hedef profil bulunamadı");
    // Onay kapısı kodla korunur: taslak profille iş koşmaz.
    if (target.status !== "approved") throw new EngineError("bad_state", `profil onaylı değil (${target.status})`);
    if (target.projectId !== job.projectId) throw new EngineError("bad_state", "profil başka projeye ait");

    this.deps.db.update(schema.jobs)
      .set({ profileId: target.id, loopCounts: {}, errorCode: null, errorMessage: null })
      .where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "job.retarget", subjectType: "job", subjectId: jobId,
      detail: { from: job.profileId, to: target.id, version: target.version } as never,
    }).run();

    return { jobId, profileId: target.id, version: target.version };
  }

  /**
   * Koşan işi durdurur: önce canlı kanal, sonra agent turu.
   *
   * Durumu BU METOT YAZMAZ — `Cancelled` geçişi API katmanındaki `transition()`
   * çağrısının işi. Burada yalnız koşan iş durdurulur, çünkü iptal yalnız DB'ye
   * yazıldığında agent arka planda koşmaya devam ediyordu: iş ekranda
   * `Cancelled` görünürken kimlik ve bütçe yanıyor, dahası motor işi hâlâ
   * `busy` sayıp profil değişimini reddediyordu (ölçüldü — Sevkiyat,
   * 2026-09-16).
   *
   * Dönen değer gerçekten kesilen bir tur olup olmadığıdır; çağıran "durdurdum"
   * derken yalan söylemesin.
   */
  async stopRun(jobId: string, reason: string): Promise<boolean> {
    // Kanal önce: agent bir sonraki mesajı beklerken asılı kalmasın.
    this.channels.get(jobId)?.close();
    this.channels.delete(jobId);
    const aborted = await this.deps.runner.abortJob(jobId, reason);
    // Kurulum damgası da düşer: iptal edilen iş yeniden başlarken konteyner
    // yeni olabilir, "kurulum yapıldı" belleği yanıltır.
    this.setupDone.delete(jobId);
    return aborted;
  }

  /**
   * Uçtan durumdaki (`Cancelled`/`Done`) bir işin kaynaklarını HEMEN bırakır.
   *
   * `reconcile()` açılışta aynı işi yapar (kural: yetim kaynak asılı kalmaz)
   * ama yalnız SUNUCU YENİDEN BAŞLADIĞINDA — iptal edilen bir iş bir sonraki
   * restart'a kadar konteyner, volume ve canlı ortamını (varsa port + DB klonu)
   * tutmaya devam ediyordu. `cancel` ucu `move()`la `Cancelled`e geçtikten
   * SONRA bu çağrılır: durum yazımı kaynak kaldırmadan önce garanti olsun diye
   * (kural 2 — önce niyet). Kaldırma hataları YUTULUR: iptal zaten
   * geri alınamaz, temizlik başarısızlığı işi tekrar canlandırmaz; bir sonraki
   * `reconcile()` yine dener.
   *
   * Worktree/branch BURADA silinmez — post-mortem için diff hâlâ okunabilir
   * kalsın (merge sonrası temizlikten farkı bu: orada `cleanup.localBranch`
   * insanın açık kararı).
   *
   * `Done`a giren HER yol bunu çağırır. Eskiden yalnız merge kapısı
   * (`cleanup.container` seçiliyse) konteyneri kaldırıyordu; CI yeşil ile ya
   * da PR açılmadan kapanan işin konteyneri restart'a kadar `Exited` hâlde
   * kalıyordu (yaşandı, 2026-10-15). Volume'ün kalması `Done → CIWatch`
   * yeniden denemesi için de gerekli: konteyneri `acquire` zaten yeniden kurar.
   */
  async releaseResources(jobId: string, reason: string): Promise<void> {
    let profile: ProjectProfile | null = null;
    let worktreePath = ".";
    try {
      const loaded = this.load(jobId);
      profile = loaded.profile;
      worktreePath = loaded.job.worktreePath ?? ".";
    } catch {
      // Profil bozuk/silinmiş olabilir (bkz. `load()`) — konteyner/lease
      // temizliği profile bağlı değil, yine denenir.
    }

    if (profile?.live?.enabled) {
      await this.deps.live?.stop(jobId, worktreePath, profile.live, reason).catch(() => false);
    }
    // Konteyner kaldırılır, volume KALIR (`removeVolume: false`) — merge sonrası
    // temizlikten farkı bu: orada `cleanup.localBranch` insanın açık kararıdır,
    // burada worktree post-mortem için okunabilir kalmalı (yukarıdaki not).
    await this.deps.runtime.release?.(jobId, { removeVolume: false }).catch(() => undefined);
    // Konteyner gitti; yeniden kurulduğunda `ensureSetup` atlanmasın.
    this.setupDone.delete(jobId);

    for (const lease of heldLeases(this.deps.db, jobId)) {
      releaseLease(this.deps.db, lease.kind, lease.value);
    }
  }

  /**
   * İptal edilen işi İZİNSİZ BIRAKMADAN kaldırır: konteyner, volume, worktree,
   * kira ve DB'deki HER satır. `releaseResources`'ın aksine post-mortem
   * amacıyla hiçbir şey saklanmaz — kullanıcı "iptal ettim, sil" dediğinde
   * `Cancelled` bir kalıntı değil, işin hiç var olmamış hâlidir.
   *
   * Sıra önemli: önce dış kaynaklar (konteyner/volume/worktree/lease), EN SON
   * DB satırları. Kaynak silme yarıda düşerse DB'de iz kalır ve bir sonraki
   * deneme (ya da `reconcile()`) yine bulur; DB önce silinseydi düşen bir
   * konteyner sonsuza dek yetim kalırdı.
   *
   * Dış kaynak hataları burada YUTULUYOR ama SESSİZCE değil: `auditLog`a
   * `job.purge_incomplete` düşülüyor (job satırının kendisi az sonra silinecek,
   * bu yüzden iz JOB DIŞINDA bir tabloda kalmalı — CodeRabbit ile yakalandı,
   * 2026-09-19: eskiden hata tamamen kayboluyor, DB temizlendikten sonra
   * yetim canlı ortam/volume keşfedilemez oluyordu). Tam bir "durable cleanup
   * queue" bu PR'ın kapsamı dışında; audit izi en azından "buraya bak" der.
   */
  async purge(jobId: string): Promise<void> {
    let profile: ProjectProfile | null = null;
    let worktreePath = ".";
    try {
      const loaded = this.load(jobId);
      profile = loaded.profile;
      worktreePath = loaded.job.worktreePath ?? ".";
    } catch {
      // Profil bozuk/silinmiş olabilir — kaynak temizliği ona bağlı değil.
    }

    const incomplete: string[] = [];

    if (profile?.live?.enabled) {
      const stopped = await this.deps.live?.stop(jobId, worktreePath, profile.live, "iş silindi").catch(() => false);
      if (stopped === false) incomplete.push("live");
    }

    // Worktree'yi konteyner ayaktaysa siliyoruz: silme `executor` üzerinden
    // koşar (git worktree remove + rm -rf), Docker erişilemezse zaten volume
    // hiç oluşmamış olabilir — o durumda atlamak güvenlidir.
    if (profile) {
      try {
        const attached = await this.deps.runtime.attach?.(jobId, profile);
        if (attached) {
          await this.deps.worktrees
            .remove({ jobId, profileSlug: profile.slug, executor: attached.executor, root: attached.workdirRoot })
            .catch(() => { incomplete.push("worktree"); return []; });
        }
      } catch {
        // Worktree silinemedi (konteyner koptu vb.) — volume'ü aşağıda zaten
        // tamamen kaldırıyoruz, artık erişilemez içerik önemsiz.
        incomplete.push("worktree");
      }
    }

    // Konteyner VE volume: `removeVolume: true` — `releaseResources`dan farkı
    // bu, post-mortem burada aranmaz.
    await this.deps.runtime.release?.(jobId, { removeVolume: true }).catch(() => { incomplete.push("container_volume"); });

    for (const lease of heldLeases(this.deps.db, jobId)) {
      releaseLease(this.deps.db, lease.kind, lease.value);
    }

    // Artifact dosyaları: `<artifactsDir>/<jobId>/…` (handoff, build log, vb.)
    await rm(join(this.deps.artifactsDir, jobId), { recursive: true, force: true }).catch(() => { incomplete.push("artifacts"); });

    // DB satırları — bağımlılık sırasına göre (jobs EN SON, FK'ler önce).
    // `jobAttachments` silinmez: dosya diske geri döner, tabloya değil
    // (kural: iş hiç açılmasa da ek satırı kalabiliyor zaten).
    this.deps.db.transaction((tx) => {
      // `auditLog` FK taşımıyor (job'a özel bir tablo değil, sistem geneli
      // operatör izi) ama `subjectId` job'a (`job.start`/`retry`/`retarget`)
      // ya da bu işin `approvals` kimliklerine (`approval.*`, `plan.answers`)
      // işaret ediyor. Approvals SİLİNMEDEN ÖNCE bu kimlikleri toplayıp audit
      // satırlarını temizliyoruz — aksi hâlde `subjectId` yetim kalır ve
      // "bu işe ne oldu" sorusunun cevabı hiç var olmamış bir kayda çıkar
      // (CodeRabbit ile yakalandı, 2026-09-19).
      const approvalIds = tx
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(eq(schema.approvals.jobId, jobId))
        .all()
        .map((a) => a.id);
      // Safha seviyesi onayları (`model.approve`, `subjectType:"phase"`)
      // `subjectId`de PLAN kimliğini taşıyor — ne job'a ne approval'a işaret
      // ediyorlar, yani yukarıdaki iki temizlik onları yakalamaz. Planlar
      // silinmeden ÖNCE toplanmalı.
      const planIds = tx
        .select({ id: schema.plans.id })
        .from(schema.plans)
        .where(eq(schema.plans.jobId, jobId))
        .all()
        .map((p) => p.id);
      tx.delete(schema.auditLog).where(eq(schema.auditLog.subjectId, jobId)).run();
      const orphanIds = [...approvalIds, ...planIds];
      if (orphanIds.length > 0) {
        tx.delete(schema.auditLog).where(inArray(schema.auditLog.subjectId, orphanIds)).run();
      }

      tx.delete(schema.costRecords).where(eq(schema.costRecords.jobId, jobId)).run();
      tx.delete(schema.externalSync).where(eq(schema.externalSync.jobId, jobId)).run();
      tx.delete(schema.triageResults).where(eq(schema.triageResults.jobId, jobId)).run();
      tx.delete(schema.bridgeTokens).where(eq(schema.bridgeTokens.jobId, jobId)).run();
      tx.delete(schema.pullRequests).where(eq(schema.pullRequests.jobId, jobId)).run();
      tx.delete(schema.artifacts).where(eq(schema.artifacts.jobId, jobId)).run();
      tx.delete(schema.testRuns).where(eq(schema.testRuns.jobId, jobId)).run();
      tx.delete(schema.builds).where(eq(schema.builds.jobId, jobId)).run();
      tx.delete(schema.qaCases).where(eq(schema.qaCases.jobId, jobId)).run();
      tx.delete(schema.critiques).where(eq(schema.critiques.jobId, jobId)).run();
      // `plans`tan ÖNCE: satır `plan_id` ile plana bağlı.
      tx.delete(schema.testScenarios).where(eq(schema.testScenarios.jobId, jobId)).run();
      tx.delete(schema.approvals).where(eq(schema.approvals.jobId, jobId)).run();
      tx.delete(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).run();
      tx.delete(schema.messages).where(eq(schema.messages.jobId, jobId)).run();
      tx.delete(schema.agentRuns).where(eq(schema.agentRuns.jobId, jobId)).run();
      tx.delete(schema.agentSessions).where(eq(schema.agentSessions.jobId, jobId)).run();
      tx.delete(schema.liveEnvironments).where(eq(schema.liveEnvironments.jobId, jobId)).run();
      tx.delete(schema.resourceLeases).where(eq(schema.resourceLeases.jobId, jobId)).run();
      tx.delete(schema.planPhases).where(eq(schema.planPhases.jobId, jobId)).run();
      tx.delete(schema.plans).where(eq(schema.plans.jobId, jobId)).run();
      tx.delete(schema.jobTransitions).where(eq(schema.jobTransitions.jobId, jobId)).run();
      tx.update(schema.jobAttachments).set({ jobId: null }).where(eq(schema.jobAttachments.jobId, jobId)).run();
      tx.delete(schema.jobs).where(eq(schema.jobs.id, jobId)).run();

      // `incomplete` varsa job SATIRI artık yok — `subjectId: jobId` yeni
      // audit kaydı da yetim doğar. `detail`e gömüyoruz: sorgulanabilir
      // (`action = 'job.purge_incomplete'`), ama silinen job'a FK iddiası yok.
      if (incomplete.length > 0) {
        tx.insert(schema.auditLog).values({
          id: newId(),
          actor: "system",
          action: "job.purge_incomplete",
          detail: { jobId, incomplete } as never,
        }).run();
      }
    });
  }

  /**
   * DEVRALMA: konteynerde hâlâ koşan bir turu üstlen.
   *
   * Sunucu yeniden başladığında `reconcile` işi `NeedsAttention`a alır — o anda
   * köprü henüz bağlanmamıştır ve konteynerde canlı koşu olup olmadığı
   * bilinemez. Köprü saniyeler sonra gelip `bridge.hello`da `activeRunId`
   * bildirirse burası çağrılır: iş eski durumuna döner ve akış devralınır.
   *
   * Kural 2 ihlal edilmiyor: "sessizce çalışıyor görünmesin" diyor. Köprüye
   * sorup "evet, bu koşu sürüyor" cevabını almak ÖLÇÜLMÜŞ gerçektir.
   *
   * Dönen değer devralmanın gerçekleşip gerçekleşmediğidir.
   */
  takeOver(jobId: string, runId: string): boolean {
    const row = this.deps.db
      .select({ state: schema.jobs.state, errorCode: schema.jobs.errorCode })
      .from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    if (!row) return false;
    // Yalnız `reconcile`ın damgaladığı işler geri alınır; insan müdahalesiyle
    // NeedsAttention'a düşmüş bir iş kendiliğinden koşmaya dönmemeli.
    if (row.state !== "NeedsAttention" || row.errorCode !== "interrupted") return false;

    const run = this.deps.db
      .select({ jobId: schema.agentRuns.jobId, status: schema.agentRuns.status })
      .from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).all()[0];
    if (!run || run.jobId !== jobId) return false;

    const prev = this.deps.db
      .select({ from: schema.jobTransitions.fromState })
      .from(schema.jobTransitions)
      .where(eq(schema.jobTransitions.jobId, jobId))
      .orderBy(desc(schema.jobTransitions.createdAt)).limit(1).all()[0];
    const back = (prev?.from ?? "Developing") as JobState;

    const recorded: ServerEvent[] = [];
    transition(
      this.deps.db,
      { jobId, to: back, phase: "running", reason: `konteynerde koşu sürüyor, devralındı (${runId})`, actorType: "system" },
      (tx) => {
        tx.update(schema.jobs).set({ errorCode: null, errorMessage: null }).where(eq(schema.jobs.id, jobId)).run();
        recorded.push(
          this.deps.hub.record(jobId, { type: "job.state", state: back, phase: "running", loopCounts: {} }, tx),
        );
      },
    );
    for (const e of recorded) this.deps.hub.emit(e);
    this.busy.add(jobId);
    // DEVRALINAN olarak ayrıca işaretlenir: `busy` bu süreçte koşan turları da
    // taşıyor ve köprü koptuğunda onların işareti KALKMAMALI (onları yöneten
    // `finally` bloğu kaldıracak). Ayrım olmasaydı, kopan bir köprü bu
    // sürecin kendi koşan turunu "bitmiş" sayardı.
    this.adopted.add(jobId);
    return true;
  }

  /**
   * Devralınan koşunun işaretini kaldırır — köprü koptuğunda çağrılır.
   *
   * `takeOver` `busy` işaretliyor ama o turu bu süreç yönetmiyor: koşu
   * konteynerde sürüyor ve işareti kaldıracak bir `finally` yok. Sonuç,
   * sunucu yeniden başlatılana kadar kalıcı olarak "koşuyor" görünen bir iş
   * ve `busy`ye bakan her işlemin (retarget, chat, kapı kararı) 409 ile
   * reddedilmesiydi.
   *
   * Bu sürecin KENDİ koşturduğu turlara dokunmaz.
   */
  releaseAdopted(jobId: string): void {
    if (!this.adopted.delete(jobId)) return;
    this.busy.delete(jobId);
  }

  /**
   * Onaylı planı olan bir işi geliştirmeden sürdürür.
   *
   * `clone()` işi Developing'de bırakıyor ama koşturmuyor: klonlama senkron bir
   * işlem, geliştirme dakikalar sürer. Çağıran bunu ayrı başlatır.
   */
  async resume(jobId: string, retry: RetryContext | null = null): Promise<void> {
    const { job, profile } = this.load(jobId);
    if (job.state !== "Developing") throw new EngineError("bad_state", `iş Developing değil (${job.state}): ${jobId}`);
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş zaten koşuyor: ${jobId}`);
    await this.ensureWorktree(jobId);
    await this.runDeveloping(jobId, null, retry);
  }

  /**
   * Worktree'nin GERÇEKTEN var olduğundan emin olur; yoksa kurar.
   *
   * DB'deki `worktreePath` yetmez — yol kayıtlı ama dizin yok olabilir:
   * volume silindiğinde ya da konteyner yeniden yaratıldığında kayıt kalır,
   * ağaç kalmaz.
   *
   * YAŞANDI (2026-09-17): DevOps turu böyle bir işte koştu; SDK var olmayan
   * bir `cwd` ile spawn edilince **ENOENT** aldı ve "native binary ... libc
   * uyumsuz" diye YANLIŞ bir tanı bastı (SDK o hata kodunu libc sanıyor).
   * libc'nin ilgisi yoktu; eksik olan çalışma diziniydi.
   */
  private async ensureWorktree(jobId: string): Promise<void> {
    const { job, profile } = this.load(jobId);
    const rt = await this.acquireRuntime(jobId, profile);
    if (job.worktreePath) {
      const probe = await rt.executor.run({
        command: `test -d ${shellQuote(job.worktreePath)}`,
        cwd: "/",
        env: {},
        timeoutMs: 30_000,
        onLine: () => {},
      });
      if (probe.exitCode === 0) return;
      this.notice(jobId, `Çalışma ağacı kayıtlı ama diskte yok (${job.worktreePath}); yeniden kuruluyor.`);
    }
    // Ağaç kaynaktan açılıyor: önce kaynak güncellensin ki mirror, iş dalı
    // ve gitignore'lu kopyalar bayat tabandan gelmesin.
    await this.syncSourceWorkspace(jobId, profile);
    const prepared = await this.deps.worktrees.prepare({
      jobId, profile, jobSlug: slugify(job.title), targetRepos: job.targetRepos,
      executor: rt.executor,
      root: rt.workdirRoot,
      sourceRoot: rt.sourceMount ?? profile.workspace.root,
    });
    const primary = prepared[0]!;
    this.deps.db.update(schema.jobs)
      .set({ worktreePath: primary.path, branchName: primary.branch })
      .where(eq(schema.jobs.id, jobId)).run();
    this.notice(jobId, `Çalışma ağacı hazır: ${primary.branch} (${prepared.length} repo)`);
    if (primary.created) await this.pullBase(jobId, profile, primary.path, rt.executor);
    await this.restoreFromRemote(jobId, profile, primary.path, primary.branch, rt.executor);
  }

  /**
   * Kaynak workspace'i uzaktaki varsayılan dala fast-forward eder (bkz.
   * `workspace/sourceSync.ts`). İşi asla durdurmaz: atlanan repo için not
   * düşülür, `pullBase` iş dalında ikinci savunma olarak kalır.
   */
  private async syncSourceWorkspace(jobId: string, profile: ProjectProfile, lessons?: CodeMapLessons): Promise<void> {
    const exec = this.deps.hostExec;
    if (!exec) return;
    try {
      const results = await syncSource(exec, profile.workspace.root, profile.workspace.repos);
      for (const r of results) {
        if (r.status === "updated") {
          this.notice(jobId, `Kaynak ${r.repo} güncellendi: ${r.from.slice(0, 8)} → ${r.to.slice(0, 8)}.`);
        } else if (r.status === "skipped") {
          // Nerede koştuğu yazılır: konteyner değil, host'taki kaynak checkout'u
          // ve sunucu sürecinin kullanıcısı — yetki sorunu o kullanıcıda aranır.
          this.notice(jobId, `UYARI: kaynak ${r.repo} güncellenemedi; mevcut hâliyle sürüyor.\nNerede: host, ${r.dir} (kullanıcı: ${r.user})\nNeden: ${scrubSecrets(r.reason).slice(0, 700)}`);
        }
      }
    } catch (err) {
      this.notice(jobId, `UYARI: kaynak workspace güncellenemedi.\n${scrubSecrets(String(err)).slice(0, 500)}`);
    }
    // Harita kaynağa bakar: senkrondan SONRA, kaynak son hâlindeyken.
    // İşaretleme hızlı (git diff); yeniden üretim arka planda, iş beklemez.
    const codeMap = await this.deps.codeMap?.refresh(this.load(jobId).job.projectId, profile, lessons);
    if (codeMap?.started) {
      const list = (ids: string[]) => `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "…" : ""}`;
      const parts = [
        ...(codeMap.stale.length ? [`${codeMap.stale.length} künye bayat (${list(codeMap.stale)})`] : []),
        ...(codeMap.learning.length ? [`${codeMap.learning.length} künyeye bu işin dersleri işlenecek (${list(codeMap.learning)})`] : []),
      ];
      this.notice(jobId, parts.length
        ? `Kod haritası: ${parts.join("; ")}; arka planda tazeleniyor.`
        : "Kod haritası arka planda üretiliyor; bu işte henüz kullanılamayabilir.");
    }
  }

  /**
   * Yeni açılan dala uzaktaki `defaultBranch`i çeker (`git pull` karşılığı).
   *
   * Mirror'ın kaynağı kullanıcının yerel checkout'u; orada `pull` yapılmamışsa
   * iş bayat `main`den başlar ve GitHub'da merge edilmiş değişiklikleri
   * görmez — fark ancak PR'da çakışma olarak çıkar. `merge` (rebase değil):
   * yerelde push'lanmamış commit'ler de tabanda kalsın.
   *
   * Yalnız dal bu kurulumda yaratıldıysa koşar; yeniden denemede dalda
   * çalışma olabilir ve oraya sessizce merge commit'i eklenmez. Düşerse iş
   * durmaz, yerel taban kullanılır — insan bilsin diye not düşülür.
   */
  private async pullBase(jobId: string, profile: ProjectProfile, worktree: string, executor: CommandExecutor): Promise<void> {
    const gh = this.deps.github;
    const remote = this.primaryRemote(this.load(jobId).job, profile);
    const base = profile.workspace.repos.find((r) => r.primary)?.defaultBranch;
    if (!gh?.fetch || !remote || !base) return;
    try {
      await gh.fetch({ executor, worktree }, remote, base);
    } catch (err) {
      this.notice(jobId, `UYARI: uzak ${base} çekilemedi; iş yerel ${base} tabanından sürüyor.\n${scrubSecrets(String(err)).slice(0, 500)}`);
      return;
    }
    const ident = ["-c", `user.name=${BRAND.displayName}`, "-c", `user.email=${BRAND.slug}@localhost`];
    const out = await execGit(executor, worktree,
      [...ident, "merge", "--no-edit", "--no-gpg-sign", "FETCH_HEAD"], { allowFailure: true });
    // Ölçüt çıkış kodu değil: çakışma da kirli ağaç reddi de aynı sonucu
    // verir — uzak uç HEAD'in atası olmamıştır.
    const fetched = (await execGit(executor, worktree, ["rev-parse", "FETCH_HEAD"])).trim();
    const common = (await execGit(executor, worktree, ["merge-base", "HEAD", "FETCH_HEAD"], { allowFailure: true })).trim();
    if (common !== fetched) {
      await execGit(executor, worktree, ["merge", "--abort"], { allowFailure: true });
      this.notice(jobId, `UYARI: uzak ${base} yerel tabanla birleşmedi; iş yerel ${base} tabanından sürüyor.\n${scrubSecrets(out).slice(0, 500)}`);
      return;
    }
    // Karşılaştırma tabanı yerel `main` DEĞİL, az önce merge edilen uç (bkz. `jobs.baseSha`).
    this.deps.db.update(schema.jobs).set({ baseSha: fetched }).where(eq(schema.jobs.id, jobId)).run();
    this.notice(jobId, `Uzak ${base} çekildi; iş güncel tabandan başlıyor.`);
  }

  /**
   * Yeniden kurulan ağacı UZAKTAKİ dalın ucuna getirir.
   *
   * `prepare()` dalı mirror'dan açıyor; mirror ise kullanıcının yerel
   * checkout'u (`/source`), gerçek remote değil. İşin dalı GitHub'a
   * push'lanmışsa mirror onu bilmez ve ağaç `defaultBranch`ten, yani BOŞ
   * açılır.
   *
   * YAŞANDI (2026-09-17, PR #135): ağaç böyle kuruldu (`ahead 1, behind 156`),
   * orkestratör üzerine commit attı ve 15 dosyalık gerçek çalışmanın yerine
   * TÜM repoyu "yeni" sayan tek bir commit oluştu. Push `non-fast-forward`
   * ile reddedildi — kabul edilseydi PR'daki çalışma silinecekti.
   *
   * Bu yüzden: PR'ı olan bir işte uzak daldan `reset --hard` ile ucu geri
   * alınır. Yerelde hiçbir şey yok (ağaç yeni kuruldu), kaybedilecek
   * değişiklik de yok.
   */
  private async restoreFromRemote(jobId: string, profile: ProjectProfile, worktree: string, branch: string, executor: CommandExecutor): Promise<void> {
    const pr = this.deps.db.select().from(schema.pullRequests)
      .where(eq(schema.pullRequests.jobId, jobId)).orderBy(desc(schema.pullRequests.createdAt)).all()[0];
    const remote = this.primaryRemote(this.load(jobId).job, profile);
    if (!pr || !remote) return;

    const lines: string[] = [];
    const res = await executor.run({
      // `--depth` YOK: sığ kopya sonraki push'u reddettirir.
      command: `git fetch ${shellQuote(remote)} ${shellQuote(branch)} && git reset --hard FETCH_HEAD`,
      cwd: worktree,
      env: {},
      timeoutMs: 600_000,
      onLine: (_s, l) => lines.push(l),
    });
    if (res.exitCode !== 0) {
      // Akışı kesmiyoruz ama insan bilsin: bu ağaçla push non-fast-forward
      // ile düşecek ve sebebi burada yazıyor.
      this.notice(jobId, `UYARI: uzak dal geri alınamadı (${branch}); ağaç PR'ın ucunda DEĞİL.\n${scrubSecrets(lines.join("\n")).slice(0, 500)}`);
      return;
    }
    this.notice(jobId, `Ağaç uzak dalın ucuna alındı: ${branch} (PR #${pr.number}).`);
  }

  /**
   * Kapanmış bir işi yeni bir işe klonlar.
   *
   * `Cancelled` ve `Done` uçtan durumlardır (`ALLOWED_TRANSITIONS` boş dizi):
   * o iş bir daha koşmaz, koşmamalı da — denetim izi kapalı kalsın. Ama
   * içindeki ONAYLI PLAN insanın emeğidir; Planner'ı yeniden koşturup aynı
   * planı yeniden ürettirmek hem pahalı hem de aynı sonucu vermez.
   *
   * Klon yeni bir iştir: yeni kimlik, yeni worktree, temiz sayaçlar. Plan
   * taşınırsa `approved` olarak gelir ve iş doğrudan Developing'den sürer;
   * taşınmazsa Draft kalır ve normal akışta planlanır.
   */
  clone(jobId: string, opts: { carryPlan?: boolean; profileId?: string } = {}, actor = "human"): { jobId: string; state: JobState } {
    const src = this.deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    if (!src) throw new EngineError("not_found", `iş bulunamadı: ${jobId}`);

    // Issue başına TEK iş (`POST /api/jobs` ile aynı kural): klon
    // `externalRef`i taşıdığı için bu kapıyı arkadan dolanıyordu — iki iş iki
    // dal ve iki "Closes #n" PR'ı üretir. Yalnız iptal edilmiş iş issue'yu
    // serbest bırakır; kaynak iş de (Done dahil) sayılır.
    if (src.externalRef) {
      const existing = this.deps.db.select({ id: schema.jobs.id, state: schema.jobs.state })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.projectId, src.projectId), eq(schema.jobs.externalRef, src.externalRef)))
        .all()
        .find((j) => j.state !== "Cancelled");
      if (existing) {
        throw new EngineError("conflict", `${src.externalRef} için iş zaten var: ${existing.id} (${existing.state})`);
      }
    }

    const plan = opts.carryPlan
      ? this.deps.db.select().from(schema.plans)
        .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.status, "approved"))).all()[0]
      : undefined;
    if (opts.carryPlan && !plan) throw new EngineError("bad_state", `taşınacak onaylı plan yok: ${jobId}`);

    // Profil açıkça verilmezse projenin GÜNCEL onaylısı — klonlamanın sık
    // sebebi zaten profilin düzelmiş olması.
    const profileId = opts.profileId ?? this.deps.db.select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.projectId, src.projectId), eq(schema.projectProfiles.status, "approved")))
      .all()[0]?.id ?? src.profileId;

    const newJobId = newId();
    this.deps.db.transaction((tx) => {
      tx.insert(schema.jobs).values({
        id: newJobId, projectId: src.projectId, profileId,
        title: src.title, description: src.description,
        targetRepos: src.targetRepos, referencePaths: src.referencePaths, priority: src.priority,
        source: src.source, externalRef: src.externalRef, externalUrl: src.externalUrl,
        // worktree/dal TAŞINMAZ: yeni iş kendi ağacını kurar, aksi hâlde iki iş
        // aynı dala yazar.
        state: plan ? "Developing" : "Draft", phase: plan ? "starting" : "done",
      }).run();

      if (plan) {
        const doc = plan.document as PlanDocument;
        const planId = newId();
        tx.insert(schema.plans).values({
          id: planId, jobId: newJobId, version: 1, status: "approved",
          document: doc as never, agentRunId: null,
          approvedAt: isoNow(), approvedBy: actor,
        }).run();
        for (const p of doc.phases) {
          tx.insert(schema.planPhases).values({
            id: newId(), planId, jobId: newJobId, order: p.order, title: p.title,
            rationale: p.rationale, files: p.files, risk: p.risk, exceedsFileCap: p.exceedsFileCap,
          }).run();
        }
      }

      tx.insert(schema.auditLog).values({
        id: newId(), actor, action: "job.clone", subjectType: "job", subjectId: newJobId,
        detail: { from: jobId, carriedPlan: Boolean(plan), profileId } as never,
      }).run();
    });

    return { jobId: newJobId, state: plan ? "Developing" : "Draft" };
  }

  /**
   * İnsanın elle koyduğu safha seviyeleri — başlığa göre.
   *
   * Plan DÜZENLENEREK onaylanınca `savePlan` yeni bir sürüm doğurur ve her
   * safhayı yeniden ölçer; müdahale taşınmazsa sessizce geri alınırdı. İnsan
   * "3. safha standard olsun" deyip planın özetinde bir kelime düzeltince
   * safha `deep`e geri dönerdi ve bunu hiçbir yerde görmezdi.
   *
   * BAŞLIK eşleşmesi, sıra değil: düzenleme safha ekleyip silebilir, sıra
   * kayar. Başlık da değiştiyse eşleşme kurulmaz ve safha yeniden ölçülür —
   * doğrusu budur: başlığı değişen safha artık başka bir iştir.
   */
  private humanTiers(jobId: string): Map<string, ModelTier> {
    const prev = this.deps.db.select({ version: schema.plans.version, id: schema.plans.id })
      .from(schema.plans).where(eq(schema.plans.jobId, jobId))
      .orderBy(desc(schema.plans.version)).limit(1).all()[0];
    if (!prev) return new Map();
    const out = new Map<string, ModelTier>();
    for (const r of this.deps.db.select().from(schema.planPhases)
      .where(eq(schema.planPhases.planId, prev.id)).all()) {
      if (r.tierSource === "human" && r.tier) out.set(r.title, r.tier as ModelTier);
    }
    return out;
  }

  private savePlan(jobId: string, doc: PlanDocument, profile: ProjectProfile, runId: string | null, status = "under_review"): string {
    // İŞLEM DIŞINDA okunur: aynı `plan_phases` tablosuna yazacağız ve okuma
    // yazmadan önce bitmeli.
    const carried = this.humanTiers(jobId);
    return this.deps.db.transaction((tx) => {
      const existing = tx.select({ version: schema.plans.version }).from(schema.plans).where(eq(schema.plans.jobId, jobId)).all();
      const version = existing.reduce((m, r) => Math.max(m, r.version), 0) + 1;
      const planId = newId();
      tx.insert(schema.plans).values({ id: planId, jobId, version, status, document: doc as never, agentRunId: runId }).run();
      const cfg = profile.agents.triage;
      // Safha seviyesi PLAN KAYDEDİLİRKEN türetilir, koşu anında değil: karar
      // kapı yüküne girmeli ve insan onaylarken neyi onayladığını görmeli.
      const perPhase = cfg.enabled && cfg.stages.perPhase;
      const threshold = cfg.approvalRequiredFrom;
      for (const p of doc.phases) {
        // Tavan orkestratörce ölçülür; agent "aşmıyor" dese de sayı konuşur.
        const exceeds = p.exceedsFileCap || p.files.length > profile.workflow.phaseMaxFiles;
        const measured = perPhase
          ? resolvePhaseTier({ triage: p.triage, files: p.files, risk: p.risk }, cfg)
          : null;
        // İnsanın seçimi motorun ölçümünü EZER ama profil tavanını ezmez;
        // onay eşiği de taşınan seviyeye göre yeniden hesaplanır (kural 8).
        // Ölçüm kapalıyken de taşınır: safha kapısında verilmiş seçimdir ve
        // `phaseModelChoice` onu ayardan bağımsız okur.
        const human = carried.get(p.title);
        const pt = human
          ? (() => {
              const tier = clampToMaxTier(human, cfg.maxTier);
              return {
                tier,
                requiresApproval: threshold !== null
                  && MODEL_TIER_ORDER.indexOf(tier) >= MODEL_TIER_ORDER.indexOf(threshold),
              };
            })()
          : measured;
        tx.insert(schema.planPhases).values({
          id: newId(), planId, jobId, order: p.order, title: p.title, rationale: p.rationale,
          files: p.files, risk: p.risk, exceedsFileCap: exceeds,
          ...(pt ? { tier: pt.tier, tierRequiresApproval: pt.requiresApproval } : {}),
          ...(human
            ? { tierSource: "human", derivedTier: measured?.tier ?? null }
            : {}),
        }).run();
      }
      // Bekleyen eski planlar geçersiz.
      for (const old of tx.select({ id: schema.plans.id, status: schema.plans.status }).from(schema.plans).where(eq(schema.plans.jobId, jobId)).all()) {
        if (old.id !== planId && old.status === "under_review") {
          tx.update(schema.plans).set({ status: "superseded" }).where(eq(schema.plans.id, old.id)).run();
        }
      }
      return planId;
    });
  }

  private openApproval(jobId: string, kind: ApprovalKind, subjectId: string | null, payload: unknown): string {
    // Aynı iş için bekleyen eski kapı varsa süresi doldu sayılır — iki açık kapı UI'ı şaşırtır.
    this.deps.db.update(schema.approvals).set({ status: "expired", decidedAt: isoNow() })
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.status, "pending"))).run();
    const id = newId();
    this.deps.db.insert(schema.approvals).values({ id, jobId, kind, subjectId, status: "pending", payload: payload as never }).run();
    return id;
  }

  /**
   * Engel kapısı açar: agent'ın yetkisi dışında kalan iş insana taşınır.
   *
   * Durum DEĞİŞMEZ — kapı açıldığı durumda `waiting` fazında beklenir. Yeni
   * bir `Blocked` durumu eklenmedi: engel her rolde çıkabilir ve her biri için
   * ayrı durum durum makinesini kombinatoryal olarak şişirirdi. `payload.state`
   * nereye dönüleceğini zaten söylüyor.
   */
  private openBlockedGate(jobId: string, state: JobState, role: AgentRoleName, handoff: Handoff, results: SuiteOutcome[]): void {
    const payload: BlockedGatePayload = { state, role, blockers: handoff.blockers, results, handoff };
    const gateId = this.openApproval(jobId, "blocked", null, payload);
    this.setPhase(jobId, "waiting", state);
    const roles = [...new Set(handoff.blockers.map((b) => b.needsRole))].join(", ");
    this.notice(jobId, `${role} ${handoff.blockers.length} engel bildirdi (${roles}); karar bekleniyor.`);
    this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "blocked", payload });
  }

  /**
   * Engel kararı. Onay = "engeli çöz": `needsRole` developer ise plana düzeltme
   * safhası eklenip Developer koşar, engelin metni geri bildirime GİRER —
   * Developer testi değil kodu düzeltmeli. Red = "yok say": akış engel hiç
   * yokmuş gibi sürer (testler kırmızıysa normal QA döngüsüne düşer).
   *
   * `human` rolü onayda da Developer'a gitmez: kararı insan verdi, kod
   * değişikliğini de insan yapacak; iş `NeedsAttention`'da bekler.
   */
  private decideBlocked(jobId: string, profile: ProjectProfile, payload: BlockedGatePayload, decision: "approve" | "reject", comment: string): { jobId: string; state: JobState; developing?: Promise<void> } {
    const { job } = this.load(jobId);
    if (decision === "reject") {
      // Engel yok sayıldı. QA'da kırmızı test varsa normal döngü işler; engel
      // bir daha sorulmaz — insan gördü ve geçti dedi.
      const red = payload.results.filter((r) => r.failed > 0);
      this.notice(jobId, `Engel yok sayıldı${comment ? `: ${comment}` : ""}.`);
      if (payload.state === "QA" && red.length > 0) {
        const loop = bumpLoop(this.deps.db, jobId, "qa", profile.limits.maxLoops.qa);
        if (loop.exceeded) {
          this.fail(jobId, "qa_loop", `testler ${loop.count} kez kırmızı; tavan ${profile.limits.maxLoops.qa}`);
          return { jobId, state: "NeedsAttention" };
        }
        this.addFixPhase(jobId, `Test düzeltmesi ${loop.count}`, `Kırık: ${red.map((r) => `${r.suiteId} (${r.failed})`).join(", ")}`);
        this.move(jobId, "Developing", "starting", "engel yok sayıldı; testler kırmızı", "human");
        return { jobId, state: "Developing", developing: this.runDeveloping(jobId, renderTestFeedback(payload.results)) };
      }
      // Yeşil: PR kapısına geç, engel hiç olmamış gibi.
      const gatePayload: PrGatePayload = { results: payload.results, baseline: [], handoff: payload.handoff, branch: job.branchName };
      return { jobId, ...this.enterPrReview(jobId, profile, gatePayload, "engel yok sayıldı", "human") };
    }

    // Onay: engeli çözecek role gönder.
    const toDeveloper = payload.blockers.filter((b) => b.needsRole === "developer");
    if (toDeveloper.length === 0) {
      // Çözecek agent yok (`human` ya da motorda koşmayan bir rol): iş insana
      // bırakılır. Sessizce Done'a gitmemeli — plan hâlâ eksik.
      this.fail(jobId, "blocked_human", `engel insana ait: ${payload.blockers.map((b) => b.what).join(" · ")}${comment ? ` — ${comment}` : ""}`);
      return { jobId, state: "NeedsAttention" };
    }
    const loop = bumpLoop(this.deps.db, jobId, "qa", profile.limits.maxLoops.qa);
    if (loop.exceeded) {
      this.fail(jobId, "qa_loop", `engel ${loop.count} kez çözülemedi; tavan ${profile.limits.maxLoops.qa}`);
      return { jobId, state: "NeedsAttention" };
    }
    // Safhanın GEREKÇESİ engelin kendisi: "Kırık: X" değil, "plan FK şart
    // koşuyordu ama şema dosyası hiç değişmemiş".
    this.addFixPhase(jobId, `Engel düzeltmesi ${loop.count}`, toDeveloper.map((b) => `${b.what} — ${b.why}`).join(" · "));
    this.move(jobId, "Developing", "starting", `engel Developer'a gönderildi (${loop.count}/${profile.limits.maxLoops.qa})`, "human");
    return {
      jobId,
      state: "Developing",
      developing: this.runDeveloping(jobId, renderBlockerFeedback(toDeveloper, payload.results, comment)),
    };
  }

  // ── Karar ────────────────────────────────────────────────────────────────

  /**
   * Onay kapısı kararı. Plan: onay → Developing; red (+yorum) → Planning ve
   * Planner aynı oturumdan planı günceller. `edits` verilirse insanın
   * düzenlediği plan doğrulanır ve onaylı yeni sürüm olur.
   */
  decide(
    gateId: string, decision: "approve" | "reject", comment: string, edits: unknown, actor = "human",
    attachmentIds: readonly string[] = [],
  ): { jobId: string; state: JobState; planning?: Promise<void>; developing?: Promise<void> } {
    const gate = this.deps.db.select().from(schema.approvals).where(eq(schema.approvals.id, gateId)).all()[0];
    if (!gate) throw new EngineError("not_found", `onay kapısı bulunamadı: ${gateId}`);
    if (gate.status !== "pending") throw new EngineError("bad_state", `kapı bekleyen durumda değil (${gate.status})`);
    if (!gate.jobId) throw new EngineError("bad_state", "kapının işi yok");
    const expectedByKind: Record<string, JobState> = {
      plan: "PlanReview", phase: "Developing", live_test: "LiveTest", qa_cases: "QACases", pr_open: "PRReview",
      // `pr_merge` bu haritada YOKTU: kapı açılıyor ama kararı "desteklenmiyor"
      // diye reddediliyordu.
      pr_merge: "CIWatch", review_round: "PRReview", security: "PRReview",
    };
    // `blocked` kapısı DURUM DEĞİŞTİRMEDEN açılıyor (bkz. `openBlockedGate`):
    // beklenen durum sabit değil, kapının yükünde yazılı.
    const expectedState = gate.kind === "blocked"
      ? (gate.payload as BlockedGatePayload | null)?.state
      : expectedByKind[gate.kind];
    if (!expectedState) throw new EngineError("unsupported", `bu kapı türü henüz desteklenmiyor: ${gate.kind}`);
    const jobId = gate.jobId;
    const { job, profile } = this.load(jobId);
    if (job.state !== expectedState) throw new EngineError("bad_state", `iş ${expectedState} değil (${job.state})`);
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş koşuyor; karar bekleyen kapı yok: ${jobId}`);

    // Düzenleme ÖNCE doğrulanır: kapı kapatılıp sonra "bozuk" denmesin.
    let editedPlan: PlanDocument | null = null;
    if (gate.kind === "plan" && decision === "approve" && edits !== undefined && edits !== null) {
      const parsed = PlanDocumentSchema.safeParse(edits);
      if (!parsed.success) throw new EngineError("bad_edits", `düzenlenen plan şemaya uymuyor: ${parsed.error.issues[0]?.message ?? ""}`);
      editedPlan = parsed.data;
    }
    // Case düzenlemesi de kapı kapanmadan doğrulanır: `decideQaCases`
    // fırlatırsa kapı `approved` kalır ve iş bekleyen kapısız kilitlenir.
    if (gate.kind === "qa_cases" && decision === "approve" && edits !== undefined && edits !== null) {
      const parsed = QaCasesDocumentSchema.safeParse(edits);
      if (!parsed.success) throw new EngineError("bad_edits", `düzenlenen case listesi şemaya uymuyor: ${parsed.error.issues[0]?.message ?? ""}`);
    }
    // Merge kapısında seçili yorumlar: aynı sebeple kapı kapanmadan doğrulanır.
    let mergeFix: string[] | null = null;
    if (gate.kind === "pr_merge" && decision === "reject" && edits !== undefined && edits !== null) {
      const parsed = MergeFixEditsSchema.safeParse(edits);
      if (!parsed.success) throw new EngineError("bad_edits", `seçili yorum listesi şemaya uymuyor: ${parsed.error.issues[0]?.message ?? ""}`);
      mergeFix = parsed.data.fixThreads;
    }

    // Görsel yolları yorumun parçası olur: her `decide*` yorumu kendi agent
    // geri bildirimine zaten taşıyor, ayrı bir alanı dokuz yola işlemek yerine.
    // Kapı kapanmadan bağlanır — geçersiz kimlik kapıyı açık bırakır.
    comment = this.withFeedbackImages(jobId, comment, attachmentIds);

    this.deps.db.update(schema.approvals)
      .set({ status: decision === "approve" ? "approved" : "rejected", comment, edits: (edits ?? null) as never, decidedAt: isoNow(), decidedBy: actor })
      .where(eq(schema.approvals.id, gateId)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: `approval.${decision}`, subjectType: "approval", subjectId: gateId, detail: { kind: gate.kind, comment } as never,
    }).run();

    if (gate.kind === "phase") return this.decidePhase(jobId, profile, gate.subjectId!, decision, comment);
    if (gate.kind === "live_test") return this.decideLiveTest(jobId, profile, job.worktreePath, decision, comment);
    if (gate.kind === "qa_cases") return this.decideQaCases(jobId, profile, job.worktreePath, decision, comment, edits);
    if (gate.kind === "pr_open") return this.decidePr(jobId, profile, decision, comment);
    if (gate.kind === "pr_merge") {
      if (mergeFix) return this.fixFromMergeGate(jobId, profile, gate.payload as MergeGatePayload, mergeFix, comment);
      return this.decideMerge(jobId, profile, gate.payload as MergeGatePayload, decision, comment);
    }
    if (gate.kind === "blocked") return this.decideBlocked(jobId, profile, gate.payload as BlockedGatePayload, decision, comment);
    if (gate.kind === "security") return this.decideSecurity(jobId, profile, gate.payload as SecurityGatePayload, decision, comment);
    if (gate.kind === "review_round") return this.decideReviewRound(jobId, profile, gate.payload as ReviewRoundPayload, decision, comment);

    if (decision === "approve") {
      let planId = gate.subjectId!;
      if (editedPlan) {
        this.deps.db.update(schema.plans).set({ status: "superseded" }).where(eq(schema.plans.id, planId)).run();
        // Düzenlenen plan ÖNCE `under_review` yazılır: pahalı seviye getirip
        // getirmediği ancak safhalar kaydedildikten sonra ölçülebilir.
        planId = this.savePlan(jobId, editedPlan, profile, null);

        // DÜZENLEME PAHALI SEVİYE GETİRDİYSE TAZE ONAY ŞART (kural 8).
        //
        // İnsan bu safhaları kapı ekranında GÖRMEDİ — düzenlemesi onları yeni
        // doğurdu. Mevcut onayı yeni plana taşımak, görülmemiş bir `frontier`
        // seçimini onaylanmış saymak olurdu; bildirim yazmak yetmez, çünkü iş
        // o sırada çoktan `Developing`e geçmiş olur. Kapı geri açılır ve karar
        // insana döner.
        const pricey = this.phaseModels(planId, profile).filter((pm) => pm.requiresApproval);
        if (pricey.length > 0) {
          const payload = {
            planId, plan: editedPlan,
            phaseModels: this.phaseModels(planId, profile),
          };
          const reGateId = this.openApproval(jobId, "plan", planId, payload);
          this.notice(
            jobId,
            `Düzenlenen plan ${pricey.length} pahalı safha getirdi (${pricey.map((p) => `${p.order + 1}. ${p.tier}`).join(", ")}); yeniden onay bekleniyor.`,
          );
          this.setPhase(jobId, "waiting", "PlanReview");
          this.deps.hub.publish(jobId, { type: "approval.required", gateId: reGateId, kind: "plan", payload });
          this.critiquePlan(jobId, profile, job, planId, editedPlan);
          return { jobId, state: "PlanReview" };
        }
      }
      this.deps.db.update(schema.plans).set({ status: "approved", approvedAt: isoNow(), approvedBy: actor }).where(eq(schema.plans.id, planId)).run();

      // PAHALI MODEL ONAYI PLAN ONAYINA GÖMÜLÜ.
      //
      // Ayrı bir kapı türü, insana aynı karar anı için ikinci bir tıklama
      // bindirirdi. İnsan planı okurken öneriyi AYNI ekranda gördü ve onayladı;
      // denetim izine ayrıca yazılır ki "bu iş neden Fable'a gitti" sorusunun
      // cevabı sonradan bulunabilsin.
      const approvedChoice = this.lastTriageChoice(jobId, "postplan", profile);
      if (approvedChoice?.requiresApproval) {
        this.deps.db.insert(schema.auditLog).values({
          id: newId(), actor, action: "model.approve", subjectType: "job", subjectId: jobId,
          detail: { tier: approvedChoice.tier, model: approvedChoice.model, effort: approvedChoice.effort } as never,
        }).run();
        this.notice(jobId, `Pahalı model insan onayıyla seçildi: ${approvedChoice.model} (${approvedChoice.tier}).`);
      }

      // Safha seviyeleri ayrı yazılır: "bu SAFHA neden Fable'a gitti" sorusunun
      // cevabı iş geneli kayıtta bulunmaz. `subjectType:"phase"` ile ayrışır.
      //
      // Buraya ulaşan her pahalı safha insanın GÖRDÜĞÜ kapıdan geçti:
      // düzenleme yenisini getirdiyse yukarıda erken dönülüp kapı yeniden
      // açıldı, ikinci turda bu satırlar o kapının onayını kaydeder.
      for (const pm of this.phaseModels(planId, profile)) {
        if (!pm.requiresApproval) continue;
        this.deps.db.insert(schema.auditLog).values({
          id: newId(), actor, action: "model.approve", subjectType: "phase", subjectId: planId,
          detail: { order: pm.order, title: pm.title, tier: pm.tier, model: pm.model, effort: pm.effort } as never,
        }).run();
        this.notice(jobId, `Safha ${pm.order + 1} (${pm.title}): pahalı model insan onayıyla seçildi — ${pm.model} (${pm.tier}).`);
      }

      this.move(jobId, "Developing", "starting", "plan onaylandı", "human");
      return { jobId, state: "Developing", developing: this.runDeveloping(jobId, null) };
    }

    this.deps.db.update(schema.plans).set({ status: "rejected" }).where(eq(schema.plans.id, gate.subjectId!)).run();
    this.move(jobId, "Planning", "starting", `plan reddedildi: ${comment}`, "human");
    return { jobId, state: "Planning", planning: this.runPlanning(jobId, comment || "Plan reddedildi; gerekçe verilmedi.") };
  }

  /**
   * Son cevap turunu denetim izinden okur.
   *
   * Cevaplar gönderildikten sonra süreç ölürse plan `superseded` kalır ve
   * cevaplar hiçbir yerde görünmez; yeniden denemede insan aynı soruları
   * baştan cevaplamak zorunda kalırdı.
   */
  private lastAnswers(jobId: string): string | null {
    const gates = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(eq(schema.approvals.jobId, jobId)).all().map((g) => g.id);
    if (gates.length === 0) return null;
    const row = this.deps.db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "plan.answers"), inArray(schema.auditLog.subjectId, gates)))
      .orderBy(desc(schema.auditLog.createdAt)).limit(1).all()[0];
    const detail = row?.detail as { answers?: { question: string; answer: string }[]; comment?: string } | null;
    if (!detail?.answers?.length) return null;

    return renderAnswerPrompt(detail.answers, detail.comment ?? "");
  }

  /**
   * Plan kapısındaki açık soruları cevaplar ve Planner'ı aynı oturumdan
   * yeniden koşturur.
   *
   * Bu bir RED değil: plan kötü olduğu için değil, EKSİK olduğu için geri
   * gidiyor. Kapı `answered` ile kapanır, plan `superseded` olur — reddedilmiş
   * sayılmaz, çünkü insan planı beğenmedi demek yanlış olurdu.
   */
  answerPlanQuestions(jobId: string, answers: { question: string; answer: string }[], comment: string, actor = "human"): { state: JobState; planning: Promise<void> } {
    const { job } = this.load(jobId);
    // NeedsAttention da kabul edilir: sunucu yeniden başladığında PlanReview'daki
    // iş oraya düşüyor ama plan kapısı AÇIK kalıyor. Operatör ekranda soruları
    // görüp cevaplayabildiği hâlde 409 yemesin — cevaplamak zaten yeniden
    // planlatıyor, yani kurtarmanın ta kendisi.
    if (job.state !== "PlanReview" && job.state !== "NeedsAttention") {
      throw new EngineError("bad_state", `iş PlanReview değil (${job.state}): ${jobId}`);
    }
    // Mesaj operatöre gidiyor: "409" tek başına neyin yanlış olduğunu söylemez.
    if (this.busy.has(jobId)) throw new EngineError("busy", "Planner şu an koşuyor; tur bitince cevapları gönderin");

    const gate = this.deps.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.status, "pending"))).all()[0];
    if (!gate || gate.kind !== "plan") throw new EngineError("not_found", "bekleyen plan kapısı yok");

    // Yeniden planlanıyor: eski hata damgası (ör. `interrupted`) taşınmasın.
    this.deps.db.update(schema.jobs).set({ errorCode: null, errorMessage: null }).where(eq(schema.jobs.id, jobId)).run();
    this.deps.db.update(schema.approvals)
      .set({ status: "answered", comment, decidedAt: isoNow(), decidedBy: actor })
      .where(eq(schema.approvals.id, gate.id)).run();
    this.deps.db.update(schema.plans).set({ status: "superseded" }).where(eq(schema.plans.id, gate.subjectId!)).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "plan.answers", subjectType: "approval", subjectId: gate.id,
      // Cevapların KENDİSİ yazılır: yalnız sayı yazılırsa, tur bitmeden süreç
      // ölünce insanın emeği kaybolur ve plan da superseded kaldığı için geriye
      // hiçbir şey kalmaz (yaşandı). `retry()` bunları geri okur.
      detail: { count: answers.length, answers, comment } as never,
    }).run();

    this.move(jobId, "Planning", "starting", `${answers.length} soru cevaplandı`, "human");
    return { state: "Planning", planning: this.runPlanning(jobId, renderAnswerPrompt(answers, comment)) };
  }

  /**
   * Safha başına model seviyesini İNSAN değiştirir — plan ya da safha kapısı
   * açıkken.
   *
   * Motorun ölçümü muhafazakârdır ve muhafazakâr kalmalı: yanlış ucuz seçim
   * (başarısız iş + yeniden koşma) yanlış pahalıdan beterdir, `deriveTier`
   * bu yüzden yukarı eğilimli. Ama planı OKUYAN insan safhanın ne olduğunu
   * ölçümden iyi bilir — "Arayüz metinleri (ResourceMigration)" safhası dört
   * katmana dokunduğu için `deep` ölçülür, oysa iş kaynak dosyası taşımaktır
   * (ölçüldü 2026-09-20, Northwind #145). Eksik olan, insanın bunu
   * söyleyebilmesiydi: tek seçenek planı reddetmekti ve bu safhanın modelini
   * değil, planın kendisini çöpe atardı.
   *
   * SEVİYE yazılır, model adı DEĞİL (kural 8): merdivendeki karşılık karar
   * anında yeniden çözülür. Basamak merdivende TANIMLI DEĞİLSE müdahale
   * reddedilir — sessizce başka bir modele düşmek, insanın seçmediği bir
   * modeli seçtiği sanılarak koşmak olurdu. Denetim `cfg.ladder`a doğrudan
   * bakar; `rungFor` bu iş için uygun değil (aşağıdaki yoruma bakın).
   *
   * ONAY EŞİĞİ YENİDEN HESAPLANIR, taşınmaz: insan `standard`ı `frontier`a
   * çekerse bu safha artık onay ister ve kapı açık olduğu için o onay zaten
   * aynı ekranda verilecektir. Tersi de geçerli — pahalıyı ucuza çeken
   * müdahale, safhanın onay ihtiyacını kaldırır.
   *
   * Kapı KAPANMAZ ve plan sürümü ARTMAZ: bu bir karar değil, kararın
   * girdisinin düzeltilmesi. İnsan tabloyu düzeltir, sonra aynı banner'dan
   * onaylar. Kapı yükü yeniden yazılır ki onay anında okunan şey (`decide`
   * içindeki `phaseModels`) ekranda görülenle aynı olsun.
   */
  overridePhaseTiers(
    jobId: string,
    overrides: { order: number; tier: ModelTier | null }[],
    comment = "",
    actor = "human",
  ): { jobId: string; phaseModels: PlanGatePayload["phaseModels"] } {
    const { job, profile } = this.load(jobId);
    if (this.busy.has(jobId)) throw new EngineError("busy", "iş koşuyor; tur bitince deneyin");

    const gate = this.deps.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.status, "pending"))).all()[0];
    // İki kapıda geçerli: plan kapısı (tüm safhalar) ve safha kapısı (yalnız
    // henüz BAŞLAMAMIŞ safhalar). Safha kapısı 48 safhalı bir planda insanın
    // "bundan sonrası ucuz modelle" diyebildiği tek yer — plan kapısında
    // verilen karar, kota tükenmeye başladığında artık geçmişte kalmıştı.
    const atPhaseGate = gate?.kind === "phase";
    if (!gate || (gate.kind !== "plan" && !atPhaseGate)) {
      throw new EngineError("not_found", "bekleyen plan ya da safha kapısı yok");
    }
    // `answerPlanQuestions` ile aynı gerekçe: sunucu yeniden başlayınca kapıdaki
    // iş NeedsAttention'a düşer ama kapı açık kalır.
    const okStates: JobState[] = atPhaseGate ? ["Developing", "Building", "NeedsAttention"] : ["PlanReview", "NeedsAttention"];
    if (!okStates.includes(job.state as JobState)) {
      throw new EngineError("bad_state", `iş ${okStates.join("/")} değil (${job.state}): ${jobId}`);
    }

    const cfg = profile.agents.triage;
    // Plan kapısındaki tablo ölçümün düzeltmesidir; ölçüm kapalıysa tablo da
    // yok. Safha kapısında ise seçim ölçümden bağımsız (`phaseModelChoice`).
    if (!atPhaseGate && (!cfg.enabled || !cfg.stages.perPhase)) {
      throw new EngineError("bad_state", "profilde safha başına model seçimi kapalı");
    }

    const planId = atPhaseGate ? this.approvedPlan(jobId).id : gate.subjectId;
    if (!planId) throw new EngineError("not_found", "kapıya bağlı plan yok");

    // DOĞRULAMA ÖNCE, YAZMA SONRA: yarısı uygulanmış bir müdahale, insanın
    // ekranda gördüğüyle kayıttakinin ayrışması demek.
    const rows = this.deps.db.select().from(schema.planPhases)
      .where(eq(schema.planPhases.planId, planId)).all();
    const byOrder = new Map(rows.map((r) => [r.order, r]));
    /**
     * Elle seçim kaldırılınca dönülecek seviye. `derivedTier` doluysa motorun
     * ölçümü oraya saklanmıştı. İnsan kaynaklı ama `derivedTier` boş satır,
     * ölçümü HİÇ olmayan safhaya safha kapısında verilmiş seçimdir — geri
     * alma onu seviyesiz hâline (iş geneli seçime) döndürür.
     */
    const engineTier = (row: typeof rows[number]): ModelTier | null =>
      (row.derivedTier ?? (row.tierSource === "human" ? null : row.tier)) as ModelTier | null;
    const applied: { order: number; from: string; to: string }[] = [];
    for (const o of overrides) {
      const row = byOrder.get(o.order);
      if (!row) throw new EngineError("not_found", `safha yok: ${o.order + 1}`);
      // Koşmuş ya da koşan safhanın seviyesini değiştirmek hiçbir şeyi
      // değiştirmez ama tabloda öyleymiş gibi görünürdü.
      if (atPhaseGate && row.status !== "pending") {
        throw new EngineError("bad_state", `safha ${o.order + 1} başladı; yalnız sıradaki safhaların modeli değişir`);
      }
      // Plan kapısında seviyesiz safha (ölçüm koşmamış) elle seviyelendirilmez:
      // iş geneli seçimine düşüyor demektir ve tek safhayı ondan koparmak,
      // tablonun göstermediği bir davranış üretirdi. Safha kapısında ise
      // önizleme etkin modeli ve kaynağını açıkça gösteriyor.
      if (!atPhaseGate && !row.tier) throw new EngineError("bad_state", `safha ${o.order + 1} için ölçüm yok`);
      // `cfg.ladder[o.tier]` — `rungFor` DEĞİL. `rungFor` eksik basamakta
      // `fallbackTier`a ya da ilk tanımlı basamağa düşüyor ve asla `null`
      // dönmüyor; onunla denetlemek, merdiveninde `frontier` olmayan bir
      // profilde "frontier" seçimini geçiriyordu. Seçim `planPhases.tier`a
      // yazılıyor, ama `phaseModels` aynı `rungFor`u çağırıp BAŞKA bir model
      // buluyordu — insanın gördüğü seviye ile koşan model ayrışıyordu.
      if (o.tier && !cfg.ladder[o.tier]) {
        throw new EngineError("unsupported", `profil merdiveninde ${o.tier} basamağı yok`);
      }
      // `applied` KIRPILMIŞ değeri taşır: `maxTier` insanı da bağlıyor ve
      // aşağıdaki transaction `clampToMaxTier`den geçmiş tier'ı yazıyor.
      // Kırpılmamış hâli raporlamak, denetim izinin ve bildirimin kalıcı
      // kayıttan farklı bir seviye söylemesi demekti.
      const wanted = o.tier ?? engineTier(row);
      applied.push({
        order: o.order,
        from: row.tier ?? "iş geneli",
        to: wanted ? clampToMaxTier(wanted, cfg.maxTier) : "iş geneli",
      });
    }

    const threshold = cfg.approvalRequiredFrom;
    this.deps.db.transaction((tx) => {
      for (const o of overrides) {
        const row = byOrder.get(o.order)!;
        const next = o.tier ?? engineTier(row);
        // Kırpmadan sonra: `maxTier` insanı da bağlar. Kör maliyet freni her
        // şeyin üstünde (kural: profil frenleri motorun kararının da üstünde).
        const tier = next ? clampToMaxTier(next, cfg.maxTier) : null;
        const requiresApproval = tier !== null && threshold !== null
          && MODEL_TIER_ORDER.indexOf(tier) >= MODEL_TIER_ORDER.indexOf(threshold);
        tx.update(schema.planPhases).set({
          tier,
          tierRequiresApproval: requiresApproval,
          tierSource: o.tier ? "human" : "engine",
          // Motorun ölçümü İLK müdahalede saklanır; sonraki müdahaleler onu
          // ezmemeli, yoksa "geri al" insanın bir önceki seçimine döner.
          derivedTier: o.tier ? engineTier(row) : null,
        }).where(eq(schema.planPhases.id, row.id)).run();
      }

      tx.insert(schema.auditLog).values({
        id: newId(), actor, action: "model.override", subjectType: "plan", subjectId: planId,
        detail: { changes: applied, comment, gate: gate.kind } as never,
      }).run();
    });

    const summary = applied
      .filter((a) => a.from !== a.to)
      .map((a) => `${a.order + 1}. safha ${a.from} → ${a.to}`)
      .join(", ");

    if (atPhaseGate) {
      // Safha kapısının yükü sıradaki safhayı taşımıyor (önizleme istekle
      // hesaplanıyor); yeniden yazılacak bir şey yok. Akış notu yeter — ama
      // zorlama varsa söylenmeli: seçim kaydedildi, koşuyu etkilemeyecek.
      if (summary) {
        const forced = this.forcedModel(jobId, profile);
        this.notice(jobId, `Model seviyesi elle değiştirildi: ${summary}.${
          forced ? ` İş geneli zorlama (${forced.model}) sürdükçe safha seçimi uygulanmaz.` : ""
        }`);
      }
      return { jobId, phaseModels: this.phaseModels(planId, profile) };
    }

    // Kapı yükü tazelenir: `decide` onay anında bunu okuyacak ve denetim izine
    // "insan onayıyla seçildi" satırlarını buradan yazacak.
    const phaseModels = this.phaseModels(planId, profile);
    const payload = { ...(gate.payload as object), phaseModels };
    this.deps.db.update(schema.approvals).set({ payload: payload as never })
      .where(eq(schema.approvals.id, gate.id)).run();

    if (summary) this.notice(jobId, `Model seviyesi elle değiştirildi: ${summary}.`);
    this.deps.hub.publish(jobId, { type: "approval.required", gateId: gate.id, kind: "plan", payload });

    return { jobId, phaseModels };
  }

  // ── Canlı test ───────────────────────────────────────────────────────────

  /**
   * Build yeşil → ortam kalkar → hazırsa LiveTest kapısı. Hazır olmazsa
   * ortam YIKILMAZ (loglar incelenebilsin) ve iş NeedsAttention'a düşer.
   */
  /**
   * Canlı ortamı YIKIP yeniden kaldırır — aynı iş, aynı safha.
   *
   * Profil değişince (port, bağlantı, komut) koşan ortam ESKİ yapılandırmayla
   * kalıyor: canlı ortam bir kez kalktıktan sonra profil ona geçmiyor.
   * Eskiden bunu yapacak bir yol yoktu; tek seçenek kapıyı reddedip işi
   * Developing'e döndürmekti — oysa kodda düzeltilecek bir şey yok, yalnız
   * ortam bayat (yaşandı 2026-09-17).
   */
  async relaunchLive(jobId: string, actor = "human"): Promise<{ jobId: string; state: JobState; work: Promise<void> }> {
    const { job, profile } = this.load(jobId);
    if (job.state !== "LiveTest") throw new EngineError("bad_state", `iş LiveTest değil (${job.state}): ${jobId}`);
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş koşuyor: ${jobId}`);
    if (!profile.live?.enabled || !this.deps.live) throw new EngineError("bad_state", "profilde canlı ortam yok");

    // Açık kapı kapanır: yenisi yeni adreslerle açılacak.
    this.deps.db.update(schema.approvals).set({ status: "expired", decidedAt: isoNow() })
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.status, "pending"))).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "live.relaunch", subjectType: "job", subjectId: jobId,
    }).run();

    const work = (async () => {
      await this.deps.live!.stop(jobId, job.worktreePath ?? ".", profile.live, "yeniden kaldırılıyor").catch(() => false);
      // Build burada AYRICA koşmaz: `buildBeforeStart` artık build'i canlı
      // konteynerin `command`'ına zincirliyor (bkz. live/buildChain.ts).
      await this.startLiveTest(jobId, profile, job.worktreePath);
    })();
    return { jobId, state: "LiveTest", work };
  }

  private async startLiveTest(jobId: string, profile: ProjectProfile, worktreePath: string | null): Promise<void> {
    if (!worktreePath || !this.deps.live) return;
    // "Yeniden kaldır"da iş ZATEN LiveTest'te; kendine geçiş reddedilir
    // (aynı tuzak `Building`de de vardı, bkz. `runDeveloping`).
    if (this.load(jobId).job.state === "LiveTest") this.setPhase(jobId, "starting", "LiveTest");
    else this.move(jobId, "LiveTest", "starting", "canlı ortam kalkıyor", "system");
    const round = (this.deps.db.select({ lc: schema.jobs.loopCounts }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.lc?.["live"] ?? 0) + 1;
    // Yürütücü: compose base dosyası worktree'de (volume) ve host'ta yok —
    // canlı ortam onu buradan çıkarıp artifact dizinine yazar.
    const rt = await this.acquireRuntime(jobId, profile);
    let started: Awaited<ReturnType<LiveController["start"]>>;
    try {
      // İşe özel değişkenler her kalkışta DB'den okunur: "Yeniden kaldır"
      // öncesi yapılan düzenleme bu turda geçerli olmalı.
      const jobEnv = this.load(jobId).job.liveEnv ?? {};
      started = await this.deps.live.start({
        jobId, profile, worktreePath, executor: rt.executor,
        ...(Object.keys(jobEnv).length > 0 ? { jobEnv } : {}),
      });
    } catch (err) {
      // `start()` FIRLATTIYSA ortam yarıda kalmıştır ve kimse ona sahip
      // çıkmıyor: kapı açılmadı, "yeniden dene" onu görmeden yenisini kurar.
      // `ready:false` dönüşünden farkı bu — orada ortam tanı için kasten
      // bırakılır, burada bırakılan yalnız port ve konteyner tüketir.
      await this.deps.live.stop(jobId, worktreePath, profile.live, "başlatma düştü").catch(() => false);
      this.fail(jobId, "live_not_ready", `canlı ortam kaldırılamadı: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!started.ready) {
      // Build zincirde düştüyse bu Developer'ın işi; ortam kalkmadığı için
      // insanı çağırmak yanlış olurdu. `busy` iç içe çağrıda devralınır.
      if (started.buildFailed) {
        // Tanı (`logTail`) zaten alındı; ortamı ayakta tutmak yalnız port
        // kirası tüketir — tekrarlanan kırmızı build havuzu bitirirdi.
        await this.deps.live.stop(jobId, worktreePath, profile.live, "build düştü").catch(() => false);
        this.busy.delete(jobId);
        await this.returnToDeveloperForBuild(
          jobId, profile, this.approvedPlan(jobId).id,
          renderContainerBuildFeedback(started.failedStep ?? "", started.logTail ?? ""),
        );
        return;
      }
      this.fail(jobId, "live_not_ready", `canlı ortam hazır olmadı: ${started.reason}`);
      return;
    }
    const reused = await this.reusableLiveDast(jobId, profile, worktreePath);
    const dast = reused ?? await this.runLiveDast(jobId, profile, worktreePath, round);
    // Taşınan özet bu kod için zaten karara bağlandı (kapı ya da autoFix);
    // aynı bulguyla yeniden düzeltme safhası açmak döngü olurdu.
    if (!reused && dast && profile.live?.dast.autoFix && dast.blocking > 0) {
      if (await this.dastAutoFix(jobId, profile, worktreePath, dast)) return;
    }
    // DAST'tan SONRA: autoFix kapıyı açmadan düzeltmeye dönerse tarayıcı turu
    // boşa koşmuş olurdu.
    const browserRun = await this.runLiveBrowserTest(jobId, profile, worktreePath, round, liveUrlLine(started));
    const payload: LiveGatePayload = {
      ...(dast ? { dast } : {}),
      ...(browserRun ? { browserRun } : {}),
      appUrl: started.appUrl,
      ...(started.apiUrl ? { apiUrl: started.apiUrl } : {}),
      ...(started.publicUrl ? { publicUrl: started.publicUrl } : {}),
      ports: started.ports, expiresAt: started.expiresAt, round,
    };
    const gateId = this.openApproval(jobId, "live_test", started.id, payload);
    this.setPhase(jobId, "waiting", "LiveTest");
    this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "live_test", payload });
  }

  /**
   * Canlı ortam hazırken, kapı açılmadan DAST (`live.dast`). Düşerse ya da
   * kapalıysa `undefined`; akış durmaz — kapı yine açılır.
   */
  private async runLiveDast(jobId: string, profile: ProjectProfile, worktreePath: string, round: number): Promise<DastSummary | undefined> {
    const cfg = profile.live?.dast;
    if (!cfg?.enabled || !this.deps.live?.dast) return undefined;
    // Taramadan ÖNCE okunur: tarama sürerken kod değişmez ama sırası açık olsun.
    const sha = await this.cleanHead(jobId, profile, worktreePath);
    const tree = await this.worktreeTree(jobId, profile, worktreePath);
    const steps = cfg.steps.filter((s) => s.enabled);
    const off = cfg.steps.filter((s) => !s.enabled).map((s) => s.id);
    this.setPhase(jobId, "running", "LiveTest");
    const scope = await this.dastTargets(jobId, profile, worktreePath, cfg);
    if (!scope) {
      this.notice(jobId, "DAST atlandı: dalın değiştirdiği dosyalarda uç bulunamadı (`live.dast.scope.whenEmpty: skip`).");
      return undefined;
    }
    this.notice(jobId, `DAST koşuyor: ${steps.map((s) => s.id).join(", ")}${off.length > 0 ? ` (profilde kapalı: ${off.join(", ")})` : ""} · ${
      scope.mode === "branch"
        ? `dalın ${scope.paths.length} ucu: ${scope.paths.slice(0, 8).join(", ")}${scope.paths.length > 8 ? " …" : ""}`
        : `tüm uygulama${scope.reason ? ` (${scope.reason})` : ""}`
    }.`);
    let dast: DastSummary;
    try {
      dast = await this.deps.live.dast({ jobId, profile, round, scope });
      dast = { ...dast, ...(sha ? { sha } : {}), ...(tree ? { tree } : {}), configKey: dastConfigKey(cfg) };
    } catch (err) {
      this.notice(jobId, `DAST koşamadı; kapı açılıyor. Sebep: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500)}`);
      return undefined;
    }
    for (const f of dast.failures) this.notice(jobId, `DAST · ${f.step}: ${f.reason}`);
    const c = dast.counts;
    this.notice(jobId, dast.ran
      ? `DAST: ${c.high} yüksek · ${c.medium} orta · ${c.low} düşük · ${c.info} bilgi; eşik (${dast.minRisk}+) üstü ${dast.blocking}.`
      // Boş liste "temiz" değil: hiçbir rapor okunamadı.
      : "DAST: hiçbir rapor okunamadı; sonuç yok (temiz DEĞİL).");
    return dast;
  }

  /**
   * DAST kapsamı (`live.dast.scope`): tabana göre değişen dosyalardan rota
   * yolları. Uç yoksa `whenEmpty`: `full` → tam tarama, `skip` → `null`.
   * Dosyalar okunamazsa tam taramaya düşülür — kapsamı daraltamamak
   * taramayı düşürmekten iyidir.
   */
  private async dastTargets(jobId: string, profile: ProjectProfile, worktreePath: string, cfg: Dast): Promise<DastTargets | null> {
    const sc = cfg.scope;
    let changed: string[] = [];
    const full = (reason?: string): DastTargets => ({ mode: "full", paths: [], changedFiles: changed, ...(reason ? { reason } : {}) });
    if (sc.mode === "full") return full();
    try {
      const rt = await this.acquireRuntime(jobId, profile);
      changed = await changedFiles(rt.executor, worktreePath, this.diffBase(jobId, profile));
      if (!sc.routePattern) return full("`scope.routePattern` tanımlı değil");
      const files = sc.files.length > 0 ? changed.filter((f) => sc.files.some((g) => posix.matchesGlob(f, g))) : changed;
      const paths = new Set<string>();
      // Silinen dosya `cat`te düşer, diğerleri yine okunur; çıkış kodu önemsiz.
      for (let i = 0; i < files.length; i += 100) {
        let text = "";
        await rt.executor.run({
          command: `cat -- ${files.slice(i, i + 100).map(shellQuote).join(" ")} 2>/dev/null`,
          cwd: worktreePath, env: {}, timeoutMs: 120_000,
          onLine: (_s, line) => { text += `${line}\n`; },
        });
        // Tavan parça başına değil birleşik listeye: env boyu buna bağlı.
        for (const p of extractRoutes(text, sc.routePattern, sc.routePrefix)) {
          if (paths.size >= MAX_TARGET_PATHS) break;
          paths.add(p);
        }
        if (paths.size >= MAX_TARGET_PATHS) break;
      }
      if (paths.size > 0) return { mode: "branch", paths: [...paths].sort(), changedFiles: changed };
      return sc.whenEmpty === "skip" ? null : full("dalın değiştirdiği dosyalarda uç bulunamadı");
    } catch (err) {
      return full(`kapsam çıkarılamadı: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  }

  /**
   * `live.dast.autoFix`: eşik üstü bulgu varsa kapı açmadan düzeltme safhası —
   * insanın reddiyle aynı yol, aynı `maxLoops.live` tavanı. Tavan doluysa
   * `false`: kapı açılır, insan karar verir (iş düşürülmez).
   */
  private async dastAutoFix(jobId: string, profile: ProjectProfile, worktreePath: string, dast: DastSummary): Promise<boolean> {
    const max = profile.limits.maxLoops.live;
    if (this.loopCount(jobId, "live") >= max) {
      this.notice(jobId, `DAST: canlı test turu tavanı (${max}) dolu; bulgular kapıda insana bırakılıyor.`);
      return false;
    }
    const feedback = renderDastFeedback(dast, true);
    const loop = bumpLoop(this.deps.db, jobId, "live", max);
    await this.deps.live?.stop(jobId, worktreePath, profile.live, "DAST düzeltmesi için").catch(() => false);
    this.addFixPhase(jobId, `DAST düzeltmesi ${loop.count}`, feedback);
    this.move(jobId, "Developing", "starting", `DAST ${dast.blocking} bulgu (${loop.count}/${max})`, "system");
    // `busy` iç içe çağrıda devralınır (`returnToDeveloperForBuild` ile aynı).
    this.busy.delete(jobId);
    await this.runDeveloping(jobId, `Canlı ortama karşı otomatik DAST taraması eşik üstü bulgu verdi.\n${feedback}\nDüzelt; dosya sınırı yok, ama yalnız bu kusurlara dokun.`);
    return true;
  }

  /**
   * Aynı kod ve aynı `live.dast` ayarıyla koşmuş bir tarama varsa onun
   * özeti. "Yeniden kaldır" çoğu zaman yalnız ortamı tazeler (profil, port);
   * kod değişmediyse DAST'ı baştan koşturmak dakikalar yakıyordu (yaşandı).
   * Hiç rapor okunamamış tarama taşınmaz.
   *
   * Kod kimliği çalışma ağacının tamamı (`tree`), temiz HEAD değil: canlı
   * konteyner build zincirini worktree'de koşuyor ve ağacı kirletiyor
   * (`npm install` kilit dosyasını yazar, ignore'suz çıktılar kalır). Temiz
   * HEAD şartıyla tarama "Yeniden kaldır"da HİÇ taşınmıyordu (yaşandı,
   * 2026-10-12). Taşınmazsa sebep akışa yazılır — sessiz yeniden tarama
   * neden diye sorduruyordu.
   */
  private async reusableLiveDast(jobId: string, profile: ProjectProfile, worktreePath: string): Promise<DastSummary | undefined> {
    const cfg = profile.live?.dast;
    if (!cfg?.enabled || !this.deps.live?.dast) return undefined;
    const last = this.lastLiveDast(jobId);
    if (!last) return undefined;
    const why = (reason: string): undefined => {
      this.notice(jobId, `DAST yeniden koşuyor: ${reason}.`);
      return undefined;
    };
    if (!last.ran) return why("önceki taramada hiçbir rapor okunamamıştı");
    if (last.configKey !== dastConfigKey(cfg)) return why("`live.dast` ayarı son taramadan beri değişti");
    if (last.tree) {
      const tree = await this.worktreeTree(jobId, profile, worktreePath);
      if (!tree) return why("çalışma ağacının özeti alınamadı");
      if (tree !== last.tree) {
        const files = await this.treeDiff(jobId, profile, worktreePath, last.tree, tree);
        return why(`kod son taramadan beri değişti${files.length > 0 ? ` (${files.slice(0, 5).join(", ")}${files.length > 5 ? ` +${files.length - 5}` : ""})` : ""}`);
      }
    } else {
      // `tree`den önceki özetler: yalnız temiz HEAD eşleşmesi.
      const head = await this.cleanHead(jobId, profile, worktreePath);
      if (!last.sha || head !== last.sha) return why("önceki tarama kodun kimliğini taşımıyor");
    }
    this.notice(jobId, `DAST: kod son taramadan beri değişmedi; önceki sonuç taşınıyor — eşik (${last.minRisk}+) üstü ${last.blocking}.`);
    return last;
  }

  /** İki ağaç özeti arasındaki dosyalar — taşınmayan taramanın sebebi. */
  private async treeDiff(jobId: string, profile: ProjectProfile, worktree: string, a: string, b: string): Promise<string[]> {
    try {
      const rt = await this.acquireRuntime(jobId, profile);
      const out = await execGit(rt.executor, worktree, ["diff", "--name-only", a, b], { allowFailure: true });
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Son `live_test` kapısının DAST özeti — kapının durumu ne olursa olsun. */
  private lastLiveDast(jobId: string): DastSummary | null {
    return this.lastLiveGatePayload(jobId)?.dast ?? null;
  }

  private lastLiveGatePayload(jobId: string): LiveGatePayload | null {
    const gate = this.deps.db.select({ payload: schema.approvals.payload }).from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, "live_test")))
      .orderBy(desc(schema.approvals.requestedAt)).limit(1).all()[0];
    return (gate?.payload as LiveGatePayload | null | undefined) ?? null;
  }

  /**
   * Canlı testte tarayıcı turu (karar §41): liste yoksa `tester` çıkarır,
   * aynı oturumda Playwright MCP ile yürütür, checklist'i `agent` kaynağıyla
   * işaretler. DAST gibi ön filtre: koşamazsa özet `skipped` taşır, kapı yine
   * açılır. Agent "kaldı"sı Developer'a ancak insan reddinde gider.
   */
  private async runLiveBrowserTest(jobId: string, profile: ProjectProfile, worktreePath: string, round: number, liveUrl: string): Promise<BrowserRunSummary | undefined> {
    const cfg = profile.live?.browserTest;
    const live = this.deps.live;
    if (!cfg?.enabled || !live?.attachBrowser) return undefined;
    const startedAt = Date.now();
    const empty = { round, ran: 0, pass: 0, fail: 0, unsure: 0, noResult: 0, missingSelectors: [] as string[] };
    const skip = (why: string): BrowserRunSummary => {
      this.notice(jobId, `Tarayıcı testi atlandı: ${why}`);
      return { ...empty, durationMs: Date.now() - startedAt, skipped: why };
    };
    // Köprü konteyner başına tek koşu alıyor. "Yeniden kaldır" yolu meşgul
    // işaretini tutmadan geliyor; bu arada istenen senaryo üretimi köprüde
    // "busy" ile düşerdi.
    const owned = !this.busy.has(jobId);
    if (owned) this.busy.add(jobId);
    let detach: (() => Promise<void>) | null = null;
    try {
      this.setPhase(jobId, "running", "LiveTest");
      const rt = await this.acquireRuntime(jobId, profile);
      if (!rt.transport.supports?.("browser")) {
        return skip("iş konteynerinin köprüsü tarayıcıyı desteklemiyor (konteyner tarayıcılı imajdan önce kurulmuş; yeniden kurulunca gelir)");
      }
      const tree = await this.worktreeTree(jobId, profile, worktreePath);
      const last = this.lastLiveGatePayload(jobId)?.browserRun;
      const profileId = this.load(jobId).job.profileId ?? undefined;
      const currentRowId = this.latestScenarioRow(jobId)?.id;
      // Sonuçsuz senaryo kalan tur taşınmaz: uygulama hiç açılmadıysa (yanlış
      // adres, ortam sorunu) kod aynı olsa da sonuç kanıt değildir. Satır ve
      // profil kimliği taşımayan eski özet de eşleşme sayılmaz.
      if (
        last && !last.skipped && last.noResult === 0 && tree && last.tree === tree &&
        last.scenarioRowId !== undefined && last.scenarioRowId === currentRowId &&
        last.profileId !== undefined && last.profileId === profileId
      ) {
        this.notice(jobId, `Tarayıcı testi: kod son turdan beri değişmedi; önceki işaretler geçerli (${last.pass} geçti, ${last.fail} kaldı, ${last.unsure} kararsız).`);
        return { ...last, round };
      }

      // Liste: plan onayında ya da önceki turda hazırlanmış olan, yoksa şimdi
      // üretilen. Üretimin oturumu sürer — kodu ve diff'i yeniden okumasın.
      let sessionId: string | null = null;
      if (!this.latestScenarioRow(jobId)) {
        const { job } = this.load(jobId);
        const plan = this.approvedPlan(jobId);
        const { id, cleanNote } = this.openScenarioRow(jobId, plan.id, "live", "", "system");
        try {
          sessionId = (await this.produceScenarios({
            jobId, id, profile, job, planDoc: PlanDocumentSchema.parse(plan.document), stage: "live", worktreePath, note: cleanNote, liveUrl,
          })).sessionId;
        } catch {
          return skip("senaryo listesi çıkarılamadı");
        }
      }
      const row = this.latestScenarioRow(jobId);
      const doc = row ? TestScenariosDocumentSchema.safeParse(row.document) : null;
      if (!row || !doc?.success) return skip("senaryo listesi okunamadı");
      const picked = pickBrowserScenarios(doc.data.scenarios, parseScenarioMarks(row.marks), cfg.scope);
      if (picked.length === 0) return skip("koşacak senaryo yok — hepsi insan tarafından işaretli");

      let target: { baseUrl: string; origins: string[] };
      try {
        const att = await live.attachBrowser(jobId, profile);
        detach = att.detach;
        target = att;
      } catch (err) {
        return skip(`iş konteyneri uygulamanın ağına bağlanamadı: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
      }

      // Şema adların hesaplar arasında tekilliğini garanti eder; tek dotenv.
      const secrets: Record<string, string> = Object.assign({}, ...cfg.accounts.map((a) => a.credentials));
      registerSecretValues(Object.values(secrets));
      // Worktree'nin DIŞINDA (volume kökü): kanıtlar diff'e girmesin.
      const outputDir = posix.join(rt.workdirRoot, ".ahtapot", `live-${round}`);
      await rt.executor.run({
        // `.start`: süpürmenin "bu turda doğdu" ölçüsü (bkz. sweepStrayEvidence).
        command: `rm -rf ${shellQuote(outputDir)} && mkdir -p ${shellQuote(outputDir)} && touch ${shellQuote(posix.join(outputDir, ".start"))}`,
        cwd: rt.workdirRoot, env: {}, timeoutMs: 60_000, onLine: () => {},
      });

      this.notice(jobId, `Tarayıcı testi koşuyor: ${picked.length} senaryo · ${target.baseUrl}`);
      const role = profile.agents.roles["tester"] ?? profile.agents.roles["qa"];
      const accounts = cfg.accounts.map((a) => ({ role: a.role, description: a.description, names: Object.keys(a.credentials) }));
      const prompt = renderBrowserTestPrompt({ picked, baseUrl: target.baseUrl, accounts, evidence: cfg.evidence, selectorAttribute: cfg.selectorAttribute });
      const browser = {
        outputDir,
        allowedOrigins: target.origins,
        viewport: cfg.viewport,
        ...(cfg.selectorAttribute ? { testIdAttribute: cfg.selectorAttribute } : {}),
        secrets,
      };
      const channel = new LiveInputChannel();
      this.channels.set(jobId, channel);
      const timer = setTimeout(() => {
        this.notice(jobId, `Tarayıcı testi ${cfg.timeoutMinutes} dakikada bitmedi; kesiliyor. Yalnız tam ve geçerli bir sonuç bloğu işlenir; blok yoksa ya da yarım kaldıysa senaryolar işaretsiz kalır.`);
        void this.deps.runner.abortJob(jobId, "tarayıcı testi süre tavanı").catch(() => false);
      }, cfg.timeoutMinutes * 60_000);
      timer.unref?.();
      let run: RunResult;
      try {
        run = await this.deps.runner.run({
          jobId, role: "tester", prompt,
          model: role?.model ?? "claude-opus-5-5", effort: role?.effort ?? "medium",
          maxTurns: cfg.maxTurns, maxBudgetUsd: role?.maxBudgetUsd ?? 10,
          cwd: worktreePath,
          allowedTools: ["Read", "Glob", "Grep", ...READ_ONLY_BASH, "mcp__playwright"],
          disallowedTools: [...READ_ONLY_DENY],
          systemPrompt: loadRolePrompt("tester"),
          resumeSessionId: sessionId,
          channel,
          transport: rt.transport,
          onTurn: (turn) => this.onLiveTurn(jobId, profile, channel, turn.text, "SCENARIO_RESULTS_JSON", cfg.idleMinutes),
          browser,
        });
      } finally {
        clearTimeout(timer);
        channel.close();
        if (this.channels.get(jobId) === channel) this.channels.delete(jobId);
        // Koşu düşse de: yarıda kalan turun görüntüleri worktree'de kalıp
        // commit'e girmesin. Sonuç isteyen ikinci koşu araçsız, görüntü üretmez.
        await sweepStrayEvidence(rt.executor, worktreePath, outputDir);
      }

      // Üç katman (kural 3): blok yoksa bir kez istenir; yine yoksa sonuçsuz
      // senaryolar işaretsiz kalır — insan dener. "Kararsız" uydurulmaz:
      // agent'ın denemediği bir senaryo için yanlış bir iz bırakırdı.
      let parsed = parseScenarioResults(run.text);
      if (!parsed && run.sessionId && run.subtype !== "error" && run.subtype !== "quota") {
        const retry = await this.deps.runner.run({
          jobId, role: "tester",
          prompt: "SCENARIO_RESULTS_JSON bloğu bulunamadı ya da şemaya uymuyor. Denediğin senaryoların sonucuyla tam ve geçerli bir SCENARIO_RESULTS_JSON bloğu üret; yeni deneme yapma.",
          model: role?.model ?? "claude-opus-5-5", effort: role?.effort ?? "medium",
          maxTurns: 5, maxBudgetUsd: 1,
          cwd: worktreePath, allowedTools: [], disallowedTools: [...READ_ONLY_DENY],
          systemPrompt: loadRolePrompt("tester"), resumeSessionId: run.sessionId, transport: rt.transport,
        });
        parsed = parseScenarioResults(retry.text);
      }

      const copied = cfg.evidence === "screenshot"
        ? await copyBrowserEvidence(rt.executor, outputDir, join(this.deps.artifactsDir, jobId, `live-${round}`))
        : new Set<string>();
      const summary = this.applyBrowserMarks(jobId, row.id, picked.map((p) => p.key), parsed?.results ?? [], copied, round);
      const missingSelectors = (parsed?.missingSelectors ?? []).map((s) => scrubSecrets(s).slice(0, 300)).slice(0, 40);
      this.notice(jobId, `Tarayıcı testi bitti: ${summary.pass} geçti, ${summary.fail} kaldı, ${summary.unsure} kararsız${summary.noResult > 0 ? `, ${summary.noResult} sonuçsuz (işaretsiz bırakıldı)` : ""}${missingSelectors.length > 0 ? ` · ${missingSelectors.length} eleman kimliksiz` : ""}.`);
      return {
        round, ran: picked.length, ...summary, missingSelectors,
        durationMs: Date.now() - startedAt, ...(tree ? { tree } : {}),
        scenarioRowId: row.id, ...(profileId ? { profileId } : {}),
      };
    } catch (err) {
      return skip(scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300));
    } finally {
      await detach?.().catch(() => {});
      if (owned) this.busy.delete(jobId);
    }
  }

  /**
   * Agent sonuçlarını checklist'e yazar. Tur sürerken insanın koyduğu
   * işaret EZİLMEZ: satır yeniden okunur, `human` kaynaklı (retest hariç)
   * işaret olduğu gibi kalır.
   */
  private applyBrowserMarks(jobId: string, rowId: string, keys: string[], results: ScenarioResult[], evidence: Set<string>, round: number): { pass: number; fail: number; unsure: number; noResult: number } {
    const row = this.deps.db.select().from(schema.testScenarios)
      .where(and(eq(schema.testScenarios.id, rowId), eq(schema.testScenarios.jobId, jobId))).all()[0];
    const counts = { pass: 0, fail: 0, unsure: 0, noResult: 0 };
    if (!row) return counts;
    const marks = parseScenarioMarks(row.marks);
    const byKey = new Map(results.map((r) => [r.key, r]));
    const at = isoNow();
    for (const key of keys) {
      const cur = marks[key];
      if (cur && cur.source === "human" && cur.state !== "retest") continue;
      const r = byKey.get(key);
      if (!r) {
        counts.noResult++;
        continue;
      }
      counts[r.state]++;
      marks[key] = {
        state: r.state, note: scrubSecrets(r.note.trim()).slice(0, 2000), round: row.round, at, source: "agent",
        // `<tur>/<dosya>`: kanıt dizini canlı test turuna göre, satırın turu ayrı sayılır.
        evidence: r.evidence.map((f) => basename(f)).filter((f) => evidence.has(f)).map((f) => `${round}/${f}`),
      };
    }
    this.deps.db.update(schema.testScenarios).set({ marks }).where(eq(schema.testScenarios.id, rowId)).run();
    return counts;
  }

  /** En son HAZIR senaryo satırı. */
  private latestScenarioRow(jobId: string): typeof schema.testScenarios.$inferSelect | undefined {
    return this.deps.db.select().from(schema.testScenarios)
      .where(and(eq(schema.testScenarios.jobId, jobId), eq(schema.testScenarios.status, "ready")))
      .orderBy(desc(schema.testScenarios.createdAt)).limit(1).all()[0];
  }

  /**
   * Onay → ortam yıkılır, QACases. Red + yorum → ortam yıkılır, "canlı test
   * düzeltmesi" adında yeni bir safha açılır ve Developer yorumla koşar;
   * safha onayından sonra ortam yeniden kalkar. `maxLoops.live` tavanı.
   */
  private decideLiveTest(jobId: string, profile: ProjectProfile, worktreePath: string | null, decision: "approve" | "reject", comment: string): { jobId: string; state: JobState; developing?: Promise<void> } {
    const stop = () => this.deps.live?.stop(jobId, worktreePath ?? ".", profile.live, decision === "approve" ? "canlı test onaylandı" : "düzeltme için").catch(() => {});
    if (decision === "approve") {
      void stop();
      return { jobId, state: "QACases", developing: this.enterQa(jobId, profile, worktreePath) };
    }

    const loop = bumpLoop(this.deps.db, jobId, "live", profile.limits.maxLoops.live);
    if (loop.exceeded) {
      void stop();
      this.fail(jobId, "live_loop", `canlı test ${loop.count} kez reddedildi; tavan ${profile.limits.maxLoops.live}`);
      return { jobId, state: "NeedsAttention" };
    }
    void stop();

    // "Kaldı" işaretli senaryolar yorumla birlikte gider: insan listeyi
    // yoruma yeniden yazmak zorunda kalmasın, liste de yeniden üretilmesin.
    const failed = this.carryScenarioMarks(jobId, loop.count + 1);
    // DAST bulguları da yorumla birlikte gider: insan onları yeniden yazmasın.
    const dast = this.lastLiveDast(jobId);
    const dastText = dast ? renderDastFeedback(dast, true) : "";
    const feedback = [comment.trim(), failed, dastText].filter(Boolean).join("\n\n") || "(gerekçe verilmedi)";

    // Düzeltme safhası: planın sonuna eklenir, aynı onay makinesinden geçer.
    this.addFixPhase(jobId, `Canlı test düzeltmesi ${loop.count}`, feedback);

    this.move(jobId, "Developing", "starting", `canlı test reddedildi (${loop.count}/${profile.limits.maxLoops.live})`, "human");
    return { jobId, state: "Developing", developing: this.runDeveloping(jobId, `Canlı testte kusur bulundu. İnsanın geri bildirimi:\n${feedback}\nDüzelt; dosya sınırı yok, ama yalnız bu kusurlara dokun.`) };
  }

  /**
   * Red anında senaryo işaretlerini sonraki tura taşır; "kaldı"ları Developer
   * metni olarak döndürür (yoksa boş dize).
   *
   * Sonraki turda:
   * - gönderilen "kaldı" → `retest` (düzeltildi mi, insan bakacak; not kalır),
   * - "kaldı" ile AYNI alandaki "geçti" → `retest`: düzeltme o ekrana
   *   dokundu, eski "geçti" artık kanıt değil,
   * - diğer "geçti" ve "kararsız" olduğu gibi kalır (eski tur olarak görünür),
   * - hâlâ denenmemiş `retest` olduğu gibi kalır.
   * Alanı boş senaryolar alan eşleşmesine girmez: "Genel" her şeyi kapsardı.
   */
  private carryScenarioMarks(jobId: string, nextRound: number): string {
    const row = this.deps.db.select().from(schema.testScenarios)
      .where(and(eq(schema.testScenarios.jobId, jobId), eq(schema.testScenarios.status, "ready")))
      .orderBy(desc(schema.testScenarios.createdAt)).limit(1).all()[0];
    if (!row) return "";
    const parsed = TestScenariosDocumentSchema.safeParse(row.document);
    if (!parsed.success) return "";
    const scenarios = parsed.data.scenarios;
    const marks = parseScenarioMarks(row.marks);

    const failed = scenarios.flatMap((s, i) => (marks[scenarioKey(i)]?.state === "fail" ? [{ s, i, note: marks[scenarioKey(i)]?.note ?? "" }] : []));
    const areas = new Set(failed.map((f) => f.s.area).filter(Boolean));
    const at = isoNow();
    const next: ScenarioMarks = {};
    scenarios.forEach((s, i) => {
      const key = scenarioKey(i);
      const m = marks[key];
      if (!m) return;
      if (m.state === "fail") next[key] = { ...m, state: "retest", round: nextRound, at };
      else if (m.state === "pass" && s.area && areas.has(s.area)) next[key] = { ...m, state: "retest", note: "", round: nextRound, at };
      else next[key] = m;
    });
    this.deps.db.update(schema.testScenarios).set({ marks: next, round: nextRound }).where(eq(schema.testScenarios.id, row.id)).run();
    if (failed.length === 0) return "";

    this.notice(jobId, `${failed.length} "kaldı" senaryosu Developer'a gönderildi; sonraki turda yeniden denenecek.`);
    const body = failed.map(({ s, i, note }) => [
      `### ${i + 1}. ${s.title}${s.area ? ` (${s.area})` : ""}`,
      ...(s.account ? [`Hesap: ${s.account}`] : []),
      ...(s.preconditions.length ? ["Ön koşul:", ...s.preconditions.map((p) => `- ${p}`)] : []),
      "Adımlar:",
      ...s.steps.map((p, j) => `${j + 1}. ${p}`),
      `Beklenen: ${s.expected}`,
      ...(note ? [`İnsanın gözlemi: ${note}`] : []),
    ].join("\n")).join("\n\n");
    return scrubSecrets(`Canlı testte KALAN senaryolar (insan elle denedi, beklenen sonuç alınamadı):\n\n${body}`);
  }

  /**
   * Tek senaryonun canlı test işareti — iş durumuna dokunmaz.
   *
   * Yalnız LiveTest'te: işaret "porttan denedim" demek, uygulama ancak orada
   * ayakta. Anahtar sıradır (`scenarioKey`); belge değişmediği için sabit.
   */
  setScenarioMark(jobId: string, rowId: string, key: string, state: "pass" | "fail" | "unsure" | null, note: string): ScenarioMarks {
    const { job } = this.load(jobId);
    if (job.state !== "LiveTest") throw new EngineError("bad_state", `senaryo işareti yalnız canlı testte konur (${job.state})`);
    const row = this.deps.db.select().from(schema.testScenarios)
      .where(and(eq(schema.testScenarios.id, rowId), eq(schema.testScenarios.jobId, jobId))).all()[0];
    if (!row) throw new EngineError("not_found", `senaryo listesi bulunamadı: ${rowId}`);
    const parsed = TestScenariosDocumentSchema.safeParse(row.document);
    if (row.status !== "ready" || !parsed.success) throw new EngineError("bad_state", "senaryo listesi hazır değil");
    const index = /^s(\d+)$/.exec(key)?.[1];
    if (index === undefined || Number(index) >= parsed.data.scenarios.length) throw new EngineError("bad_input", `bilinmeyen senaryo: ${key}`);

    const marks = parseScenarioMarks(row.marks);
    if (state === null) delete marks[key];
    // İnsan agent işaretini benimseyince ya da değiştirince kaynak `human`
    // olur; agent'ın kanıt görüntüleri işaretle birlikte kalır.
    else marks[key] = { state, note: scrubSecrets(note.trim()), round: row.round, at: isoNow(), source: "human", evidence: marks[key]?.evidence ?? [] };
    this.deps.db.update(schema.testScenarios).set({ marks }).where(eq(schema.testScenarios.id, rowId)).run();
    return marks;
  }

  /**
   * Canlı ortamı elle yıkar — iş durumuna dokunmadan.
   *
   * Hazır olmayan ortam tanı için kasten ayakta bırakılıyor (`live_not_ready`);
   * insan loglara baktıktan sonra onu kapatmanın tek yolu işi iptal etmekti.
   * Koşan bir işte reddedilir: ortam o anda kuruluyor olabilir. LiveTest'te de
   * reddedilir: kapı ortama bağlı, onu kapatmanın yolu onay/red kararı.
   */
  async stopLive(jobId: string, actor = "human"): Promise<boolean> {
    const { job, profile } = this.load(jobId);
    if (this.busy.has(jobId)) throw new EngineError("busy", `iş koşuyor: ${jobId}`);
    if (job.state === "LiveTest") throw new EngineError("bad_state", "canlı test kapısı açık; ortamı onay/red kararı kapatır");
    if (!this.deps.live || !profile.live?.enabled) return false;
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "live.stop", subjectType: "job", subjectId: jobId,
    }).run();
    return this.deps.live.stop(jobId, job.worktreePath ?? ".", profile.live, "elle yıkıldı");
  }

  /** Canlı ortam süresini uzatır; ortam yoksa null. */
  extendLive(jobId: string, minutes: number): string | null {
    if (!this.deps.live) return null;
    const expiresAt = this.deps.live.extend(jobId, minutes);
    if (expiresAt) this.notice(jobId, `Canlı ortam süresi uzatıldı: ${expiresAt}`);
    return expiresAt;
  }

  // ── Canlı test senaryoları ───────────────────────────────────────────────

  /**
   * İnsanın düğmeyle istediği canlı test senaryoları — iş durumuna dokunmaz.
   *
   * Plan kapısında (kod yokken, yalnız plandan) ya da canlı test kapısında
   * (plan + değişen dosyalar) istenir. Kapı açık kalır; senaryo bir DANIŞMAN
   * çıktısıdır, üretilemezse iş NeedsAttention'a düşmez, yalnız satır `failed`
   * olur.
   *
   * `busy` işaretlenir: köprü konteyner başına TEK koşu kabul ediyor (ikinci
   * `run.start` "busy" ile düşer). Üretim sürerken bir onay Developer'ı
   * başlatsaydı o koşu köprüde reddedilir ve iş boşuna NeedsAttention'a
   * düşerdi; `decide` ve sohbet `busy`yi zaten reddediyor. Faz DEĞİŞMEZ —
   * `running` yazılsaydı yeniden başlatmada `reconcile` bekleyen kapısı olan
   * işi yarıda kalmış sayardı.
   */
  generateTestScenarios(jobId: string, note: string, actor = "human"): { id: string; work: Promise<void> } {
    const { job, profile } = this.load(jobId);
    const stage = job.state === "PlanReview" ? "plan" : job.state === "LiveTest" ? "live" : null;
    if (!stage) throw new EngineError("bad_state", `test senaryosu yalnız plan onayında ya da canlı testte istenir (${job.state})`);
    if (this.busy.has(jobId)) throw new EngineError("busy", "iş koşuyor; tur bitince deneyin");
    if (!job.worktreePath) throw new EngineError("bad_state", "işin worktree'si yok");
    const plan = stage === "plan"
      ? this.deps.db.select().from(schema.plans).where(eq(schema.plans.jobId, jobId)).orderBy(desc(schema.plans.version)).limit(1).all()[0]
      : this.approvedPlan(jobId);
    if (!plan) throw new EngineError("no_plan", `plan yok: ${jobId}`);
    const planDoc = PlanDocumentSchema.parse(plan.document);
    const worktreePath = job.worktreePath;
    const { id, cleanNote } = this.openScenarioRow(jobId, plan.id, stage, note, actor);

    this.busy.add(jobId);
    const work = (async () => {
      try {
        const live = stage === "live" ? this.pendingLivePayload(jobId) : null;
        await this.produceScenarios({ jobId, id, profile, job, planDoc, stage, worktreePath, note: cleanNote, liveUrl: live ? liveUrlLine(live) : null });
      } catch {
        // `produceScenarios` satırı `failed` yazdı ve akışa not düştü.
      } finally {
        this.busy.delete(jobId);
      }
    })();
    return { id, work };
  }

  /** Senaryo isteğinin satırı + denetim izi; üretim ayrı (`produceScenarios`). */
  private openScenarioRow(jobId: string, planId: string, stage: TestScenarioStage, note: string, actor: string): { id: string; cleanNote: string } {
    const id = newId();
    const cleanNote = scrubSecrets(note.trim());
    // Tur, canlı test kapısının turuyla aynı sayılır: işaretin "eski tur" olup
    // olmadığı bu sayıya göre gösterilir.
    const round = this.loopCount(jobId, "live") + 1;
    this.deps.db.insert(schema.testScenarios).values({ id, jobId, planId, stage, note: cleanNote, requestedBy: actor, round }).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "test_scenarios.request", subjectType: "job", subjectId: jobId, detail: { id, stage } as never,
    }).run();
    this.notice(jobId, `Canlı test senaryoları çıkarılıyor (${stage === "plan" ? "plandan" : "plan + değişikliklerden"}).`);
    return { id, cleanNote };
  }

  /**
   * `tester` turu: senaryo listesini üretir, satırı `ready` ya da `failed`
   * yazar. Düşerse fırlatır. Oturum kimliği döner — tarayıcı turu aynı
   * oturumda sürer, kodu ve diff'i yeniden okumaz (karar §41).
   */
  private async produceScenarios(input: {
    jobId: string; id: string; profile: ProjectProfile; job: typeof schema.jobs.$inferSelect; planDoc: PlanDocument;
    stage: TestScenarioStage; worktreePath: string; note: string; liveUrl: string | null;
  }): Promise<{ doc: TestScenariosDocument; sessionId: string | null }> {
    const { jobId, id, profile, job, planDoc, stage, worktreePath } = input;
    const finish = (set: { status: "ready" | "failed"; document?: TestScenariosDocument; error?: string }) =>
      this.deps.db.update(schema.testScenarios).set(set).where(eq(schema.testScenarios.id, id)).run();
    try {
      const rt = await this.acquireRuntime(jobId, profile);
      const baseRef = this.diffBase(jobId, profile);
      const files = stage === "live" ? await changedFiles(rt.executor, worktreePath, baseRef) : [];
      // Rol yapılandırması yoksa QA'nınkine düşülür: çoğu profilde `tester`
      // tanımlı olmayacak, ayrı bir alan zorunlu tutmak yeni bir onay turu demek.
      const role = profile.agents.roles["tester"] ?? profile.agents.roles["qa"];
      const accounts = profile.live?.browserTest.accounts ?? [];
      let attemptPrompt = renderTestScenariosPrompt(job, planDoc, stage, worktreePath, files, input.liveUrl, input.note, accounts);
      let resume: string | null = null;
      let doc: TestScenariosDocument | null = null;
      for (let attempt = 0; attempt < 2 && !doc; attempt++) {
        const run = await this.deps.runner.run({
          jobId, role: "tester", prompt: attemptPrompt,
          model: role?.model ?? "claude-opus-5-5", effort: role?.effort ?? "medium",
          maxTurns: role?.maxTurns ?? 40, maxBudgetUsd: role?.maxBudgetUsd ?? 3,
          cwd: worktreePath,
          allowedTools: ["Read", "Glob", "Grep", ...READ_ONLY_BASH],
          disallowedTools: [...READ_ONLY_DENY],
          systemPrompt: loadRolePrompt("tester"),
          // İlk deneme YENİ oturum: önceki istek eski plana bakmış olabilir.
          // Blok eksikse ikinci deneme aynı oturumdan (bağlamı yeniden kurmasın).
          resumeSessionId: resume,
          transport: rt.transport,
        });
        if (run.subtype === "error" || run.subtype === "quota") {
          throw new Error(`koşu bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
        }
        resume = run.sessionId ?? null;
        const raw = extractBlock(run.text, "TEST_SCENARIOS_JSON");
        const parsed = raw === null ? null : TestScenariosDocumentSchema.safeParse(raw);
        if (parsed?.success) doc = parsed.data;
        else attemptPrompt = `${raw === null ? "TEST_SCENARIOS_JSON bloğu bulunamadı" : "TEST_SCENARIOS_JSON şemaya uymuyor"}. Tam ve geçerli bir TEST_SCENARIOS_JSON bloğu üret.`;
      }
      if (!doc) throw new Error("iki denemede geçerli TEST_SCENARIOS_JSON üretilmedi");
      const clean = scrubScenarios(doc);
      finish({ status: "ready", document: clean });
      this.notice(jobId, `${doc.scenarios.length} canlı test senaryosu hazır.`);
      // İkinci göz (§42) arka planda; tarayıcı turunu (§41) bekletmez.
      this.startCritique({ jobId, profile, subject: "scenarios", subjectId: id, prompt: () => buildScenariosCritique(job, planDoc, clean) });
      return { doc: clean, sessionId: resume };
    } catch (err) {
      const message = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 1000);
      finish({ status: "failed", error: message });
      this.notice(jobId, `Canlı test senaryoları çıkarılamadı: ${message}`);
      throw err;
    }
  }

  // ── İkinci göz (§42) ─────────────────────────────────────────────────────

  /**
   * Planı ya da senaryo listesini yerel incelemenin sağlayıcısındaki modele
   * eleştirtir. DANIŞMANDIR: kapıyı bekletmez, iş durumuna ve `busy`ye
   * dokunmaz (köprüyü kullanmıyor — istek sunucudan gider), bulgu Planner'a
   * kendiliğinden gitmez. Hata fırlatmaz; sonuç `critiques` satırında.
   *
   * Profil bayrağı kapalıysa satır HİÇ yazılmaz — söylenecek bir şey yok.
   * Anahtar ya da model yoksa `skipped` + sebep: insan neden koşmadığını
   * görmeli. `force`: insan elle istedi, bayrak aranmaz.
   */
  private startCritique(input: {
    jobId: string; profile: ProjectProfile; subject: CritiqueSubject; subjectId: string;
    prompt: () => string; actor?: string; force?: boolean;
  }): string | null {
    const { jobId, profile, subject, subjectId } = input;
    const { critic, local } = profile.workflow.review;
    if (!input.force && !(subject === "plan" ? critic.plan : critic.scenarios)) return null;

    const id = newId();
    const model = critic.model ?? local.model ?? "";
    const actor = input.actor ?? "engine";
    const label = subject === "plan" ? "plan" : "senaryolar";
    this.deps.db.insert(schema.critiques).values({ id, jobId, subject, subjectId, model, requestedBy: actor }).run();
    this.deps.db.insert(schema.auditLog).values({
      id: newId(), actor, action: "critique.request", subjectType: "job", subjectId: jobId, detail: { id, subject, subjectId, model } as never,
    }).run();
    const publish = (status: CritiqueStatus) =>
      this.deps.hub.publish(jobId, { type: "critique.updated", critiqueId: id, subject, subjectId, status });
    const finish = (set: { status: Exclude<CritiqueStatus, "running">; document?: CritiqueDocument; error?: string; inputTokens?: number; outputTokens?: number }) => {
      this.deps.db.update(schema.critiques).set({ ...set, finishedAt: isoNow() }).where(eq(schema.critiques.id, id)).run();
      publish(set.status);
    };
    publish("running");

    const key = local.keyRef ? this.deps.reviewKey?.(local.keyRef) ?? null : null;
    const missing = !model ? "model tanımlı değil" : !local.keyRef ? "yerel incelemede keyRef yok" : !key ? `AHTAPOT_REVIEW_KEYS içinde '${local.keyRef}' bulunamadı` : null;
    const fallback = critic.fallback;
    if (missing && !fallback.enabled) {
      finish({ status: "skipped", error: missing });
      this.notice(jobId, `İkinci göz (${label}) koşmadı: ${missing}.`);
      return id;
    }

    void (async () => {
      try {
        const system = loadRolePrompt("critic");
        const user = input.prompt();
        let used = model;
        let res: Awaited<ReturnType<typeof completeText>> = missing
          ? { ok: false, kind: "transport", reason: missing }
          : await completeText({
            protocol: local.protocol, baseUrl: local.baseUrl, model, key: key!,
            system, user, maxOutputTokens: critic.maxOutputTokens, timeoutMs: critic.timeoutSeconds * 1000,
          });
        let costMicroUsd = 0;
        // Ayrıştırma hatası yedeği tetiklemez: sağlayıcı cevap verdi.
        if (!res.ok && res.kind === "transport" && fallback.enabled) {
          // Dış sağlayıcı düştü: Claude havuzuyla tekrar. Sebep notta kalır —
          // insan farklı modelin değil Claude'un okuduğunu bilmeli.
          this.notice(jobId, `İkinci göz (${label}) dış sağlayıcıda koşamadı (${res.reason}); ${fallback.model} ile deneniyor.`);
          const firstReason = res.reason;
          used = fallback.model;
          this.deps.db.update(schema.critiques).set({ model: used }).where(eq(schema.critiques.id, id)).run();
          const alt = await this.critiqueWithClaude(jobId, fallback, system, user);
          if (alt.ok) costMicroUsd = alt.costMicroUsd;
          res = alt.ok ? alt : { ok: false, kind: "transport", reason: `${firstReason} · yedek (${used}): ${alt.reason}` };
        }
        if (!res.ok) {
          finish({ status: "failed", error: res.reason });
          this.notice(jobId, `İkinci göz (${label}) koşamadı: ${res.reason}`);
          return;
        }
        const tokens = res.usage ? { inputTokens: res.usage.input, outputTokens: res.usage.output } : {};
        const parsed = parseCritique(res.text);
        // Tavana takılan yanıt, blok okunabilse bile tam sayılmaz: yarım bir
        // eleştiri "hazır" görünüp eksik bulguyu gizlemesin.
        if (!parsed.ok || res.truncated) {
          const cut = "yanıt token tavanında kesildi: maxOutputTokens";
          const reason = !parsed.ok ? (res.truncated ? `${parsed.reason} (${cut})` : parsed.reason) : `yanıt tamamlanmadı (${cut})`;
          finish({ status: "failed", error: reason, ...tokens });
          this.notice(jobId, `İkinci göz (${label}) sonucu okunamadı: ${reason}`);
          return;
        }
        finish({ status: "ready", document: parsed.doc, ...tokens });
        const n = parsed.doc.findings.length;
        const usage = res.usage ? ` · ${res.usage.input + res.usage.output} token` : costMicroUsd ? ` · $${(costMicroUsd / 1e6).toFixed(2)}` : "";
        this.notice(jobId, `İkinci göz (${used}, ${label}): ${n === 0 ? "bulgu yok" : `${n} bulgu`}${usage}.`);
      } catch (err) {
        const message = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 1000);
        try {
          finish({ status: "failed", error: message });
        } catch {
          // DB'ye yazılamadıysa açılıştaki reconcile `running`i kapatır.
        }
      }
    })();
    return id;
  }

  /**
   * İkinci gözün yedeği: Claude havuzunda araçsız yan koşu (mentor kalıbı,
   * §33). `nested`: asıl koşunun iptal kolunu ezmez, akışa agent.start/end
   * yazmaz. Kota imzasını runner `result`/hata nesnesinden okur (kural 6).
   * `completeText` sözleşmesine çevirir: FIRLATMAZ.
   */
  private async critiqueWithClaude(
    jobId: string, cfg: ProjectProfile["workflow"]["review"]["critic"]["fallback"], system: string, user: string,
  ): Promise<{ ok: true; text: string; usage: null; truncated: false; costMicroUsd: number } | { ok: false; reason: string }> {
    try {
      const run = await this.deps.runner.run({
        jobId,
        role: "critic",
        nested: true,
        // Kural 4: ham iş metni ve plan agent çıktısı taşır.
        prompt: scrubSecrets(user),
        model: cfg.model,
        effort: cfg.effort,
        maxTurns: 1,
        maxBudgetUsd: cfg.maxBudgetUsd,
        cwd: tmpdir(),
        systemPrompt: system,
        allowedTools: [],
        disallowedTools: MENTOR_DENY,
      });
      const text = run.text.trim();
      if (run.subtype !== "success" || !text) {
        return { ok: false, reason: run.errorMessage ?? `cevap üretmedi (${run.subtype})` };
      }
      return { ok: true, text, usage: null, truncated: false, costMicroUsd: run.costMicroUsd };
    } catch (err) {
      return { ok: false, reason: scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500) };
    }
  }

  /** Plan sürümünün eleştirisi — kapı açıldıktan SONRA çağrılır. */
  private critiquePlan(jobId: string, profile: ProjectProfile, job: { title: string; description: string }, planId: string, doc: PlanDocument): void {
    this.startCritique({ jobId, profile, subject: "plan", subjectId: planId, prompt: () => buildPlanCritique(job, doc) });
  }

  /**
   * İnsanın "yeniden incele"si — profil bayrağı aranmaz (insan istedi), ama
   * sağlayıcı yine yerel incelemeden; anahtar yoksa satır `skipped`.
   */
  requestCritique(jobId: string, subject: CritiqueSubject, subjectId: string, actor = "human"): { id: string } {
    const { job, profile } = this.load(jobId);
    if (subject === "plan") {
      const plan = this.deps.db.select().from(schema.plans)
        .where(and(eq(schema.plans.id, subjectId), eq(schema.plans.jobId, jobId))).all()[0];
      if (!plan) throw new EngineError("not_found", `plan bulunamadı: ${subjectId}`);
      const doc = PlanDocumentSchema.parse(plan.document);
      const id = this.startCritique({ jobId, profile, subject, subjectId, actor, force: true, prompt: () => buildPlanCritique(job, doc) });
      return { id: id! };
    }
    const row = this.deps.db.select().from(schema.testScenarios)
      .where(and(eq(schema.testScenarios.id, subjectId), eq(schema.testScenarios.jobId, jobId))).all()[0];
    if (!row) throw new EngineError("not_found", `senaryo listesi bulunamadı: ${subjectId}`);
    const scenarios = TestScenariosDocumentSchema.safeParse(row.document);
    if (row.status !== "ready" || !scenarios.success) throw new EngineError("bad_state", "senaryo listesi hazır değil");
    const plan = row.planId
      ? this.deps.db.select().from(schema.plans).where(eq(schema.plans.id, row.planId)).all()[0]
      : undefined;
    if (!plan) throw new EngineError("no_plan", "senaryo listesinin planı yok");
    const planDoc = PlanDocumentSchema.parse(plan.document);
    const id = this.startCritique({
      jobId, profile, subject, subjectId, actor, force: true,
      prompt: () => buildScenariosCritique(job, planDoc, scenarios.data),
    });
    return { id: id! };
  }

  /** Açık `live_test` kapısının yükü — senaryo "nereye gidilecek" desin diye. */
  private pendingLivePayload(jobId: string): LiveGatePayload | null {
    const gate = this.deps.db.select({ payload: schema.approvals.payload }).from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, "live_test"), eq(schema.approvals.status, "pending")))
      .all()[0];
    return (gate?.payload as LiveGatePayload | null | undefined) ?? null;
  }

  /** En son HAZIR senaryo listesi — QA case turu onları da görsün. */
  private latestTestScenarios(jobId: string): TestScenario[] {
    const row = this.deps.db.select({ document: schema.testScenarios.document }).from(schema.testScenarios)
      .where(and(eq(schema.testScenarios.jobId, jobId), eq(schema.testScenarios.status, "ready")))
      .orderBy(desc(schema.testScenarios.createdAt)).limit(1).all()[0];
    const parsed = TestScenariosDocumentSchema.safeParse(row?.document);
    return parsed.success ? parsed.data.scenarios : [];
  }

  // ── QA ───────────────────────────────────────────────────────────────────

  /**
   * QA'ya giriş. Onaylı case listesi yoksa önce liste üretilir ve kapı
   * açılır (profil `caseApproval` ise); varsa doğrudan testler yazılır ve
   * koşturulur (düzeltme döngüsünden dönüşte listeyi yeniden sormak gereksiz).
   */
  private async enterQa(jobId: string, profile: ProjectProfile, worktreePath: string | null): Promise<void> {
    const approvedCases = this.approvedQaCases(jobId);
    if (approvedCases.length > 0) {
      this.move(jobId, "QACases", "done", "case listesi zaten onaylı", "system");
      this.move(jobId, "QA", "starting", "testler yazılıyor", "system");
      // Açık bir QA oturumu varsa bu bir İLK giriş değil, "Test düzeltmesi N"
      // safhasından dönüş: `runQa` `feedback` boşken TÜM `renderQaPrompt`u
      // (plan + case listesi + "HEPSİNİ yaz") yeni bir tur olarak resumed
      // oturuma yeniden yolluyordu — QA zaten yazdığı testleri sanki ilk
      // kezmiş gibi baştan üstünden geçiyordu. Ölçüldü (2026-09-27): "testten
      // geri gittiğinde tekrar işliyor." Developer'ın kırmızı build'de
      // yaptığı gibi (`<feedback>`), yalnız DEĞİŞEN bilgi gönderilir.
      const resuming = this.roleSessionId(jobId, "qa") !== null;
      await this.runQa(jobId, profile, worktreePath,
        resuming ? "Üretim kodu güncellendi (bir önceki kırmızı test turundan sonra). Testleri baştan yazma; yalnız hâlâ kırmızı olanı incele — kod düzeldiyse test kendiliğinden yeşile döner, dönmüyorsa testi gözden geçir." : null,
        { reuse: true });
      return;
    }
    this.move(jobId, "QACases", "starting", "QA case listesi çıkarıyor", "system");
    await this.runQaCases(jobId, profile, worktreePath, null);
  }

  private approvedQaCases(jobId: string): QaCase[] {
    const approved = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, "qa_cases"), eq(schema.approvals.status, "approved"))).all();
    if (approved.length === 0) return [];
    return this.deps.db.select().from(schema.qaCases).where(eq(schema.qaCases.jobId, jobId)).all()
      .filter((c) => c.included)
      .map((c) => ({ id: c.id, title: c.title, rationale: c.rationale, origin: c.origin as "agent" | "human", included: c.included }));
  }

  /** QA salt okunur tur: plan + diff'e bakıp QA_CASES_JSON üretir; kapı açılır. */
  private async runQaCases(jobId: string, profile: ProjectProfile, worktreePath: string | null, feedback: string | null): Promise<void> {
    this.busy.add(jobId);
    try {
      if (!worktreePath) throw new Error("işin worktree'si yok");
      const { job } = this.load(jobId);
      const plan = PlanDocumentSchema.parse(this.approvedPlan(jobId).document);
      const role = profile.agents.roles["qa"];
      this.setPhase(jobId, "running", "QACases");
      const baseRef = this.diffBase(jobId, profile);
      // Worktree volume'de: diff okumak da agent'ı koşturmak da konteynerde.
      const rt = await this.acquireRuntime(jobId, profile);
      const graph = await this.prepareCodeGraph(jobId, profile, rt, "qa");
      const prompt = feedback
        ? `<feedback>\n${feedback}\n</feedback>\n\nListeyi güncelle ve tam bir QA_CASES_JSON bloğu üret.`
        : await renderQaCasesPrompt(rt.executor, job, plan, worktreePath, baseRef, this.latestTestScenarios(jobId)) + (graph?.note ?? "");

      let doc: { cases: QaCase[] } | null = null;
      let attemptPrompt = prompt;
      for (let attempt = 0; attempt < 2 && !doc; attempt++) {
        const run = await this.deps.runner.run({
          jobId, role: "qa", prompt: attemptPrompt,
          ...this.roleModel(jobId, profile, role, "claude-opus-5-5"),
          maxTurns: role?.maxTurns ?? 60, maxBudgetUsd: role?.maxBudgetUsd ?? 5,
          cwd: worktreePath,
          // WebSearch/WebFetch açık: Planner sürüm notu, kütüphane sınırı gibi
          // şeyleri kendi doğrulayabilsin (insan kararı, 2026-09-14). Takılma
          // riski runner'daki sessizlik gözcüsüyle karşılanıyor — ölçüldü:
          // dönmeyen bir WebSearch turu 11 dakika asılı bırakmıştı.
          allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", ...READ_ONLY_BASH, ...(graph?.tools ?? [])],
          disallowedTools: [...READ_ONLY_DENY],
          systemPrompt: `${loadRolePrompt("qa")}\n\n# Görev: 1 — case listesi`,
          resumeSessionId: this.roleSessionId(jobId, "qa"),
          // Worktree konteynerde: QA da orada koşmalı, host'ta o dizin yok.
          transport: rt.transport,
          ...(graph ? { codeGraph: graph.config } : {}),
        });
        if (run.sessionId) this.sessions.set(`${jobId}:qa`, run.sessionId);
        if (run.subtype === "error" || run.subtype === "quota") {
          this.fail(jobId, "qa_error", `QA koşusu bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
          return;
        }
        const raw = extractBlock(run.text, "QA_CASES_JSON");
        const parsed = raw === null ? null : QaCasesDocumentSchema.safeParse(raw);
        if (parsed?.success) doc = parsed.data;
        else {
          // Planner'la aynı: hangi alanın düştüğü söylenmezse QA aynı bloğu
          // yeniden yazar. Reddedilen blok da saklanır.
          const text = extractTextBlock(run.text, "QA_CASES_JSON");
          const issues = parsed
            ? parsed.error.issues.map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`)
            : text !== null ? ["blok geçerli JSON değil"] : [];
          if (text !== null) this.saveRejectedBlock(jobId, run.runId, "QA_CASES_JSON", text, issues, null);
          attemptPrompt = `${text === null ? "QA_CASES_JSON bloğu bulunamadı" : `QA_CASES_JSON şemaya uymuyor: ${issues.slice(0, 3).join(" · ")}`}. Tam ve geçerli bir QA_CASES_JSON bloğu üret.`;
        }
      }
      if (!doc) {
        this.fail(jobId, "no_qa_cases", "QA iki denemede geçerli QA_CASES_JSON üretmedi");
        return;
      }

      // Eski öneriler silinir (insan eklemeleri değil), yenileri yazılır.
      this.deps.db.delete(schema.qaCases).where(and(eq(schema.qaCases.jobId, jobId), eq(schema.qaCases.origin, "agent"))).run();
      for (const c of doc.cases) {
        this.deps.db.insert(schema.qaCases).values({ id: newId(), jobId, title: c.title, rationale: c.rationale, origin: "agent", included: true }).run();
      }
      const cases = this.deps.db.select().from(schema.qaCases).where(eq(schema.qaCases.jobId, jobId)).all();
      const payload = { cases: cases.map((c) => ({ id: c.id, title: c.title, rationale: c.rationale, origin: c.origin, included: c.included })) };

      if (!profile.test.caseApproval) {
        this.deps.db.insert(schema.approvals).values({ id: newId(), jobId, kind: "qa_cases", status: "approved", payload: payload as never, decidedAt: isoNow(), decidedBy: "profile" }).run();
        this.move(jobId, "QA", "starting", "case onayı profilde kapalı", "system");
        await this.runQa(jobId, profile, worktreePath, null);
        return;
      }
      const gateId = this.openApproval(jobId, "qa_cases", null, payload);
      this.setPhase(jobId, "waiting", "QACases");
      this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "qa_cases", payload });
    } catch (err) {
      this.fail(jobId, "qa_cases_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(jobId);
    }
  }

  /**
   * Case kapısı. Onay + `edits` (tam liste: `included` bayrakları, insan
   * eklemeleri `origin: human`) → QA testleri yazar. Red + yorum → QA listeyi
   * aynı oturumdan günceller.
   */
  private decideQaCases(jobId: string, profile: ProjectProfile, worktreePath: string | null, decision: "approve" | "reject", comment: string, edits: unknown): { jobId: string; state: JobState; developing?: Promise<void> } {
    if (decision === "reject") {
      this.setPhase(jobId, "starting", "QACases");
      return { jobId, state: "QACases", developing: this.runQaCases(jobId, profile, worktreePath, comment || "Liste reddedildi; gerekçe verilmedi.") };
    }
    if (edits !== undefined && edits !== null) {
      const parsed = QaCasesDocumentSchema.safeParse(edits);
      if (!parsed.success) throw new EngineError("bad_edits", `düzenlenen case listesi şemaya uymuyor: ${parsed.error.issues[0]?.message ?? ""}`);
      const existing = new Map(this.deps.db.select().from(schema.qaCases).where(eq(schema.qaCases.jobId, jobId)).all().map((c) => [c.id, c]));
      const seen = new Set<string>();
      for (const c of parsed.data.cases) {
        if (existing.has(c.id)) {
          seen.add(c.id);
          this.deps.db.update(schema.qaCases).set({ title: c.title, rationale: c.rationale, included: c.included }).where(eq(schema.qaCases.id, c.id)).run();
        } else {
          const id = newId();
          seen.add(id);
          this.deps.db.insert(schema.qaCases).values({ id, jobId, title: c.title, rationale: c.rationale, origin: "human", included: c.included }).run();
        }
      }
      // Listeden tamamen çıkarılanlar: dahil değil (silinmez, iz kalır).
      for (const [id] of existing) if (!seen.has(id)) this.deps.db.update(schema.qaCases).set({ included: false }).where(eq(schema.qaCases.id, id)).run();
    }
    if (this.approvedQaCases(jobId).length === 0) {
      // Hiç case seçilmedi: insan "bu iş için yeni test gerekmiyor" dedi.
      // Eskiden burada hata fırlatılıyordu — ama kapı `decide()`da çoktan
      // `approved` yazılmış oluyordu; iş bekleyen kapısı olmadan QACases'te
      // kilitli kalıyordu (yaşandı).
      this.move(jobId, "QA", "starting", "case seçilmedi; QA testleri atlandı", "human");
      this.notice(jobId, "Hiç QA case'i seçilmedi; test yazımı atlanıyor, PR adımına geçiliyor.");
      const payload: PrGatePayload = { results: [], baseline: [], handoff: HandoffSchema.parse({}), branch: this.load(jobId).job.branchName };
      return { jobId, ...this.enterPrReview(jobId, profile, payload, "QA case'i seçilmedi", "human") };
    }
    this.move(jobId, "QA", "starting", "case listesi onaylandı", "human");
    return { jobId, state: "QA", developing: this.runQa(jobId, profile, worktreePath, null) };
  }

  /**
   * QA testleri yazar (konteynerde, canlı kanal), sonra orkestratör ölçer:
   * baseline (stash) → tek koşu → önceden kırıklar ayrılır. Kırmızı →
   * düzeltme safhası + Developer (`maxLoops.qa`); yeşil → PRReview kapısı.
   *
   * Handoff'ta `blockers` varsa ikisinden ÖNCE engel kapısı açılır: kırmızının
   * sebebi testin kendisi değil, agent'ın çözemediği bir eksik olabilir.
   */
  private async runQa(
    jobId: string, profile: ProjectProfile, worktreePath: string | null, feedback: string | null,
    opts: { reuse?: boolean; retry?: RetryContext } = {},
  ): Promise<void> {
    this.busy.add(jobId);
    try {
      if (!worktreePath) throw new Error("işin worktree'si yok");
      const { job } = this.load(jobId);
      // Bu ağaçta testler zaten yazıldı ve yeşildi (karar §34, `qa.write`):
      // "Yeniden kaldır"/LiveTest'e yeniden açılış sonrası onay QA agent'ını
      // ve takımları aynı kod üzerinde baştan koşturuyordu (yaşandı). İnsanın
      // açıkça QA'yı seçtiği "Yeniden aç → QA" `reuse` vermez.
      if (opts.reuse) {
        const prev = await this.reusableQa(jobId, profile, worktreePath);
        if (prev) {
          const next = this.enterPrReview(jobId, profile, { ...prev, branch: job.branchName }, "testler bu kodda zaten yeşil", "agent");
          await next.developing;
          return;
        }
      }
      const cases = this.approvedQaCases(jobId);
      const plan = PlanDocumentSchema.parse(this.approvedPlan(jobId).document);
      const rt = await this.acquireRuntime(jobId, profile);
      const role = profile.agents.roles["qa"];
      this.setPhase(jobId, "running", "QA");

      const graph = await this.prepareCodeGraph(jobId, profile, rt, "qa");
      const fullPrompt = renderQaPrompt(job, profile, plan, cases) + await this.codeMapNote(rt) + (graph?.note ?? "");
      const feedbackPrompt = feedback ? `<feedback>\n${feedback}\n</feedback>\n\nDüzelt ve bitince tam bir HANDOFF_JSON bloğu yaz.` : null;
      // Yeniden deneme: Developer ile aynı ayrım — sebep her iki yola, son QA
      // devri ve reddedilen blok yalnız yeni oturuma.
      let shortRetry = "";
      let fullRetry = "";
      if (opts.retry) {
        const last = this.lastHandoff(jobId, (k) => k.startsWith("qa-"));
        shortRetry = `\n\n${renderRetryNote(opts.retry, { rejected: last?.rejected ?? null, full: false })}`;
        fullRetry = `\n\n${renderRetryNote(opts.retry, { rejected: last?.rejected ?? null, handoff: last?.handoff ?? null, full: true })}`;
        this.notice(jobId, `Yeniden deneme: önceki hata${opts.retry.errorCode ? ` (${opts.retry.errorCode})` : ""} QA'ya iletildi.`);
      }

      const channel = new LiveInputChannel();
      this.channels.set(jobId, channel);
      let run: RunResult;
      try {
        run = await this.deps.runner.run({
          jobId, role: "qa",
          prompt: feedbackPrompt ?? `${fullPrompt}${shortRetry}`,
          // Oturum kaybında yalnız `<feedback>` gören yeni oturum görevi bilmez.
          freshPrompt: feedbackPrompt ? `${fullPrompt}\n\n${feedbackPrompt}` : `${fullPrompt}${fullRetry}`,
          ...this.roleModel(jobId, profile, role, "claude-opus-5-5"),
          maxTurns: role?.maxTurns ?? 120, maxBudgetUsd: role?.maxBudgetUsd ?? 8,
          cwd: rt.agentCwd,
          permissionMode: "bypassPermissions",
          disallowedTools: ["Bash(git commit*)", "Bash(git push*)", "Bash(git checkout*)", "Bash(git clean*)", "Bash(git reset*)"],
          systemPrompt: `${loadRolePrompt("qa")}\n\n# Görev: 2 — testleri yazmak`,
          // QA yeni oturum: Developer'ın bias'ını taşımasın (plan kararı).
          resumeSessionId: this.roleSessionId(jobId, "qa"),
          ...this.askUserFor(jobId, profile),
          channel,
          transport: rt.transport,
          ...(graph ? { codeGraph: graph.config } : {}),
          onTurn: (turn) => this.onLiveTurn(jobId, profile, channel, turn.text, "HANDOFF_JSON"),
        });
      } finally {
        channel.close();
        if (this.channels.get(jobId) === channel) this.channels.delete(jobId);
      }
      if (run.sessionId) this.sessions.set(`${jobId}:qa`, run.sessionId);
      if (run.subtype === "error" || run.subtype === "quota") {
        this.fail(jobId, "qa_error", `QA koşusu bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
        return;
      }
      const baseRef = this.diffBase(jobId, profile);
      const handoff = await this.resolveHandoff(rt.executor, jobId, `qa-${newId()}`, run.text, worktreePath, baseRef);
      // Takımlardan ÖNCE: test koşusu ignore dışı çıktı bırakırsa ağaç
      // değişir; kayıt QA'nın yazdığı kodu anlatmalı.
      const qaTree = await this.worktreeTree(jobId, profile, worktreePath);

      // Ölçüm orkestratörde: baseline (stash) → gerçek koşu → fark.
      const suiteInput = { jobId, profile, workdir: rt.workdir, worktreePath, executor: rt.executor, artifactsDir: this.deps.artifactsDir };
      const baseline = profile.test.baseline ? await measureBaseline(this.deps.tests, suiteInput) : [];
      const raw = await this.deps.tests.runSuites({ ...suiteInput, kind: "run" });
      const results = diffAgainstBaseline(baseline, raw);
      const red = results.filter((r) => r.failed > 0);
      // Ortam kurulamadıysa (servis tanımsız, klon açılamadı) Developer'a
      // "testler kırmızı" demek yanlış: düzeltecek kod yok, döngü boşuna
      // yanar. İnsan profili ya da altyapıyı düzeltip yeniden dener.
      const unready = results.filter((r) => r.setupError);
      if (unready.length > 0) {
        this.fail(jobId, "qa_env", `test ortamı hazırlanamadı: ${unready.map((r) => `${r.suiteId} — ${r.setupError}`).join("; ")}`);
        return;
      }

      if (red.length > 0) {
        // ENGEL KAPISI, DÖNGÜDEN ÖNCE.
        //
        // QA "test doğru, ÜRETİM KODU eksik ve düzeltmek benim yetkimde değil"
        // diyebiliyor (bkz. `BlockerSchema`). Bu kırmızı bir test hatası
        // DEĞİL — yakalanmış gerçek bir eksik. Buna `addFixPhase` + Developer
        // demek yanlış iki şey yapar: (a) döngü sayacını yakar, (b) Developer'a
        // "testler kırmızı" diye gider ve o TESTİ düzeltip bulguyu siler.
        //
        // Karar insanın: engeli çözecek role gönder, ya da yok say.
        if (handoff.blockers.length > 0 && profile.workflow.blockedApproval) {
          this.openBlockedGate(jobId, "QA", "qa", handoff, results);
          return;
        }
        const loop = bumpLoop(this.deps.db, jobId, "qa", profile.limits.maxLoops.qa);
        if (loop.exceeded) {
          this.fail(jobId, "qa_loop", `testler ${loop.count} kez kırmızı; tavan ${profile.limits.maxLoops.qa}`);
          return;
        }
        this.addFixPhase(jobId, `Test düzeltmesi ${loop.count}`, `Kırık: ${red.map((r) => `${r.suiteId} (${r.failed})`).join(", ")}`);
        this.move(jobId, "Developing", "starting", `testler kırmızı (${loop.count}/${profile.limits.maxLoops.qa})`, "system");
        await this.runDeveloping(jobId, renderTestFeedback(results, handoff.blockers));
        return;
      }
      // TESTLER YEŞİL AMA ENGEL VAR: kapı yine açılır.
      //
      // Engel her zaman kırmızı testle gelmez — "plan X'i şart koşuyordu, ben
      // yazamadım, test de yazamadım" hâlinde takımlar yeşil görünür ve iş
      // sessizce PR'a giderdi. Eksik planlı iş PR'a gitmemeli.
      if (handoff.blockers.length > 0 && profile.workflow.blockedApproval) {
        this.openBlockedGate(jobId, "QA", "qa", handoff, results);
        return;
      }

      if (qaTree) await this.markStep(jobId, profile, worktreePath, "qa.write", "done", `${results.length} takım yeşil`, qaTree);
      const payload: PrGatePayload = { results, baseline, handoff, branch: job.branchName };
      const next = this.enterPrReview(jobId, profile, payload, "testler yeşil", "agent");
      // Onaysız profilde PR bu turda açılır; `busy` o iş bitene kadar sürmeli.
      await next.developing;
    } catch (err) {
      this.fail(jobId, "qa_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(jobId);
    }
  }

  /**
   * `qa.write` kaydı bugünkü ağaçla aynıysa son PR kapısının yükü (takım
   * sonuçları, handoff). Kayıt `stale` olsa da geçerli: ağaç hash'i kodun
   * kendisi, duruma girişin "kod değişmiş olabilir" şüphesini zaten çözer.
   */
  private async reusableQa(jobId: string, profile: ProjectProfile, worktreePath: string): Promise<PrGatePayload | null> {
    const entry = this.deps.db.select({ c: schema.jobs.stepChecklist }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.c?.["qa.write"];
    if (!entry?.sha) return null;
    const last = this.deps.db.select({ payload: schema.approvals.payload }).from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, "pr_open")))
      .orderBy(desc(schema.approvals.requestedAt)).limit(1).all()[0];
    const prev = (last?.payload ?? null) as Partial<PrGatePayload> | null;
    const handoff = HandoffSchema.safeParse(prev?.handoff ?? {});
    if (!prev?.results || prev.results.length === 0 || !handoff.success) return null;
    const tree = await this.worktreeTree(jobId, profile, worktreePath);
    if (tree !== entry.sha) return null;
    this.notice(jobId, `${STEP_CHECK_LABELS["qa.write"]}: bu kodda daha önce yazıldı ve yeşildi (${entry.at.slice(0, 16).replace("T", " ")} · ${entry.note}); QA yeniden koşulmuyor.`);
    return { results: prev.results, baseline: prev.baseline ?? [], handoff: handoff.data, branch: null };
  }

  /**
   * QA yeşil → PRReview. Profil PR onayı istiyorsa `pr_open` kapısı açılır;
   * istemiyorsa PR hemen açılır.
   *
   * Onaysız yolda da kapı satırı YAZILIR (sistem onaylı): `retry()` PR
   * adımını, `preexistingFailures()` önceden kırık testleri bu satırdan okuyor.
   */
  private enterPrReview(jobId: string, profile: ProjectProfile, payload: PrGatePayload, why: string, actor: "human" | "agent"): { state: JobState; developing?: Promise<void> } {
    const gateId = this.openApproval(jobId, "pr_open", null, payload);
    if (profile.git.pr.openApproval) {
      this.move(jobId, "PRReview", "waiting", `${why}; PR onayı bekliyor`, actor);
      this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "pr_open", payload });
      return { state: "PRReview" };
    }
    this.deps.db.update(schema.approvals)
      .set({ status: "approved", comment: "profil: PR onayı kapalı", decidedAt: isoNow(), decidedBy: "system" })
      .where(eq(schema.approvals.id, gateId)).run();
    this.move(jobId, "PRReview", "starting", `${why}; PR açılıyor`, actor);
    return this.approvePr(jobId, profile, "system");
  }

  /**
   * PR'ı açar ve incelemeye geçer. Açılamıyorsa (sağlayıcı/remote yok) iş
   * dal yerelde kalarak `Done` olur.
   */
  private approvePr(jobId: string, profile: ProjectProfile, actor: "human" | "system"): { state: JobState; developing?: Promise<void> } {
    const { job } = this.load(jobId);
    const primary = profile.workspace.repos.find((r) => r.primary);
    const remote = this.primaryRemote(job, profile);
    const repo = remote ? repoSlugFromRemote(remote) : null;
    if (profile.git.pr.provider === "none" || !this.deps.github || !repo || !job.worktreePath || !job.branchName) {
      // PR açılmaz: sağlayıcı yok, remote yok/GitHub değil ya da istemci verilmemiş. Dal yerelde kalır.
      // "remote yok" ile "GitHub değil" AYRI söylenir: ikisi farklı düzeltme
      // ister ve eskiden tek mesajdı (yanıltıcıydı — remote hiç yoktu).
      const why = profile.git.pr.provider === "none" ? "sağlayıcı yok"
        : !remote ? "remote tanımsız — profilde repo remote'u yok"
        : !repo ? `remote GitHub değil: ${scrubSecrets(remote)}`
        : !this.deps.github ? "istemci yok"
        : "worktree ya da dal yok";
      this.move(jobId, "Done", "done", "PR onaylandı; PR açılmadı", actor);
      this.notice(jobId, `İş tamamlandı. PR açılmadı (${why}); dal: ${job.branchName ?? "?"}`);
      // Temizlik `busy` altında ve çağırana verilir: araya giren `retry` ya
      // da "Yeniden aç" yeni konteyner kurup bu temizliğe sildirmesin.
      this.busy.add(jobId);
      const cleanup = this.releaseResources(jobId, "iş kapandı")
        .catch(() => undefined)
        .finally(() => this.busy.delete(jobId));
      return { state: "Done", developing: cleanup };
    }
    this.setPhase(jobId, "running", "PRReview");
    return { state: "PRReview", developing: this.openPrAndReview(jobId, profile, job.worktreePath, job.branchName, repo, primary!.defaultBranch) };
  }

  /** PR kapısı: onay → PR açılır, inceleme; red → düzeltme safhası. */
  private decidePr(jobId: string, profile: ProjectProfile, decision: "approve" | "reject", comment: string): { jobId: string; state: JobState; developing?: Promise<void> } {
    if (decision === "approve") return { jobId, ...this.approvePr(jobId, profile, "human") };
    this.addFixPhase(jobId, "PR incelemesi düzeltmesi", comment || "(gerekçe verilmedi)");
    this.move(jobId, "Developing", "starting", "PR reddedildi", "human");
    return { jobId, state: "Developing", developing: this.runDeveloping(jobId, `PR incelemesinde kusur bulundu. İnsan yorumu:\n${comment || "(gerekçe verilmedi)"}`) };
  }

  /**
   * Kapanış kapısı: CI yeşil, insan merge + temizlik kararını verdi.
   *
   * Red işi `Done` yapmaz ve hiçbir şeyi silmez — PR açık kalır, insan elle
   * ilgilenir. Onay merge eder ve profilin saydığı kadarını toplar.
   *
   * Merge geri alınamaz: bu yüzden `gh pr merge` agent'a kapalı ve yol yalnız
   * buradan, onaylı bir kapıdan geçiyor.
   */
  private decideMerge(jobId: string, profile: ProjectProfile, payload: MergeGatePayload, decision: "approve" | "reject", comment: string): { jobId: string; state: JobState; developing?: Promise<void> } {
    if (decision !== "approve") {
      // `Done` DEĞİL: PR birleşmedi, iş bitmedi. CIWatch'tan tek Done-dışı
      // çıkış kaçış durumu; `blocked_human` gibi insana bırakılır.
      this.notice(jobId, `Merge reddedildi${comment ? `: ${comment}` : ""}. PR açık: ${payload.prUrl}`);
      this.fail(jobId, "merge_rejected", `merge reddedildi; PR açık bırakıldı${comment ? ` — ${comment}` : ""}`);
      return { jobId, state: "NeedsAttention" };
    }
    this.setPhase(jobId, "running", "CIWatch");
    return { jobId, state: "CIWatch", developing: this.mergeAndCleanup(jobId, profile, payload) };
  }

  /**
   * Merge kapısında insanın seçtiği açık yorumlar için TEK düzeltme turu;
   * ardından CI yeniden izlenir ve kapı yeniden açılır.
   *
   * Tur bütçesi (`maxFixPushes`) burada uygulanmaz: tur insanın açık isteği,
   * "bir tur daha" kapısı gibi. Döngü riski yok — push sonrası botun yazdığı
   * yeni eşik-altı yorumlar kendiliğinden tur açmaz, yine kapıda listelenir.
   *
   * Seçim kapı açıldığı andaki listeden geliyor; arada çözülen başlık GitHub'dan
   * taze okunarak elenir.
   */
  private fixFromMergeGate(jobId: string, profile: ProjectProfile, payload: MergeGatePayload, ids: string[], comment: string): { jobId: string; state: JobState; developing: Promise<void> } {
    const gh = this.deps.github!;
    const pr = { repo: payload.repo, number: payload.prNumber, url: payload.prUrl };
    this.setPhase(jobId, "running", "CIWatch");
    this.busy.add(jobId);
    const run = async (): Promise<void> => {
      await this.ensureWorktree(jobId);
      const worktree = this.load(jobId).job.worktreePath ?? "";
      const wanted = new Set(ids);
      const selected = ((await gh.openReviewThreads?.(pr.repo, pr.number)) ?? []).filter((t) => wanted.has(t.id));
      if (selected.length === 0) {
        this.notice(jobId, "Seçilen yorumlar artık açık değil; CI yeniden izleniyor.");
      } else {
        this.notice(jobId, `Merge kapısından ${selected.length} yorum seçildi; DevOps düzeltiyor.`);
        const fixed = await this.runDevOps(jobId, profile, worktree, pr.repo, pr.number, 1, [], "", selected, { role: "devops", budget: 1, note: comment });
        if (!fixed.ok) return; // fail() çağrıldı
        if (fixed.verifyFailed) {
          this.notice(jobId, `Seçili yorumların düzeltmesi doğrulanamadı (${fixed.verifyFailed}); push edilmedi.`);
        } else if (!fixed.changed) {
          this.notice(jobId, "Seçili yorumlar kod değişikliği gerektirmedi; kapıya dönülüyor.");
        } else {
          const rt = await this.acquireRuntime(jobId, profile);
          await gh.push({ executor: rt.executor, worktree }, this.primaryRemote(this.load(jobId).job, profile)!, this.load(jobId).job.branchName ?? "");
          this.notice(jobId, `Seçili ${selected.length} yorumun düzeltmesi push'landı; CI yeniden izleniyor.`);
          // Push'tan hemen sonra ESKİ commit'in yeşil check'leri görünebilir;
          // beklemeden bakılırsa kapı düzeltme hiç koşmamış gibi yeniden açılır.
          await new Promise((r) => setTimeout(r, this.deps.ci?.intervalMs ?? 30_000));
        }
      }
      await this.watchCi(jobId, profile, worktree, pr.repo, pr.number, pr.url);
    };
    return {
      jobId, state: "CIWatch",
      developing: run()
        .catch((err: unknown) => this.fail(jobId, "pr_failed", err instanceof Error ? err.message : String(err)))
        .finally(() => this.busy.delete(jobId)),
    };
  }

  /**
   * Merge'ü kilitleyen, İNCELEME BOTUNA ait `CHANGES_REQUESTED`lar. Profil
   * kapalıysa, sağlayıcı yoksa ya da istemci desteklemiyorsa boş. Okuma hatası
   * akışı durdurmaz: boş döner, merge kilitliyse kendi hatasını verir.
   */
  private async botChangesRequested(profile: ProjectProfile, repo: string, prNumber: number): Promise<BlockingReview[]> {
    const review = profile.workflow.review;
    const gh = this.deps.github;
    if (!review.dismissBotChangesRequest || review.provider === "none" || !gh?.changesRequested || !gh.dismissReview) return [];
    try {
      return (await gh.changesRequested(repo, prNumber)).filter((r) => isReviewBot(r.author, review.provider));
    } catch {
      return [];
    }
  }

  /** Merge + profilin izin verdiği temizlik. Hata `NeedsAttention`a düşürür. */
  private async mergeAndCleanup(jobId: string, profile: ProjectProfile, payload: MergeGatePayload): Promise<void> {
    this.busy.add(jobId);
    try {
      const gh = this.deps.github!;
      const { job } = this.load(jobId);
      const cleanup = payload.cleanup;

      // Botun bayat change request'i merge'ü kilitliyor (bkz. profil alanı
      // `dismissBotChangesRequest`). Kapıdaki liste DEĞİL, şimdiki durum
      // okunur: kapı açıkken bot kendisi onaylamış ya da yeni istek bırakmış
      // olabilir. Dismiss düşerse merge yine denenir; kilit sürüyorsa hatayı
      // `gh pr merge` kendi mesajıyla verir.
      for (const r of await this.botChangesRequested(profile, payload.repo, payload.prNumber)) {
        try {
          await gh.dismissReview!(payload.repo, payload.prNumber, r.id,
            `${BRAND.displayName}: yorumlar ele alındı ve merge insan tarafından onaylandı.`);
          this.notice(jobId, `${r.author} değişiklik talebi kaldırıldı (dismiss).`);
        } catch (err) {
          this.notice(jobId, `${r.author} değişiklik talebi kaldırılamadı: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
        }
      }

      // Uzak dal silme merge ile AYNI çağrıda: `gh` sırayı kendi yönetir ve
      // ayrı bir `git push --delete` yarışa girebilir.
      await gh.merge(payload.repo, payload.prNumber, payload.method, cleanup.remoteBranch);
      this.deps.db.update(schema.pullRequests).set({ state: "merged" })
        .where(and(eq(schema.pullRequests.jobId, jobId), eq(schema.pullRequests.number, payload.prNumber))).run();
      this.notice(jobId, `PR #${payload.prNumber} birleştirildi (${payload.method})${cleanup.remoteBranch ? " · uzak dal silindi" : ""}.`);
      // Sonraki iş merge edilen değişikliği kaynakta bulsun. Dersler merge'den
      // SONRA toplanır: merge edilmemiş işin tuzağı kanıtlanmış değildir.
      await this.syncSourceWorkspace(jobId, profile, this.jobLessons(jobId, profile) ?? undefined);

      // Yerel dal/worktree: konteyner hâlâ ayakta olmalı, silme orada koşuyor.
      if (cleanup.localBranch) {
        const rt = await this.acquireRuntime(jobId, profile);
        const removed = await this.deps.worktrees.remove({
          jobId, profileSlug: profile.slug, executor: rt.executor, root: rt.workdirRoot,
        });
        this.notice(jobId, `Çalışma ağacı temizlendi (${removed.length} dizin); dal: ${job.branchName ?? "?"}`);
      }

      // Konteyner EN SON: yukarıdaki adımlar onu kullanıyor.
      if (cleanup.container) {
        await this.deps.live?.stop(jobId, job.worktreePath ?? ".", profile.live, "iş kapandı").catch(() => false);
        // Volume de gider: ağaç zaten merge edildi, saklamanın değeri kalmadı.
        await this.deps.runtime.release?.(jobId, { removeVolume: true });
        this.setupDone.delete(jobId);
        this.notice(jobId, "Konteyner, volume ve canlı ortam kaldırıldı.");
      }

      this.move(jobId, "Done", "done", "merge edildi", "human");
      this.notice(jobId, `İş tamamlandı. PR: ${payload.prUrl}`);
      // `cleanup.container` kapalıysa bile duran konteynerin değeri yok;
      // seçenek artık volume'ün (worktree) kalıp kalmayacağını söyler.
      // Hata `fail()`a düşmesin: iş merge edildi, Done geri alınmaz.
      if (!cleanup.container) await this.releaseResources(jobId, "iş kapandı").catch(() => undefined);
    } catch (err) {
      this.fail(jobId, "merge_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(jobId);
    }
  }

  /**
   * PR'ı aç (açıksa geç) ve doğrudan CI'ı izle — `retry()` yolu. İnceleme
   * turları `openPrAndReview`da; buradan yeniden koşmaz.
   */
  private async openPrAndWatch(jobId: string, profile: ProjectProfile, worktree: string, branch: string, repo: string, base: string): Promise<void> {
    this.busy.add(jobId);
    try {
      // Yeniden deneme, yerel/statik inceleme kapalıysa PR'ı buradan açıyor;
      // senkron atlanırsa PR bayat tabanla açılırdı.
      if (!(await this.syncBaseBeforePr(jobId, profile, worktree, branch, "CIWatch"))) return; // fail() çağrıldı
      const pr = await this.openPr(jobId, profile, worktree, branch, repo, base, "CIWatch");
      await this.watchCi(jobId, profile, worktree, pr.repo, pr.number, pr.url);
    } catch (err) {
      this.fail(jobId, "pr_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(jobId);
    }
  }

  /**
   * PRReview: PR'ı aç, profil inceleme sağlayıcısı söylüyorsa botun
   * incelemesini bekleyip yorumları çözdür, sonra CIWatch.
   *
   * İnceleme CI'dan ÖNCE: kırmızı CI turu botun yorumlarını beklemiyordu —
   * build dakikalar içinde düşüyor, bot o sırada hâlâ inceliyor ve DevOps'a
   * yalnız CI logları gidiyordu.
   */
  private async openPrAndReview(
    jobId: string, profile: ProjectProfile, worktree: string, branch: string, repo: string, base: string,
    opts: { securityDone?: boolean; securityNote?: string } = {},
  ): Promise<void> {
    this.busy.add(jobId);
    try {
      await this.revalidateSteps(jobId, profile, worktree);
      // İnceleme tabanından ÖNCE: merge `baseSha`yi çekilen uca taşır ve
      // statik analiz ile yerel inceleme PR'a gidecek son diff'i görür.
      if (!(await this.syncBaseBeforePr(jobId, profile, worktree, branch, "PRReview"))) return; // fail() çağrıldı
      await this.ensureDiffBase(jobId, profile, worktree);
      // Statik analiz OCR'dan ÖNCE: deterministik ve anahtarsız; OCR
      // temizlenmiş kodu görür. Aynı "PR yokken" kuralı. Sıra: güvenlik →
      // (kapı) → kod kalitesi; kalite güvenlik düzeltmelerini de denetler.
      //
      // Her adım bitince kontrol listesine yazılır; yeniden denemede (retry,
      // kapı kararı) tamamlanmış adım koşulmaz (karar §34). "Bir tur daha"
      // (`securityNote`) insanın açık isteğidir, kayda bakmaz.
      const st = profile.workflow.review.static;
      if (st.enabled && !this.hasPr(jobId)) {
        const diffBase = this.diffBase(jobId, profile);
        if (!opts.securityDone && (opts.securityNote !== undefined || !this.stepDone(jobId, "pr.security"))) {
          const sec = await this.staticReviewLoop(jobId, profile, worktree, diffBase, "security", opts.securityNote);
          if (!sec.ok) return; // fail() çağrıldı
          if (st.securityGate && (sec.remaining.length > 0 || sec.failed.length > 0)) {
            this.openSecurityGate(jobId, {
              worktree, branch, repo, base,
              rounds: this.loopCount(jobId, "static_review"),
              failed: sec.failed,
              threads: sec.remaining.slice(0, 50).map((t) => ({ path: t.path, line: t.line, severity: t.severity, author: t.author, body: t.body.slice(0, 500) })),
            });
            return;
          }
          // Koşamayan araç varsa kayıt yok: yeniden denemede yeniden denensin.
          if (sec.failed.length === 0) {
            await this.markStep(jobId, profile, worktree, "pr.security", "done", sec.remaining.length > 0 ? `${sec.remaining.length} bulgu kaldı` : "");
          }
        }
        if (!this.stepDone(jobId, "pr.quality")) {
          const quality = await this.staticReviewLoop(jobId, profile, worktree, diffBase, "quality");
          if (!quality.ok) return; // fail() çağrıldı
          if (quality.failed.length === 0) {
            await this.markStep(jobId, profile, worktree, "pr.quality", "done", quality.remaining.length > 0 ? `${quality.remaining.length} bulgu kaldı` : "");
          }
        }
      }
      // Yerel ön inceleme PR'DAN ÖNCE ve yalnız PR henüz yokken: açık PR'a
      // yapılan her düzeltme push'u botun kotasından bir inceleme daha yer.
      if (profile.workflow.review.local.enabled && !this.hasPr(jobId) && !this.stepDone(jobId, "pr.local_review")) {
        const local = await this.localReviewLoop(jobId, profile, worktree, this.diffBase(jobId, profile));
        if (local === false) return; // fail() çağrıldı
        if (local === "done") await this.markStep(jobId, profile, worktree, "pr.local_review", "done");
      }
      const pr = await this.openPr(jobId, profile, worktree, branch, repo, base, "PRReview");
      // Bot incelemesi geçtiyse yeniden beklenmez: sonradan gelen yorumları
      // CIWatch zaten DevOps'a veriyor.
      if (profile.workflow.review.provider !== "none" && !this.stepDone(jobId, "pr.bot_review")) {
        const proceed = await this.reviewLoop(jobId, profile, pr, profile.workflow.review.maxRounds, "");
        if (!proceed) return; // kapı açıldı ya da iş düştü
        await this.markStep(jobId, profile, worktree, "pr.bot_review", "done");
      }
      await this.enterCiWatch(jobId, profile, pr, "PR açıldı; CI izleniyor", "system");
    } catch (err) {
      this.fail(jobId, "pr_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(jobId);
    }
  }

  /** İşin açılmış bir PR'ı var mı — `openPr`ın "zaten açık" dalıyla aynı kayıt. */
  private hasPr(jobId: string): boolean {
    return this.deps.db.select({ id: schema.pullRequests.id }).from(schema.pullRequests)
      .where(eq(schema.pullRequests.jobId, jobId)).limit(1).all().length > 0;
  }

  private loopCount(jobId: string, key: string): number {
    return this.deps.db.select({ lc: schema.jobs.loopCounts }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.lc?.[key] ?? 0;
  }

  /**
   * Diff/inceleme için taban: işin dalının uzak `defaultBranch` ile ayrıştığı
   * commit. Kayıt yoksa (uzak çekilemedi) yerel `defaultBranch`e düşülür.
   */
  private diffBase(jobId: string, profile: ProjectProfile): string {
    const sha = this.deps.db.select({ b: schema.jobs.baseSha }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.b;
    return sha || (profile.workspace.repos.find((r) => r.primary)?.defaultBranch ?? "main");
  }

  /**
   * `baseSha` yoksa şimdi yazar: uzak `defaultBranch` çekilir, taban
   * `merge-base HEAD FETCH_HEAD` olur (GitHub'ın PR diff'iyle aynı nokta).
   *
   * Kayıt yalnız `pullBase` dalı bu kurulumda yarattığında yazılıyordu;
   * yeniden kurulan ağaçta ya da çekme o an düştüğünde iş yerel `main`e
   * düşüyordu. Worktree'nin gördüğü yerel `main` mirror'ın dalı ve HEAD'e
   * merge edilmiş uzak commit'leri bilmiyor.
   * YAŞANDI (2026-10-08): yerel inceleme bu yüzden 772 dosyayı "PR'ın
   * değişikliği" saydı.
   *
   * Çekme yine düşerse eski davranış (yerel dal) sürer; not düşülür.
   */
  private async ensureDiffBase(jobId: string, profile: ProjectProfile, worktree: string): Promise<void> {
    const recorded = this.deps.db.select({ b: schema.jobs.baseSha }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.b;
    if (recorded) return;
    const gh = this.deps.github;
    const remote = this.primaryRemote(this.load(jobId).job, profile);
    const base = profile.workspace.repos.find((r) => r.primary)?.defaultBranch;
    if (!gh?.fetch || !remote || !base) return;
    const rt = await this.acquireRuntime(jobId, profile);
    try {
      await gh.fetch({ executor: rt.executor, worktree }, remote, base);
    } catch (err) {
      this.notice(jobId, `UYARI: inceleme tabanı için uzak ${base} çekilemedi; yerel ${base} kullanılacak.\n${scrubSecrets(String(err)).slice(0, 500)}`);
      return;
    }
    const common = (await execGit(rt.executor, worktree, ["merge-base", "HEAD", "FETCH_HEAD"], { allowFailure: true })).trim();
    if (!/^[0-9a-f]{40}$/.test(common)) {
      this.notice(jobId, `UYARI: dalın uzak ${base} ile ortak atası bulunamadı; yerel ${base} kullanılacak.`);
      return;
    }
    this.deps.db.update(schema.jobs).set({ baseSha: common }).where(eq(schema.jobs.id, jobId)).run();
    this.notice(jobId, `İnceleme tabanı uzak ${base}'den yazıldı: ${common.slice(0, 12)}.`);
  }

  /** Düzeltme commit'i bütçesi (`workflow.maxFixPushes`) doldu mu? */
  private fixBudgetLeft(jobId: string, profile: ProjectProfile): boolean {
    return this.loopCount(jobId, "fix_push") < profile.workflow.maxFixPushes;
  }

  /**
   * İnceleme başlıklarını PR'ın kendi dosyalarına göre ayırır.
   *
   * PR'da olmayan bir dosyadaki yorum bu işin kusuru değil: düzeltmek başkasının
   * koduna dokunup PR'ı şişirir ve bot yeni yüzeye yeni yorum yazar (Northwind#184).
   * Dosya listesi alınamazsa ayrım yapılmaz — yanlışlıkla gerçek bir yorumu
   * susturmaktansa eski davranış.
   */
  private async splitByScope(jobId: string, profile: ProjectProfile, threads: ReviewThread[]): Promise<{ inScope: ReviewThread[]; outOfScope: ReviewThread[] }> {
    if (threads.length === 0) return { inScope: threads, outOfScope: [] };
    await this.ensureWorktree(jobId);
    const worktree = this.load(jobId).job.worktreePath;
    if (!worktree) return { inScope: threads, outOfScope: [] };
    const rt = await this.acquireRuntime(jobId, profile);
    const files = new Set(await changedFiles(rt.executor, worktree, this.diffBase(jobId, profile)));
    if (files.size === 0) return { inScope: threads, outOfScope: [] };
    const inScope: ReviewThread[] = [];
    const outOfScope: ReviewThread[] = [];
    for (const t of threads) (files.has(t.path.replace(/^\.\//, "")) ? inScope : outOfScope).push(t);
    if (outOfScope.length > 0) {
      this.notice(jobId, `${outOfScope.length} inceleme yorumu PR'ın dosyaları dışında; düzeltilmeyecek: ${[...new Set(outOfScope.map((t) => t.path))].slice(0, 5).join(", ")}`);
    }
    return { inScope, outOfScope };
  }

  /** `reviewLoop()`da gerekçeyle yanıtlanmış (kod değişikliği gerektirmeyen) başlık id'leri. */
  /**
   * PR öncesi zincirin bu adımı daha önce tamamlandı mı? Tamamlandıysa
   * akışa not düşülür ve adım atlanır (karar §34).
   *
   * YAŞANDI: temiz geçen adım iz bırakmıyordu; PR açılmadan (push, kota,
   * Developer düzeltmesi) düşen iş "yeniden dene" ile güvenlik, kalite ve
   * yerel incelemeyi aynı kod üzerinde BAŞTAN koşuyordu.
   */
  private stepDone(jobId: string, step: StepCheck): boolean {
    const row = this.deps.db.select({ c: schema.jobs.stepChecklist }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    const entry = row?.c?.[step];
    // `stale` buraya `revalidateSteps`ten sağ çıkamaz; yine de doğrulanmamış
    // kayıtla adım atlanmaz.
    if (!entry || entry.stale) return false;
    const how = entry.status === "waived" ? "insan kalanları kabul etti" : "tamamlandı";
    this.notice(jobId, `${STEP_CHECK_LABELS[step]}: daha önce ${how} (${entry.at.slice(0, 16).replace("T", " ")}${entry.note ? ` · ${entry.note}` : ""}); yeniden koşulmuyor.`);
    return true;
  }

  /**
   * `stale` kayıtları HEAD ile doğrular: kod en son tamamlanan adımın
   * gördüğüyle aynıysa (aynı commit, izlenen dosyalarda değişiklik yok)
   * kayıtlar geri gelir, değilse silinir. Zincirin kendi düzeltme commit'leri
   * en son adımın `sha`sında zaten var; karşılaştırma ona yapılır.
   *
   * `syncBaseBeforePr`dan ÖNCE çağrılır: çakışmasız `main` merge'ü HEAD'i
   * değiştirir ama kaydı geçersiz kılmaz (§32/§34).
   */
  private async revalidateSteps(jobId: string, profile: ProjectProfile, worktree: string): Promise<void> {
    const cur = this.deps.db.select({ c: schema.jobs.stepChecklist }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]?.c ?? {};
    const entries = PR_STEP_CHECKS.flatMap((k) => (cur[k] ? [cur[k]] : []));
    if (!entries.some((e) => e.stale)) return;
    const latest = entries.reduce((a, b) => (b.at > a.at ? b : a));
    const head = await this.cleanHead(jobId, profile, worktree);
    const keep = head !== null && latest.sha === head;
    const next: StepChecklist = { ...cur };
    for (const k of PR_STEP_CHECKS) {
      const e = cur[k];
      if (!e) continue;
      if (!keep) {
        delete next[k];
        continue;
      }
      const { stale: _stale, ...rest } = e;
      next[k] = rest;
    }
    this.deps.db.update(schema.jobs).set({ stepChecklist: next }).where(eq(schema.jobs.id, jobId)).run();
    this.notice(jobId, keep
      ? `Kod son PR öncesi denetimden beri değişmedi (${latest.sha.slice(0, 10)}); tamamlanmış adımlar korunuyor.`
      : `Kod son PR öncesi denetimden beri değişti (${latest.sha.slice(0, 10) || "?"} → ${head?.slice(0, 10) ?? "kaydedilmemiş değişiklik"}); denetimler yeniden koşacak.`);
  }

  /**
   * Çalışma ağacının TAMAMININ git tree'si: izlenen + izlenmeyen (ignore
   * dışı) dosyalar, commit'lenmiş olsun olmasın. QA'nın testleri PR açılana
   * kadar commit'lenmiyor (`commitPhase(999)`); HEAD onları görmez. Geçici
   * index gerçek index'in kopyası — stat önbelleği sayesinde büyük repoda
   * yalnız değişen dosyalar yeniden okunur. Okunamazsa `null`.
   */
  private async worktreeTree(jobId: string, profile: ProjectProfile, worktree: string): Promise<string | null> {
    try {
      const rt = await this.acquireRuntime(jobId, profile);
      const lines: string[] = [];
      const res = await rt.executor.run({
        // `mktemp -u`: boş dosya geçersiz index sayılır. Asıl index yoksa
        // kopya atlanır, git geçici index'i sıfırdan kurar.
        command: 'idx=$(mktemp -u) && { cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null; GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree; }; rc=$?; rm -f "$idx"; exit $rc',
        cwd: worktree, env: {}, timeoutMs: 300_000,
        onLine: (stream, line) => { if (stream === "stdout") lines.push(line.trim()); },
      });
      const tree = lines.filter(Boolean).pop() ?? "";
      return res.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
    } catch {
      return null;
    }
  }

  /**
   * Çalışma ağacı temizse HEAD, değilse ya da okunamazsa `null`. "Bu kod
   * daha önce denetlendi mi" sorusunun anahtarı: commit'lenmemiş bir
   * değişiklik HEAD'i değiştirmez ama denetlenmiş kodu değiştirir.
   * İzlenmeyen dosyalar da sayılır: "Yeniden aç → QA" sonrası QA'nın yeni
   * test dosyaları commit'lenmemiş durur; sayılmasaydı PR zinciri onları
   * SAST'tan geçirmeden eski kaydı geri yüklerdi. Ignore dışı build çıktısı
   * ağacı kirli gösterirse en kötü ihtimalle adım yeniden koşar.
   */
  private async cleanHead(jobId: string, profile: ProjectProfile, worktree: string): Promise<string | null> {
    try {
      const rt = await this.acquireRuntime(jobId, profile);
      const dirty = (await execGit(rt.executor, worktree, ["status", "--porcelain", "--untracked-files=normal"])).trim();
      if (dirty) return null;
      return (await execGit(rt.executor, worktree, ["rev-parse", "HEAD"])).trim().slice(0, 40) || null;
    } catch {
      return null;
    }
  }

  /** Verilen adımların kaydını siler; kod o adımların gördüğünden değişti. */
  private clearSteps(jobId: string, steps: readonly StepCheck[]): void {
    const row = this.deps.db.select({ c: schema.jobs.stepChecklist }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    const next = { ...(row?.c ?? {}) };
    for (const s of steps) delete next[s];
    this.deps.db.update(schema.jobs).set({ stepChecklist: next }).where(eq(schema.jobs.id, jobId)).run();
  }

  /**
   * Adımı kontrol listesine yazar. ASLA fırlatmaz: kayıt bir iyileştirme,
   * akışın ön şartı değil. Yazılamazsa en kötü ihtimalle adım yeniden
   * denemede yeniden koşar (eski davranış); iş düşmemeli ya da kapı
   * kararından sonra asılı kalmamalı.
   */
  private async markStep(jobId: string, profile: ProjectProfile, worktree: string, step: StepCheck, status: StepCheckEntry["status"], note = "", shaOverride?: string): Promise<void> {
    // HEAD okunamazsa kayıt yine yazılır; boş `sha` hiçbir şeyle eşleşmez,
    // adım yeniden koşar.
    let sha = shaOverride ?? "";
    if (shaOverride === undefined) {
      try {
        const rt = await this.acquireRuntime(jobId, profile);
        sha = (await execGit(rt.executor, worktree, ["rev-parse", "HEAD"])).trim().slice(0, 40);
      } catch {
        sha = "";
      }
    }
    try {
      const row = this.deps.db.select({ c: schema.jobs.stepChecklist }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
      const next = { ...(row?.c ?? {}), [step]: { status, at: isoNow(), sha, note } };
      this.deps.db.update(schema.jobs).set({ stepChecklist: next }).where(eq(schema.jobs.id, jobId)).run();
    } catch (err) {
      this.notice(jobId, `${STEP_CHECK_LABELS[step]}: kontrol listesine yazılamadı (${err instanceof Error ? err.message : String(err)}); yeniden denemede yeniden koşabilir.`);
    }
  }

  private reviewHandled(jobId: string): Set<string> {
    const row = this.deps.db.select({ h: schema.jobs.reviewHandledThreads }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
    return new Set(row?.h ?? []);
  }

  private markReviewHandled(jobId: string, ids: string[]): void {
    if (ids.length === 0) return;
    const current = this.reviewHandled(jobId);
    for (const id of ids) current.add(id);
    this.deps.db.update(schema.jobs).set({ reviewHandledThreads: [...current] }).where(eq(schema.jobs.id, jobId)).run();
  }

  /**
   * Yerel ön inceleme turları: OCR incele → bulguları Developer çözsün →
   * tekrar incele. Son düzeltmeden sonra yeniden incelenmez: doğrulamayı PR'daki
   * bot yapar.
   *
   * `false` yalnız iş düştüğünde (`fail()` çağrıldı). Bu bir ön filtre, akışı
   * durdurmaz — kapı açmaz. `not_run`: inceleme koşamadı (anahtar yok, araç
   * düştü); kontrol listesine yazılmaz, yeniden denemede yeniden denenir.
   * `done`: temiz, düzeltildi ya da tavan doldu — yeniden koşmaz (karar §34).
   *
   * Tur sayacı `loopCounts.local_review`da: yarıda kalan iş `retry()` ile
   * dönünce kaldığı turdan sürer, tavanı baştan harcamaz.
   */
  private async localReviewLoop(jobId: string, profile: ProjectProfile, worktree: string, base: string): Promise<"done" | "not_run" | false> {
    const cfg = profile.workflow.review.local;
    const key = cfg.keyRef ? (this.deps.reviewKey?.(cfg.keyRef) ?? null) : null;
    if (!key) {
      this.notice(jobId, `Yerel inceleme atlandı: "${cfg.keyRef ?? "?"}" anahtarı tanımlı değil (AHTAPOT_REVIEW_KEYS).`);
      return "not_run";
    }
    const rt = await this.acquireRuntime(jobId, profile);
    // QA testleri henüz commit'lenmedi (`openPr` yapıyordu); aralık incelemesi
    // yalnız commit'lenmişi görür. `openPr`daki ikinci çağrı boş geçer.
    await this.commitPhase(rt.executor, worktree, profile, 999, "QA testleri");
    for (let round = this.loopCount(jobId, "local_review") + 1; round <= cfg.maxRounds; round++) {
      this.setPhase(jobId, "running", "PRReview");
      // Aracın göreceği aralık (`--from base --to HEAD`) insana da gösterilir:
      // "527 dosya" bayat tabandan mı, aracın sayımından mı geliyor ayırt edilsin.
      // Taban bir SHA değil dal adıysa `baseSha` yazılamamış demektir — yerel
      // `main` bayatsa başkalarının commit'leri de bu listeye girer (§24).
      //
      // `execGit` değil: o stderr'i de toplar, diff düşerse `fatal:` satırı
      // dosya sanılırdı. Yalnız stdout, yalnız başarılı çıkışta.
      const git = async (args: string[]): Promise<string[] | null> => {
        const lines: string[] = [];
        const r = await rt.executor.run({
          command: `git ${args.map(shellQuote).join(" ")}`, cwd: worktree, env: {}, timeoutMs: 60_000,
          onLine: (stream, line) => { if (stream === "stdout") lines.push(line); },
        });
        return r.exitCode === 0 ? lines.map((l) => l.trim()).filter(Boolean) : null;
      };
      // Dal adı bir kez SHA'ya çözülür: sayım, inceleme ve not aynı commit'i göstersin.
      const isSha = /^[0-9a-f]{40}$/.test(base);
      const reviewBase = isSha ? base : ((await git(["rev-parse", "--verify", `${base}^{commit}`]))?.[0] ?? base);
      // Araca `--exclude` gidiyor; liste süzülmezse insan hariç tutulan
      // dosyaları "incelenecek" sanar ve sayım karşılaştırması da şişer.
      const diffed = await git(["diff", "--name-only", `${reviewBase}...HEAD`]);
      const files = diffed && diffed.filter((f) => !excludedByReview(f, cfg.exclude));
      const excludedCount = diffed && files ? diffed.length - files.length : 0;
      const scope = files?.length ?? null;
      const baseLabel = `${reviewBase.slice(0, 12)}${isSha ? "" : `; UYARI: uzak taban kaydı yok, yerel "${base}" kullanılıyor`}`;
      const scopeLine = files
        ? `İncelenecek ${files.length} dosya${excludedCount > 0 ? ` (${excludedCount} hariç tutuldu)` : ""}: ${files.slice(0, 40).join(", ") + (files.length > 40 ? ` … +${files.length - 40}` : "") || "(yok)"}`
        : `İncelenecek dosyalar hesaplanamadı (git diff ${reviewBase.slice(0, 12)}...HEAD düştü)`;
      if (scope !== null && cfg.maxFiles > 0 && scope > cfg.maxFiles) {
        this.notice(jobId, `Yerel inceleme atlandı: ${scope} dosya, sınır ${cfg.maxFiles} (review.local.maxFiles); PR açılıyor.\nTaban: ${baseLabel}\n${scopeLine}`);
        return "done";
      }
      this.notice(jobId, `Yerel inceleme ${round}/${cfg.maxRounds} koşuyor (${cfg.protocol} · ${cfg.model ?? "?"}).\nTaban: ${baseLabel}\n${scopeLine}`);
      const out = await runOcrReview({ exec: rt.executor, worktree, base: reviewBase, cfg, key });
      if (!out.ok) {
        this.notice(jobId, `Yerel inceleme koşamadı; PR açılıyor. Sebep: ${out.reason}`);
        return "not_run";
      }
      // `skipped`: araç hiçbir dosyayı incelemedi (ör. desteklenen dosya
      // değişmedi). Boş yorum listesi burada "temiz" DEĞİL.
      if (out.report.status === "skipped") {
        this.notice(jobId, `Yerel inceleme ${round}: atlandı, hiçbir dosya incelenmedi${out.report.message ? ` (${scrubSecrets(out.report.message).slice(0, 200)})` : ""}; PR açılıyor.`);
        return "done";
      }
      const s = out.report.summary;
      const stats = s ? ` · ${s.files_reviewed ?? "?"} dosya, ${s.total_tokens ?? "?"} token, ${s.elapsed ?? "?"}` : "";
      if (scope !== null && s?.files_reviewed !== undefined && s.files_reviewed > scope) {
        this.notice(jobId, `UYARI: araç ${s.files_reviewed} dosya saydı ama işin değişikliği ${scope} dosya; taban (${reviewBase.slice(0, 12)}) bayat olabilir ya da araç bağlam dosyalarını da sayıyor.`);
      }
      // Bazı alt ajanlar düştüyse rapor eksik: sessizce "temiz" sayılmasın.
      const partial = out.report.status === "partial" || out.report.status === "completed_with_errors" ? " (bazı dosyalar incelenemedi)" : "";
      // OCR bağlam için ilgili dosyaları da okuyor ve onlara da bulgu
      // yazıyor; aralık doğru olsa bile rapor PR'ın dosyalarıyla sınırlı
      // değil. Bot yorumlarındaki kapsam süzgeci (§24) burada yoktu:
      // başkasının koduna ait bulgular Developer'a gidiyor, tur yakıyordu.
      const all = ocrThreads(out.report);
      const { inScope: threads, outOfScope } = await this.splitByScope(jobId, profile, all);
      if (threads.length === 0) {
        this.notice(jobId, `Yerel inceleme ${round}: ${outOfScope.length > 0 ? "PR'ın dosyalarında " : ""}bulgu yok${partial}${stats}.`);
        return "done";
      }
      this.notice(jobId, `Yerel inceleme ${round}: ${threads.length} bulgu${outOfScope.length > 0 ? ` (+${outOfScope.length} PR dışı, yok sayıldı)` : ""}${partial}${stats}.`);
      if (!this.fixBudgetLeft(jobId, profile)) {
        this.notice(jobId, `Düzeltme bütçesi (${profile.workflow.maxFixPushes}) dolu; PR açılıyor, bulguları bot ve insan görecek.`);
        return "done";
      }
      bumpLoop(this.deps.db, jobId, "local_review", cfg.maxRounds);
      const fixed = await this.runDevOps(jobId, profile, worktree, "", 0, round, [], "", threads, { role: "developer", budget: cfg.maxRounds, source: "local" });
      if (!fixed.ok) return false;
      if (fixed.verifyFailed) {
        // PR'daki kod QA'da yeşildi; kırık düzeltme yerine onu açmak doğru.
        this.notice(jobId, `Yerel inceleme ${round}: düzeltme doğrulanamadı (${fixed.verifyFailed}); PR düzeltmesiz açılıyor, bulguları bot ve insan görecek.`);
        return "done";
      }
      if (!fixed.changed) {
        this.notice(jobId, `Yerel inceleme ${round}: kod değişikliği gerekmedi; PR açılıyor.`);
        return "done";
      }
    }
    this.notice(jobId, `Yerel inceleme tavanı (${cfg.maxRounds} tur) doldu; PR açılıyor, doğrulamayı bot yapacak.`);
    return "done";
  }

  /**
   * Otomatik düzelticilerin (`step.fix`) bıraktığı değişikliği kapsamlar,
   * doğrular ve ancak yeşilse kendi commit'ine alır.
   *
   * Düzeltici `$AHTAPOT_CHANGED`a uymak zorunda değil ve `commitPhase`
   * `git add -A` yapar: PR'ın dosyaları dışına dokunan bir düzeltici
   * başkasının kodunu `style` commit'ine katardı (Northwind#184'teki kapsam
   * sorunu). Doğrulanmadan atılan commit de, derleme kırsa bile HEAD'de
   * kalırdı — Developer düzeltmesi için geçerli kural (`verifyFix`) burada da.
   */
  private async settleAutoFix(
    jobId: string,
    profile: ProjectProfile,
    rt: { executor: CommandExecutor; workdir: string },
    worktree: string,
    base: string,
    scope: ReadonlySet<string>,
  ): Promise<void> {
    const status = await execGit(rt.executor, worktree, ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"]);
    const dirty = status.split("\n").filter((l) => l.trim()).map((l) => ({
      untracked: l.startsWith("??"),
      path: (l.slice(3).includes(" -> ") ? l.slice(3).split(" -> ")[1]! : l.slice(3)).trim(),
    }));
    if (dirty.length === 0) return;

    const discard = async (files: { untracked: boolean; path: string }[]) => {
      const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
      const untracked = files.filter((f) => f.untracked).map((f) => f.path);
      if (tracked.length > 0) await execGit(rt.executor, worktree, ["checkout", "-q", "--", ...tracked]);
      if (untracked.length > 0) await execGit(rt.executor, worktree, ["clean", "-fq", "--", ...untracked]);
    };

    // Kapsam listesi alınamadıysa süzülmez — `splitByScope` ile aynı ilke.
    const outside = scope.size === 0 ? [] : dirty.filter((f) => !scope.has(f.path));
    if (outside.length > 0) {
      await discard(outside);
      this.notice(jobId, `Statik analiz: otomatik düzeltici PR dışındaki ${outside.length} dosyaya dokundu, geri alındı: ${outside.slice(0, 5).map((f) => f.path).join(", ")}`);
    }
    const inside = dirty.filter((f) => !outside.includes(f));
    if (inside.length === 0) return;

    let verdict: Awaited<ReturnType<JobEngine["verifyFix"]>>;
    try {
      verdict = await this.verifyFix(jobId, profile, rt, worktree, base, {});
    } catch (err) {
      verdict = { kind: "red", summary: `doğrulama düştü: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, feedback: "" };
    }
    if (verdict.kind !== "ok") {
      await discard(inside);
      const why = verdict.kind === "forbidden" ? verdict.message : verdict.summary;
      this.notice(jobId, `Statik analiz: otomatik düzeltme doğrulanamadı (${why}); geri alındı, commit'lenmedi.`);
      return;
    }
    await this.commitPhase(rt.executor, worktree, profile, 997, "statik analiz otomatik düzeltme");
  }

  /**
   * Yerel statik analiz turları, kategori başına: profildeki açık adımları
   * koş → kapsamdaki bulguları Developer çözsün → yeniden koş.
   *
   * `security` önce, `quality` (okunabilirlik, MegaLinter) sonra çağrılır:
   * güvenlik düzeltmesinin dokunduğu dosyalar da kalite denetiminden geçer.
   *
   * OCR turundan farkı: son düzeltmeden sonra bir kez daha koşar (ucuz,
   * deterministik) ve kalanı döner — güvenlik kapısı ona bakar. `ok:false`
   * yalnız iş düştüğünde. `note` verilirse (kapıda "bir tur daha") tavanın
   * üstünde tek bir tur daha koşar ve not Developer'a gider.
   *
   * Tur sayacı `loopCounts.static_review` / `quality_review`: `retry()`
   * kaldığı turdan sürer.
   */
  private async staticReviewLoop(
    jobId: string,
    profile: ProjectProfile,
    worktree: string,
    base: string,
    category: "security" | "quality",
    note?: string,
  ): Promise<{ ok: boolean; remaining: ReviewThread[]; failed: string[] }> {
    const cfg = profile.workflow.review.static;
    const label = category === "security" ? "Güvenlik (SAST)" : "Kod kalitesi";
    const key = category === "security" ? "static_review" : "quality_review";
    const own = cfg.steps.filter((s) => s.category === category);
    const steps = own.filter((s) => s.enabled);
    const off = own.filter((s) => !s.enabled).map((s) => s.id);
    if (off.length > 0) this.notice(jobId, `${label}: ${off.join(", ")} profilde kapalı, atlanıyor.`);
    if (steps.length === 0) return { ok: true, remaining: [], failed: [] };
    const rt = await this.acquireRuntime(jobId, profile);
    // Araç kurulumu (`exec.setup`, ör. opengrep) ve restore burada; sunucu
    // yeniden başladıysa konteyner yenidir.
    await this.ensureSetup(jobId, profile, rt);
    // Aralık incelemesi yalnız commit'lenmişi görür; QA testleri henüz
    // commit'lenmedi (`localReviewLoop` ile aynı sebep).
    await this.commitPhase(rt.executor, worktree, profile, 999, "QA testleri");
    const roots = [...new Set([worktree, rt.workdir])];
    // İmajlı adımlar iş konteynerinin kullanıcısıyla koşar: root'un yazdığı
    // dosyayı iş konteyneri (node) commit'leyemez.
    const user = steps.some((s) => s.image) ? await this.containerUser(rt.executor, worktree) : "";
    const imageFor = (step: StaticStep) => step.image
      ? {
        exec: imageExecutor({
          docker: defaultDockerRun, image: step.image, volume: jobVolumeName(jobId), root: rt.workdirRoot, user,
          name: `${BRAND.slug}-static-${jobId}-${step.id}`,
          log: (line) => this.deps.hub.publish(jobId, { type: "build.log", stream: "stdout", line: scrubSecrets(line) }),
        }),
        reportDir: `${rt.workdirRoot}/.ahtapot-static`,
      }
      : undefined;
    const cap = note !== undefined ? this.loopCount(jobId, key) + 1 : cfg.maxRounds;

    for (let round = this.loopCount(jobId, key) + 1; ; round++) {
      this.setPhase(jobId, "running", "PRReview");
      const last = round > cap;
      const tag = last ? "son denetim" : `${round}/${cap}`;
      this.notice(jobId, `${label} ${tag} koşuyor: ${steps.map((s) => s.id).join(", ")}.`);
      const changed = await changedFiles(rt.executor, worktree, base);
      const lines = await changedLines(rt.executor, worktree, base);
      const changedSet = new Set(changed);
      const threads: ReviewThread[] = [];
      const failed: string[] = [];
      const summary: string[] = [];
      for (const step of steps) {
        const image = imageFor(step);
        const out = await runStaticStep({
          exec: rt.executor, worktree, step, forbiddenFlags: profile.build.forbiddenFlags, changed,
          ...(image ? { image } : {}),
        });
        if (!out.ok) {
          this.notice(jobId, `${label} · ${step.id}: koşamadı. Sebep: ${scrubSecrets(out.reason)}`);
          summary.push(`${step.id}: koşamadı`);
          failed.push(step.id);
          continue;
        }
        if (out.fixNote) this.notice(jobId, `${label} · ${step.id}: ${out.fixNote}`);
        const all = staticThreads(step.id, out.findings, roots);
        // Kapsam: `lines` yalnız diff'in eklediği satırlar; satır farkı
        // alınamadıysa dosya düzeyine düşülür — gerçek bulguyu susturmaktansa.
        const inScope = all.filter((t) => {
          if (step.scope === "lines" && lines) return t.line !== null && (lines.get(t.path)?.has(t.line) ?? false);
          return changedSet.size === 0 || changedSet.has(t.path);
        });
        summary.push(`${step.id}: ${inScope.length}${all.length > inScope.length ? ` (+${all.length - inScope.length} kapsam dışı)` : ""}`);
        threads.push(...inScope);
      }
      await this.settleAutoFix(jobId, profile, rt, worktree, base, changedSet);

      if (threads.length === 0) {
        this.notice(jobId, `${label} ${tag}: bulgu yok (${summary.join(" · ")}).`);
        return { ok: true, remaining: [], failed };
      }
      this.notice(jobId, `${label} ${tag}: ${threads.length} bulgu (${summary.join(" · ")}).`);
      const stop = (msg: string) => {
        this.notice(jobId, msg);
        return { ok: true, remaining: threads, failed };
      };
      if (last) return stop(`${label} tavanı (${cap} tur) doldu; ${threads.length} bulgu kaldı.`);
      if (!this.fixBudgetLeft(jobId, profile)) return stop(`Düzeltme bütçesi (${profile.workflow.maxFixPushes}) dolu; ${label.toLowerCase()} bulguları düzeltilmedi.`);
      bumpLoop(this.deps.db, jobId, key, Number.MAX_SAFE_INTEGER);
      const fixed = await this.runDevOps(jobId, profile, worktree, "", 0, round, [], "", threads, {
        role: "developer", budget: cap, source: "static",
        ...(note && round === cap ? { note } : {}),
      });
      if (!fixed.ok) return { ok: false, remaining: threads, failed };
      if (fixed.verifyFailed) return stop(`${label} ${round}: düzeltme doğrulanamadı (${fixed.verifyFailed}); düzeltmesiz devam.`);
      if (!fixed.changed) return stop(`${label} ${round}: Developer kod değişikliği yapmadı (bulgular gerekçeyle reddedildi).`);
    }
  }

  /** İş konteynerinin `uid:gid`i — imajlı adımlar aynı kullanıcıyla koşsun. */
  private async containerUser(exec: CommandExecutor, cwd: string): Promise<string> {
    const out: string[] = [];
    await exec.run({ command: "echo \"$(id -u):$(id -g)\"", cwd, env: {}, timeoutMs: 30_000, onLine: (s, l) => { if (s === "stdout") out.push(l.trim()); } });
    return out.find((l) => /^\d+:\d+$/.test(l)) ?? "1000:1000";
  }

  /**
   * Güvenlik turları bitti, bulgu kaldı ya da bir güvenlik aracı koşamadı:
   * PR'a geçmeden insana sor (`workflow.review.static.securityGate`).
   */
  private openSecurityGate(jobId: string, payload: SecurityGatePayload): void {
    const gateId = this.openApproval(jobId, "security", null, payload);
    this.setPhase(jobId, "waiting", "PRReview");
    this.notice(jobId, `Güvenlik kapısı: ${payload.threads.length} bulgu kaldı${payload.failed.length > 0 ? `, koşamayan: ${payload.failed.join(", ")}` : ""}; insan kararı bekleniyor.`);
    this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "security", payload });
  }

  /**
   * Onay → bir güvenlik turu daha (yorum Developer'a not). Red → kalan
   * güvenlik bulgularıyla devam: kalite turu, OCR, PR.
   */
  private decideSecurity(jobId: string, profile: ProjectProfile, payload: SecurityGatePayload, decision: "approve" | "reject", comment: string): { jobId: string; state: JobState; developing: Promise<void> } {
    const { worktree, branch, repo, base } = payload;
    this.setPhase(jobId, "running", "PRReview");
    if (decision === "approve") {
      return { jobId, state: "PRReview", developing: this.openPrAndReview(jobId, profile, worktree, branch, repo, base, { securityNote: comment.trim() }) };
    }
    this.notice(jobId, `Güvenlik: ${payload.threads.length} bulgu insan kararıyla açık bırakıldı${comment.trim() ? ` (${scrubSecrets(comment.trim()).slice(0, 200)})` : ""}.`);
    // Karar kayda geçer: yeniden denemede güvenlik turu ve kapı yeniden
    // açılmasın — insan bu bulguları zaten gördü ve kabul etti.
    const waive = this.markStep(jobId, profile, worktree, "pr.security", "waived", `${payload.threads.length} bulgu açık bırakıldı`);
    return { jobId, state: "PRReview", developing: waive.then(() => this.openPrAndReview(jobId, profile, worktree, branch, repo, base, { securityDone: true })) };
  }

  private async enterCiWatch(jobId: string, profile: ProjectProfile, pr: { repo: string; number: number; url: string }, reason: string, actor: "human" | "system"): Promise<void> {
    this.move(jobId, "CIWatch", "starting", reason, actor);
    this.setPhase(jobId, "running", "CIWatch");
    await this.watchCi(jobId, profile, this.load(jobId).job.worktreePath ?? "", pr.repo, pr.number, pr.url);
  }

  /**
   * İnceleme turları: botu bekle → eşiği aşan açık yorumları Developer'a
   * çözdür → push → yeniden bekle.
   *
   * `true` CIWatch'a geçilebilir demek; `false` kapı açıldı ya da iş düştü.
   * `budget` bu girişte izin verilen tur sayısı ("bir tur daha" kapısı 1 verir).
   *
   * Ele alınmış başlık bir daha verilmez: Developer bir yorumu gerekçeyle
   * reddedebilir ve başlık açık kalır — aynı yorumu her turda yeniden koşmak
   * tavanı boşa yakardı. Set DB'de kalıcı (`reviewHandledThreads`): GitHub
   * gerekçeli reddi görmüyor (yorum resolve edilmiyor), o yüzden bu bilgi
   * yalnız bellekte kalsaydı "bir tur daha" onayının açtığı YENİ
   * `reviewLoop()` çağrısı aynı başlığı yeniden Developer'a gönderirdi.
   */
  private async reviewLoop(jobId: string, profile: ProjectProfile, pr: { repo: string; number: number; url: string }, budget: number, note: string, enforceFixBudget = true): Promise<boolean> {
    const gh = this.deps.github!;
    const minRank = severityRank(profile.workflow.review.minSeverity);
    const handled = this.reviewHandled(jobId);
    let pushedSha: string | undefined;
    for (let round = 1; ; round++) {
      const reviewed = await this.waitForReview(jobId, profile, pr, pushedSha);
      const { inScope: actionable } = await this.splitByScope(jobId, profile,
        ((await gh.openReviewThreads?.(pr.repo, pr.number)) ?? [])
          .filter((t) => severityRank(t.severity) >= minRank && !handled.has(t.id)));
      if (actionable.length === 0) {
        // Süre dolduysa sebebi `waitForReview` zaten yazdı.
        if (reviewed) this.notice(jobId, "İncelemede ele alınacak açık yorum yok.");
        return true;
      }
      if (round > budget || (enforceFixBudget && !this.fixBudgetLeft(jobId, profile))) {
        const payload: ReviewRoundPayload = {
          prNumber: pr.number, prUrl: pr.url, repo: pr.repo, rounds: round - 1,
          threads: actionable.map((t) => ({ path: t.path, line: t.line, severity: t.severity, author: t.author })),
        };
        const gateId = this.openApproval(jobId, "review_round", null, payload);
        this.setPhase(jobId, "waiting", "PRReview");
        this.notice(jobId, `${round - 1} turdan sonra ${actionable.length} inceleme yorumu hâlâ açık; karar bekleniyor.`);
        this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "review_round", payload });
        return false;
      }
      await this.ensureWorktree(jobId);
      const worktree = this.load(jobId).job.worktreePath ?? "";
      const fixed = await this.runDevOps(jobId, profile, worktree, pr.repo, pr.number, round, [], "", actionable, { role: "developer", budget, note });
      if (!fixed.ok) return false; // fail() çağrıldı
      if (fixed.verifyFailed) {
        // Yorumlar ele alınmış SAYILMAZ: düzeltme push'lanmadı, açık kaldılar.
        // Yeniden denemek aynı kırmızıyı üretir; karar insanın ("bir tur daha"
        // ya da "CI'a geç") — tavan kapısıyla aynı yük.
        const payload: ReviewRoundPayload = {
          prNumber: pr.number, prUrl: pr.url, repo: pr.repo, rounds: round,
          threads: actionable.map((t) => ({ path: t.path, line: t.line, severity: t.severity, author: t.author })),
        };
        const gateId = this.openApproval(jobId, "review_round", null, payload);
        this.setPhase(jobId, "waiting", "PRReview");
        this.notice(jobId, `İnceleme turu ${round}: düzeltme doğrulanamadı (${fixed.verifyFailed}); ${actionable.length} yorum açık, karar bekleniyor.`);
        this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "review_round", payload });
        return false;
      }
      this.markReviewHandled(jobId, actionable.map((t) => t.id));
      for (const t of actionable) handled.add(t.id);
      if (!fixed.changed) {
        // Yorumlar kod değişikliği gerektirmedi (gerekçeyle cevaplandı).
        // Yeni push yok → bot yeniden incelemeyecek; beklemek boşa.
        this.notice(jobId, `İnceleme turu ${round}: kod değişikliği gerekmedi; CI'a geçiliyor.`);
        return true;
      }
      const rt = await this.acquireRuntime(jobId, profile);
      await gh.push({ executor: rt.executor, worktree }, this.primaryRemote(this.load(jobId).job, profile)!, this.load(jobId).job.branchName ?? "");
      pushedSha = (await execGit(rt.executor, worktree, ["rev-parse", "HEAD"])).trim();
      this.notice(jobId, `İnceleme düzeltmesi ${round} push'landı (${actionable.length} yorum); yeniden inceleme bekleniyor.`);
      note = ""; // insan notu yalnız ilk tura
    }
  }

  /**
   * Botun head commit'i incelemesini bekler.
   *
   * Üç tuzak ölçüldü (Northwind#153, 2026-09-25):
   * - Push'tan sonra GitHub PR head'ini birkaç saniye geç çeviriyor; o arada
   *   ESKİ commit'in yeşil check'i görünüyor ve motor 2 sn'de "inceleme
   *   bitti" diyordu. `expectedSha` verilirse head ona dönene kadar beklenir.
   * - Bot yeni commit'e `pending`i ~6 sn sonra yazıyor; durum yoksa inceleme
   *   henüz başlamamıştır.
   * - Kota dolunca bot `success` + "Review rate limited" yazıyor: inceleme
   *   YAPILMADI ve kendiliğinden yeniden incelemiyor; dolu kotada
   *   `@coderabbitai review` de "Review rate limited" ile reddediliyor. Bu
   *   yüzden görülür görülmez beklemeden dönülür (`false`).
   *
   * Süre dolarsa da akış DURMAZ (dönüş `false`); eldeki yorumlarla sürülür.
   */
  private async waitForReview(jobId: string, profile: ProjectProfile, pr: { repo: string; number: number }, expectedSha?: string): Promise<boolean> {
    const gh = this.deps.github!;
    const review = profile.workflow.review;
    const intervalMs = this.deps.ci?.intervalMs ?? 30_000;
    const started = Date.now();
    const waitMs = review.waitMinutes * 60_000;
    let lastTrigger = 0;
    this.notice(jobId, `${review.provider} incelemesi bekleniyor (en çok ${review.waitMinutes} dk).`);
    for (;;) {
      const elapsed = Date.now() - started;
      let state: "absent" | "pending" | "done" | "rate_limited" | "stale";
      try {
        if (gh.reviewStatus) {
          const s = await gh.reviewStatus(pr.repo, pr.number, review.provider);
          state = expectedSha && !s.headSha.startsWith(expectedSha) ? "stale" : s.state;
        } else {
          // Durum ucu olmayan istemci (sahte): check'ten okunur, açıklamasız.
          const bot = (await gh.checks(pr.repo, pr.number)).find((c) => c.name.toLowerCase().includes(review.provider));
          state = !bot ? "absent" : bot.status === "pending" ? "pending" : "done";
        }
      } catch {
        // Tek okuma hatası (ağ, `gh` zaman aşımı) işi düşürmemeli: bu tur
        // "yok" sayılır, süre dolana dek yoklama sürer.
        state = "absent";
      }
      if (state === "done") return true;
      if (state === "rate_limited") {
        this.notice(jobId, `${review.provider} kotası dolu ("rate limited"); inceleme beklenmeden eldeki yorumlarla sürülüyor.`);
        return false;
      }
      const shouldTrigger = review.autoTrigger && gh.commentPr && Date.now() - lastTrigger >= 10 * 60_000
        && state === "absent" && elapsed >= waitMs / 2;
      if (shouldTrigger) {
        lastTrigger = Date.now();
        // Tetikleme başarısızsa bekleme sürer; süre dolunca akış kendiliğinden geçer.
        await gh.commentPr!(pr.repo, pr.number, "@coderabbitai review").then(
          () => this.notice(jobId, "İnceleme başlamadı; `@coderabbitai review` ile tetiklendi."),
          () => undefined,
        );
      }
      if (elapsed >= waitMs) {
        this.notice(jobId, `${review.provider} ${review.waitMinutes} dk içinde incelemedi; eldeki yorumlarla sürülüyor.`);
        return false;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * İnceleme tavanı kapısı. Onay → bir tur daha (insan yorumu Developer'a
   * not); red → açık yorumlarla CIWatch.
   */
  private decideReviewRound(jobId: string, profile: ProjectProfile, payload: ReviewRoundPayload, decision: "approve" | "reject", comment: string): { jobId: string; state: JobState; developing: Promise<void> } {
    const pr = { repo: payload.repo, number: payload.prNumber, url: payload.prUrl };
    const guarded = (fn: () => Promise<void>): Promise<void> => {
      this.busy.add(jobId);
      return fn()
        .catch((err: unknown) => this.fail(jobId, "pr_failed", err instanceof Error ? err.message : String(err)))
        .finally(() => this.busy.delete(jobId));
    };
    if (decision === "approve") {
      this.setPhase(jobId, "running", "PRReview");
      return {
        jobId, state: "PRReview",
        developing: guarded(async () => {
          if (await this.reviewLoop(jobId, profile, pr, 1, comment, false)) {
            await this.markStep(jobId, profile, this.load(jobId).job.worktreePath ?? "", "pr.bot_review", "done");
            await this.enterCiWatch(jobId, profile, pr, "inceleme tamam; CI izleniyor", "system");
          }
        }),
      };
    }
    // Durum senkron yazılır: çağıran anında CIWatch görsün (kural 2).
    this.move(jobId, "CIWatch", "starting", `inceleme yorumları açık bırakıldı${comment ? `: ${comment.slice(0, 200)}` : ""}`, "human");
    // İnsan kalanları kabul etti; yeniden denemede bot turu yeniden açılmasın.
    void this.markStep(jobId, profile, this.load(jobId).job.worktreePath ?? "", "pr.bot_review", "waived", `${payload.threads.length} yorum açık bırakıldı`);
    this.setPhase(jobId, "running", "CIWatch");
    return {
      jobId, state: "CIWatch",
      developing: guarded(() => this.watchCi(jobId, profile, this.load(jobId).job.worktreePath ?? "", pr.repo, pr.number, pr.url)),
    };
  }

  /**
   * QA testlerini commit'le, gerçek remote'a push'la, PR aç.
   *
   * PR ZATEN AÇILMIŞSA yeniden açılmaz. Yeniden deneme bu yola da giriyor
   * (`retry()`): PR açıldıktan sonra düşen ya da CI izlenmeden kapanan bir
   * işte `gh pr create` "already exists" ile düşerdi. Commit/push de atlanır:
   * ağaç zaten itilmiş.
   */
  private async openPr(jobId: string, profile: ProjectProfile, worktree: string, branch: string, repo: string, base: string, state: "PRReview" | "CIWatch"): Promise<{ repo: string; number: number; url: string }> {
    const gh = this.deps.github!;
    const { job } = this.load(jobId);

    const existing = this.deps.db.select().from(schema.pullRequests)
      .where(eq(schema.pullRequests.jobId, jobId)).orderBy(desc(schema.pullRequests.createdAt)).all()[0];
    if (existing) {
      this.setPhase(jobId, "running", state);
      this.notice(jobId, `PR zaten açık: ${existing.url} — kalındığı yerden devam.`);
      return { repo: existing.repo, number: existing.number, url: existing.url };
    }

    // Worktree volume'de: commit de push de konteynerde koşar.
    const rt = await this.acquireRuntime(jobId, profile);
    await this.commitPhase(rt.executor, worktree, profile, 999, "QA testleri");
    this.setPhase(jobId, "running", state);

    await gh.push({ executor: rt.executor, worktree }, this.primaryRemote(job, profile)!, branch);
    const plan = PlanDocumentSchema.parse(this.approvedPlan(jobId).document);
    const results = this.deps.db.select().from(schema.testRuns).where(and(eq(schema.testRuns.jobId, jobId), eq(schema.testRuns.kind, "run"))).all();
    const fallbackTitle = profile.git.pr.titleTemplate.replaceAll("{title}", job.title);
    // GitHub issue'dan açılan işte externalRef "#1211" biçiminde tutulur;
    // PR gövdesine `Closes #N` eklenip merge'de issue otomatik kapansın.
    const closesIssue = job.source === "github_issue" ? Number(job.externalRef?.replace("#", "")) || undefined : undefined;
    const fallbackBody = renderPrBody({
      title: job.title, description: job.description, planSummary: plan.summary,
      phases: plan.phases.map((p) => `${p.order + 1}. ${p.title}`),
      tests: results.map((r) => `${r.suiteId}: ${r.passed}/${r.total} geçti, ${r.failed} kırık`),
      ...(closesIssue ? { closesIssue } : {}),
    });
    // BAŞLIK agent'a yazdırılabilir: şablon başlık işin adını kopyalıyor
    // ("Sipariş notları"), kodun ne yaptığını söylemiyor — ve sürüm
    // numarası konvansiyonel tipten türediği için başlık yanlışsa sürüm de
    // yanlış artar. Üretim düşerse şablona dönülür (kural 3).
    //
    // Gövde ŞABLON kalır: CodeRabbit PR'a kendi özetini basıyor.
    const writtenTitle = profile.git.pr.aiDescription
      ? await this.writePrText(jobId, profile, rt, worktree, { plan, results, fallbackTitle })
      : null;
    const pr = await gh.createDraftPr({ executor: rt.executor, worktree }, {
      repo,
      base: profile.git.pr.base.replaceAll("{defaultBranch}", base),
      head: branch,
      title: writtenTitle ?? fallbackTitle,
      body: fallbackBody,
      labels: profile.git.pr.labels,
      draft: profile.git.pr.draft,
    });
    this.deps.db.insert(schema.pullRequests).values({
      id: newId(), jobId, provider: "github", repo, number: pr.number, url: pr.url, branch, baseBranch: base,
      state: profile.git.pr.draft ? "draft" : "open",
    }).run();
    this.notice(jobId, `${profile.git.pr.draft ? "Draft PR" : "PR"} açıldı: ${pr.url}`);
    return { repo, number: pr.number, url: pr.url };
  }

  /**
   * PR BAŞLIĞINI agent'a yazdırır — gövdeyi değil.
   *
   * Şablon başlık işin ADINI kopyalıyor ("Sipariş notları"); inceleyen için
   * kodun ne yaptığını söylemiyor. Başlık ayrıca konvansiyonel olmak ZORUNDA:
   * sürüm numarası ondan türüyor (`feat` minor, `fix` patch, `!` major).
   * Yanlış tip yanlış sürüm demek.
   *
   * Gövde üretilmiyor: CodeRabbit PR'a zaten "Summary by CodeRabbit" özeti
   * basıyor, ikinci bir anlatı gürültü. Şablon gövde (plan + test sonuçları)
   * olduğu gibi kalır.
   *
   * `cwd` WORKTREE DEĞİL, bir üst dizin. YAŞANDI (2026-09-18): worktree'de
   * koşunca Northwind'in 503 KB'lık `CLAUDE.md`'si otomatik yükleniyor (~126K
   * token) ve istek 200K limitini aşıp "Prompt is too long" ile düşüyordu —
   * konuşmanın kendisi yalnız ~120K'ydı. Bu turun repoyu okumasına gerek yok:
   * diff stat ve plan özeti zaten prompt'ta.
   *
   * UCUZ bir iş: tek blok, araçsız. Varsayılan model `haiku`, tur ve bütçe
   * tavanı dar. Üretim düşerse `null` döner ve ÇAĞIRAN ŞABLONA DÜŞER — PR
   * açılmadan kalmaz (kural 3: üretici taraf güvenilmez).
   */
  private async writePrText(
    jobId: string,
    profile: ProjectProfile,
    rt: AcquiredRuntime,
    worktree: string,
    ctx: { plan: PlanDocument; results: { suiteId: string; passed: number; total: number; failed: number }[]; fallbackTitle: string },
  ): Promise<string | null> {
    try {
      // Üçüncü parametre PATCH SINIRI; başlık için stat yeterli, patch gerekmiyor.
      const diff = await diffSummary(rt.executor, worktree, 1);
      const run = await this.deps.runner.run({
        jobId, role: "devops",
        prompt: [
          "# PR başlığı yaz",
          "",
          `İş: ${ctx.fallbackTitle}`,
          `Plan özeti: ${ctx.plan.summary}`,
          "",
          "## Değişen dosyalar", "```", diff.stat.slice(0, 4000), "```",
          "",
          "Kurallar:",
          "- TEK satır, konvansiyonel: `<tip>(<kapsam>): <ne yapıldı>`, en çok 72 karakter.",
          "- Tip SÜRÜMÜ BELİRLER, doğru seç:",
          "  `feat` yeni yetenek (minor) · `fix` kusur düzeltmesi (patch) ·",
          "  `perf` başarım · `refactor` davranış değişmeden yapı · `docs` · `test` ·",
          "  `build` · `ci` · `chore` (sürüm artmaz).",
          "- Geriye dönük uyumu KIRIYORSA tipin sonuna `!` koy (major).",
          "- Kapsam değişen alanın kısa adı (dizin/modül). Emin değilsen kapsamı yaz.",
          "- İşin adını KOPYALAMA; kodun ne yaptığını yaz. Sonuna nokta koyma.",
          "- Diff'te GÖRMEDİĞİN şeyi yazma; tahmin etme.",
          "- Türkçe yaz.",
          "",
          "Yalnızca şu bloğu üret:",
          "```PR_TEXT_JSON",
          '{ "title": "..." }',
          "```",
        ].join("\n"),
        model: profile.git.pr.aiModel,
        effort: "low",
        maxTurns: 2,
        maxBudgetUsd: 1,
        // Proje kökü DEĞİL: `CLAUDE.md` yüklenmesin (bkz. üst yorum).
        cwd: rt.workdirRoot,
        allowedTools: [],
        disallowedTools: [...READ_ONLY_DENY],
        systemPrompt: "Sen bir yazılım mühendisisin. Yalnız PR başlığı yazıyorsun; kod okumuyor, değiştirmiyorsun.",
        resumeSessionId: null,
        transport: rt.transport,
      });
      if (run.subtype === "error" || run.subtype === "quota") return null;
      const raw = extractBlock(run.text, "PR_TEXT_JSON");
      const parsed = raw === null ? null : PrTitleSchema.safeParse(raw);
      if (!parsed?.success) {
        this.notice(jobId, "PR başlığı üretilemedi; şablon kullanılıyor.");
        return null;
      }
      return parsed.data.title;
    } catch {
      // Başlık üretimi PR açmayı ENGELLEMEZ.
      return null;
    }
  }

  /**
   * Açık bir PR'ın CI'ını izler; kırmızıysa DevOps'u tavanlı koşturur.
   *
   * `openPrAndWatch`ten AYRI: PR zaten açıkken (yeniden deneme, CI izlenmeden
   * kapanmış iş) yeniden açmaya çalışmadan buradan devam edilir.
   */
  private async watchCi(jobId: string, profile: ProjectProfile, worktree: string, repo: string, prNumber: number, prUrl: string): Promise<void> {
    const gh = this.deps.github!;
    // DevOps turu worktree'de koşar; ağaç yoksa SDK `cwd` bulamaz ve spawn
    // ENOENT'i "libc uyumsuz" diye raporlanır (bkz. `ensureWorktree`).
    await this.ensureWorktree(jobId);
    const rt = await this.acquireRuntime(jobId, profile);
    // Yol `ensureWorktree` içinde değişmiş olabilir (ağaç yeniden kuruldu);
    // çağıranın verdiği değer bayat olabilir, DB'den tazelenir.
    const { job: cur } = this.load(jobId);
    worktree = cur.worktreePath ?? worktree;
    const branch = cur.branchName ?? "";
    const ci = this.deps.ci ?? { intervalMs: 30_000, timeoutMs: 60 * 60_000 };
    const devopsRole = profile.agents.roles["devops"];
    const maxIterations = devopsRole?.maxIterations ?? 2;
    // DB'de kalıcı (`loopCounts.ci`, `bumpLoop` ile): bu değişken eskiden
    // yalnız bellekteydi ve her `watchCi()` çağrısında sıfırdan başlıyordu.
    // `retry()` — modelTier SEÇİLMESE BİLE — CIWatch'a her dönüşte yeni bir
    // `watchCi()` çağırıyor (bkz. `openPrAndWatch`); iş `ci_failed` ya da
    // `review_unresolved` ile düşüp yeniden denendikçe DevOps aynı kırmızıyı
    // tavan boyunca YENİDEN deniyordu — local_review'daki gibi ama modelTier
    // bile gerekmeden. Ölçüldü (2026-09-27): "CI adımında tekrar tekrar koşu."
    let iteration = this.loopCount(jobId, "ci");
    let started = Date.now();
    // DevOps'un ÇÖZEMEDİĞİ kalanlar. Akış bunlarda durmuyor: karar insana
    // ait ve merge kapısında görünüyorlar.
    let ciUnfixed: string[] = [];
    let reviewUnfixed: string[] = [];
    // Aynı sebepten `ci` gibi kalıcı (`loopCounts.ci_merge`): eskiden yerel
    // `baseMerges = 0` her `watchCi()` çağrısında sıfırlanıyor, base'le
    // ısrarla çakışan bir PR'da retry() sonsuza dek yeniden merge deneyebiliyordu.
    let baseMerges = this.loopCount(jobId, "ci_merge");
    // PR'ın dosyaları dışındaki yorumlar: düzeltme turuna verilmez, kapıda insana gösterilir.
    let scopeSkipped: string[] = [];
    for (;;) {
      // ÇAKIŞMA CHECK'LERDEN ÖNCE. Base'le çakışan PR'da GitHub merge commit'i
      // üretemiyor ve `pull_request` workflow'u hiç tetiklenmiyor: liste boş
      // ya da bayat kalıyor, döngü "CI yeşil / check yok" deyip kapıya
      // geçiyordu — çakışma merge anında `gh pr merge` hatası olarak çıkıyordu.
      const synced = await this.syncBase(jobId, profile, worktree, repo, prNumber, branch, baseMerges);
      if (synced === "failed") return; // fail() çağrıldı
      if (synced === "pushed") {
        // Tavan burada değil `syncBase()`in kendi `attempts >= 2` denetiminde;
        // `max` yalnız `bumpLoop` imzası gereği — `.exceeded` kullanılmıyor.
        baseMerges = bumpLoop(this.deps.db, jobId, "ci_merge", 2).count;
        started = Date.now();
        await new Promise((r) => setTimeout(r, ci.intervalMs));
        continue;
      }
      const checks = await gh.checks(repo, prNumber);
      const failed = checks.filter((c) => c.status === "failure");
      const pending = checks.filter((c) => c.status === "pending");
      this.deps.db.update(schema.pullRequests)
        .set({ ciStatus: failed.length ? "failure" : pending.length ? "pending" : "success" })
        .where(and(eq(schema.pullRequests.jobId, jobId), eq(schema.pullRequests.number, prNumber))).run();
      // `ciUnfixed` doluysa bu kırmızılık bu turda ele alındı ve DevOps
      // dokunmadı (önceden kırık testler gibi). Tekrar denemek aynı sonucu
      // verir; akış incelemeye ve oradan kapıya geçsin.
      if (failed.length > 0 && ciUnfixed.length === 0 && !this.fixBudgetLeft(jobId, profile)) {
        this.notice(jobId, `Düzeltme bütçesi (${profile.workflow.maxFixPushes}) dolu; CI kırmızılığı merge kapısında insana bırakılıyor.`);
        ciUnfixed = failed.map((c) => c.name);
      }
      if (failed.length > 0 && ciUnfixed.length === 0) {
        // DevOps düzeltmeye çalışır: iterasyon başına YENİ oturum, tavanlı.
        const ciLoop = bumpLoop(this.deps.db, jobId, "ci", maxIterations);
        if (ciLoop.exceeded) {
          this.fail(jobId, "ci_failed", `CI ${ciLoop.count} düzeltme denemesinden sonra hâlâ kırmızı: ${failed.map((c) => c.name).join(", ")}`);
          return;
        }
        iteration = ciLoop.count;
        // Yorumlar da AYNI tura veriliyor: CI kırmızıyken beklemeye gerek yok,
        // ikisi de aynı PR'ın geri bildirimi ve aynı rolün işi. Önceden kırık
        // testler yüzünden CI'a dokunulmasa bile yorumlar çözülebilir.
        const ciThreads = profile.workflow.review.blocksMerge
          ? (await this.splitByScope(jobId, profile, ((await gh.openReviewThreads?.(repo, prNumber)) ?? []).filter(
            (t) => severityRank(t.severity) >= severityRank(profile.workflow.review.minSeverity)))).inScope
          : [];
        const fixed = await this.runDevOps(jobId, profile, worktree, repo, prNumber, iteration, failed, await gh.failedLogs(repo, checks), ciThreads);
        if (!fixed.ok) return; // fail() çağrıldı
        if (!fixed.changed) {
          // DevOps kırmızıyı DÜZELTMEDİ (önceden kırık testler gibi bir sebeple
          // dokunmadı). CI'a geri dönmek aynı kırmızıyı tekrar görmek olurdu:
          // sonsuz döngü. Akış durmuyor — inceleme yorumlarına geçiliyor ve
          // kalan kırmızılık merge kapısında insana taşınıyor.
          this.notice(jobId, `DevOps ${iteration}: CI kırmızılığı düzeltilmedi; incelemeye geçiliyor.`);
          ciUnfixed = failed.map((c) => c.name);
        } else {
        await gh.push({ executor: rt.executor, worktree }, this.primaryRemote(this.load(jobId).job, profile)!, branch);
        this.notice(jobId, `DevOps düzeltmesi ${iteration} push'landı; CI yeniden izleniyor.`);
        started = Date.now();
        // Push'tan sonra eski sonuçlar bir an daha görünebilir; bir aralık bekle.
        await new Promise((r) => setTimeout(r, ci.intervalMs));
        continue;
        }
      }
      if (pending.length === 0) {
        // BOŞ LİSTE "CI yok" DEMEK DEĞİL — henüz tetiklenmemiş de olabilir.
        //
        // YAŞANDI (2026-09-17, PR #135): PR açıldıktan saniyeler sonra ilk
        // sorgu boş döndü, iş "CI check'i yok" diyerek Done oldu; oysa
        // Actions o sırada workflow'u kuyruğa almıştı ve 10 sn sonra üç
        // check koşuyordu. CI kırmızı dönse bile iş çoktan kapanmış olurdu.
        //
        // Boş listede hemen karar verilmez: bir süre beklenip yeniden
        // bakılır. Gerçekten check'i olmayan bir repoda bu süre sonunda
        // liste yine boş kalır ve iş normal biçimde biter.
        if (checks.length === 0 && Date.now() - started < CI_EMPTY_GRACE_MS) {
          await new Promise((r) => setTimeout(r, ci.intervalMs));
          continue;
        }
        // CHECK'LER YEŞİL AMA İŞ BİTMEMİŞ OLABİLİR.
        //
        // CodeRabbit'in check'i yorumlarından BAĞIMSIZ yeşile dönüyor —
        // ölçüldü (PR #135: check SUCCESS, 11 açık yorum, 7'si Major).
        // İnceleme de CI'ın bir parçası: aynı döngüde, aynı rolle çözülür.
        const threads = profile.workflow.review.blocksMerge
          ? ((await gh.openReviewThreads?.(repo, prNumber)) ?? [])
          : [];
        const minRank = severityRank(profile.workflow.review.minSeverity);
        const scoped = await this.splitByScope(jobId, profile, threads.filter((t) => severityRank(t.severity) >= minRank));
        const actionable = scoped.inScope;
        const belowThreshold = threads.filter((t) => severityRank(t.severity) < minRank);
        // Düzeltilmeyecek ama sessizce de kaybolmasın: kapıda "çözülmedi" görünür.
        scopeSkipped = scoped.outOfScope.map((t) => `${t.path}:${t.line ?? "?"} (PR dışı)`);
        if (actionable.length > 0 && reviewUnfixed.length === 0 && !this.fixBudgetLeft(jobId, profile)) {
          this.notice(jobId, `Düzeltme bütçesi (${profile.workflow.maxFixPushes}) dolu; ${actionable.length} yorum merge kapısında insana bırakılıyor.`);
          reviewUnfixed = actionable.map((t) => `${t.path}:${t.line ?? "?"}`);
        }
        // `reviewUnfixed` doluysa bu turda zaten denendi ve kod değişikliği
        // gerekmedi; tekrar denemek aynı yorumları yeniden ele almak olur.
        if (actionable.length > 0 && reviewUnfixed.length === 0) {
          const reviewLoop = bumpLoop(this.deps.db, jobId, "ci", maxIterations);
          if (reviewLoop.exceeded) {
            this.fail(jobId, "review_unresolved",
              `${actionable.length} inceleme yorumu ${reviewLoop.count} denemeden sonra hâlâ açık: ` +
              actionable.slice(0, 5).map((t) => `${t.path}:${t.line ?? "?"}`).join(", "));
            return;
          }
          iteration = reviewLoop.count;
          const fixed = await this.runDevOps(jobId, profile, worktree, repo, prNumber, iteration, [], "", actionable);
          if (!fixed.ok) return; // fail() çağrıldı
          if (!fixed.changed) {
            // Yorumlar kod değişikliği gerektirmiyordu (agent gerekçeyle
            // cevapladı ya da karar insana bırakıldı). Yeniden koşmak aynı
            // yorumları tekrar ele almak olurdu; kapıya geçiliyor.
            this.notice(jobId, `DevOps ${iteration}: yorumlar kod değişikliği gerektirmedi; kapıya geçiliyor.`);
            reviewUnfixed = actionable.map((t) => `${t.path}:${t.line ?? "?"}`);
            continue;
          }
          await gh.push({ executor: rt.executor, worktree }, this.primaryRemote(this.load(jobId).job, profile)!, branch);
          this.notice(jobId, `İnceleme düzeltmesi ${iteration} push'landı (${actionable.length} yorum); CI yeniden izleniyor.`);
          started = Date.now();
          await new Promise((r) => setTimeout(r, ci.intervalMs));
          continue;
        }

        // CI yeşil, inceleme temiz. Profil kapanış kapısı istiyorsa insana
        // sorulur: merge ve dal silme geri alınamaz, motor kendi başına yapmaz.
        if (profile.git.pr.mergeApproval) {
          const botBlocks = await this.botChangesRequested(profile, repo, prNumber);
          const payload: MergeGatePayload = {
            prNumber, prUrl, repo,
            method: profile.git.pr.mergeMethod,
            cleanup: profile.git.pr.cleanup,
            checks: checks.map((c) => ({ name: c.name, status: c.status })),
            // Eşiğin altındakiler ele alınmadı ama hâlâ açık; kapıda görünsün
            // ve insan seçip düzelttirebilsin. Eşiği aşanlar burada YOK: onlar
            // ya çözüldü ya `reviewUnfixed`ta — iki listede birden görünmesin.
            ...(belowThreshold.length > 0 ? { unresolvedBelowThreshold: belowThreshold.map(openThreadItem) } : {}),
            ...(ciUnfixed.length > 0 ? { ciUnfixed } : {}),
            ...(reviewUnfixed.length + scopeSkipped.length > 0 ? { reviewUnfixed: [...reviewUnfixed, ...scopeSkipped] } : {}),
            ...(botBlocks.length > 0
              ? { botChangesRequested: botBlocks.map((r) => ({ author: r.author, submittedAt: r.submittedAt })) }
              : {}),
          };
          const gateId = this.openApproval(jobId, "pr_merge", null, payload);
          this.setPhase(jobId, "waiting", "CIWatch");
          const head = ciUnfixed.length > 0 || reviewUnfixed.length + scopeSkipped.length > 0
            ? `DevOps'un çözemediği ${ciUnfixed.length + reviewUnfixed.length + scopeSkipped.length} madde var`
            : "CI yeşil";
          this.notice(jobId, `${head}. Merge onayı bekleniyor: ${prUrl}`);
          this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "pr_merge", payload });
          return;
        }
        this.move(jobId, "Done", "done", checks.length ? "CI yeşil" : "CI check'i yok", "system");
        this.notice(jobId, `İş tamamlandı. PR: ${prUrl}`);
        await this.releaseResources(jobId, "iş kapandı").catch(() => undefined);
        return;
      }
      if (Date.now() - started >= ci.timeoutMs) {
        this.fail(jobId, "ci_timeout", `CI ${Math.round(ci.timeoutMs / 60_000)} dk içinde bitmedi: ${pending.map((c) => c.name).join(", ")}`);
        return;
      }
      await new Promise((r) => setTimeout(r, ci.intervalMs));
    }
  }

  /**
   * PR base'le çakışıyorsa base'i dala MERGE eder; çakışan dosyaları DevOps çözer.
   *
   * Rebase DEĞİL merge: rebase force-push ister (agent'a da motora da yasak)
   * ve PR'daki inceleme başlıklarını bayatlatır. Merge commit'i PR'ın
   * squash'ında zaten kaybolur.
   *
   * `clean`: çakışma yok ya da bilinemiyor — akış check'lere geçer.
   * `pushed`: merge commit'i itildi, CI yeniden tetiklenecek.
   * `failed`: çözülemedi, `fail()` çağrıldı; ağaç merge öncesine döndü.
   */
  private async syncBase(jobId: string, profile: ProjectProfile, worktree: string, repo: string, prNumber: number, branch: string, attempts: number): Promise<"clean" | "pushed" | "failed"> {
    const gh = this.deps.github!;
    if (!gh.mergeState) return "clean";
    let state: { mergeable: string; base: string };
    try {
      state = await gh.mergeState(repo, prNumber);
    } catch {
      // Sorgu düşerse akış durmaz; çakışma varsa merge kapısında görünür.
      return "clean";
    }
    if (state.mergeable !== "CONFLICTING") return "clean";
    // Base her merge'den sonra yine ilerlemiş olabilir; ama aynı dalı iki kez
    // birleştirip hâlâ çakışıyorsa üçüncü deneme de aynı sonucu verir.
    if (attempts >= 2) {
      this.fail(jobId, "merge_conflict", `PR #${prNumber} ${attempts} base birleştirmesinden sonra hâlâ ${state.base} ile çakışıyor.`);
      return "failed";
    }
    const remote = this.primaryRemote(this.load(jobId).job, profile);
    if (!remote || !gh.fetch || !state.base) {
      this.fail(jobId, "merge_conflict", `PR #${prNumber} ${state.base || "base"} ile çakışıyor; uzak dal çekilemediği için elle çözülmeli.`);
      return "failed";
    }
    this.setPhase(jobId, "running", "CIWatch");
    this.notice(jobId, `PR #${prNumber} ${state.base} ile çakışıyor; base dala birleştiriliyor.`);
    const rt = await this.acquireRuntime(jobId, profile);
    try {
      await gh.fetch({ executor: rt.executor, worktree }, remote, state.base);
    } catch (err) {
      this.fail(jobId, "merge_conflict", `${state.base} çekilemedi: ${scrubSecrets(String(err)).slice(0, 500)}`);
      return "failed";
    }
    const merged = await this.mergeFetched(jobId, profile, rt.executor, worktree, branch, state.base, `PR #${prNumber} (${repo})`, attempts + 1, `conflict-${attempts + 1}`);
    if (merged.kind === "failed") return "failed";
    // GitHub'ın `mergeable` değeri push'tan sonra bir süre bayat kalabiliyor:
    // uç zaten daldaysa birleştirilecek bir şey yok, check'lere geçilir.
    if (merged.kind === "current") {
      // Taban yine de çekilen uca yazılır: eski `baseSha` ile kapsam
      // (`runDevOps`) base'in getirdiği dosyaları PR'ın değişikliği sayardı.
      this.deps.db.update(schema.jobs).set({ baseSha: merged.fetched }).where(eq(schema.jobs.id, jobId)).run();
      return "clean";
    }
    const fetchedBase = merged.fetched;
    await gh.push({ executor: rt.executor, worktree }, remote, branch);
    // Taban ilerledi: eski SHA ile diff, base'in yeni getirdiği dosyaları da
    // "bu PR'ın değişikliği" gösterir ve CI turunda agent onlara dokunabilir.
    this.deps.db.update(schema.jobs).set({ baseSha: fetchedBase }).where(eq(schema.jobs.id, jobId)).run();
    this.notice(jobId, merged.conflicts > 0
      ? `${state.base} birleştirildi, ${merged.conflicts} çakışma çözüldü ve push'landı; CI yeniden izleniyor.`
      : `${state.base} çakışmasız birleştirildi ve push'landı; CI yeniden izleniyor.`);
    return "pushed";
  }

  /**
   * Çekilmiş `FETCH_HEAD`i dala merge eder; çakışan dosyaları DevOps çözer,
   * commit orkestratörde. `syncBase` (PR açıkken) ve `syncBaseBeforePr`
   * (PR'dan önce) aynı yolu kullanır — çakışma çözümü iki yerde ayrı ayrı
   * evrilmesin.
   *
   * `current`: uç zaten dalda, merge gerekmedi. `merged`: merge commit'i
   * atıldı (`conflicts`: DevOps'un çözdüğü dosya sayısı, `before`: merge
   * öncesi HEAD). `failed`: ağaç merge öncesine döndü, `fail()` çağrıldı.
   */
  private async mergeFetched(
    jobId: string, profile: ProjectProfile, executor: CommandExecutor, worktree: string,
    branch: string, base: string, label: string, attempt: number, handoffKey: string,
  ): Promise<{ kind: "current"; fetched: string } | { kind: "merged"; fetched: string; before: string; conflicts: number } | { kind: "failed" }> {
    const ident = ["-c", `user.name=${BRAND.displayName}`, "-c", `user.email=${BRAND.slug}@localhost`];
    // Merge sonrası FETCH_HEAD'e güvenilmez; taban olarak çekilen uç yazılacak
    // (merge commit'i DEĞİL — o işin kendi değişikliği sayılırdı).
    const fetched = (await execGit(executor, worktree, ["rev-parse", "FETCH_HEAD"])).trim();
    const common = (await execGit(executor, worktree, ["merge-base", "HEAD", "FETCH_HEAD"], { allowFailure: true })).trim();
    if (common === fetched) return { kind: "current", fetched };
    const before = (await execGit(executor, worktree, ["rev-parse", "HEAD"])).trim();
    const out = await execGit(executor, worktree,
      [...ident, "merge", "--no-ff", "--no-gpg-sign", "-m", `Merge ${base} into ${branch}`, "FETCH_HEAD"],
      { allowFailure: true });
    const unmerged = (await execGit(executor, worktree, ["diff", "--name-only", "--diff-filter=U"]))
      .split("\n").map((l) => l.trim()).filter(Boolean);

    if (unmerged.length > 0) {
      const resolved = await this.resolveConflicts(jobId, profile, worktree, label, base, unmerged, attempt, handoffKey);
      // `git grep` eşleşme yoksa 1 döner; o da başarı.
      const markers = resolved
        ? (await execGit(executor, worktree, ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>)( |$)", "--", ...unmerged], { allowFailure: true }))
          .split("\n").map((l) => l.trim()).filter(Boolean)
        : unmerged;
      if (markers.length > 0) {
        await execGit(executor, worktree, ["merge", "--abort"], { allowFailure: true });
        // `resolveConflicts` false döndüyse fail() orada çağrıldı.
        if (resolved) {
          this.fail(jobId, "merge_conflict", `Çakışma çözülemedi (${markers.length} dosyada işaret kaldı): ${markers.slice(0, 10).join(", ")}`);
        }
        return { kind: "failed" };
      }
      await execGit(executor, worktree, ["add", "-A"]);
      await execGit(executor, worktree, [...ident, "commit", "-q", "--no-gpg-sign", "--no-edit"]);
    }

    const after = (await execGit(executor, worktree, ["rev-parse", "HEAD"])).trim();
    if (before === after) {
      // Merge ne commit üretti ne çakışma bıraktı: kirli ağaç gibi başka bir
      // sebeple reddedildi. Git'in çıktısı sebebi söylüyor.
      await execGit(executor, worktree, ["merge", "--abort"], { allowFailure: true });
      this.fail(jobId, "merge_conflict", `${base} birleştirilemedi:\n${scrubSecrets(out).slice(0, 1000)}`);
      return { kind: "failed" };
    }
    return { kind: "merged", fetched, before, conflicts: unmerged.length };
  }

  /**
   * PR açılmadan ÖNCE uzak `defaultBranch`i dala merge eder
   * (`workflow.syncBaseBeforePr`).
   *
   * `pullBase` yalnız işin başında koşuyor; LiveTest ve QA insanı beklediği
   * için saatler-günler sürüyor ve `main` bu arada ilerliyor. Çakışma ancak PR
   * açıldıktan sonra `syncBase`te görünüyordu: bot inceleme kotası çakışma
   * push'una gidiyor, bot ve yerel inceleme PR'a gidecek son diff'i
   * görmüyordu. Burada merge edilince statik analiz, yerel inceleme ve bot
   * birleşmiş son hâli görür; `syncBase` PR açıkken ilerleyen `main` için
   * güvenlik ağı olarak kalır.
   *
   * Uzak `main` incelenmiş ve test edilmiş sayılır (kullanıcı kararı): taban
   * (`baseSha`) çekilen uca ilerletilir, inceleme yalnız işin değişikliğini
   * ve çakışma çözümlerini görür. Çakışmasız merge doğrulanmaz, birleşimi CI
   * sınar. Çakışmayı agent elle çözdüyse derleme kapısı koşar: iki tarafın
   * da tek başına geçtiği ama elle birleşiminin derlenmediği durum (yeniden
   * adlandırılmış bir metot, kaybolan bir alan) PR'a gitmeden yakalanır.
   *
   * Rebase değil merge: PR squash'landığı için merge commit'i `main`e iz
   * bırakmaz; rebase ise çakışmayı commit commit çıkarır (agent N tur çözer)
   * ve yeniden denemede push'lanmış dalı force-push'a zorlar (bkz. karar §32).
   *
   * Çekme düşerse iş durmaz (PR'daki `syncBase` yine yakalar); not düşülür.
   * false: `fail()` çağrıldı, ağaç merge öncesinde.
   */
  private async syncBaseBeforePr(jobId: string, profile: ProjectProfile, worktree: string, branch: string, state: "PRReview" | "CIWatch"): Promise<boolean> {
    if (!profile.workflow.syncBaseBeforePr || this.hasPr(jobId)) return true;
    const gh = this.deps.github;
    const remote = this.primaryRemote(this.load(jobId).job, profile);
    const base = profile.workspace.repos.find((r) => r.primary)?.defaultBranch;
    if (!gh?.fetch || !remote || !base) return true;

    // PRReview'dan da, yeniden denemede doğrudan CIWatch'tan da çağrılıyor.
    this.setPhase(jobId, "running", state);
    const rt = await this.acquireRuntime(jobId, profile);
    // QA testleri henüz commit'lenmedi (`openPr` yapıyordu); kirli ağaçta
    // merge, dokunduğu dosyalar için reddedilir. `openPr`daki çağrı boş geçer.
    await this.commitPhase(rt.executor, worktree, profile, 999, "QA testleri");
    try {
      await gh.fetch({ executor: rt.executor, worktree }, remote, base);
    } catch (err) {
      this.notice(jobId, `UYARI: PR öncesi uzak ${base} çekilemedi; dal mevcut tabanıyla sürüyor.\n${scrubSecrets(String(err)).slice(0, 500)}`);
      return true;
    }
    // Sayaç yalnız çözüm handoff'unun adını ayırır; yeniden denemede
    // önceki çözümün kaydı ezilmesin. Tavanı yok: kırmızı birleşim zaten
    // işi düşürüyor, yeniden denemeyi insan başlatıyor.
    const attempt = this.loopCount(jobId, "pre_pr_merge") + 1;
    const merged = await this.mergeFetched(jobId, profile, rt.executor, worktree, branch, base, `Dal ${branch}`, attempt, `pre-pr-conflict-${attempt}`);
    if (merged.kind !== "current") bumpLoop(this.deps.db, jobId, "pre_pr_merge", Number.MAX_SAFE_INTEGER);
    if (merged.kind === "failed") return false;
    const setBase = (sha: string): void => {
      this.deps.db.update(schema.jobs).set({ baseSha: sha }).where(eq(schema.jobs.id, jobId)).run();
    };
    if (merged.kind === "current") {
      setBase(merged.fetched);
      return true;
    }
    if (merged.conflicts === 0) {
      setBase(merged.fetched);
      this.notice(jobId, `Uzak ${base} PR öncesi çakışmasız birleştirildi (${merged.fetched.slice(0, 12)}).`);
      return true;
    }
    // Taban build'den SONRA yazılır: kırmızıda merge geri alınıyor ve taban
    // eski uçta kalmalı.
    let build: BuildRunOutput;
    try {
      // Kurulum da korumanın İÇİNDE: burada fırlayan hata merge'ü dalda
      // bırakırsa yeniden denemede uç "zaten dalda" görünür ve derlenmemiş
      // çözüm PR'a gider.
      await this.ensureSetup(jobId, profile, rt);
      this.notice(jobId, `${merged.conflicts} dosyada çakışma çözüldü; birleşim derleniyor.`);
      build = await this.deps.gate.run({
        jobId, phaseId: null, profile,
        workdir: rt.workdir,
        changedFiles: await changedFiles(rt.executor, worktree, merged.fetched),
        executor: rt.executor,
        artifactsDir: this.deps.artifactsDir,
      });
    } catch (err) {
      await execGit(rt.executor, worktree, ["reset", "--hard", merged.before]);
      if (!(err instanceof ForbiddenFlagError)) throw err;
      this.fail(jobId, "forbidden_flag", err.message);
      return false;
    }
    if (!build.ok) {
      // Kırık birleşim dalda bırakılmaz: yeniden denemede uç "zaten dalda"
      // görünür ve çakışma bir daha çözülmeden PR'a giderdi. Geri alınca
      // yeniden deneme merge'ü ve çözümü baştan yapar.
      await execGit(rt.executor, worktree, ["reset", "--hard", merged.before]);
      this.fail(jobId, "merge_conflict",
        `Uzak ${base} ile çakışma çözüldü ama birleşim derlenmedi; merge geri alındı.\n${renderBuildFeedback(build.results).slice(0, 4000)}`);
      return false;
    }
    setBase(merged.fetched);
    // Çakışma çözümü agent'ın yazdığı YENİ kod: önceki "geçti" kayıtları onu
    // görmedi, PR öncesi denetimler yeniden koşmalı (karar §34). Çakışmasız
    // merge silmez: uzak `main` incelenmiş sayılıyor (§32).
    this.clearSteps(jobId, ["pr.security", "pr.quality", "pr.local_review"]);
    this.notice(jobId, `Uzak ${base} PR öncesi birleştirildi, ${merged.conflicts} çakışma çözüldü ve derlendi; PR öncesi denetimler bu kod için yeniden koşacak.`);
    return true;
  }

  /**
   * Yarım kalmış merge'ün çakışan dosyalarını DevOps'a çözdürür.
   *
   * Commit orkestratörde (`mergeFetched`); agent yalnız dosyaları düzenler.
   * false: koşu bitmedi ve `fail()` çağrıldı.
   */
  private async resolveConflicts(jobId: string, profile: ProjectProfile, worktree: string, label: string, base: string, files: string[], attempt: number, handoffKey: string): Promise<boolean> {
    const role = profile.agents.roles["devops"];
    this.notice(jobId, `${files.length} dosyada çakışma; DevOps çözüyor.`);
    const rt = await this.acquireRuntime(jobId, profile);
    const channel = new LiveInputChannel();
    this.channels.set(jobId, channel);
    let run: RunResult;
    try {
      run = await this.deps.runner.run({
        jobId, role: "devops",
        prompt: [
          `# ${label} ${base} ile çakışıyor — birleştirme ${attempt}`,
          `\`${base}\` dala merge edildi; şu dosyalarda çakışma işaretleri var:`,
          ...files.map((f) => `- ${f}`),
          "",
          "Her dosyada `<<<<<<<` / `=======` / `>>>>>>>` bloklarını çöz: İKİ tarafın",
          "niyetini de koru. Base'deki değişikliği atıp yalnız kendi tarafını",
          "seçmek, başkasının birleşmiş işini sessizce geri alır.",
          "`git diff`, `git log` ile iki tarafı oku. Hangi tarafın doğru olduğu",
          "bir ürün kararıysa `ask_user` ile sor.",
          "",
          "İşaret BIRAKMA. Commit/push/merge --abort orkestratörde. Bitince tam bir HANDOFF_JSON bloğu yaz.",
        ].join("\n"),
        ...this.roleModel(jobId, profile, role, "claude-sonnet-5-5"),
        maxTurns: role?.maxTurns ?? 60, maxBudgetUsd: role?.maxBudgetUsd ?? 3,
        cwd: rt.agentCwd,
        permissionMode: "bypassPermissions",
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git diff*)", "Bash(git status*)", "Bash(git log*)", "Bash(git show*)"],
        disallowedTools: ["Bash(gh pr merge*)", "Bash(git push*)", "Bash(git commit*)", "Bash(git merge*)", "Bash(git reset*)", "Bash(git checkout*)", "Bash(git clean*)"],
        systemPrompt: loadRolePrompt("devops"),
        resumeSessionId: null,
        ...this.askUserFor(jobId, profile),
        channel,
        transport: rt.transport,
        onTurn: (turn) => this.onLiveTurn(jobId, profile, channel, turn.text, "HANDOFF_JSON"),
      });
    } finally {
      channel.close();
      if (this.channels.get(jobId) === channel) this.channels.delete(jobId);
    }
    if (run.subtype === "error" || run.subtype === "quota") {
      this.fail(jobId, "devops_error", `Çakışma çözümü bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
      return false;
    }
    await this.resolveHandoff(rt.executor, jobId, handoffKey, run.text, worktree, base);
    return true;
  }

  /**
   * DevOps turu: kırmızı check'ler + başarısız adım logu ile konteynerde
   * düzeltme. Commit orkestratörde; `gh pr merge` ve `git push` agent'a
   * kapalı. Değişiklik yoksa (geçici hata teşhisi) yine true döner — yeniden
   * izleme kendisi karar verir.
   */
  /**
   * İŞİN GETİRMEDİĞİ kırık testler — PR kapısının payload'ından.
   *
   * QA safhasında baseline (stash'li koşu) ile karşılaştırma yapılıyor ve
   * sonuç `pr_open` kapısında saklanıyor. DevOps'a bu bilgi GİTMİYORDU:
   * CI'da "Failed: 2" görüp o iki testi düzeltmeye çalışıyordu, oysa ikisi de
   * dalın açılmasından önce de kırıktı (ölçüldü — PR #135'te
   * `ResourceKeyContractTest` ve `ShipmentStatusNoteLanguageTest`).
   */
  private preexistingFailures(jobId: string): string[] {
    const gate = this.deps.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, "pr_open")))
      .orderBy(desc(schema.approvals.requestedAt)).all()[0];
    if (!gate) return [];
    const payload = gate.payload as Partial<PrGatePayload> | null;
    const names = new Set<string>();
    for (const r of payload?.results ?? []) for (const n of r.preexistingFailures ?? []) names.add(n);
    return [...names];
  }

  private async runDevOps(jobId: string, profile: ProjectProfile, worktree: string, repo: string, prNumber: number, iteration: number, failed: { name: string }[], logs: string, threads: ReviewThread[] = [], opts: { role: "devops" | "developer"; budget?: number; note?: string; source?: "pr" | "local" | "static" } = { role: "devops" }): Promise<{ ok: boolean; changed: boolean; verifyFailed?: string }> {
    // PRReview'da inceleme yorumlarını kodu yazan rol (Developer) çözer;
    // CIWatch'ta kırmızı CI ve sonradan gelen yorumlar DevOps'ta kalır.
    const roleName = opts.role;
    const role = profile.agents.roles[roleName];
    const label = roleName === "developer" ? "Developer" : "DevOps";
    const state: JobState = roleName === "developer" ? "PRReview" : "CIWatch";
    this.setPhase(jobId, "running", state);
    const preexisting = failed.length > 0 ? this.preexistingFailures(jobId) : [];
    const what = failed.length > 0
      ? `CI kırmızı (${failed.map((c) => c.name).join(", ")})`
      : `${threads.length} açık inceleme yorumu`;
    this.notice(jobId, `${what}; ${label} düzeltme ${iteration}/${opts.budget ?? role?.maxIterations ?? 2}.`);
    const rt = await this.acquireRuntime(jobId, profile);
    // Yorum GÖVDELERİ prompt'a motordan girer. Agent'a "`gh` ile kendin çek"
    // deniyordu, ama konteynerde GitHub kimliği yok (kural 5: kimlik
    // konteynere taşınmaz). YAŞANDI (2026-09-25, Northwind#153): Developer
    // gövdeyi çekemedi, koda dokunmadı; motor bunu "değişiklik gerekmedi"
    // sanıp CI'a geçti. Gövdeler `openReviewThreads`te zaten maskeli ve kırpık.
    const threadBodies = threads.slice(0, 20).flatMap((t) => [
      "",
      `## [${t.severity}] ${t.path}:${t.line ?? "?"} (${t.author})`,
      "```text", t.body, "```",
    ]);
    // Kapsam çıpası: agent PR'ın dosyalarını bilmezse "açık kusur → düzelt"
    // kuralı başkasının kodunu da kapsıyor (Northwind#184).
    const scopeFiles = await changedFiles(rt.executor, worktree, this.diffBase(jobId, profile));
    const scopeBase = this.diffBase(jobId, profile);
    const scopeTruncated = scopeFiles.length > 80;
    const scopeLines = scopeFiles.length === 0 ? [] : [
      "",
      `## KAPSAM — bu PR ${scopeFiles.length} dosyayı değiştiriyor`,
      ...scopeFiles.slice(0, 80).map((f) => `- ${f}`),
      // Kısaltılmış liste "tam kapsam" gibi sunulursa 81. dosyadaki geçerli bir
      // yorum yasaklanmış olur; tam liste agent'ın kendi komutuyla alınır.
      ...(scopeTruncated ? [`- … (+${scopeFiles.length - 80} dosya; liste KISALTILDI, tamamı: \`git diff --name-only ${scopeBase}...HEAD\`)`] : []),
      scopeTruncated
        ? "Kapsam kararı vermeden önce tam listeyi o komutla al. PR'ın dosyalarının DIŞINDAKİ bir dosyaya DOKUNMA."
        : "Bu listenin DIŞINDAKİ bir dosyaya DOKUNMA.",
      "Bir bulgu/log PR'ın dosyalarında olmayan bir dosyayı işaret ediyorsa o işin",
      "kusuru değildir: düzeltme, handoff'un `keyDecisions` alanına",
      "\"kapsam dışı: <dosya>\" yaz. Başkasının kodunu düzeltmek PR'ı şişirir ve",
      "inceleme botu yeni yüzeye yeni yorum yazar.",
      // Dosya listesi kusurun sahibini söylemez: base'den gelen kod bu PR'ın
      // testine çarpabilir. YAŞANDI (Northwind, ShopifyCollectionLog.cs): DevOps
      // düzeltmeyi bulup "kapsam dışı" diye bıraktı; soru handoff'ta kaldı.
      "İSTİSNA: CI kırmızısı YALNIZ kapsam dışı bir dosya düzeltilerek gideriliyorsa",
      "bu bir kapsam kararıdır — `ask_user` ile sor.",
      "Yanıt gelmezse (`TIMEOUT_ANSWER` dahil) varsayımla ilerleme; dosyaya dokunma.",
    ];
    const prompt = (failed.length > 0
      ? [
        `# PR #${prNumber} (${repo}) CI kırmızı — düzeltme ${iteration}`,
        `Kırmızı check'ler: ${failed.map((c) => c.name).join(", ")}`,
        ...(preexisting.length > 0
          ? [
            "",
            "## ÖNCEDEN KIRIK — senin işin DEĞİL",
            "Bu testler dal açılmadan ÖNCE de kırıktı (baseline'la ölçüldü):",
            ...preexisting.map((n) => `- ${n}`),
            "Bunları düzeltmeye çalışma. CI'daki tek kırmızılık bunlarsa,",
            "hiçbir değişiklik yapma ve handoff'ta `nextAction: \"insan baksın\"` de.",
          ]
          : []),
        "\n# Başarısız adım logları (kuyruk)", "```", logs || "(log alınamadı)", "```",
        ...(threads.length > 0
          ? [
            "",
            `# AYRICA: ${threads.length} açık inceleme yorumu`,
            "CI'ı düzeltemesen bile (önceden kırık testler gibi) BUNLARI ÇÖZ.",
            ...threadBodies,
          ]
          : []),
      ]
      : [
        opts.source === "local"
          ? `# Yerel inceleme bulguları (PR öncesi) — düzeltme ${iteration}`
          : opts.source === "static"
            ? `# Statik analiz bulguları (PR öncesi) — düzeltme ${iteration}`
            : `# PR #${prNumber} (${repo}) inceleme yorumları — düzeltme ${iteration}`,
        `${threads.length} çözülmemiş yorum var:`,
        ...threadBodies,
        ...(roleName === "developer"
          ? [
            "",
            "Her yorumu kodda DOĞRULA: bot yanılabilir. Geçerliyse düzelt; değilse",
            "koda dokunma ve gerekçesini handoff'un `keyDecisions` alanına yaz.",
          ]
          : []),
        // PR henüz yok: `gh pr comment` ile cevap yazılacak yer yok.
        ...(opts.source === "local" || opts.source === "static" ? ["PR henüz açılmadı; yorumlara GitHub'da cevap yazma."] : []),
        // Bulgu projenin kendi kurallarından (analizör, OpenGrep). Kuralı
        // susturmak bulguyu "çözer" ama kusuru PR'a taşır.
        ...(opts.source === "static"
          ? ["Kuralı susturma: `#pragma warning disable`, `// nosemgrep`, `[SuppressMessage]`, `.editorconfig` ya da kural dosyası değişikliği YASAK. Bulgu yanlış pozitifse koda dokunma, gerekçeyi `keyDecisions`a yaz."]
          : []),
        ...(opts.note ? ["", "## İnsan notu", opts.note] : []),
      ]
    ).concat([
      ...scopeLines,
      "\nWorktree'de düzelt; commit/push orkestratörde. Bitince tam bir HANDOFF_JSON bloğu yaz.",
    ]).join("\n");
    const baseRef = this.diffBase(jobId, profile);
    const handoffId = opts.source === "local" ? "local-review" : opts.source === "static" ? "static-review" : roleName === "developer" ? "review" : "devops";

    // Yeniden denemenin sebebi ve aynı adımın son devri. DevOps her
    // iterasyonda YENİ oturum açar — önceki turu hiç görmez, tam not gider.
    // Developer kendi oturumunu sürdürür; ona yalnız sebep.
    const retry = this.pendingRetry.get(jobId);
    this.pendingRetry.delete(jobId);
    let retryNote = "";
    if (retry) {
      const last = this.lastHandoff(jobId, (k) => k.startsWith(`${handoffId}-`));
      const full = roleName !== "developer";
      retryNote = `\n\n${renderRetryNote(retry, { rejected: last?.rejected ?? null, ...(full ? { handoff: last?.handoff ?? null } : {}), full })}`;
      this.notice(jobId, `Yeniden deneme: önceki hata${retry.errorCode ? ` (${retry.errorCode})` : ""} ${label}'a iletildi.`);
    }
    const promptWithRetry = `${prompt}${retryNote}`;
    const runAgent = async (text: string, resumeSessionId: string | null): Promise<RunResult> => {
      const channel = new LiveInputChannel();
      this.channels.set(jobId, channel);
      try {
        return await this.deps.runner.run({
          jobId, role: roleName,
          prompt: text,
          ...this.roleModel(jobId, profile, role, "claude-sonnet-5-5"),
          maxTurns: role?.maxTurns ?? 60, maxBudgetUsd: role?.maxBudgetUsd ?? 3,
          cwd: rt.agentCwd,
          permissionMode: "bypassPermissions",
          // `gh api` inceleme başlıklarını okumak için (GraphQL; `isResolved`
          // REST'te yok). `gh pr comment` ve `gh api --method PATCH` yoruma
          // CEVAP yazmak için: düzeltilmeyen bir yorumun gerekçesi PR'da kalmalı.
          allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(gh pr view*)", "Bash(gh pr checks*)", "Bash(gh pr comment*)", "Bash(gh run *)", "Bash(gh api*)", "Bash(git diff*)", "Bash(git status*)", "Bash(git log*)"],
          // Release workflow'unu tetiklemek agent'a kapalı: yayın yalnız insan
          // ya da profildeki takvimle çıkar (bkz. `release/service.ts`). `gh api`
          // açık olduğu için dispatch ucu da ayrıca kapatılır.
          disallowedTools: ["Bash(gh pr merge*)", "Bash(gh pr close*)", "Bash(gh workflow run*)", "Bash(gh api*dispatches*)", "Bash(git push*)", "Bash(git commit*)", "Bash(git reset*)", "Bash(git clean*)"],
          systemPrompt: loadRolePrompt(roleName),
          resumeSessionId,
          ...this.askUserFor(jobId, profile),
          channel,
          transport: rt.transport,
          onTurn: (turn) => this.onLiveTurn(jobId, profile, channel, turn.text, "HANDOFF_JSON"),
        });
      } finally {
        channel.close();
        if (this.channels.get(jobId) === channel) this.channels.delete(jobId);
      }
    };
    // DevOps: iterasyon başına yeni oturum (plan kararı). Developer ise
    // KENDİ oturumunu sürdürür: runner işin rol başına tek açık oturumunu
    // tutuyor, yeni oturum Developing'in resume edeceği kimliği ezerdi.
    // Yazdığı kodun bağlamı da yorumu doğrulamak için zaten gerekli.
    let run = await runAgent(promptWithRetry, roleName === "developer" ? this.roleSessionId(jobId, "developer") : null);
    // Doğrulama turları: kırmızı derleme/test aynı oturuma geri bildirim olarak
    // döner (DevOps da bu düzeltmenin bağlamını taşısın diye kendi oturumunu
    // sürdürür). Tavan düzeltme başına; işin `build` sayacını yakmaz.
    const maxAttempts = profile.limits.maxLoops.build;
    const baselineCache: { value?: SuiteOutcome[] } = {};
    for (let attempt = 1; ; attempt++) {
      if (roleName === "developer" && run.sessionId) this.sessions.set(`${jobId}:developer`, run.sessionId);
      if (run.subtype === "error" || run.subtype === "quota") {
        this.fail(jobId, roleName === "developer" ? "review_error" : "devops_error", `${label} koşusu bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
        return { ok: false, changed: false };
      }
      await this.resolveHandoff(rt.executor, jobId, `${handoffId}-${iteration}${attempt > 1 ? `-v${attempt}` : ""}`, run.text, worktree, baseRef);
      const verdict = await this.verifyFix(jobId, profile, rt, worktree, baseRef, baselineCache);
      if (verdict.kind === "forbidden") {
        this.fail(jobId, "forbidden_flag", verdict.message);
        return { ok: false, changed: false };
      }
      if (verdict.kind === "ok") break;
      if (attempt >= maxAttempts || verdict.retryable === false) {
        // Kırık düzeltme commit'lenmez: uzak CI derlemiyorsa push'lanan her
        // kırmızı doğrudan PR'a girer. Stash'te durur — insan geri alabilir.
        await execGit(rt.executor, worktree, ["stash", "push", "--include-untracked", "--quiet", "-m", `ahtapot-red-fix ${handoffId}-${iteration}`]);
        this.notice(jobId, `${label} ${iteration}: düzeltme ${attempt} denemede ${verdict.summary}; commit'lenmedi, stash'e alındı.`);
        return { ok: true, changed: false, verifyFailed: verdict.summary };
      }
      this.notice(jobId, `${label} ${iteration}: düzeltme ${verdict.summary} (${attempt}/${maxAttempts}); geri gönderiliyor.`);
      run = await runAgent(
        `<feedback>\nDüzeltmen commit'lenmeden önce yerelde doğrulandı ve ${verdict.summary}.\n\n${verdict.feedback}\n</feedback>\n\nDüzelt ve bitince tam bir HANDOFF_JSON bloğu yaz.`,
        run.sessionId ?? null,
      );
    }
    const head = (await execGit(rt.executor, worktree, ["rev-parse", "HEAD"])).trim();
    await this.commitPhase(rt.executor, worktree, profile, 998,
      opts.source === "local" ? `Yerel inceleme düzeltmesi ${iteration}` : opts.source === "static" ? `Statik analiz düzeltmesi ${iteration}` : roleName === "developer" ? `İnceleme düzeltmesi ${iteration}` : `DevOps düzeltmesi ${iteration}`);
    const after = (await execGit(rt.executor, worktree, ["rev-parse", "HEAD"])).trim();
    // Commit OLUŞMADIYSA itilecek bir şey yok. DevOps "önceden kırık, benim
    // işim değil" deyip hiçbir dosyaya dokunmayabiliyor (ölçüldü) ve o
    // durumda push boşuna koşup uzak dalla yarışa giriyordu.
    if (head === after) {
      this.notice(jobId, `${label} ${iteration}: değişiklik yok, push atlanıyor.`);
      return { ok: true, changed: false };
    }
    bumpLoop(this.deps.db, jobId, "fix_push", Number.MAX_SAFE_INTEGER);
    return { ok: true, changed: true };
  }

  /**
   * Düzeltmeyi commit'lemeden önce doğrular (`workflow.verifyFixes`).
   *
   * Orkestratör koşar, agent değil: düzeltme rolünün araçları derleme komutu
   * içermiyor ve üretici taraf güvenilmez. Testlerde baseline, commit'lenmemiş
   * düzeltme stash'lenerek HEAD'de ölçülür — önceden kırık test düzeltmeyi
   * kırmızıya çekmez.
   */
  private async verifyFix(
    jobId: string,
    profile: ProjectProfile,
    rt: { executor: CommandExecutor; workdir: string },
    worktree: string,
    baseRef: string,
    baselineCache: { value?: SuiteOutcome[] },
  ): Promise<{ kind: "ok" } | { kind: "red"; summary: string; feedback: string; retryable?: false } | { kind: "forbidden"; message: string }> {
    const mode = profile.workflow.verifyFixes;
    if (mode === "none") return { kind: "ok" };
    // Değişiklik yoksa doğrulanacak bir şey yok (gerekçeyle reddedilen yorum).
    const dirty = (await execGit(rt.executor, worktree, ["status", "--porcelain", "--untracked-files=all"])).trim();
    if (!dirty) return { kind: "ok" };
    // `setupDone` yalnız bellekte: sunucu yeniden başlayıp iş yerel
    // incelemeden ya da CIWatch'tan sürerse konteyner yenidir ve kurulum
    // yapılmamıştır. Hazırlıksız derleme ortam yüzünden kırmızı döner ve
    // geçerli düzeltme stash'e gider. İkinci çağrı sessizce döner.
    await this.ensureSetup(jobId, profile, rt);

    this.notice(jobId, `Düzeltme doğrulanıyor: ${mode === "build" ? "derleme" : "derleme + test"}.`);
    let build: BuildRunOutput;
    try {
      build = await this.deps.gate.run({
        jobId, phaseId: null, profile,
        workdir: rt.workdir,
        changedFiles: await changedFiles(rt.executor, worktree, baseRef),
        executor: rt.executor,
        artifactsDir: this.deps.artifactsDir,
      });
    } catch (err) {
      if (err instanceof ForbiddenFlagError) return { kind: "forbidden", message: err.message };
      throw err;
    }
    if (!build.ok) return { kind: "red", summary: "derleme kırmızı", feedback: renderBuildFeedback(build.results) };
    if (mode === "build") return { kind: "ok" };

    const suiteInput = { jobId, profile, workdir: rt.workdir, worktreePath: worktree, executor: rt.executor, artifactsDir: this.deps.artifactsDir };
    // Baseline HEAD'de ölçülür ve HEAD bir `runDevOps` boyunca değişmez
    // (commit döngüden sonra): denemeler arasında yeniden koşmak test
    // süresini her denemede ikiye katlardı.
    let baseline: SuiteOutcome[] = [];
    if (profile.test.baseline) {
      baseline = baselineCache.value ?? await measureBaseline(this.deps.tests, suiteInput);
      baselineCache.value = baseline;
    }
    const results = diffAgainstBaseline(baseline, await this.deps.tests.runSuites({ ...suiteInput, kind: "run" }));
    // Ortam kurulamadı: agent'a geri göndermek boşuna — düzeltecek kod yok.
    const unready = results.filter((r) => r.setupError);
    if (unready.length > 0) {
      return {
        kind: "red", retryable: false, feedback: "",
        summary: `test ortamı hazırlanamadı (${unready.map((r) => `${r.suiteId}: ${r.setupError}`).join("; ")})`,
      };
    }
    const red = results.filter((r) => r.failed > 0);
    if (red.length > 0) {
      return { kind: "red", summary: `testler kırmızı (${red.map((r) => `${r.suiteId}: ${r.failed}`).join(", ")})`, feedback: renderTestFeedback(results) };
    }
    // Yeşilin NEYİ kapsadığı yazılır: "derleme + test" notundan sonra yalnız
    // derleme satırları görülüp testlerin koşup koşmadığı sorulmuştu
    // (2026-10-13). `runAt: "qa"` takımı yoksa bu da açıkça söylenir.
    this.notice(jobId, `Düzeltme doğrulandı: derleme yeşil · ${results.length > 0
      ? results.map((r) => `${r.suiteId} ${r.total > 0 ? `${r.passed}/${r.total}` : `çıkış ${r.exitCode ?? "?"}`}${r.preexistingFailures.length ? ` (${r.preexistingFailures.length} önceden kırık)` : ""}`).join(" · ")
      : "koşacak test takımı yok (runAt: qa)"}.`);
    return { kind: "ok" };
  }

  /** Planın sonuna düzeltme safhası ekler; aynı onay makinesinden geçer. */
  private addFixPhase(jobId: string, title: string, rationale: string): void {
    const plan = this.approvedPlan(jobId);
    const phases = this.deps.db.select({ order: schema.planPhases.order }).from(schema.planPhases).where(eq(schema.planPhases.planId, plan.id)).all();
    const order = phases.reduce((m, p) => Math.max(m, p.order), -1) + 1;
    this.deps.db.insert(schema.planPhases).values({
      id: newId(), planId: plan.id, jobId, order, title, rationale, files: [], risk: "medium", status: "pending",
    }).run();
  }

  // ── Geliştirme (safhalı) ─────────────────────────────────────────────────

  private decidePhase(jobId: string, profile: ProjectProfile, phaseId: string, decision: "approve" | "reject", comment: string): { jobId: string; state: JobState; developing: Promise<void> } {
    const phase = this.deps.db.select().from(schema.planPhases).where(eq(schema.planPhases.id, phaseId)).all()[0];
    if (!phase) throw new EngineError("not_found", `safha bulunamadı: ${phaseId}`);
    const { job } = this.load(jobId);

    if (decision === "approve") {
      this.deps.db.update(schema.planPhases).set({ status: "approved", approvedAt: isoNow() }).where(eq(schema.planPhases.id, phaseId)).run();
      this.setPhase(jobId, "starting", "Developing");
      // Commit artık konteynerde koşuyor (worktree volume'de) ve ASENKRON.
      // Durum güncellemesi senkron kalır — çağıran anında "Developing" görür —
      // ama commit sıradaki safha başlamadan ÖNCE bitmeli: ikisi aynı
      // promise'te zincirlenir.
      const worktree = job.worktreePath;
      const developing = (async () => {
        if (worktree) {
          // Onay commit'i kaldırır: safha kendi commit'iyle iz bırakır, PR'da okunur.
          //
          // Commit HATASI İŞİ DÜŞÜRÜR, SÜRECİ DEĞİL. `runDeveloping` kendi
          // hatalarını `fail()` ile yakalıyor; bu zincir onun dışında kaldığı
          // için yakalanmamış bir reddetme tüm sunucuyu öldürüyordu (yaşandı
          // 2026-09-17: eski bir işin `worktree_path`i host yoluydu, `docker
          // exec` "Cwd must be an absolute path" dedi, süreç çöktü).
          try {
            const rt = await this.acquireRuntime(jobId, profile);
            await this.commitPhase(rt.executor, worktree, profile, phase.order, phase.title);
          } catch (err) {
            this.fail(jobId, "commit_failed", err instanceof Error ? err.message : String(err));
            return;
          }
        }
        await this.runDeveloping(jobId, null);
      })();
      return { jobId, state: "Developing", developing };
    }

    // Red: aynı safha, aynı Developer oturumu, yorum <feedback> ile.
    this.deps.db.update(schema.planPhases).set({ status: "running" }).where(eq(schema.planPhases.id, phaseId)).run();
    this.setPhase(jobId, "starting", "Developing");
    return { jobId, state: "Developing", developing: this.runDeveloping(jobId, `Safha reddedildi. İnsan yorumu:\n${comment || "(gerekçe verilmedi)"}`) };
  }

  /**
   * Sıradaki safhayı koşturur: Developer → build → onay kapısı.
   *
   * Kırmızı build Developer'a `<feedback>` ile döner; döngü sayacı tavanı
   * aşınca insan çağrılır. Bütün safhalar onaylanınca Building → QACases.
   */
  private async runDeveloping(jobId: string, feedback: string | null, retry: RetryContext | null = null): Promise<void> {
    this.busy.add(jobId);
    // Otopilotta açılan safha kapısı `busy` kalktıktan SONRA onaylanır (`finally`).
    let autoGate: string | null = null;
    try {
      const { job, profile } = this.load(jobId);
      if (!job.worktreePath) throw new Error("işin worktree'si yok");
      const plan = this.approvedPlan(jobId);
      const doc = PlanDocumentSchema.parse(plan.document);
      const phase = this.nextPhase(plan.id);

      if (!phase) {
        // `final-phase`: ara safhalar derlenmedi, TEK build burada koşar.
        // `each-phase`de son safha zaten derlenip onaylandı, tekrar edilmez.
        //
        // Canlı ortamın istediği TAM build artık BURADA koşmaz: `buildBeforeStart`
        // build'i canlı konteynerin `command`'ına zincirliyor (live/buildChain.ts).
        // Eskiden burada bir kez daha koşuyordu — aynı build iki ortamda iki kez.
        if (profile.build.when === "final-phase") {
          const done = await this.runFinalBuild(jobId, profile, job.worktreePath, plan.id);
          // Kırmızı build son safhayı yeniden açtı; o tur kendi akışını sürdürür.
          if (!done) return;
        }
        // `runFinalBuild` işi ZATEN `Building`e aldı; tekrar geçmek kendine
        // geçiş olur ve reddedilir (aynı tuzak safha kapısında da vardı).
        const { job: atBuild } = this.load(jobId);
        if (atBuild.state === "Building") this.setPhase(jobId, "done", "Building");
        else this.move(jobId, "Building", "done", "tüm safhalar onaylandı", "system");
        if (profile.live?.enabled && this.deps.live) {
          await this.startLiveTest(jobId, profile, job.worktreePath);
          return;
        }
        await this.enterQa(jobId, profile, job.worktreePath);
        return;
      }

      // Yeni safha (ilk koşu) geri bildirimle açılmış olabilir (canlı test
      // düzeltmesi): o zaman safha bağlamı + geri bildirim birlikte gider.
      const freshPhase = phase.status === "pending";
      this.deps.db.update(schema.planPhases).set({ status: "running" }).where(eq(schema.planPhases.id, phase.id)).run();
      this.setPhase(jobId, "running", "Developing");

      const rt = await this.acquireRuntime(jobId, profile);

      // ORTAM HAZIRLIĞI — Developer'dan ÖNCE, iş boyunca bir kez.
      // GitHub Actions düzeni: önce bağımlılık kurulur, sonra geliştirme, sonra
      // derleme. Kurulum agent'ın işi değil; kurulmamış bağımlılığı Developer
      // "benim düzeltmem gereken build hatası" sanıp altı modülün npm ci'sini
      // elle koşturdu ve tur sessizlik gözcüsüne takıldı (Sevkiyat, 2026-09-16).
      await this.ensureSetup(jobId, profile, rt);

      const role = profile.agents.roles["developer"];
      const devPick = this.developerPick(jobId, profile, phase);
      const channel = new LiveInputChannel();
      this.channels.set(jobId, channel);

      const feedbackBlock = feedback ? `<feedback>\n${feedback}\n</feedback>` : "";
      const note = this.planApprovalNote(jobId, plan.id);
      // Geri bildirimsiz ama safha zaten `running`: önceki koşu yarıda kaldı
      // (yeniden deneme, sunucu yeniden başlaması). Söylenmezse Developer ağaçta
      // işin bittiğini görüp "zaten uygulanmış" der ve HANDOFF_JSON'suz durur;
      // tur bloksuz bitince iş insan mesajı beklemeye kalır.
      const resumeNote = !freshPhase
        ? "\n\n<resume>\nBu safhanın önceki koşusu yarıda kesildi; ağaçtaki değişiklikler o koşudan kalmış olabilir. Safhaya göre doğrula, eksiği tamamla ve bitince tam bir HANDOFF_JSON bloğu yaz. Sonraki safhaya geçme.\n</resume>"
        : "";
      const graph = await this.prepareCodeGraph(jobId, profile, rt, "developer");
      const phasePrompt = renderDeveloperPrompt(job, profile, doc, phase, this.previousHandoffs(jobId, phase.order), note) + await this.codeMapNote(rt) + (graph?.note ?? "");

      // YENİDEN DENEME: düşme sebebi her iki yola; bu safhanın son devri ve
      // reddedilen HANDOFF_JSON yalnız YENİ oturuma — devralınan oturum onları
      // zaten bağlamında görüyor. Yeni oturumda bunlar olmadan Developer ağaçtaki
      // yarım işin hangi kararla yazıldığını bilemez.
      let shortRetry = "";
      let fullRetry = "";
      if (retry) {
        const last = this.lastHandoff(jobId, (k) => k === phase.id);
        shortRetry = `\n\n${renderRetryNote(retry, { rejected: last?.rejected ?? null, full: false })}`;
        fullRetry = `\n\n${renderRetryNote(retry, { rejected: last?.rejected ?? null, handoff: last?.handoff ?? null, full: true })}`;
        this.notice(jobId, `Yeniden deneme: önceki hata${retry.errorCode ? ` (${retry.errorCode})` : ""} Developer'a iletildi${last ? "; bu safhanın son devri yeni oturum için hazır" : ""}.`);
      }

      // Otopilot notu HER varyanta eklenir: devralınan oturumda yalnız "düzelt"
      // gidiyor, sistem prompt'u ise yalnız yeni oturumda geçerli — iş ortasında
      // açılan otopilot ancak böyle ulaşır. Rol prompt'undaki "sor ve bekle"yi ezer.
      // Seçici notu da aynı sebeple her varyantta: profil iş ortasında açılabilir.
      const autopilotNote = (job.autopilot
        ? "\n\n<autopilot>\nOtopilot açık: bu adımda insan beklenmiyor. Belirsizlikte soru sorma, makul olanı seç; kararı ve varsayımı HANDOFF_JSON'da belirt.\n</autopilot>"
        : "") + renderSelectorNote(profile);
      const prompt = (!feedback
        ? `${phasePrompt}${resumeNote}${shortRetry}`
        : freshPhase
          ? `${phasePrompt}\n\n${feedbackBlock}`
          : `${feedbackBlock}\n\nDüzelt ve bitince tam bir HANDOFF_JSON bloğu yaz.`) + autopilotNote;
      // Runner oturumu bırakırsa (taşma, kayıp transcript) yeni oturum yalnız
      // "düzelt" görürse safhayı bilmez; tam bağlam + yarıda kaldı notu gider.
      const freshPrompt = feedback && !freshPhase
        ? `${phasePrompt}${resumeNote}\n\n${feedbackBlock}${autopilotNote}`
        : !feedback
          ? `${phasePrompt}${resumeNote}${fullRetry}${autopilotNote}`
          : prompt;

      let run: RunResult;
      try {
        run = await this.deps.runner.run({
          jobId,
          role: "developer",
          prompt,
          // Postplan triage seçtiyse onun modeli. Parametre olarak DEĞİL
          // kayıttan okunuyor: `runDeveloping` altı ayrı yerden çağrılıyor
          // (build kırmızı, QA kırmızı, canlı test reddi, safha onayı, engel
          // kapısı, plan onayı) ve her birine aynı seçimi taşıtmak, bir tanesini
          // unutunca sessizce yanlış modele düşmek demekti.
          //
          // Merdivenden YENİDEN çözülüyor (kural 8): kapı yükündeki model
          // dizesine güvenilmez, profil o arada değişmiş olabilir.
          model: devPick.model,
          effort: devPick.effort,
          maxTurns: role?.maxTurns ?? 150,
          maxBudgetUsd: role?.maxBudgetUsd ?? 10,
          cwd: rt.agentCwd,
          permissionMode: "bypassPermissions",
          // Commit/PR insan onayından sonra orkestratörün işi; agent git tarihine dokunmaz.
          disallowedTools: ["Bash(git commit*)", "Bash(git push*)", "Bash(git checkout*)", "Bash(git clean*)", "Bash(git reset*)"],
          systemPrompt: loadRolePrompt("developer"),
          resumeSessionId: this.roleSessionId(jobId, "developer"),
          freshPrompt,
          ...this.askUserFor(jobId, profile),
          channel,
          transport: rt.transport,
          ...(graph ? { codeGraph: graph.config } : {}),
          onTurn: (turn) => this.onLiveTurn(jobId, profile, channel, turn.text, "HANDOFF_JSON"),
        });
      } finally {
        channel.close();
        this.channels.delete(jobId);
      }
      if (run.sessionId) this.sessions.set(`${jobId}:developer`, run.sessionId);
      if (run.subtype === "error" || run.subtype === "quota") {
        this.fail(jobId, "developer_error", `Developer koşusu bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
        return;
      }

      const baseRef = this.diffBase(jobId, profile);
      // Prompt'taki numaralandırmayla aynı kaynak (`renderDeveloperPrompt`): sıra ile eşlenir.
      const acceptance = doc.phases.find((p) => p.order === phase.order)?.acceptance ?? [];
      const handoff = await this.resolveHandoff(
        rt.executor, jobId, phase.id, run.text, job.worktreePath, baseRef,
        (h) => ({ ...h, acceptanceEvidence: completeAcceptanceEvidence(h.acceptanceEvidence, acceptance) }),
      );

      // Build: orkestratör koşar, agent değil.
      //
      // `final-phase` profilinde ARA safhalar derlenmez: build yalnız son
      // safhadan sonra, `nextPhase` boş döndüğünde koşar (aşağıdaki dala bak).
      // Safha yine onaya çıkar, yalnız build sonucu taşımaz.
      let buildOk = true;
      let results: BuildResult[] = [];
      if (profile.build.when === "each-phase") {
        this.move(jobId, "Building", "running", `safha ${phase.order + 1} derleniyor`, "system");
        try {
          const out = await this.deps.gate.run({
            jobId, phaseId: phase.id, profile,
            workdir: rt.workdir,
            changedFiles: await changedFiles(rt.executor, job.worktreePath, baseRef),
            executor: rt.executor,
            artifactsDir: this.deps.artifactsDir,
          });
          buildOk = out.ok;
          results = out.results;
        } catch (err) {
          if (err instanceof ForbiddenFlagError) {
            this.fail(jobId, "forbidden_flag", err.message);
            return;
          }
          throw err;
        }
      }

      if (!buildOk) {
        const loop = bumpLoop(this.deps.db, jobId, "build", profile.limits.maxLoops.build);
        if (loop.exceeded) {
          this.fail(jobId, "build_loop", `build ${loop.count} kez kırmızı; tavan ${profile.limits.maxLoops.build}`);
          return;
        }
        this.move(jobId, "Developing", "starting", `build kırmızı (${loop.count}/${profile.limits.maxLoops.build})`, "system");
        await this.runDeveloping(jobId, renderBuildFeedback(results));
        return;
      }

      this.deps.db.update(schema.planPhases).set({ status: "awaiting_approval" }).where(eq(schema.planPhases.id, phase.id)).run();
      const payload: PhaseGatePayload = {
        phaseId: phase.id, order: phase.order, title: phase.title, handoff,
        diff: await diffSummary(rt.executor, job.worktreePath),
        build: results,
        outOfPlanFiles: outOfPlanFiles(await phaseChangedFiles(rt.executor, job.worktreePath), phase.files),
      };
      const gateId = this.openApproval(jobId, "phase", phase.id, payload);
      // `final-phase`de iş ZATEN `Developing`: ara safhada build koşmadığı için
      // `Building`e hiç geçilmedi ve `move(...,"Developing",...)` kendine geçiş
      // olurdu — durum makinesi onu reddeder, iş NeedsAttention'a düşer ve kapı
      // `pending` asılı kalır (yaşandı 2026-09-18: safha 5 onay bekliyor
      // görünürken Developer onu baştan yazmaya başladı).
      //
      // Durum değişmiyorsa YALNIZ faz güncellenir; kural 1 korunuyor: durum
      // geçişi hâlâ `transition()` üzerinden, burada geçiş YOK.
      const { job: cur } = this.load(jobId);
      if (cur.state === "Developing") {
        this.setPhase(jobId, "waiting", "Developing");
      } else {
        this.move(jobId, "Developing", "waiting", `safha ${phase.order + 1} onay bekliyor`, "agent");
      }
      this.deps.hub.publish(jobId, { type: "approval.required", gateId, kind: "phase", payload });
      autoGate = gateId;
    } catch (err) {
      this.fail(jobId, "developing_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(jobId);
    }
    // Bayrak burada yeniden okunur (`autoApprovePhase`): koşu sürerken kapatıldıysa kapı insanda kalır.
    if (autoGate) this.autoApprovePhase(jobId, autoGate);
  }

  /**
   * `final-phase` profilinde tüm safhalar onaylandıktan sonra koşan TEK build.
   *
   * Dönüş: `true` → yeşil, akış QA/canlı teste devam edebilir. `false` → build
   * kırmızı ve SON safha yeniden açıldı; `runDeveloping` yeni turu başlattı,
   * çağıran hiçbir şey yapmamalı.
   *
   * Kırmızı build son safhaya yazılır çünkü hatanın hangi safhadan geldiği
   * bilinmiyor — `final-phase`in kabul edilmiş bedeli budur. Developer tüm
   * worktree'yi görüyor, geri bildirim tam build çıktısını taşıyor.
   */
  private async runFinalBuild(
    jobId: string,
    profile: ProjectProfile,
    worktreePath: string,
    planId: string,
  ): Promise<boolean> {
    const baseRef = this.diffBase(jobId, profile);
    const rt = await this.acquireRuntime(jobId, profile);

    this.move(jobId, "Building", "running", "tüm safhalar bitti, derleniyor", "system");
    let out: BuildRunOutput;
    try {
      out = await this.deps.gate.run({
        jobId, phaseId: null, profile,
        workdir: rt.workdir,
        changedFiles: await changedFiles(rt.executor, worktreePath, baseRef),
        executor: rt.executor,
        artifactsDir: this.deps.artifactsDir,
      });
    } catch (err) {
      if (err instanceof ForbiddenFlagError) {
        this.fail(jobId, "forbidden_flag", err.message);
        return false;
      }
      throw err;
    }
    if (out.ok) return true;

    await this.returnToDeveloperForBuild(jobId, profile, planId, renderBuildFeedback(out.results));
    return false;
  }

  /**
   * Kırmızı build → Developer. Sayaç artar, tavan aşılırsa insan çağrılır.
   *
   * İki yerden çağrılır: build agent konteynerinde koştuğunda (`runFinalBuild`)
   * ve canlı konteynerin zincirinde düştüğünde (`startLiveTest`). Build'in
   * NEREDE koştuğu değişti ama kırmızıya verilen cevap aynı kalmalı.
   */
  private async returnToDeveloperForBuild(
    jobId: string,
    profile: ProjectProfile,
    planId: string,
    feedback: string,
  ): Promise<void> {
    const loop = bumpLoop(this.deps.db, jobId, "build", profile.limits.maxLoops.build);
    if (loop.exceeded) {
      this.fail(jobId, "build_loop", `build ${loop.count} kez kırmızı; tavan ${profile.limits.maxLoops.build}`);
      return;
    }

    // Son safhayı yeniden aç: `nextPhase` onu bulsun ve Developer aynı safha
    // bağlamıyla koşsun. Onay commit'i zaten atıldı, düzeltme yeni commit olur.
    const last = this.deps.db.select().from(schema.planPhases)
      .where(eq(schema.planPhases.planId, planId)).orderBy(desc(schema.planPhases.order)).all()[0];
    if (last) {
      this.deps.db.update(schema.planPhases).set({ status: "running" })
        .where(eq(schema.planPhases.id, last.id)).run();
    }
    this.move(jobId, "Developing", "starting", `build kırmızı (${loop.count}/${profile.limits.maxLoops.build})`, "system");
    // `busy` hâlâ bu iş için işaretli; iç içe çağrı onu devralır.
    this.busy.delete(jobId);
    await this.runDeveloping(jobId, feedback);
  }

  private approvedPlan(jobId: string) {
    const plan = this.deps.db.select().from(schema.plans)
      .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.status, "approved")))
      .orderBy(desc(schema.plans.version)).limit(1).all()[0];
    if (!plan) throw new EngineError("no_plan", `onaylı plan yok: ${jobId}`);
    return plan;
  }

  /**
   * Planı onaylayan kapının notu.
   *
   * Plan ekranında açık sorular onayla BİRLİKTE cevaplanabiliyor (UI cevapları
   * onay notuna yazar); not Developer'a ulaşmazsa insanın seçtiği şık yerine
   * Planner'ın varsayımıyla kod yazılır. Onay reddin tersine yeniden planlatmaz,
   * bu yüzden notun tek okuyucusu burası.
   */
  private planApprovalNote(jobId: string, planId: string): string {
    // Sıra KARAR anına göre: notu taşıyan onay en son verilen karardır, en son
    // açılan kapı değil.
    const gate = this.deps.db.select({ comment: schema.approvals.comment }).from(schema.approvals)
      .where(and(
        eq(schema.approvals.jobId, jobId),
        eq(schema.approvals.subjectId, planId),
        eq(schema.approvals.kind, "plan"),
        eq(schema.approvals.status, "approved"),
      ))
      .orderBy(desc(schema.approvals.decidedAt)).limit(1).all()[0];
    return gate?.comment.trim() ?? "";
  }

  /** Onaylanmamış ilk safha (pending / running / awaiting_approval sırayla). */
  private nextPhase(planId: string) {
    return this.deps.db.select().from(schema.planPhases)
      .where(eq(schema.planPhases.planId, planId)).orderBy(asc(schema.planPhases.order)).all()
      .find((p) => p.status !== "approved" && p.status !== "skipped");
  }

  /**
   * Handoff üç katmandan geçer: agent yazar → yoksa orkestratör diff'ten
   * sentezler (synthesized:true) → Zod doğrular. Dosyaya yazılır ve
   * artifacts'a kaydedilir; insan neyin söz neyin tahmin olduğunu görür.
   */
  private async resolveHandoff(
    exec: CommandExecutor, jobId: string, phaseId: string, text: string, worktree: string, baseRef: string,
    // Çağırana özgü tamamlama (ör. Developer safhasında kabul kanıtı). Burada,
    // yazmadan ÖNCE uygulanır: diske ve `previousHandoffs`a giden kopya ile
    // kapıya giden aynı olmalı. `phaseId` plan safhası değil artifact anahtarı
    // olduğundan bu fonksiyon safhanın `acceptance`ını kendisi bilemez.
    complete?: (h: Handoff) => Handoff,
  ): Promise<Handoff> {
    const raw = extractBlock(text, "HANDOFF_JSON");
    const parsed = raw === null ? null : HandoffSchema.safeParse(raw);
    let handoff: Handoff;
    // Sentez agent'ın sözünü (kararlar, sapmalar) siliyordu; reddedilen blok
    // saklanır ve devre bağlanır — yeniden denemede Developer'a geri verilir.
    let rejectedId: string | null = null;
    if (parsed?.success) {
      handoff = parsed.data;
    } else {
      const block = extractTextBlock(text, "HANDOFF_JSON");
      if (block !== null) {
        const issues = parsed
          ? parsed.error.issues.map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`)
          : ["blok geçerli JSON değil"];
        rejectedId = this.saveRejectedBlock(jobId, null, "HANDOFF_JSON", block, issues, phaseId);
      }
      handoff = HandoffSchema.parse({
        completedSteps: [],
        filesTouched: await changedFiles(exec, worktree, baseRef),
        nextAction: "",
        synthesized: true,
      });
      this.notice(jobId, raw === null ? "Developer HANDOFF_JSON yazmadı; diff'ten sentezlendi." : "HANDOFF_JSON şemaya uymuyor; diff'ten sentezlendi.");
    }
    if (complete) handoff = complete(handoff);
    const dir = join(this.deps.artifactsDir, jobId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `handoff-${phaseId}.json`);
    const body = JSON.stringify(handoff, null, 2);
    writeFileSync(path, body);
    this.deps.db.insert(schema.artifacts).values({
      id: newId(), jobId, type: "handoff", path, sizeBytes: Buffer.byteLength(body),
      metadata: { phaseId, synthesized: handoff.synthesized, ...(rejectedId ? { rejectedId } : {}) } as never,
    }).run();
    return handoff;
  }

  /**
   * Reddedilen yapılandırılmış bloğu saklar (`rejected_block` artifact'ı).
   * Maskelenir (kural 4): dosya insana da gösterilebilir, prompt'a da girer.
   */
  private saveRejectedBlock(
    jobId: string, runId: string | null, tag: string, raw: string, issues: string[], phaseId: string | null,
  ): string {
    const max = 60_000;
    const doc: RejectedBlock = {
      tag,
      issues: issues.slice(0, 20).map((i) => scrubSecrets(i)),
      raw: scrubSecrets(raw.slice(0, max)),
      truncated: raw.length > max,
    };
    const id = newId();
    const dir = join(this.deps.artifactsDir, jobId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rejected-${tag.toLowerCase()}-${id}.json`);
    const body = JSON.stringify(doc, null, 2);
    writeFileSync(path, body);
    this.deps.db.insert(schema.artifacts).values({
      id, jobId, runId, type: "rejected_block", path, sizeBytes: Buffer.byteLength(body),
      metadata: { tag, ...(phaseId ? { phaseId } : {}) } as never,
    }).run();
    return id;
  }

  /** `rejected_block` satırını okur; dosya silinmiş ya da bozuksa `null`. */
  private readRejectedBlock(row: { path: string }): RejectedBlock | null {
    try {
      const parsed = RejectedBlockSchema.safeParse(JSON.parse(readFileSync(row.path, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Son reddedilen PLAN_JSON — ondan SONRA bir plan kaydedilmediyse.
   * Kaydedilmiş bir plan varsa red eskidir; geri vermek Planner'ı eski bir
   * belgeye döndürürdü.
   */
  private pendingRejectedPlan(jobId: string): RejectedBlock | null {
    const row = this.deps.db.select().from(schema.artifacts)
      .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.type, "rejected_block")))
      .orderBy(desc(schema.artifacts.createdAt)).all()
      .find((r) => (r.metadata as { tag?: string } | null)?.tag === "PLAN_JSON");
    if (!row) return null;
    const latestPlan = this.deps.db.select({ createdAt: schema.plans.createdAt }).from(schema.plans)
      .where(eq(schema.plans.jobId, jobId))
      .orderBy(desc(schema.plans.createdAt)).limit(1).all()[0];
    // Eşitlikte de eski sayılır: belirsizse eski bloğu geri vermemek güvenli taraf.
    if (latestPlan && latestPlan.createdAt >= row.createdAt) return null;
    return this.readRejectedBlock(row);
  }

  /**
   * Anahtarı `match`e uyan son devir (onaylı olsun olmasın) ve sentezlendiyse
   * yerine geçtiği reddedilen blok. `previousHandoffs` yalnız ÖNCEKİ onaylı
   * safhaları verir; yarıda kalan adımın kendi devri yeniden denemede hiç
   * okunmuyordu. Anahtar `resolveHandoff`in `phaseId`i: safha kimliği,
   * `qa-<id>`, `devops-<n>`, `review-<n>`…
   */
  private lastHandoff(jobId: string, match: (key: string) => boolean): { handoff: Handoff; rejected: RejectedBlock | null } | null {
    const rows = this.deps.db.select().from(schema.artifacts)
      .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.type, "handoff")))
      .orderBy(desc(schema.artifacts.createdAt)).all();
    const row = rows.find((r) => {
      const key = (r.metadata as { phaseId?: string } | null)?.phaseId;
      return key !== undefined && match(key);
    });
    if (!row) return null;
    let handoff: Handoff;
    try {
      const parsed = HandoffSchema.safeParse(JSON.parse(readFileSync(row.path, "utf8")));
      if (!parsed.success) return null;
      handoff = parsed.data;
    } catch {
      return null;
    }
    const rejectedId = (row.metadata as { rejectedId?: string } | null)?.rejectedId;
    const rejRow = rejectedId
      ? this.deps.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, rejectedId)).all()[0]
      : undefined;
    return { handoff, rejected: rejRow ? this.readRejectedBlock(rejRow) : null };
  }

  /** Önceki safhaların handoff'ları — Developer bağlamı buradan taşır. */
  private previousHandoffs(jobId: string, beforeOrder: number): Handoff[] {
    const rows = this.deps.db.select().from(schema.artifacts)
      .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.type, "handoff")))
      .orderBy(asc(schema.artifacts.createdAt)).all();
    const out: Handoff[] = [];
    for (const r of rows) {
      const phaseId = (r.metadata as { phaseId?: string } | null)?.phaseId;
      const phase = phaseId ? this.deps.db.select({ order: schema.planPhases.order, status: schema.planPhases.status }).from(schema.planPhases).where(eq(schema.planPhases.id, phaseId)).all()[0] : null;
      if (!phase || phase.order >= beforeOrder || phase.status !== "approved") continue;
      try {
        const parsed = HandoffSchema.safeParse(JSON.parse(readFileSync(r.path, "utf8")));
        if (parsed.success) out.push(parsed.data);
      } catch {
        /* silinmiş artifact bağlamı düşürmez */
      }
    }
    return out;
  }

  /**
   * Merge edilen işin yaşadıkları — kod haritasına ders hammaddesi (karar §39).
   *
   * Kaynaklar: bütün rollerin handoff'ları (tuzak, çözülemeyen madde, plandan
   * sapma), kırmızı build'ler ve insanın safha/canlı test retleri. Ayıklama
   * burada yapılmaz: genellenebilir olanı haritacı kodla doğrulayıp seçer.
   * Metin LLM prompt'una ve diske gider; sırlardan arındırılır (kural 4).
   * Profilde kapalıysa ya da not yoksa `null`.
   */
  private jobLessons(jobId: string, profile: ProjectProfile): CodeMapLessons | null {
    if (!profile.agents.codeMap.enabled || !profile.agents.codeMap.learn) return null;
    const { job } = this.load(jobId);
    // `filesTouched` primary repo köküne göreli: sentezde `changedFiles`
    // primary worktree'de koşar, agent'ın cwd'si de orası. Ders workspace
    // köküne göreli yol taşır; primary alt dizindeyse önek eklenir.
    const primary = (profile.workspace.repos.find((r) => r.primary)?.path ?? ".")
      .replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
    const toWorkspace = (f: string) => {
      const p = f.replace(/\\/g, "/").replace(/^\.\//, "");
      return primary ? `${primary}/${p}` : p;
    };
    const files = new Set<string>();
    const notes: CodeMapLessons["notes"] = [];
    const add = (source: CodeMapLessons["notes"][number]["source"], text: string) => {
      const t = scrubSecrets(text.trim()).slice(0, 1500);
      if (t && !notes.some((n) => n.text === t)) notes.push({ source, text: t });
    };

    const handoffs = this.deps.db.select().from(schema.artifacts)
      .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.type, "handoff")))
      .orderBy(asc(schema.artifacts.createdAt)).all();
    for (const r of handoffs) {
      let h: Handoff;
      try {
        const parsed = HandoffSchema.safeParse(JSON.parse(readFileSync(r.path, "utf8")));
        if (!parsed.success) continue;
        h = parsed.data;
      } catch {
        continue;
      }
      for (const f of h.filesTouched) files.add(toWorkspace(f));
      // Sentezlenmiş handoff'un tuzağı agent'ın sözü değil, orkestratörün tahmini.
      if (h.synthesized) continue;
      for (const g of h.gotchas) add("gotcha", g);
      for (const b of h.blockers) add("blocker", [b.what, b.why].filter(Boolean).join(" — ") + (b.refs.length ? ` (${b.refs.join(", ")})` : ""));
      for (const d of h.deviations) if (d.reason) add("deviation", `Plan: ${d.planned} → yapılan: ${d.actual}. Neden: ${d.reason}`);
    }

    const red = this.deps.db.select().from(schema.builds)
      .where(eq(schema.builds.jobId, jobId)).orderBy(asc(schema.builds.createdAt)).all()
      .filter((b) => !b.skipped && b.exitCode !== 0);
    for (const b of red.slice(-5)) {
      let tail = "";
      try {
        tail = b.logRef ? readFileSync(b.logRef, "utf8").split("\n").filter((l) => l.trim()).slice(-12).join("\n") : "";
      } catch {
        /* log yoksa yalnız adım adı */
      }
      add("build", `Build adımı "${b.stepName}" düştü (çıkış ${b.exitCode ?? "zaman aşımı"}), sonra düzeltildi.${tail ? `\n${tail}` : ""}`);
    }

    const rejected = this.deps.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.status, "rejected"))).all()
      .filter((a) => (a.kind === "phase" || a.kind === "live_test") && a.comment.trim());
    for (const a of rejected) add("review", `İnsan ${a.kind === "phase" ? "safhayı" : "canlı testi"} reddetti: ${a.comment}`);

    if (notes.length === 0) return null;
    return { jobId, title: scrubSecrets(job.title), files: [...files], notes };
  }

  /**
   * Onaylı safhayı worktree'de commit'ler. Kimlik marka botu; agent kimliği değil.
   *
   * Worktree volume'de olduğu için git de yürütücüde (konteynerde) koşar.
   */
  private async commitPhase(
    exec: CommandExecutor,
    worktree: string,
    profile: ProjectProfile,
    order: number,
    title: string,
  ): Promise<void> {
    await execGit(exec, worktree, ["add", "-A"]);
    const staged = (await execGit(exec, worktree, ["diff", "--cached", "--name-only"])).trim();
    if (!staged) return;
    // 997-999: orkestratörün kendi commit'leri (statik otomatik düzeltme /
    // DevOps düzeltmesi / QA testleri), safha değil.
    const type = order === 999 ? "test" : order === 998 ? "ci" : order === 997 ? "style" : "feat";
    const message = profile.git.commitTemplate
      .replaceAll("{type}", type)
      .replaceAll("{summary}", order >= 997 ? title : `safha ${order + 1}: ${title}`);
    await execGit(exec, worktree, [
      "-c", `user.name=${BRAND.displayName}`,
      "-c", `user.email=${BRAND.slug}@localhost`,
      "commit", "-q", "--no-gpg-sign", "-m", message,
    ]);
  }

  // ── Sohbet ───────────────────────────────────────────────────────────────

  /**
   * Kullanıcı mesajı. Süren canlı koşu varsa kanala düşer (tur sınırında
   * görülür; `interrupt` ile hemen). PlanReview'da bekleyen işte Planner
   * aynı oturumdan cevaplar ve plan değişirse yeni sürüm + yeni kapı açılır.
   * Başka durumda mesaj kabul edilmez — sessizce yutulmasın.
   */
  chat(jobId: string, text: string, interrupt = false, actor = "human"): { accepted: boolean; reason: string; turn?: Promise<void> } {
    // Önce iş var mı (not_found), sonra kabul kararı; mesaj yalnız kabul
    // edilince kalıcılaşır — reddedilen mesaj sohbet geçmişinde görünmesin.
    const { job } = this.load(jobId);
    const channel = this.channels.get(jobId);
    if (channel && !channel.closed) {
      this.persistUserMessage(jobId, text, actor);
      channel.push(`<user_message>\n${text}\n</user_message>`, interrupt);
      return { accepted: true, reason: interrupt ? "tur kesildi, mesaj işleniyor" : "mesaj tur sınırında işlenecek" };
    }
    if (job.state === "PlanReview" && !this.busy.has(jobId)) {
      this.persistUserMessage(jobId, text, actor);
      this.move(jobId, "Planning", "starting", "kullanıcı Planner ile konuşuyor", "human");
      return { accepted: true, reason: "Planner cevaplıyor", turn: this.runPlanning(jobId, text) };
    }
    return { accepted: false, reason: `bu durumda mesaj alınamıyor: ${job.state}/${job.phase}` };
  }

  private persistUserMessage(jobId: string, text: string, actor: string): void {
    const row = this.deps.db.select({ m: schema.messages.seq }).from(schema.messages).where(eq(schema.messages.jobId, jobId)).orderBy(desc(schema.messages.seq)).limit(1).all()[0];
    this.deps.db.insert(schema.messages).values({
      id: newId(), jobId, runId: null, seq: (row?.m ?? 0) + 1, role: "user", kind: "text", content: text, metadata: { actor } as never,
    }).run();
    this.deps.hub.publish(jobId, { type: "agent.message", runId: "", role: "user", content: text });
  }

  /** Süren koşuyu keser (kanalı kapatır). Koşu yoksa false. */
  interrupt(jobId: string): boolean {
    const channel = this.channels.get(jobId);
    if (!channel || channel.closed) return false;
    channel.close();
    return true;
  }
}

/**
 * Canlı test senaryosu prompt'u.
 *
 * `plan` aşamasında kod henüz yok: senaryolar planın kabul kriterlerinden
 * türer ve Developer'ın hedefi olarak da okunabilir. `live` aşamasında
 * değişen dosyalar ve ortamın adresi eklenir — senaryo gerçekten var olan
 * ekrana/uca gitsin, plandaki niyete değil.
 */
export function renderTestScenariosPrompt(
  job: typeof schema.jobs.$inferSelect,
  plan: PlanDocument,
  stage: TestScenarioStage,
  worktreePath: string,
  files: string[],
  liveUrl: string | null,
  note: string,
  accounts: Pick<TestAccount, "role" | "description">[] = [],
): string {
  return [
    "# İş", `Başlık: ${job.title}`, job.description ? `Açıklama:\n${job.description}` : "",
    `\n# Plan${stage === "plan" ? " (henüz onaylanmadı, kod yazılmadı)" : " (onaylı)"}`, plan.summary,
    // Gereksinimler (§42): senaryoların `covers`ı bunlara bağlanır. Eski
    // planlarda yok — o zaman bölüm de yok, tester `covers`ı boş bırakır.
    plan.requirements.length ? "\n## Gereksinimler" : "",
    ...plan.requirements.map((r) => `- ${r.id}: ${r.text}`),
    ...plan.phases.map((p) => [
      `\n## ${p.order + 1}. ${p.title}`,
      p.rationale,
      p.covers.length ? `Karşılar: ${p.covers.join(", ")}` : "",
      p.acceptance.length ? `Kabul: ${p.acceptance.join(" · ")}` : "",
      p.files.length ? `Dosyalar: ${p.files.join(", ")}` : "",
    ].filter(Boolean).join("\n")),
    plan.testStrategy ? `\nTest stratejisi (Planner): ${plan.testStrategy}` : "",
    stage === "live" ? "\n# Bu işte değişen dosyalar" : "",
    ...(stage === "live" ? (files.length ? files.map((f) => `- ${f}`) : ["(değişen dosya bulunamadı)"]) : []),
    liveUrl ? `\n# Canlı ortam\n${liveUrl}` : "",
    // Rol bazlı hesaplar: senaryo hangi kullanıcıyla koşacağını bilmeden yetki
    // farkı doğrulanamaz. Sır adları burada gerekmez, yalnız rol ve ne yapabildiği.
    ...(accounts.length
      ? [
        "\n# Test hesapları",
        ...accounts.map((a) => `- \`${a.role}\`${a.description ? `: ${a.description}` : ""}`),
        "Her senaryonun `account`ına onu koşacak hesabın rolünü birebir yaz; giriş gerekmiyorsa boş bırak. Plandaki ve gereksinimlerdeki rol/yetki ifadelerini bu hesaplara eşle. Yetki farkını doğrulayan senaryo, erişimi OLMAMASI gereken hesapla koşar. Gereken bir rolün hesabı yoksa senaryoyu yine yaz, `account`a o rolü yaz (boş bırakma: boş \"girişsiz\" demektir ve tarayıcı turu başka hesapla koşabilir) ve eksik hesabı `notes`ta adıyla söyle.",
      ]
      : []),
    note ? `\n# İnsanın odak isteği\n${note}` : "",
    "\nBu dizinde çalış: " + worktreePath,
    stage === "plan"
      ? "Kod henüz yok: senaryoları planın kabul kriterlerinden türet; mevcut ekran ve uçları koddan doğrula."
      : "Senaryolar değişen koddaki gerçek ekran, alan ve uç adlarını kullansın; diff'i oku.",
    "Tam olarak bir TEST_SCENARIOS_JSON bloğu üret.",
  ].filter(Boolean).join("\n");
}

/**
 * Tarayıcı turunda koşacak senaryolar. `pending`: işaretsiz, `retest` ve
 * agent'ın işaretleri (kod değiştiyse eski "geçti" kanıt değil). İnsanın
 * koyduğu işaret yeniden koşmaz — insan baktı, agent onu ezmez.
 */
export function pickBrowserScenarios(
  scenarios: TestScenario[],
  marks: ScenarioMarks,
  scope: "pending" | "all" | "high",
): { key: string; scenario: TestScenario }[] {
  return scenarios.flatMap((scenario, i) => {
    const key = scenarioKey(i);
    if (scope === "all") return [{ key, scenario }];
    const m = marks[key];
    const pending = !m || m.state === "retest" || m.source === "agent";
    if (!pending || (scope === "high" && scenario.priority !== "high")) return [];
    return [{ key, scenario }];
  });
}

/** Tarayıcı turunun prompt'u — senaryolar sabit anahtarlarıyla (`s0`…). */
export function renderBrowserTestPrompt(input: {
  picked: { key: string; scenario: TestScenario }[];
  baseUrl: string;
  accounts: { role: string; description: string; names: string[] }[];
  evidence: "screenshot" | "none";
  selectorAttribute: string;
}): string {
  const roles = new Set(input.accounts.map((a) => a.role));
  // Aynı hesabın senaryoları ardışık: her hesap değişimi bir çıkış + giriş
  // turu. Anahtarlar (`s0`…) sabit, sıra değişse de sonuç doğru satıra gider.
  const order = [...new Set(input.picked.map((p) => p.scenario.account))];
  const picked = [...input.picked].sort((a, b) => order.indexOf(a.scenario.account) - order.indexOf(b.scenario.account));
  return [
    "# Görev: senaryoları tarayıcıda yürüt",
    `Uygulama: ${input.baseUrl}`,
    "Playwright araçlarıyla (`mcp__playwright__*`) aşağıdaki senaryoları uygulamada SIRAYLA yürüt ve her birinin sonucunu yaz.",
    ...(input.accounts.length > 0
      ? [
        "\n# Test hesapları",
        "Giriş bilgileri gizli; alana DEĞERİ DEĞİL ADI yaz, araç gerçeğini koyar.",
        ...input.accounts.map((a) => `- \`${a.role}\`${a.description ? ` (${a.description})` : ""}: ${a.names.length ? a.names.map((n) => `\`${n}\``).join(", ") : "giriş bilgisi yok"}`),
        "Her senaryo `Hesap:` satırındaki rolle koşar. Hesap bir öncekinden farklıysa önce oturumu kapat, sonra o hesabın adlarıyla giriş yap. Hesabın giriş bilgisi yoksa ve giriş gerekiyorsa senaryoyu `unsure` + \"giriş bilgisi yok\" olarak işaretle. `Hesap:` satırı olmayan senaryo girişsiz koşar: ona geçerken açık oturum varsa önce kapat, önceki hesabın yetkisiyle koşmasın. Girişsiz yürümüyorsa açıklamasına en uygun hesabı seç, seçtiğini notta söyle.",
      ]
      : ["Giriş bilgisi verilmedi; giriş gerekiyorsa senaryoyu `unsure` + \"giriş bilgisi yok\" yaz."]),
    input.evidence === "screenshot"
      // `filename` verilirse MCP onu SDK'nın bildirdiği çalışma köküne
      // (worktree) göre çözer, `--output-dir`e değil: Northwind'de 12 görüntü
      // worktree köküne düştü, kanıt dizini boş kaldı (yaşandı).
      ? "Her senaryonun beklenen sonucu görülen anda `browser_take_screenshot` çağır; `filename` VERME — araç kanıt dizinine kendi adıyla kaydeder. Yanıtta dönen dosya adını sonucun `evidence`ine yaz."
      : "",
    input.selectorAttribute
      ? `Tıkladığın ya da yazdığın etkileşimli elemanda \`${input.selectorAttribute}\` özniteliği yoksa onu \`missingSelectors\`e "Ekran › eleman" biçiminde yaz.`
      : "",
    ...picked.map(({ key, scenario: s }) => [
      `\n## ${key} — ${s.title}${s.area ? ` (${s.area})` : ""}`,
      s.account
        ? `Hesap: \`${s.account}\`${roles.has(s.account) ? "" : " — profilde bu rolün hesabı yok; giriş gerekiyorsa `unsure` + \"hesap yok\" yaz"}`
        : "",
      s.preconditions.length ? `Ön koşul: ${s.preconditions.join(" · ")}` : "",
      ...s.steps.map((st, i) => `${i + 1}. ${st}`),
      `Beklenen: ${s.expected}`,
    ].filter(Boolean).join("\n")),
    "\nBitince tam olarak bir SCENARIO_RESULTS_JSON bloğu üret.",
  ].filter(Boolean).join("\n");
}

/** `SCENARIO_RESULTS_JSON` bloğu; yoksa ya da şemaya uymuyorsa null. */
export function parseScenarioResults(text: string): ScenarioResults | null {
  const raw = extractBlock(text, "SCENARIO_RESULTS_JSON");
  if (raw === null) return null;
  const parsed = ScenarioResultsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Agent `filename` kuralına uymazsa görüntü worktree köküne düşer ve QA'nın
 * commit'ine girer. Turda doğmuş (`.start`tan yeni), git'in izlemediği
 * görüntüler kanıt dizinine taşınır; izlenen dosyaya dokunulmaz — reponun
 * kendi görseli olabilir.
 */
export async function sweepStrayEvidence(exec: CommandExecutor, worktree: string, outputDir: string): Promise<void> {
  const marker = shellQuote(posix.join(outputDir, ".start"));
  await exec.run({
    command: `[ -f ${marker} ] || exit 0; find . -maxdepth 1 -type f \\( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \\) -newer ${marker} | while IFS= read -r f; do git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 || mv -n -- "$f" ${shellQuote(outputDir)}/; done`,
    cwd: worktree, env: {}, timeoutMs: 60_000, onLine: () => {},
  }).catch(() => undefined);
}

/**
 * Kanıt görüntülerini konteynerden artifact dizinine taşır. Motor Docker'ı
 * bilmiyor ve yürütücü yalnız satır veriyor: dosya başına `base64 -w0`.
 * Tavanlar log'u ve diski korur; ad deseni yol kaçışını keser.
 */
export async function copyBrowserEvidence(exec: CommandExecutor, dir: string, dest: string): Promise<Set<string>> {
  const names: string[] = [];
  await exec.run({
    command: `find ${shellQuote(dir)} -maxdepth 1 -type f \\( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \\) -size -3M -printf '%f\\n' | sort | head -n 80`,
    cwd: dir, env: {}, timeoutMs: 60_000,
    onLine: (s, l) => { if (s === "stdout" && /^[\w.-]+$/.test(l)) names.push(l); },
  });
  const copied = new Set<string>();
  if (names.length === 0) return copied;
  mkdirSync(dest, { recursive: true });
  for (const name of names) {
    let b64 = "";
    const res = await exec.run({
      command: `base64 -w0 ${shellQuote(posix.join(dir, name))}`,
      cwd: dir, env: {}, timeoutMs: 60_000,
      onLine: (s, l) => { if (s === "stdout") b64 += l; },
    });
    if (res.exitCode !== 0 || b64.length === 0) continue;
    writeFileSync(join(dest, name), Buffer.from(b64, "base64"));
    copied.add(name);
  }
  return copied;
}

/**
 * Developer'a kararlı seçici kuralı (karar §41). Yalnız tarayıcı testi
 * açıkken: öznitelik adı projenin tercihi, kapalı projede not gürültü.
 */
export function renderSelectorNote(profile: ProjectProfile): string {
  const cfg = profile.live?.browserTest;
  if (!cfg?.enabled || !cfg.selectorAttribute) return "";
  const a = cfg.selectorAttribute;
  return [
    "\n\n<live-test>",
    `Canlı testte bir agent arayüzü tarayıcıda yürütecek. Eklediğin ya da değiştirdiğin her input, select, textarea, button, link ve satır eylemine kararlı bir \`${a}\` ver:`,
    `- Değer anlamlı ve ekran + alan adından: \`${a}="order-amount"\`, \`${a}="order-save"\`. Sıra numarası ya da rastgele değer olmaz.`,
    `- Listede tekrar eden satır eyleminde kayıt anahtarı eklenir: \`${a}="order-row-<id>-delete"\`.`,
    "- Input'un görünür etiketi kendisine bağlı kalır (`<label for>` / `aria-label`); kimlik etiketin yerine geçmez.",
    "- Formu şemadan üreten bir bileşen varsa kimliği bileşende alan adından bir kez türet; ekran ekran elle yazma.",
    "</live-test>",
  ].join("\n");
}

/** İnsanın açtığı adres satırı — senaryo prompt'u "nereye gidilecek" desin diye. */
export function liveUrlLine(live: Pick<LiveGatePayload, "appUrl" | "apiUrl" | "publicUrl">): string {
  return `Uygulama: ${live.publicUrl ?? live.appUrl}${live.apiUrl ? ` · API: ${live.apiUrl}` : ""}`;
}

/** Senaryo belgesi DB'ye ve UI'a gider: her metin alanı maskelenir (kural 4). */
function scrubScenarios(doc: TestScenariosDocument): TestScenariosDocument {
  return {
    notes: scrubSecrets(doc.notes),
    scenarios: doc.scenarios.map((s) => ({
      ...s,
      title: scrubSecrets(s.title),
      area: scrubSecrets(s.area),
      preconditions: s.preconditions.map(scrubSecrets),
      steps: s.steps.map(scrubSecrets),
      expected: scrubSecrets(s.expected),
      account: scrubSecrets(s.account),
    })),
  };
}

/** QA case listesi için prompt: plan + iş boyunca değişen dosyalar. */
export async function renderQaCasesPrompt(exec: CommandExecutor, job: typeof schema.jobs.$inferSelect, plan: PlanDocument, worktreePath: string, baseRef: string, scenarios: TestScenario[] = []): Promise<string> {
  const files = await changedFiles(exec, worktreePath, baseRef);
  return [
    "# İş", `Başlık: ${job.title}`, job.description ? `Açıklama:\n${job.description}` : "",
    "\n# Onaylı plan", plan.summary,
    `Safhalar: ${plan.phases.map((p) => `${p.order + 1}. ${p.title}`).join(" · ")}`,
    plan.testStrategy ? `Test stratejisi (Planner): ${plan.testStrategy}` : "",
    "\n# Bu işte değişen dosyalar", ...files.map((f) => `- ${f}`),
    // İnsan canlı testte bu senaryoları elle koştu; otomatiğe çevrilebilenler
    // case adayıdır. Liste bağlayıcı DEĞİL — QA kendi yargısını korur.
    scenarios.length ? "\n# Canlı testte kullanılan senaryolar (otomatiğe çevrilebilecekleri değerlendir)" : "",
    ...scenarios.map((s) => `- ${s.title}: ${s.expected.split("\n")[0] ?? ""}`),
    "\nBu dizinde çalış: " + worktreePath,
    "Değişen davranışı doğrulayan case'leri listele; tam olarak bir QA_CASES_JSON bloğu üret.",
  ].filter(Boolean).join("\n");
}

/** QA testleri yazarken: onaylı case listesi + test takımları. */
export function renderQaPrompt(job: typeof schema.jobs.$inferSelect, profile: ProjectProfile, plan: PlanDocument, cases: QaCase[]): string {
  return [
    "# İş", `Başlık: ${job.title}`,
    "\n# Onaylı plan", plan.summary,
    "\n# Onaylı case listesi (HEPSİNİ yaz, dışına çıkma)",
    ...cases.map((c) => `- [${c.id}] ${c.title}${c.rationale ? ` — ${c.rationale}` : ""}${c.origin === "human" ? " (insan ekledi)" : ""}`),
    "\n# Test takımları (orkestratör koşturur, sen koşturma)",
    ...profile.test.suites.map((s) => `- ${s.id}: ${s.command.run}${s.services.length ? " (servis ister; bu dilimde koşturulmaz)" : ""}`),
    profile.security.sensitiveFiles.length ? `\nDokunma/okuma: ${profile.security.sensitiveFiles.join(", ")}` : "",
    "\nYalnız test dizinlerine yaz. Commit atma. Bitince tam olarak bir HANDOFF_JSON bloğu yaz.",
  ].filter(Boolean).join("\n");
}

/**
 * Engeli Developer'a anlatan geri bildirim.
 *
 * `renderTestFeedback`ten AYRI ve tonu bilinçli olarak farklı: orada "kodu ya
 * da testi düzelt" deniyor, burada TESTE DOKUNMA deniyor. QA'nın teşhisi
 * doğruysa test zaten doğru; kırmızılık üretim kodundaki eksiğin kanıtı.
 * Developer'ın en kolay yolu testi gevşetmek olurdu ve bulgu kaybolurdu.
 */
export function renderBlockerFeedback(blockers: Blocker[], results: SuiteOutcome[], humanComment: string): string {
  const lines = [
    "# ENGEL: önceki rol çözemedi, sana devredildi",
    "",
    "Aşağıdaki maddeler ÜRETİM KODUNDAKİ eksiklerdir; insan bunları senin",
    "çözmene karar verdi.",
    "",
    "## TESTİ DEĞİŞTİRME",
    "Kırmızı testler bu eksiğin KANITI — doğru yazılmışlar. Testi silmek,",
    "atlamak (`Skip`/`Ignore`), beklentisini gevşetmek ya da InlineData",
    "çıkarmak YASAK. Üretim kodunu planın şart koştuğu hâle getir; test",
    "kendiliğinden yeşile döner.",
    "",
    "## Maddeler",
  ];
  for (const b of blockers) {
    lines.push(`- ${b.what}`);
    if (b.why) lines.push(`  Niçin devredildi: ${b.why}`);
    if (b.refs.length) lines.push(`  İlgili: ${b.refs.join(", ")}`);
  }
  if (humanComment.trim()) lines.push("", "## İnsanın notu", humanComment.trim());
  const red = results.filter((r) => r.failed > 0);
  if (red.length > 0) {
    lines.push("", "## Şu an kırmızı olan testler (kanıt)");
    for (const r of red) {
      lines.push(`- ${r.suiteId}: ${r.failed} kırık${r.failedNames.length ? ` — ${r.failedNames.slice(0, 20).join(", ")}` : ""}`);
    }
  }
  lines.push("", "Bitince tam bir HANDOFF_JSON bloğu yaz. Hâlâ çözemediysen",
    "`blockers` alanını doldur ve NİÇİN çözemediğini yaz — uydurup geçme.");
  return lines.join("\n");
}

/** Kırmızı testleri Developer'a anlatan geri bildirim. */
export function renderTestFeedback(results: SuiteOutcome[], blockers: Blocker[] = []): string {
  const lines = ["Testler KIRMIZI. Orkestratör koşturdu; sen koşturma, kodu ya da testi düzelt."];
  // Engel varsa BAŞA yazılır: QA'nın teşhisi olmadan Developer kırmızı testi
  // görüp testi düzeltmeye yönelir ve gerçek eksik gizlenir. Kapı kapalıyken
  // (`blockedApproval: false`) bu tek taşıyıcıdır.
  if (blockers.length > 0) {
    lines.push("", "ÖNCEKİ ROLÜN BİLDİRDİĞİ ENGEL — testi değil KODU düzelt:");
    for (const b of blockers) {
      lines.push(`- ${b.what}${b.why ? ` (${b.why})` : ""}${b.refs.length ? ` [${b.refs.join(", ")}]` : ""}`);
    }
    lines.push("");
  }
  for (const r of results) {
    if (r.failed === 0) continue;
    lines.push(`Takım ${r.suiteId}: ${r.failed} kırık${r.failedNames.length ? ` — ${r.failedNames.slice(0, 20).join(", ")}` : ""}`);
    if (r.preexistingFailures.length) lines.push(`  (önceden kırık, sorumluluğun değil: ${r.preexistingFailures.join(", ")})`);
    try {
      const log = readFileSync(r.reportRef, "utf8").split("\n");
      lines.push("  Log kuyruğu:", "  ```", ...log.slice(-60).map((l) => `  ${l}`), "  ```");
    } catch {
      /* log yoksa yalnız özet */
    }
  }
  return lines.join("\n");
}

/** Worktree'deki değişikliğin özeti — safha onayında insan bunu görür. */
/**
 * Bu safhanın değiştirdiği dosyalar: HEAD'e göre commit'lenmemiş her şey.
 *
 * `changedFiles(diffBase)` KULLANILMAZ: o `base...HEAD` aralığını da sayar ve
 * her safha onayda commit'lendiği için (`commitPhase`) önceki safhaların
 * dosyalarını da getirir — hepsi "plan dışı" görünür, insan uyarıyı
 * okumamayı öğrenir. Kapının diff'i (`diffSummary`) de HEAD'e göre; ikisi aynı
 * kümeye bakar.
 *
 * `-z` KULLANILMAZ: `execGit` stderr'i stdout'a satır olarak katar; `-z`
 * çıktısında satır sonu olmadığından bir git uyarısı son kaydın yoluna
 * yapışır. Satır tabanlı okuyup durum kodu deseniyle süzülür (uyarı satırı
 * elenir). `core.quotePath=false`: Türkçe adlar `\303…` kaçışıyla gelmesin;
 * boşluklu ad yine `"…"` içinde gelir, çözülür.
 */
export async function phaseChangedFiles(
  exec: CommandExecutor,
  worktree: string,
): Promise<{ path: string; added: boolean }[]> {
  const out = await execGit(exec, worktree, ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
  const unquote = (p: string) => {
    if (!(p.startsWith("\"") && p.endsWith("\""))) return p;
    try { return JSON.parse(p) as string; } catch { return p.slice(1, -1); }
  };
  const files: { path: string; added: boolean }[] = [];
  for (const line of out.split("\n")) {
    const m = /^([ MADRCUT?!]{2}) (.+)$/.exec(line);
    if (!m) continue;
    const code = m[1]!;
    if (code === "!!") continue;
    // Yeniden adlandırma "eski -> yeni": yeni yoluyla sayılır, yeni dosya gibi.
    const arrow = m[2]!.split(" -> ");
    const path = unquote(arrow[arrow.length - 1]!);
    files.push({ path, added: code === "??" || /[ARC]/.test(code) });
  }
  return files;
}

/**
 * Safhanın `files` sınırı dışında kalan değişiklikler.
 *
 * Var olan dosyada TAM YOL eşleşmesi. Yeni dosyada planlanan yerin dizini
 * altı da kabul: Planner yeni dosya için "nereye konacağını" yazar (dizin ya
 * da tahmini ad); Developer aynı dizine farklı adla ya da yanına yardımcı bir
 * dosya açtıysa bu plan dışı değil. Kök dizin (`""`) dizin eşlemesine girmez —
 * yoksa kökte planlanan tek dosya kökteki her yeni dosyayı aklar.
 */
export function outOfPlanFiles(changed: { path: string; added: boolean }[], planned: string[]): string[] {
  const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const exact = new Set(planned.map(norm).filter(Boolean));
  const dirs = new Set<string>();
  for (const p of planned) {
    const n = norm(p);
    if (!n) continue;
    dirs.add(n); // planlanan bir dizin olabilir
    const slash = n.lastIndexOf("/");
    if (slash > 0) dirs.add(n.slice(0, slash));
  }
  const underDir = (f: string) => [...dirs].some((d) => f.startsWith(`${d}/`));
  return changed
    .filter(({ path, added }) => {
      const f = norm(path);
      if (exact.has(f)) return false;
      return !(added && underDir(f));
    })
    .map(({ path }) => norm(path))
    .sort();
}

export async function diffSummary(
  exec: CommandExecutor,
  worktree: string,
  maxPatchChars = 200_000,
): Promise<PhaseGatePayload["diff"]> {
  // `allowFailure`: `git diff --no-index` FARK BULUNCA çıkış 1 döner — bu hata
  // değil, sonucun kendisi. Fırlatılırsa yeni dosyaların patch'i sessizce
  // kaybolur (yaşandı: düzeltme yazıldı ama onay ekranı "değişiklik yok"
  // diyordu, çünkü üretilen patch atılıyordu).
  const git = (args: string[]) => execGit(exec, worktree, args, { allowFailure: true });
  const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
    .split("\n").map((s) => s.trim()).filter(Boolean);

  // İZLENMEYEN DOSYALAR DA PATCH'E GİRER.
  //
  // `git diff HEAD` yalnız izlenen dosyaları gösterir; yeni yaratılmış bir
  // dosya orada HİÇ görünmez. Sonuç: yeni bir servis sınıfı yazan safha onay
  // ekranında "değişiklik yok" diyordu ve hemen altında dosya adlarını
  // listeliyordu — insanın onaylayacağı kodu göremediği bir kapı (yaşandı,
  // 2026-09-18: CollectionRule.cs + CollectionRuleWhitelist.cs).
  //
  // `--no-index` iki yolu karşılaştırır ve repo dışındaki dosyalarda da çalışır;
  // `/dev/null` ile karşılaştırıldığında çıktı normal bir "yeni dosya" patch'i
  // olur. Çıkış kodu 1'dir (fark var) — `git()` zaten yutuyor.
  const patches: string[] = [];
  for (const path of untracked) {
    const p = await git(["diff", "--no-index", "--", "/dev/null", path]);
    if (p.trim().length > 0) patches.push(p);
  }
  const untrackedPatch = patches.join("\n");

  const stat = scrubSecrets((await git(["diff", "--stat", "HEAD"])).trim());
  const full = scrubSecrets((await git(["diff", "HEAD"])) + untrackedPatch);
  return {
    stat,
    patch: full.length > maxPatchChars ? full.slice(0, maxPatchChars) : full,
    truncated: full.length > maxPatchChars,
    untracked,
  };
}

/** Kırmızı build'i Developer'a anlatan geri bildirim: düşen adım + logun kuyruğu. */
export function renderBuildFeedback(results: BuildResult[], tailLines = 80): string {
  const failed = results.find((r) => !r.skipped && r.exitCode !== 0);
  const lines: string[] = ["Build KIRMIZI. Orkestratör derledi; sen derleme koşturma, hatayı düzelt."];
  if (failed) {
    lines.push(`Düşen adım: ${failed.stepName} (çıkış ${failed.exitCode ?? "zaman aşımı"})`);
    try {
      const log = readFileSync(failed.logRef, "utf8").split("\n");
      lines.push("Log kuyruğu:", "```", ...log.slice(-tailLines), "```");
    } catch {
      /* log dosyası yoksa yalnız adım adı */
    }
  }
  return lines.join("\n");
}

/**
 * Kırmızı build'i Developer'a anlatır — build CANLI KONTEYNERDE koştuğunda.
 *
 * `renderBuildFeedback`in kardeşi; metin düzeni bilinçli olarak aynı, kaynak
 * farkı log DOSYASI yerine konteyner çıktısı. Zincir adım sınırlarını
 * `STEP_SENTINEL` ile işaretliyor, düşen adımı `FAIL_SENTINEL` taşıyor —
 * dosya başına ayrı log yok, tek bir akış var.
 */
export function renderContainerBuildFeedback(failedStep: string, logTail: string, tailLines = 80): string {
  const lines: string[] = ["Build KIRMIZI. Orkestratör derledi; sen derleme koşturma, hatayı düzelt."];
  if (failedStep) lines.push(`Düşen adım: ${failedStep}`);
  const tail = logTail.split("\n").filter((l) => l.trim());
  if (tail.length > 0) lines.push("Log kuyruğu:", "```", ...tail.slice(-tailLines), "```");
  return lines.join("\n");
}

/**
 * Agent'ın kabul kanıtını planın `acceptance` listesine hizalar (kural 3:
 * üretici güvenilmez). Çıktıda planın her maddesi için TAM BİR satır olur,
 * `index` sırasıyla:
 *  - aralık dışı `index` atılır (olmayan maddeye "kanıt" kapıda görünmesin);
 *  - mükerrer `index`te ilk satır kalır — ikinci bir `yes` ilk `no`yu ezmesin;
 *  - `criterion` daima plandan: agent maddeyi yeniden ifade eder, insan
 *    plandakiyle karşılaştıramaz;
 *  - karşılığı gelmeyen madde `unknown` + `synthesized` ile eklenir. Eksik
 *    madde sessizce düşerse kapıda "hepsi kanıtlı" gibi görünür.
 */
export function completeAcceptanceEvidence(rows: AcceptanceEvidence[], acceptance: string[]): AcceptanceEvidence[] {
  const byIndex = new Map<number, AcceptanceEvidence>();
  for (const r of rows) {
    if (r.index >= acceptance.length || byIndex.has(r.index)) continue;
    byIndex.set(r.index, r);
  }
  return acceptance.map((criterion, index) => {
    const r = byIndex.get(index);
    return r
      ? { ...r, criterion, synthesized: false }
      : { index, criterion, met: "unknown", evidence: "", synthesized: true };
  });
}

/** Developer'a verilen safha promptu: plan özeti + bu safha + önceki handoff'lar. */
export function renderDeveloperPrompt(
  job: typeof schema.jobs.$inferSelect,
  profile: ProjectProfile,
  plan: PlanDocument,
  phase: typeof schema.planPhases.$inferSelect,
  previous: Handoff[],
  approvalNote = "",
): string {
  const lines: string[] = [];
  lines.push("# İş", `Başlık: ${job.title}`);
  if (job.description) lines.push(`Açıklama:\n${job.description}`);
  lines.push("\n# Onaylı plan (özet)", plan.summary);
  lines.push(`Safhalar: ${plan.phases.map((p) => `${p.order + 1}. ${p.title}`).join(" · ")}`);
  // Açık sorular onaydan sonra da açık kalabiliyor: cevapsız olanda Planner'ın
  // varsayımı geçerli. Developer bunu bilmezse aynı kararı kendi sezgisiyle verir.
  if (plan.openQuestions.length > 0 || approvalNote) {
    lines.push("\n# Plan kararları");
    if (approvalNote) lines.push(`İnsanın onay notu (cevapları varsayımları ezer):\n${approvalNote}`);
    for (const q of plan.openQuestions) {
      // UI'daki "Cevapsız kalırsa: …" ile aynı öncelik: planın varsayımı, yoksa önerilen şık.
      const fallback = q.assumption || q.recommended;
      if (fallback) lines.push(`- ${q.question} → cevapsızsa: ${fallback}`);
    }
  }
  lines.push(`\n# BU SAFHA: ${phase.order + 1}. ${phase.title}`);
  if (phase.rationale) lines.push(`Gerekçe: ${phase.rationale}`);
  lines.push("Dosyalar (sınırın):", ...phase.files.map((f) => `- ${f}`));
  lines.push(`Risk: ${phase.risk}`);
  // Kabul kriterleri belgede duruyor, safha satırında değil: sıra ile eşlenir.
  const acceptance = plan.phases.find((p) => p.order === phase.order)?.acceptance ?? [];
  // Numaralı: handoff'taki `acceptanceEvidence.index` bu sıraya bağlanır.
  if (acceptance.length > 0) lines.push("Kabul kriterleri (numarayı handoff'ta `index` olarak kullan):", ...acceptance.map((a, i) => `${i}. ${a}`));
  if (previous.length > 0) {
    lines.push("\n# Önceki safhalardan devir");
    for (const h of previous) {
      if (h.keyDecisions.length) lines.push(`Kararlar: ${h.keyDecisions.join("; ")}`);
      if (h.gotchas.length) lines.push(`Tuzaklar: ${h.gotchas.join("; ")}`);
      if (h.remainingSteps.length) lines.push(`Kalanlar: ${h.remainingSteps.join("; ")}`);
    }
  }
  lines.push("\n# Proje kuralları");
  lines.push(`Build (orkestratör koşturur, sen koşturma): ${profile.build.steps.map((s) => s.name).join(" → ")}`);
  if (profile.build.forbiddenFlags.length) lines.push(`Yasak bayraklar: ${profile.build.forbiddenFlags.join(", ")}`);
  if (profile.security.sensitiveFiles.length) lines.push(`Dokunma/okuma: ${profile.security.sensitiveFiles.join(", ")}`);
  if (profile.agents.oversizedFiles.length) lines.push(`Ham okuma: ${profile.agents.oversizedFiles.map((f) => f.path).join(", ")}`);
  lines.push(...docLayerLines(profile));
  lines.push(...jobReferenceLines(job));
  lines.push(...referenceRepoLines(profile));
  lines.push("\nCommit atma. Bitince tam olarak bir HANDOFF_JSON bloğu yaz.");
  return lines.join("\n");
}

/**
 * Açık soru biçimi — devam eden turlara da basılır.
 *
 * Rol promptu (planner.md) yalnız YENİ oturumda okunur. Aynı oturumdan süren
 * bir Planner eski sistem promptuyla koşar ve düz dize yazmaya devam eder:
 * ölçüldü (Collection işi v3 — 12 soru, hepsi düz dize, sıfır şık). Bu yüzden
 * biçim her feedback turunda tekrar hatırlatılır.
 */
/**
 * Cevapları Planner promptuna çevirir.
 *
 * Soru ve cevap BİRLİKTE verilir: Planner hangi cevabın hangi soruya ait
 * olduğunu sırayla eşleştirmek zorunda kalmasın. Hem canlı gönderim hem de
 * `retry()` sonrası kurtarma aynı metni üretir.
 */
function renderAnswerPrompt(answers: { question: string; answer: string }[], comment: string): string {
  const lines = ["<answers>"];
  for (const a of answers) lines.push(`S: ${a.question}\nC: ${a.answer}\n`);
  lines.push("</answers>");
  if (comment) lines.push(`\n<comment>\n${comment}\n</comment>`);
  lines.push("\nBu cevaplara göre planı güncelle ve tam bir PLAN_JSON bloğu üret. Cevaplanan sorular openQuestions'tan çıkmalı.");
  lines.push(OPEN_QUESTION_FORMAT);
  return lines.join("\n");
}

/** `retry()`ın sildiği hata damgası — yeniden koşan agent'a iletilir. */
export interface RetryContext {
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Yeniden denemede agent'a önceki denemenin neden düştüğünü söyler.
 *
 * `full` yalnız YENİ oturum içindir: devralınan oturum reddedilen bloğu ve
 * son devri zaten bağlamında görüyor, ikinci kopyası boşa token. Sebep ise
 * her iki yola da gider — agent'ın hiç görmediği tek bilgi o (kota, konteyner,
 * şema hatası orkestratörde oluşur, transcript'e düşmez).
 */
export function renderRetryNote(
  retry: RetryContext,
  opts: { rejected: RejectedBlock | null; handoff?: Handoff | null; full: boolean },
): string {
  const lines = ["<retry>", "Önceki deneme yarıda kaldı; insan yeniden denemeyi başlattı."];
  if (retry.errorCode || retry.errorMessage) {
    lines.push(`Düşme sebebi${retry.errorCode ? ` (${retry.errorCode})` : ""}: ${scrubSecrets(retry.errorMessage ?? "").slice(0, 2000)}`);
  }
  const rej = opts.rejected;
  if (rej) {
    lines.push(`Son ${rej.tag} bloğun şemaya uymadığı için reddedildi:`, ...rej.issues.map((i) => `- ${i}`));
    if (opts.full) lines.push(`Reddedilen blok${rej.truncated ? " (kırpıldı)" : ""}:`, "```" + rej.tag, rej.raw, "```");
  }
  if (opts.full && opts.handoff) {
    lines.push(`Bu safhanın son devri${opts.handoff.synthesized ? " (orkestratör diff'ten sentezledi)" : ""}:`, "```json", JSON.stringify(opts.handoff, null, 2), "```");
  }
  lines.push("</retry>");
  return lines.join("\n");
}

const OPEN_QUESTION_FORMAT = `
openQuestions biçimi (ZORUNLU — düz dize DEĞİL, nesne):
[{"question":"Kural değerlendirmesi nerede yapılsın?","context":"gerekçe, ölçüm, risk — uzun olabilir","options":["ES'te değerlendir","Postgres'te değerlendir"],"recommended":"ES'te değerlendir","assumption":"cevapsız kalırsa plan bunu varsayar","blocksPlan":true}]
- question: TEK CÜMLE, ~150 karakter, gerekçesiz. Şıkları soruya GÖMME ("Üç seçenek: (A)... (B)..." yanlış).
- options: kısa etiket (~60 karakter). Uzun açıklama context'e.
- Şık verilebiliyorsa options'ı MUTLAKA doldur; cevap safhaları değiştirecekse blocksPlan:true.`;

/**
 * Katmanlı doküman dizini satırları — dosya İÇERİĞİ değil, yalnız yönlendirme.
 * Agent kendi Read/Grep'iyle açar; hangi dizinin ne işe yaradığını profil söyler.
 */
function docLayerLines(profile: ProjectProfile): string[] {
  if (profile.agents.docLayers.length === 0) return [];
  const purposeLabel: Record<DocLayer["purpose"], string> = {
    "active-rule": "AKTİF KURAL — her işte önce buraya bak",
    "tacit-knowledge": "TUZAK/GEREKÇE — aynı adlı active-rule dosyası yetersizse aç",
    archive: "ARŞİV — yalnız 'bu karar neden alındı' sorusunda aç",
  };
  const lines = ["\n# Katmanlı doküman dizinleri (öncelik sırasıyla)"];
  for (const layer of profile.agents.docLayers) {
    lines.push(`- ${layer.dir} — ${purposeLabel[layer.purpose]}; önce ${layer.indexFile} oku, sonra ilgili dosyayı seç`);
  }
  return lines;
}

/**
 * Referans depo satırları. Konteyner ayağa kalkarken bu depolar `gitUrl`den
 * konteyner diskine klonlanır (bkz. `cloneReferenceRepos`); host'un hiçbir
 * yolu görünmez. Agent'a yalnız SONUÇ yolu söylenir.
 */
/**
 * İşe bağlı emsal satırları. İnsan HOST yolu verdi; agent onu göremez, yalnız
 * konteyner içi karşılığını görür. İkisi birlikte basılır ki açıklamada host
 * yolu geçerse agent eşlemeyi kendisi tahmin etmek zorunda kalmasın.
 */
function jobReferenceLines(job: typeof schema.jobs.$inferSelect): string[] {
  if (job.referencePaths.length === 0) return [];
  const lines = ["\n# Emsal (insan gösterdi — SALT OKUNUR, işe başlamadan önce incele ve desenini izle)"];
  for (const r of jobReferenceMounts(job.referencePaths)) lines.push(`- ${r.mount}  (host: ${r.hostPath})`);
  lines.push("Açıklamada host yolu geçiyorsa yukarıdaki konteyner yolunu kullan. Buraya yazma.");
  return lines;
}

function referenceRepoLines(profile: ProjectProfile): string[] {
  if (profile.workspace.referenceRepos.length === 0) return [];
  const lines = ["\n# Referans depolar (SALT OKUNUR — yazma, PR açma, buraya commit atma)"];
  for (const r of profile.workspace.referenceRepos) {
    lines.push(`- ${r.name}: ${referenceRepoPath(r.name)}${r.note ? ` — ${r.note}` : ""}`);
    if (r.searchPaths.length) {
      lines.push(`  Aramayı şunlarla sınırla: ${r.searchPaths.join(", ")} (kökte Glob yavaş; Grep'i dar kapsamla kullan)`);
    }
  }
  return lines;
}

/** Planner'a verilen ilk prompt: iş + profil özeti + çalışma ağacı. */
/**
 * Intake triage promptu — ölçüm için iş metni ve proje bağlamı.
 *
 * Açıklama KİRPILMAZ: stack trace ve hata metni genelde sonda olur ve
 * triage'ın en değerli sinyali tam orasıdır. Şema `description`ı 64 KB'a
 * sınırlıyor, bu da tek bir tur için kabul edilebilir.
 */
export function renderTriagePrompt(job: typeof schema.jobs.$inferSelect, profile: ProjectProfile, worktreePath: string): string {
  const lines: string[] = [];
  lines.push("# Ölçülecek iş");
  lines.push(`Başlık: ${job.title}`);
  if (job.description) lines.push(`Açıklama:\n${job.description}`);
  if (job.targetRepos.length > 0) lines.push(`Hedef repolar (insan seçti): ${job.targetRepos.join(", ")}`);

  lines.push("\n# Proje");
  lines.push(`${profile.name} (${profile.slug})`);
  for (const r of profile.workspace.repos) {
    lines.push(`- repo ${r.name}: ${r.path} · dal ${r.defaultBranch}${r.primary ? " · PRIMARY" : ""}`);
  }
  if (profile.test.suites.length) {
    lines.push(`Test takımları: ${profile.test.suites.map((t) => t.id).join(", ")}`);
  }
  if (profile.agents.oversizedFiles.length) {
    lines.push("Ham OKUMA: " + profile.agents.oversizedFiles.map((f) => f.path).join(", ") + " — yalnız hedefli bak.");
  }
  lines.push(...docLayerLines(profile));
  // Triage "emsal var mı" diye ölçüyor; insanın gösterdiği emsal o sinyalin kendisi.
  lines.push(...jobReferenceLines(job));

  lines.push("\n# Çalışma ağacı");
  lines.push(`${worktreePath} — kodu buradan oku, git geçmişini buradan ölç.`);
  lines.push("\nGörev: `intake`. Sonunda tam olarak bir TRIAGE_JSON bloğu üret.");
  return lines.join("\n");
}

/**
 * Postplan triage promptu — artık tahmin yok, plandan SAYILIYOR.
 *
 * Dosya listesi tekrarsız veriliyor: aynı dosyaya birden çok safhada
 * dokunulması "çok dosya" anlamına gelmez, tersine odaklı iş demektir.
 */
export function renderPostplanTriagePrompt(job: typeof schema.jobs.$inferSelect, doc: PlanDocument, worktreePath: string): string {
  const files = [...new Set(doc.phases.flatMap((ph) => ph.files))];
  const lines: string[] = [];
  lines.push("# Ölçülecek plan");
  lines.push(`İş: ${job.title}`);
  lines.push(`Özet: ${doc.summary}`);
  lines.push(`Planner'ın karmaşıklık tahmini: ${doc.estimatedComplexity}`);
  lines.push(`Safha sayısı: ${doc.phases.length} · tekrarsız dosya: ${files.length}`);

  lines.push("\n## Safhalar");
  for (const ph of doc.phases) {
    lines.push(`${ph.order + 1}. ${ph.title} [risk=${ph.risk}${ph.exceedsFileCap ? ", tavan aşıyor" : ""}]`);
    if (ph.rationale) lines.push(`   gerekçe: ${ph.rationale}`);
    if (ph.files.length) lines.push(`   dosyalar: ${ph.files.join(", ")}`);
  }

  lines.push("\n## Dokunulacak dosyalar (tekrarsız)");
  for (const f of files) lines.push(`- ${f}`);

  if (doc.openQuestions.length > 0) {
    // AÇIK SORU SAYISI BELİRSİZLİK GÖSTERGESİDİR — triage bunu ölçmeli.
    lines.push(`\n## Açık sorular (${doc.openQuestions.length})`);
    for (const q of doc.openQuestions) {
      lines.push(`- ${q.question}${q.blocksPlan ? " [PLANI ETKİLİYOR]" : ""}`);
    }
  }
  if (doc.testStrategy) lines.push(`\n## Test stratejisi\n${doc.testStrategy}`);
  if (doc.outOfScope.length) lines.push(`\n## Kapsam dışı\n${doc.outOfScope.map((o) => `- ${o}`).join("\n")}`);

  lines.push("\n# Çalışma ağacı");
  lines.push(`${worktreePath} — plandaki dosyaların git geçmişini buradan ölç.`);
  lines.push("\nGörev: `postplan`. Bu planı KİMİN uygulayacağına karar verilecek.");
  lines.push("Sonunda tam olarak bir TRIAGE_JSON bloğu üret.");
  return lines.join("\n");
}

export function renderPlannerPrompt(job: typeof schema.jobs.$inferSelect, profile: ProjectProfile, worktreePath: string, resourcesMount?: string): string {
  const lines: string[] = [];
  lines.push("# İş");
  lines.push(`Başlık: ${job.title}`);
  if (job.description) lines.push(`Açıklama:\n${job.description}`);
  if (job.targetRepos.length > 0) lines.push(`Hedef repolar (insan seçti): ${job.targetRepos.join(", ")}`);
  // İnsanın iş açarken eklediği ekran görüntüsü/tasarım — salt okunur bağlı.
  // Ad tek tek listelenmez: Planner kendi Read/Glob'uyla dizini keşfeder.
  // `issue-NN.*` iş açılırken issue gövdesinden indirilir (bkz. `downloadIssueImages`).
  if (resourcesMount) lines.push(`Ek görseller (ekran görüntüsü/tasarım): ${resourcesMount} — plan yazmadan önce incele. \`issue-01\`, \`issue-02\`… issue gövdesindeki GitHub ek görselleridir (github.com/user-attachments, user-images/private-user-images.githubusercontent.com): kod blokları dışındakiler, ilk görünüş sırasıyla, aynı adres bir kez sayılır. Başka sunuculardaki görseller numaralanmaz ve indirilmez. Eksik numara, o sıradaki GitHub ek görselinin indirilemediği demektir.`);

  lines.push("\n# Proje profili (özet)");
  lines.push(`Proje: ${profile.name} (${profile.slug})`);
  for (const r of profile.workspace.repos) lines.push(`- repo ${r.name}: ${r.path} · dal ${r.defaultBranch}${r.primary ? " · PRIMARY" : ""}`);
  lines.push(`Çalışma disiplini: developing=${profile.workflow.developing}, safha başına dosya tavanı=${profile.workflow.phaseMaxFiles}, safha sonunda test=${profile.workflow.phaseRunsTests ? "evet" : "hayır, yalnız derleme"}`);
  lines.push("Build adımları (sıra bağlayıcı):");
  for (const s of profile.build.steps) lines.push(`- ${s.name}: ${s.run}${s.whenChanged.length ? ` [${s.whenChanged.join(", ")}]` : ""}`);
  if (profile.build.forbiddenFlags.length) lines.push(`Yasak bayraklar: ${profile.build.forbiddenFlags.join(", ")}`);
  if (profile.test.suites.length) {
    lines.push("Test takımları:");
    for (const t of profile.test.suites) lines.push(`- ${t.id}: ${t.command.run} (${t.runAt}${t.services.length ? ", servis ister" : ""})`);
  }
  if (profile.agents.oversizedFiles.length) {
    lines.push("Ham OKUMA: " + profile.agents.oversizedFiles.map((f) => f.path).join(", ") + " — yalnız hedefli (grep/başlık) oku.");
  }
  lines.push(...docLayerLines(profile));

  lines.push(...jobReferenceLines(job));
  lines.push(...referenceRepoLines(profile));

  lines.push("\n# Çalışma ağacı");
  lines.push(`${worktreePath} — kodu buradan oku; bu senin çalışma dizinin. Değişiklik YALNIZ buraya.`);
  lines.push("\nSonunda tam olarak bir PLAN_JSON bloğu üret.");
  return lines.join("\n");
}
