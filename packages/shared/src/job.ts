import { z } from "zod";

/**
 * İş durum makinesi.
 *
 * Geçişler TEK YERDE tanımlıdır (ALLOWED_TRANSITIONS) ve motor bunun dışına
 * çıkamaz. Durum DB'ye yazılmadan hiçbir WS olayı yayınlanmaz — aksi hâlde
 * istemci var olmayan bir duruma göre çizer.
 */

export const JOB_STATES = [
  "Draft",
  "Planning",
  "PlanReview",
  "Developing",
  "Building",
  "LiveTest",
  "QACases",
  "QA",
  "PRReview",
  "CIWatch",
  "Done",
  "NeedsAttention",
  "Cancelled",
] as const;

export const JobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobStateSchema>;

/**
 * Kapanmış (`Done`) ya da takılmış (`NeedsAttention`) bir işin İNSAN eliyle
 * yeniden açılabileceği adımlar — pipeline sırasıyla.
 *
 * `Building` yok: kendi başına bir adım değil, Developing'in son safhasının
 * ardından kendiliğinden gelir. `CIWatch` yok: PR'sız işte izlenecek bir şey
 * yok, PR'lı işte `retry` zaten oraya döner.
 */
export const REOPEN_TARGETS = ["Planning", "Developing", "LiveTest", "QACases", "QA", "PRReview"] as const;
export const ReopenTargetSchema = z.enum(REOPEN_TARGETS);
export type ReopenTarget = z.infer<typeof ReopenTargetSchema>;

/**
 * İzin verilen geçişler. Geri adımlar (Developing'e dönüş) bilinçli olarak
 * geniştir: build kırmızı, canlı testte kusur, QA kırmızı ve PR reddi — dördü de
 * aynı yere döner.
 *
 * NeedsAttention ve Cancelled her durumdan erişilebilir, ayrıca ele alınır.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  Draft: ["Planning", "Cancelled"],
  Planning: ["PlanReview", "Draft"],
  PlanReview: ["Developing", "Planning"],
  Developing: ["Building"],
  Building: ["LiveTest", "Developing", "QACases"],
  LiveTest: ["QACases", "Developing"],
  QACases: ["QA", "Developing"],
  QA: ["PRReview", "Developing"],
  PRReview: ["CIWatch", "Developing", "Done"],
  CIWatch: ["Done"],
  /**
   * `Done`dan iki tür çıkış var, ikisi de İNSAN kararıyla.
   *
   * CIWatch — YAŞANDI (2026-09-17, PR #135): PR açıldıktan saniyeler sonra
   * check listesi boş döndü, iş "CI check'i yok" diyerek Done oldu; Actions
   * ise workflow'u o sırada kuyruğa almıştı. İş kapanmış ama CI izlenmemişti.
   *
   * Yeniden açma (`REOPEN_TARGETS`) — YAŞANDI (2026-09-24): remote GitHub
   * olmadığı için PR açılmadan Done olan işte workspace, dal ve onaylı plan
   * yerindeydi; profil düzeltildikten sonra PR adımına dönmenin yolu yoktu,
   * tek seçenek klonlayıp Developer'ı sıfırdan koşturmaktı.
   *
   * Cancelled'a ve Draft'a gidilmez: iptal silmedir, Draft ise onaylı planı
   * olan bir işte anlamsız.
   */
  Done: ["CIWatch", ...REOPEN_TARGETS],
  NeedsAttention: [...JOB_STATES],
  Cancelled: [],
} as const;

/** Her durumdan gidilebilen kaçış durumları. */
const ESCAPE_STATES: readonly JobState[] = ["NeedsAttention", "Cancelled"];

