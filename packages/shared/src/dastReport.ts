import { z } from "zod";

import { parseSarif } from "./staticReport.js";

/**
 * DAST raporları (`live.dast`). Üretici taraf güvenilmez (kural 3): yalnız
 * bulguyu anlatan alanlar okunur, bilinmeyenler atılır.
 */

export type DastRisk = "high" | "medium" | "low" | "info";

export interface DastFinding {
  /** Adımın `id`si. */
  tool: string;
  rule: string;
  risk: DastRisk;
  title: string;
  detail: string;
  /** Örnek adres; tarayıcı iç ağ adresini yazar (`http://app:5080/...`). */
  url?: string;
  /** Aynı uyarının kaç örneği var (ZAP). */
  count?: number;
}

/** `live_test` kapısının DAST bölümü. */
export interface DastSummary {
  /** Hiçbir raporlu adım koşamadıysa `false` — boş liste "temiz" DEĞİL. */
  ran: boolean;
  minRisk: Exclude<DastRisk, "info">;
  counts: Record<DastRisk, number>;
  /** Eşik üstü bulgu sayısı. */
  blocking: number;
  /** Riske göre sıralı, kırpılmış. */
  findings: DastFinding[];
  /** Koşamayan adımlar ve sebepleri. */
  failures: { step: string; reason: string }[];
  /** Raporların artifact dizinindeki yeri (`<jobId>/dast-<tur>`). */
  reportDir: string;
  /**
   * Taranan kod: HEAD ve `live.dast` ayarının özeti. İkisi de aynıysa
   * "Yeniden kaldır" taramayı yinelemez, önceki özeti taşır.
   */
  sha?: string;
  configKey?: string;
  /**
   * Çalışma ağacının tamamının git ağaç özeti (kirli ağaç dahil). Taşıma
   * buna bakar: canlı build worktree'yi kirlettiği için temiz HEAD şartı
   * taramayı hiç taşıtmıyordu.
   */
  tree?: string;
  /**
   * Neye saldırıldı. `branch`: dalın değiştirdiği uçlar (`paths`);
   * `full`: tüm uygulama — ya profil öyle istedi ya da dalda uç bulunamadı
   * (`reason`). Kapıda "neyi taradı?" sorusunun cevabı.
   */
  scope?: { mode: "branch" | "full"; paths: string[]; reason?: string };
}

const RISK_RANK: Record<DastRisk, number> = { info: 0, low: 1, medium: 2, high: 3 };

export function riskAtLeast(r: DastRisk, min: DastRisk): boolean {
  return RISK_RANK[r] >= RISK_RANK[min];
}

export function sortByRisk(findings: readonly DastFinding[]): DastFinding[] {
  return [...findings].sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);
}

// ── ZAP `-J` ──────────────────────────────────────────────────────────────

const ZapAlertSchema = z.object({
  pluginid: z.union([z.string(), z.number()]).optional(),
  alert: z.string().optional(),
  name: z.string().optional(),
  /** Belgede sayı, gerçek raporda STRING ("3"). İkisi de kabul. */
  riskcode: z.union([z.string(), z.number()]).optional(),
  desc: z.string().optional(),
  solution: z.string().optional(),
  count: z.union([z.string(), z.number()]).optional(),
  instances: z.array(z.object({ uri: z.string().optional() })).optional(),
});

export const ZapReportSchema = z.object({
  site: z.array(z.object({
    alerts: z.array(ZapAlertSchema).nullish().transform((v) => v ?? []),
  })).nullish().transform((v) => v ?? []),
});

const ZAP_RISK: Record<string, DastRisk> = { "3": "high", "2": "medium", "1": "low", "0": "info" };

