import {
  MODEL_TIER_ORDER,
  TriageDocumentSchema,
  type ModelChoice,
  type ModelTier,
  type PhaseTriage,
  type Triage,
  type TriageDocument,
  type TriageSignal,
} from "@ahtapot/shared";

/**
 * Triage kararının SAF mantığı — SDK yok, DB yok, yan etki yok.
 *
 * Ayrı dosya olmasının sebebi test edilebilirlik: model seçimi para harcayan
 * bir karar ve eşikteki ters bir karşılaştırma doğrudan bütçe kaybı demek.
 * Burası tamamen deterministik, dolayısıyla tamamen sınanabilir.
 *
 * İş bölümü nettir: ucuz model ÖLÇER (kaç katman, kaç dosya, git'te kaç
 * commit, metinde belirsiz ifade var mı), motor KARAR VERİR. Tier'ı modelin
 * yargısına bırakmak, bütçe politikasını LLM sezgisine devretmek olurdu.
 */

/** Sinyal seviyelerinin sayısal ağırlığı. */
const SIGNAL_WEIGHT: Record<TriageSignal["level"], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  /**
   * Bilinmezlik SIFIR değil.
   *
   * Model "emin değilim" dediğinde bunu "sorun yok" saymak, ucuz modelin
   * kendi sınırını bildirmesini cezalandırmak olur — ve tam da ölçemediği
   * için ucuz modele bırakılmaması gereken işi ucuza gönderir. `low` ile aynı
   * ağırlık: belirsizlik hafif bir yukarı baskıdır.
   */
  unknown: 1,
};

function weigh(signal: TriageSignal | undefined): number {
  return SIGNAL_WEIGHT[signal?.level ?? "unknown"] ?? 1;
}

/** Bir seviyeyi `n` basamak yukarı taşır (tavanda durur). */
export function bumpTier(tier: ModelTier, steps = 1): ModelTier {
  const i = MODEL_TIER_ORDER.indexOf(tier);
  const next = Math.min(MODEL_TIER_ORDER.length - 1, (i < 0 ? 0 : i) + steps);
  return MODEL_TIER_ORDER[next]!;
}

/** İki seviyeden ucuz olanı — kör maliyet freni (`maxTier`) bunu kullanır. */
export function clampToMaxTier(tier: ModelTier, maxTier: ModelTier): ModelTier {
  const a = MODEL_TIER_ORDER.indexOf(tier);
  const b = MODEL_TIER_ORDER.indexOf(maxTier);
  return a <= b ? tier : maxTier;
}

/** Seviye `approvalRequiredFrom` eşiğine ulaşıyor mu — `null` eşik hiç onay istemez. */
export function tierNeedsApproval(tier: ModelTier, cfg: Triage): boolean {
  const threshold = cfg.approvalRequiredFrom;
  return threshold !== null && MODEL_TIER_ORDER.indexOf(tier) >= MODEL_TIER_ORDER.indexOf(threshold);
}

/**
 * Onaysız koşabilecek en pahalı seviye: eşik aşılıyorsa eşiğin bir altı.
 *
 * Planlama için var: Planner plan kapısından ÖNCE koşar, onun seçimini gömecek
 * bir onay henüz yoktur. Eşik en alt basamaksa (`cheap`) onaysız seviye
 * kalmaz → `null`, çağıran rolün sabit modeline düşer.
 */
export function capBelowApproval(tier: ModelTier, cfg: Triage): ModelTier | null {
  if (!tierNeedsApproval(tier, cfg)) return tier;
  const i = MODEL_TIER_ORDER.indexOf(cfg.approvalRequiredFrom!);
  return i > 0 ? MODEL_TIER_ORDER[i - 1]! : null;
}

/** `a` seviyesi `b`den pahalı mı (eşitse false). */
export function isAbove(a: ModelTier, b: ModelTier): boolean {
  return MODEL_TIER_ORDER.indexOf(a) > MODEL_TIER_ORDER.indexOf(b);
}

/**
 * Ölçülen sinyallerden seviyeyi TÜRETİR.
 *
 * Triage kendi `recommendedTier`ını yazar ama motor buna mecbur değil: belge
 * eksik gelirse (üretici taraf güvenilmez) sinyallerden türetme yapılır.
 * `resolveTier` ikisini birleştirir — modelin önerisi ile motorun türetmesi
 * ayrışırsa PAHALI olan kazanır, çünkü yanlış ucuz seçimin bedeli (başarısız
 * iş + yeniden koşma) yanlış pahalı seçiminkinden yüksektir.
 *
 * Eşikler deneyime göre ayarlanacak; ilk hâli kasten muhafazakâr.
 */
