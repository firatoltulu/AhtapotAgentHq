import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanWorkspace, fingerprintDrift } from "./scan.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * Northwind'in yapısını taklit eden sahte workspace:
 * kök repo + gitignore'lu nested repo + büyük doküman + ignore'lu çalışma dizini.
 */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-scan-"));

  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);

  writeFileSync(join(dir, ".gitignore"), ["Nested.Lib/", ".run/", "secrets.json", ""].join("\n"));
  writeFileSync(join(dir, "App.slnx"), "<Solution />");
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "CLAUDE.md"), "# Kurallar\n".repeat(12_000)); // >100 KB
  writeFileSync(join(dir, "run.ps1"), "param()");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI");
  mkdirSync(join(dir, "deploy"), { recursive: true });
  writeFileSync(join(dir, "deploy", "docker-compose.yml"), "services: {}");

  // Gitignore'lu ama gerçek: çalışma zamanı dizini ve sır dosyası.
  mkdirSync(join(dir, ".run"), { recursive: true });
  writeFileSync(join(dir, ".run", "at.txt"), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig");
  writeFileSync(join(dir, "secrets.json"), "{}");

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "ilk", "--no-gpg-sign"]);

  // Nested repo: submodule DEĞİL, kök repo tarafından yok sayılıyor.
  const nested = join(dir, "Nested.Lib");
  mkdirSync(nested, { recursive: true });
  git(nested, ["init", "-b", "develop"]);
  git(nested, ["config", "user.email", "t@t"]);
  git(nested, ["config", "user.name", "T"]);
  writeFileSync(join(nested, "lib.ts"), "export {};");
  git(nested, ["add", "-A"]);
  git(nested, ["commit", "-m", "lib", "--no-gpg-sign"]);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("tarama: kök repo ve varsayılan dal tespit edilir", () => {
  const w = makeWorkspace();
  try {
    const r = scanWorkspace(w.dir);
    assert.equal(r.rootIsRepo, true);
    const root = r.repos.find((x) => x.path === ".");
    assert.ok(root, "kök repo bulunamadı");
    // Dal SABİT VARSAYILMAZ: Northwind main, AdventureWorks master kullanıyor.
    assert.equal(root.defaultBranch, "main");
  } finally {
    w.cleanup();
  }
});

test("tarama: gitignore'lu iç içe repo NESTED olarak işaretlenir", () => {
  const w = makeWorkspace();
  try {
    const r = scanWorkspace(w.dir);
    const nested = r.repos.find((x) => x.path === "Nested.Lib");
    assert.ok(nested, "iç içe repo bulunamadı");
    // Submodule değil: worktree'ye taşınmaz, `git clean -xfd` içeriğini siler.
    assert.equal(nested.nested, true);
    assert.equal(nested.defaultBranch, "develop");
  } finally {
    w.cleanup();
  }
});

test("tarama: gitignore'lu ama diskte var olan yollar listelenir", () => {
  const w = makeWorkspace();
  try {
    const r = scanWorkspace(w.dir);
    // Bu sınıf worktree'de kaybolur; biri kopyalanmalı (plans/), biri asla (.run/).
    assert.ok(r.ignoredButPresent.some((p) => p.startsWith(".run")), ".run/ kaçırıldı");
    assert.ok(r.ignoredButPresent.some((p) => p.startsWith("Nested.Lib")), "nested repo kaçırıldı");
  } finally {
    w.cleanup();
  }
});

test("tarama: büyük dosyalar işaretlenir", () => {
  const w = makeWorkspace();
  try {
    const r = scanWorkspace(w.dir);
    const big = r.oversizedFiles.find((f) => f.path === "CLAUDE.md");
    assert.ok(big, "büyük CLAUDE.md yakalanmadı");
    assert.ok(big.bytes > 100_000);
  } finally {
    w.cleanup();
  }
});

test("tarama: build ve çalıştırma işaretleri toplanır", () => {
  const w = makeWorkspace();
  try {
    const r = scanWorkspace(w.dir);
    assert.ok(r.markers.solutions.includes("App.slnx"));
    assert.ok(r.markers.composeFiles.includes("deploy/docker-compose.yml"));
    assert.ok(r.markers.ciWorkflows.includes(".github/workflows/ci.yml"));
    assert.ok(r.markers.scripts.includes("run.ps1"));
    assert.ok(r.markers.docs.includes("CLAUDE.md"));
  } finally {
    w.cleanup();
  }
});

test("imza: değişmeyen workspace aynı imzayı üretir", () => {
  const w = makeWorkspace();
  try {
    const a = scanWorkspace(w.dir).fingerprint;
    const b = scanWorkspace(w.dir).fingerprint;
    assert.deepEqual(a, b);
    assert.equal(fingerprintDrift(a, b).stale, false);
  } finally {
    w.cleanup();
  }
});

test("imza: solution değişince profil bayat sayılır", () => {
  const w = makeWorkspace();
  try {
    const before = scanWorkspace(w.dir).fingerprint;
    writeFileSync(join(w.dir, "App.slnx"), "<Solution><Project /></Solution>");
    const after = scanWorkspace(w.dir).fingerprint;

    const drift = fingerprintDrift(before, after);
    assert.equal(drift.stale, true);
    assert.ok(drift.changed.includes("App.slnx"));
  } finally {
    w.cleanup();
  }
});

test("imza: yeni repo eklenince bayatlık yakalanır", () => {
  const w = makeWorkspace();
  try {
    const before = scanWorkspace(w.dir).fingerprint;

    const extra = join(w.dir, "Extra.Lib");
    mkdirSync(extra, { recursive: true });
    git(extra, ["init", "-b", "main"]);
    git(extra, ["config", "user.email", "t@t"]);
    git(extra, ["config", "user.name", "T"]);
    writeFileSync(join(extra, "x.ts"), "export {};");
    git(extra, ["add", "-A"]);
    git(extra, ["commit", "-m", "x", "--no-gpg-sign"]);

    const after = scanWorkspace(w.dir).fingerprint;
    assert.equal(fingerprintDrift(before, after).stale, true);
  } finally {
    w.cleanup();
  }
});

test("tarama: olmayan workspace anlaşılır hata verir", () => {
  assert.throws(() => scanWorkspace(join(tmpdir(), "yok-boyle-bir-dizin-12345")), /bulunamadı/);
});

/**
 * Gerçek Northwind üzerinde doğrulama.
 *
 * Workspace yoksa atlanır — bu test geliştiricinin makinesinde anlamlı, CI'da
 * değil. Amacı, sentetik testlerin kaçırabileceği gerçek dünya yapısını
 * (yerel disk remote'lu nested repo, 476 KB doküman) yakalamak.
 */
test("gerçek Northwind workspace'i doğru okunur", (t) => {
  const root = "C:/src/northwind";
  if (!existsSync(root)) {
    t.skip("Northwind workspace'i bu makinede yok");
    return;
  }

  const r = scanWorkspace(root);
  assert.equal(r.rootIsRepo, true);

  const formsRepo = r.repos.find((x) => x.path === "Northwind.Forms");
  assert.ok(formsRepo, "Northwind.Forms bulunamadı");
  assert.equal(formsRepo.nested, true, "nested repo submodule sanıldı");

  assert.ok(r.ignoredButPresent.some((p) => p.startsWith(".run")), ".run/ yakalanmadı");
  assert.ok(
    r.oversizedFiles.some((f) => f.path === "CLAUDE.md"),
    "476 KB CLAUDE.md oversized olarak işaretlenmedi",
  );
  assert.ok(r.markers.solutions.includes("Northwind.slnx"));
});
