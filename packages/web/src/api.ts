import type {
  AnswerBody,
  ApiError,
  ApprovalDecisionBody,
  AuthStatus,
  ChatBody,
  CodeMap,
  CodeMapStatus,
  CreateJobBody,
  CreateProjectBody,
  JobPhase,
  JobState,
  ModelTier,
  NextPhaseView,
  PlanDocument,
  PlanGatePayload,
  ProjectProfile,
  PushStatus,
  PushSubscriptionBody,
  Release,
  ReleaseBump,
  ReleaseStatus,
  ReleaseTrigger,
  ReopenTarget,
  ScenarioMarks,
  TestScenarioStage,
  TestScenariosDocument,
  CritiqueDocument,
  CritiqueStatus,
  CritiqueSubject,
  TotpSetup,
} from "@ahtapot/shared";

/**
 * REST istemcisi — gövde tipleri paylaşılan Zod şemalarından.
 *
 * Kimlik HttpOnly oturum çerezinde; aynı origin'e giden her `fetch` onu
 * kendiliğinden taşır, WS yükseltmesi de. ESKİDEN token `localStorage`'dan
 * `Authorization` başlığıyla gidiyordu: WS başlık taşıyamadığı için canlı
 * akış token tanımlıyken hiç bağlanmıyordu ve token betikten okunabiliyordu.
 *
 * 401 gelince `UNAUTHORIZED_EVENT` yayınlanır; kabuk giriş ekranına döner
 * (oturumun süresi dolmuş ya da başka cihazdan TOTP bağlanıp kapatılmış olabilir).
 */

export const UNAUTHORIZED_EVENT = "ahtapot:unauthorized";

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: ApiError) {
    super(body.error);
    this.name = "HttpError";
  }
}

function onStatus(status: number): void {
  if (status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    // Giriş uçlarının kendi 401'i ("token hatalı") giriş ekranında gösterilir;
    // oturumu düşürme sinyali değil.
    if (!path.startsWith("/api/auth/")) onStatus(res.status);
    throw new HttpError(res.status, (json as ApiError) ?? { error: `HTTP ${res.status}` });
  }
  return json as T;
}

/**
 * Düz metin döndüren uçlar (build log dosyası).
 *
 * `call` gövdeyi JSON olarak ayrıştırıyor; log megabaytlarca ham metin ve
 * JSON değil. Hata gövdesi YİNE JSON'dur (`{ error }`), bu yüzden başarısız
 * yanıt normal yoldan ayrıştırılır.
 */
async function callText(path: string): Promise<string> {
  const res = await fetch(path);
  const text = await res.text();
  if (!res.ok) {
    onStatus(res.status);
    let body: ApiError = { error: `HTTP ${res.status}` };
    try {
      body = JSON.parse(text) as ApiError;
    } catch {
      /* hata gövdesi JSON değilse varsayılan mesaj kalır */
    }
    throw new HttpError(res.status, body);
  }
  return text;
}

/**
 * Dosya yükleme (ek görseller). `content-type` elle VERİLMEZ: `fetch` bunu
 * `FormData`dan kendi üretir, boundary de içinde — elle set etmek boundary'yi
 * kaybettirip sunucunun gövdeyi hiç ayrıştıramamasına yol açar.
 */
async function callUpload<T>(file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body: form });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    onStatus(res.status);
    throw new HttpError(res.status, (json as ApiError) ?? { error: `HTTP ${res.status}` });
  }
  return json as T;
}

// ── Tipler (sunucu satırlarının UI'da kullanılan alt kümesi) ────────────────

/** Sunucudaki `SourceSyncResult`'ın UI aynası (`workspace/sourceSync.ts`). */
export type SourceSyncResult =
  | { repo: string; status: "updated"; from: string; to: string }
  | { repo: string; status: "current" }
  | { repo: string; status: "skipped"; reason: string; dir: string; user: string };

export interface Project {
  id: string;
  slug: string;
  name: string;
  workspaceRoot: string;
  sourceGitUrl: string | null;
  workspaceStatus: "pending" | "ready" | "failed";
  workspaceError: string | null;
  activeProfileId: string | null;
  createdAt: string;
  runningAnalysisId: string | null;
  activeProfileVersion: number | null;
  jobStats: { waiting: number; running: number; costMicroUsd: number };
}

