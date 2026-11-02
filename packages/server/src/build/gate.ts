import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join, matchesGlob, sep } from "node:path";

import {
  scrubSecrets,
  type BuildResult,
  type Command,
  type BuildStep,
  type ProjectProfile,
} from "@ahtapot/shared";

import { isoNow, newId, type Db, schema } from "../db/index.js";
import type { EventHub } from "../ws/hub.js";
import { elapsed } from "./elapsed.js";
import { execGit, type CommandExecutor } from "./executor.js";


/**
 * Build kapısı.
 *
 * Profilin `build` bölümünü uygular; yorum yapmaz:
 *
 *  1. YASAK BAYRAK: komutta `forbiddenFlags`tan biri geçiyorsa hiçbir şey
 *     koşmaz. Northwind'de `-c Release` private NuGet'e düşüp 401 döner — bu bir
 *     kısıt, tercih değil.
 *  2. ÖN ADIMLAR her zaman koşar (appsettings şablonu, host durdurma).
 *  3. ADIM SEÇİMİ: "derleme yalnızca dokunulan katmanda". `whenChanged`
 *     tutmayan adım atlanır; `exceptPaths` tutuyorsa yine koşar — kaynak
 *     metnini okuyan sözleşme testleri dil sınırını aşar.
 *  4. SIRA profil sırasıdır. Northwind'de npm → dotnet; ters sırada publish
 *     yeşil ama panel ekransız.
 *  5. LOG satır satır maskelenir; hem UI'a akar hem dosyaya yazılır.
 */

export class ForbiddenFlagError extends Error {
  constructor(readonly stepName: string, readonly flag: string) {
    super(`yasak bayrak: "${flag}" (adım: ${stepName})`);
    this.name = "ForbiddenFlagError";
  }
}

