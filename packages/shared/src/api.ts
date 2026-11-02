import { z } from "zod";
import { ProjectProfileSchema, ReleaseBumpSchema } from "./profile.js";
import { JobStateSchema, ModelTierSchema, ReopenTargetSchema } from "./job.js";
import { CritiqueSubjectSchema } from "./critique.js";

/**
 * REST gövdeleri — sunucu ile UI arasındaki sözleşme.
 *
 * Her istek gövdesi burada tanımlanır ve sunucu tarafında Zod ile doğrulanır;
 * UI aynı şemadan tip türetir. İki tarafın ayrı ayrı "ne bekliyoruz" yazması
 * DevAgent'ta beş yerde tüketilen markdown şemasının tekrarı olurdu.
 *
 * Yanıt gövdeleri DB satırlarından türer ve burada tekrar tanımlanmaz; yalnız
 * hata zarfı ortaktır.
 */

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "küçük harf, rakam ve tire");

// ── Projeler ─────────────────────────────────────────────────────────────────

export const CreateProjectBodySchema = z.object({
  slug: Slug,
  name: z.string().min(1).max(200),
  /**
   * Hedef workspace'in disk yolu. Verilmezse VE `gitUrl` verilmişse VE
   * sunucuda AHTAPOT_WORKSPACES_ROOT tanımlıysa, sunucu `<kök>/<repo-adı>`
   * olarak türetir (bkz. POST /api/projects). Şema burada XOR ilişkisini
   * KURAMAZ — "workspacesRoot tanımlı mı" sunucu config'ine ait bir bilgi;
   * eksik kombinasyon route handler'ında 400 ile yakalanır.
   */
  workspaceRoot: z.string().min(1).optional(),
  /** Verilirse ve workspaceRoot yoksa, sunucu buradan klonlar (bkz. `WorkspaceStatusSchema`). */
  gitUrl: z.string().min(1).optional(),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

/** Klonla kurulan workspace'in durumu — yalnız clone akışı ve `retry-clone` ucu yazar. */
export const WorkspaceStatusSchema = z.enum(["pending", "ready", "failed"]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

/**
 * Proje (workspace) silme. `removeFiles` yalnız sunucunun KENDİ klonladığı
 * dizinde geçerlidir (`sourceGitUrl` dolu ve `AHTAPOT_WORKSPACES_ROOT` altında);
 * dışarıdan bağlanan bir repo (ör. `C:\src\northwind`) asla silinmez.
 */
export const DeleteProjectBodySchema = z.object({
  removeFiles: z.boolean().default(false),
});
export type DeleteProjectBody = z.infer<typeof DeleteProjectBodySchema>;

/** Analiz başlatma — hepsi isteğe bağlı, varsayılanlar Analyst'te. */
export const AnalyzeBodySchema = z.object({
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().max(500).optional(),
  maxBudgetUsd: z.number().positive().max(100).optional(),
});
export type AnalyzeBody = z.infer<typeof AnalyzeBodySchema>;

// ── Profiller ────────────────────────────────────────────────────────────────

/**
 * İnsan eliyle yazılmış ya da düzenlenmiş taslak. Analyst çıktısıyla aynı
 * şemadan geçer: elle yazılan profil de "üretici taraf"tır.
 */
export const CreateProfileBodySchema = z.object({
  document: ProjectProfileSchema,
  note: z.string().max(2000).default(""),
});
export type CreateProfileBody = z.infer<typeof CreateProfileBodySchema>;

export const ProfileDecisionBodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(2000).default(""),
});
export type ProfileDecisionBody = z.infer<typeof ProfileDecisionBodySchema>;

// ── Release (hedef repodaki yayın Action'ı) ──────────────────────────────────

/** Elle yayın: insan bump türünü seçer; `auto` yalnız zamanlı turdadır. */
export const StartReleaseBodySchema = z.object({
  bump: ReleaseBumpSchema,
});
export type StartReleaseBody = z.infer<typeof StartReleaseBodySchema>;

/**
 * Zamanlı yayını duraklatır (`until` gelene dek) ya da sürdürür (`null`).
 * Profil DEĞİL: "bu hafta yayınlama" operasyonel bir karar, yeni profil
 * sürümü ve onay istememeli.
 */
export const PauseReleaseBodySchema = z.object({
  until: z.iso.datetime().nullable(),
});
export type PauseReleaseBody = z.infer<typeof PauseReleaseBodySchema>;

export const ReleaseTriggerSchema = z.enum(["manual", "schedule"]);
export type ReleaseTrigger = z.infer<typeof ReleaseTriggerSchema>;

/**
 * starting: niyet yazıldı, dispatch henüz yapılmadı (kural 2).
 * unknown: süreç dispatch sırasında öldü ya da koşu eşlenemedi — workflow
 *   tetiklenmiş OLABİLİR, ikinci kez denenmez.
 */
export const ReleaseStatusSchema = z.enum([
  "starting", "dispatched", "running", "succeeded", "failed", "skipped", "unknown",
]);
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

// ── İşler ────────────────────────────────────────────────────────────────────

/**
 * Emsal yolu agent konteynerine bağlanabilir mi? Sorun varsa metni, yoksa null.
 *
 * `ReadOnly` bind soketi KORUMAZ: bağlanan `docker.sock`a salt okunur mount'tan
 * da bağlanılır ve agent Docker'ı, dolayısıyla host'u yönetir. Kök dizin tüm
 * host ağacını açar. Sunucu host yolunu `stat` edemeyebilir (kendisi konteynerde
 * koşabilir, yol Windows'ta olabilir) — denetim bu yüzden biçimsel. Sunucu şeması
 * ve iş açma formu AYNI kuralı kullanır.
 */
export function referencePathProblem(p: string): string | null {
  if (!/^([A-Za-z]:[\\/]|\/)/.test(p)) return "mutlak host yolu olmalı (E:\\... ya da /...)";
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (n === "" || /^[A-Za-z]:$/.test(n)) return "kök dizin bağlanamaz";
  const segs = n.split("/");
  if (segs.includes("..") || segs.includes(".")) return "yol '..' ya da '.' içeremez";
  if (segs.some((s) => s.toLowerCase().endsWith(".sock"))) return "soket bağlanamaz";
  if (/^\/(proc|sys|dev|run|var\/run)(\/|$)/.test(n)) return "sistem dizini bağlanamaz";
  return null;
}

export const CreateJobBodySchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(300),
  description: z.string().max(64_000).default(""),
  /**
   * Dış sistem referansı ve kaynağı AYRI alanlar: taşıyıcıya özel bir ad
   * (clickUpTaskId gibi) şemaya girmez.
   */
  externalRef: z.string().max(200).optional(),
  /** Dış kaydın insana açılan adresi (issue sayfası) — iş detayında bağlantı. */
  externalUrl: z.url({ protocol: /^https?$/ }).max(500).optional(),
  source: z.string().min(1).max(50).default("ui"),
  /** Boşsa Planner seçer, insan plan onayında düzeltir. */
  targetRepos: z.array(z.string().min(1)).default([]),
  /**
   * Emsal yolları — HOST'taki mutlak dizinler ("şuradaki plugin'lere bak").
   * Agent konteynerine salt okunur bağlanır; agent'a konteyner içi yolu
   * söylenir. Var olmayan yol konteyner kurulurken Docker hatasıyla düşer.
   */
  referencePaths: z.array(
    z.string().trim().max(500).superRefine((p, ctx) => {
      const problem = referencePathProblem(p);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  ).max(10).default([]),
  priority: z.number().int().min(-10).max(10).default(0),
  /** `POST /api/uploads`den dönen kimlikler — iş oluşunca eklere bağlanır. */
  attachmentIds: z.array(z.string().min(1)).default([]),
});
export type CreateJobBody = z.infer<typeof CreateJobBodySchema>;

export const CancelJobBodySchema = z.object({
  reason: z.string().max(2000).default(""),
});
export type CancelJobBody = z.infer<typeof CancelJobBodySchema>;

/**
 * Kapanmış/takılmış işi seçilen adımdan yeniden aç.
 *
 * `comment` hedefe göre anlam kazanır: Planning'de Planner'a geri bildirim,
 * Developing'de yeni düzeltme safhasının gerekçesi. Developing için boş
 * yorum reddedilir — safhaları bitmiş bir planda Developer'a ne yapacağını
 * söyleyen tek şey odur.
 */
/**
 * İşe zorlanan model seviyesi. Alan HİÇ yoksa mevcut seçim korunur; `null`
 * kaldırır (profil/triage zinciri geri gelir). Seviye soyut — model adı
 * profilin merdiveninden çözülür.
 */
const ModelTierField = ModelTierSchema.nullable().optional();

/**
 * Red/yeniden açma yorumuna eklenen görseller — önce `/api/uploads` ile
 * yüklenir, kimlikleri burada gelir. Motor işin `resources/` dizinine kopyalar
 * ve yollarını yoruma yazar. İsteğe bağlı: onay çağrılarının çoğu görselsiz.
 */
export const FeedbackAttachmentsField = z.array(z.string().min(1)).max(10).optional();

export const ReopenJobBodySchema = z.object({
  target: ReopenTargetSchema,
  comment: z.string().max(20_000).default(""),
  modelTier: ModelTierField,
  attachmentIds: FeedbackAttachmentsField,
});
export type ReopenJobBody = z.infer<typeof ReopenJobBodySchema>;

export const RetryJobBodySchema = z.object({
  modelTier: ModelTierField,
});
export type RetryJobBody = z.infer<typeof RetryJobBodySchema>;

/** Deneme başlatmadan yalnız seviyeyi değiştir (ör. "bir tur daha" kapısından önce). */
export const JobModelTierBodySchema = z.object({
  tier: ModelTierSchema.nullable(),
});
export type JobModelTierBody = z.infer<typeof JobModelTierBodySchema>;

/** İşin otopilotunu aç/kapat — yalnız geliştirme adımını etkiler. */
export const JobAutopilotBodySchema = z.object({
  enabled: z.boolean(),
});
export type JobAutopilotBody = z.infer<typeof JobAutopilotBodySchema>;

/** POSIX ortam değişkeni adı; compose `environment` anahtarı olarak da güvenli. */
const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "geçersiz değişken adı (harf/rakam/_; rakamla başlamaz)").max(128);

