import type { ProjectProfile } from "@ahtapot/shared";

import type { CommandExecutor } from "./executor.js";

/**
 * Bind-mount'ta yaşamaması gereken dizinleri konteyner diskine taşır.
 *
 * NEDEN: ölçüldü (2026-09-15, Windows) — bind-mount üzerinde `npm ci` paketleri
 * eksik açıyor ve bunu HATA SAYMIYOR. `TAR_ENTRY_ERROR ENOENT` uyarısı basıp
 * "added 159 packages" diyor ve çıkış 0 dönüyor; ardından build `tsc: not
 * found` ya da TS6053 ile düşüyor. Aynı kurulum konteyner diskinde 10 sn'de ve
 * doğru bitiyor (21 → 70 girdi).
 *
 * ÇÖZÜM GitHub Actions deseni: bağımlılık runner'ın kendi diskinde kurulur,
 * checkout ayrı yerde durur. Burada da `path` konteyner diskinde yaşar,
 * worktree'deki yerine symlink konur — build komutu farkı görmez.
 *
 * Hangi dizinlerin böyle olduğunu PROFİL söyler; bu dosyada `node_modules`
 * geçmez. Alan boşsa hiçbir şey yapılmaz.
 */

/** Konteyner diskinde scratch kökü. Konteyner root DEĞİL; /tmp yazılabilir. */
const SCRATCH_ROOT = "/tmp/ahtapot-scratch";

export interface ScratchPlan {
  /** Kaç dizin hazırlandı. */
  prepared: number;
  /** Anahtarı bilinen ve yeniden kullanılan dizin sayısı. */
  reused: number;
}

/**
 * Kurulumdan SONRA: `npm ci`'nin sildiği symlink'i geri kurar.
 *
 * NEDEN AYRI BİR ADIM: `npm ci` kuruluma başlarken mevcut `node_modules`'ı
 * tamamen siler — symlink de "mevcut `node_modules`"tur. Ölçüldü (2026-09-16,
 * Collection işi, npm 10.9.8): `prepareScratchDirs` symlink'i kuruyor,
 * `npm ci` `npm warn reify Removing non-directory ...` basıp siliyor ve
 * kurulum yine bind-mount'a düşüyor. `df` ile doğrulandı: hedef
 * `C:\ /workspace`, scratch `overlay /`.
 *
 * Sonuç DOĞRU oluyor (69-81 girdi, `.bin/tsc` var) ama YAVAŞ: sekiz modül
 * 17 dakika. Aynı kurulum konteyner diskinde modül başına ~10 sn.
 *
 * Bu yüzden kurulum bittikten sonra sonucu scratch'e taşıyıp symlink'i geri
 * kuruyoruz: bir sonraki koşu `prepareScratchDirs` aşamasında symlink'i yerinde
 * bulup kurulumu hiç tekrarlamayacak (`keyFile` aynıysa).
 *
 * Kurulumdan ÖNCE symlink kurmayı bırakmıyoruz: hedef zaten scratch'teyse ve
 * npm silmezse (yarn/pnpm, ya da `npm ci` yerine `npm install`) kazanç orada
 * kalır.
 */