/** Komut bayrağı taşıyor mu? Sözcük sınırıyla: "-c Release" ≠ "-c ReleaseNotes". */
export function containsFlag(command: string, flag: string): boolean {
  const norm = command.replace(/\s+/g, " ");
  const f = flag.trim().replace(/\s+/g, " ");
  if (!f) return false;
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${esc}(?=\\s|$)`, "i").test(norm);
}

/** Bütün komutlarda (ön adımlar dâhil) yasak bayrak arar; ilk ihlali fırlatır. */
export function assertNoForbiddenFlags(build: ProjectProfile["build"]): void {
  const all: Command[] = [...build.preSteps, ...build.steps];
  for (const step of all) {
    for (const flag of build.forbiddenFlags) {
      if (containsFlag(step.run, flag)) throw new ForbiddenFlagError(step.name, flag);
    }
  }
}

export interface StepDecision {
  step: BuildStep;
  run: boolean;
  reason: string;
}

function anyMatch(files: readonly string[], globs: readonly string[]): string | null {
  for (const f of files) {
    const norm = f.split(sep).join("/");
    for (const g of globs) if (matchesGlob(norm, g)) return norm;
  }
  return null;
}

/**
 * Hangi adımlar koşacak?
 *
 * `changedFiles` boş liste (hiç değişiklik yok) → koşullu adımlar atlanır;
 * `null` (değişiklik BİLİNMİYOR) → hepsi koşar. Bilinmeyen değişiklikte
 * atlamak sessiz bozuk çıktı üretir; fazla koşmak yalnız zaman kaybettirir.
 */
export function selectSteps(
  build: ProjectProfile["build"],
  changedFiles: readonly string[] | null,
): StepDecision[] {
  return build.steps.map((step) => {
    if (step.whenChanged.length === 0) return { step, run: true, reason: "koşulsuz" };
    if (changedFiles === null) return { step, run: true, reason: "değişiklik bilinmiyor" };
    const hit = anyMatch(changedFiles, step.whenChanged);
    if (hit) return { step, run: true, reason: `değişti: ${hit}` };
    const except = anyMatch(changedFiles, step.exceptPaths);
    if (except) return { step, run: true, reason: `istisna: ${except}` };
    return { step, run: false, reason: "dokunulmadı" };
  });
}

/**
 * Worktree'de değişen dosyalar: `baseRef`e göre commit'li fark + çalışma
 * ağacındaki takipsiz/değişmiş dosyalar. Agent commit atmadan da derleme
 * gerekir; bu yüzden yalnız `git diff` yetmez.
 */
export async function changedFiles(
  exec: CommandExecutor,
  worktree: string,
  baseRef: string,
): Promise<string[]> {
  const set = new Set<string>();
  // baseRef yoksa (ilk commit) git düşer; o durumda yalnız çalışma ağacına bakılır.
  const diff = await execGit(exec, worktree, ["diff", "--name-only", `${baseRef}...HEAD`], { allowFailure: true });
  for (const l of diff.split("\n")) if (l.trim()) set.add(l.trim());
  const status = await execGit(exec, worktree, ["status", "--porcelain", "--untracked-files=all"]);
  for (const l of status.split("\n")) {
    const p = l.slice(3).trim();
    if (!p) continue;
    // Yeniden adlandırma: "eski -> yeni".
    set.add(p.includes(" -> ") ? p.split(" -> ")[1]!.trim() : p);
  }
  return [...set].sort();
}

/**
 * `baseRef...HEAD` aralığında EKLENEN/değişen satırlar, dosya başına.
 *
 * Yalnız commit'li fark: statik analiz QA testleri commit'lendikten sonra
 * koşar. Satır kapsamı eski borcu (dokunulmamış satırdaki uyarı) işin
 * kusurundan ayırır. Fark alınamazsa `null` — çağıran süzmez.
 */
export async function changedLines(
  exec: CommandExecutor,
  worktree: string,
  baseRef: string,
): Promise<Map<string, Set<number>> | null> {
  let diff: string;
  try {
    diff = await execGit(exec, worktree, ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", `${baseRef}...HEAD`]);
  } catch {
    return null;
  }
  return parseDiffLines(diff);
}

/** `git diff -U0` çıktısından eklenen satır numaraları. Silinen dosya atlanır. */
export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).trim();
      if (p === "/dev/null") { current = null; continue; }
      const path = p.startsWith("b/") ? p.slice(2) : p;
      current = out.get(path) ?? new Set<number>();
      out.set(path, current);
      continue;
    }
    if (!current || !l.startsWith("@@")) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) current.add(start + i);
  }
  return out;
}

export interface BuildRunInput {
  jobId: string;
  phaseId?: string | null;
  profile: ProjectProfile;
  /** Worktree kökü (yürütücünün gördüğü yol — host ya da konteyner). */
  workdir: string;
  changedFiles: readonly string[] | null;
  executor: CommandExecutor;
  /** Log dosyaları buraya: `<artifactsDir>/<jobId>/build-<buildId>.log`. */
  artifactsDir: string;
}

export interface BuildRunOutput {
  ok: boolean;
  results: BuildResult[];
  decisions: StepDecision[];
}

export class BuildGate {
  constructor(
    private readonly db: Db,
    private readonly hub: EventHub | null,
  ) {}

  /**
   * Kapıyı koşturur. Yasak bayrak varsa HİÇBİR komut çalışmadan fırlatır.
   * Ön adım düşerse durur; adım düşerse `failureIsBlocking`e göre durur.
   */
  async run(input: BuildRunInput): Promise<BuildRunOutput> {
    const { profile } = input;
    assertNoForbiddenFlags(profile.build);

    const decisions = selectSteps(profile.build, input.changedFiles);
    const results: BuildResult[] = [];

    for (const pre of profile.build.preSteps) {
      const r = await this.runCommand(input, pre);
      results.push(r);
      if (r.exitCode !== 0 && !pre.optional) return { ok: false, results, decisions };
    }

    for (const d of decisions) {
      if (!d.run) {
        results.push(this.recordSkip(input, d));
        continue;
      }
      const r = await this.runCommand(input, d.step);
      results.push(r);
      if (r.exitCode !== 0 && !d.step.optional && profile.build.failureIsBlocking) {
        return { ok: false, results, decisions };
      }
    }

    const ok = results.every((r) => r.skipped || r.exitCode === 0 || isOptional(profile, r.stepName));
    return { ok, results, decisions };
  }

  private recordSkip(input: BuildRunInput, d: StepDecision): BuildResult {
    this.db
      .insert(schema.builds)
      .values({
        id: newId(),
        jobId: input.jobId,
        phaseId: input.phaseId ?? null,
        stepName: d.step.name,
        command: scrubSecrets(d.step.run),
        skipped: true,
        skipReason: d.reason,
        exitCode: null,
      })
      .run();
    this.hub?.publish(input.jobId, {
      type: "build.log",
      stream: "stdout",
      line: `▷ ${d.step.name}: atlandı (${d.reason})`,
    });
    return { stepName: d.step.name, skipped: true, skipReason: d.reason, exitCode: null, durationMs: 0, logRef: "" };
  }

  private async runCommand(input: BuildRunInput, cmd: Command): Promise<BuildResult> {
    const buildId = newId();
    const dir = join(input.artifactsDir, input.jobId);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `build-${buildId}.log`);
    const file = createWriteStream(logPath, { encoding: "utf8" });
    // Dosya tamamen yazılmadan logRef dönmesin: tüketici eksik log görür.
    const flushed = new Promise<void>((resolve, reject) => {
      file.on("finish", resolve);
      file.on("error", reject);
    });

    // Komutun kendisi de sır taşıyabilir (satır içi token); olaya ve DB'ye maskeli gider.
    const shownCommand = scrubSecrets(cmd.run);
    this.hub?.publish(input.jobId, { type: "build.log", stream: "stdout", line: `▶ ${cmd.name}: ${shownCommand}` });

    // Zaman damgası hem dosyaya hem UI'a. Build kırmızı döndüğünde ya da koşu
    // yarıda kaldığında sorulan ilk soru "nerede asıldı" oluyor; damgasız log
    // bunu söylemiyor — "added 159 packages in 2m" gibi satırlar dışında hiçbir
    // zaman bilgisi kalmıyor ve 60+ satırlık bir logda hangi adımın kaç dakika
    // sürdüğü okunamıyor (yaşandı).
    const startedAt = Date.now();
    file.write(`=== ${cmd.name} | ${isoNow()} | ${shownCommand}\n`);

    const cwd = cmd.cwd === "." ? input.workdir : `${input.workdir}/${cmd.cwd}`.replace(/\/+/g, "/");
    const result = await input.executor.run({
      command: cmd.run,
      cwd,
      env: cmd.env,
      timeoutMs: cmd.timeoutMinutes * 60_000,
      onLine: (stream, raw) => {
        // Maskeleme burada — dosyaya da UI'a da aynı maskeli satır gider.
        const line = scrubSecrets(raw);
        // Mutlak saat değil GEÇEN SÜRE: bir adımın neresinin yavaş olduğunu
        // okumak için saat farkı hesaplamak gerekmesin.
        const since = elapsed(startedAt);
        file.write(`[${since}] ${line}\n`);
        this.hub?.publish(input.jobId, { type: "build.log", stream, line, elapsed: since });
      },
    });

    const status = result.timedOut ? "zaman aşımı" : `çıkış ${result.exitCode}`;
    file.end(`--- ${cmd.name}: ${status}, ${result.durationMs} ms | bitiş ${isoNow()}\n`);
    await flushed;
    this.hub?.publish(input.jobId, {
      type: "build.log",
      stream: result.exitCode === 0 ? "stdout" : "stderr",
      line: `■ ${cmd.name}: ${status} (${(result.durationMs / 1000).toFixed(1)} s)`,
    });

    this.db
      .insert(schema.builds)
      .values({
        id: buildId,
        jobId: input.jobId,
        phaseId: input.phaseId ?? null,
        stepName: cmd.name,
        command: shownCommand,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logRef: logPath,
      })
      .run();

    return {
      stepName: cmd.name,
      skipped: false,
      skipReason: "",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      logRef: logPath,
    };
  }
}

function isOptional(profile: ProjectProfile, stepName: string): boolean {
  return [...profile.build.preSteps, ...profile.build.steps].some((s) => s.name === stepName && s.optional);
}