/**
 * İşe özel canlı ortam değişkenleri — profildeki `appEnv`i ve
 * orkestratörün ürettiklerini (DB bağlantısı vb.) EZER.
 *
 * Profil tüm işlere ortaktır; tek bir işi farklı bir uca/bayrağa bağlamak
 * için profili değiştirmek diğer işleri de etkilerdi. Değer yer tutucu
 * taşıyabilir (`$jobId`); boş dize değişkeni boşaltır. Tamamı yazılır —
 * listeden çıkan anahtar silinir.
 */
export const JobLiveEnvBodySchema = z.object({
  // Satır sonu YOK: düzenleyici `KEY=değer` satırları; çok satırlı bir değer
  // geri yüklenince bölünüp sahte bir değişken üretirdi.
  //
  // `__proto__` geçerli bir POSIX adı ama Zod `record` onu ad doğrulamasına
  // hiç sokmadan SESSİZCE düşürüyor (ölçüldü, zod 4.6) — kaydedildi sanılan
  // değişken kaybolurdu. Ham girdide aranır ve açıkça reddedilir.
  env: z.unknown()
    .refine((e) => !(e !== null && typeof e === "object" && Object.hasOwn(e, "__proto__")), "'__proto__' değişken adı olarak kullanılamaz")
    .pipe(
      z.record(EnvNameSchema, z.string().max(8000).refine((v) => !/[\r\n]/.test(v), "değer satır sonu içeremez"))
        .refine((e) => Object.keys(e).length <= 100, "en çok 100 değişken"),
    ),
});
export type JobLiveEnvBody = z.infer<typeof JobLiveEnvBodySchema>;