export async function stashScratchDirs(
  profile: ProjectProfile,
  workdir: string,
  jobId: string,
  exec: CommandExecutor,
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<{ moved: number }> {
  const dirs = profile.exec.scratchDirs;
  if (dirs.length === 0) return { moved: 0 };

  const script = dirs.map((d) => renderStash(d.path, d.keyFile, jobId)).join("\n");
  let moved = 0;

  const res = await exec.run({
    command: `set -e\nmkdir -p ${SCRATCH_ROOT}\n${script}`,
    cwd: workdir,
    env: {},
    // Taşıma bind-mount'tan okuyup konteyner diskine yazıyor: kurulumun
    // kendisinden hızlı ama anlık değil. Süre profilden — dizin sayısı ve boyut
    // projeye göre değişiyor ve sabit 15 dk Northwind'de yetmedi.
    timeoutMs: profile.exec.scratchStashMinutes * 60_000,
    onLine: (stream, line) => {
      if (line.startsWith("scratch:taşındı ")) moved++;
      onLine(stream, line);
    },
  });

  // Taşıma DÜŞERSE iş durmaz: kurulum zaten doğru bitti, bu yalnız bir sonraki
  // koşunun hızıyla ilgili. Sessiz kalmak da olmaz — neden yavaş kalacağı
  // görünsün.
  if (res.exitCode !== 0) {
    const why = res.timedOut
      // Ne yapılacağını söyle: bu uyarı "sonraki koşu yavaş" diye okunup
      // geçiliyordu, oysa yarım kalan taşıma modülleri eksik bırakıp build'i
      // kırıyor. Çözüm profilde ve adı burada geçmeli.
      ? `${Math.round(res.durationMs / 1000)} s sonra zaman aşımı — profilde exec.scratchStashMinutes artırılmalı (şu an ${profile.exec.scratchStashMinutes})`
      : `çıkış ${res.exitCode}`;
    onLine("stderr", `▲ scratch taşınamadı (${why}); kurulum doğru ama sonraki koşu yine baştan kuracak`);
  }
  return { moved };
}

/**
 * Tek bir kabuk komutuyla tüm scratch dizinlerini kurar.
 *
 * Tek komut, çünkü her dizin için ayrı `exec` Windows'ta pahalı ve çıktısı
 * parçalanıyor. Kabuk tarafında yapılanlar, sırayla:
 *   1. glob'u genişlet (profil "Partials/x/wwwroot/node_modules" yazabilir)
 *   2. anahtar dosyasının hash'ini al — yoksa işe özel anahtar üret
 *   3. hedef zaten varsa DOKUNMA (paylaşım burada kazanılıyor)
 *   4. worktree'deki yeri sil, yerine symlink koy
 *
 * Kurulumun kendisini (npm ci vb.) BU MODÜL YAPMAZ: o profilin build adımıdır.
 * Burada yalnız symlink hazırlanır, komut sonra doğru yere yazar.
 */
export async function prepareScratchDirs(
  profile: ProjectProfile,
  workdir: string,
  jobId: string,
  exec: CommandExecutor,
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<ScratchPlan> {
  const dirs = profile.exec.scratchDirs;
  if (dirs.length === 0) return { prepared: 0, reused: 0 };

  const script = dirs.map((d) => renderOne(d.path, d.keyFile, jobId)).join("\n");
  let prepared = 0;
  let reused = 0;

  const res = await exec.run({
    command: `set -e\nmkdir -p ${SCRATCH_ROOT}\n${script}`,
    cwd: workdir,
    env: {},
    // Bind-mount yavaş: ilk koşuda her dizin için eski `node_modules`
    // taşınıyor. 5 dakika ölçülerek yetmedi. Tavan `stash` ile aynı profil
    // alanından — ikisi de aynı dosya sisteminde aynı veriyi taşıyor, ayrı ayrı
    // ayarlanmaları kullanıcıya iki bilinmeyen verirdi.
    timeoutMs: profile.exec.scratchStashMinutes * 60_000,
    onLine: (stream, line) => {
      if (line.startsWith("scratch:hazır ")) prepared++;
      else if (line.startsWith("scratch:yeniden ")) { prepared++; reused++; }
      onLine(stream, line);
    },
  });

  if (res.exitCode !== 0) {
    // "çıkış null" tek başına neyin yanlış olduğunu söylemiyordu; zaman aşımı
    // ile gerçek hatayı ayır (yaşandı — null görünce sebebi aramak gerekti).
    const why = res.timedOut
      ? `${Math.round(res.durationMs / 1000)} s sonra zaman aşımı; ${prepared}/${dirs.length} dizin hazırlandı`
      : `çıkış ${res.exitCode}`;
    throw new Error(`scratch dizinleri hazırlanamadı (${why}); bind-mount'ta kurulum sessizce bozulur`);
  }
  return { prepared, reused };
}

/**
 * Anahtar ve yol hesabı — `renderOne` ile `renderStash` AYNI değeri üretmeli.
 *
 * Ayrı ayrı yazılsaydı biri `cut -c1-16`, öteki `cut -c1-12` olurdu ve iki
 * taraf birbirini hiç bulamazdı; bu hata sessizdir (her koşu baştan kurar,
 * kimse şikâyet etmez). Tek yerden üretilmesi bunun içindir.
 */
function keyAndStore(leaf: string, keyFile: string, jobId: string): string[] {
  return [
    `  target="$parent/${leaf}"`,
    keyFile
      ? `  if [ -f "$parent/${keyFile}" ]; then key=$(sha256sum "$parent/${keyFile}" | cut -c1-16); else key="${jobId}"; fi`
      : `  key="${jobId}"`,
    `  name=$(echo "$target" | tr '/' '_')`,
    // Yaprak adı KORUNUR: store `<kova>/node_modules` olur, `<kova>-anahtar` değil.
    //
    // Node modül çözümlemesi dizin ADINA bakıyor ve symlink'i değil GERÇEK yolu
    // izliyor: `typescript` paketi `/tmp/.../Northwind.Web_node_modules-a1b2/` altında
    // yaşarken `import.meta.resolve("@typescript/typescript-linux-x64")` kardeş
    // paketi bulamıyor, çünkü yukarıda `node_modules` adlı bir dizin yok. Belirti
    // TypeScript 7'de çıktı — native ikiliyi optional dependency olarak taşıyor ve
    // `tsc -v` bile `Unable to resolve @typescript/typescript-linux-x64` ile düştü
    // (ölçüldü: aynı dizin `node_modules` adıyla kopyalanınca çözümleme geçiyor).
    `  store="${SCRATCH_ROOT}/$name-$key/${leaf}"`,
  ];
}

/** `pattern`i üst dizin deseni + yaprak adına ayırır (glob üst dizine uygulanır). */
function splitPattern(pattern: string): { parentPattern: string; leaf: string } {
  const idx = pattern.lastIndexOf("/");
  return {
    parentPattern: idx > 0 ? pattern.slice(0, idx) : ".",
    leaf: idx > 0 ? pattern.slice(idx + 1) : pattern,
  };
}

/**
 * Kurulum sonrası taşıma parçası.
 *
 * Hedef symlink ise npm dokunmamış demektir — yapılacak şey yok. Gerçek dizinse
 * `npm ci` silip yeniden kurmuştur: içeriği scratch'e taşı, yerine symlink koy.
 */
function renderStash(pattern: string, keyFile: string, jobId: string): string {
  const { parentPattern, leaf } = splitPattern(pattern);
  return [
    `for parent in ${parentPattern}; do`,
    `  [ -d "$parent" ] || continue`,
    ...keyAndStore(leaf, keyFile, jobId),
    // Symlink ise npm dokunmamış: taşınacak bir şey yok.
    `  [ -L "$target" ] && continue`,
    `  [ -d "$target" ] || continue`,
    // Scratch'te eskisi varsa onu at: kurulum yenisini üretti, doğrusu bu.
    // `mv` anlık; silmeyi arka plana bırak (bind-mount'ta silme dakikalar sürer).
    `  if [ -e "$store" ]; then`,
    `    old="$store.eski.$$"`,
    `    mv "$store" "$old" 2>/dev/null && (rm -rf "$old" &) || rm -rf "$store"`,
    `  fi`,
    // Asıl taşıma. `mv` dosya sistemi sınırını geçtiği için kopyalama olur;
    // düşerse hedefe dokunma — kurulum doğru, yalnız hızlanmamış olur.
    // Kova dizini önce açılır: `store` artık `<kova>/node_modules` ve `mv` var
    // olmayan bir üst dizine yazamaz.
    `  mkdir -p "$(dirname "$store")"`,
    `  if mv "$target" "$store" 2>/dev/null; then`,
    `    ln -s "$store" "$target"`,
    `    echo "scratch:taşındı $target -> $store"`,
    `  else`,
    `    echo "scratch:taşınamadı $target" >&2`,
    `  fi`,
    `done`,
  ].join("\n");
}

/**
 * Bir desen için kabuk parçası.
 *
 * Anahtar: `keyFile` varsa içeriğinin sha256'sı — aynı lock dosyası olan işler
 * kurulumu PAYLAŞIR. Yoksa işe özel, çünkü paylaşılan bir dizinde farklı
 * sürümlerin çakışması sessiz yanlış build üretir.
 */
function renderOne(pattern: string, keyFile: string, jobId: string): string {
  // Glob HEDEFE değil ÜST DİZİNE uygulanır.
  //
  // Ölçüldü: hedefin kendisiyle (`Partials/*/wwwroot/node_modules`) genişletince
  // dizin henüz yokken glob hiçbir şeye eşleşmiyor, kabuk deseni ham veriyor ve
  // döngü tek tur bile dönmüyor — oysa asıl ihtiyaç TAM DA yokken kurmak.
  const { parentPattern, leaf } = splitPattern(pattern);
  return [
    `for parent in ${parentPattern}; do`,
    `  [ -d "$parent" ] || continue`,
    ...keyAndStore(leaf, keyFile, jobId),
    // Zaten symlink ve doğru yeri gösteriyorsa iş bitti.
    `  if [ -L "$target" ] && [ "$(readlink "$target")" = "$store" ]; then`,
    `    echo "scratch:yeniden $target -> $store"; continue`,
    `  fi`,
    // `[ -d ... ] && had=1` KULLANMA — iki ayrı sebeple, ikisi de ölçüldü:
    //
    //  1. `had` ÖNCEKİ TURDAN SIZAR. Kabuk değişkeni döngüye yerel değildir:
    //     ilk modülün store'u varsa `had=1` kalır ve store'u OLMAYAN sonraki
    //     modüller de "yeniden kullanıldı" raporlanır. Sayı yanlış çıkar ve
    //     kimse fark etmez — sessiz yalan.
    //  2. Liste son çalışan komutsa BETİĞİN ÇIKIŞ KODUNU 1 yapar; çağıran
    //     "scratch hazırlanamadı" diye fırlatır, oysa bir şey yanlış gitmemiştir.
    //
    // `if` bloğu her turda `had`ı tazeler ve her dalda 0 döner.
    `  if [ -d "$store" ]; then had=1; else had=0; fi`,
    `  mkdir -p "$store"`,
    // `rm -rf` DEĞİL: bind-mount'ta 69-81 girdilik bir `node_modules`'ı silmek
    // dakikalar sürüyor ve 5 dakikalık sınır dolup adım "çıkış null" ile
    // düşüyordu (ölçüldü: 10 dizinin ancak 5'i işlenebildi). `mv` anlık;
    // çöpü arka planda, adımı bekletmeden sil.
    `  if [ -e "$target" ] || [ -L "$target" ]; then`,
    `    trash="$target.eski.$$"`,
    `    mv "$target" "$trash" 2>/dev/null && (rm -rf "$trash" &) || rm -rf "$target"`,
    `  fi`,
    `  ln -s "$store" "$target"`,
    `  if [ "$had" = "1" ]; then echo "scratch:yeniden $target -> $store"; else echo "scratch:hazır $target -> $store"; fi`,
    `done`,
  ].join("\n");
}
