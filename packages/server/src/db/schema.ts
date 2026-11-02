import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

import type { StepChecklist } from "@ahtapot/shared";

/**
 * Veritabanı şeması — SQLite bugün, PostgreSQL yarın.
 *
 * Taşınabilirlik kuralları (hepsi bilinçli, geçişin bedelini baştan ödüyoruz):
 *
 *  • PK: TEXT UUIDv7. SQLite AUTOINCREMENT ile PG IDENTITY arasındaki fark
 *    geçişte acı verir; v7 zaman sıralı olduğu için index'te de artan anahtar
 *    kadar iyi davranır.
 *  • Zaman: TEXT, ISO-8601 UTC. SQLite'ta native tarih tipi yok. ISO UTC
 *    leksikografik sıralandığında kronolojik sıralanır; PG'de timestamptz'ye
 *    cast tek satırdır.
 *  • Boolean: INTEGER 0/1, Drizzle mode:"boolean" ile TS tarafında boolean.
 *  • JSON: TEXT + mode:"json". PG'de jsonb'ye geçerken sütun tipi değişir,
 *    uygulama kodu değişmez.
 *  • Para: INTEGER mikro-dolar. Float para asla — $1.23 → 1_230_000.
 *  • ENUM yok: TEXT + uygulama katmanında Zod union. PG enum'ları migration'da
 *    baş belasıdır.
 *  • Büyük metin ayrı tabloda/dosyada: ana tabloların satırları küçük kalsın.
 */

const now = () => new Date().toISOString();

/** Her tabloda tekrarlayan zaman damgaları. */
const stamps = {
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
};

// ── Projeler ve profiller ────────────────────────────────────────────────────

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Hedef workspace'in disk yolu. Sistemin parçası değil, dışarıdan bağlanır. */
  workspaceRoot: text("workspace_root").notNull(),
  /** Klonun kaynağı — yalnız `gitUrl` ile oluşturulan projelerde dolu. */
  sourceGitUrl: text("source_git_url"),
  /**
   * pending|ready|failed (bkz. `WorkspaceStatusSchema`). YALNIZ clone akışı ve
   * `retry-clone` ucu yazar; analiz/job akışları dokunmaz. "pending" iken
   * proje analiz edilemez. `gitUrl` verilmeden oluşturulan projeler doğrudan
   * "ready" doğar.
   */
  workspaceStatus: text("workspace_status").notNull().default("ready"),
  workspaceError: text("workspace_error"),
  /** Şu an geçerli olan onaylı profil. Yoksa proje henüz kullanılamaz. */
  activeProfileId: text("active_profile_id"),
  /**
   * Zamanlı yayın bu ana dek duraklatıldı. Profilde DEĞİL: duraklatma
   * çalışma zamanı kararı, yeni profil sürümü ve onay istememeli.
   */
  releasePausedUntil: text("release_paused_until"),
  archivedAt: text("archived_at"),
  ...stamps,
});

/**
 * Profil versiyonlanır ve ONAYLANIR. Analyst taslak üretir (`draft`), insan
 * inceleyip onaylar (`approved`). Yalnız onaylı profil pipeline'da kullanılır —
 * yanlış bir build komutu tüm işleri bozar, bu yüzden kapı var.
 */
export const projectProfiles = sqliteTable(
  "project_profiles",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"), // draft|approved|superseded|rejected
    /** ProjectProfileSchema ile doğrulanmış tam profil. */
    document: text("document", { mode: "json" }).notNull(),
    /** Analyst'in her alan için gerekçesi (dosya:satır referanslarıyla). */
    rationale: text("rationale", { mode: "json" }),
    analysisId: text("analysis_id"),
    approvedAt: text("approved_at"),
    approvedBy: text("approved_by"),
    ...stamps,
  },
  (t) => [uniqueIndex("ux_profile_project_version").on(t.projectId, t.version)],
);

/**
 * Workspace analizi — Analyst agent'ın ham çıktısı ve bayatlık takibi.
 *
 * `fingerprint`: yapısal imza (sln/compose/CLAUDE.md hash'leri). Workspace
 * değiştiğinde profil "bayatladı" uyarısı bununla verilir.
 */