export const ListJobsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  state: JobStateSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

// ── Hata zarfı ───────────────────────────────────────────────────────────────

/** Tüm 4xx/5xx yanıtları bu biçimdedir; UI tek bir yerden ayrıştırır. */
export const ApiErrorSchema = z.object({
  error: z.string(),
  /** Doğrulama hatalarında alan bazlı ayrıntı. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ── Onay ve sohbet ───────────────────────────────────────────────────────────

export const ApprovalDecisionBodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(4000).default(""),
  /** Plan/QA case onayında insanın düzenlediği belge; şema motorda doğrulanır. */
  edits: z.unknown().optional(),
  attachmentIds: FeedbackAttachmentsField,
});
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBodySchema>;

/**
 * `pr_merge` kapısında RED + bu düzenleme: merge edilmez, insanın seçtiği
 * eşik-altı yorumlar tek bir düzeltme turunda çözülür, sonra kapı yeniden açılır.
 *
 * Eşik profilde sabit, ama "hangi minor önemli" sorusunun cevabı işten işe
 * değişiyor (test dosyasındaki yorum bütçesi önemsiz, koddaki minor önemli).
 * Seçim insanda olduğu için tur sınırlı: botun yeni minor'ları eşiğin altında
 * kalır, kendiliğinden yeni tur açmaz.
 */