export function deriveTier(doc: TriageDocument): ModelTier {
  let score = 0;

  // ── Kapsam: kaç katman, şema değişikliği, tenant izolasyonu ──
  // `unknown` katmanı saymayız; gerçek katman sayısı genişlikten haber verir.
  const layers = doc.scope.layers.filter((l) => l !== "unknown");
  if (layers.length >= 4) score += 3;
  else if (layers.length === 3) score += 2;
  else if (layers.length === 2) score += 1;

  // Şema değişikliği ağır basar: migration geri alınamaz, FK/cascade hatası
  // veri kaybeder. Bu, ucuz modele bırakılmayacak işin en net imzası.
  score += weigh(doc.scope.schemaChange) * 1.5;
  score += weigh(doc.scope.multiTenantImpact);

  // Dosya sayısı: postplan'da plandan sayılır, intake'te tahmindir.
  if (doc.scope.estimatedFiles >= 12) score += 2;
  else if (doc.scope.estimatedFiles >= 6) score += 1;

  // ── Belirsizlik: cevabı olmayan soru, tahmin edilmiş varsayılan ──
  score += weigh(doc.ambiguity.overall);
  const vague = doc.ambiguity.vaguePhrases.length + doc.ambiguity.unclearTerms.length;
  if (vague >= 3) score += 2;
  else if (vague >= 1) score += 1;
  if (doc.ambiguity.assumedDefaults.length >= 2) score += 1;

  // ── Risk: geri dönüşsüzlük ve "ince hata" kategorisi ──
  score += weigh(doc.risk.irreversible) * 1.5;
  // Concurrency/race condition/state mutation: gözle yakalanması en zor kusur
  // sınıfı. Derin akıl yürütme burada gerçekten fark yaratır.
  score += weigh(doc.risk.concurrency) * 1.5;
  if (doc.risk.changeKind === "breaking") score += 2;
  else if (doc.risk.changeKind === "mixed") score += 1;

  // ── Geçmiş: çok patch görmüş dosya tuzaklıdır ──
  // Sekiz commit gören bir dosya ya kırılgan ya da karmaşık; ikisi de dikkat
  // ister. Emsal varsa (referans alınacak bir pattern) iş kolaylaşır.
  const churny = doc.history.touchedFiles.filter((f) => f.commits >= 8).length;
  if (churny >= 2) score += 2;
  else if (churny === 1) score += 1;
  if (doc.history.similarPrecedent.trim()) score -= 1;

  if (score >= 12) return "frontier";
  if (score >= 7) return "deep";
  if (score >= 3) return "standard";
  return "cheap";
}

/**
 * Safha ölçümünden seviye türetir — `deriveTier`i YENİDEN KULLANIR.
 *
 * Neden ayrı fonksiyon değil de sarmalayıcı: eşikler tek yerde kalmalı. Safha
 * ölçümü iş ölçümünün alt kümesidir; ikinci bir eşik tablosu yazmak, ikisinin
 * zamanla ayrışması demekti.
 *
 * ÖLÇÜM YOKSA SENTEZLENİR (kural 3): Planner `triage` bloğunu yazmazsa safha
 * sınıflandırmasız kalmaz — `risk` ve dosya sayısı zaten plandadır ve ikisi
 * birlikte kaba ama kullanılabilir bir sinyal verir. `high` risk `irreversible`
 * sayılmaz (risk "dikkat" der, geri dönüşsüzlük başka bir şeydir); `concurrency`
 * sinyali olarak okunur — plan riskinin en sık sebebi odur.
 *
 * `estimatedFiles` HER ZAMAN plandan sayılır, Planner'ın beyanından değil:
 * `savePlan` içindeki `exceedsFileCap` yeniden hesaplamasıyla aynı desen —
 * agent ne derse desin sayı konuşur.
 */
export function resolvePhaseTier(
  phase: { triage?: PhaseTriage | undefined; files: string[]; risk: "low" | "medium" | "high" },
  cfg: Triage,
): { tier: ModelTier; requiresApproval: boolean } | null {
  const measured: PhaseTriage = phase.triage ?? {
    scope: {
      layers: [],
      schemaChange: { level: "unknown", note: "" },
      multiTenantImpact: { level: "unknown", note: "" },
      estimatedFiles: 0,
    },
    ambiguity: {
      vaguePhrases: [], unclearTerms: [], assumedDefaults: [],
      overall: { level: "unknown", note: "" },
    },
    risk: {
      irreversible: { level: "unknown", note: "" },
      // Planner ölçüm yazmadı: safha riskini concurrency sinyaline çeviriyoruz.
      concurrency: { level: phase.risk === "high" ? "high" : phase.risk === "medium" ? "low" : "none", note: "plan riskinden sentezlendi" },
      changeKind: "unknown",
    },
  };

  // `deriveTier` tam belge bekler: eksik `history` ve karar alanları doldurulur.
  // `history` boş → emsal indirimi uygulanmaz, churn puanı eklenmez.
  const doc: TriageDocument = {
    ...measured,
    scope: { ...measured.scope, estimatedFiles: phase.files.length },
    history: { touchedFiles: [], churnNote: "", similarPrecedent: "" },
    stage: "postplan",
    acceptanceCriteria: [],
    questions: [],
    recommendedTier: "cheap",
    rationale: "safha ölçümü",
    confidence: "medium",
  };

  const tier = clampToMaxTier(deriveTier(doc), cfg.maxTier);
  // Kırpmadan SONRA: `maxTier` zaten engellemişse sorulacak bir şey kalmamıştır.
  return { tier, requiresApproval: tierNeedsApproval(tier, cfg) };
}

