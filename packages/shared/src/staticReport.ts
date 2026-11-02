import { z } from "zod";

/**
 * Statik analiz raporları (`workflow.review.static`).
 *
 * Üretici taraf güvenilmez (kural 3): araçlar sürümden sürüme alan ekler,
 * bazılarını boş bırakır. Bulguyu yerine OTURTAN alanlar zorunlu, gerisi
 * isteğe bağlı; bilinmeyen alanlar atılır.
 */

export type StaticLevel = "error" | "warning" | "note";

/** Araçtan bağımsız tek bulgu biçimi. `path` araç ne yazdıysa odur — göreli yapmak çağıranın işi. */
export interface StaticFinding {
  path: string;
  line: number | null;
  rule: string;
  level: StaticLevel;
  message: string;
}

// ── SARIF 2.1 (asgari alt küme) ───────────────────────────────────────────

const SarifResultSchema = z.object({
  ruleId: z.string().optional(),
  /** Spec: yoksa `warning`. `none` bilgi amaçlı, bulgu değil. */
  level: z.enum(["error", "warning", "note", "none"]).optional(),
  message: z.object({ text: z.string().optional() }).optional(),
  locations: z.array(z.object({
    physicalLocation: z.object({
      artifactLocation: z.object({ uri: z.string().min(1) }).optional(),
      region: z.object({ startLine: z.number().int().optional() }).optional(),
    }).optional(),
  })).optional(),
});

export const SarifLogSchema = z.object({
  runs: z.array(z.object({
    results: z.array(SarifResultSchema).nullish().transform((v) => v ?? []),
  })).default([]),
});

export function parseSarif(raw: unknown): StaticFinding[] {
  const log = SarifLogSchema.parse(raw);
  const out: StaticFinding[] = [];
  for (const run of log.runs) {
    for (const r of run.results) {
      const loc = r.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      // Konumsuz bulgu (proje düzeyi) bir dosyaya bağlanamaz; kapsam süzgeci
      // onu zaten atardı.
      if (!uri || r.level === "none") continue;
      out.push({
        path: uri,
        line: loc?.region?.startLine ?? null,
        rule: r.ruleId ?? "?",
        level: r.level ?? "warning",
        message: r.message?.text?.trim() || r.ruleId || "(mesaj yok)",
      });
    }
  }
  return out;
}

// ── dotnet format --report ────────────────────────────────────────────────

export const DotnetFormatReportSchema = z.array(z.object({
  FilePath: z.string().min(1),
  FileChanges: z.array(z.object({
    LineNumber: z.number().int().optional(),
    DiagnosticId: z.string().optional(),
    FormatDescription: z.string().optional(),
  })).nullish().transform((v) => v ?? []),
}));

/**
 * `--verify-no-changes` ile raporlanan her değişiklik `error` sayılır:
 * CI'daki `format` job'u bunları kırmızı yapar, seviyesi yok.
 */
export function parseDotnetFormat(raw: unknown): StaticFinding[] {
  return DotnetFormatReportSchema.parse(raw).flatMap((doc) => doc.FileChanges.map((c) => ({
    path: doc.FilePath,
    line: c.LineNumber ?? null,
    rule: c.DiagnosticId ?? "FORMAT",
    level: "error" as const,
    message: c.FormatDescription?.trim() || "biçim kuralına uymuyor",
  })));
}

// ── MSBuild/Roslyn çıktısı ────────────────────────────────────────────────

/**
 * `yol(satır,kolon): warning KOD: mesaj [proje]`. Kolon kısmı `(s)`,
 * `(s,k)` ya da `(s,k,s2,k2)` olabilir. Önek (`  1>` gibi) atlanır.
 */
const MSBUILD_LINE = /^\s*(?:\d+>)?\s*(.+?)\((\d+)(?:,\d+){0,3}\):\s+(warning|error)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]+\])?\s*$/;

/**
 * MSBuild aynı uyarıyı derleme sırasında ve sondaki özette iki kez basar;
 * tekilleştirme çağıranın işi (`dedupeFindings`).
 */
export function parseMsbuildLog(lines: readonly string[]): StaticFinding[] {
  const out: StaticFinding[] = [];
  for (const l of lines) {
    const m = MSBUILD_LINE.exec(l);
    if (!m) continue;
    out.push({
      path: m[1]!.trim(),
      line: Number(m[2]),
      rule: m[4]!,
      level: m[3] === "error" ? "error" : "warning",
      message: m[5]!.trim() || m[4]!,
    });
  }
  return out;
}

const LEVEL_RANK: Record<StaticLevel, number> = { note: 0, warning: 1, error: 2 };

/** `min` seviyesinin altındakileri atar. */
export function atLeast(findings: readonly StaticFinding[], min: StaticLevel): StaticFinding[] {
  return findings.filter((f) => LEVEL_RANK[f.level] >= LEVEL_RANK[min]);
}

/** Aynı (yol, satır, kural) tek bulgu. */
export function dedupeFindings(findings: readonly StaticFinding[]): StaticFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.path}\0${f.line ?? ""}\0${f.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
