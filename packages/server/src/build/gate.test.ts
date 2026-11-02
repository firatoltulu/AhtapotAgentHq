import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { z } from "zod";

import { BuildSchema, ProjectProfileSchema, containsSecret, type ProjectProfile } from "@ahtapot/shared";

import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { EventHub } from "../ws/hub.js";
import { ContainerExecutor, HostExecutor } from "./executor.js";
import {
  BuildGate,
  ForbiddenFlagError,
  assertNoForbiddenFlags,
  changedFiles,
  containsFlag,
  selectSteps,
} from "./gate.js";

/**
 * Build kapısı testleri — gerçek süreçler, host yürütücü.
 *
 * Komutlar `node -e` ile yazıldı: Windows cmd ile Linux sh arasında aynı
 * davranır. Northwind kabul testleri #1 (yasak bayrak) ve #3 (sıra) burada.
 */

const NODE = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
const js = (code: string) => `${NODE} -e "${code.replace(/"/g, '\\"')}"`;

/** Şema GİRİŞ tipi: varsayılanlar (cwd, timeout, optional) yazılmak zorunda değil. */
function profile(build: Partial<z.input<typeof BuildSchema>>): ProjectProfile {
  return ProjectProfileSchema.parse({
    version: 1, slug: "t", name: "T",
    workspace: { root: "/w", rootIsRepo: true, repos: [{ name: "a", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: "x" },
    build: { steps: [{ name: "b", run: "true" }], ...build },
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-build-"));
  const file = join(dir, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  const projectId = newId();
  h.db.insert(schema.projects).values({ id: projectId, slug: "t", name: "T", workspaceRoot: dir }).run();
  const jobId = newId();
  h.db.insert(schema.jobs).values({ id: jobId, projectId, title: "iş" }).run();
  const hub = new EventHub(h.db);
  const gate = new BuildGate(h.db, hub);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  return {
    db: h.db, hub, gate, jobId, work, artifacts: join(dir, "artifacts"),
    run: (p: ProjectProfile, changed: string[] | null = null) =>
      gate.run({ jobId, profile: p, workdir: work, changedFiles: changed, executor: new HostExecutor(), artifactsDir: join(dir, "artifacts") }),
    logs: () => hub.replay(jobId, 0).filter((e) => e.type === "build.log").map((e) => (e.type === "build.log" ? e.line : "")),
    cleanup() { h.sqlite.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("yasak bayrak: sözcük sınırıyla eşleşir", () => {
  assert.equal(containsFlag("dotnet build X.slnx -c Release --no-restore", "-c Release"), true);
  assert.equal(containsFlag("dotnet build X.slnx -c  Release", "-c Release"), true, "çoklu boşluk");
  assert.equal(containsFlag("dotnet build X.slnx -c Debug", "-c Release"), false);
  assert.equal(containsFlag("dotnet build -c ReleaseNotes", "-c Release"), false, "önek eşleşmemeli");
  assert.equal(containsFlag("dotnet build -warnaserror", "-warnaserror"), true);
});

test("yasak bayrak: profil reddedilir, hiçbir komut koşmaz (Northwind #1)", async () => {
  const t = setup();
  try {
    const marker = join(t.work, "kostu.txt");
    const p = profile({
      preSteps: [{ name: "iz", run: js(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`) }],
      steps: [{ name: "derle", run: "dotnet build Northwind.slnx -c Release" }],
      forbiddenFlags: ["-c Release", "-warnaserror"],
    });
    assert.throws(() => assertNoForbiddenFlags(p.build), ForbiddenFlagError);
    await assert.rejects(() => t.run(p), (e: unknown) => e instanceof ForbiddenFlagError && e.flag === "-c Release");
    assert.throws(() => readFileSync(marker), "ön adım yasak bayrağa rağmen koştu");
  } finally {
    t.cleanup();
  }
});

test("adım seçimi: yalnız .tsx değişince dotnet atlanır; sözleşme testi istisnası koşturur", () => {
  const build = profile({
    steps: [
      { name: "npm", run: "npm run build", whenChanged: ["**/*.tsx", "**/*.ts", "**/package.json"] },
      { name: "dotnet", run: "dotnet build", whenChanged: ["**/*.cs", "**/*.csproj"], exceptPaths: ["Northwind.Web/src/contracts/**"] },
      { name: "hep", run: "echo" },
    ],
  }).build;

  const onlyTsx = selectSteps(build, ["Northwind.Web/src/App.tsx"]);
  assert.deepEqual(onlyTsx.map((d) => [d.step.name, d.run]), [["npm", true], ["dotnet", false], ["hep", true]]);

  const contract = selectSteps(build, ["Northwind.Web/src/contracts/Order.tsx"]);
  assert.equal(contract[1]?.run, true, "sözleşme dosyası dotnet'i koşturmalı");
  assert.match(contract[1]?.reason ?? "", /istisna/);

  // Değişiklik BİLİNMİYORSA hepsi koşar — atlamak sessiz bozuk çıktı üretir.
  assert.ok(selectSteps(build, null).every((d) => d.run));
  // Hiç değişiklik yoksa koşullu adımlar atlanır.
  assert.deepEqual(selectSteps(build, []).map((d) => d.run), [false, false, true]);
});

test("değişen dosyalar: commit'li fark + takipsiz dosyalar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-chg-"));
  try {
    const git = (a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git(["init", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "T"]);
    writeFileSync(join(dir, "a.cs"), "1"); git(["add", "-A"]); git(["commit", "-m", "ilk", "--no-gpg-sign"]);
    git(["checkout", "-q", "-b", "is"]);
    writeFileSync(join(dir, "b.tsx"), "2"); git(["add", "-A"]); git(["commit", "-m", "b", "--no-gpg-sign"]);
    writeFileSync(join(dir, "a.cs"), "degisti");          // değişmiş, commit'siz
    mkdirSync(join(dir, "x")); writeFileSync(join(dir, "x", "c.ts"), "3"); // takipsiz
    assert.deepEqual(await changedFiles(new HostExecutor(), dir, "main"), ["a.cs", "b.tsx", "x/c.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("koşu: sıra korunur, log maskelenir, dosyaya ve UI'a aynı satır gider", async () => {
  const t = setup();
  try {
    const p = profile({
      preSteps: [{ name: "hazirlik", run: js("console.log('hazir')") }],
      steps: [
        { name: "npm", run: js("console.log('npm ok'); console.log('token=sk-ant-api03-GIZLI-DEGER')") },
        { name: "dotnet", run: js("console.error('uyari'); console.log('dotnet ok')") },
      ],
    });
    const out = await t.run(p, null);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results.map((r) => [r.stepName, r.exitCode]), [["hazirlik", 0], ["npm", 0], ["dotnet", 0]]);

    const lines = t.logs();
    const order = lines.filter((l) => l.startsWith("▶")).map((l) => l.slice(2).split(":")[0]);
    assert.deepEqual(order, ["hazirlik", "npm", "dotnet"], "sıra profil sırası olmalı (Northwind #3)");
    assert.ok(lines.some((l) => l === "npm ok"));
    assert.ok(lines.some((l) => l === "uyari"));
    assert.ok(!lines.some((l) => l.includes("GIZLI-DEGER")), "sır UI'a sızdı");

    const npmLog = readFileSync(out.results[1]!.logRef, "utf8");
    assert.ok(!npmLog.includes("GIZLI-DEGER"), "sır log dosyasına sızdı");
    assert.equal(containsSecret(npmLog), false);
    assert.match(npmLog, /npm ok/);

    const rows = t.db.select().from(schema.builds).all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.exitCode === 0 && !r.skipped));
  } finally {
    t.cleanup();
  }
});

test("koşu: ön adım düşerse adımlar koşmaz; adım düşerse sonrakiler koşmaz (blocking)", async () => {
  const t = setup();
  try {
    const marker = join(t.work, "sonraki.txt");
    const write = js(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    const pre = await t.run(profile({
      preSteps: [{ name: "kopya", run: js("console.error('MSB3030'); process.exit(3)") }],
      steps: [{ name: "derle", run: write }],
    }));
    assert.equal(pre.ok, false);
    assert.deepEqual(pre.results.map((r) => [r.stepName, r.exitCode]), [["kopya", 3]]);
    assert.throws(() => readFileSync(marker), "ön adım düştü ama derleme koştu");

    const step = await t.run(profile({
      steps: [
        { name: "npm", run: js("process.exit(1)") },
        { name: "dotnet", run: write },
      ],
    }));
    assert.equal(step.ok, false);
    assert.equal(step.results.length, 1);
    assert.throws(() => readFileSync(marker), "kırmızı adımdan sonra devam edildi");
  } finally {
    t.cleanup();
  }
});

test("koşu: optional adım düşse de kapı yeşil; atlanan adım kaydedilir", async () => {
  const t = setup();
  try {
    const out = await t.run(profile({
      steps: [
        { name: "lint", run: js("process.exit(2)"), optional: true },
        { name: "dotnet", run: js("console.log('x')"), whenChanged: ["**/*.cs"] },
        { name: "npm", run: js("console.log('y')") },
      ],
    }), ["App.tsx"]);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results.map((r) => [r.stepName, r.skipped, r.exitCode]), [
      ["lint", false, 2], ["dotnet", true, null], ["npm", false, 0],
    ]);
    const skipped = t.db.select().from(schema.builds).all().find((r) => r.stepName === "dotnet");
    assert.equal(skipped?.skipped, true);
    assert.equal(skipped?.skipReason, "dokunulmadı");
  } finally {
    t.cleanup();
  }
});

test("komut satırındaki sır olaya ve DB'ye maskeli gider", async () => {
  const t = setup();
  try {
    const p = profile({ steps: [{ name: "gizli", run: js("console.log('ok')") + " --token=sk-ant-api03-KOMUTTAKI-SIR" }] });
    await t.run(p);
    assert.ok(!t.logs().some((l) => l.includes("KOMUTTAKI-SIR")), "komut satırı UI'a sızdı");
    const row = t.db.select().from(schema.builds).all()[0];
    assert.ok(row && !row.command.includes("KOMUTTAKI-SIR"), "komut satırı DB'ye sızdı");
    assert.match(row.command, /sk-ant-api0\*\*\*/);
  } finally {
    t.cleanup();
  }
});

test("konteyner yürütücü: Docker exec reddedilirse fırlatmaz, null çıkış + stderr satırı döner", async () => {
  const fake = { exec: async () => { throw new Error("docker daemon down"); } };
  const lines: string[] = [];
  const r = await new ContainerExecutor(fake as never).run({
    command: "echo x", cwd: "/w", env: {}, timeoutMs: 1000, onLine: (s, l) => lines.push(`${s}:${l}`),
  });
  assert.equal(r.exitCode, null);
  assert.equal(r.timedOut, false);
  assert.ok(lines.some((l) => l.startsWith("stderr:") && l.includes("docker daemon down")));
});

test("koşu: zaman aşımı süreci öldürür ve null çıkış kodu döner", async () => {
  const t = setup();
  try {
    const p = profile({ steps: [{ name: "asili", run: js("setTimeout(()=>{}, 60000)"), timeoutMinutes: 1 }] });
    // Şemada dakika var; test için milisaniyeye inmek gerekiyor.
    const step = p.build.steps[0]!;
    (step as { timeoutMinutes: number }).timeoutMinutes = 0.002; // ~120 ms
    const started = Date.now();
    const out = await t.run(p);
    assert.equal(out.ok, false);
    assert.equal(out.results[0]?.exitCode, null);
    assert.ok(Date.now() - started < 10_000, "zaman aşımı işlemedi");
    assert.ok(t.logs().some((l) => l.includes("zaman aşımı")));
  } finally {
    t.cleanup();
  }
});
