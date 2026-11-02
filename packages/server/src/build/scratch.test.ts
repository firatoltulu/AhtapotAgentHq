import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, lstatSync, readlinkSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectProfileSchema, type ProjectProfile } from "@ahtapot/shared";

import type { CommandExecutor, ExecRequest, ExecResult } from "./executor.js";
import { prepareScratchDirs, stashScratchDirs } from "./scratch.js";

/**
 * Scratch betiği testleri — GERÇEK POSIX kabuğunda.
 *
 * Bu modülün tamamı kabuk metni üretiyor ve bugüne dek iki kez sessizce
 * bozuldu: `[ -d "$x" ] && y=1` `set -e` altında döngüyü kesiyordu, ve glob
 * hedefe uygulanınca dizin yokken hiçbir şeye eşleşmiyordu. İkisi de ancak
 * gerçek kabukta koşturunca görünür — string karşılaştıran bir test ikisini de
 * kaçırırdı.
 *
 * Windows'ta `sh` Git ile geliyor ama varsayılan ayarla `ln -s` symlink değil
 * KOPYA üretir; o hâlde bu testler ölçemeyeceklerini ölçmüş olur ve atlanır
 * (kırılmaz). Gerçek kapsama Linux'ta ve CI'da kazanılır.
 */

/** POSIX kabuğu doğrudan çağıran yürütücü — `HostExecutor` Windows'ta cmd kullanır. */
class ShExecutor implements CommandExecutor {
  constructor(private readonly sh: string) {}

  run(req: ExecRequest): Promise<ExecResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(this.sh, ["-c", req.command], {
        cwd: req.cwd,
        env: { ...process.env, ...req.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const feed = (stream: "stdout" | "stderr") => (d: string) => {
        for (const line of d.split(/\r?\n/)) if (line) req.onLine(stream, line);
      };
      child.stdout.setEncoding("utf8").on("data", feed("stdout"));
      child.stderr.setEncoding("utf8").on("data", feed("stderr"));
      child.on("close", (code) => {
        resolve({ exitCode: code, timedOut: false, durationMs: Date.now() - started });
      });
    });
  }
}

/**
 * Kullanılabilir POSIX kabuğu; yoksa `null`.
 *
 * `ln -s` de sınanır: Windows'ta Git Bash varsayılan ayarla symlink yerine
 * KOPYA üretir (`MSYS=winsymlinks:nativestrict` yoksa), o zaman `[ -L ]` hiç
 * tutmaz ve bu betiğin davranışı burada ölçülemez. Kabuğun varlığına bakıp
 * symlink'e bakmamak, yeşil ama anlamsız bir test üretirdi.
 */
function findSh(): string | null {
  for (const candidate of ["sh", "/usr/bin/sh", "C:/Program Files/Git/usr/bin/sh.exe"]) {
    try {
      const probe = 'd=$(mktemp -d); mkdir -p "$d/s"; ln -s "$d/s" "$d/l" 2>/dev/null; [ -L "$d/l" ]; r=$?; rm -rf "$d"; exit $r';
      execFileSync(candidate, ["-c", probe], { stdio: "ignore" });
      return candidate;
    } catch {
      // sıradakini dene
    }
  }
  return null;
}

const SH_SKIP = "POSIX kabuğu ya da symlink desteği yok (Windows: MSYS=winsymlinks:nativestrict)";