/**
 * Nihai karar: triage'ın önerisi + motorun türetmesi + profil frenleri.
 *
 * Sıra önemli:
 *  1. Öneri ile türetmenin PAHALI olanı alınır (yanlış ucuz daha pahalıya patlar).
 *  2. `confidence:"low"` ise bir basamak yukarı — model kendi kararına
 *     güvenmiyorsa biz de güvenmeyiz.
 *  3. `maxTier` ile kırpılır — kör maliyet freni her şeyin üstünde.
 *  4. `approvalRequiredFrom` eşiği aşılıyorsa insan onayı işaretlenir.
 *
 * `requiresApproval` KIRPMADAN SONRA hesaplanır: `maxTier` zaten `frontier`ı
 * engellemişse insana sorulacak bir şey kalmamıştır.
 */
export function resolveTier(
  doc: TriageDocument,
  cfg: Triage,
): { tier: ModelTier; requiresApproval: boolean; derived: ModelTier } {
  const derived = deriveTier(doc);
  let tier = isAbove(doc.recommendedTier, derived) ? doc.recommendedTier : derived;

  if (doc.confidence === "low") tier = bumpTier(tier);
  tier = clampToMaxTier(tier, cfg.maxTier);

  return { tier, requiresApproval: tierNeedsApproval(tier, cfg), derived };
}

/**
 * Seviyeyi profilin merdiveninden modele çevirir.
 *
 * Merdivende basamak tanımsızsa `fallbackTier`a, o da yoksa ilk tanımlı
 * basamağa düşülür: eksik yapılandırma yüzünden iş DÜŞMEMELİ. Hiçbir basamak
 * yoksa `null` döner ve çağıran rolün kendi sabit modelini kullanır.
 */
export function rungFor(tier: ModelTier, cfg: Triage): { model: string; effort: string } | null {
  const rung = cfg.ladder[tier] ?? cfg.ladder[cfg.fallbackTier];
  if (rung) return { model: rung.model, effort: rung.effort };
  for (const t of MODEL_TIER_ORDER) {
    const any = cfg.ladder[t];
    if (any) return { model: any.model, effort: any.effort };
  }
  return null;
}

/**
 * Tam karar: belge → seviye → model. Kapı yüküne giren şey budur.
 *
 * `null` dönerse merdiven tamamen boştur; çağıran rolün sabit modelinde kalır.
 */
export function chooseModel(doc: TriageDocument, cfg: Triage): ModelChoice | null {
  const { tier, requiresApproval, derived } = resolveTier(doc, cfg);
  const rung = rungFor(tier, cfg);
  if (!rung) return null;

  const why = [doc.rationale.trim()];
  if (derived !== doc.recommendedTier) {
    why.push(`motor türetmesi: ${derived}, triage önerisi: ${doc.recommendedTier}`);
  }
  if (doc.confidence === "low") why.push("güven düşük; bir basamak yukarı alındı");
  if (tier !== derived && tier === cfg.maxTier) why.push(`profil tavanı: ${cfg.maxTier}`);

  return {
    tier,
    model: rung.model,
    effort: rung.effort,
    rationale: why.filter(Boolean).join(" · "),
    requiresApproval,
  };
}

/**
 * Ham blok → belge. Üç katmanlı doğrulamanın motor tarafı.
 *
 * Triage `HANDOFF_JSON`a benzer, `PLAN_JSON`a değil: planın yerine geçecek bir
 * şey yoktur (bu yüzden orada `fail("no_plan")`), ama triage bir DANIŞMANDIR —
 * çıktısı olmasa da sistem bugünkü davranışıyla koşar. Bu yüzden:
 *
 *  - Blok hiç yoksa `null` döner; çağıran `fallbackTier`a düşer.
 *  - Blok var ama `recommendedTier`/`rationale` eksikse belge ÇÖPE ATILMAZ:
 *    okunabilen sinyaller korunur, tier motorda türetilir ve gerekçeye
 *    "motor sentezledi" yazılır. Ölçümün kendisi değerlidir.
 *
 * Yeniden dürtme YOK (Planner'dan farkı): ikinci bir tur, tasarrufun bir
 * kısmını yer ve triage'ın kendisi zaten isteğe bağlı bir iyileştirmedir.
 */
export function parseTriage(raw: unknown, stage: TriageDocument["stage"]): {
  doc: TriageDocument;
  synthesized: boolean;
} | null {
  if (raw === null || typeof raw !== "object") return null;

  const direct = TriageDocumentSchema.safeParse({ ...(raw as object), stage });
  if (direct.success) return { doc: direct.data, synthesized: false };

  // Karar alanları eksik/bozuk — ölçümleri kurtarıp tier'ı motorda türet.
  const salvage = TriageDocumentSchema.safeParse({
    ...(raw as object),
    stage,
    recommendedTier: "cheap",
    rationale: "motor sentezledi: triage karar alanlarını yazmadı",
  });
  if (!salvage.success) return null;

  const doc = salvage.data;
  return {
    doc: { ...doc, recommendedTier: deriveTier(doc) },
    synthesized: true,
  };
}
