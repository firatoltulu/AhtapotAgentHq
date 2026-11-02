import type { ProjectProfile } from "@ahtapot/shared";

import { shellQuote, type CommandExecutor } from "../build/executor.js";
import { resolveToken } from "../git/github.js";

/**
 * Kaynak workspace'i uzaktaki varsayılan dalın ucuna ilerletir (`git pull
 * --ff-only` karşılığı).
 *
 * Mirror kaynaktan, iş dalı mirror'dan açılıyor; kaynak hiç güncellenmezse
 * her iş bayat tabandan başlar. YAŞANDI (2026-10-06, uzak sunucu): kaynak
 * `gitUrl`den bir kez klonlanmıştı ve bir daha çekilmedi — Planner'ın planda
 * adını verdiği dosya ağaçta yoktu. `pullBase` yalnız birincil repoyu ve
 * yalnız iş dalını düzeltiyordu; mirror, gitignore'lu kopyalar ve ikincil
 * repolar bayat kalıyordu.
 *
 * Yıkıcı değil, bu yüzden profil kapısı yok: yalnız repo varsayılan dalındaysa
 * ve yalnız fast-forward. Yerel commit varsa ya da yerel değişiklik çekilen
 * dosyalara çarpıyorsa git reddeder, repo olduğu gibi kalır — kullanıcının
 * kendi checkout'u da (yerel geliştirme) güvende.
 */

export type SourceSyncResult =
  | { repo: string; status: "updated"; from: string; to: string }
  | { repo: string; status: "current" }
  /** `dir`/`user`: komutun koştuğu yer — host'ta, sunucu sürecinin kullanıcısıyla. */
  | { repo: string; status: "skipped"; reason: string; dir: string; user: string };

type Repo = ProjectProfile["workspace"]["repos"][number];

/**
 * Aynı dizinde iki eşzamanlı senkron `FETCH_HEAD`i ve `index.lock`u
 * paylaşır — iki iş aynı anda açılınca biri ötekinin fetch'ini merge ederdi.
 */
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}

export async function syncSource(exec: CommandExecutor, root: string, repos: readonly Repo[]): Promise<SourceSyncResult[]> {
  const token = await resolveToken();
  const user = await whoami(exec, root);
  const out: SourceSyncResult[] = [];
  for (const repo of repos) {
    const dir = repo.path === "." ? root : joinPath(root, repo.path);
    try {
      out.push(await serialize(dir, () => syncRepo(exec, dir, repo, token, user)));
    } catch (err) {
      out.push({ repo: repo.name, status: "skipped", reason: err instanceof Error ? err.message : String(err), dir, user });
    }
  }
  return out;
}

/**
 * Zamanlayıcı: kaynak workspace'leri saatte bir uzaktaki uca ilerletir.
 *
 * İş açılışındaki senkron tek başına yetmiyordu: uzun süren işlerde ve iş
 * açılmayan aralıklarda kaynak (ve ondan beslenen mirror) bayatlıyor,
 * taban kaydı olmayan diff'ler yerel `main`e düşüyordu. Kurallar aynı —
 * yalnız varsayılan daldaysa, yalnız fast-forward; atlanan repo loglanır.
 *
 * `watchReleases` kalıbı: `unref`, önceki tur bitmeden yenisi binmez.
 * Profiller her turda yeniden okunur: onaylanan/arşivlenen proje sunucu
 * yeniden başlamadan devreye girsin.
 */