export interface ProjectDetail extends Project {
  activeProfile: { id: string; version: number; approvedAt: string | null; approvedBy: string | null } | null;
  latestAnalysis: { id: string; status: string; error: string | null; note: string | null; createdAt: string } | null;
  /** Dizini sunucu klonladıysa true — yalnız o zaman silmede dosyalar da gidebilir. */
  canRemoveFiles: boolean;
}

export interface ProfileRow {
  id: string;
  version: number;
  status: string;
  analysisId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface ValidationCheck {
  id: string;
  level: "ok" | "warn" | "error" | "skip";
  message: string;
}

export interface ProfileValidation {
  checks: ValidationCheck[];
  errors: number;
  warnings: number;
  ok: boolean;
}

export interface ProfileFull extends ProfileRow {
  document: ProjectProfile;
  rationale: Record<string, { why: string; source: string }> | null;
}

export interface Analysis {
  id: string;
  status: string;
  error: string | null;
  /** Analizi düşürmeyen not (ör. "agent DOCKERFILE bloğu üretmedi") — hata DEĞİL. */
  note: string | null;
  createdAt: string;
  profile: { id: string; version: number; status: string } | null;
}

export interface GithubIssueSummary {
  number: number;
  url: string;
  title: string;
  labels: string[];
  author: string;
  updatedAt: string;
  comments: number;
}

export interface GithubIssueDetail extends GithubIssueSummary {
  body: string;
  thread: { author: string; body: string; createdAt: string }[];
}

export interface GithubRepoSummary {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
  updatedAt: string;
  defaultBranchRef: string | null;
}

export interface Drift {
  known: boolean;
  stale: boolean;
  changed: string[];
  added: string[];
  removed: string[];
}

export interface Job {
  id: string;
  projectId: string;
  profileId: string | null;
  /** `GET /api/jobs` join'inden gelir; profil silinmiş/erişilemezse `null`. */
  profileVersion: number | null;
  title: string;
  description: string;
  source: string;
  externalRef: string | null;
  /** Dış kaydın sayfası (issue) — iş detayında bağlantı. */
  externalUrl: string | null;
  /** Boşsa Planner seçer. */
  targetRepos: string[];
  /** Host'taki emsal dizinleri — agent konteynerine salt okunur bağlanır. */
  referencePaths: string[];
  state: JobState;
  phase: JobPhase;
  loopCounts: Record<string, number>;
  branchName: string | null;
  worktreePath: string | null;
  costMicroUsd: number;
  /** İnsanın zorladığı model seviyesi; null → profil/triage zinciri. */
  modelTier: ModelTier | null;
  /** İşe özel canlı ortam değişkenleri; profilin ve orkestratörün değerlerini ezer. */
  liveEnv: Record<string, string>;
  /** Otopilot: geliştirme adımında safha onayı ve sorular insanı beklemez. */
  autopilot: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** İşe bağlı ek görsel (`GET /api/jobs/:id/attachments`). */
export interface JobAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface Transition {
  id: string;
  fromState: string;
  toState: string;
  reason: string;
  actorType: string;
  createdAt: string;
}

export interface PlanPhaseRow {
  id: string;
  order: number;
  title: string;
  rationale: string;
  files: string[];
  risk: string;
  status: string;
  exceedsFileCap: boolean;
}

export interface Approval {
  id: string;
  kind: string;
  subjectId: string | null;
  status: string;
  payload: unknown;
  comment: string;
  requestedAt: string;
  decidedAt: string | null;
}

/**
 * `qa_cases` satırı. Kapı payload'ındaki listeden farkı KALICI olması: onay
 * verilip kapı kapandıktan sonra da okunabilir (bkz. `QaTab`).
 */
export interface QaCaseRow {
  id: string;
  jobId: string;
  title: string;
  rationale: string;
  origin: "agent" | "human";
  included: boolean;
  createdAt: string;
}

export interface PlanView {
  id: string;
  version: number;
  status: string;
  document: PlanDocument;
  phases: PlanPhaseRow[];
  pendingApproval: Approval | null;
  versions: { id: string; version: number; status: string; createdAt: string }[];
  qaCases: QaCaseRow[];
}

/** Canlı test senaryosu isteği; `document` yalnız `ready`de dolu (şemaya uymazsa null). */
export interface TestScenariosRow {
  id: string;
  jobId: string;
  planId: string | null;
  stage: TestScenarioStage;
  status: "running" | "ready" | "failed";
  note: string;
  document: TestScenariosDocument | null;
  error: string;
  /** Senaryo anahtarı (`scenarioKey`) → işaret; sunucuda tutulur, red anında Developer'a gider. */
  marks: ScenarioMarks;
  /** Listenin şu anki canlı test turu; işaretin `round`u küçükse önceki turdandır. */
  round: number;
  createdAt: string;
}

/** İkinci göz satırı; `document` yalnız `ready`de dolu (şemaya uymazsa null). */
export interface CritiqueRow {
  id: string;
  jobId: string;
  subject: CritiqueSubject;
  subjectId: string;
  status: CritiqueStatus;
  model: string;
  document: CritiqueDocument | null;
  error: string;
  requestedBy: string;
  inputTokens: number | null;
  outputTokens: number | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface TestScenariosView {
  latest: TestScenariosRow | null;
  history: { id: string; stage: TestScenarioStage; status: string; createdAt: string }[];
}

/**
 * Profil imajı build'i. Profil onaylandığında (imaj yoksa ve `exec.dockerfile`
 * varsa) sunucu arka planda build eder; ilerleme WS'ten DEĞİL polling'le gelir.
 */
export interface ImageBuildRow {
  id: string;
  profileId: string;
  status: "running" | "succeeded" | "failed";
  imageRef: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SystemInfo {
  brand: string;
  /** Çalışan Ahtapot sürümü: imajda `1.14.5`, geliştirmede `git describe`, yoksa `dev`. */
  version: string;
  identities: { total: number; available: number; nextResetAt: string | null };
  /** Tanımlıysa "Klonla"/"GitHub'dan seç" modlarında workspace yolu otomatik türetilir. */
  workspacesRoot: boolean;
  /** Sunucunun GitHub kimliği var mı (değer dönmez). */
  github: { token: boolean };
  jobs: { running: number };
  at: string;
}

/** `GET /api/github/issues` — tüm workspace'lerin açık issue'ları, bağlı işiyle. */
export interface GithubIssueWithJob extends GithubIssueSummary {
  linkedJob: { id: string; state: JobState; phase: JobPhase } | null;
}

export interface GithubIssuesByProject {
  projectId: string;
  projectName: string;
  repo: string | null;
  /** Bu projenin `gh` çağrısı düştüyse; diğer projeler yine listelenir. */
  error: string | null;
  issues: GithubIssueWithJob[];
}

/** Issue şablonlarının hedef repodaki durumu (`tracker/issueTemplates.ts`). */
export type IssueTemplateState =
  | { state: "present" }
  | { state: "pending"; url: string }
  | { state: "declined"; url: string }
  | { state: "missing"; missing: string[]; defaultBranch: string }
  | { state: "opened"; url: string; paths: string[] };

export interface IssueTemplatesInfo {
  repo: string | null;
  status: IssueTemplateState | null;
}

/** `project_releases` satırı — hedef repodaki release workflow'unun bir tetiklenişi. */
export interface ReleaseRow {
  id: string;
  trigger: ReleaseTrigger;
  scheduledFor: string | null;
  status: ReleaseStatus;
  bump: ReleaseBump | null;
  repo: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  workflowFile: string | null;
  ref: string | null;
  skipReason: string | null;
  runUrl: string | null;
  tag: string | null;
  error: string | null;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

/** Hedef reponun güncel sürüm tag'i; okunamadıysa null. */
export interface ProjectVersion {
  repo: string;
  tag: string | null;
  version: string | null;
}

export interface ReleaseInfo {
  /** Onaylı profil yoksa null. */
  config: Release | null;
  current: ProjectVersion | null;
  pausedUntil: string | null;
  nextRunAt: string | null;
  inFlight: ReleaseRow | null;
  history: ReleaseRow[];
}

export interface ReleasePlan {
  repo: string;
  ref: string;
  workflowFile: string;
  fromTag: string | null;
  fromVersion: string | null;
  bump: ReleaseBump;
  toVersion: string;
  estimated: boolean;
  inputs: Record<string, string>;
  commits: number | null;
  ci: "success" | "failure" | "pending" | "none" | null;
  skipReason: string | null;
}

// ── Uçlar ────────────────────────────────────────────────────────────────────

/** `GET /api/projects/:id/agent-reads` gövdesinin UI'da kullanılan alt kümesi (`agents/readStats.ts`). */
export interface AgentReadStats {
  role: string;
  jobsAnalyzed: number;
  files: { path: string; jobs: number; reads: number; earlyJobs: number }[];
}

export const api = {
  system: () => call<SystemInfo>("GET", "/api/system"),

  authStatus: () => call<AuthStatus>("GET", "/api/auth/status"),
  login: (token: string) => call<AuthStatus>("POST", "/api/auth/login", { token }),
  loginTotp: (code: string) => call<AuthStatus>("POST", "/api/auth/totp", { code }),
  logout: () => call<{ ok: boolean }>("POST", "/api/auth/logout", {}),
  totpSetup: () => call<TotpSetup>("POST", "/api/auth/totp/setup", {}),
  totpConfirm: (code: string) => call<AuthStatus>("POST", "/api/auth/totp/confirm", { code }),
  totpDisable: (code: string) => call<AuthStatus>("POST", "/api/auth/totp/disable", { code }),

  pushStatus: () => call<PushStatus>("GET", "/api/push"),
  pushSubscribe: (sub: PushSubscriptionBody) =>
    call<{ ok: boolean; subscriptions: number }>("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) =>
    call<{ ok: boolean; subscriptions: number }>("POST", "/api/push/unsubscribe", { endpoint }),
  pushTest: () => call<{ ok: boolean; subscriptions: number; ntfy: boolean }>("POST", "/api/push/test", {}),

  projects: () => call<Project[]>("GET", "/api/projects"),
  workspaceProbe: (path: string) =>
    call<{ exists: boolean; isRepo: boolean; remoteUrl: string | null }>(
      "GET",
      `/api/workspace-probe?path=${encodeURIComponent(path)}`,
    ),
  referenceDirs: (q: string) =>
    call<{ root: string | null; dirs: string[] }>("GET", `/api/reference-dirs?q=${encodeURIComponent(q)}`),
  project: (id: string) => call<ProjectDetail>("GET", `/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => call<Project>("POST", "/api/projects", body),
  retryClone: (id: string) => call<Project>("POST", `/api/projects/${id}/retry-clone`, {}),
  syncSource: (id: string) =>
    call<{ results: SourceSyncResult[] }>("POST", `/api/projects/${id}/sync-source`, {}),
  deleteProject: (id: string, removeFiles: boolean) =>
    call<{ id: string; deleted: boolean; jobs: number; removedFiles: boolean; incomplete: string[] }>(
      "DELETE",
      `/api/projects/${id}`,
      { removeFiles },
    ),
  analyze: (id: string) => call<{ analysisId: string }>("POST", `/api/projects/${id}/analyze`, {}),
  analysis: (id: string) => call<Analysis>("GET", `/api/analyses/${id}`),
  drift: (id: string) => call<Drift>("GET", `/api/projects/${id}/drift`),
  profiles: (projectId: string) => call<ProfileRow[]>("GET", `/api/projects/${projectId}/profiles`),
  profile: (id: string) => call<ProfileFull>("GET", `/api/profiles/${id}`),
  validateProfile: (id: string) => call<ProfileValidation>("POST", `/api/profiles/${id}/validate`, {}),
  /** Kaydedilmemiş belgeyi doğrular; taslak sürüm doğurmaz. */
  validateProfileDraft: (projectId: string, document: unknown) =>
    call<ProfileValidation>("POST", `/api/projects/${projectId}/profiles/validate`, { document }),
  // imageBuildId: onay imajı otomatik build ettiyse dolu gelir (imaj zaten
  // varsa null). UI bunu görünce build durumunu polling'le izler.
  decideProfile: (id: string, decision: "approve" | "reject", comment = "") =>
    call<{ status: string; imageBuildId: string | null }>("POST", `/api/profiles/${id}/decision`, { decision, comment }),
  imageBuilds: (profileId: string) =>
    call<ImageBuildRow[]>("GET", `/api/profiles/${profileId}/image-builds`),
  imageBuild: (id: string) => call<ImageBuildRow & { hasLog: boolean }>("GET", `/api/image-builds/${id}`),
  imageBuildLog: (id: string) => callText(`/api/image-builds/${id}/log`),
  buildImage: (profileId: string) =>
    call<{ imageBuildId: string; status: string }>("POST", `/api/profiles/${profileId}/build-image`, {}),
  // droppedFields: sunucu şemadan geçerken sessizce düşen alanları döner
  // (projects.ts:droppedKeys) — form kaydettikten sonra bunu göstermeli.
  saveProfile: (projectId: string, document: unknown, note = "") =>
    call<ProfileRow & { droppedFields?: string[] }>("POST", `/api/projects/${projectId}/profiles`, { document, note }),
  deleteProfile: (id: string) => call<{ id: string; deleted: boolean }>("DELETE", `/api/profiles/${id}`),
  /** Tek işi başka bir profile taşır; profil verilmezse projenin güncel onaylısı. */
  retargetJob: (jobId: string, profileId?: string) =>
    call<{ jobId: string; profileId: string; version: number }>(
      "POST",
      `/api/jobs/${jobId}/profile`,
      profileId ? { profileId } : {},
    ),
  /** Projedeki TÜM işleri bu profile taşır; koşanlar atlanır ve dönüşte raporlanır. */
  applyProfileToJobs: (profileId: string) =>
    call<{
      profileId: string;
      version: number;
      moved: number;
      alreadyOnTarget: number;
      skipped: { id: string; title: string; reason: string }[];
    }>("POST", `/api/profiles/${profileId}/apply-to-jobs`, {}),

  githubIssue: (projectId: string, number: number) =>
    call<GithubIssueDetail>("GET", `/api/projects/${projectId}/github/issues/${number}`),
  issueTemplates: (projectId: string) =>
    call<IssueTemplatesInfo>("GET", `/api/projects/${projectId}/github/issue-templates`),
  proposeIssueTemplates: (projectId: string) =>
    call<IssueTemplatesInfo>("POST", `/api/projects/${projectId}/github/issue-templates`, {}),
  projectVersions: () => call<Record<string, ProjectVersion | null>>("GET", "/api/projects/versions"),
  release: (projectId: string) => call<ReleaseInfo>("GET", `/api/projects/${projectId}/release`),
  codeMap: (projectId: string) => call<CodeMapStatus>("GET", `/api/projects/${projectId}/codemap`),
  codeMapContent: (projectId: string) => call<{ map: CodeMap | null }>("GET", `/api/projects/${projectId}/codemap/map`),
  generateCodeMap: (projectId: string) =>
    call<{ started: boolean; status: CodeMapStatus }>("POST", `/api/projects/${projectId}/codemap`, {}),
  agentReads: (projectId: string, role: string) =>
    call<AgentReadStats>("GET", `/api/projects/${projectId}/agent-reads?role=${encodeURIComponent(role)}&top=500`),
  startRelease: (projectId: string, bump: ReleaseBump) =>
    call<{ releaseId: string }>("POST", `/api/projects/${projectId}/release`, { bump }),
  /** `bump` yoksa zamanlı turun planı. */
  releaseDryRun: (projectId: string, bump?: ReleaseBump) =>
    call<{ plan: ReleasePlan; warnings: string[]; nextRunAt: string | null }>(
      "POST", `/api/projects/${projectId}/release/dry-run`, bump ? { bump } : {},
    ),
  pauseRelease: (projectId: string, until: string | null) =>
    call<{ pausedUntil: string | null; nextRunAt: string | null }>("POST", `/api/projects/${projectId}/release/pause`, { until }),
  allGithubIssues: () =>
    call<{ fetchedAt: string; projects: GithubIssuesByProject[] }>("GET", "/api/github/issues"),
  githubRepos: () => call<{ repos: GithubRepoSummary[] }>("GET", "/api/github/repos"),

  upload: (file: File) =>
    callUpload<{ id: string; fileName: string; mimeType: string; sizeBytes: number }>(file),
  deleteUpload: (id: string) => call<{ ok: boolean }>("DELETE", `/api/uploads/${id}`),
  /** `<img src>` için adres — çerezle yetkilenir, `call` üzerinden geçmez. */
  uploadFileUrl: (id: string) => `/api/uploads/${id}/file`,
  /** Tarayıcı turunun kanıt görüntüsü; `ref` işaretteki `<tur>/<dosya>`. Çerezle yetkilenir. */
  liveEvidenceUrl: (jobId: string, ref: string) => `/api/jobs/${jobId}/live-evidence/${ref.split("/").map(encodeURIComponent).join("/")}`,
  jobAttachments: (jobId: string) => call<JobAttachment[]>("GET", `/api/jobs/${jobId}/attachments`),

  jobs: (projectId?: string) => call<Job[]>("GET", `/api/jobs${projectId ? `?projectId=${projectId}` : ""}`),
  job: (id: string) => call<Job & { transitions: Transition[] }>("GET", `/api/jobs/${id}`),
  createJob: (body: CreateJobBody) => call<Job>("POST", "/api/jobs", body),
  startJob: (id: string) => call<Job>("POST", `/api/jobs/${id}/start`, {}),
  planVersion: (id: string, planId: string) => call<PlanView>("GET", `/api/jobs/${id}/plans/${planId}`),
  liveDiff: (id: string) =>
    call<{ ready: boolean; reason: string; diff: { stat: string; patch: string; truncated: boolean; untracked: string[] } | null }>(
      "GET", `/api/jobs/${id}/diff`,
    ),
  /** `modelTier` verilmezse mevcut seçim korunur; `null` zorlamayı kaldırır. */
  retryJob: (id: string, modelTier?: ModelTier | null) =>
    call<{ jobId: string; state: string }>("POST", `/api/jobs/${id}/retry`, modelTier === undefined ? {} : { modelTier }),
  /** NeedsAttention işinin PR'ı için merge kapısını aç — CI kırmızı olsa bile. */
  openMergeGate: (id: string) =>
    call<{ jobId: string; state: string; gateId: string }>("POST", `/api/jobs/${id}/merge-gate`, {}),
  /** Done/NeedsAttention işini seçilen adımdan yeniden aç — aynı iş, aynı dal. */
  reopenJob: (id: string, body: { target: ReopenTarget; comment: string; modelTier?: ModelTier | null; attachmentIds?: string[] }) =>
    call<{ jobId: string; state: string }>("POST", `/api/jobs/${id}/reopen`, body),
  /** İşin model seviyesini deneme başlatmadan değiştir. */
  setModelTier: (id: string, tier: ModelTier | null) =>
    call<{ tier: ModelTier | null; model: string | null; effort: string | null }>("POST", `/api/jobs/${id}/model-tier`, { tier }),
  /** İşin otopilotunu aç/kapat — yalnız geliştirme adımını etkiler. */
  setAutopilot: (id: string, enabled: boolean) =>
    call<{ enabled: boolean }>("POST", `/api/jobs/${id}/autopilot`, { enabled }),
  answerPlanQuestions: (id: string, body: { answers: { question: string; answer: string }[]; comment: string }) =>
    call<{ jobId: string; state: string }>("POST", `/api/jobs/${id}/plan/answers`, body),
  /** Safha başına model seviyesini elle değiştir; `tier: null` motorun ölçümüne döner. */
  overridePhaseTiers: (id: string, body: { overrides: { order: number; tier: ModelTier | null }[]; comment: string }) =>
    call<{ jobId: string; phaseModels: PlanGatePayload["phaseModels"] }>("POST", `/api/jobs/${id}/phase-tiers`, body),
  /** Safha kapısında sıradaki safha ve koşacağı model; son safhada `null`. */
  nextPhase: (id: string) => call<{ next: NextPhaseView | null }>("GET", `/api/jobs/${id}/next-phase`),
  cancelJob: (id: string, reason = "") => call<unknown>("POST", `/api/jobs/${id}/cancel`, { reason }),
  plan: (jobId: string) => call<PlanView>("GET", `/api/jobs/${jobId}/plan`),
  approvals: (jobId: string) => call<Approval[]>("GET", `/api/jobs/${jobId}/approvals`),
  decide: (gateId: string, body: ApprovalDecisionBody) =>
    call<{ jobId: string; state: JobState }>("POST", `/api/approvals/${gateId}/decide`, body),
  chat: (jobId: string, body: ChatBody) => call<{ accepted: boolean; reason: string }>("POST", `/api/jobs/${jobId}/chat`, body),
  /** Aktif canlı ortam — yoksa `active: null`. */
  live: (jobId: string) => call<{ active: { id: string; status: string; appUrl: string } | null }>("GET", `/api/jobs/${jobId}/live`),
  setLiveEnv: (jobId: string, env: Record<string, string>) =>
    call<{ env: Record<string, string> }>("PUT", `/api/jobs/${jobId}/live/env`, { env }),
  relaunchLive: (jobId: string) =>
    call<{ jobId: string; state: JobState }>("POST", `/api/jobs/${jobId}/live/relaunch`, {}),
  stopLive: (jobId: string) => call<{ stopped: boolean }>("POST", `/api/jobs/${jobId}/live/stop`, {}),
  extendLive: (jobId: string, minutes: number) => call<{ expiresAt: string }>("POST", `/api/jobs/${jobId}/live/extend`, { minutes }),
  testScenarios: (jobId: string) => call<TestScenariosView>("GET", `/api/jobs/${jobId}/test-scenarios`),
  /** Canlı test senaryosu iste — 202; sonuç `testScenarios` yoklanarak gelir. */
  generateTestScenarios: (jobId: string, note: string) =>
    call<{ id: string }>("POST", `/api/jobs/${jobId}/test-scenarios`, { note }),
  /** İşin tüm ikinci göz eleştirileri, yeniden eskiye. */
  critiques: (jobId: string) => call<{ critiques: CritiqueRow[] }>("GET", `/api/jobs/${jobId}/critiques`),
  /** Elle yeniden incele — 202; sonuç `critique.updated` olayıyla gelir. */
  requestCritique: (jobId: string, subject: CritiqueSubject, subjectId: string) =>
    call<{ id: string }>("POST", `/api/jobs/${jobId}/critiques`, { subject, subjectId }),
  /** Tek senaryonun işareti; `state: null` kaldırır. Yalnız canlı testte. */
  setScenarioMark: (jobId: string, rowId: string, key: string, state: "pass" | "fail" | "unsure" | null, note = "") =>
    call<{ marks: ScenarioMarks }>("PUT", `/api/jobs/${jobId}/test-scenarios/${rowId}/marks/${key}`, { state, note }),
  answer: (jobId: string, body: AnswerBody) => call<{ ok: boolean }>("POST", `/api/jobs/${jobId}/answer`, body),

  /** Build adımları — sekme geçmişi. Canlı satırlar WS'ten gelir. */
  builds: (jobId: string) => call<BuildRow[]>("GET", `/api/jobs/${jobId}/builds`),
  /** Bir adımın tam log dosyası (düz metin). */
  buildLog: (jobId: string, buildId: string) => callText(`/api/jobs/${jobId}/builds/${buildId}/log`),
};

export interface BuildRow {
  id: string;
  phaseId: string | null;
  stepName: string;
  command: string;
  skipped: boolean;
  skipReason: string | null;
  exitCode: number | null;
  durationMs: number | null;
  hasLog: boolean;
  createdAt: string;
}