export const workspaceAnalyses = sqliteTable(
  "workspace_analyses",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    status: text("status").notNull().default("running"), // running|succeeded|failed
    fingerprint: text("fingerprint", { mode: "json" }),
    findings: text("findings", { mode: "json" }),
    error: text("error"),
    /**
     * Analizi DÜŞÜRMEYEN ama insanın bilmesi gereken not — bugün yalnız
     * Dockerfile tarafı kullanıyor ("agent DOCKERFILE bloğu üretmedi",
     * "blok reddedildi: …").
     *
     * `error`dan AYRI: UI `error` dolu olan analizi kırmızı hata kutusuyla
     * gösteriyor ve `(status='succeeded', error != null)` bileşimi diğer
     * okuyucuların varsaymadığı bir durum üretiyordu. Başarılı bir analizde
     * normal bir durumu hata gibi göstermemek için ayrı alan.
     */
    note: text("note"),
    agentRunId: text("agent_run_id"),
    ...stamps,
  },
  (t) => [index("ix_analysis_project").on(t.projectId, t.createdAt)],
);

/**
 * Profil imajı build'i — `exec.dockerfile`daki tarifin `exec.image` etiketine
 * dönüştürülmesi.
 *
 * Profil onaylandığında (imaj yoksa) sunucu arka planda `docker build` koşar.
 * İlerleme WS'ten değil POLLING ile okunur: `job_events` iş kimliğine bağlı,
 * bu build ise profil seviyesinde ve henüz ortada iş yok.
 *
 * `logRef` dosya yolu taşır (`builds.logRef` kalıbı): `docker build` çıktısı
 * onlarca MB olabilir, DB satırına gömülmez.
 */
export const profileImageBuilds = sqliteTable(
  "profile_image_builds",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull().references(() => projectProfiles.id),
    status: text("status").notNull().default("running"), // running|succeeded|failed
    /** Build edilen etiket — profil sonradan değişse de kaydın neyi ürettiği bilinir. */
    imageRef: text("image_ref").notNull(),
    /** `<artifactsDir>/image-builds/<id>.log` — sırlar maskelenmiş hâlde. */
    logRef: text("log_ref"),
    error: text("error"),
    ...stamps,
  },
  (t) => [index("ix_image_build_profile").on(t.profileId, t.createdAt)],
);

/**
 * Hedef repodaki release workflow'unun bir tetiklenişi (elle ya da zamanlı).
 *
 * `scheduledFor` zamanlı turun yuvasıdır ve (proje, yuva) TEKİLDİR: dispatch
 * ile sonucun yazılması arasında süreç ölürse açılışta kayıt `unknown` olur
 * ama yuva harcanmıştır — aynı tur ikinci kez yayınlanmaz. Elle yayında null
 * (SQLite ve PG unique index'te null'ları ayrı sayar).
 */
export const projectReleases = sqliteTable(
  "project_releases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    profileId: text("profile_id"),
    trigger: text("trigger").notNull(), // ReleaseTriggerSchema
    scheduledFor: text("scheduled_for"),
    status: text("status").notNull().default("starting"), // ReleaseStatusSchema
    /** Ne olduğu (patch|minor|major); atlanan turda boş kalabilir. */
    bump: text("bump"),
    repo: text("repo"),
    fromVersion: text("from_version"),
    /** Ahtapot'un hesapladığı sürüm; `versionInput` yoksa yalnız tahmin. */
    toVersion: text("to_version"),
    workflowFile: text("workflow_file"),
    ref: text("ref"),
    skipReason: text("skip_reason"),
    /** Workflow'a `correlationInput` ile geçen kimlik; koşu `run-name`inde aranır. */
    correlationId: text("correlation_id"),
    runId: text("run_id"),
    runUrl: text("run_url"),
    /** Koşu bitince gerçekten oluşan tag — doğrulanan sürüm budur. */
    tag: text("tag"),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    dispatchedAt: text("dispatched_at"),
    finishedAt: text("finished_at"),
    ...stamps,
  },
  (t) => [
    index("ix_release_project").on(t.projectId, t.createdAt),
    uniqueIndex("ux_release_project_slot").on(t.projectId, t.scheduledFor),
  ],
);

