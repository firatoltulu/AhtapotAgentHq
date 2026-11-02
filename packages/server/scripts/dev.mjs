// Geliştirme başlatıcısı: sunucuyu koşar, yalnız sunucu ve shared `dist/`i
// değişince yeniden başlatır.
//
// Node'un kendi izleyicisi iki yoldan da yanlış tetikleniyordu (yaşandı):
// - Düz `--watch` yüklenen her dosyayı, `node_modules` dahil, izliyor: başka
//   bir `npm install` sunucuyu yeniden başlattı, yürüyen imaj build'i kesildi.
// - `--watch-path=dist` (Node 24, Windows) ağacın DIŞINDAKİ değişikliğe de
//   tepki verdi: sunucunun açılışta dokunduğu `.git/index.lock` ve
//   `packages/bridge/dist` her açılışta yeni bir yeniden başlatma doğurdu,
//   sunucu döngüye girdi. Aynı koşuda `fs.watch` bu dizinlerde hiç olay
//   görmedi; kusur Node'un watch modunda.
// `fs.watch` recursive Node 20'den beri Linux'ta da var.
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

const WATCHED = ["dist", "../shared/dist"].map((p) => resolve(p));
/** tsc bir derlemede onlarca dosya yazar; tek yeniden başlatmada toplanır. */
const DEBOUNCE_MS = 300;

let child = null;
let restarting = false;
let timer = null;

function start() {
  child = spawn(process.execPath, ["--env-file-if-exists=../../.env", "dist/main.js"], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    child = null;
    if (restarting) {
      restarting = false;
      start();
    } else if (signal !== "SIGTERM" && signal !== "SIGINT") {
      // Çökme: süreci bitirme, düzeltilmiş derlemeyi bekle (Node --watch gibi).
      console.log(`[dev] sunucu çıktı (${signal ?? code}); değişiklik bekleniyor`);
    }
  });
}

function restart(file) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[dev] değişti: ${file} — yeniden başlatılıyor`);
    if (child) {
      restarting = true;
      child.kill("SIGTERM");
    } else {
      start();
    }
  }, DEBOUNCE_MS);
}

for (const dir of WATCHED) {
  watch(dir, { recursive: true }, (_event, file) => {
    // Kaynak haritası ve tip bildirimi çalışan kodu değiştirmez.
    if (file && /\.(map|d\.ts)$/.test(file)) return;
    restart(resolve(dir, file ?? ""));
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (child) child.once("exit", () => process.exit(0)).kill(sig);
    else process.exit(0);
  });
}

start();