export function watchSourceSync(
  exec: CommandExecutor,
  profiles: () => ProjectProfile[],
  log: (level: "info" | "warn", obj: Record<string, unknown>, msg: string) => void,
  intervalMs = 3_600_000,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const profile of profiles()) {
        try {
          for (const r of await syncSource(exec, profile.workspace.root, profile.workspace.repos)) {
            if (r.status === "updated") log("info", { repo: r.repo, from: r.from, to: r.to }, "kaynak güncellendi");
            else if (r.status === "skipped") log("warn", { repo: r.repo, dir: r.dir, user: r.user, reason: r.reason }, "kaynak güncellenemedi");
          }
        } catch (err) {
          // Tek projenin hatası diğerlerini durdurmasın.
          log("warn", { root: profile.workspace.root, err: String(err) }, "kaynak senkronu düştü");
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function syncRepo(exec: CommandExecutor, dir: string, repo: Repo, token: string, user: string): Promise<SourceSyncResult> {
  const base = repo.defaultBranch;
  const skip = (reason: string): SourceSyncResult => ({ repo: repo.name, status: "skipped", reason, dir, user });

  // `--git-dir` üst deponun alt dizininde de başarılı olur; o zaman fetch ve
  // merge alt depoyu değil üst depoyu ilerletirdi. Boş önek = depo kökündeyiz
  // (yol karşılaştırması Windows'ta `E:/` ile `E:\` farkına takılırdı).
  const prefix = await git(exec, dir, "rev-parse --show-prefix");
  if (prefix.code !== 0) return skip(`depo değil ya da erişilemiyor: ${dir}`);
  if (prefix.out.trim() !== "") return skip(`kendi deposu değil, üst deponun alt dizini: ${dir}`);

  const branch = (await git(exec, dir, "symbolic-ref --short -q HEAD")).out.trim();
  if (branch !== base) return skip(`${branch || "detached HEAD"} dalında; yalnız ${base} ilerletilir`);

  const denied = await checkAccess(exec, dir, base, token);
  if (denied) return skip(denied);

  const fetch = await remoteGit(exec, dir, `fetch --quiet origin ${shellQuote(base)}`, token, 600_000);
  if (fetch.code !== 0) return skip(`origin/${base} çekilemedi (çıkış ${fetch.code}): ${explainRemoteError(fetch.code, fetch.out)}`);

  const from = (await git(exec, dir, "rev-parse HEAD")).out.trim();
  const to = (await git(exec, dir, "rev-parse FETCH_HEAD")).out.trim();
  if (from === to) return { repo: repo.name, status: "current" };
  // Yerel uç uzaktakinin önündeyse çekecek bir şey yok, ama "güncel" de
  // değil: iş push'lanmamış yerel commit'leri taban alır — insan bilsin.
  if ((await git(exec, dir, "merge-base --is-ancestor FETCH_HEAD HEAD")).code === 0) {
    return skip(`yerel ${base} origin/${base}'in önünde (push'lanmamış commit); iş yerel tabandan sürüyor`);
  }

  // Varsayılan merge, gelen commit'in izlediği yoldaki gitignore'lu yerel
  // dosyanın üzerine yazar; reddetsin, insan uyarıyı görsün.
  const merge = await git(exec, dir, "merge --ff-only --no-overwrite-ignore --quiet FETCH_HEAD");
  if (merge.code !== 0) return skip(`fast-forward olmadı (yerel commit ya da çakışan yerel değişiklik)\n${merge.out.slice(0, 400)}`);
  return { repo: repo.name, status: "updated", from, to };
}

/**
 * Standart erişim denetimi: fetch'ten ÖNCE, ucuzdan pahalıya.
 *
 * YAŞANDI (2026-10-12): uyarı yalnız "origin/main çekilemedi (255)" diyordu;
 * stderr atılıyordu ve komutun nerede, hangi kullanıcıyla koştuğu da
 * yazmıyordu. 255 git'te çoğunlukla SSH kimlik hatasıdır ama yazma izni,
 * `safe.directory` ve ağ da aynı belirsiz uyarıya düşüyordu. Her adım kendi
 * nedenini söyler; ilk düşen adım raporlanır. `null` = erişim tamam.
 */
async function checkAccess(exec: CommandExecutor, dir: string, base: string, token: string): Promise<string | null> {
  // Fetch `FETCH_HEAD` ve ref'leri yazar; sunucu başka kullanıcıyla koşuyorsa
  // (servis hesabı) okuma geçer, yazma düşer.
  const gitDir = (await git(exec, dir, "rev-parse --absolute-git-dir")).out.trim();
  if (gitDir && (await sh(exec, dir, `test -w ${shellQuote(gitDir)}`)).code !== 0) {
    return `yazma izni yok: ${gitDir} — sunucu kullanıcısı fetch sonucunu (FETCH_HEAD) yazamaz`;
  }
  // YAŞANDI (2026-10-14): dizin yazılabilirdi ama `.git/FETCH_HEAD` başka
  // kullanıcıya (root) aitti — daha önce o kullanıcıyla koşan bir git onu
  // yaratmıştı. Dizin denetimi geçer, fetch "cannot open FETCH_HEAD" ile düşerdi.
  // Dosya atılabilir bir çıktı (fetch her seferinde baştan yazar) ve silmek için
  // dosyaya değil DİZİNE yazma izni yeter: insana `chown` yaptırmak yerine
  // sunucu kendi onarır. (Konteynerdeki `node` host'ta yok; elle `chown` bu
  // yüzden de "invalid user" verdi.) Silinemezse sahibi düzeltilmeli, rapor edilir.
  if (gitDir) {
    const fetchHead = shellQuote(`${gitDir}/FETCH_HEAD`);
    const stale = `test -e ${fetchHead} && ! test -w ${fetchHead}`;
    if ((await sh(exec, dir, stale)).code === 0) {
      await sh(exec, dir, `rm -f ${fetchHead}`);
      if ((await sh(exec, dir, stale)).code === 0) {
        return `yazma izni yok: ${gitDir}/FETCH_HEAD — başka kullanıcıya ait ve silinemedi (sunucu kullanıcısı: ${await whoami(exec, dir)}); host'ta sahibi düzeltilmeli`;
      }
    }
  }

  const url = (await git(exec, dir, "remote get-url origin")).out.trim();
  if (!url) return "origin remote'u tanımlı değil";

  // Okuma yetkisi: ağı ve kimliği tek bir ucuz çağrıyla dener. `--exit-code`
  // dal yoksa 2 döner — kimlik sorunundan ayrılsın.
  const probe = await remoteGit(exec, dir, `ls-remote --exit-code origin ${shellQuote(`refs/heads/${base}`)}`, token, 120_000);
  if (probe.code === 2) return `origin'de ${base} dalı yok (${scrubUrl(url)})`;
  if (probe.code !== 0) {
    const hint = isSshUrl(url) && token
      ? " Not: GitHub token'ı yalnız HTTPS remote'ta işe yarar; bu remote SSH."
      : "";
    return `origin okunamadı (${scrubUrl(url)}, çıkış ${probe.code}): ${explainRemoteError(probe.code, probe.out)}${hint}`;
  }
  return null;
}

/**
 * Uzak git çağrısı. Kimlik `clone.ts`teki gibi: helper kurulumu ve komut
 * AYNI çağrıda (kural 5). `origin` nested repoda yerel disk yolu da olabilir;
 * o zaman token gerekmez ama zararı da yok. `GIT_TERMINAL_PROMPT=0`: HTTPS
 * kimlik sorarsa asılı kalmasın, düşsün.
 */
async function remoteGit(exec: CommandExecutor, dir: string, args: string, token: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const lines: string[] = [];
  const res = await exec.run({
    command: `${token ? "gh auth setup-git -h github.com && " : ""}git ${args}`,
    cwd: dir,
    env: { GIT_TERMINAL_PROMPT: "0", ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}) },
    timeoutMs,
    onLine: (_s, l) => lines.push(l),
  });
  return { code: res.timedOut ? null : res.exitCode, out: lines.join("\n") };
}