// ── İşler ───────────────────────────────────────────────────────────────────

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    /** İşin koştuğu profil sürümü — profil değişse bile iş kendi sürümünü izler. */
    profileId: text("profile_id").references(() => projectProfiles.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),

    /**
     * Dış sistem referansı. TAŞIYICIYA ÖZEL ALAN ŞEMAYA GİRMEZ — DevAgent'ta
     * `clickUpTaskId` wire şemasına sızmıştı ve ClickUp'tan kopmayı imkânsız
     * kılıyordu. Burada kaynak ayrı bir alan.
     */
    externalRef: text("external_ref"),
    /** Dış kaydın insana açılan adresi (issue sayfası). */
    externalUrl: text("external_url"),
    source: text("source").notNull().default("ui"),

    state: text("state").notNull().default("Draft"),
    /** starting|running|waiting|paused|done — kesinti dayanıklılığının anahtarı. */
    phase: text("phase").notNull().default("done"),
    priority: integer("priority").notNull().default(0),

    /**
     * Dalın GitHub'daki `defaultBranch` ucuyla birleştiği commit (SHA).
     *
     * Yerel `defaultBranch` referansı bunun yerine KULLANILMAZ: mirror'ın
     * kaynağı kullanıcının checkout'u ve `pullBase()` uzak ucu dala merge eder
     * ama yerel `main`i ilerletmez. `main..HEAD` aralığı o yüzden başkalarının
     * commit'lerini de "bu işin değişikliği" sayıyordu; yerel inceleme o
     * dosyaları inceledi, Developer başkasının kodunu "düzeltti" (Northwind#184).
     * Null: uzak çekilemedi, eski davranışa (yerel taban) düşülür.
     */
    baseSha: text("base_sha"),
    /** {build:2, qa:1, live:3} — tavan aşılınca NeedsAttention. */
    loopCounts: text("loop_counts", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .$defaultFn(() => ({})),
    /**
     * `reviewLoop()`da gerekçeyle (kod değişikliği olmadan) yanıtlanmış
     * GitHub inceleme başlığı id'leri (GraphQL node id).
     *
     * `openReviewThreads()` yalnız GitHub'ın KENDİ `isResolved` bayrağına
     * bakıyor (bkz. `github.ts`); ne motor ne Developer bir başlığı GitHub'da
     * resolve edebiliyor — gerekçeli ret hiçbir zaman GitHub'a yazılmıyor. Bu
     * yüzden aynı başlık `openReviewThreads()`ta SONSUZA DEK açık görünür.
     * Bellek içi bir `Set` (eskiden `reviewLoop()`un yerel değişkeniydi) yalnız
     * TEK çağrı içinde koruyordu; "bir tur daha" onayı her seferinde yeni bir
     * `reviewLoop()` açtığı için (`decideReviewRound`) aynı başlık her onayda
     * yeniden Developer'a gidiyordu. Ölçüldü (2026-09-27). `loopCounts`daki
     * gibi retry/modelTier'da SIFIRLANMAZ: bir başlığın zaten yanıtlandığı
     * gerçeği modelden ya da profil sürümünden bağımsız.
     */
    reviewHandledThreads: text("review_handled_threads", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    /**
     * TAMAMLANMIŞ adımlar: bugün PR zinciri — güvenlik, kod
     * kalitesi, yerel inceleme, bot incelemesi.
     *
     * Temiz geçen bir adım iz bırakmıyordu (tur sayaçları yalnız bulgu
     * varken artıyor); PR açılmadan düşen iş "yeniden dene" ile zinciri
     * BAŞTAN koşuyor, aynı kodu yeniden inceliyordu. Kod PRReview'dan önceki
     * bir adımda (Developing, QA, LiveTest…) yeniden değişince silinir.
     */
    stepChecklist: text("step_checklist", { mode: "json" })
      .$type<StepChecklist>()
      .notNull()
      .$defaultFn(() => ({})),
    targetRepos: text("target_repos", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    /**
     * İşe bağlı emsal yolları (host) — agent konteynerine salt okunur bağlanır.
     * İş açılırken sabitlenir: konteyner bir kez kurulur ve bağlamaları sonradan
     * değişmez.
     */
    referencePaths: text("reference_paths", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),

    branchName: text("branch_name"),
    worktreePath: text("worktree_path"),

    /**
     * İnsanın bu işe zorladığı model SEVİYESİ (cheap|standard|deep|frontier);
     * null → profil/triage zinciri. Model adı değil: kullanımda profilin
     * merdiveninden çözülür (kural 8 — kayıttaki dizeye güvenilmez).
     */
    modelTier: text("model_tier"),
    /**
     * İşe özel canlı ortam değişkenleri; canlı ortam her kalktığında profilin
     * ve orkestratörün değerlerinin ÜSTÜNE yazılır. Koşan ortama geçmez —
     * "Yeniden kaldır" ya da yeniden deneme gerekir.
     */
    liveEnv: text("live_env", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .$defaultFn(() => ({})),
    /**
     * Otopilot: yalnız geliştirme adımında (Developing/Building) insan
     * beklenmez — safha kapısı kendiliğinden onaylanır, Developer'ın soruları
     * "kendin karar ver" cevabı alır. Sonraki kapılar (canlı test, QA, PR)
     * etkilenmez. İşe özel; koşarken açılıp kapanabilir.
     */
    autopilot: integer("autopilot", { mode: "boolean" }).notNull().default(false),

    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    completedAt: text("completed_at"),
    ...stamps,
  },
  (t) => [
    index("ix_jobs_project_state").on(t.projectId, t.state),
    index("ix_jobs_state_updated").on(t.state, t.updatedAt),
    index("ix_jobs_external").on(t.source, t.externalRef),
  ],
);

/** Durum makinesi denetim izi — UI'daki zaman çizelgesinin kaynağı. */
export const jobTransitions = sqliteTable(
  "job_transitions",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text("reason").notNull().default(""),
    /** human|agent|system */
    actorType: text("actor_type").notNull().default("system"),
    actor: text("actor"),
    payload: text("payload", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_transitions_job").on(t.jobId, t.createdAt)],
);

/**
 * Dış takipçiye (issue) yapılmış yan etkilerin kaydı — idempotency.
 *
 * Uzlaştırma ve yeniden başlatma aynı `job.state` olayını tekrar yayınlayabilir;
 * bellek içi "görüldü" kümesi süreçle ölür ve issue'ya aynı yorum iki kez düşer.
 * Anahtar yalnız yan etki BAŞARILI olunca yazılır: düşen çağrı sonraki olayda
 * yeniden denenir.
 */
export const externalSync = sqliteTable(
  "external_sync",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    /** `assign:self`, `transition:<id>`, `live:<gateId>`, `close` … */
    key: text("key").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("ux_external_sync_job_key").on(t.jobId, t.key)],
);

/**
 * İş açma formundaki ek görseller (ekran görüntüsü, tasarım). İki aşamalı:
 * `POST /api/uploads` job YOKKEN diske yazar (id burada üretilir), iş
 * oluşurken `jobId` bu satıra SONRADAN yazılır. Job hiç açılmazsa satır
 * `jobId: null` kalır — temizlik kapsam dışı (Faz 1: tek kullanıcı, düşük hacim).
 */
export const jobAttachments = sqliteTable(
  "job_attachments",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").references(() => jobs.id),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** `<artifactsDir>/uploads/<id>-<fileName>` — jobId atanınca taşınmaz, referans kalır. */
    path: text("path").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_attachments_job").on(t.jobId)],
);

// ── Planlar ve safhalar ─────────────────────────────────────────────────────

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"), // draft|under_review|approved|rejected|superseded
    /** PlanDocumentSchema. */
    document: text("document", { mode: "json" }).notNull(),
    agentRunId: text("agent_run_id"),
    approvedAt: text("approved_at"),
    approvedBy: text("approved_by"),
    ...stamps,
  },
  (t) => [uniqueIndex("ux_plan_job_version").on(t.jobId, t.version)],
);

