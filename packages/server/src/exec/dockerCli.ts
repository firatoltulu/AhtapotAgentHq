import { execFile } from "node:child_process";

/**
 * `docker` CLI'ını tek seferlik konteynerler için koşturur (DAST tarayıcıları,
 * imajlı statik adımlar). dockerode yerine CLI: çekme ve `run --rm` akışı
 * CLI'da tek komut, compose da zaten CLI istiyor (`live/environment.ts`).
 * Fırlatmaz; çıkış kodu ve çıktı döner.
 */
export interface DockerRun {
  (args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

export const defaultDockerRun: DockerRun = (args, timeoutMs) => new Promise((resolve) => {
  execFile("docker", args, { encoding: "utf8", maxBuffer: 64_000_000, timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
    if (e?.code === "ENOENT") {
      resolve({ code: 127, stdout: "", stderr: "`docker` komutu sunucunun PATH'inde yok", timedOut: false });
      return;
    }
    resolve({
      code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      timedOut: Boolean(e?.killed),
    });
  });
});

const PULL_TIMEOUT_MS = 15 * 60_000;

/** İmaj yerelde yoksa çeker. Tarayıcı/araç konteynerleri iç ağda çekemez. */
export async function ensureImage(docker: DockerRun, image: string, log: (l: string) => void): Promise<boolean> {
  if ((await docker(["image", "inspect", "--format", "{{.Id}}", image], 60_000)).code === 0) return true;
  log(`▶ imaj çekiliyor: ${image}`);
  return (await docker(["pull", "--quiet", image], PULL_TIMEOUT_MS)).code === 0;
}
