import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Workspace mekanik taraması.
 *
 * Analyst agent'ın GÖZÜ. Burada yorum yok, yalnız ölçüm: hangi repolar var,
 * hangi dosyalar büyük, hangi yollar gitignore'lu ama gerçek. Yorumu (build
 * komutu ne olmalı, hangi test konteynerde koşar) agent yapar; bu katman ona
 * güvenilir bir zemin verir.
 *
 * Ayrım önemli: mekanik olarak bulunabilen şeyi modele sordurmak hem pahalı
 * hem güvenilmezdir.
 */

const SKIP_DIRS = new Set([
  "node_modules", ".git", "bin", "obj", "dist", "build", ".vs", ".vscode",
  "packages", "TestResults", ".idea",
]);

/** Bağlamı patlatacak kadar büyük sayılan dosya eşiği. */
const OVERSIZED_BYTES = 100_000;

export interface RepoInfo {
  name: string;
  /** Workspace köküne göreli. Kök reponun kendisi ise ".". */
  path: string;
  remote: string | null;
  defaultBranch: string;
  /** Kök repo tarafından yok sayılan iç içe repo (submodule DEĞİL). */
  nested: boolean;
}

export interface ScanResult {
  root: string;
  rootIsRepo: boolean;
  repos: RepoInfo[];
  /** Kök repo tarafından ignore edilen ama diskte var olan yollar. */
  ignoredButPresent: string[];
  /** 100 KB üstü metin dosyaları — agent'a ham verilmemeli. */
  oversizedFiles: { path: string; bytes: number }[];
  /** Build/test/çalıştırma için ipucu veren dosyalar. */
  markers: {
    solutions: string[];
    packageJsons: string[];
    dockerfiles: string[];
    composeFiles: string[];
    ciWorkflows: string[];
    /**
     * GitHub Actions DIŞI CI/CD tanımları (Jenkins, GitLab, Azure Pipelines).
     *
     * Ayrı marker: bu dosyalar "bu proje nasıl build/test edilir" sorusunun
     * en güvenilir cevabıdır (README bayatlar, kırmızı yanan pipeline
     * düzeltilir) ve Analyst'e önce bunlara bakması söylenir. Yalnız VARLIK
     * tespiti — içerik ayrıştırması agent'ın işi.
     */
    ciFiles: string[];
    scripts: string[];
    docs: string[];
  };
  /** Yapısal imza — profil bayatlığı bununla anlaşılır. */
  fingerprint: Record<string, string>;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Reponun varsayılan dalını tespit eder.
 *
 * SABİT VARSAYILMAZ: Northwind "main", AdventureWorks "master" kullanıyor ve aynı
 * workspace içinde bile repodan repoya değişebiliyor. Uzak HEAD yoksa yerel
 * dala düşülür.
 */
function detectDefaultBranch(repoPath: string): string {
  const head = git(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head) {
    const parts = head.split("/");
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  const current = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current || "main";
}

function isRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Dizin ağacında sınırlı derinlikte dolaşır. */
function walk(
  dir: string,
  depth: number,
  visit: (fullPath: string, isDir: boolean) => void,
): void {
  if (depth < 0) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      visit(full, true);
      walk(full, depth - 1, visit);
    } else {
      visit(full, false);
    }
  }
}

/**
 * `git check-ignore` ile gitignore'lu ama diskte var olan yolları bulur.
 *
 * Bu sınıf `git worktree add` sırasında KAYBOLUR. Northwind'de `plans/` ve `docs/`
 * agent'ın plan bağlamını taşıyor, `.run/` ise canlı JWT token — biri
 * kopyalanmalı, diğeri asla. Ayrımı insan yapar; tarama yalnız adayları sunar.
 */
