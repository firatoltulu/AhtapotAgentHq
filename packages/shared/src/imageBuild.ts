import { z } from "zod";

/**
 * Proje imajı build'i — Analyst'in ürettiği Dockerfile'ın somut çıktısı.
 *
 * Profil onaylandığında sunucu `exec.dockerfile`daki tarifi `exec.image`
 * etiketine build eder. Bu şema o build'in DURUMUNU taşır; ilerleme WS'ten
 * DEĞİL polling ile okunur (olay job-scoped, build ise profil seviyesinde).
 *
 * Log içeriği burada YOK: `logRef` bir dosya yoludur (`builds.logRef` ile aynı
 * kalıp). Onlarca MB'lık `docker build` çıktısı DB satırına gömülmez.
 */

export const ImageBuildStatusSchema = z.enum(["running", "succeeded", "failed"]);
export type ImageBuildStatus = z.infer<typeof ImageBuildStatusSchema>;

export const ImageBuildSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  status: ImageBuildStatusSchema,
  /** Build edilen etiket (`exec.image`) — profil sonradan değişse de kayıt neyin build edildiğini bilir. */
  imageRef: z.string().min(1),
  error: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImageBuild = z.infer<typeof ImageBuildSchema>;