/**
 * Safhalar ayrı tabloda: her biri kendi onayını taşıyor.
 *
 * "Her safhadan sonra DUR ve onay iste" kuralının veri karşılığı. Faz sonunu
 * beklemek yetmez — dokuz safhalık bir fazın sonunda sunulan diff incelenemeyecek
 * kadar büyük olur ve yanlış kararın üzerine sekiz safha daha inşa edilir.
 */
export const planPhases = sqliteTable(
  "plan_phases",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => plans.id),
    jobId: text("job_id").notNull().references(() => jobs.id),
    order: integer("order").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull().default(""),
    files: text("files", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    risk: text("risk").notNull().default("low"),
    /** pending|running|awaiting_approval|approved|rejected|skipped */
    status: text("status").notNull().default("pending"),
    /** Dosya tavanını aşıyorsa gerekçe `rationale`da olmalı. */
    exceedsFileCap: integer("exceeds_file_cap", { mode: "boolean" }).notNull().default(false),
    /**
     * Motorun bu safha için türettiği seviye — `stages.perPhase` açıkken dolu.
     *
     * NULL anlamlı: safha ölçümü koşmadı, iş geneli `postplan` seçimi geçerli.
     * Model ADI saklanmaz; karar anında `rungFor` ile merdivenden yeniden
     * çözülür (kural 8) — merdiven değişmiş olabilir ve kayıttaki dizeye
     * güvenmek eski bir ayarı diriltmek olurdu.
     */
    tier: text("tier"),
    /** Bu seviye `approvalRequiredFrom` eşiğini aştı — insan onayı şart. */
    tierRequiresApproval: integer("tier_requires_approval", { mode: "boolean" }).notNull().default(false),
    /**
     * `engine`|`human` — seviyeyi kim koydu.
     *
     * Ayrı kolon, çünkü `tier`in kendisi bunu söylemiyor: insanın `deep`
     * dediği safha ile motorun `deep` ölçtüğü safha aynı değerde ama aynı
     * şey değil. Plan düzenlenip safhalar yeniden yazıldığında insanın
     * seçimi taşınır, motorunki yeniden ölçülür.
     */
    tierSource: text("tier_source").notNull().default("engine"),
    /**
     * Motorun ÖLÇTÜĞÜ seviye — insan değiştirse de saklanır.
     *
     * "Geri al" bunu geri koyar; ayrıca "insan hangi safhalarda motoru ne
     * kadar aşağı çekiyor" sorusu ancak ikisi yan yana durursa cevaplanır.
     * NULL: müdahale yok, `tier` zaten motorunki.
     */
    derivedTier: text("derived_tier"),
    approvedAt: text("approved_at"),
    ...stamps,
  },
  (t) => [
    uniqueIndex("ux_phase_plan_order").on(t.planId, t.order),
    index("ix_phase_job_status").on(t.jobId, t.status),
  ],
);