export function canTransition(from: JobState, to: JobState): boolean {
  if (from === to) return false;
  if (ESCAPE_STATES.includes(to)) return from !== "Done" && from !== "Cancelled";
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Durum içi alt-faz. Kesinti dayanıklılığının anahtarı: her durum girişinde
 * ÖNCE niyet yazılır (`starting`), sonra iş yapılır. Açılışta `starting`
 * görülürse o iş yarıda kalmıştır.
 */
export const JOB_PHASES = ["starting", "running", "waiting", "paused", "done"] as const;
export const JobPhaseSchema = z.enum(JOB_PHASES);
export type JobPhase = z.infer<typeof JobPhaseSchema>;

/**
 * Agent rolleri.
 *
 * `triage` ayrı bir rol, çünkü para harcıyor: `agent_runs.role` ve
 * `cost_records.role` ayrımı olmadan model yönlendirmesinin kazancı
 * ölçülemez. Kendi durumu YOK — Planning içinde bir alt-adım olarak koşar.
 *
 * `tester` da durumsuz: insan istediğinde canlı test senaryosu yazar. `qa`dan
 * ayrı, çünkü oturum rol başına tutuluyor — `qa` rolüyle koşsaydı QA'nın
 * sonraki case turu bu oturumu (plan anındaki eski bağlamı) devam ettirirdi.
 */
/**
 * `mentor`: takılan agent'ın danıştığı üst basamak (karar §33). Host'ta,
 * araçsız koşar; köprüye hiç gitmez.
 */
export const AGENT_ROLES = ["analyst", "triage", "planner", "developer", "qa", "devops", "tester", "mentor", "cartographer", "critic"] as const;
export const AgentRoleNameSchema = z.enum(AGENT_ROLES);
export type AgentRoleName = z.infer<typeof AgentRoleNameSchema>;

/** Onay kapısı türleri. Hangilerinin açık olduğunu profil belirler. */
export const APPROVAL_KINDS = [
  "profile",
  "plan",
  "phase",
  "live_test",
  "qa_cases",
  "pr_open",
  /** CI yeşil; insan merge + temizlik onayı veriyor (profil açtıysa). */
  "pr_merge",
  /**
   * Agent yetkisi dışında bir engel bildirdi; insan ne yapılacağına karar
   * veriyor. Onay → engeli çözecek role geri gönder; red → engeli yok say ve
   * akışı olduğu gibi sürdür.
   */
  "blocked",
  /**
   * PRReview'da inceleme turları tavana ulaştı ve eşiği aşan yorum hâlâ açık.
   * Onay → bir tur daha (yorum Developer'a not olarak gider); red → açık
   * yorumlarla CIWatch'a geç.
   */
  "review_round",
  /**
   * PR'dan önce güvenlik (SAST) turları bitti ve eşik üstü bulgu kaldı ya da
   * bir güvenlik aracı koşamadı (`workflow.review.static.securityGate`).
   * Onay → bir güvenlik turu daha (yorum Developer'a not); red → kalan
   * bulgularla devam (okunabilirlik, OCR, PR).
   */
  "security",
] as const;
export const ApprovalKindSchema = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  /**
   * Açık sorular cevaplandı, kapı kapandı — ama plan REDDEDİLMEDİ.
   * İkisini ayırmak gerekiyor: insan planı beğenmediği için değil, eksik
   * olduğu için geri gönderdi.
   */
  "answered",
  "expired",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// ── Ölçüm sinyalleri (triage ve plan safhaları ortak kullanır) ───────────────

/**
 * Triage'ın ölçtüğü tek sinyal.
 *
 * `level` zorunlu değil ve varsayılanı `unknown`: modelin "emin değilim"
 * diyebilmesi, uydurmasından iyidir. Motor `unknown`u belirsizlik sayar ve
 * seviyeyi yukarı yuvarlar — ucuz modelin bilmediğini söylemesi cezalandırılmaz.
 */
export const TriageSignalSchema = z.object({
  // `.catch`: tanımsız değer `unknown`a düşer, ölçümün tamamını düşürmez —
  // bkz. `TriageMeasurementSchema.risk.changeKind`.
  level: z.enum(["none", "low", "medium", "high", "unknown"]).catch("unknown").default("unknown"),
  note: z.string().default(""),
});
export type TriageSignal = z.infer<typeof TriageSignalSchema>;

/**
 * ÖLÇÜM alanları — karar alanlarından ayrı.
 *
 * Ayrı şema olmasının sebebi yeniden kullanım: aynı ölçümü hem triage turu
 * (iş geneli) hem Planner (safha başına) üretiyor ve `deriveTier` ikisini de
 * aynı eşiklerle değerlendiriyor. Eşiklerin iki yerde ayrı tanımlanması
 * kaçınılmaz olarak ayrışırdı.
 */
export const TriageMeasurementSchema = z.object({
  scope: z.object({
    layers: z.array(z.enum(["db", "entity", "api", "ui", "auth", "infra", "unknown"]).catch("unknown")).default([]),
    /** Migration, yeni kolon, FK, cascade — geri dönüşü pahalı olan. */
    schemaChange: TriageSignalSchema.prefault({}),
    multiTenantImpact: TriageSignalSchema.prefault({}),
    /** Postplan'da plandan SAYILIR; intake'te tahmindir. */
    estimatedFiles: z.number().int().nonnegative().default(0),
  }).prefault({}),

  ambiguity: z.object({
    /** "olsa güzel olur", "gibi bir şey", "bazen" — birebir alıntı. */
    vaguePhrases: z.array(z.string()).default([]),
    /** "sil" → hard delete mi soft delete mi gibi terim belirsizlikleri. */
    unclearTerms: z.array(z.string()).default([]),
    /** Kullanıcı söylemediği için varsayılmak zorunda kalınanlar. */
    assumedDefaults: z.array(z.string()).default([]),
    overall: TriageSignalSchema.prefault({}),
  }).prefault({}),

  risk: z.object({
    /** Veri silme, geri alınamaz migration. */
    irreversible: TriageSignalSchema.prefault({}),
    /** Race condition, state mutation — "ince hata" kategorisi. */
    concurrency: TriageSignalSchema.prefault({}),
    /**
     * `.catch`: Planner bu alana enum dışı değer yazdı (safha başına ölçümde
     * ilk denemede iki safhada birden) ve isteğe bağlı bir ölçüm alanı TÜM
     * PLAN_JSON'u düşürdü. `unknown` motorda belirsizlik sayılıp yukarı
     * yuvarlandığından tanımsızı ona düşürmek güvenli taraftır.
     */
    changeKind: z.enum(["additive", "breaking", "mixed", "unknown"]).catch("unknown").default("unknown"),
  }).prefault({}),

  history: z.object({
    /** `git log --oneline -- <path> | wc -l` ile ölçülür; tahmin değil. */
    touchedFiles: z.array(z.object({
      path: z.string().min(1),
      commits: z.number().int().nonnegative().default(0),
    })).default([]),
    churnNote: z.string().default(""),
    /** Sistemde emsal bir uygulama var mı — varsa iş kolaylaşır. */
    similarPrecedent: z.string().default(""),
  }).prefault({}),
});
export type TriageMeasurement = z.infer<typeof TriageMeasurementSchema>;

/**
 * Planner'ın safha başına ölçümü — `TriageMeasurement`in alt kümesi.
 *
 * `history` YOK: git log ölçümü Planner'ın işi değil (safha bazında churn
 * sayısı plan yazılırken anlamlı bir birime oturmuyor — safha henüz yazılmamış
 * dosyalar içerebilir). `deriveTier` eksik `history`yi boş sayar ve emsal
 * indirimini uygulamaz; safha ölçümü bu yüzden hafif yukarı eğilimlidir.
 *
 * Tüm alanlar varsayılanlı: Planner bloğu eksik yazarsa ölçüm çöpe atılmaz.
 */
export const PhaseTriageSchema = TriageMeasurementSchema.omit({ history: true });
export type PhaseTriage = z.infer<typeof PhaseTriageSchema>;

// ── Plan belgesi (Planner çıktısı) ───────────────────────────────────────────

/**
 * Gereksinim kimliği listesi. Üretici taraf güvenilmez: "R1, R2" gibi tek
 * dize de gelebilir — virgül/boşlukla bölünür.
 */
const idList = (v: unknown): unknown => (typeof v === "string" ? v.split(/[\s,;]+/).filter(Boolean) : v);

/**
 * İş tanımından çıkarılmış tek gereksinim (karar §42).
 *
 * İş tanımı çoğu zaman dağınık giriliyor: istekler paragraf içinde kayboluyor,
 * bir kısmı örtük. Planner bunları numaralı, doğrulanabilir cümlelere çevirir;
 * insan plan onayında metnin NASIL anlaşıldığını görür. Ham metin
 * (`jobs.description`) değişmez — `source` ona geri bağlar.
 */
export const RequirementSchema = z.object({
  /** "R1", "R2"… — safha ve senaryoların `covers`ı buna bağlanır. */
  id: z.string().min(1),
  /** Düzenlenmiş, doğrulanabilir tek cümle. */
  text: z.string().min(1),
  /** Ham metinden birebir alıntı; örtük gereksinimde boş. */
  source: z.string().default(""),
});
export type Requirement = z.infer<typeof RequirementSchema>;

/**
 * Yinelenen gereksinim kimliği yeniden adlandırılır (`R1`, `R1#2`), plan
 * REDDEDİLMEZ: red Planner'ı yeniden koşturur, ikinci denemede de olursa iş
 * `no_plan` ile düşer — bir numaralandırma kusuru için fazla pahalı. Kapsam
 * `id` ile eşleştiğinden, yinelenen bırakılsaydı `covers: ["R1"]` ikisini de
 * karşılanmış gösterir ve atlanan gereksinimi gizlerdi; yeni ad hiçbir
 * safhaya bağlı olmadığı için "karşılanmamış" görünür ve insan fark eder.
 */
function uniqueRequirementIds(rs: Requirement[]): Requirement[] {
  const seen = new Map<string, number>();
  return rs.map((r) => {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    return n === 1 ? r : { ...r, id: `${r.id}#${n}` };
  });
}

/**
 * Plan safhası. "Safha 3-4 dosyayı geçmez" bir TAVANDIR, ölçüt "birlikte
 * incelenebilir mi". Bölünemeyen iş tavanı aşabilir — gerekçesi `rationale`a yazılır.
 */
export const PlanPhaseSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  rationale: z.string().default(""),
  /** Dokunulacak dosyalar — tavan kontrolü buradan yapılır. */
  files: z.array(z.string()).default([]),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  /** Tavanı aşıyorsa gerekçe zorunlu. */
  exceedsFileCap: z.boolean().default(false),
  /**
   * Safhanın bittiğini söyleyen gözlemlenebilir koşullar.
   *
   * İnsan safhayı onaylarken "ne olunca tamam" sorusunun cevabını plandan
   * okuyabilmeli; gerekçe paragrafı bunu söylemiyordu. Developer da aynı
   * listeyi görür. Eski planlarda yok — boş liste.
   */
  acceptance: z.array(z.string()).default([]),
  /** Bu safhanın karşıladığı gereksinimlerin `id`leri (`PlanDocument.requirements`). */
  covers: z.preprocess(idList, z.array(z.string())).default([]),
  /**
   * Planner'ın bu safha için ÖLÇÜMÜ — tier DEĞİL.
   *
   * Motor `resolvePhaseTier` ile tier'a çevirir. Planner'ın doğrudan tier
   * yazması bütçe politikasını LLM sezgisine devretmek olurdu; aynı gerekçe
   * `TriageDocumentSchema.recommendedTier` için de geçerli (orada model
   * öneriyor ama motor türetmesiyle karşılaştırılıp pahalı olan seçiliyor).
   *
   * Opsiyonel: Planner bloğu yazmazsa motor `risk` ve `files.length`ten
   * sentezler — üretici taraf güvenilmez (kural 3).
   */
  triage: PhaseTriageSchema.optional(),
});
export type PlanPhase = z.infer<typeof PlanPhaseSchema>;

