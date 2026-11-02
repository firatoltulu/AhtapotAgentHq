import { basename, matchesGlob, sep } from "node:path";

import { BRAND, type ProjectProfile } from "@ahtapot/shared";

import type { CommandExecutor } from "../build/executor.js";
import type { Db } from "../db/index.js";
import { acquireLease, heldLeases, releaseLease } from "../resources/leases.js";

/**
 * Worktree yöneticisi — her işe kendi çalışma ağacı.
 *
 * Kaynak workspace'e DOKUNULMAZ. Repo başına bir bare mirror tutulur
 * (`<kök>/mirrors/<slug>/<repo>.git`), worktree'ler oradan açılır. Böylece
 * kullanıcının checkout'undaki yarım iş işe sızmaz, `git worktree list`
 * kirlenmez ve beş paralel iş aynı repodan beş dal açabilir.
 *
 * NEREDE KOŞAR: her şey `CommandExecutor` üzerinden. Üretimde bu konteynerdir
 * (`ContainerExecutor`) ve dosyalar named volume'de, ext4'te yaşar. Eskiden
 * worktree host'ta (Windows NTFS) durup konteynere bind ediliyordu; her dosya
 * erişimi NTFS → WSL2 (9p) → konteyner zincirini geçtiği için Northwind web
 * build'i 30 dakikaya çıkmıştı (ölçüldü 2026-09-17). Testler `HostExecutor`
 * ile koşar, böylece Docker olmadan da doğrulanabilir.
 *
 * Worktree'nin kör noktası: `git worktree add` yalnız takip edilen dosyaları
 * taşır. Gitignore'lu ama gerçek içerik yeni ağaçta HİÇ OLMAZ. Northwind'de
 * `plans/` agent'ın plan bağlamı, `.run/` ise canlı JWT — biri kopyalanmalı,
 * diğeri asla. Profil ayrımı yapar (`ignoredButNeeded` / `neverCopy`), burası
 * uygular; çakışmada `neverCopy` KAZANIR.
 */

/**
 * Mirror kilidi: fetch EXCLUSIVE, worktree add SHARED.
 *
 * Fetch sırasında ref'ler değişirken worktree açmak yarım ref'e denk gelebilir;
 * ama iki worktree aynı anda açılabilir. Süreç içi kilit yeterli — mirror'a
 * yalnız bu süreç dokunur.
 */
class MirrorLock {
  private readers = 0;
  private writer = false;
  private readonly waiters: (() => void)[] = [];

  private wake(): void {
    const all = this.waiters.splice(0);
    for (const w of all) w();
  }

  private wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  async shared<T>(fn: () => Promise<T>): Promise<T> {
    while (this.writer) await this.wait();
    this.readers++;
    try {
      return await fn();
    } finally {
      this.readers--;
      this.wake();
    }
  }

  /**
   * Süre dolarsa `null` döner — "alamazsa ATLA". Fetch'i beklemek yerine
   * mevcut mirror durumuyla devam etmek, işi kilitlemekten iyidir; bayat bir
   * dal zaten PR'da fark edilir.
   */
  async exclusive<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.writer || this.readers > 0) {
      if (Date.now() >= deadline) return null;
      await Promise.race([this.wait(), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
    }
    this.writer = true;
    try {
      return await fn();
    } finally {
      this.writer = false;
      this.wake();
    }
  }
}

export interface PrepareInput {
  jobId: string;
  profile: ProjectProfile;
  /** Dal adındaki `{slug}` — iş başlığından türetilmiş. */
  jobSlug: string;
  /** Materyalize edilecek repolar (profil `repos[].name`). Boşsa yalnız primary. */
  targetRepos?: string[];
  /** Fetch için en fazla bu kadar beklenir; sonra mirror olduğu gibi kullanılır. */
  fetchLockTimeoutMs?: number;
  /** Komutların koşacağı yer — konteyner (üretim) ya da host (test). */
  executor: CommandExecutor;
  /** İş dizininin kökü: konteynerde `/workspace`, testte geçici dizin. */
  root: string;
  /** Kaynak workspace'in yürütücüden görünen yolu (konteynerde `/source`). */
  sourceRoot: string;
}

export interface PreparedWorktree {
  repo: string;
  path: string;
  branch: string;
  mirror: string;
  /** Kaynaktan kopyalanan gitignore'lu yollar. */
  copied: string[];
  /** `neverCopy` yüzünden kopyalanMAyan adaylar — insan görsün. */
  refused: string[];
  /** Worktree'den silinen hassas dosyalar. */
  removed: string[];
  /** Fetch kilidi alınamadığı için atlandıysa true. */
  fetchSkipped: boolean;
  /** Dal bu çağrıda `defaultBranch`ten yaratıldıysa true; yeniden denemede false. */
  created: boolean;
}