// ── Agent oturumları ve turları ─────────────────────────────────────────────

/** SDK oturumu — `resume` anahtarını taşır. */
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    role: text("role").notNull(),
    /** SDK'nın kendi session id'si; resume bununla yapılır. */
    sdkSessionId: text("sdk_session_id"),
    model: text("model").notNull(),
    status: text("status").notNull().default("open"), // open|closed
    transcriptRef: text("transcript_ref"),
    totalCostMicroUsd: integer("total_cost_micro_usd").notNull().default(0),
    closedAt: text("closed_at"),
    ...stamps,
  },
  (t) => [index("ix_sessions_job_role").on(t.jobId, t.role)],
);

/** Tek `query()` çağrısı. Token metrikleri bağlam penceresi takibi için. */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => agentSessions.id),
    jobId: text("job_id").references(() => jobs.id),
    role: text("role").notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    status: text("status").notNull().default("running"), // running|success|error|interrupted|quota
    /** Havuzdaki kimliğin sırası — anahtarın KENDİSİ asla saklanmaz. */
    identityIndex: integer("identity_index"),
    startedAt: text("started_at").notNull().$defaultFn(now),
    endedAt: text("ended_at"),
    numTurns: integer("num_turns").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    stopReason: text("stop_reason"),
    errorMessage: text("error_message"),
  },
  (t) => [
    index("ix_runs_job").on(t.jobId, t.startedAt),
    index("ix_runs_session").on(t.sessionId),
  ],
);

// ── Mesajlar ve olaylar ─────────────────────────────────────────────────────

/**
 * UI'ın ana beslemesi. `seq` iş içinde monoton artar ve WS replay bunu kullanır.
 *
 * `content` 64KB'ı aşarsa artifacts'a dosya olarak yazılır ve burada özet+referans
 * kalır — aksi hâlde SQLite dosyası aylar içinde onlarca GB olur.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    runId: text("run_id").references(() => agentRuns.id),
    seq: integer("seq").notNull(),
    role: text("role").notNull(), // user|assistant|system|tool|tool_result
    kind: text("kind").notNull(), // text|thinking|tool_use|tool_result|question|answer|notice
    content: text("content").notNull().default(""),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("ux_messages_job_seq").on(t.jobId, t.seq)],
);

/**
 * WS olay günlüğü — yeniden bağlanmada `sinceSeq` ile replay edilir.
 *
 * `agent.delta` olayları BURAYA YAZILMAZ: token akışı hacimlidir ve replay'de
 * tamamlanmış `agent.message` zaten nihai içeriği taşır.
 */
export const jobEvents = sqliteTable(
  "job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("ux_events_job_seq").on(t.jobId, t.seq)],
);

// ── Onaylar ve QA case'leri ─────────────────────────────────────────────────

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").references(() => jobs.id),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind").notNull(), // profile|plan|phase|live_test|qa_cases|pr_open
    /** Onayın bağlı olduğu kayıt (plan, safha, profil...). */
    subjectId: text("subject_id"),
    status: text("status").notNull().default("pending"),
    payload: text("payload", { mode: "json" }),
    /** İnsanın yaptığı düzenlemeler (plan değişikliği, case ekleme). */
    edits: text("edits", { mode: "json" }),
    comment: text("comment").notNull().default(""),
    requestedAt: text("requested_at").notNull().$defaultFn(now),
    decidedAt: text("decided_at"),
    decidedBy: text("decided_by"),
  },
  (t) => [index("ix_approvals_job_status").on(t.jobId, t.status)],
);