/** Git'in ham stderr'ini insanın düzeltebileceği bir cümleye çevirir; ham satırlar da eklenir. */
export function explainRemoteError(code: number | null, out: string): string {
  const tail = out.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");
  const raw = tail ? ` [git: ${tail.slice(0, 300)}]` : "";
  if (code === null) return `zaman aşımı — ağ ya da SSH parola sorusu bekliyor olabilir${raw}`;
  const cases: Array<[RegExp, string]> = [
    [/Permission denied \(publickey/i, "SSH anahtarı reddedildi — sunucu kullanıcısının ~/.ssh'ında GitHub'a tanımlı anahtar yok"],
    [/Host key verification failed/i, "SSH host anahtarı doğrulanamadı — sunucu kullanıcısının known_hosts'unda github.com yok"],
    [/dubious ownership|safe\.directory/i, "git depoyu güvensiz sayıyor (sahip farklı kullanıcı) — `git config --global --add safe.directory <yol>`"],
    [/could not read Username|terminal prompts disabled|Authentication failed|\b403\b|\b401\b/i, "HTTPS kimliği yok ya da yetersiz — `gh auth login` ya da GH_TOKEN"],
    [/Repository not found|does not appear to be a git repository|not found/i, "depo bulunamadı ya da bu kimliğin okuma yetkisi yok"],
    [/Could not resolve host|Connection timed out|Network is unreachable|Connection refused/i, "ağ erişimi yok"],
    [/Permission denied/i, "dosya sistemi izni reddedildi"],
  ];
  const hit = cases.find(([re]) => re.test(out));
  if (hit) return `${hit[1]}${raw}`;
  if (code === 255) return `büyük olasılıkla SSH bağlantı/kimlik hatası${raw}`;
  return tail ? `git: ${tail.slice(0, 300)}` : "git çıktı vermedi";
}

function isSshUrl(url: string): boolean {
  return /^ssh:\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url);
}

/** Remote URL'sindeki gömülü kimliği (`https://user:token@`) maskeler. */
function scrubUrl(url: string): string {
  return url.replace(/\/\/[^/@]+@/, "//***@");
}

/** Yetki hataları kullanıcıya bağlı: servis hesabı ile insanın oturumu farklı ~/.ssh görür. */
async function whoami(exec: CommandExecutor, cwd: string): Promise<string> {
  const lines: string[] = [];
  const res = await exec.run({ command: "whoami", cwd, env: {}, timeoutMs: 10_000, onLine: (_s, l) => lines.push(l) });
  return res.exitCode === 0 ? (lines[0]?.trim() || "?") : "?";
}

async function sh(exec: CommandExecutor, cwd: string, command: string): Promise<{ code: number | null }> {
  const res = await exec.run({ command, cwd, env: {}, timeoutMs: 30_000, onLine: () => undefined });
  return { code: res.exitCode };
}

async function git(exec: CommandExecutor, cwd: string, args: string): Promise<{ code: number | null; out: string }> {
  const lines: string[] = [];
  const res = await exec.run({
    command: `git ${args}`,
    cwd,
    env: {},
    timeoutMs: 120_000,
    onLine: (_s, l) => lines.push(l),
  });
  return { code: res.exitCode, out: lines.join("\n") };
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((p) => p.length > 0)
    .join("/");
}