/** ZAP açıklamaları `<p>` etiketli HTML; prompt ve UI düz metin ister. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function parseZapJson(tool: string, raw: unknown): DastFinding[] {
  const report = ZapReportSchema.parse(raw);
  return report.site.flatMap((site) => site.alerts.map((a) => {
    const solution = a.solution ? stripHtml(a.solution) : "";
    const url = a.instances?.[0]?.uri;
    const count = a.count !== undefined ? Number(a.count) : a.instances?.length;
    return {
      tool,
      rule: String(a.pluginid ?? "?"),
      risk: ZAP_RISK[String(a.riskcode ?? "0")] ?? "info",
      title: a.alert ?? a.name ?? "(adsız uyarı)",
      detail: [a.desc ? stripHtml(a.desc) : "", solution ? `Çözüm: ${solution}` : ""].filter(Boolean).join("\n"),
      ...(url ? { url } : {}),
      ...(count !== undefined && Number.isFinite(count) ? { count } : {}),
    };
  }));
}

// ── JUnit (Schemathesis) ──────────────────────────────────────────────────

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Her kırık `<testcase>` bir bulgu; mesaj `message` özniteliğinden ya da gövdeden. */
export function parseJunitFailures(tool: string, xml: string, risk: Exclude<DastRisk, "info">): DastFinding[] {
  const out: DastFinding[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] ?? "";
    const f = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!f) continue;
    const name = unescapeXml(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? "?");
    const message = unescapeXml(/\bmessage="([^"]*)"/.exec(f[2] ?? "")?.[1] ?? "");
    const text = unescapeXml((f[3] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")).trim();
    out.push({
      tool,
      rule: f[1]!,
      risk,
      title: name,
      detail: [message, text].filter(Boolean).join("\n").slice(0, 2000),
    });
  }
  return out;
}

// ── SARIF ─────────────────────────────────────────────────────────────────

const SARIF_RISK = { error: "high", warning: "medium", note: "low" } as const;

export function parseDastSarif(tool: string, raw: unknown): DastFinding[] {
  return parseSarif(raw).map((f) => ({
    tool,
    rule: f.rule,
    risk: SARIF_RISK[f.level],
    title: f.message.split("\n")[0]!.slice(0, 200),
    detail: f.message,
    url: f.path,
  }));
}

// ── Kapsam (dalın uçları) ─────────────────────────────────────────────────

/**
 * Yol listesinin ve tek yolun tavanı. Liste env ile (`TARGET_PATHS`,
 * `TARGET_PATH_REGEX`) her tarayıcıya gider; Linux tek env dizesini 128 KB
 * ile sınırlar (`MAX_ARG_STRLEN`). 200 × 256 B ≈ 50 KB; regex kaçışlarla
 * bile sınırın altında kalır.
 */
export const MAX_TARGET_PATHS = 200;
const MAX_TARGET_PATH_BYTES = 256;

/**
 * Metindeki rota tanımlarından yolları çıkarır (`live.dast.scope.routePattern`).
 * 1. grup varsa o, yoksa eşleşmenin tamamı. Yol `/` ile başlar, çift `/`
 * tekilleşir; sorgu dizesi ve sondaki `/` atılır.
 */
export function extractRoutes(content: string, pattern: string, prefix = ""): string[] {
  const re = new RegExp(pattern, "g");
  const out = new Set<string>();
  for (const m of content.matchAll(re)) {
    const raw = (m[1] ?? m[0]).trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
    // Önek (FastEndpoints `RoutePrefix`) baştaki `/`dan bağımsız her yola
    // eklenir; yol zaten önekle başlıyorsa ikilenmez.
    const pre = prefix.replace(/^\/+|\/+$/g, "");
    let p = raw.split("?")[0]!.replace(/^\/+/, "");
    if (pre && p !== pre && !p.startsWith(`${pre}/`)) p = `${pre}/${p}`;
    p = `/${p}`.replace(/\/{2,}/g, "/");
    if (p.length > 1) p = p.replace(/\/+$/, "");
    // Önek eklendikten sonra, UTF-8 bayt olarak: env sınırı bayt sayar.
    // `TextEncoder`, `Buffer` değil: paket arayüzde de yükleniyor.
    if (new TextEncoder().encode(p).length > MAX_TARGET_PATH_BYTES) continue;
    out.add(p);
    if (out.size >= MAX_TARGET_PATHS) break;
  }
  return [...out].sort();
}

/**
 * Yolların çapalı birleşimi. Yol parametreleri (`{id}`, `{id:int}`, `:id`)
 * tek segmente eşlenir — tarayıcı OpenAPI'deki şablonu ya da somut adresi
 * görebilir, ikisi de tutmalı.
 */
export function targetPathRegex(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const seg = (s: string): string =>
    /^\{[^}]*\}$/.test(s) || /^:\w+$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^(?:${paths.map((p) => p.split("/").map(seg).join("/")).join("|")})/?$`;
}