/** QA case listesi — agent önerir, insan ekler/çıkarır, sonra testler yazılır. */
export const qaCases = sqliteTable(
  "qa_cases",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    title: text("title").notNull(),
    rationale: text("rationale").notNull().default(""),
    origin: text("origin").notNull().default("agent"), // agent|human
    included: integer("included", { mode: "boolean" }).notNull().default(true),
    ...stamps,
  },
  (t) => [index("ix_qa_cases_job").on(t.jobId)],
);

/**
 * Canlı test senaryoları — insan düğmeyle ister, `tester` rolü yazar.
 *
 * Her istek yeni satır: plan anında üretilen liste canlı testte yenisiyle
 * değişebilir, ama eskisi iz olarak kalır. UI en yenisini gösterir.
 * `running` satır sunucu ölürse sahipsiz kalır — açılışta `failed` yazılır
 * (bkz. `reconcile`).
 */
export const testScenarios = sqliteTable(
  "test_scenarios",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    planId: text("plan_id").references(() => plans.id),
    stage: text("stage").notNull(), // plan|live
    status: text("status").notNull().default("running"), // running|ready|failed
    /** İnsanın odak notu. */
    note: text("note").notNull().default(""),
    /** `TestScenariosDocumentSchema` — okurken yine Zod'dan geçer; `ready` olana dek null. */
    document: text("document", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error").notNull().default(""),
    requestedBy: text("requested_by").notNull().default("human"),
    /**
     * `ScenarioMarksSchema` — senaryo anahtarı → geçti/kaldı/tekrar test.
     * Okurken Zod'dan geçer. Liste turlar boyunca aynı satırda sürer.
     * NULL olabilir: sütun sonradan eklendi ve SQL varsayılanı JSON'u çift
     * kodlardı; eski satırlar NULL okunur, `{}` sayılır.
     */
    marks: text("marks", { mode: "json" })
      .$type<Record<string, unknown>>()
      .$defaultFn(() => ({})),
    /** Bu liste kaçıncı canlı test turunda; her red'de artar. */
    round: integer("round").notNull().default(1),
    ...stamps,
  },
  (t) => [index("ix_test_scenarios_job").on(t.jobId, t.createdAt)],
);

/**
 * İkinci göz: plan sürümünün ya da senaryo listesinin ikinci
 * model tarafından eleştirisi.
 *
 * `plans`/`test_scenarios`a sütun değil, ayrı tablo: her plan sürümü ve her
 * elle "yeniden incele" yeni satır — geçmiş kalır. `subject_id` iki ayrı
 * tabloya baktığı için FK yok.
 */
