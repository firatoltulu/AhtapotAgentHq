import { eq } from "drizzle-orm";

import { shellQuote, type CommandExecutor } from "../build/executor.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { resolveToken } from "../git/github.js";

/**
 * Host'ta git clone — `workspaceRoot` yoksa `gitUrl`den kurulur.
 *
 * `worktree.ts`'teki mirror (konteyner, named volume) ile KARIŞTIRILMAMALI:
 * burası "kaynağın" kendisini host diskinde var eder, worktree o kaynaktan
 * SONRA açılır. `dubious ownership` savunması burada gerekmiyor — worktree.ts
 * bunu kaynağın konteynere bind-mount edilmesinden (host uid ≠ konteyner uid)
 * doğan bir soruna karşı uyguluyor; burada klonu yapan da kullanan aynı host
 * kullanıcısı.
 */

/** worktree.ts:287-291 ile AYNI ölçüt: VARLIK DEĞİL GEÇERLİLİK. */
export async function isRepo(exec: CommandExecutor, path: string): Promise<boolean> {
  const res = await exec.run({
    command: `git -C ${shellQuote(path)} rev-parse --git-dir`,
    cwd: "/",
    env: {},
    timeoutMs: 30_000,
    onLine: () => undefined,
  });
  return res.exitCode === 0;
}

/**
 * `gitUrl`den `dest`e klonlar. `dest`in üst dizini yoksa oluşturulur.
 *
 * Kimlik `resolveToken()`den çözülüp ÇAĞRI BAŞINA verilir (kural 5); `gh auth
 * setup-git` ve `git clone` AYNI çağrıda koşar — token kalıcı git config'e
 * ayrı bir adımda yazılmaz (github.ts'teki `push()` ile aynı gerekçe).
 */
