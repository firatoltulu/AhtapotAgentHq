import { createHash } from "node:crypto";

import {
  atLeast,
  dedupeFindings,
  parseDotnetFormat,
  parseMsbuildLog,
  parseSarif,
  scrubSecrets,
  type StaticFinding,
  type StaticStep,
} from "@ahtapot/shared";

import { LineSplitter, shellQuote, type CommandExecutor, type ExecRequest, type ExecResult } from "../build/executor.js";
import { containsFlag } from "../build/gate.js";
import { ensureImage, type DockerRun } from "../exec/dockerCli.js";
import type { ReviewThread } from "../git/github.js";

/**
 * Yerel statik analiz (`workflow.review.static`) — iş konteynerinde koşar.
 *
 * Konteynerde, çünkü worktree named volume'de: sunucu ne dosyaları ne raporu
 * görebiliyor, rapor da `cat` ile konteynerden okunur (`ocr.ts` ile aynı
 * sebep). İmajlı adım (`step.image`, ör. MegaLinter) ayrı bir konteynerde,
 * iş volume'ü aynı yola bağlanarak koşar (`imageExecutor`). Hata FIRLATMAZ:
 * bu bir ön filtre, araç düşerse akış sürer.
 */

/** Rapor worktree DIŞINDA: commit'e girmesin, sır kuralları kendini taramasın. */
const REPORT_DIR = "/tmp/ahtapot-static";

/** `msbuild-log` için tutulan en çok satır — çözüm derlemesi on binlerce satır basabiliyor. */
const MAX_LOG_LINES = 200_000;

export type StaticOutcome =
  | { ok: true; findings: StaticFinding[]; fixNote?: string }
  | { ok: false; reason: string };

