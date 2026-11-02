import { z } from "zod";
import { JobStateSchema, JobPhaseSchema, AgentRoleNameSchema, ApprovalKindSchema } from "./job.js";
import { CritiqueStatusSchema, CritiqueSubjectSchema } from "./critique.js";

/**
 * WebSocket protokolü — canlı etkileşimin sözleşmesi.
 *
 * Her sunucu olayı monoton artan bir `seq` taşır ve `job_events` tablosuna
 * yazılır. İstemci yeniden bağlanırken `sinceSeq` gönderir ve eksikleri replay
 * eder: tarayıcı sekmesi uyuduğunda 20 dakikalık bir agent turu kaybolmamalı.
 *
 * TEK İSTİSNA `agent.delta`: token akışı DB'ye yazılmaz (hacim). Replay'de
 * onun yerine tamamlanmış `agent.message` gösterilir — nihai içerik asla kaybolmaz.
 */

// ── Sunucu → İstemci ─────────────────────────────────────────────────────────

const ServerEventBase = z.object({
  seq: z.number().int().nonnegative(),
  jobId: z.string().min(1),
  at: z.string(), // ISO-8601 UTC
});

export const ServerEventSchema = z.discriminatedUnion("type", [
  ServerEventBase.extend({
    type: z.literal("job.state"),
    state: JobStateSchema,
    phase: JobPhaseSchema,
    loopCounts: z.record(z.string(), z.number().int()).default({}),
  }),

  ServerEventBase.extend({
    type: z.literal("agent.start"),
    runId: z.string(),
    role: AgentRoleNameSchema,
    model: z.string(),
    sessionId: z.string().nullable(),
  }),

  /** Token akışı. DB'ye YAZILMAZ; 50ms pencerelerde toplanarak gönderilir. */
  ServerEventBase.extend({
    type: z.literal("agent.delta"),
    runId: z.string(),
    blockIndex: z.number().int().nonnegative(),
    text: z.string(),
  }),

  ServerEventBase.extend({
    type: z.literal("agent.message"),
    runId: z.string(),
    role: z.enum(["assistant", "user", "system"]),
    content: z.string(),
  }),

  ServerEventBase.extend({
    type: z.literal("agent.thinking"),
    runId: z.string(),
    text: z.string(),
  }),

  /** Araç girdisi ÖZETLENİR — tam içerik değil (hacim + sır riski). */
  ServerEventBase.extend({
    type: z.literal("agent.tool_use"),
    runId: z.string(),
    toolId: z.string(),
    name: z.string(),
    inputSummary: z.string(),
    /**
     * Kabuk komutunun KENDİSİ — yalnız Bash/shell araçlarında dolu.
     *
     * `inputSummary` girdinin 200 karakterde kesilmiş JSON'u: UI oradan komutu
     * güvenilir biçimde çıkaramıyor (kesme JSON'u ortasından bölüyor, kaçışlar
     * okunmuyor). Operatör akışta "ne koştu" sorusunu en çok soruyor; komut
     * ayrı ve ham alanda taşınır.
     *
     * İsteğe bağlı: bu alan eklenmeden yazılmış olaylar replay'de doğrulanmalı.
     */
    command: z.string().optional(),
    /** Komutun çalıştığı dizin — varsa gösterilir. */
    cwd: z.string().optional(),

    /**
     * Dosya aracının dokunduğu yol (Read/Edit/Write/NotebookEdit).
     *
     * `inputSummary`den çıkarılamıyor: JSON 200 karakterde kesiliyor ve kesme
     * çoğu zaman `file_path` değerinin ortasına düşüyor. Operatör akışta
     * "hangi dosya" sorusunu komut sorusu kadar sık soruyor.
     */
    file: z.string().optional(),

    /**
     * Ölçü çipleri — "168 satır", "+6 −2", "1 eşleşme".
     *
     * Serbest dize dizisi, şema değil: her aracın ölçüsü farkı ve motor yeni
     * araç gördüğünde şema değiştirmek zorunda kalmamalı. UI sırayla basar.
     */
    meta: z.array(z.string()).default([]),

    /**
     * Edit'in satır satır farkı — `["-", eski]` / `["+", yeni]`.
     *
     * YAŞANDI: `old_string`/`new_string` `inputSummary` içinde ham JSON olarak
     * basılıyordu; tek satıra sığmadığı için kesiliyor ve operatör ne
     * değiştiğini JSON ayrıştırmadan okuyamıyordu. Fark ÜRETİCİ tarafta
     * çıkarılır çünkü kesilmemiş girdiyi yalnız orası görür.
     */
    diff: z.array(z.tuple([z.enum(["-", "+"]), z.string()])).default([]),
  }),

  ServerEventBase.extend({
    type: z.literal("agent.tool_result"),
    runId: z.string(),
    toolId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    /**
     * Kabuk komutunun çıkış kodu — yalnız Bash sonuçlarında.
     *
     * `ok` yetmiyor: "exit 1" ile "exit 137" (OOM kill) operatör için aynı şey
     * değil. SDK sonucu metin taşıdığı için çıkarılabildiği kadar çıkarılır,
     * bulunamazsa alan hiç yazılmaz.
     */
    exitCode: z.number().int().optional(),
    /** Aracın sürdüğü süre (ms) — tool_use'tan sonucuna kadar ölçülür. */
    durationMs: z.number().int().nonnegative().optional(),
    /**
     * Sonucun özetlenmeden önceki uzunluğu (karakter). `summary` kesik
     * olduğundan bir okumanın bağlama ne kadar yük getirdiği yalnız buradan
     * bilinir — tekrar eden okumaların maliyet ölçümü buna dayanır.
     */
    chars: z.number().int().nonnegative().optional(),
  }),

  /** Agent insana soru sordu; cevap gelene kadar araç çağrısı bekler. */
  ServerEventBase.extend({
    type: z.literal("agent.question"),
    runId: z.string(),
    questionId: z.string(),
    text: z.string(),
    options: z.array(z.string()).default([]),
  }),

  /**
   * Motor agent'ın döngüde olduğundan şüpheleniyor (karar §33).
   *
   * Agent'ın metninden değil araç davranışından çıkarılır. Gözlem modunda
   * yalnız bu olay düşer; kayıtlı kalır çünkü eşikler bu kayıtlarla ölçülecek.
   */
  ServerEventBase.extend({
    type: z.literal("agent.stuck"),
    runId: z.string(),
    role: AgentRoleNameSchema,
    model: z.string(),
    signal: z.enum(["repeat_read", "repeat_failure", "no_progress"]),
    /** Okunan yol, arama deseni ya da kırılan komut; `no_progress`te boş. */
    target: z.string().default(""),
    count: z.number().int().positive(),
    /** İnsanın okuyacağı tek satır. */
    detail: z.string().default(""),
  }),

  /**
   * Takılan agent bir üst basamağa danıştı (karar §33).
   *
   * `advised`: öneri koşan oturuma teslim edilmek üzere bırakıldı.
   * `skipped`: danışma yapılmadı (`reason`): tavan, basamak yok, eski köprü,
   * kota. Kayıtlı kalır — maliyet ve isabet buradan ölçülür.
   */
  ServerEventBase.extend({
    type: z.literal("agent.mentor"),
    /** Junior'un koşusu. */
    runId: z.string(),
    role: AgentRoleNameSchema,
    juniorModel: z.string(),
    mentorModel: z.string().default(""),
    signal: z.enum(["repeat_read", "repeat_failure", "no_progress"]),
    target: z.string().default(""),
    outcome: z.enum(["advised", "skipped"]),
    advice: z.string().default(""),
    reason: z.string().default(""),
    costMicroUsd: z.number().int().nonnegative().default(0),
  }),

  ServerEventBase.extend({
    type: z.literal("agent.end"),
    runId: z.string(),
    subtype: z.string(),
    costMicroUsd: z.number().int().nonnegative().default(0),
    numTurns: z.number().int().nonnegative().default(0),
    durationMs: z.number().int().nonnegative().default(0),
  }),

  ServerEventBase.extend({
    type: z.literal("approval.required"),
    gateId: z.string(),
    kind: ApprovalKindSchema,
    payload: z.unknown(),
  }),

  /** Build/test çıktısı — secret scrubbing'den GEÇMİŞ hâli. */
  ServerEventBase.extend({
    type: z.literal("build.log"),
    stream: z.enum(["stdout", "stderr"]),
    line: z.string(),
    /**
     * Adım başlangıcından bu yana geçen süre (`m:ss.d`).
     *
     * `at` DEĞİL: o, her olayda bulunan mutlak ISO damgadır ve hub doldurur.
     * Buradaki değer adıma görelidir — "npm ci'nin 2. dakikasında asıldı"
     * okunabilsin diye. Mutlak saatten çıkarmak için her satırda adımın
     * başlangıcını bilmek gerekirdi.
     *
     * İsteğe bağlı: bu alan eklenmeden önce yazılmış olaylar replay'de hâlâ
     * doğrulanmalı.
     */
    elapsed: z.string().optional(),
  }),

  ServerEventBase.extend({
    type: z.literal("live.ready"),
    url: z.string(),
    ports: z.array(z.number().int()),
    expiresAt: z.string(),
  }),

  /**
   * İkinci gözün (§42) durumu değişti. İçerik değil kimlik taşır: UI REST'ten
   * yeniden çeker. Bulgular `critiques` satırında; olay replay'de yalnız
   * "burada bir eleştiri vardı" der.
   */
  ServerEventBase.extend({
    type: z.literal("critique.updated"),
    critiqueId: z.string(),
    subject: CritiqueSubjectSchema,
    subjectId: z.string(),
    status: CritiqueStatusSchema,
  }),

  ServerEventBase.extend({
    type: z.literal("cost.update"),
    totalMicroUsd: z.number().int().nonnegative(),
    byRole: z.record(z.string(), z.number().int()).default({}),
  }),

  ServerEventBase.extend({
    type: z.literal("job.error"),
    code: z.string(),
    message: z.string(),
  }),

  /**
   * İş kalıcı olarak silindi — iptal artık `Cancelled` durumunda bırakmaz,
   * işe ait her şeyi (satırlar, worktree, konteyner) kaldırır. DB'ye YAZILMAZ
   * (job zaten siliniyor, `job_events`e yazacak satır kalmıyor); yalnız o an
   * bağlı izleyicilere anlık duyuru. `seq` bu yüzden her zaman 0 — canlı
   * izleyici görmezse kayıp değildir, REST liste zaten satırı döndürmeyecek.
   */
  ServerEventBase.extend({
    type: z.literal("job.deleted"),
    reason: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ── İstemci → Sunucu ─────────────────────────────────────────────────────────

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    jobId: z.string().min(1),
    /** Verilirse bu seq'ten sonraki olaylar replay edilir. */
    sinceSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), jobId: z.string().min(1) }),

  /**
   * Canlı mesaj enjeksiyonu. İçerik <user_message> sınırlayıcısı içinde agent'a
   * geçer: yönlendirmedir, ama güvenlik kurallarını, araç kısıtlarını ve onay
   * kapılarını EZEMEZ.
   *
   * `interrupt: true` → mevcut tur kesilir ve mesaj hemen işlenir. Aksi hâlde
   * agent onu ancak tur sınırında görür.
   */
  z.object({
    type: z.literal("chat.send"),
    jobId: z.string().min(1),
    text: z.string().min(1).max(32_000),
    interrupt: z.boolean().default(false),
  }),

  z.object({
    type: z.literal("question.answer"),
    questionId: z.string().min(1),
    answer: z.string(),
  }),

  z.object({
    type: z.literal("approval.decide"),
    gateId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    comment: z.string().default(""),
    /** Plan/QA case onayında insanın yaptığı düzenlemeler. */
    edits: z.unknown().optional(),
    /** Önce `/api/uploads` ile yüklenmiş görseller (bkz. `ApprovalDecisionBodySchema`). */
    attachmentIds: z.array(z.string().min(1)).max(10).optional(),
  }),

  z.object({
    type: z.literal("job.interrupt"),
    jobId: z.string().min(1),
    reason: z.string().default(""),
  }),

  z.object({
    type: z.literal("live.extend"),
    jobId: z.string().min(1),
    minutes: z.number().int().positive().max(480),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ── Köprü ↔ Sunucu (konteyner içi) ───────────────────────────────────────────

/**
 * Agent konteyneri içindeki köprü, sunucuya DIŞARI DOĞRU bağlanır — konteynere
 * port açmak gerekmez. Bu kanal iş boyunca açık kalır; kimlik devretmesi bile
 * konteyneri öldürmez (kimlik her `query()` çağrısına `options.env` ile verilir).
 *
 * Köprü APTALDIR: SDK mesajlarını olduğu gibi iletir, yorumlamaz. Kota imzası,
 * maliyet, kalıcılık — hepsi sunucuda, tek yerde. Köprü yalnız "akış bitti"
 * (`bridge.done`) ve "akış patladı" (`bridge.error`) der.
 */
export const BridgeHelloSchema = z.object({
  type: z.literal("bridge.hello"),
  jobId: z.string().min(1),
  token: z.string().min(1),
  bridgeVersion: z.string(),
  /**
   * DEVRALMA: bağlantı koptuğunda köprü koşuyu KESMEZ; agent konteynerde
   * çalışmayı sürdürür ve olaylar tamponda birikir. Yeniden bağlanınca köprü
   * hâlâ canlı koşuyu burada bildirir, sunucu `run.attach` ile devralır.
   *
   * ÖNCEDEN köprü soket kapanınca `q.interrupt()` çağırıyordu: 2 saniyelik bir
   * sunucu yeniden başlatması 38 dakikalık bir Developer turunu öldürüyordu.
   *
   * `null` → konteynerde koşan bir şey yok (normal ilk bağlantı).
   */
  activeRunId: z.string().nullable().optional(),
  /** Tamponun EN ESKİ olayının sırası; sunucu boşluğu buradan anlar. */
  bufferedFrom: z.number().int().nonnegative().optional(),
  /** Tampon taştı ve baştan N olay atıldı — sessiz kayıp olmasın. */
  droppedEvents: z.number().int().nonnegative().optional(),
  /**
   * Köprünün anladığı isteğe bağlı mesajlar. `guide`: `run.hold`/`run.guide`
   * (karar §33). İmajı tazelenmemiş eski köprü bunu bildirmez; sunucu ona bu
   * mesajları göndermez — tanımadığı mesajda koşu sessizce askıda kalmasın.
   */
  capabilities: z.array(z.string()).optional(),
});

export const BridgeToServerSchema = z.discriminatedUnion("type", [
  BridgeHelloSchema,
  /**
   * Ham SDK mesajı. `runId` sunucunun `run.start` ile verdiği kimlik.
   *
   * `seq` koşu içinde 1'den artar: devralmada sunucu `run.attach{sinceSeq}`
   * der, köprü tampondan o noktadan sonrasını yollar. Eski köprülerle uyum
   * için isteğe bağlı.
   */
  z.object({ type: z.literal("bridge.event"), runId: z.string(), event: z.unknown(), seq: z.number().int().optional() }),
  /** Bu koşunun akışı bitti; hata olduysa önce `bridge.error` gelmiştir. */
  z.object({ type: z.literal("bridge.done"), runId: z.string() }),
  /** Agent `ask_user` aracını çağırdı; cevap `run.answer` ile gelir. */
  z.object({
    type: z.literal("bridge.question"),
    runId: z.string(),
    questionId: z.string(),
    text: z.string(),
    options: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("bridge.error"),
    runId: z.string().nullable(),
    code: z.string(),
    message: z.string(),
  }),
]);
export type BridgeToServer = z.infer<typeof BridgeToServerSchema>;

/**
 * Köprünün Playwright MCP'yi nasıl başlatacağı. Ekran görüntüsü dosya adları
 * MCP'nin çalışma köküne göre çözüldüğü için süreç `outputDir`de başlatılır;
 * worktree'de başlasaydı kanıtlar diff'e girerdi.
 */
export const BrowserRunConfigSchema = z.object({
  /** Konteyner içi kanıt dizini; yoksa köprü yaratır. */
  outputDir: z.string().min(1),
  /** Tarayıcının istek atabileceği kökenler. Güvenlik sınırı DEĞİL (MCP belgesi), gürültü süzgeci. */
  allowedOrigins: z.array(z.string()).default([]),
  viewport: z.string().optional(),
  testIdAttribute: z.string().optional(),
  /**
   * Ad → değer. Köprü koşu başına `0600` dotenv dosyasına yazar, koşu bitince
   * siler. Kimlik gibi yalnız bu koşuya aittir; log'a yazılmaz.
   */
  secrets: z.record(z.string(), z.string()).default({}),
});
export type BrowserRunConfig = z.infer<typeof BrowserRunConfigSchema>;

/**
 * Köprünün Trail kod grafiği MCP'sini nasıl başlatacağı (karar §44). Grafik
 * koşudan ÖNCE motor tarafından kurulmuştur; köprü kurmaz, yalnız sunar.
 * Grafik dizini worktree'nin DIŞINDA: içeride olsaydı diff'e girerdi.
 */
export const CodeGraphRunConfigSchema = z.object({
  servers: z.array(z.object({
    /** MCP sunucu adı; araçlar `mcp__<ad>__trail_*` olarak görünür. */
    name: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    /** Konteyner içi repo kökü (worktree). */
    repoDir: z.string().min(1),
    /** Konteyner içi grafik dizini (`trail --dir`). */
    graphDir: z.string().min(1),
  })).min(1),
});
export type CodeGraphRunConfig = z.infer<typeof CodeGraphRunConfigSchema>;

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ServerToBridgeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.start"),
    runId: z.string(),
    role: AgentRoleNameSchema,
    prompt: z.string(),
    model: z.string(),
    effort: z.string().optional(),
    maxTurns: z.number().int().positive(),
    maxBudgetUsd: z.number().positive(),
    /** Konteyner içi yol — sunucu host yolunu çevirir. */
    cwd: z.string(),
    /**
     * true: prompt ilk mesajdır, kanal açık kalır ve `run.input` ile beslenir;
     * `run.close` gelene kadar oturum canlı. false: tek atış, sonuçla biter.
     */
    live: z.boolean().default(false),
    permissionMode: PermissionModeSchema.optional(),
    /** `ask_user` cevabı bu kadar beklenir; sonra agent varsayımıyla sürer. */
    askTimeoutMinutes: z.number().int().positive().default(30),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    resumeSessionId: z.string().nullable().optional(),
    /**
     * Varsa koşuya Playwright MCP eklenir (karar §41). Yalnız `browser`
     * yeteneğini bildiren köprüye gönderilir: eski köprü alanı sessizce
     * atar ve agent tarayıcısız koşardı.
     */
    browser: BrowserRunConfigSchema.optional(),
    /** Varsa Trail MCP eklenir (karar §44). Yalnız `codegraph` yeteneğini bildiren köprüye. */
    codeGraph: CodeGraphRunConfigSchema.optional(),
  }),
  /** Canlı mesaj — streaming input kanalına push edilir. */
  z.object({
    type: z.literal("run.input"),
    runId: z.string(),
    text: z.string(),
    interrupt: z.boolean().default(false),
  }),
  /** Kanalı nazikçe kapat: mevcut tur biter, akış `bridge.done` ile son bulur. */
  z.object({ type: z.literal("run.close"), runId: z.string() }),
  z.object({ type: z.literal("run.answer"), questionId: z.string(), answer: z.string() }),
  /** Turu kes: SDK `interrupt()`, kanal kapanır. */
  z.object({ type: z.literal("run.abort"), runId: z.string(), reason: z.string().default("") }),
  /**
   * DEVRALMA: köprünün `bridge.hello`da bildirdiği canlı koşuyu üstlen.
   * Köprü tampondaki olayları `sinceSeq`ten itibaren yeniden yollar; koşu
   * kesilmez. Sunucu devralmak istemiyorsa `run.abort` gönderir.
   */
  z.object({ type: z.literal("run.attach"), runId: z.string(), sinceSeq: z.number().int().nonnegative().default(0) }),
  /**
   * Kimlik devri — konteyner DAİMA TEK anahtar görür. Bir sonraki `run.start`
   * bu kimlikle koşar; köprü onu `process.env`e değil `options.env`e koyar.
   */
  z.object({ type: z.literal("identity.set"), envName: z.string(), value: z.string() }),
  /**
   * Mentor danışması başladı: agent'ın sıradaki araç çağrısını beklet
   * (karar §33). Süre dolarsa köprü kendiliğinden serbest bırakır.
   */
  z.object({ type: z.literal("run.hold"), runId: z.string(), timeoutMs: z.number().int().positive() }),
  /** Mentor cevabı; `text` boşsa danışma atlandı, yalnız serbest bırakılır. */
  z.object({ type: z.literal("run.guide"), runId: z.string(), text: z.string().default("") }),
]);
export type ServerToBridge = z.infer<typeof ServerToBridgeSchema>;