export const MergeFixEditsSchema = z.object({
  fixThreads: z.array(z.string().min(1)).min(1).max(50),
});
export type MergeFixEdits = z.infer<typeof MergeFixEditsSchema>;

/**
 * Plan kapısındaki açık soruların cevapları.
 *
 * Ayrı bir uç, çünkü bu bir RED değil: plan kötü olduğu için değil, eksik
 * olduğu için geri gidiyor. Cevaplar Planner'a tek turda gider ve yeni bir
 * plan sürümü üretir — insanın cevapları sohbete tek tek yazmasındansa.
 */
export const AnswerQuestionsBodySchema = z.object({
  answers: z.array(z.object({
    question: z.string().min(1),
    answer: z.string().min(1).max(4000),
  })).min(1),
  /** Cevaplarla birlikte iletilecek serbest not. */
  comment: z.string().max(4000).default(""),
});
export type AnswerQuestionsBody = z.infer<typeof AnswerQuestionsBodySchema>;

/**
 * Safha başına model seviyesinin İNSAN tarafından değiştirilmesi.
 *
 * SEVİYE yazılır, model adı değil — merdivendeki karşılığı karar anında
 * `rungFor` ile yeniden çözülür (kural 8). İnsanın "opus" yazıp profilin
 * merdiveninde olmayan bir modeli işe sokması da böyle engellenir.
 *
 * `null` seviyeyi GERİ ALIR: safha motorun türettiği ölçüme döner. Bir kez
 * elle dokununca geri dönüşü olmaması, yanlış tıklamayı kalıcı kılardı.
 *
 * Ölçüldü (2026-09-20, Northwind #145): triage "Arayüz metinleri
 * (ResourceMigration)" safhasını `deep`e koydu; iş yalnız kaynak dosyası
 * taşımaktı ve `standard` yeterdi. Motorun ölçümü muhafazakâr olmak zorunda
 * (yanlış ucuz, yanlış pahalıdan beter) — ama planı okuyan insan safhanın ne
 * olduğunu motordan iyi bilir. Eksik olan onun bunu söyleyebilmesiydi.
 */
export const PhaseTierOverrideBodySchema = z.object({
  overrides: z.array(z.object({
    order: z.number().int().nonnegative(),
    /** `null` → elle seçim kaldırılır, motorun ölçümü geri gelir. */
    tier: ModelTierSchema.nullable(),
  })).min(1),
  comment: z.string().max(4000).default(""),
});
export type PhaseTierOverrideBody = z.infer<typeof PhaseTierOverrideBodySchema>;

export const ChatBodySchema = z.object({
  text: z.string().min(1).max(32_000),
  interrupt: z.boolean().default(false),
});
export type ChatBody = z.infer<typeof ChatBodySchema>;

export const LiveExtendBodySchema = z.object({
  minutes: z.number().int().positive().max(480),
});
export type LiveExtendBody = z.infer<typeof LiveExtendBodySchema>;

/** Canlı test senaryosu iste; `note` insanın odak isteği ("yetki kontrollerine ağırlık ver"). */
export const GenerateTestScenariosBodySchema = z.object({
  note: z.string().max(4000).default(""),
});
export type GenerateTestScenariosBody = z.infer<typeof GenerateTestScenariosBodySchema>;

/** İkinci gözü elle yeniden koştur (§42): plan sürümü ya da senaryo satırı. */
export const RequestCritiqueBodySchema = z.object({
  subject: CritiqueSubjectSchema,
  subjectId: z.string().min(1),
});
export type RequestCritiqueBody = z.infer<typeof RequestCritiqueBodySchema>;

/**
 * Tek senaryonun işareti. `state: null` işareti kaldırır. İnsan yalnız
 * geçti/kaldı/kararsız koyar; `retest` motorun yazdığı durumdur.
 */
export const SetScenarioMarkBodySchema = z.object({
  state: z.enum(["pass", "fail", "unsure"]).nullable(),
  note: z.string().max(4000).default(""),
});
export type SetScenarioMarkBody = z.infer<typeof SetScenarioMarkBodySchema>;

export const AnswerBodySchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().max(32_000),
});
export type AnswerBody = z.infer<typeof AnswerBodySchema>;