function findIgnoredButPresent(root: string): string[] {
  if (!isRepo(root)) return [];
  const candidates: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (e.name === ".git") continue;
    candidates.push(e.isDirectory() ? `${e.name}/` : e.name);
  }
  if (candidates.length === 0) return [];

  try {
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: root,
      input: candidates.join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // check-ignore hiçbir eşleşme bulamazsa 1 ile çıkar — hata değil.
    return [];
  }
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function scanWorkspace(rootInput: string, maxDepth = 3): ScanResult {
  const root = resolve(rootInput);
  if (!existsSync(root)) throw new Error(`workspace bulunamadı: ${root}`);

  const rootIsRepo = isRepo(root);
  const repos: RepoInfo[] = [];
  const ignored = new Set(findIgnoredButPresent(root));

  if (rootIsRepo) {
    repos.push({
      name: root.split(sep).filter(Boolean).pop() ?? "root",
      path: ".",
      remote: git(root, ["remote", "get-url", "origin"]) || null,
      defaultBranch: detectDefaultBranch(root),
      nested: false,
    });
  }

  const markers: ScanResult["markers"] = {
    solutions: [], packageJsons: [], dockerfiles: [], composeFiles: [],
    ciWorkflows: [], ciFiles: [], scripts: [], docs: [],
  };
  const oversized: ScanResult["oversizedFiles"] = [];

  walk(root, maxDepth, (full, isDir) => {
    const rel = relative(root, full).split(sep).join("/");

    if (isDir) {
      if (!isRepo(full)) return;
      // Kök repo bunu yok sayıyorsa NESTED REPO'dur, submodule değil:
      // worktree'ye taşınmaz ve `git clean -xfd` içeriğini siler.
      const nested = rootIsRepo && [...ignored].some((i) => rel.startsWith(i.replace(/\/$/, "")));
      repos.push({
        name: rel.split("/").pop() ?? rel,
        path: rel,
        remote: git(full, ["remote", "get-url", "origin"]) || null,
        defaultBranch: detectDefaultBranch(full),
        nested,
      });
      return;
    }

    const base = rel.split("/").pop() ?? "";
    const lower = base.toLowerCase();

    if (/\.(sln|slnx)$/i.test(base)) markers.solutions.push(rel);
    else if (base === "package.json") markers.packageJsons.push(rel);
    else if (lower.startsWith("dockerfile")) markers.dockerfiles.push(rel);
    else if (/^docker-compose.*\.ya?ml$/i.test(base)) markers.composeFiles.push(rel);
    else if (rel.startsWith(".github/workflows/")) markers.ciWorkflows.push(rel);
    // GitHub Actions dışı CI tanımları. `Jenkinsfile` uzantısız olduğu için
    // `scripts` zincirine takılmaz, ama `.gitlab-ci.yml` compose kontrolünden
    // SONRA gelmeli — sıra bu yüzden bağlayıcı.
    else if (/^(Jenkinsfile|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml)$/i.test(base)) markers.ciFiles.push(rel);
    else if (/\.(ps1|sh|cmd|bat)$/i.test(base)) markers.scripts.push(rel);
    else if (/^(claude|agents|readme|contributing)\.md$/i.test(base)) markers.docs.push(rel);

    if (/\.(md|json|ya?ml|ps1|txt|editorconfig)$/i.test(base) || base === ".editorconfig") {
      try {
        const { size } = statSync(full);
        if (size > OVERSIZED_BYTES) oversized.push({ path: rel, bytes: size });
      } catch {
        /* erişilemeyen dosya taramayı durdurmaz */
      }
    }
  });

  // Yapısal imza: bu dosyalar değiştiğinde profil bayatlamış sayılır.
  const fingerprint: Record<string, string> = {};
  for (const rel of [...markers.solutions, ...markers.composeFiles, ...markers.docs]) {
    try {
      fingerprint[rel] = sha(readFileSync(join(root, rel), "utf8"));
    } catch {
      /* okunamayan dosya imzaya girmez */
    }
  }
  fingerprint["#repos"] = sha(repos.map((r) => `${r.path}@${r.defaultBranch}`).sort().join("|"));

  return {
    root,
    rootIsRepo,
    repos: repos.sort((a, b) => a.path.localeCompare(b.path)),
    ignoredButPresent: [...ignored].sort(),
    oversizedFiles: oversized.sort((a, b) => b.bytes - a.bytes),
    markers,
    fingerprint,
  };
}

/**
 * İki imzayı karşılaştırır: profil hâlâ geçerli mi?
 *
 * Eskiyen profil sessizce yanlış davranan bir sisteme yol açar — yeni bir repo
 * eklendiğinde ya da compose değiştiğinde UI uyarır, iş durdurulmaz.
 */
export function fingerprintDrift(
  before: Record<string, string>,
  after: Record<string, string>,
): { changed: string[]; added: string[]; removed: string[]; stale: boolean } {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push(k);
    else if (before[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) removed.push(k);
  }

  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    stale: changed.length > 0 || added.length > 0 || removed.length > 0,
  };
}