export const critiques = sqliteTable(
  "critiques",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    subject: text("subject").notNull(), // plan|scenarios
    /** `plans.id` ya da `test_scenarios.id`. */
    subjectId: text("subject_id").notNull(),
    status: text("status").notNull().default("running"), // running|ready|failed|skipped
    model: text("model").notNull().default(""),
    /** `CritiqueDocumentSchema` — okurken yine Zod'dan geçer; `ready` olana dek null. */
    document: text("document", { mode: "json" }).$type<Record<string, unknown>>(),
    /** `failed`/`skipped` sebebi — insan neden koşmadığını görmeli. */
    error: text("error").notNull().default(""),
    requestedBy: text("requested_by").notNull().default("engine"),
    /** Sağlayıcının bildirdiği; `cost_records`a yazılmaz. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    finishedAt: text("finished_at"),
    ...stamps,
  },
  (t) => [index("ix_critiques_subject").on(t.jobId, t.subjectId, t.createdAt)],
);

// ── Build, test, artifact ───────────────────────────────────────────────────

export const builds = sqliteTable(
  "builds",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    phaseId: text("phase_id").references(() => planPhases.id),
    stepName: text("step_name").notNull(),
    command: text("command").notNull(),
    /** Koşullu eşleme tutmadığı için atlandıysa neden atlandığı. */
    skipped: integer("skipped", { mode: "boolean" }).notNull().default(false),
    skipReason: text("skip_reason").notNull().default(""),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms").notNull().default(0),
    logRef: text("log_ref"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_builds_job").on(t.jobId, t.createdAt)],
);

export const testRuns = sqliteTable(
  "test_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    suiteId: text("suite_id").notNull(),
    kind: text("kind").notNull().default("run"), // baseline|run
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    /** Baseline'da da kırık olanlar — agent'ın sorumluluğu değil. */
    preexistingFailures: text("preexisting_failures", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    reportRef: text("report_ref"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_tests_job").on(t.jobId, t.createdAt)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    runId: text("run_id").references(() => agentRuns.id),
    type: text("type").notNull(), // plan|diff|build_log|test_report|handoff|screenshot
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    sha256: text("sha256"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_artifacts_job_type").on(t.jobId, t.type)],
);

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    provider: text("provider").notNull().default("github"),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    state: text("state").notNull().default("draft"),
    ciStatus: text("ci_status"),
    reviewStatus: text("review_status"),
    mergedAt: text("merged_at"),
    ...stamps,
  },
  (t) => [
    index("ix_prs_job").on(t.jobId),
    uniqueIndex("ux_pr_provider_repo_number").on(t.provider, t.repo, t.number),
  ],
);

/**
 * Köprü kimlik doğrulama token'ları — konteyner başına bir satır.
 *
 * Token ÖNCEDEN yalnızca bellekteydi (`BridgeRegistry.tokens`). Sunucu yeniden
 * başlayınca kayboluyordu; ayakta kalan konteynerin köprüsü eski token'la
 * bağlanıp reddediliyor, 30 sn'de bir yeniden deniyor ve `acquire` 60 sn sonra
 * düşüyordu. Çare olarak konteyner "bayat" sayılıp siliniyordu — içinde koşan
 * agent'la birlikte (yaşandı; `runtime.ts` o yolu hâlâ taşıyor).
 *
 * SHA-256 HASH saklanır, token'ın kendisi değil (kural 4): DB okuyan biri
 * konteynere bağlanamamalı. Doğrulama sabit zamanlı karşılaştırmayla yapılır.
 */
export const bridgeTokens = sqliteTable("bridge_tokens", {
  jobId: text("job_id").primaryKey().references(() => jobs.id),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

// ── Kaynaklar ───────────────────────────────────────────────────────────────

/**
 * TEK TAHSİS OTORİTESİ. Port, DB, worktree, ağ ve kimlik kiraları burada.
 *
 * Kısmi benzersiz index (`WHERE state='held'`) aynı kaynağın iki işe birden
 * verilmesini veritabanı seviyesinde imkânsız kılar. Hem SQLite hem PG destekler.
 */
export const resourceLeases = sqliteTable(
  "resource_leases",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").references(() => jobs.id),
    kind: text("kind").notNull(), // port|db|worktree|network|identity|live_env
    value: text("value").notNull(),
    state: text("state").notNull().default("held"), // held|released
    acquiredAt: text("acquired_at").notNull().$defaultFn(now),
    expiresAt: text("expires_at"),
    releasedAt: text("released_at"),
  },
  (t) => [
    uniqueIndex("ux_lease_kind_value_held")
      .on(t.kind, t.value)
      .where(sql`state = 'held'`),
    index("ix_leases_job").on(t.jobId),
  ],
);

export const liveEnvironments = sqliteTable(
  "live_environments",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    composeProject: text("compose_project").notNull(),
    networkName: text("network_name").notNull(),
    appUrl: text("app_url"),
    ports: text("ports", { mode: "json" })
      .$type<number[]>()
      .notNull()
      .$defaultFn(() => []),
    dbVolume: text("db_volume"),
    status: text("status").notNull().default("starting"), // starting|ready|unhealthy|stopped
    startedAt: text("started_at").notNull().$defaultFn(now),
    expiresAt: text("expires_at"),
    stoppedAt: text("stopped_at"),
  },
  (t) => [index("ix_live_job").on(t.jobId)],
);

// ── Kimlik havuzu ve maliyet ────────────────────────────────────────────────

/**
 * Kimlik havuzu DURUMU. ANAHTARIN KENDİSİ ASLA BURADA DEĞİL — anahtarlar
 * repo dışındaki bir dosyada durur ve konteynere daima TEK anahtar geçer.
 */
export const identities = sqliteTable("identities", {
  id: text("id").primaryKey(),
  indexNo: integer("index_no").notNull().unique(),
  label: text("label").notNull().default(""),
  kind: text("kind").notNull().default("api_key"), // oauth|api_key
  /** Kota dolduğunda dinlenmeye alınır. */
  cooldownUntil: text("cooldown_until"),
  lastUsedAt: text("last_used_at"),
  totalMicroUsd: integer("total_micro_usd").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  ...stamps,
});

/**
 * Triage ölçümü — model yönlendirmesinin denetim izi.
 *
 * Neden ayrı tablo: seçilen modelin GEREKÇESİ sonradan sorulabilmeli.
 * "Bu iş neden Haiku'ya gitti?" sorusunun cevabı ölçümün kendisidir; yalnız
 * seçilen modeli saklamak eşiklerin doğru ayarlanıp ayarlanmadığını
 * değerlendirmeyi imkânsız kılar.
 *
 * `subjectId` postplan aşamasında plan kimliğini taşır; intake'te boştur
 * (henüz plan yok).
 */
export const triageResults = sqliteTable(
  "triage_results",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    /** intake | postplan */
    stage: text("stage").notNull(),
    /** Postplan'da `plans.id`; intake'te null. */
    subjectId: text("subject_id"),
    /** TriageDocumentSchema — ölçümün tamamı. */
    doc: text("doc", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    /** Seçilen seviye ve karşılığı — merdiven değişirse geçmiş bozulmasın. */
    tier: text("tier").notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    /** Blok gelmedi ya da eksikti; ölçüm kısmen sentezlendi. */
    synthesized: integer("synthesized", { mode: "boolean" }).notNull().default(false),
    /** İnsan onayı gerekti mi (pahalı seviye eşiği). */
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(false),
    runId: text("run_id").references(() => agentRuns.id),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_triage_job_stage").on(t.jobId, t.stage)],
);

export const costRecords = sqliteTable(
  "cost_records",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").references(() => jobs.id),
    runId: text("run_id").references(() => agentRuns.id),
    role: text("role").notNull(),
    model: text("model").notNull(),
    microUsd: integer("micro_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_cost_job").on(t.jobId), index("ix_cost_created").on(t.createdAt)],
);

// ── Denetim izi ─────────────────────────────────────────────────────────────

/**
 * Operatör eylemleri: onaylar, elle durum değişiklikleri, profil düzenlemeleri,
 * kimlik işlemleri. Heartbeat ve boş-kuyruk yoklamaları BURAYA YAZILMAZ —
 * dakikada birkaç kayıt, gerçek eylemleri gürültüde boğardı.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull().default("system"),
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    detail: text("detail", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ix_audit_created").on(t.createdAt)],
);

// ── Kullanıcı doğrulama ve bildirim ─────────────────────────────────────────

/**
 * Tarayıcı oturumları.
 *
 * Neden çerez oturumu, `localStorage`daki token değil: tarayıcının WebSocket
 * API'si başlık gönderemiyor, token tanımlıyken `/ws` yükseltmesi 401 ile
 * düşüyordu. Aynı origin'den giden HttpOnly çerez hem REST'e hem WS'e gider
 * ve betik tarafından okunamaz.
 *
 * `stage`: `pending_totp` — token doğrulandı, ikinci adım bekleniyor (kısa
 * ömürlü, hiçbir API'ye erişemez); `full` — oturum açık.
 *
 * Token'ın SHA-256 HASH'i saklanır (köprü token'larıyla aynı gerekçe): DB'yi
 * okuyan biri oturum çalamamalı.
 */
export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    stage: text("stage").notNull(), // pending_totp|full
    userAgent: text("user_agent").notNull().default(""),
    ip: text("ip").notNull().default(""),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull().$defaultFn(now),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("ux_auth_sessions_token").on(t.tokenHash), index("ix_auth_sessions_expires").on(t.expiresAt)],
);

