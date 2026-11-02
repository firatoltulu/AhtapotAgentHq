import { z } from "zod";

/**
 * Yerel inceleme aracının (OpenCodeReview, `ocr review --format json`)
 * çıktısı.
 *
 * Üretici taraf güvenilmez (kural 3): araç LLM'e yazdırıyor ve belgelediği
 * alanları her zaman doldurmuyor. Yorumu yerine OTURTAN alanlar (`path`,
 * `content`) zorunlu; gerisi yoksa boş geçer. Bilinmeyen alanlar atılır —
 * sürüm yükseltmesi eklediği alan yüzünden raporu düşürmemeli.
 */
export const OcrCommentSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  start_line: z.number().int().nonnegative().optional(),
  end_line: z.number().int().nonnegative().optional(),
  suggestion_code: z.string().optional(),
});

export const OcrReportSchema = z.object({
  /**
   * Belge `success`/`completed_with_*` diyor; gerçek koşu manifest'in
   * `terminal_state`ini yazıyor: `complete` · `partial` · `failed` ·
   * `skipped` (ölçüldü, v1.12.9 — belgedekiler yalnız manifest'siz eski yol).
   * Enum DEĞİL: tanınmayan bir değer yüzünden tüm bulgular atılmasın; motor
   * bildiği değerleri yorumlar.
   */
  status: z.string().min(1),
  message: z.string().optional(),
  summary: z.object({
    files_reviewed: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    elapsed: z.string().optional(),
  }).optional(),
  /** Belge "daima var" diyor; `failed` raporunda `null` geliyor (ölçüldü). */
  comments: z.array(OcrCommentSchema).nullish().transform((v) => v ?? []),
  /** Alt ajan düşmelerinin açıklaması; biçimi belgelenmemiş, metne çevrilir. */
  warnings: z.array(z.unknown()).optional(),
});

export type OcrComment = z.infer<typeof OcrCommentSchema>;
export type OcrReport = z.infer<typeof OcrReportSchema>;