/** Dal adı şablonu. `{jobId}` kısa tutulur: UUIDv7'nin rastgele kuyruğu. */
export function renderBranch(pattern: string, vars: { jobId: string; slug: string }): string {
  return pattern
    .replaceAll("{brand}", BRAND.slug)
    .replaceAll("{jobId}", vars.jobId.replace(/-/g, "").slice(-12))
    .replaceAll("{slug}", vars.slug);
}

/** İş başlığını dal adına uygun hâle getirir. */
export function slugify(input: string, max = 40): string {
  const s = input
    .toLowerCase()
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "is";
}

/** Glob meta karakteri taşıyor mu? Taşımıyorsa düz yol olarak ele alınır. */
function isGlob(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

/** `plans/`, `.run/**`, `**\/appsettings.json` — üçünü de göreli yola eşler. */
function matchesAny(rel: string, patterns: readonly string[]): boolean {
  const norm = rel.split(sep).join("/");
  for (const raw of patterns) {
    const pat = raw.replace(/\/$/, "");
    if (matchesGlob(norm, pat)) return true;
    // `.run/**` dizinin kendisiyle eşleşmez; kökü de kapsayalım.
    const base = pat.replace(/\/\*\*$/, "");
    if (!isGlob(base) && (norm === base || norm.startsWith(`${base}/`))) return true;
  }
  return false;
}

/**
 * Kabuk tek tırnak kaçışı.
 *
 * Yollar ve desenler profil belgesinden geliyor; boşluk, tırnak ya da `$`
 * taşıyabilir. Yürütücü komutu `sh -lc` ile koşuyor — kaçışsız birleştirme
 * komut enjeksiyonudur, üstelik profili agent üretiyor.
 */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Yürütücüden görünen yol birleştirme — daima POSIX, host `sep`'i karışmaz. */
function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((p) => p.length > 0)
    .join("/");
}

/** Komut sonucu: çıkış kodu + toplanmış çıktı. */
interface RunOutcome {
  code: number | null;
  out: string;
}

export class WorktreeManager {
  private readonly locks = new Map<string, MirrorLock>();

  constructor(private readonly db: Db) {}

  private lockFor(mirror: string): MirrorLock {
    let l = this.locks.get(mirror);
    if (!l) {
      l = new MirrorLock();
      this.locks.set(mirror, l);
    }
    return l;
  }

  /**
   * Yürütücüde kabuk komutu koşar ve çıktıyı toplar.
   *
   * Çıktı burada bellekte tutuluyor — build log'unun aksine bunlar kısa
   * (dosya listesi, ref adı). Uzun çıktı üreten tek komut `git clone`, o da
   * `--quiet` ile susturulmuş.
   */
  private async run(exec: CommandExecutor, cwd: string, command: string, timeoutMs = 600_000): Promise<RunOutcome> {
    const lines: string[] = [];
    const res = await exec.run({
      command,
      cwd,
      env: {},
      timeoutMs,
      onLine: (_stream, line) => {
        lines.push(line);
      },
    });
    return { code: res.exitCode, out: lines.join("\n").trim() };
  }

  /** Koşar, çıkış kodu sıfır değilse fırlatır. */
  private async must(exec: CommandExecutor, cwd: string, command: string, timeoutMs?: number): Promise<string> {
    const r = await this.run(exec, cwd, command, timeoutMs);
    if (r.code !== 0) throw new Error(`komut düştü (${r.code}): ${command}\n${r.out}`);
    return r.out;
  }

  private async git(exec: CommandExecutor, cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    return this.must(exec, cwd, `git ${args.map(q).join(" ")}`, timeoutMs);
  }

  /** Yürütücüde dosya/dizin var mı? */
  private async exists(exec: CommandExecutor, path: string): Promise<boolean> {
    const r = await this.run(exec, "/", `test -e ${q(path)}`, 30_000);
    return r.code === 0;
  }

  /**
   * Dizin gerçekten bir git deposu mu?
   *
   * Yarım kalan bir klon geride boş dizin bırakır; "var mı" sorusu onu geçerli
   * sayar ve hata iki adım sonra, anlamsız bir yerde patlar.
   */
  private async isRepo(exec: CommandExecutor, path: string): Promise<boolean> {
    const r = await this.run(exec, "/", `git -C ${q(path)} rev-parse --git-dir`, 30_000);
    return r.code === 0;
  }

  mirrorPath(root: string, profileSlug: string, repoName: string): string {
    return joinPath(root, "mirrors", profileSlug, `${repoName}.git`);
  }

