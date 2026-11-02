import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type Dockerode from "dockerode";

/**
 * Komut yürütücü — build/test komutları nerede koşar?
 *
 * Kapı mantığı (adım seçimi, yasak bayrak, ön adımlar, log) yürütücüden
 * bağımsızdır. İki uygulama:
 *
 *  • HostExecutor: bu makinede kabuk. Testler ve yerel geliştirme.
 *  • ContainerExecutor: işin agent konteynerinde `docker exec`. Araç zinciri
 *    (dotnet, npm) orada; host'ta olması beklenmez.
 *
 * Çıktı SATIR SATIR verilir: çağıran maskeleyip akıtır. Tam çıktı bellekte
 * tutulmaz — Northwind'in `dotnet build` çıktısı megabaytlarca olabilir.
 */

export interface ExecRequest {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onLine(stream: "stdout" | "stderr", line: string): void;
}

export interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandExecutor {
  run(req: ExecRequest): Promise<ExecResult>;
}

/**
 * Kabuk tek tırnak kaçışı — yollar ve şablonlar kullanıcı/agent verisi taşır.
 *
 * Komutlar `sh -lc` ile koşuyor; kaçışsız birleştirme komut enjeksiyonudur.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Yürütücüde git koşturur, stdout döner, çıkış kodu sıfır değilse fırlatır.
 *
 * Worktree named volume'de yaşadığından git artık host'ta değil konteynerde
 * koşar (2026-09-17 taşıması). Çıktı bellekte toplanır: git'in buradaki
 * çıktıları kısa (dosya listesi, diff özeti) — build log'u bu yoldan geçmez.
 */
export async function execGit(
  exec: CommandExecutor,
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<string> {
  const lines: string[] = [];
  const res = await exec.run({
    command: `git ${args.map(shellQuote).join(" ")}`,
    cwd,
    env: {},
    timeoutMs: opts.timeoutMs ?? 600_000,
    onLine: (_s, line) => {
      lines.push(line);
    },
  });
  const out = lines.join("\n");
  if (res.exitCode !== 0 && !opts.allowFailure) {
    throw new Error(`git düştü (${res.exitCode}): ${args.join(" ")}\n${out.slice(0, 2000)}`);
  }
  return out;
}

/** Akışı satırlara böler; son eksik satırı kapanışta boşaltır. */
export class LineSplitter {
  private rest = "";
  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: string): void {
    const text = this.rest + chunk;
    const parts = text.split(/\r?\n/);
    this.rest = parts.pop() ?? "";
    for (const p of parts) this.emit(p);
  }

  flush(): void {
    if (this.rest.length > 0) this.emit(this.rest);
    this.rest = "";
  }
}

/**
 * Windows'ta `sh` yolu — Git for Windows ile gelir.
 *
 * `spawn(..., { shell: "sh" })` PATH'te aramaz; tam yol gerekir. Bulunamazsa
 * `true` döner ve komut `cmd.exe`ye düşer: POSIX sözdizimi orada anlaşılmaz,
 * ama sessiz yanlış davranış yerine açık bir hata üretir.
 */
function findShOnWindows(): string | true {
  const candidates = [
    process.env["SHELL"],
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files (x86)\\Git\\bin\\sh.exe",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return true;
}

export class HostExecutor implements CommandExecutor {
  /**
   * `posix`: komutu Windows'ta da `sh` ile koşturur (Git Bash'ten).
   *
   * Worktree yönetimi POSIX sözdizimi üretiyor (`test -e`, `mkdir -p`,
   * `cp -a`) çünkü üretimde konteynerde koşuyor. Testler aynı kodu host'ta
   * koşturur; `cmd.exe` bu komutları anlamaz. Windows'ta git kuruluysa
   * `sh` de vardır — git'in kendisi onunla gelir.
   */
  constructor(private readonly posix = false) {}

  run(req: ExecRequest): Promise<ExecResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      // shell: Windows'ta cmd, Linux'ta sh — profil komutları kabuk sözdizimi taşır.
      const shell = this.posix && process.platform === "win32" ? findShOnWindows() : true;
      const child = spawn(req.command, {
        cwd: req.cwd,
        env: { ...process.env, ...req.env },
        shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const out = new LineSplitter((l) => req.onLine("stdout", l));
      const err = new LineSplitter((l) => req.onLine("stderr", l));
      child.stdout.setEncoding("utf8").on("data", (d: string) => out.push(d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => err.push(d));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, req.timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        out.flush();
        err.flush();
        resolve({ exitCode: code, durationMs: Date.now() - started, timedOut });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        req.onLine("stderr", `süreç başlatılamadı: ${e.message}`);
        resolve({ exitCode: null, durationMs: Date.now() - started, timedOut });
      });
    });
  }
}