/**
 * TOTP ikinci adımı (RFC 6238). Tek kullanıcı: en fazla bir satır anlamlı —
 * `confirmedAt` boşsa kurulum yarımdır ve girişte SORULMAZ.
 *
 * `lastStep`: son kabul edilen zaman adımı. Aynı kod pencere içinde ikinci kez
 * kullanılamaz (omuz üstünden okunan kodla tekrar giriş).
 *
 * Sır düz metin: sunucunun kendisi kodu hesaplamak zorunda, şifrelense de
 * anahtar aynı makinede duracaktı. DB dosyası `keys.txt` ile aynı güven
 * sınırında.
 */
export const authTotp = sqliteTable("auth_totp", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  confirmedAt: text("confirmed_at"),
  lastStep: integer("last_step").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

/**
 * Web Push abonelikleri — cihaz başına bir satır (endpoint benzersiz).
 *
 * Push servisi 404/410 dönerse abonelik ölüdür ve silinir; üst üste başka
 * hatalar `failures` sayacında birikir.
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    keys: text("keys", { mode: "json" }).$type<{ p256dh: string; auth: string }>().notNull(),
    userAgent: text("user_agent").notNull().default(""),
    failures: integer("failures").notNull().default(0),
    lastSentAt: text("last_sent_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("ux_push_endpoint").on(t.endpoint)],
);

/**
 * Sunucunun kendi ürettiği kalıcı ayarlar (ör. VAPID anahtar çifti).
 *
 * VAPID anahtarı her açılışta yeniden üretilirse tüm abonelikler geçersiz
 * olur — telefon bildirimi sessizce kesilir. Bu yüzden ilk üretimde yazılır.
 */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  ...stamps,
});