  worktreePath(root: string, jobId: string, repoName: string): string {
    return joinPath(root, "worktrees", jobId, repoName);
  }

  /**
   * Mirror'ı kaynak workspace'ten kurar ya da tazeler.
   *
   * `--mirror`: bare clone'da `git fetch` yerel dalları güncellemez; mirror
   * refspec'i (`+refs/*:refs/*`) bunu düzeltir. Kaynak = kullanıcının yerel
   * checkout'u: commit'lenmiş ama push'lanmamış işi de görür, yarım işi görmez.
   *
   * Kaynak konteynere SALT OKUNUR bağlı; `clone` ondan yalnız okur.
   */
  /**
   * Git'in "dubious ownership" reddini kaldırır.
   *
   * YAŞANDI (2026-09-17): kaynak workspace konteynere bind mount edildiğinde
   * dosyaların sahibi host kullanıcısı (Windows'ta farklı uid) oluyor ve git
   * 2.35+ o dizinde çalışmayı REDDEDİYOR:
   *
   *   fatal: detected dubious ownership in repository at '/source'
   *
   * `clone --mirror` bunun üzerine BOŞ bir hedef dizin bırakıyor, hata
   * yutuluyor ve sıradaki `worktree add` "not a git repository" ile düşüyordu.
   * Teşhisi zor: asıl hata iki adım önce.
   *
   * `safe.directory '*'` konteyner içinde güvenli — konteyner zaten tek işe
   * ait ve içindeki her şey aynı işin dosyaları.
   */
  private async trustDirs(exec: CommandExecutor): Promise<void> {
    await this.run(exec, "/", `git config --global --add safe.directory '*'`, 30_000);
  }

  private async ensureMirror(
    exec: CommandExecutor,
    source: string,
    mirror: string,
    timeoutMs: number,
  ): Promise<boolean> {
    await this.trustDirs(exec);
    const lock = this.lockFor(mirror);
    // VARLIK DEĞİL GEÇERLİLİK: yarım kalmış bir klon geride BOŞ bir dizin
    // bırakır ve `test -e` onu "mirror var" sayardı — sonraki her deneme
    // `worktree add` aşamasında "not a git repository" ile düşerdi (yaşandı).
    // Ölçüt: dizin gerçekten bare repo mu?
    if (!(await this.isRepo(exec, mirror))) {
      // Yarım klon varsa temizlenir; yoksa bu zararsız.
      await this.run(exec, "/", `rm -rf ${q(mirror)}`, 120_000);
      await this.must(exec, "/", `mkdir -p ${q(joinPath(mirror, ".."))}`, 60_000);
      const clone = async () => {
        if (await this.isRepo(exec, mirror)) return;
        // Klon uzun sürebilir (Northwind büyük): 30 dakika tavan.
        await this.git(exec, "/", ["clone", "--mirror", "--quiet", source, mirror], 1_800_000);
        // Çıkış 0 yetmiyor: klon boş dizin bırakıp "başarılı" dönebiliyor.
        // Burada yakalanmazsa hata `worktree add`e taşınır ve sebebi kaybolur.
        if (!(await this.isRepo(exec, mirror))) {
          throw new Error(`mirror klonlandı ama geçerli depo değil: ${mirror} (kaynak: ${source})`);
        }
      };
      const done = await lock.exclusive(clone, timeoutMs);
      // İlk klon atlanamaz: mirror yoksa worktree de yok.
      if (done === null) await lock.exclusive(clone, Number.MAX_SAFE_INTEGER);
      return false;
    }
    const fetched = await lock.exclusive(
      () => this.git(exec, mirror, ["fetch", "--prune", "--quiet", "origin"], 1_800_000),
      timeoutMs,
    );
    return fetched === null;
  }

