import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CodeMapSchema, type CodeMap, type CodeMapModule } from "@ahtapot/shared";

/**
 * Kod haritasının diskteki hâli (karar §35).
 *
 * `<artifactsDir>/codemap/<projectId>/` — hedef workspace'e ASLA yazılmaz.
 * Dizin konteynere salt okunur bağlı olduğundan YERİNDE güncellenir:
 * dizinin kendisi silinip yeniden yaratılırsa ayaktaki konteynerin bind'i
 * eski (silinmiş) inode'a bakar ve haritayı boş görür.
 */

export function codeMapDir(artifactsDir: string, projectId: string): string {
  return join(artifactsDir, "codemap", projectId);
}

export function readCodeMap(dir: string): CodeMap | null {
  const file = join(dir, "map.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = CodeMapSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** JSON'u ve ondan üretilen markdown'ı yazar; artık olmayan modüllerin dosyası silinir. */
export function writeCodeMap(dir: string, map: CodeMap, title: string): void {
  const modulesDir = join(dir, "modules");
  mkdirSync(modulesDir, { recursive: true });
  // Dosya başına geçici ad + rename: agent yarım yazılmış bir künye okumasın.
  const put = (path: string, body: string) => {
    writeFileSync(`${path}.tmp`, body, "utf8");
    renameSync(`${path}.tmp`, path);
  };
  const usedBy = reverseDeps(map.modules);
  for (const m of map.modules) put(join(modulesDir, `${m.id}.md`), renderModule(m, usedBy.get(m.id) ?? []));
  const keep = new Set(map.modules.map((m) => `${m.id}.md`));
  for (const f of readdirSync(modulesDir)) {
    if (f.endsWith(".md") && !keep.has(f)) rmSync(join(modulesDir, f), { force: true });
  }
  put(join(dir, "INDEX.md"), renderIndex(map, title));
  // JSON en son: okuyan taraf için "harita var" demek markdown'ın da hazır olması demek.
  put(join(dir, "map.json"), `${JSON.stringify(map, null, 2)}\n`);
}

function reverseDeps(modules: readonly CodeMapModule[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of modules) {
    for (const d of m.dependsOn) out.set(d, [...(out.get(d) ?? []), m.id]);
  }
  return out;
}

export function renderIndex(map: CodeMap, title: string): string {
  const lines: string[] = [];
  lines.push(`# Kod haritası — ${title}`);
  lines.push("");
  lines.push(`Commit: ${Object.entries(map.commits).map(([r, s]) => `${r}@${s.slice(0, 8)}`).join(", ") || "?"} · güncellendi ${map.generatedAt}`);
  lines.push("");
  lines.push("İşinle ilgili modülün künyesini aç: `modules/<id>.md`. Gerisini açma.");
  lines.push("Künye yön gösterir; kodla çelişirse **kod kazanır**. [BAYAT] künyenin dizininde, künye üretildikten sonra değişiklik olmuş demek.");
  lines.push("");
  const byRepo = new Map<string, CodeMapModule[]>();
  for (const m of map.modules) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m]);
  for (const [repo, mods] of byRepo) {
    lines.push(`## ${repo}`);
    for (const m of [...mods].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- \`${m.id}\` — ${m.purpose} · ${m.paths.join(", ")}${m.stale.length ? " [BAYAT]" : ""}`);
    }
    lines.push("");
  }
  if (map.unmapped.length > 0) {
    lines.push("## Haritada olmayan değişiklikler");
    lines.push("Hiçbir modülün dizinine düşmeyen, künye üretildikten sonra değişmiş dosyalar (yeni modül olabilir):");
    for (const f of map.unmapped.slice(0, 30)) lines.push(`- ${f}`);
    if (map.unmapped.length > 30) lines.push(`- … ve ${map.unmapped.length - 30} dosya daha`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderModule(m: CodeMapModule, usedBy: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`# ${m.name} (\`${m.id}\`)`);
  lines.push("");
  lines.push(m.purpose);
  lines.push("");
  lines.push(`Repo: ${m.repo} · Dizinler: ${m.paths.join(", ")} · Commit: ${m.sha ? m.sha.slice(0, 8) : "?"}`);
  if (m.stale.length > 0) {
    lines.push("");
    lines.push("> **BAYAT** — bu künye üretildikten sonra şu dosyalar değişti. Bunlara dair bilgiyi kodda doğrula:");
    for (const f of m.stale.slice(0, 20)) lines.push(`> - ${f}`);
    if (m.stale.length > 20) lines.push(`> - … ve ${m.stale.length - 20} dosya daha`);
  }
  const section = (heading: string, items: readonly string[]) => {
    if (items.length === 0) return;
    lines.push("", `## ${heading}`);
    for (const i of items) lines.push(`- ${i}`);
  };
  section("Kilit dosyalar", m.keyFiles.map((f) => (f.role ? `\`${f.path}\` — ${f.role}` : `\`${f.path}\``)));
  section("Giriş noktaları", m.entryPoints);
  section("Sözleşmeler (dokunursan başka katmanlar etkilenir)", m.contracts);
  section("Entity / tablolar", m.entities);
  section("API uçları", m.endpoints);
  section("Bağımlı olduğu modüller", m.dependsOn.map((d) => `\`${d}\``));
  section("Onu kullanan modüller", usedBy.map((d) => `\`${d}\``));
  section("Tuzaklar", m.pitfalls);
  lines.push("");
  return lines.join("\n");
}

/** `path` modülün dizinlerinden birinin altında mı? */
export function inModule(m: CodeMapModule, path: string): boolean {
  return m.paths.some((p) => {
    const pre = p.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
    return pre === "" || path === pre || path.startsWith(`${pre}/`);
  });
}