export async function cloneWorkspace(
  exec: CommandExecutor,
  gitUrl: string,
  dest: string,
  opts: { timeoutMs?: number; onLine?: (stream: "stdout" | "stderr", line: string) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const token = await resolveToken();

  // ÖNCE GEÇİCİ DİZİNE, SONRA YERİNE TAŞI. Doğrudan `dest`e klonlayıp hata
  // hâlinde `dest`i silmek, SAHİP OLMADIĞIMIZ bir yolu silme riski taşıyordu:
  // `isRepo` yalnız "geçerli repo değil" der, "biz yarattık" demez. API artık
  // VAR ama BOŞ bir hedefe de klonlamaya izin verdiği için (projects.ts) bu
  // yol gerçek: kullanıcının mount noktası ya da elle açtığı dizin, klon
  // auth'tan düşünce silinirdi. Geçici dizin bu çağrıya ait — silmesi güvenli.
  const staging = `${dest}.ahtapot-clone-${process.pid}-${Date.now()}`;

  const tail: string[] = [];
  // Git çıktısı TUTULUYOR: eskiden atılıyordu ve geriye yalnız exit kodu
  // kalıyordu ("klonlanamadı (1)"), asıl sebep — auth, DNS, "repository not
  // found", disk dolu — kullanıcıya da log'a da hiç ulaşmıyordu (yaşandı).
  // `--quiet` kalktı ki ilerleme değil ama hata satırları gelsin.
  const res = await exec.run({
    command:
      `mkdir -p ${shellQuote(parentDir(dest))} && ` +
      `gh auth setup-git -h github.com && ` +
      `git clone --progress ${shellQuote(gitUrl)} ${shellQuote(staging)}`,
    cwd: "/",
    env: token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {},
    timeoutMs,
    // İKİ PARAMETRE: `ExecRequest.onLine`in gerçek imzası `(stream, line)`.
    // Eskiden tek parametreli `(line) => ...` yazılmıştı — TS bunu yapısal
    // uyum yüzünden sessizce kabul etti, ama çalışma zamanında `line`a giren
    // aslında `stream` ("stdout"/"stderr") oluyordu, gerçek satır metni HİÇ
    // yakalanmıyordu (hata mesajı sonunda çıplak "stderr" görülmesi buydu).
    onLine: (stream, line) => {
      opts.onLine?.(stream, line);
      // Son N satır yeter: hata git'in sonunda konuşur, baştaki ilerleme
      // satırları (`Receiving objects: 43%`) mesajı boğardı.
      tail.push(line);
      if (tail.length > 20) tail.shift();
    },
  });

  const ok = res.exitCode === 0 && (await isRepo(exec, staging));
  if (!ok) {
    await removeDir(exec, staging);
    const detail = tail.join("\n").trim();
    throw new Error(
      `klonlanamadı (${res.exitCode}): ${dest} (kaynak: ${gitUrl})` + (detail ? `\n${detail}` : ""),
    );
  }

  // Yayınlama: `dest` boş bir dizin olarak önceden VAR olabilir (API buna izin
  // veriyor), o yüzden `mv staging dest` dizini İÇİNE taşırdı — `rmdir` ile
  // önce kaldırılıyor. `rmdir` yalnız BOŞ dizinde başarılı olur; dolu bir
  // hedefte hata verir ve yayınlama düşer, yanlışlıkla üzerine yazılmaz.
  const publish = await exec.run({
    command: `rmdir ${shellQuote(dest)} 2>/dev/null; mv ${shellQuote(staging)} ${shellQuote(dest)}`,
    cwd: "/",
    env: {},
    timeoutMs: 60_000,
    onLine: (stream, line) => opts.onLine?.(stream, line),
  });

  if (publish.exitCode !== 0 || !(await isRepo(exec, dest))) {
    await removeDir(exec, staging);
    throw new Error(
      `klon tamamlandı ama hedefe taşınamadı (${publish.exitCode}): ${dest} (kaynak: ${gitUrl})`,
    );
  }
}

/** Geçici klon dizinini siler; hata yutulur — asıl hata çağıran tarafta. */
async function removeDir(exec: CommandExecutor, path: string): Promise<void> {
  await exec.run({
    command: `rm -rf ${shellQuote(path)}`,
    cwd: "/",
    env: {},
    timeoutMs: 60_000,
    onLine: () => undefined,
  });
}

/**
 * `gitUrl`den hedef klasör adını türetir: son path segmenti, `.git` uzantısı
 * kesilir. `repoSlugFromRemote` (github.ts) İLE KARIŞTIRILMAMALI: o yalnız
 * github.com remote'larını `owner/repo` biçiminde tanır (issue/PR akışı
 * için); burada genel git URL'si (github dışı da olabilir) kabul edilip TEK
 * klasör adı isteniyor — `git clone` de zaten URL'yi olduğu gibi kabul ediyor.
 *
 * GÜVENLİK: `gitUrl` istemciden geliyor (kural 3 — üretici taraf güvenilmez).
 * `\` de ayraç sayılır — yoksa `owner/evil\..\..\..\etc` gibi bir girdide son
 * segment `\` içeren tek parça kalır ve `path traversal`e açılır. Sonuç TEK
 * güvenli klasör adı olmalı: yalnız harf/rakam/`-`/`_`/`.`, nokta ile
 * başlayamaz (`.`/`..` böylece elenir).
 */
export function repoFolderName(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/[/\\]+$/, "");
  const last = trimmed.split(/[/\\:]/).pop() ?? trimmed;
  const stripped = last.replace(/\.git$/i, "");
  const safe = stripped.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "");
  return safe || "workspace";
}

function parentDir(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx > 0 ? norm.slice(0, idx) : "/";
}

/**
 * Yarıda kalmış klonları kapatır — sunucu açılışında çağrılır.
 *
 * `analyst.ts`teki `reconcileInterruptedAnalyses` ile aynı gerekçe: clone
 * süreç içi bir promise'te sürer, süreç ölürse satır "pending"de kalır ve
 * hiçbir şey onu tamamlamaz.
 */
export function reconcileInterruptedClones(db: Db): number {
  const stuck = db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.workspaceStatus, "pending"))
    .all();

  for (const p of stuck) {
    db.update(schema.projects)
      .set({ workspaceStatus: "failed", workspaceError: "sunucu yeniden başladı; klon yarıda kaldı" })
      .where(eq(schema.projects.id, p.id))
      .run();
  }
  return stuck.length;
}