  async prepare(input: PrepareInput): Promise<PreparedWorktree[]> {
    const { profile, jobId, executor, root } = input;
    const wanted = new Set(
      input.targetRepos && input.targetRepos.length > 0
        ? input.targetRepos
        : profile.workspace.repos.filter((r) => r.primary).map((r) => r.name),
    );
    const repos = profile.workspace.repos.filter((r) => wanted.has(r.name));
    if (repos.length === 0) throw new Error(`materyalize edilecek repo yok (istenen: ${[...wanted].join(", ")})`);

    const timeoutMs = input.fetchLockTimeoutMs ?? 10_000;
    const branch = renderBranch(profile.git.branchPattern, { jobId, slug: input.jobSlug });
    const out: PreparedWorktree[] = [];

    for (const repo of repos) {
      // Kaynak repo yolu profil köküne göreli; yürütücüde kaynak `sourceRoot`.
      const source = joinPath(input.sourceRoot, repo.path === "." ? "" : repo.path);
      const mirror = this.mirrorPath(root, profile.slug, repo.name);
      const path = this.worktreePath(root, jobId, repo.name);

      // Kira ÖNCE: iki iş aynı yolu asla paylaşmaz; index reddederse buradan çıkılır.
      //
      // İşin KENDİ kirası çakışma değil: ağaç diskten yok olup yeniden
      // kurulurken (bkz. `ensureWorktree`) kayıt `held` kalır. YAŞANDI
      // (2026-09-21): volume yenilendi, aşağıdaki prune yolu git tarafını
      // toparladı ama `prepare` daha kiraya gelmeden kendi kaydına takılıp
      // "kaynak zaten kirada" ile düştü — iş NeedsAttention'da sıkıştı ve
      // yeniden deneme her seferinde aynı yere çarptı.
      const mine = heldLeases(this.db, jobId, "worktree").some((l) => l.value === path);
      if (!mine) acquireLease(this.db, { jobId, kind: "worktree", value: path });

      try {
        const fetchSkipped = await this.ensureMirror(executor, source, mirror, timeoutMs);

        const created = await this.lockFor(mirror).shared(async () => {
          await this.must(executor, "/", `mkdir -p ${q(joinPath(path, ".."))}`, 60_000);
          // Kayıtlı ama GEÇERSİZ worktree kaydını temizle.
          //
          // YAŞANDI (2026-09-17): volume yeniden yaratıldığında mirror'ın
          // kaydı kalıyor ve `worktree add` "is a missing but already
          // registered worktree" ile düşüyordu — iş `pr_failed` ile duruyor.
          //
          // `prune` TEK BAŞINA YETMİYOR: `mkdir -p` hedef dizini önceden
          // yarattığı için kayıt `prunable` görünse de prune onu atlıyor
          // (ölçüldü). Bu yüzden önce BOŞ dizin siliniyor, sonra prune.
          await this.run(executor, "/", `rmdir ${q(path)} 2>/dev/null || true`, 60_000);
          await this.run(executor, mirror, `git worktree prune`, 120_000);
          const ref = await this.run(executor, mirror, `git show-ref --verify --quiet ${q(`refs/heads/${branch}`)}`, 60_000);
          // Yeniden deneme: dal önceki denemeden kalmışsa yeniden yaratma.
          const args = ref.code === 0
            ? ["worktree", "add", "--quiet", path, branch]
            : ["worktree", "add", "--quiet", "-b", branch, path, repo.defaultBranch];
          await this.git(executor, mirror, args, 1_800_000);
          return ref.code !== 0;
        });

        const { copied, refused } = await this.copyIgnoredButNeeded(executor, source, path, profile);
        const removed = await this.removeSensitive(executor, path, profile);

        out.push({ repo: repo.name, path, branch, mirror, copied, refused, removed, fetchSkipped, created });
      } catch (err) {
        releaseLease(this.db, "worktree", path);
        throw err;
      }
    }

    return out;
  }

  /** Yürütücüde glob — `find` ile, kaynağa göreli yollar döner. */
  private async globIn(exec: CommandExecutor, cwd: string, pattern: string): Promise<string[]> {
    if (!(await this.exists(exec, cwd))) return [];
    // `find` deseni tam yola uygular; `-path` ile `./` önekini eşleştiriyoruz.
    const r = await this.run(
      exec,
      cwd,
      `find . -path ${q(`./${pattern}`)} -prune -print 2>/dev/null || true`,
      120_000,
    );
    return r.out
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter((l) => l.length > 0);
  }

  /**
   * Gitignore'lu ama gerekli içeriği kaynaktan kopyalar.
   *
   * `neverCopy` her düzeyde kazanır: hem aday yolun kendisi hem kopyalanan bir
   * dizinin içindeki alt yollar süzülür. "plans/" kopyalanırken içinde bir
   * token dosyası varsa o dosya gelmez.
   *
   * Kopyalama konteynerde `cp -a` ile yapılır, ama süzme ONDAN SONRA değil
   * ÖNCE olamaz — `cp` desen bilmez. Bu yüzden kopyalanan ağaç içinde
   * `neverCopy` eşleşenler hemen silinir. Sır bir an bile diskte kalmasın
   * diye silme aynı komut zincirinde koşar.
   */
  private async copyIgnoredButNeeded(
    exec: CommandExecutor,
    source: string,
    target: string,
    profile: ProjectProfile,
  ): Promise<{ copied: string[]; refused: string[] }> {
    const never = profile.security.neverCopy;
    const copied: string[] = [];
    const refused: string[] = [];

    for (const raw of profile.workspace.ignoredButNeeded) {
      const pat = raw.replace(/\/$/, "");
      const candidates = isGlob(pat)
        ? await this.globIn(exec, source, pat)
        : (await this.exists(exec, joinPath(source, pat))) ? [pat] : [];

      for (const relRaw of candidates) {
        const rel = relRaw.split(sep).join("/");
        if (matchesAny(rel, never)) {
          refused.push(rel);
          continue;
        }
        const from = joinPath(source, rel);
        const to = joinPath(target, rel);
        await this.must(exec, "/", `mkdir -p ${q(joinPath(to, ".."))} && cp -a ${q(from)} ${q(to)}`, 600_000);
        await this.pruneCopied(exec, target, to, never);
        copied.push(rel);
      }
    }
    return { copied, refused };
  }

