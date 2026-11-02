import type { ReleaseBump } from "@ahtapot/shared";

/**
 * Release için gereken kadar semver: X.Y.Z karşılaştırma ve artırma.
 *
 * Ön sürüm (`-rc.1`) ve build metası (`+abc`) sürüm SAYILMAZ: zamanlı yayın
 * kararlı sürüm üretir, rc tag'ini "son sürüm" sanıp üstüne bump etmek
 * `1.3.0-rc.1` → `1.3.1` gibi atlamalar yapardı.
 */
export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const STRICT = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(s: string): Version | null {
  const m = STRICT.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function bumpVersion(v: Version, bump: ReleaseBump): Version {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

/** `v{version}` → tag ile eşleşen düzenli ifade; sürüm 1. grupta. */
function tagRegex(pattern: string): RegExp {
  const [head = "", tail = ""] = pattern.split("{version}");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc(head)}(.+)${esc(tail)}$`);
}

/** Desenin `{version}`dan önceki kısmı — GitHub'da tag'leri öneke göre süzmek için. */
export function tagPrefix(pattern: string): string {
  return pattern.split("{version}")[0] ?? "";
}

export function renderTag(pattern: string, v: Version): string {
  return pattern.replaceAll("{version}", formatVersion(v));
}

/** Desene uyan tag'ler arasından en büyük kararlı sürüm. */
export function latestVersion(tags: readonly string[], pattern: string): { tag: string; version: Version } | null {
  const re = tagRegex(pattern);
  let best: { tag: string; version: Version } | null = null;
  for (const tag of tags) {
    const raw = re.exec(tag)?.[1];
    const v = raw ? parseVersion(raw) : null;
    if (v && (!best || compareVersions(v, best.version) > 0)) best = { tag, version: v };
  }
  return best;
}

/**
 * Conventional commit başlıklarından bump: `type!:` ya da gövdede
 * `BREAKING CHANGE` → major, `feat` → minor, kalan her şey patch.
 *
 * Squash-merge'de commit mesajı PR başlığıdır; PR başlığı conventional değilse
 * patch'e düşer — yanlış yönde hata (fazla küçük sürüm) zararsız taraf.
 */
export function inferBump(messages: readonly string[]): ReleaseBump {
  let bump: ReleaseBump = "patch";
  for (const msg of messages) {
    const subject = msg.split("\n", 1)[0] ?? "";
    if (/^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(msg)) return "major";
    if (/^feat(\([^)]*\))?:/.test(subject)) bump = "minor";
  }
  return bump;
}
