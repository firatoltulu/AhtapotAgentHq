import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { eq } from "drizzle-orm";

import { ProjectProfileSchema, TestSchema, type ProjectProfile } from "@ahtapot/shared";

import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { EventHub } from "../ws/hub.js";
import { HostExecutor } from "./executor.js";
import { TestGate, diffAgainstBaseline, measureBaseline, parseJunit, parseTrx } from "./tests.js";

const NODE = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
const js = (code: string) => `${NODE} -e "${code.replace(/"/g, '\\"')}"`;

test("trx: sayaçlar ve kırık test adları", () => {
  const xml = `<TestRun><Results>
    <UnitTestResult testName="A.Ok" outcome="Passed" />
    <UnitTestResult testName="A.Bad" outcome="Failed" />
    <UnitTestResult outcome="Failed" testName="B.Bad" />
  </Results><ResultSummary><Counters total="4" executed="4" passed="2" failed="2" /></ResultSummary></TestRun>`;
  const r = parseTrx(xml);
  assert.deepEqual([r.total, r.passed, r.failed, r.skipped], [4, 2, 2, 0]);
  assert.deepEqual(r.failedNames, ["A.Bad", "B.Bad"]);
});

test("junit: toplamlar ve kırık case adları", () => {
  const xml = `<testsuites><testsuite name="s1" tests="3" failures="1" errors="0" skipped="1">
    <testcase name="ok"/><testcase name="kirik"><failure message="x"/></testcase><testcase name="atla"><skipped/></testcase>
  </testsuite><testsuite name="s2" tests="1" failures="0" errors="1"><testcase name="patlak"><error/></testcase></testsuite></testsuites>`;
  const r = parseJunit(xml);
  assert.deepEqual([r.total, r.passed, r.failed, r.skipped], [4, 1, 2, 1]);
  assert.deepEqual(r.failedNames, ["kirik", "patlak"]);
});

function setup(tests: z.input<typeof TestSchema>) {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-tg-"));
  const wt = join(dir, "wt");
  mkdirSync(wt);
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  execFileSync("git", ["-C", wt, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", wt, "config", "user.name", "T"]);
  writeFileSync(join(wt, "src.txt"), "v1");
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", "ilk", "--no-gpg-sign"]);
  const file = join(dir, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  const projectId = newId();
  h.db.insert(schema.projects).values({ id: projectId, slug: "t", name: "T", workspaceRoot: wt }).run();
  const jobId = newId();
  h.db.insert(schema.jobs).values({ id: jobId, projectId, title: "iş" }).run();
  const profile: ProjectProfile = ProjectProfileSchema.parse({
    version: 1, slug: "t", name: "T",
    workspace: { root: wt, rootIsRepo: true, repos: [{ name: "a", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: "x" }, build: { steps: [{ name: "b", run: "true" }] }, test: tests,
  });
  const hub = new EventHub(h.db);
  const gate = new TestGate(h.db, hub);
  const input = { jobId, profile, workdir: wt, worktreePath: wt, executor: new HostExecutor(), artifactsDir: join(dir, "art") };
  return { db: h.db, hub, gate, input, wt, jobId, cleanup() { h.sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("baseline: değişiklik stash'lenir, koşulur, geri gelir; önceden kırık ayrılır, yeni kırık kalır", async () => {
  // "pre" takımı her zaman kırık (önceden kırık); "new" takımı yalnız QA'nın yeni dosyasıyla kırılır.
  const t = setup({
    suites: [
      { id: "ok", command: { name: "ok", run: js("process.exit(0)") } },
      { id: "pre", command: { name: "pre", run: js("process.exit(1)") } },
      { id: "new", command: { name: "new", run: js("process.exit(require('fs').existsSync('tests/new.txt')?1:0)") } },
      { id: "svc", command: { name: "svc", run: "true" }, services: ["pg"] },
    ],
  });
  try {
    mkdirSync(join(t.wt, "tests"));
    writeFileSync(join(t.wt, "tests", "new.txt"), "qa yazdı");

    const baseline = await measureBaseline(t.gate, t.input);
    assert.ok(require_(t.wt, "tests/new.txt"), "stash geri gelmedi");
    assert.deepEqual(baseline.map((b) => [b.suiteId, b.failed]), [["ok", 0], ["pre", 1], ["new", 0], ["svc", 1]]);
    // Tanımsız servis takımı ATLANMAZ, kırmızıdır (eskiden atlanıp yeşil geçiyordu).
    assert.match(baseline[3]!.setupError, /tanımsız/);

    const run = await t.gate.runSuites({ ...t.input, kind: "run" });
    const results = diffAgainstBaseline(baseline, run);
    const by = Object.fromEntries(results.map((r) => [r.suiteId, r]));
    assert.equal(by["ok"]!.failed, 0);
    assert.equal(by["pre"]!.failed, 0, "önceden kırık takım kırmızı sayılmamalı");
    assert.deepEqual(by["pre"]!.preexistingFailures, ["pre (baseline da kırık)"]);
    assert.equal(by["new"]!.failed, 1, "yeni kırık kalmalı");
    assert.equal(by["svc"]!.failed, 1, "kurulamayan takım baseline ile silinmemeli");

    const rows = t.db.select().from(schema.testRuns).where(eq(schema.testRuns.jobId, t.jobId)).all();
    assert.equal(rows.filter((r) => r.kind === "baseline").length, 3);
    assert.equal(rows.filter((r) => r.kind === "run").length, 3);
    assert.ok(t.hub.replay(t.jobId, 0).some((e) => e.type === "build.log"));
  } finally {
    t.cleanup();
  }
});

test("rapor: trx dosyası çıkış kodundan bağımsız sayıları verir; sıfır çıkışla rapor kırıksa yine kırık", async () => {
  const t = setup({
    suites: [{
      id: "dotnet",
      // Komut sıfırla çıkar; rapor dosyası (önceden yazılmış) kırık test taşır.
      command: { name: "t", run: js("process.exit(0)") },
      report: { format: "trx", path: "TestResults/*.trx" },
    }],
  });
  try {
    mkdirSync(join(t.wt, "TestResults"));
    writeFileSync(join(t.wt, "TestResults", "r.trx"),
      '<TestRun><Results><UnitTestResult testName="X.Y" outcome="Failed"/></Results><ResultSummary><Counters total="3" passed="2" failed="1"/></ResultSummary></TestRun>');
    const [r] = await t.gate.runSuites({ ...t.input, kind: "run" });
    assert.deepEqual([r!.total, r!.passed, r!.failed], [3, 2, 1]);
    assert.deepEqual(r!.failedNames, ["X.Y"]);
  } finally {
    t.cleanup();
  }
});

function require_(wt: string, rel: string): boolean {
  try {
    execFileSync("git", ["-C", wt, "ls-files", "--others", "--error-unmatch", rel], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