  /**
   * Kopyalanan ağacın İÇİNDE `neverCopy` ve `.git` temizliği.
   *
   * `cp -a` her şeyi getirir; süzme burada. Hedefe göreli yol hesaplanıp
   * profil desenleriyle karşılaştırılır — host tarafındaki `cpSync` filtresi
   * neyi yapıyorsa aynısı, yalnız kopya sonrası.
   */
  private async pruneCopied(
    exec: CommandExecutor,
    target: string,
    copiedRoot: string,
    never: readonly string[],
  ): Promise<void> {
    // `.git` asla taşınmaz: nested repo tarihi worktree'ye girmemeli.
    await this.run(exec, "/", `find ${q(copiedRoot)} -name .git -maxdepth 6 -exec rm -rf {} + 2>/dev/null || true`, 120_000);
    if (never.length === 0) return;
    const listed = await this.run(exec, target, `find ${q(copiedRoot)} -mindepth 0 2>/dev/null || true`, 120_000);
    const doomed: string[] = [];
    for (const abs of listed.out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const norm = abs.replace(/\\/g, "/");
      const t = target.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!norm.startsWith(`${t}/`)) continue;
      const rel = norm.slice(t.length + 1);
      if (matchesAny(rel, never)) doomed.push(norm);
    }
    // Tek komutta sil: sır diskte gereksiz bir an bile durmasın.
    if (doomed.length > 0) {
      await this.run(exec, "/", `rm -rf ${doomed.map(q).join(" ")}`, 120_000);
    }
  }

  /** Hassas dosyalar worktree'de barınmaz — takip edilse bile silinir. */
  private async removeSensitive(
    exec: CommandExecutor,
    target: string,
    profile: ProjectProfile,
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const pat of profile.security.sensitiveFiles) {
      for (const relRaw of await this.globIn(exec, target, pat)) {
        const rel = relRaw.split(sep).join("/");
        if (rel === ".git" || rel.startsWith(".git/")) continue;
        await this.run(exec, "/", `rm -rf ${q(joinPath(target, rel))}`, 120_000);
        removed.push(rel);
      }
    }
    return removed.sort();
  }

  /**
   * İşin worktree'lerini kaldırır ve kiraları bırakır.
   *
   * Çağıran karar verir: başarısız işlerin worktree'si post-mortem için
   * SAKLANIR, bu yüzden otomatik değil. Dal mirror'da kalır — push'lanmış
   * olabilir, silmek PR'ı koparır.
   *
   * Volume'ün kendisini silmek çağıranın işi (`ContainerManager.removeVolume`);
   * burası yalnız ağacı ve kirayı temizler.
   */
  async remove(input: {
    jobId: string;
    profileSlug: string;
    executor: CommandExecutor;
    root: string;
  }): Promise<string[]> {
    const { jobId, profileSlug, executor, root } = input;
    const removed: string[] = [];
    for (const lease of heldLeases(this.db, jobId, "worktree")) {
      const path = lease.value;
      const repoName = basename(path);
      const mirror = this.mirrorPath(root, profileSlug, repoName);
      if (await this.exists(executor, mirror)) {
        await this.lockFor(mirror).shared(async () => {
          // Dizin elle silinmiş olabilir; kaydı prune temizler.
          await this.run(executor, mirror, `git worktree remove --force ${q(path)}`, 300_000);
          await this.run(executor, mirror, `git worktree prune`, 120_000);
        });
      }
      await this.run(executor, "/", `rm -rf ${q(path)}`, 300_000);
      releaseLease(this.db, "worktree", path);
      removed.push(path);
    }
    const jobDir = joinPath(root, "worktrees", jobId);
    await this.run(executor, "/", `rm -rf ${q(jobDir)}`, 300_000);
    return removed;
  }
}