/**
 * Konteyner içinde `sh -lc <komut>`.
 *
 * Docker exec akışı 8 baytlık çerçeve başlığıyla gelir (stdout/stderr
 * çoklanmış); burada ayrıştırılıp satırlara bölünür.
 *
 * Zaman aşımı: Docker API exec'i öldüremez. Komut ağacı benzersiz bir ortam
 * değişkeniyle (`AHTAPOT_EXEC_ID`) işaretlenir; çocuklar onu miras alır ve
 * yalnız o ağaç `/proc/<pid>/environ` üzerinden bulunup TERM alır.
 * Konteynerdeki agent ve köprü süreçlerine dokunulmaz.
 *
 * Docker'ın kendisi düşerse (exec/start reddi) hata FIRLATILMAZ: `exitCode:
 * null` + stderr satırı döner, kapı log dosyasını ve build kaydını yazabilir.
 */
export class ContainerExecutor implements CommandExecutor {
  constructor(private readonly container: Dockerode.Container) {}

  async run(req: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    const execId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    let exec: Dockerode.Exec;
    let stream: NodeJS.ReadWriteStream;
    try {
      exec = await this.container.exec({
        Cmd: ["sh", "-lc", req.command],
        WorkingDir: req.cwd,
        Env: [...Object.entries(req.env).map(([k, v]) => `${k}=${v}`), `AHTAPOT_EXEC_ID=${execId}`],
        AttachStdout: true,
        AttachStderr: true,
      });
      stream = (await exec.start({ hijack: true, stdin: false })) as unknown as NodeJS.ReadWriteStream;
    } catch (e) {
      req.onLine("stderr", `konteynerde komut başlatılamadı: ${e instanceof Error ? e.message : String(e)}`);
      return { exitCode: null, durationMs: Date.now() - started, timedOut: false };
    }

    const out = new LineSplitter((l) => req.onLine("stdout", l));
    const err = new LineSplitter((l) => req.onLine("stderr", l));
    let timedOut = false;

    const done = new Promise<void>((resolve) => {
      let pending = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          if (pending.length < 8) break;
          const kind = pending.readUInt8(0);
          const len = pending.readUInt32BE(4);
          if (pending.length < 8 + len) break;
          const text = pending.subarray(8, 8 + len).toString("utf8");
          (kind === 2 ? err : out).push(text);
          pending = pending.subarray(8 + len);
        }
      });
      // `destroy()` sonrası yalnız `close` gelir; `end` beklemek asılı bırakır.
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.on("error", () => resolve());
    });

    // Temizlik exec'i BEKLENİR: run() dönmeden ağaç TERM almış olmalı, yoksa
    // sonraki adım aynı çalışma ağacına yazan yarım süreçlerle çakışır.
    let cleanup: Promise<void> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      const killTree =
        `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx 'AHTAPOT_EXEC_ID=${execId}' && kill -TERM "\${p#/proc/}" 2>/dev/null; done; true`;
      cleanup = this.container
        .exec({ Cmd: ["sh", "-c", killTree], AttachStdout: true, AttachStderr: true })
        .then((k) => k.start({ hijack: true, stdin: false }))
        .then(
          (s) =>
            new Promise<void>((resolve) => {
              const ks = s as unknown as NodeJS.ReadableStream;
              ks.on("data", () => {});
              ks.on("end", () => resolve());
              ks.on("close", () => resolve());
              ks.on("error", () => resolve());
            }),
        )
        .catch(() => {});
      (stream as unknown as { destroy?: () => void }).destroy?.();
    }, req.timeoutMs);

    await done;
    clearTimeout(timer);
    if (cleanup) await cleanup;
    out.flush();
    err.flush();

    const info = await exec.inspect().catch(() => null);
    return {
      exitCode: timedOut ? null : (info?.ExitCode ?? null),
      durationMs: Date.now() - started,
      timedOut,
    };
  }
}
