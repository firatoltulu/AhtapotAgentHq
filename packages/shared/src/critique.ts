import { z } from "zod";

/**
 * İkinci göz: plan ve test senaryolarını, yerel incelemede
 * tanımlı sağlayıcının modeli eleştirir. Üretici Claude, eleştirmen başka
 * model — eleştirmen yazmaz, yalnız ham iş tanımı ile Claude'un anladığı
 * arasındaki tutarsızlığı bulur.
 *
 * Danışmandır: akışı durdurmaz, kapı açmaz, bulgu Planner'a kendiliğinden
 * gitmez. İnsan seçtiğini ret yorumuna ekler.
 */

export const CRITIQUE_SUBJECTS = ["plan", "scenarios"] as const;
export const CritiqueSubjectSchema = z.enum(CRITIQUE_SUBJECTS);
export type CritiqueSubject = z.infer<typeof CritiqueSubjectSchema>;

/**
 * `skipped`: koşmadı ama insan nedenini görmeli (anahtar yok gibi). Profil
 * bayrağı kapalıysa satır hiç yazılmaz — orada söylenecek bir şey yok.
 */
export const CRITIQUE_STATUSES = ["running", "ready", "failed", "skipped"] as const;
export const CritiqueStatusSchema = z.enum(CRITIQUE_STATUSES);
export type CritiqueStatus = z.infer<typeof CritiqueStatusSchema>;

export const CRITIQUE_KINDS = [
  /** Ham metinde var; gereksinimlerde ya da planda yok. */
  "missing_requirement",
  /** Planda var; istenmemiş. */
  "unrequested_scope",
  /** Sessiz varsayım — açık soru olmalıydı. */
  "hidden_assumption",
  /** Gereksinim iki türlü okunuyor. */
  "ambiguity",
  /** Hiçbir safha ya da senaryo karşılamıyor. */
  "uncovered_requirement",
  "missing_edge_case",
  /** Senaryonun beklenen sonucu gereksinimle çelişiyor. */
  "wrong_expectation",
  "other",
] as const;

/**
 * Tek bulgu. Üretici taraf güvenilmez (kural 3): bilinmeyen `kind` bulguyu
 * düşürmez, `other`e iner — model kendi etiketini uydurabiliyor.
 */
export const CritiqueFindingSchema = z.object({
  kind: z.enum(CRITIQUE_KINDS).catch("other"),
  /** Bulgunun bağlandığı yer: `R2`, safha `id`si, senaryo `id`si. Yoksa boş. */
  ref: z.string().default(""),
  text: z.string().min(1),
  suggestion: z.string().default(""),
});
export type CritiqueFinding = z.infer<typeof CritiqueFindingSchema>;

/**
 * Eleştirmenin `CRITIQUE_JSON` bloğu. Blok yoksa SENTEZLENMEZ: "bulgu yok"
 * uydurmak insanı yanıltırdı; satır `failed` kalır.
 */
export const CritiqueDocumentSchema = z.object({
  verdict: z.enum(["ok", "concerns"]),
  /**
   * Varsayılan YOK: `{"verdict":"ok"}` yarım bir yanıt da olabilir; eksik
   * liste "bulgu yok"a çevrilseydi doğrulanmamış bir temiz sonuç doğardı.
   * Boş liste yalnız model açıkça `[]` yazınca geçerli.
   */
  findings: z.array(CritiqueFindingSchema),
  notes: z.string().default(""),
});
export type CritiqueDocument = z.infer<typeof CritiqueDocumentSchema>;
