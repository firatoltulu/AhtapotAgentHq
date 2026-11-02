import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Çalışan Ahtapot'un sürümü — UI üst çubuğunda ve `/health`te görünür.
 *
 * Kaynak repo kökündeki `version.txt`: yayın workflow'u (`docker-server.yml`)
 * build'den önce içine sürümü yazar, Dockerfile imaja kopyalar. Repoda `dev`
 * yer tutucusuyla durur — o zaman (geliştirme) `git describe`e düşülür; tag'in
 * kaç commit önünde olunduğunu da gösterir (`v1.14.4-3-gabc1234`). İkisi de
 * yoksa `dev`.
 *
 * package.json sürümleri KAYNAK DEĞİL: hepsi 0.1.0'da kaldı, tag'le eşlenmiyor.
 */
export function resolveAppVersion(): string {
  // dist/version.js → repo kökü üç seviye yukarıda (imajda /opt/ahtapot).
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  try {
    const fromFile = readFileSync(join(root, "version.txt"), "utf8").trim();
    if (fromFile && fromFile !== "dev") return fromFile;
  } catch {
    // Dosya yok: geliştirme ortamı, git'e düş.
  }
  try {
    const out = execFileSync("git", ["describe", "--tags", "--match", "v*", "--dirty"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    }).trim();
    if (out) return out;
  } catch {
    // git yok ya da tag yok: sessizce `dev`.
  }
  return "dev";
}