export const PlanDocumentSchema = z.object({
  summary: z.string().min(1),
  /** İş tanımından çıkarılan gereksinimler (§42). Eski planlarda yok — boş liste. */
  requirements: z.array(RequirementSchema).transform(uniqueRequirementIds).default([]),
  /** Hangi repolara dokunulacak. Auto kipte Planner seçer, insan düzeltebilir. */
  targetRepos: z.array(z.string()).default([]),
  repoSelectionReason: z.string().default(""),
  phases: z.array(PlanPhaseSchema).min(1),
  /**
   * Planı onaylamadan ÖNCE cevaplanması gereken kararlar.
   *
   * Düz metin listesiydi; ölçüldü (2026-09-14, Collection işi): Planner 12 soru
   * üretti, çoğu şıklıydı ("A/B/C? Hangisi?") ve bazıları planın şeklini
   * değiştiriyordu ("19 safha, beş faza bölünsün mü?"). Tek satırlık madde
   * olarak okunamıyor, cevaplanamıyordu — insan cevabı sohbete yazmak zorunda
   * kalıyor, hangi soruya ait olduğu kayboluyordu.
   *
   * Üretici taraf güvenilmez: Planner yalın dize de yazabilir, `preprocess`
   * onu `{ question }` nesnesine çevirir — eski planlar da böyle okunur.
   */
  openQuestions: z.array(
    z.preprocess(
      (v) => (typeof v === "string" ? { question: v } : v),
      z.object({
        id: z.string().default(""),
        /**
         * SORUNUN KENDİSİ — tek cümle, gerekçesiz.
         *
         * Ölçüldü: Planner gerekçeyi, ölçümü ve üç şıkkın açıklamasını tek
         * paragrafa sıkıştırınca soru okunamaz hâle geldi ("Üç seçenek: (A)…
         * (B)… (C)… Onayın hangisi?" — 900 karakter). Gerekçe `context`e,
         * şıklar `options`a ayrılır.
         */
        question: z.string().min(1),
        /** Kararın arka planı: ölçüm, risk, emsal. UI'da katlanır. */
        context: z.string().default(""),
        /** Şıklar. Boşsa serbest cevap. Her şık KISA bir etiket olmalı. */
        options: z.array(z.string()).default([]),
        /** Planner'ın önerisi — `options` içinden biri olmalı. */
        recommended: z.string().default(""),
        /** Cevaplanmazsa planın neyi varsaydığı. */
        assumption: z.string().default(""),
        /**
         * Cevap planın şeklini değiştirir mi (safha ekler/böler)? Doğruysa
         * cevapsız onay, sonradan çöpe gidecek bir planı onaylamak demektir.
         */
        blocksPlan: z.boolean().default(false),
      }),
    ),
  ).default([]),
  testStrategy: z.string().default(""),
  outOfScope: z.array(z.string()).default([]),
  estimatedComplexity: z.enum(["small", "medium", "large"]).default("medium"),
});
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