function profileWith(scratchDirs: { path: string; keyFile: string }[]): ProjectProfile {
  return ProjectProfileSchema.parse({
    version: 1, slug: "t", name: "T",
    workspace: { root: "/w", rootIsRepo: true, repos: [{ name: "a", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: "x", scratchDirs },
    build: { steps: [{ name: "b", run: "true" }] },
  });
}

/** İki modüllü sahte bir worktree: Northwind'in Partials/<mod>/wwwroot düzeni. */
function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-scratch-"));
  for (const mod of ["Alpha", "Beta"]) {
    const w = join(dir, "Partials", mod, "wwwroot");
    mkdirSync(w, { recursive: true });
    // Aynı lock içeriği → aynı anahtar → iki modül AYRI store (yol adı farklı).
    writeFileSync(join(w, "package-lock.json"), `{"name":"${mod}"}`, "utf8");
  }
  return dir;
}

const SCRATCH = "Partials/*/wwwroot/node_modules";

test("scratch: hedef yokken symlink kurulur (glob üst dizine uygulanır)", async (t) => {
  const sh = findSh();
  if (!sh) return t.skip(SH_SKIP);
  const dir = makeTree();
  try {
    const lines: string[] = [];
    const plan = await prepareScratchDirs(
      profileWith([{ path: SCRATCH, keyFile: "package-lock.json" }]),
      dir, "job1", new ShExecutor(sh), (_s, l) => lines.push(l),
    );

    // ÖLÇÜLDÜ: glob hedefe uygulanınca dizin yokken hiçbir şeye eşleşmiyor ve
    // döngü tek tur dönmüyordu — oysa asıl ihtiyaç tam da yokken kurmak.
    assert.equal(plan.prepared, 2, `iki modül hazırlanmalıydı: ${lines.join(" | ")}`);

    for (const mod of ["Alpha", "Beta"]) {
      const target = join(dir, "Partials", mod, "wwwroot", "node_modules");
      assert.ok(lstatSync(target).isSymbolicLink(), `${mod}: symlink değil`);
      assert.ok(readlinkSync(target).startsWith("/tmp/ahtapot-scratch/"), `${mod}: yanlış hedef`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scratch: 'yeniden kullanıldı' bayrağı önceki modülden sızmaz", async (t) => {
  const sh = findSh();
  if (!sh) return t.skip(SH_SKIP);
  const dir = makeTree();
  const profile = profileWith([{ path: SCRATCH, keyFile: "package-lock.json" }]);
  const exec = new ShExecutor(sh);
  try {
    // Alpha'yı bir kez kur ve taşı: store'u ARTIK VAR. Beta'ya dokunma.
    await prepareScratchDirs(profile, dir, "job1", exec, () => {});
    const alpha = join(dir, "Partials", "Alpha", "wwwroot", "node_modules");
    rmSync(alpha, { recursive: true, force: true });
    mkdirSync(join(alpha, "react"), { recursive: true });
    await stashScratchDirs(profile, dir, "job1", exec, () => {});
    // Kurgunun tamamı, sızıntının görünebilmesi için:
    //  - Alpha: symlink kaldırılır ama STORE kalır → `had=1` yazılır
    //  - Beta:  symlink de store da kaldırılır    → `had=0` OLMALI
    // Alpha'nın symlink'i yerinde bırakılırsa betik onu `continue` ile atlar,
    // `had` hiç yazılmaz ve sızıntı ortaya çıkmaz (bu kurguyla bir kez yanıldım).
    rmSync(alpha, { recursive: true, force: true });

    const betaLink = join(dir, "Partials", "Beta", "wwwroot", "node_modules");
    const betaStore = readlinkSync(betaLink);
    rmSync(betaLink, { recursive: true, force: true });
    rmSync(betaStore, { recursive: true, force: true });

    const lines: string[] = [];
    const plan = await prepareScratchDirs(profile, dir, "job1", exec, (_s, l) => lines.push(l));

    // ÖLÇÜLDÜ: `[ -d "$store" ] && had=1` deseninde `had` döngüye yerel
    // değildir. Alpha `had=1` yazınca Beta da — store'u OLMADIĞI hâlde —
    // "yeniden kullanıldı" raporlanıyordu. Sayı yanlış, kimse fark etmez.
    const beta = lines.find((l) => l.includes("Beta"));
    assert.ok(beta?.startsWith("scratch:hazır "), `Beta yanlış raporlandı: ${beta ?? "(satır yok)"}`);
    assert.equal(plan.reused, 1, `yalnız Alpha paylaşılmalıydı: ${lines.join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync("/tmp/ahtapot-scratch", { recursive: true, force: true });
  }
});

test("scratch: npm'in sildiği symlink kurulum sonrası geri kurulur", async (t) => {
  const sh = findSh();
  if (!sh) return t.skip(SH_SKIP);
  const dir = makeTree();
  const profile = profileWith([{ path: SCRATCH, keyFile: "package-lock.json" }]);
  const exec = new ShExecutor(sh);
  try {
    await prepareScratchDirs(profile, dir, "job1", exec, () => {});

    // `npm ci`yi taklit et: symlink'i sil, yerine gerçek dizin kur.
    // ÖLÇÜLDÜ (npm 10.9.8): "npm warn reify Removing non-directory ...".
    const alpha = join(dir, "Partials", "Alpha", "wwwroot", "node_modules");
    rmSync(alpha, { recursive: true, force: true });
    mkdirSync(join(alpha, "react"), { recursive: true });
    writeFileSync(join(alpha, "react", "index.js"), "module.exports={}", "utf8");
    assert.ok(!lstatSync(alpha).isSymbolicLink(), "kurulum taklidi symlink bırakmamalıydı");

    const lines: string[] = [];
    const stashed = await stashScratchDirs(profile, dir, "job1", exec, (_s, l) => lines.push(l));

    assert.equal(stashed.moved, 1, `taşınmadı: ${lines.join(" | ")}`);
    assert.ok(lstatSync(alpha).isSymbolicLink(), "symlink geri kurulmadı");

    // İçerik kaybolmamalı: taşıma kopyalamadır, silme değil.
    assert.ok(existsSync(join(alpha, "react", "index.js")), "kurulan paket kayboldu");

    // Symlink kalan modüle dokunulmamalı — npm oraya değmemiş demektir.
    const beta = join(dir, "Partials", "Beta", "wwwroot", "node_modules");
    assert.ok(lstatSync(beta).isSymbolicLink(), "dokunulmaması gereken symlink bozuldu");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync("/tmp/ahtapot-scratch", { recursive: true, force: true });
  }
});

test("scratch: aynı lock'lu ikinci koşu kurulumu yeniden kullanır", async (t) => {
  const sh = findSh();
  if (!sh) return t.skip(SH_SKIP);
  const dir = makeTree();
  const profile = profileWith([{ path: SCRATCH, keyFile: "package-lock.json" }]);
  const exec = new ShExecutor(sh);
  try {
    await prepareScratchDirs(profile, dir, "job1", exec, () => {});
    const alpha = join(dir, "Partials", "Alpha", "wwwroot", "node_modules");
    rmSync(alpha, { recursive: true, force: true });
    mkdirSync(join(alpha, "react"), { recursive: true });
    await stashScratchDirs(profile, dir, "job1", exec, () => {});

    // BAŞKA bir iş, aynı lock dosyası: kurulum paylaşılmalı. Kazancın tamamı
    // burada — aksi hâlde her iş 17 dakikayı baştan öder (ölçüldü, 8 modül).
    const lines: string[] = [];
    const second = await prepareScratchDirs(profile, dir, "job2", exec, (_s, l) => lines.push(l));
    assert.ok(second.reused >= 1, `kurulum paylaşılmadı: ${lines.join(" | ")}`);

    const store = readlinkSync(alpha);
    assert.ok(readdirSync(store).includes("react"), "paylaşılan store boş");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync("/tmp/ahtapot-scratch", { recursive: true, force: true });
  }
});
