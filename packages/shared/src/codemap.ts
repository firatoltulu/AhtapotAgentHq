import { z } from "zod";

/**
 * Kod haritası — projenin modül künyeleri (karar §35).
 *
 * Gerçek kaynak bu JSON'dur; agent'ın okuduğu `INDEX.md` ve
 * `modules/<id>.md` sunucuda bundan üretilir. Agent markdown yazmaz:
 * biçim motorda kalsın, agent yalnız içeriği versin.
 */

const ModuleId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "küçük harf, rakam ve tire");

export const CodeMapModuleSchema = z.object({
  id: ModuleId,
  name: z.string().min(1).max(120),
  /** `profile.workspace.repos[].name`. */
  repo: z.string().min(1),
  /**
   * Repo köküne göreli DİZİN önekleri ("src/Orders", "." = tüm repo).
   * Glob değil: tazelik denetimi `startsWith` ile yapılır, belirsizlik olmasın.
   */
  paths: z.array(z.string().min(1)).min(1),
  /** Tek cümle — INDEX satırına girer. */
  purpose: z.string().min(1).max(240),
  keyFiles: z.array(z.object({ path: z.string().min(1), role: z.string().default("") })).max(15).default([]),
  entryPoints: z.array(z.string()).max(15).default([]),
  /** Dokunulunca başka katmanları etkileyen dosyalar: DTO, şema, API sözleşmesi. */
  contracts: z.array(z.string()).max(15).default([]),
  entities: z.array(z.string()).max(30).default([]),
  endpoints: z.array(z.string()).max(40).default([]),
  /** Diğer modüllerin `id`leri. */
  dependsOn: z.array(z.string()).max(20).default([]),
  pitfalls: z.array(z.string()).max(10).default([]),
  /** Künyenin üretildiği commit (o repoda). */
  sha: z.string().default(""),
  /** Son tazelikte modülün dizinine düşen değişiklikler — doluysa künye bayattır. */
  stale: z.array(z.string()).default([]),
  updatedAt: z.string().default(""),
});
export type CodeMapModule = z.infer<typeof CodeMapModuleSchema>;

export const CodeMapSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  generatedAt: z.string(),
  /** Son tazelikte her reponun HEAD'i. */
  commits: z.record(z.string(), z.string()).default({}),
  modules: z.array(CodeMapModuleSchema).default([]),
  /** Hiçbir modülün dizinine düşmeyen değişen dosyalar (`<repo>/<yol>`). */
  unmapped: z.array(z.string()).default([]),
});
export type CodeMap = z.infer<typeof CodeMapSchema>;

/**
 * Merge edilmiş bir işin yaşadıkları — haritacıya ders hammaddesi (karar §39).
 *
 * Statik okuma sessiz bozulan derlemeyi, yanlış varsayılan sözleşmeyi
 * göremez; iş içinde çarpılan tuzak yalnız burada vardır. Not künyeye
 * motor tarafından yazılmaz: haritacı kodla doğrulayıp genellenebilir
 * olanı `pitfalls`a işler.
 */
export const CodeMapLessonsSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  /** Workspace köküne göreli dokunulan dosyalar — dersin hangi künyeye gideceğini belirler. */
  files: z.array(z.string()).default([]),
  notes: z.array(z.object({
    source: z.enum(["gotcha", "blocker", "deviation", "build", "review"]),
    text: z.string().min(1),
  })).default([]),
});
export type CodeMapLessons = z.infer<typeof CodeMapLessonsSchema>;

/** `GET /api/projects/:id/codemap` gövdesi. */
export interface CodeMapStatus {
  enabled: boolean;
  running: boolean;
  lastError: string | null;
  generatedAt: string | null;
  commits: Record<string, string>;
  modules: number;
  stale: string[];
  unmapped: number;
}