// ── Triage (model yönlendirmesi) ─────────────────────────────────────────────

/**
 * Model seviyesi — SOYUT basamak, model adı değil.
 *
 * Burada tanımlı çünkü triage belgesinin parçası; hangi basamağın hangi modele
 * düştüğünü profil söyler (`agents.triage.ladder`). Motor yetenek sunar,
 * profil hangisinin geçerli olduğunu söyler.
 */
/**
 * Adım kontrol listesi (karar §34): bir kez geçen adım, kodu değişmedikçe
 * yeniden koşmaz. Anahtar `<durum>.<adım>`. Bugün PR zinciri:
 * güvenlik → (kapı) → kod kalitesi → yerel inceleme → PR → bot incelemesi.
 * `qa.write`: QA testleri yazdı ve takımlar yeşil; `sha` HEAD değil, çalışma
 * ağacının tamamının (commit'lenmemiş testler dahil) git tree'si.
 * Başka bir adım aynı kusuru taşıyorsa buraya anahtar eklenir.
 */
export const STEP_CHECKS = ["pr.security", "pr.quality", "pr.local_review", "pr.bot_review", "qa.write"] as const;
export const StepCheckSchema = z.enum(STEP_CHECKS);
export type StepCheck = z.infer<typeof StepCheckSchema>;

/**
 * Tamamlanmış bir adımın kaydı. `done`: adım işini bitirdi (temiz, düzeltildi
 * ya da tavan doldu — kalan bulgular kapıda/botta). `waived`: insan kapıda
 * kalanları kabul etti. Adım KOŞAMADIYSA (anahtar yok, araç düştü) kayıt
 * yazılmaz: yeniden denemede yeniden denenmeli.
 */
export const StepCheckEntrySchema = z.object({
  status: z.enum(["done", "waived"]),
  at: z.string(),
  /**
   * Adım bittiğinde HEAD. İş PR öncesi bir duruma dönünce kayıt `stale` olur;
   * PR zinciri başında HEAD bu değere eşitse kayıt geri gelir (karar §34).
   */
  sha: z.string().default(""),
  note: z.string().default(""),
  /** Kod değişmiş olabilir — zincir başında HEAD ile doğrulanmadan atlanmaz. */
  stale: z.boolean().optional(),
});
export type StepCheckEntry = z.infer<typeof StepCheckEntrySchema>;
export type StepChecklist = Partial<Record<StepCheck, StepCheckEntry>>;

