import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { OcrReportSchema, scrubSecrets, type LocalReview, type OcrReport } from "@ahtapot/shared";

import { shellQuote, type CommandExecutor } from "../build/executor.js";
import type { ReviewThread } from "../git/github.js";
import { DEFAULT_BASE_URL } from "./llm.js";

/**
 * Yerel ön inceleme — OpenCodeReview (`ocr`) iş konteynerinde koşar.
 *
 * Konteynerde, çünkü worktree named volume'de: sunucu dosyalara erişemiyor.
 * Anahtar konteynerin KALICI ortamına yazılmaz; yalnız bu exec'in ortamına
 * girer ve süreçle ölür (köprünün `identity.set`i ile aynı ilke). Claude
 * havuzundan ayrıdır: `AHTAPOT_REVIEW_KEYS`.
 */

/**
 * `ad=anahtar` satırlarından adı verilen anahtarı okur. Her çağrıda dosyadan:
 * anahtar eklemek ya da döndürmek sunucuyu yeniden başlatmayı gerektirmesin.
 * `#` ile başlayan ve boş satırlar atlanır.
 */
export function readReviewKey(file: string | undefined, ref: string): string | null {
  if (!file || !existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Compose, host'ta olmayan dosyanın yerine DİZİN yaratıyor (EISDIR).
    return null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() === ref) return line.slice(eq + 1).trim() || null;
  }
  return null;
}

export type OcrOutcome =
  | { ok: true; report: OcrReport }
  | { ok: false; reason: string };

/**
 * `ocr review --from <base> --to HEAD` koşturur ve raporu Zod'dan geçirir.
 *
 * Hata FIRLATMAZ: ön inceleme düşerse akış PR'a geçer, bot yine inceler.
 * Sebep metni maskelidir (kural 4) — anahtar ayrıca açıkça silinir, çünkü
 * `scrubSecrets` her sağlayıcının anahtar biçimini tanımayabilir.
 */
export async function runOcrReview(opts: {
  exec: CommandExecutor;
  worktree: string;
  base: string;
  cfg: LocalReview;
  key: string;
}): Promise<OcrOutcome> {
  const { cfg, key } = opts;
  const args = [
    "review", "--repo", opts.worktree, "--from", opts.base, "--to", "HEAD",
    "--format", "json", "--audience", "agent",
    "--effort", cfg.effort,
    "--max-tokens-budget", String(cfg.maxTokensBudget),
    "--timeout", String(cfg.timeoutMinutes),
    ...(cfg.exclude.length > 0 ? ["--exclude", cfg.exclude.join(",")] : []),
  ];
  // HOME geçici: `~/.opencodereview/config.json` ortam değişkenlerinden
  // ÖNCE okunuyor (OCR'ın çözüm sırası). Konteynerde kalmış bir dosya
  // profilin seçtiği sağlayıcıyı ve anahtarı sessizce ezerdi.
  const command = [
    `export HOME="$(mktemp -d)"`,
    `ocr ${args.map(shellQuote).join(" ")}`,
    `rc=$?`, `rm -rf "$HOME"`, `exit $rc`,
  ].join("; ");

  const stdout: string[] = [];
  const stderr: string[] = [];
  const res = await opts.exec.run({
    command,
    cwd: opts.worktree,
    env: {
      OCR_LLM_URL: cfg.baseUrl ?? DEFAULT_BASE_URL[cfg.protocol],
      OCR_LLM_TOKEN: key,
      OCR_LLM_MODEL: cfg.model ?? "",
      OCR_LLM_PROTOCOL: cfg.protocol,
    },
    // Aracın kendi `--timeout`u alt görev başına; bu dış tavan tüm koşu için.
    timeoutMs: cfg.timeoutMinutes * 60_000 + 60_000,
    onLine: (stream, line) => (stream === "stdout" ? stdout : stderr).push(line),
  });

  const mask = (s: string): string => scrubSecrets(key ? s.replaceAll(key, "***") : s);
  // git 2.39 uyarısı her koşuda basılıyor (bookworm'ün git'i; araç 2.41
  // istiyor ama yalnız uyarıyor — dosya seçimi 2.39'da ölçüldü, çalışıyor).
  const tail = (): string => mask(stderr.filter((l) => !l.startsWith("warning: git ")).slice(-15).join("\n")).slice(0, 1500);

  if (res.timedOut) return { ok: false, reason: `${cfg.timeoutMinutes} dk içinde bitmedi` };
  if (res.exitCode === 127) return { ok: false, reason: "`ocr` konteynerde yok — agent tabanı güncel mi?" };
  if (res.exitCode !== 0) return { ok: false, reason: `çıkış ${res.exitCode ?? "?"}: ${tail() || "(stderr boş)"}` };

  let raw: unknown;
  try {
    raw = JSON.parse(stdout.join("\n"));
  } catch {
    return { ok: false, reason: `çıktı JSON değil: ${mask(stdout.join("\n")).slice(0, 300)}` };
  }
  const parsed = OcrReportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `rapor şemaya uymuyor: ${parsed.error.issues[0]?.message ?? "?"}` };
  // Hiçbir dosya incelenemediyse boş yorum listesi "temiz" DEĞİL.
  if (parsed.data.status === "failed") return { ok: false, reason: mask(parsed.data.message ?? "inceleme düştü") };
  return { ok: true, report: parsed.data };
}

/**
 * OCR yorumlarını bot başlıklarıyla AYNI biçime çevirir: Developer'a giden
 * düzeltme yolu (`runDevOps`) tek kalsın.
 *
 * Şiddet `unknown`: OCR şiddet yazmıyor. Eşiğe (`minSeverity`) tabi
 * tutulmaz — araç precision'a ayarlı; Developer yine her yorumu kodda
 * doğrular ve geçersizi gerekçeyle reddeder.
 */
export function ocrThreads(report: OcrReport): ReviewThread[] {
  return report.comments.map((c) => {
    const body = [
      c.content.trim(),
      ...(c.suggestion_code?.trim() ? ["", "Öneri:", c.suggestion_code.trim()] : []),
    ].join("\n");
    const id = createHash("sha1").update(`${c.path}\0${c.start_line ?? ""}\0${c.content}`).digest("hex").slice(0, 16);
    return {
      id: `ocr:${id}`,
      author: "ocr",
      path: c.path,
      line: c.start_line ?? null,
      body: scrubSecrets(body).slice(0, 4000),
      severity: "unknown" as const,
    };
  });
}