export async function runStaticStep(opts: {
  exec: CommandExecutor;
  worktree: string;
  step: StaticStep;
  /**
   * `step.image` doluysa komutları koşturan yürütücü ve raporun yazılacağı
   * dizin (volume'de, worktree dışında). Yoksa imajlı adım koşamaz.
   */
  image?: { exec: CommandExecutor; reportDir: string };
  forbiddenFlags: readonly string[];
  /** Değişen dosyalar — komut `$AHTAPOT_CHANGED` ile daraltabilsin (ör. `dotnet format --include`). */
  changed: readonly string[];
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}): Promise<StaticOutcome> {
  const { step } = opts;
  // Derleme kapısındaki kısıt burada da geçerli: `-c Release` statik adımda
  // da private feed'e düşer (Northwind).
  for (const cmd of [step.run, step.fix ?? ""]) {
    for (const flag of opts.forbiddenFlags) {
      if (containsFlag(cmd, flag)) return { ok: false, reason: `yasak bayrak: "${flag}"` };
    }
  }

  if (step.image && !opts.image) return { ok: false, reason: "imajlı adım için docker yok (sunucuda `docker` CLI gerekir)" };
  // İmajlı adımın `/tmp`si konteynerle ölür; rapor iş konteynerinden okunacağı
  // için ortak volume'de durmalı.
  const runner = step.image && opts.image ? opts.image.exec : opts.exec;
  const reportDir = step.image && opts.image ? opts.image.reportDir : REPORT_DIR;
  const reportPath = step.report.path ?? `${reportDir}/${step.id}.${step.report.format === "sarif" ? "sarif" : "json"}`;
  const env = { AHTAPOT_REPORT: reportPath, AHTAPOT_CHANGED: opts.changed.join(" ") };
  const timeoutMs = step.timeoutMinutes * 60_000;

  let fixNote: string | undefined;
  if (step.fix) {
    const err: string[] = [];
    const res = await runner.run({
      command: step.fix, cwd: opts.worktree, env, timeoutMs,
      onLine: (s, l) => { if (s === "stderr") err.push(l); opts.onLine?.(s, l); },
    });
    // Düzelticinin düşmesi denetimi engellemez: kalan bulgular yine raporlanır.
    if (res.timedOut || res.exitCode !== 0) {
      fixNote = `otomatik düzeltici ${res.timedOut ? "zaman aşımına uğradı" : `çıkış ${res.exitCode ?? "?"}`}: ${scrubSecrets(err.slice(-5).join(" | ")).slice(0, 300)}`;
    }
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const res = await runner.run({
    // Eski rapor kalırsa düşen araç "temiz" görünürdü.
    command: `mkdir -p ${shellQuote(reportDir)} && rm -f ${shellQuote(reportPath)} && { ${step.run}\n}`,
    cwd: opts.worktree, env, timeoutMs,
    onLine: (s, l) => {
      if (s === "stdout") { if (stdout.length < MAX_LOG_LINES) stdout.push(l); } else stderr.push(l);
      opts.onLine?.(s, l);
    },
  });
  const tail = (): string => scrubSecrets([...stderr.slice(-10), ...stdout.slice(-5)].join("\n")).slice(0, 1500);
  const done = (findings: StaticFinding[]): StaticOutcome => ({
    ok: true,
    findings: dedupeFindings(atLeast(findings, step.minLevel)),
    ...(fixNote ? { fixNote } : {}),
  });

  if (res.timedOut) return { ok: false, reason: `${step.timeoutMinutes} dk içinde bitmedi` };
  if (res.exitCode === 127) return { ok: false, reason: `komut bulunamadı (çıkış 127) — araç konteynerde kurulu mu? ${tail()}` };

  if (step.report.format === "msbuild-log") {
    const findings = parseMsbuildLog([...stdout, ...stderr]);
    // Çıkış ≠ 0 ve tek `error` bile ayrıştırılamadıysa derleme bulgu
    // dışında bir sebeple düştü (restore, SDK); "temiz" sayılmamalı.
    if (res.exitCode !== 0 && !findings.some((f) => f.level === "error")) {
      return { ok: false, reason: `derleme düştü (çıkış ${res.exitCode ?? "?"}), bulgu ayrıştırılamadı: ${tail()}` };
    }
    return done(findings);
  }

  // Bulgu varken araçların çoğu ≠ 0 döner (`--verify-no-changes`, `--error`);
  // belirleyici olan raporun yazılmış olması.
  const content: string[] = [];
  const cat = await opts.exec.run({
    command: `cat -- ${shellQuote(reportPath)}`, cwd: opts.worktree, env: {}, timeoutMs: 60_000,
    onLine: (s, l) => { if (s === "stdout") content.push(l); },
  });
  if (cat.exitCode !== 0) return { ok: false, reason: `rapor yazılmadı (çıkış ${res.exitCode ?? "?"}): ${tail() || "(çıktı boş)"}` };

  let raw: unknown;
  try {
    raw = JSON.parse(content.join("\n"));
  } catch {
    return { ok: false, reason: `rapor JSON değil: ${scrubSecrets(content.join("\n")).slice(0, 300)}` };
  }
  try {
    return done(step.report.format === "sarif" ? parseSarif(raw) : parseDotnetFormat(raw));
  } catch (err) {
    return { ok: false, reason: `rapor şemaya uymuyor: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` };
  }
}

/**
 * Aracın yazdığı yolu worktree'ye göreli yapar. Roslyn ve dotnet-format
 * mutlak yol, SARIF `file://` URI'si yazar; OpenGrep zaten göreli.
 */
export function relativePath(path: string, roots: readonly string[]): string {
  let p = path;
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.slice("file://".length);
    }
  }
  p = p.replaceAll("\\", "/");
  for (const r of roots) {
    const root = r.replaceAll("\\", "/").replace(/\/+$/, "");
    if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  return p.replace(/^\.\//, "");
}

/**
 * Bulguları bot başlıklarıyla AYNI biçime çevirir: Developer'a giden düzeltme
 * yolu (`runDevOps`) tek kalsın.
 *
 * Gövde maskelenir (kural 4): sır kuralları bulduğu sırrı mesaja yazar.
 */
export function staticThreads(stepId: string, findings: readonly StaticFinding[], roots: readonly string[]): ReviewThread[] {
  return findings.map((f) => {
    const path = relativePath(f.path, roots);
    const id = createHash("sha1").update(`${stepId}\0${path}\0${f.line ?? ""}\0${f.rule}`).digest("hex").slice(0, 16);
    return {
      id: `static:${stepId}:${id}`,
      author: stepId,
      path,
      line: f.line,
      body: scrubSecrets(`[${f.rule}] ${f.message}`).slice(0, 4000),
      severity: f.level === "error" ? "major" as const : "minor" as const,
    };
  });
}

/**
 * İmajlı adım yürütücüsü: her komut `docker run --rm` ile, iş volume'ü iş
 * konteynerindeki AYNI yola bağlanarak koşar — worktree yolu iki tarafta
 * aynı kalır, rapor iş konteynerinden okunabilir.
 *
 * Kullanıcı iş konteyneriyle aynı (`user`): root yazarsa iş konteyneri
 * (node) dosyaları commit'leyemez, git düşer.
 */
export function imageExecutor(opts: {
  docker: DockerRun;
  image: string;
  volume: string;
  /** Volume'ün iş konteynerindeki bağlama yolu (`exec.workdir`). */
  root: string;
  /** `uid:gid`. */
  user: string;
  name: string;
  log: (line: string) => void;
}): CommandExecutor {
  let pulled = false;
  return {
    async run(req: ExecRequest): Promise<ExecResult> {
      const started = Date.now();
      if (!pulled) {
        if (!(await ensureImage(opts.docker, opts.image, opts.log))) {
          req.onLine("stderr", `imaj çekilemedi: ${opts.image}`);
          return { exitCode: 127, durationMs: Date.now() - started, timedOut: false };
        }
        pulled = true;
      }
      await opts.docker(["rm", "-f", opts.name], 60_000);
      const res = await opts.docker([
        "run", "--rm", "--name", opts.name,
        "-v", `${opts.volume}:${opts.root}`, "-w", req.cwd, "--user", opts.user,
        // Root olmayan kullanıcının HOME'u imajda yazılamayabilir.
        "-e", "HOME=/tmp",
        ...Object.entries(req.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "--entrypoint", "sh", opts.image, "-c", req.command,
      ], req.timeoutMs);
      if (res.timedOut) await opts.docker(["rm", "-f", opts.name], 60_000);
      for (const [stream, text] of [["stdout", res.stdout], ["stderr", res.stderr]] as const) {
        const split = new LineSplitter((line) => req.onLine(stream, line));
        split.push(text);
        split.flush();
      }
      return { exitCode: res.code, durationMs: Date.now() - started, timedOut: res.timedOut };
    },
  };
}