export const ModelTierSchema = z.enum(["cheap", "standard", "deep", "frontier"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** Seviyeler ucuzdan pahalıya — karşılaştırma ve yukarı yuvarlama bu sırayı kullanır. */
export const MODEL_TIER_ORDER: readonly ModelTier[] = ["cheap", "standard", "deep", "frontier"];

/**
 * Triage belgesi — işin ZORLUĞUNU ölçen ucuz turun çıktısı.
 *
 * İki yerde üretilir: iş girilince (`intake`, girdi metnine bakar) ve plan
 * üretilince (`postplan`, plan belgesine bakar). İlki planlama modelini,
 * ikincisi geliştirme modelini seçer.
 *
 * Şemanın neredeyse tamamı ÖLÇÜM, yargı değil: kaç katman, kaç dosya, git'te
 * kaç commit, metinde belirsiz ifade var mı. Tier'a çevirme işi motorda
 * (`deriveTier`) ve deterministiktir — ucuz modelin yargısına bırakılmaz.
 *
 * Ölçüm alanları `TriageMeasurementSchema`dan gelir: aynı ölçümü Planner da
 * safha başına üretiyor ve `deriveTier` ikisini de aynı eşiklerle okuyor.
 *
 * Üretici taraf güvenilmez: `recommendedTier` ve `rationale` dışında her alan
 * varsayılanlı. Blok hiç gelmezse motor `fallbackTier`a düşer ve iş sürer —
 * triage bir DANIŞMANDIR, çökmesi işi öldürmemeli.
 */
export const TriageDocumentSchema = TriageMeasurementSchema.extend({
  stage: z.enum(["intake", "postplan"]),

  /** Kabul kriteri yoksa triage ÜRETİR: "şu davranış doğrulanmalı". */
  acceptanceCriteria: z.array(z.string()).default([]),
  /** Triage'ın kendi soruları — plan kapısında insana gösterilir. */
  questions: z.array(z.string()).default([]),

  /**
   * SOYUT SEVİYE — model adı DEĞİL.
   *
   * Hangi seviyenin hangi modele düştüğünü profil söyler
   * (`agents.triage.ladder`). Model adı bir proje tercihidir, motora gömülmez;
   * ayrıca `z.enum` dört değeri kapatır — serbest dizede model uydurulursa
   * geçersiz model runner'a gider ve koşu API hatasıyla düşerdi.
   */
  recommendedTier: ModelTierSchema,
  rationale: z.string().min(1),
  /** Düşükse motor seviyeyi bir basamak YUKARI yuvarlar. */
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});
export type TriageDocument = z.infer<typeof TriageDocumentSchema>;

/**
 * Motorun seçtiği model — triage sonucunun uygulanmış hâli.
 *
 * `tier` triage'dan, `model`/`effort` profilin merdiveninden gelir. Kapı
 * yüküne bu girer; karar anında model ladder'dan YENİDEN çözülür, buradaki
 * dizeye güvenilmez (kural 8: onay kapıları kodla korunur).
 */
export const ModelChoiceSchema = z.object({
  tier: ModelTierSchema,
  model: z.string(),
  effort: z.string(),
  rationale: z.string(),
  /** `approvalRequiredFrom` eşiğini aştı — insan onayı şart. */
  requiresApproval: z.boolean().default(false),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

/**
 * Plan kapısının yükü.
 *
 * `modelChoice` postplan triage koştuysa vardır. Fable gibi pahalı bir seviye
 * önerildiğinde insan planı okurken AYNI ekranda görür — ayrı bir kapı açmak
 * aynı karar anı için ikinci bir tıklama bindirirdi.
 */
export const PlanGatePayloadSchema = z.object({
  planId: z.string(),
  plan: PlanDocumentSchema,
  modelChoice: ModelChoiceSchema.optional(),
  /**
   * Safha başına seçim — `stages.perPhase` açıkken dolu.
   *
   * İnsan planı okurken hangi safhanın hangi modele gideceğini AYNI ekranda
   * görür. Ayrı bir kapı açmak, aynı karar anı için safha sayısı kadar tıklama
   * bindirirdi (`modelChoice` için verilen kararın aynısı).
   *
   * `model`/`effort` yalnız GÖSTERİM içindir; karar anında merdivenden yeniden
   * çözülür (kural 8) — profil o arada değişmiş olabilir.
   */
  phaseModels: z.array(z.object({
    order: z.number().int().nonnegative(),
    title: z.string(),
    tier: ModelTierSchema,
    model: z.string(),
    effort: z.string(),
    requiresApproval: z.boolean().default(false),
    /**
     * Seviyeyi kim koydu: motorun ölçümü mü, insanın müdahalesi mi.
     *
     * Gösterim için değil yalnız süs olarak: insan bir safhayı elle
     * düşürdüyse, plan düzenlemesi sonrası yeniden ölçüm onu SESSİZCE geri
     * almamalı. UI da "bunu ben değiştirmiştim" diyebilmeli — aksi hâlde
     * ikinci turda aynı safhayı tekrar düşürmeye kalkar.
     */
    source: z.enum(["engine", "human"]).default("engine"),
    /** Motorun ölçtüğü seviye — insan değiştirdiyse geri alma bunu gösterir. */
    derivedTier: ModelTierSchema.optional(),
  })).default([]),
});
export type PlanGatePayload = z.infer<typeof PlanGatePayloadSchema>;

/**
 * Developer'ın modelini kim belirledi — `runDeveloping`teki öncelik zinciri.
 *
 * `forced` iş geneli zorlama (§22) her şeyi önceler; safha seçimi o varken
 * yok sayılır ve insan bunu ekranda görmeli, yoksa safhayı düşürdüğünü sanıp
 * Fable'la koşmaya devam eder.
 */
export const DeveloperModelSourceSchema = z.enum(["forced", "phase", "postplan", "role"]);
export type DeveloperModelSource = z.infer<typeof DeveloperModelSourceSchema>;

/**
 * Safha kapısında SIRADAKİ safhanın önizlemesi.
 *
 * Kapı yüküne GÖMÜLMEZ, istekle hesaplanır: insan kapı açıkken modeli
 * değiştirebiliyor ve yük o anda bayatlardı. `model` koşuda kullanılacak
 * çözümün aynısıdır (aynı fonksiyon) — ekran ile koşu ayrışmasın.
 */
export const NextPhaseViewSchema = z.object({
  order: z.number().int().nonnegative(),
  title: z.string(),
  rationale: z.string(),
  files: z.array(z.string()),
  risk: z.string(),
  exceedsFileCap: z.boolean(),
  acceptance: z.array(z.string()),
  /**
   * Bu ve sonrasında henüz başlamamış safhaların sırası — "kalanların hepsi"
   * seçimi için. 48 safhada tek tek seçmek, kota tükenirken pratik değil.
   */
  pendingOrders: z.array(z.number().int().nonnegative()),
  model: z.object({
    model: z.string(),
    effort: z.string(),
    /** Merdivenden geldiyse seviye; profil rolünden geldiyse yok. */
    tier: ModelTierSchema.nullable(),
    source: DeveloperModelSourceSchema,
  }),
  /** Safhanın KAYITLI seviyesi (ölçüm ya da insan) — seçicinin işaretli düğmesi. */
  phaseTier: ModelTierSchema.nullable(),
  phaseTierSource: z.enum(["engine", "human"]),
});
export type NextPhaseView = z.infer<typeof NextPhaseViewSchema>;

// ── QA case listesi ──────────────────────────────────────────────────────────

export const QaCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().default(""),
  /** agent: QA önerdi · human: insan ekledi. */
  origin: z.enum(["agent", "human"]).default("agent"),
  /** İnsan onayında çıkarılmış olabilir. */
  included: z.boolean().default(true),
});
export type QaCase = z.infer<typeof QaCaseSchema>;

/** QA'nın ürettiği blok ve insanın düzenlediği liste — aynı şema. */
export const QaCasesDocumentSchema = z.object({
  cases: z.array(QaCaseSchema).min(1),
});
export type QaCasesDocument = z.infer<typeof QaCasesDocumentSchema>;

// ── Canlı test senaryoları ───────────────────────────────────────────────────

/**
 * İnsanın canlı ortamda ELLE koşacağı senaryo — adım + beklenen sonuç.
 *
 * QA case'inden AYRI: QA case'i otomatik teste dönüşür ve canlı testten SONRA
 * gelir. Oysa insan porttan test ederken "neyi denemeliyim" sorusunun cevabına
 * o anda ihtiyaç duyuyor; canlı test sonrası yazılan unit testler bunu
 * karşılamıyor (insan talebi, 2026-09-26).
 *
 * Üretici taraf güvenilmez: tek dize gelen `steps`/`preconditions` diziye,
 * dizi gelen `expected` satırlara çevrilir; bilinmeyen öncelik `medium` olur.
 */
const lines = (v: unknown): unknown => (typeof v === "string" ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : v);

export const TestScenarioSchema = z.object({
  id: z.string().default(""),
  title: z.string().min(1),
  /** Ekran/modül — insan senaryoları uygulamada nereye gideceğine göre gruplar. */
  area: z.string().default(""),
  priority: z.enum(["high", "medium", "low"]).catch("medium").default("medium"),
  preconditions: z.preprocess(lines, z.array(z.string())).default([]),
  steps: z.preprocess(lines, z.array(z.string()).min(1)),
  expected: z.preprocess((v) => (Array.isArray(v) ? v.join("\n") : v), z.string().min(1)),
  /** Senaryonun doğruladığı gereksinimlerin `id`leri (§42). */
  covers: z.preprocess(idList, z.array(z.string())).default([]),
  /**
   * Senaryoyu koşacak test hesabının rolü (`live.browserTest.accounts[].role`).
   * Boş: giriş gerekmiyor ya da profilde hesap yok.
   */
  account: z.string().trim().catch("").default(""),
});
export type TestScenario = z.infer<typeof TestScenarioSchema>;

/** Agent'ın `TEST_SCENARIOS_JSON` bloğu. */
export const TestScenariosDocumentSchema = z.object({
  scenarios: z.array(TestScenarioSchema).min(1),
  /** Kapsam dışı bırakılanlar, test verisi ipucu gibi serbest not. */
  notes: z.string().default(""),
});
export type TestScenariosDocument = z.infer<typeof TestScenariosDocumentSchema>;

/**
 * İşaret anahtarı SIRA (`s0`, `s1`…): agent `id`yi boş bırakabilir ya da
 * tekrarlayabilir. Belge satır başına değişmez (yeniden üretim yeni satırdır),
 * sıra sabit kalır. UI ve motor aynı anahtarı buradan alır.
 */
export const scenarioKey = (index: number): string => `s${index}`;

/**
 * Senaryo başına canlı test işareti — sunucuda tutulur, çünkü red anında
 * "kaldı"lar Developer'a gider ve sonraki turda liste yeniden üretilmeden
 * sürer.
 *
 * `unsure`: nadir ama gerçek — sonuç tutarsız ya da senaryonun kendisi yanlış
 * (yanlış alarm). Developer'a GİTMEZ, turlar arasında sıfırlanmaz; notu
 * nedenini taşır.
 *
 * `retest`: insanın koymadığı, motorun red anında yazdığı durum. Developer'a
 * giden "kaldı"lar ve aynı alandaki "geçti"ler düzeltmeden etkilenmiş
 * sayılır; bir sonraki turda yeniden denenmeleri gerekir.
 */
export const ScenarioMarkStateSchema = z.enum(["pass", "fail", "unsure", "retest"]);
export type ScenarioMarkState = z.infer<typeof ScenarioMarkStateSchema>;

export const ScenarioMarkSchema = z.object({
  state: ScenarioMarkStateSchema,
  /** İnsanın "ne oldu" notu — kaldıysa Developer'a senaryoyla birlikte gider. */
  note: z.string().default(""),
  /** İşaretin konduğu canlı test turu; satırın `round`undan küçükse eski turdan kalmadır. */
  round: z.number().int().min(1).default(1),
  at: z.string().default(""),
  /**
   * `agent`: tarayıcı turunun ön işareti (karar §41). İnsanın işareti her
   * zaman üstündür; insan agent işaretini benimseyince `human` olur.
   */
  source: z.enum(["human", "agent"]).default("human"),
  /** Kanıt görüntüleri, `<tur>/<dosya>` — `artifacts/<job>/live-<tur>/<dosya>`. */
  evidence: z.array(z.string()).default([]),
});
export type ScenarioMark = z.infer<typeof ScenarioMarkSchema>;

export const ScenarioMarksSchema = z.record(z.string(), ScenarioMarkSchema);
export type ScenarioMarks = z.infer<typeof ScenarioMarksSchema>;

/**
 * DB'deki işaretleri okur (kural 3). Bozuk tek girdi tüm listeyi düşürmesin
 * diye girdi girdi doğrulanır; NULL (sütundan önceki satırlar) boş sayılır.
 */
export function parseScenarioMarks(raw: unknown): ScenarioMarks {
  const out: ScenarioMarks = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw)) {
    const parsed = ScenarioMarkSchema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/**
 * Tarayıcı turunun `SCENARIO_RESULTS_JSON` bloğu (karar §41).
 *
 * `retest` agent'ın yazabileceği bir durum DEĞİL — motorun red anındaki
 * işaretidir. Ön koşulu kurulamayan senaryo `unsure` + gerekçe.
 */
export const ScenarioResultSchema = z.object({
  key: z.string().regex(/^s\d+$/),
  state: z.enum(["pass", "fail", "unsure"]),
  note: z.string().default(""),
  evidence: z.array(z.string()).default([]),
});
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;

export const ScenarioResultsSchema = z.object({
  results: z.array(ScenarioResultSchema).default([]),
  /** Kararlı kimliği olmayan etkileşimli elemanlar: "Siparişler > Yeni › Kaydet düğmesi". */
  missingSelectors: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type ScenarioResults = z.infer<typeof ScenarioResultsSchema>;

/** `live_test` kapısındaki tarayıcı turu özeti. */
export interface BrowserRunSummary {
  round: number;
  /** Koşan senaryo sayısı ve sonuç dağılımı. */
  ran: number;
  pass: number;
  fail: number;
  unsure: number;
  /**
   * Koşup sonucu yazılmayan senaryolar (süre doldu, blok eksik). İşaretsiz
   * kalır — insan dener; "kararsız" uydurulmaz.
   */
  noResult: number;
  missingSelectors: string[];
  durationMs: number;
  /** Koşunun baktığı çalışma ağacı özeti; aynı kodda tur tekrarlanmaz. */
  tree?: string;
  /**
   * İşaretlerin yazıldığı senaryo satırı ve koşunun profili. Kod aynı olsa da
   * liste yeniden üretildiyse ya da iş başka profil sürümüne taşındıysa eski
   * özet yeni duruma ait değildir; ikisi de eşleşmeden taşınmaz.
   */
  scenarioRowId?: string;
  profileId?: string;
  /** Koşmadıysa sebebi (köprü eski, senaryo yok, ağ bağlanamadı…). */
  skipped?: string;
}

/**
 * Hangi adımda üretildi. `plan`: yalnız plana bakılır (kod henüz yok);
 * `live`: plan + gerçekten değişen dosyalar.
 */
export const TestScenarioStageSchema = z.enum(["plan", "live"]);
export type TestScenarioStage = z.infer<typeof TestScenarioStageSchema>;

/**
 * Agent'ın yazdığı PR başlığı (`PR_TEXT_JSON` bloğu).
 *
 * YALNIZ BAŞLIK: gövdeyi CodeRabbit "Summary by CodeRabbit" ile zaten
 * üretiyor, ikinci bir anlatı gürültü. Başlık ise konvansiyonel olmak zorunda
 * — sürüm numarası tipten türüyor (`feat` minor, `fix` patch, `!` major).
 *
 * Tek satır ve kırpılmasın diye sınırlı; 72 karakter HEDEF, 120 tavan
 * (üretici taraf güvenilmez, hedefi aşan başlık yüzünden PR açılmasın).
 */
export const PrTitleSchema = z.object({
  title: z.string().min(1).max(120).refine((s) => !s.includes("\n"), "başlık tek satır olmalı"),
});
export type PrTitle = z.infer<typeof PrTitleSchema>;

// ── Handoff (bağlam devri) ───────────────────────────────────────────────────

/**
 * Oturum devri. Üretici taraf GÜVENİLMEZ: agent yazar → orkestratör eksikse
 * git diff'ten sentezler → tüketirken bu şema ile doğrulanır.
 */
/**
 * Agent'ın YETKİSİ DIŞINDA kalan iş — rolün yapamadığı, başka rolün ya da
 * insanın yapması gereken.
 *
 * YAŞANDI (2026-09-18): QA "onaylı plan dört tabloya Cascade FK şart
 * koşuyordu, üretim kodunda yok; yazdığım test bu yüzden bilerek kırmızı ve
 * düzeltmesi benim yetkimde değil — yalnız test dizinlerine yazabiliyorum"
 * dedi. Doğru ve değerli bir teşhisti; `gotchas`a sıkışıp PR gövdesinde tek
 * satır oldu, motor kırmızı testi görüp Developer'a "testler kırmızı" diye
 * gönderdi. Developer'ın testi düzelterek bulguyu silmesi an meselesiydi.
 *
 * Bu yüzden ayrı ve YAPISAL bir alan: motor `needsRole`a bakıp kapı açabilir.
 */
export const BlockerSchema = z.object({
  /** Eksik olan ne — insanın okuyacağı tek cümle. */
  what: z.string().default(""),
  /** Niçin bu rol yapamıyor (yetki sınırı, eksik bilgi, dış bağımlılık). */
  why: z.string().default(""),
  /** Kim yapmalı. `human`: karar insana ait, hiçbir agent çözemez. */
  needsRole: z.enum([...AGENT_ROLES, "human"]).default("human"),
  /** İlgili dosya/test adları — kapıda ve geri bildirimde gösterilir. */
  refs: z.array(z.string()).default([]),
});
export type Blocker = z.infer<typeof BlockerSchema>;

/**
 * Safhanın bir kabul ölçütü için Developer'ın kanıtı. Eşleme METİNLE değil
 * `index` ile: LLM maddeyi yeniden ifade eder, metin eşlemesi kırılır.
 *
 * `criterion`ı agent değil orkestratör plandan yazar (insan plandakiyle
 * karşılaştırabilsin); karşılığı gelmeyen madde `unknown` + `synthesized`
 * ile eklenir. `.default`lar eski kapı yüklerinin (DB'deki JSON) bozulmadan
 * okunması için (kural 3).
 */
export const AcceptanceEvidenceSchema = z.object({
  /** Safhanın `acceptance` dizisindeki sıra (0'dan). */
  index: z.number().int().min(0),
  criterion: z.string().default(""),
  met: z.enum(["yes", "no", "unknown"]).default("unknown"),
  evidence: z.string().default(""),
  /** Orkestratör ekledi (agent bu madde için bir şey yazmadı). */
  synthesized: z.boolean().default(false),
});
export type AcceptanceEvidence = z.infer<typeof AcceptanceEvidenceSchema>;

/**
 * Plandan bilerek ayrılma. `keyDecisions`ta serbest metin olarak kalırsa insan
 * "plandan nerede ayrıldı"yı satır satır okuyarak bulur; yapısal olunca kapıda
 * öne çıkarılabilir. `.default`lar eski yüklerin okunması için (kural 3).
 */
export const DEVIATION_CATEGORIES = ["library", "pattern", "security", "architecture", "implementation"] as const;
export const DeviationSchema = z.object({
  planned: z.string().default(""),
  actual: z.string().default(""),
  reason: z.string().default(""),
  /**
   * Eksik ya da tanımsız sınıflama `unknown` olur ve kapıda kırmızı vurgu
   * alır. `low`/`implementation` varsayılanı etiketlemeyi unutan agent'ın
   * güvenlik sapmasını sessizce vurgusuz bırakırdı. Alanı ZORUNLU yapmak da
   * çözüm değil: tek satırdaki eksik tüm handoff'u düşürür, orkestratör
   * diff'ten sentezler ve agent'ın bütün sözü (sapmalar dahil) kaybolur.
   */
  category: z.enum([...DEVIATION_CATEGORIES, "unknown"]).catch("unknown").default("unknown"),
  impact: z.enum(["low", "medium", "high", "unknown"]).catch("unknown").default("unknown"),
});
export type Deviation = z.infer<typeof DeviationSchema>;

export const HandoffSchema = z.object({
  completedSteps: z.array(z.string()).default([]),
  remainingSteps: z.array(z.string()).default([]),
  keyDecisions: z.array(z.string()).default([]),
  gotchas: z.array(z.string()).default([]),
  filesTouched: z.array(z.string()).default([]),
  nextAction: z.string().default(""),
  /**
   * Rolün çözemediği maddeler. BOŞ OLMASI NORMAL — agent'ın her koşuda
   * blocker üretmesi beklenmez; şema `.default([])` ile eksikliğe toleranslı
   * (kural 3: üretici taraf güvenilmez).
   */
  blockers: z.array(BlockerSchema).default([]),
  /** Safhanın kabul ölçütlerine kanıt. Yalnız Developer safhası doldurur. */
  acceptanceEvidence: z.array(AcceptanceEvidenceSchema).default([]),
  /** Plandan bilerek ayrılmalar. Boş olması normal. */
  deviations: z.array(DeviationSchema).default([]),
  /** Orkestratör sentezlediyse true — insan neyin tahmin olduğunu bilsin. */
  synthesized: z.boolean().default(false),
});
export type Handoff = z.infer<typeof HandoffSchema>;

/**
 * Şemaya uymadığı için reddedilen yapılandırılmış blok (PLAN_JSON,
 * HANDOFF_JSON). `rejected_block` artifact'ı olarak diske yazılır.
 *
 * Neden saklanıyor: blok reddedilince agent'ın bütün sözü kayboluyordu —
 * Planner iki denemede düşünce plan yalnız sohbet geçmişinde kalıyor, yeniden
 * denemede oturum devralınamazsa Planner keşfi sıfırdan koşuyordu. Hata çoğu
 * zaman tek bir alandır (bkz. `changeKind`, 2026-10-14); bloğu geri vermek
 * yeniden planlamaktan çok daha ucuz.
 */
export const RejectedBlockSchema = z.object({
  tag: z.string().min(1),
  /** Zod hataları `yol: mesaj` biçiminde; JSON hiç ayrışmadıysa tek satır. */
  issues: z.array(z.string()).default([]),
  /** Ham blok — maskelenmiş ve kırpılmış. */
  raw: z.string(),
  truncated: z.boolean().default(false),
});
export type RejectedBlock = z.infer<typeof RejectedBlockSchema>;

// ── Build / test sonuçları ───────────────────────────────────────────────────

export const BuildResultSchema = z.object({
  stepName: z.string(),
  /** Koşullu eşleme tutmadığı için atlandıysa. */
  skipped: z.boolean().default(false),
  skipReason: z.string().default(""),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().default(0),
  logRef: z.string().default(""),
});
export type BuildResult = z.infer<typeof BuildResultSchema>;

export const TestResultSchema = z.object({
  suiteId: z.string(),
  kind: z.enum(["baseline", "run"]).default("run"),
  total: z.number().int().nonnegative().default(0),
  passed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  /**
   * Baseline'da da kırık olan testler. Bunlar agent'ın sorumluluğu DEĞİL ve
   * UI'da ayrı gösterilir — aksi hâlde yanlış panik yaratır.
   */
  preexistingFailures: z.array(z.string()).default([]),
  reportRef: z.string().default(""),
});
export type TestResult = z.infer<typeof TestResultSchema>;
