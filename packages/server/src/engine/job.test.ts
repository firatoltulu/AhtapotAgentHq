import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { PlanDocumentSchema, ProjectProfileSchema } from "@ahtapot/shared";

import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import type { AgentRunner, RunOptions, RunResult } from "../agents/runner.js";
import type { AgentTransport } from "../agents/transport.js";
import { approveProfile, saveProfileDraft } from "../analyst/analyst.js";
import { BuildGate } from "../build/gate.js";
import { TestGate } from "../build/tests.js";
import { HostExecutor } from "../build/executor.js";
import type { WorktreeSite } from "../git/github.js";
import { WorktreeManager } from "../workspace/worktree.js";
import { EventHub } from "../ws/hub.js";
import { EngineError, JobEngine, renderPlannerPrompt, type PhaseGatePayload, type PrGatePayload } from "./job.js";
import type { DeveloperRuntime } from "./runtime.js";

const NODE = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
const js = (code: string) => `${NODE} -e "${code.replace(/"/g, '\\"')}"`;

/** Developer'ın yaptığını taklit eder: worktree'ye dosya yazar, handoff bloğu döner. */
function developerResponse(cwd: string, file: string, content: string, withHandoff = true): string {
  writeFileSync(join(cwd, file), content);
  if (!withHandoff) return "Yazdım ama blok unutmuşum.";
  const h = { completedSteps: [`${file} yazıldı`], keyDecisions: ["basit tutuldu"], gotchas: ["dikkat"], filesTouched: [file], nextAction: "onay" };
  return `Bitti.\n\`\`\`HANDOFF_JSON\n${JSON.stringify(h)}\n\`\`\``;
}

/** QA'nın case listesi. */
function qaCasesBlock(): string {
  const doc = { cases: [
    { id: "c1", title: "Login başarılı", rationale: "ana yol" },
    { id: "c2", title: "Yanlış şifre 401", rationale: "hata yolu" },
  ] };
  return `Liste hazır.\n\`\`\`QA_CASES_JSON\n${JSON.stringify(doc)}\n\`\`\``;
}

/** QA'nın test yazması: tests/new.txt içeriği takımın kaderini belirler. */
function qaTestsResponse(cwd: string, content: string): string {
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests", "new.txt"), content);
  const h = { completedSteps: ["c1 testi", "c2 testi"], filesTouched: ["tests/new.txt"], nextAction: "koştur" };
  return `Testler yazıldı.\n\`\`\`HANDOFF_JSON\n${JSON.stringify(h)}\n\`\`\``;
}

/**
 * İş motoru testleri — gerçek git worktree, sahte Planner.
 *
 * Sahte runner çağrıları kaydeder: hangi cwd, hangi araçlar, hangi oturum.
 * Motorun Planner'a NE verdiği, Planner'ın ne söylediği kadar önemli.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function planBlock(summary: string, files: string[] = ["src/a.cs", "src/b.cs"]): string {
  const doc = {
    summary,
    targetRepos: ["app"],
    phases: [
      { id: "p1", order: 0, title: "Model", files, risk: "low" },
      { id: "p2", order: 1, title: "Uç", files: ["src/c.cs"], risk: "medium" },
    ],
    testStrategy: "birim",
  };
  return `Plan hazır.\n\`\`\`PLAN_JSON\n${JSON.stringify(doc)}\n\`\`\``;
}

/** Sahte GitHub: push/PR/check çağrılarını kaydeder; check sonuçları sıralı verilir. */
function fakeGithub(checkSequence: ("pending" | "success" | "failure")[][] = [[]]) {
  const calls: { kind: string; args: unknown }[] = [];
  const seq = [...checkSequence];
  return {
    calls,
    async push(site: WorktreeSite, remote: string, branch: string) { calls.push({ kind: "push", args: { remote, branch } }); void site; },
    async createDraftPr(_site: WorktreeSite, input: { repo: string; base: string; head: string; title: string; body: string; labels: string[] }) {
      calls.push({ kind: "pr", args: input });
      return { number: 42, url: `https://github.com/${input.repo}/pull/42` };
    },
    async checks(_repo: string, _n: number) {
      const next = seq.length > 1 ? seq.shift()! : seq[0]!;
      calls.push({ kind: "checks", args: next });
      return next.map((status, i) => ({ name: `check-${i}`, status, detailsUrl: `https://github.com/acme/app/actions/runs/${100 + i}` }));
    },
    async failedLogs(_repo: string, checks: { name: string; status: string }[]) {
      calls.push({ kind: "logs", args: checks.filter((c) => c.status === "failure").map((c) => c.name) });
      return "##[error] lint: satır 12 noktalı virgül eksik";
    },
    async merge(repo: string, number: number, method: string, deleteBranch: boolean) {
      calls.push({ kind: "merge", args: { repo, number, method, deleteBranch } });
    },
    async listIssues(_repo: string) {
      return [];
    },
    async issueDetail(_repo: string, number: number) {
      return { number, url: "", title: "", labels: [], author: "?", updatedAt: "", comments: 0, body: "", thread: [] };
    },
    async listRepos() {
      return [];
    },
  };
}

/** Sahte canlı ortam: çağrıları kaydeder, hazır/hazır değil ayarlanabilir. */
function fakeLive(ready = true) {
  const calls: string[] = [];
  return {
    calls,
    async start(input: { jobId: string }) {
      calls.push("start");
      return { id: "env-1", appUrl: "http://127.0.0.1:20001", ports: [20001], expiresAt: new Date(Date.now() + 3600_000).toISOString(), ready, reason: ready ? "ok" : "log deseni yok" };
    },
    async stop(_jobId: string, _wt: string, _live: unknown, reason?: string) { calls.push(`stop:${reason ?? ""}`); return true; },
    extend(_jobId: string, minutes: number) { calls.push(`extend:${minutes}`); return new Date(Date.now() + minutes * 60_000).toISOString(); },
  };
}

function setup(responses: (string | ((opts: RunOptions) => string))[], buildRun = "true", opts: { live?: ReturnType<typeof fakeLive> | null; liveProfile?: boolean; suites?: unknown[]; caseApproval?: boolean; github?: ReturnType<typeof fakeGithub> | null; prProvider?: "github" | "none"; triage?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-engine-"));
  const src = join(dir, "src-ws");
  execFileSync("git", ["init", "-b", "main", src], { stdio: "ignore" });
  git(src, ["config", "user.email", "t@t"]);
  git(src, ["config", "user.name", "T"]);
  writeFileSync(join(src, "App.slnx"), "<Solution />");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-m", "ilk", "--no-gpg-sign"]);

  const file = join(dir, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  const projectId = newId();
  h.db.insert(schema.projects).values({ id: projectId, slug: "t", name: "T", workspaceRoot: src }).run();
  const profile = ProjectProfileSchema.parse({
    version: 1, slug: "t", name: "T",
    workspace: { root: src, rootIsRepo: true, repos: [{ name: "app", path: ".", defaultBranch: "main", primary: true, remote: "https://github.com/acme/app.git" }] },
    exec: { image: "x" },
    build: { steps: [{ name: "derle", run: buildRun }] },
    git: { pr: { provider: opts.prProvider ?? "github", labels: ["ahtapot"] } },
    // Varsayılan takım: tests/new.txt "FAIL" içeriyorsa kırık — QA'nın yazdığı test kodu kırmışsa gibi.
    test: {
      suites: opts.suites ?? [{ id: "unit", command: { name: "unit", run: js("const f=require('fs');process.exit(f.existsSync('tests/new.txt')&&f.readFileSync('tests/new.txt','utf8').includes('FAIL')?1:0)") } }],
      caseApproval: opts.caseApproval ?? true,
    },
    workflow: { developing: "phased", phaseMaxFiles: 4 },
    limits: { maxLoops: { build: 2, live: 2, qa: 2 } },
    ...(opts.triage ? { agents: { triage: opts.triage } } : {}),
    ...(opts.liveProfile
      ? { live: { app: { containerPort: 8080 }, healthcheck: { path: "/", intervalSeconds: 1, timeoutMinutes: 1 } } }
      : {}),
  });
  const profileId = saveProfileDraft(h.db, projectId, profile, null, null);
  approveProfile(h.db, profileId);

  const jobId = newId();
  h.db.insert(schema.jobs).values({ id: jobId, projectId, profileId, title: "Login ekranı", description: "Şifre sıfırlama" }).run();

  const calls: RunOptions[] = [];
  const queue = [...responses];
  const runner = {
    async run(opts: RunOptions): Promise<RunResult> {
      calls.push(opts);
      const next = queue.shift();
      const text = typeof next === "function" ? next(opts) : (next ?? "");
      return { runId: newId(), sessionId: `sdk-${opts.role}`, subtype: "success", text, costMicroUsd: 1000, numTurns: 2, quota: false };
    },
  } as unknown as AgentRunner;

  // Docker yok: taşıma sahte, her şey host'ta koşar. Üretimde worktree named
  // volume'de ve kök `/workspace`; testte kök geçici bir host dizini — kod
  // ikisini de yalnız "yürütücünün gördüğü yol" olarak bilir.
  const workdirRoot = join(dir, "data");
  const repoName = "app";
  const runtime: DeveloperRuntime = {
    async acquire() {
      return {
        transport: { start: () => { throw new Error("sahte taşıma çağrılmamalı"); } } as unknown as AgentTransport,
        executor: new HostExecutor(),
        workdir: join(workdirRoot, "worktrees", jobId, repoName),
        agentCwd: join(workdirRoot, "worktrees", jobId, repoName),
        workdirRoot,
      };
    },
    async attach() {
      return {
        transport: null as unknown as AgentTransport,
        executor: new HostExecutor(),
        workdir: join(workdirRoot, "worktrees", jobId, repoName),
        agentCwd: join(workdirRoot, "worktrees", jobId, repoName),
        workdirRoot,
      };
    },
  };

  const hub = new EventHub(h.db);
  const engine = new JobEngine({
    db: h.db, hub, runner, runtime,
    worktrees: new WorktreeManager(h.db),
    gate: new BuildGate(h.db, hub),
    tests: new TestGate(h.db, hub),
    artifactsDir: join(dir, "artifacts"),
    live: opts.live ?? null,
    github: opts.github ?? null,
    ci: { intervalMs: 10, timeoutMs: 500 },
  });
  const job = () => h.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0]!;
  const pending = () => h.db.select().from(schema.approvals).where(eq(schema.approvals.jobId, jobId)).all().filter((a) => a.status === "pending");
  const plans = () => h.db.select().from(schema.plans).where(eq(schema.plans.jobId, jobId)).orderBy(schema.plans.version).all();
  return {
    db: h.db, hub, engine, jobId, calls, job, pending, plans, src,
    cleanup() { h.sqlite.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

test("başlat: Draft → Planning → PlanReview; worktree hazır, plan v1, kapı açık", async () => {
  const t = setup([planBlock("v1")]);
  try {
    const { planning } = t.engine.start(t.jobId);
    assert.equal(t.job().state, "Planning");
    assert.equal(t.job().phase, "starting");
    await planning;

    const j = t.job();
    assert.equal(j.state, "PlanReview");
    assert.equal(j.phase, "waiting");
    assert.ok(j.worktreePath && existsSync(join(j.worktreePath, "App.slnx")), "worktree hazırlanmadı");
    assert.match(j.branchName ?? "", /^ahtapot\/.*-login-ekrani$/);

    // Planner'a verilen: worktree cwd, salt okunur araçlar, iş başlığı.
    const call = t.calls[0]!;
    assert.equal(call.cwd, j.worktreePath);
    // Web araçları insan kararıyla açık (01-decisions §12 değil, agents bölümü):
    // Planner sürüm notu/kütüphane sınırı gibi şeyleri kendi doğrulayabilsin.
    assert.deepEqual(call.allowedTools, ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    assert.match(call.prompt, /Login ekranı/);
    assert.match(call.prompt, /developing=phased/);
    assert.equal(call.resumeSessionId, null);

    const [plan] = t.plans();
    assert.equal(plan?.version, 1);
    assert.equal(plan?.status, "under_review");
    const phases = t.db.select().from(schema.planPhases).where(eq(schema.planPhases.planId, plan!.id)).all();
    assert.equal(phases.length, 2);

    const gates = t.pending();
    assert.equal(gates.length, 1);
    assert.equal(gates[0]?.kind, "plan");

    const types = t.hub.replay(t.jobId, 0).map((e) => e.type);
    assert.ok(types.includes("approval.required"));
    assert.deepEqual(types.filter((x) => x === "job.state").length >= 3, true);
  } finally {
    t.cleanup();
  }
});

test("red: Planning'e döner, Planner AYNI oturumdan yorumla güncellenir, plan v2 + yeni kapı", async () => {
  const t = setup([planBlock("v1"), planBlock("v2")]);
  try {
    await t.engine.start(t.jobId).planning;
    const gate = t.pending()[0]!;

    const r = t.engine.decide(gate.id, "reject", "safha 1 çok geniş", undefined);
    assert.equal(r.state, "Planning");
    await r.planning;

    assert.equal(t.job().state, "PlanReview");
    const second = t.calls[1]!;
    assert.equal(second.resumeSessionId, "sdk-planner", "ikinci tur aynı oturumdan sürmeli");
    assert.match(second.prompt, /<feedback>[\s\S]*safha 1 çok geniş/);

    const ps = t.plans();
    assert.deepEqual(ps.map((p) => [p.version, p.status]), [[1, "rejected"], [2, "under_review"]]);
    const gates = t.db.select().from(schema.approvals).where(eq(schema.approvals.jobId, t.jobId)).all();
    assert.deepEqual(gates.map((g) => g.status).sort(), ["pending", "rejected"]);
    assert.equal(gates.find((g) => g.status === "rejected")?.comment, "safha 1 çok geniş");
  } finally {
    t.cleanup();
  }
});

test("düzenleme pahalı safha getirirse plan ONAYLANMAZ, kapı yeniden açılır", async () => {
  // İnsan ucuz bir planı onaylarken düzenleyip pahalı bir safha ekleyebilir.
  // O safhayı kapı ekranında GÖRMEDİ — düzenlemesi onu yeni doğurdu. Önceki
  // sürümün onayını yeni plana taşımak, görülmemiş bir `frontier` seçimini
  // onaylanmış saymak olurdu ve iş anında `Developing`e geçerdi.
  const t = setup([planBlock("ucuz plan")], "true", {
    triage: { enabled: true, stages: { intake: false, postplan: false, perPhase: true } },
  });
  try {
    await t.engine.start(t.jobId).planning;
    const gate = t.pending()[0]!;

    // Düzenleme: eşzamanlılık + geri dönüşsüzlük ölçümü taşıyan safha ekle.
    // `deriveTier` bunu `frontier`a çıkarır, `approvalRequiredFrom` onay ister.
    const edited = {
      summary: "düzenlenmiş",
      targetRepos: ["app"],
      phases: [
        { id: "p1", order: 0, title: "Model", files: ["src/a.cs"], risk: "low" },
        {
          id: "p2", order: 1, title: "Yarış koşulu", files: ["src/c.cs", "src/d.cs", "src/e.cs"], risk: "high",
          triage: {
            scope: { layers: ["api", "db"], multiTenantImpact: { level: "medium" } },
            ambiguity: { overall: { level: "medium" } },
            risk: { irreversible: { level: "medium" }, concurrency: { level: "high" }, changeKind: "mixed" },
          },
        },
      ],
      testStrategy: "birim",
    };

    const r = t.engine.decide(gate.id, "approve", "", edited);

    // İŞ DEVELOPING'E GEÇMEDİ: karar insana döndü.
    assert.equal(r.state, "PlanReview");
    assert.equal(t.job().state, "PlanReview");
    assert.equal(t.job().phase, "waiting");

    // Yeni sürüm ONAYLI DEĞİL; eskisi superseded.
    const ps = t.plans();
    assert.deepEqual(ps.map((p) => [p.version, p.status]), [[1, "superseded"], [2, "under_review"]]);

    // Taze kapı açıldı ve yeni plana bakıyor — eskisinin subjectId'si taşınmadı.
    const fresh = t.pending();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]?.kind, "plan");
    const newPlanId = ps.find((p) => p.version === 2)!.id;
    assert.equal(fresh[0]?.subjectId, newPlanId);
    assert.notEqual(fresh[0]?.id, gate.id, "eski kapı yeniden kullanılmamalı");

    // Kapı yükü pahalı safhayı insana gösteriyor.
    const pm = (fresh[0]?.payload as { phaseModels?: { order: number; tier: string; requiresApproval: boolean }[] }).phaseModels ?? [];
    const pricey = pm.filter((x) => x.requiresApproval);
    assert.equal(pricey.length, 1, `beklenen tek pahalı safha, gelen: ${JSON.stringify(pm)}`);
    assert.equal(pricey[0]?.order, 1);
    assert.equal(pricey[0]?.tier, "frontier");

    // Onay kaydı YAZILMADI: insan henüz onaylamadı.
    const audits = t.db.select().from(schema.auditLog).all()
      .filter((a) => a.action === "model.approve" && a.subjectType === "phase");
    assert.equal(audits.length, 0, "görülmemiş safha için onay kaydı yazılmamalı");
  } finally {
    t.cleanup();
  }
});

test("onay: plan approved, Developer safha 1'i yazar, build yeşil, safha kapısı diff ile açılır", async () => {
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "class A {}"),
  ]);
  try {
    await t.engine.start(t.jobId).planning;
    const gate = t.pending()[0]!;
    const r = t.engine.decide(gate.id, "approve", "", undefined);
    assert.equal(r.state, "Developing");
    assert.equal(t.plans()[0]?.status, "approved");
    assert.throws(() => t.engine.decide(gate.id, "approve", "", undefined), (e: unknown) => e instanceof EngineError && e.code === "bad_state");
    await r.developing;

    const j = t.job();
    assert.equal(j.state, "Developing");
    assert.equal(j.phase, "waiting");

    // Developer'a verilen: worktree cwd, safha promptu, canlı kanal, bypass izni.
    const dev = t.calls[1]!;
    assert.equal(dev.role, "developer");
    assert.equal(dev.cwd, j.worktreePath);
    assert.match(dev.prompt, /BU SAFHA: 1\. Model/);
    assert.match(dev.prompt, /src\/a\.cs/);
    assert.equal(dev.permissionMode, "bypassPermissions");
    assert.ok(dev.channel, "canlı kanal verilmedi");
    assert.ok(dev.disallowedTools?.some((x) => x.includes("git commit")), "commit yasağı yok");

    // Build koştu, safha onay bekliyor, kapı diff'i ve handoff'u taşıyor.
    const builds = t.db.select().from(schema.builds).where(eq(schema.builds.jobId, t.jobId)).all();
    assert.equal(builds.length, 1);
    assert.equal(builds[0]?.exitCode, 0);
    const phases = t.db.select().from(schema.planPhases).where(eq(schema.planPhases.jobId, t.jobId)).orderBy(schema.planPhases.order).all();
    assert.equal(phases[0]?.status, "awaiting_approval");
    const pg = t.pending()[0]!;
    assert.equal(pg.kind, "phase");
    const payload = pg.payload as PhaseGatePayload;
    assert.equal(payload.handoff.synthesized, false);
    assert.deepEqual(payload.handoff.filesTouched, ["a.cs"]);
    assert.ok(payload.diff.untracked.includes("a.cs"), "yeni dosya diff özetinde yok");
    assert.equal(payload.build[0]?.stepName, "derle");

    const types = t.hub.replay(t.jobId, 0).map((e) => e.type);
    assert.ok(types.includes("build.log"));
    assert.equal(types.filter((x) => x === "approval.required").length, 2);
  } finally {
    t.cleanup();
  }
});

test("tam hat: safha onayı → commit → safha 2 → QA case kapısı (düzenleme) → QA testleri → baseline + koşu → PRReview → Done", async () => {
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "class A {}"),
    (o) => developerResponse(o.cwd, "c.cs", "class C {}"),
    qaCasesBlock(),
    (o) => qaTestsResponse(o.cwd, "OK"),
  ]);
  try {
    await t.engine.start(t.jobId).planning;
    const planGate = t.pending()[0]!;
    await t.engine.decide(planGate.id, "approve", "", undefined).developing;

    const g1 = t.pending()[0]!;
    const r1 = t.engine.decide(g1.id, "approve", "", undefined);
    await r1.developing;

    const wt = t.job().worktreePath!;
    const log = execFileSync("git", ["log", "--oneline"], { cwd: wt, encoding: "utf8" }).trim().split("\n");
    assert.equal(log.length, 2, "safha commit'i yok");
    assert.match(log[0] ?? "", /safha 1: Model/);

    // Safha 2 Developer'ı önceki handoff'u gördü ve aynı oturumdan sürdü.
    const dev2 = t.calls[2]!;
    assert.match(dev2.prompt, /BU SAFHA: 2\. Uç/);
    assert.match(dev2.prompt, /Tuzaklar: dikkat/);
    assert.equal(dev2.resumeSessionId, "sdk-developer");

    const g2 = t.pending()[0]!;
    assert.equal((g2.payload as PhaseGatePayload).order, 1);
    await t.engine.decide(g2.id, "approve", "", undefined).developing;

    // QA case kapısı: QA salt okunur koştu, liste DB'de, kapı açık.
    assert.equal(t.job().state, "QACases");
    assert.equal(t.job().phase, "waiting");
    const qaCall = t.calls[3]!;
    assert.equal(qaCall.role, "qa");
    assert.deepEqual(qaCall.allowedTools, ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    assert.match(qaCall.prompt, /Bu işte değişen dosyalar[\s\S]*a\.cs/);
    const cg = t.pending()[0]!;
    assert.equal(cg.kind, "qa_cases");
    const listed = (cg.payload as { cases: { id: string; title: string; included: boolean }[] }).cases;
    assert.equal(listed.length, 2);

    // İnsan: c2'yi çıkar, kendi case'ini ekle.
    const edits = { cases: [
      { ...listed[0]!, included: true },
      { ...listed[1]!, included: false },
      { id: "yeni", title: "Boş şifre reddedilir", rationale: "insan ekledi", origin: "human", included: true },
    ] };
    const rq = t.engine.decide(cg.id, "approve", "", edits);
    assert.equal(rq.state, "QA");
    await rq.developing;

    // QA testleri onaylı listeyle yazdı (c2 yok, insan case'i var), konteyner izniyle.
    const qaWrite = t.calls[4]!;
    assert.equal(qaWrite.role, "qa");
    assert.equal(qaWrite.permissionMode, "bypassPermissions");
    assert.match(qaWrite.prompt, /Login başarılı/);
    assert.match(qaWrite.prompt, /Boş şifre reddedilir[^\n]*insan ekledi/);
    assert.ok(!qaWrite.prompt.includes("Yanlış şifre 401"), "çıkarılan case QA'ya gitti");
    const rows = t.db.select().from(schema.qaCases).where(eq(schema.qaCases.jobId, t.jobId)).all();
    assert.equal(rows.filter((r) => r.origin === "human").length, 1);
    assert.equal(rows.find((r) => r.title === "Yanlış şifre 401")?.included, false);

    // Baseline + koşu kaydedildi; yeşil → PRReview kapısı.
    const runs = t.db.select().from(schema.testRuns).where(eq(schema.testRuns.jobId, t.jobId)).all();
    assert.deepEqual(runs.map((r) => r.kind).sort(), ["baseline", "run"]);
    assert.equal(t.job().state, "PRReview");
    const pg = t.pending()[0]!;
    assert.equal(pg.kind, "pr_open");
    const pp = pg.payload as PrGatePayload;
    assert.equal(pp.results[0]?.failed, 0);
    assert.match(pp.branch ?? "", /^ahtapot\//);

    const done = t.engine.decide(pg.id, "approve", "", undefined);
    assert.equal(done.state, "Done");
    assert.ok(t.job().completedAt, "completedAt damgalanmadı");
    const phases = t.db.select().from(schema.planPhases).where(eq(schema.planPhases.jobId, t.jobId)).all();
    assert.ok(phases.every((p) => p.status === "approved"));
  } finally {
    t.cleanup();
  }
});

test("QA kırmızı: test düzeltmesi safhası → Developer → onay → QA yeniden (liste sorulmaz) → yeşil → PRReview", async () => {
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "1"),
    (o) => developerResponse(o.cwd, "c.cs", "2"),
    qaCasesBlock(),
    (o) => qaTestsResponse(o.cwd, "FAIL"),          // kırmızı
    (o) => developerResponse(o.cwd, "a.cs", "fix"),  // düzeltme safhası
    (o) => qaTestsResponse(o.cwd, "OK"),            // QA tekrar, liste sorulmadan
  ]);
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t.pending()[0]!.kind, "qa_cases");
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;

    // Kırmızı → düzeltme safhası açıldı, Developer test geri bildirimiyle koştu.
    assert.equal(t.job().state, "Developing");
    assert.deepEqual(t.job().loopCounts, { qa: 1 });
    assert.match(t.calls[5]!.prompt, /Testler KIRMIZI[\s\S]*Takım unit: 1 kırık/);
    assert.match(t.calls[5]!.prompt, /Test düzeltmesi 1/);
    assert.equal(t.pending()[0]!.kind, "phase");

    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    // Liste yeniden sorulmadı: 7. çağrı QA test yazma (rol qa, bypass).
    assert.equal(t.calls.length, 7);
    assert.equal(t.calls[6]!.role, "qa");
    assert.equal(t.calls[6]!.permissionMode, "bypassPermissions");
    assert.equal(t.job().state, "PRReview");
  } finally {
    t.cleanup();
  }
});

test("canlı test: son safha onayı → ortam kalkar → live_test kapısı; onay → yıkılır, QACases", async () => {
  const live = fakeLive(true);
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "1"),
    (o) => developerResponse(o.cwd, "c.cs", "2"),
    qaCasesBlock(),
  ], "true", { live, liveProfile: true });
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing; // safha 1
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing; // safha 2 → canlı

    assert.equal(t.job().state, "LiveTest");
    assert.equal(t.job().phase, "waiting");
    assert.deepEqual(live.calls, ["start"]);
    const g = t.pending()[0]!;
    assert.equal(g.kind, "live_test");
    const p = g.payload as { appUrl: string; round: number };
    assert.equal(p.appUrl, "http://127.0.0.1:20001");
    assert.equal(p.round, 1);
    assert.ok(t.hub.replay(t.jobId, 0).some((e) => e.type === "approval.required" && e.kind === "live_test"));

    assert.equal(t.engine.extendLive(t.jobId, 30) !== null, true);
    const r = t.engine.decide(g.id, "approve", "", undefined);
    assert.equal(r.state, "QACases");
    await r.developing;
    assert.equal(t.job().state, "QACases");
    assert.equal(t.pending()[0]?.kind, "qa_cases");
    assert.ok(live.calls.some((c) => c.startsWith("stop:")), "ortam yıkılmadı");
  } finally {
    t.cleanup();
  }
});

test("canlı test reddi: düzeltme safhası açılır, Developer yorumla koşar, tekrar canlı; tavan → NeedsAttention", async () => {
  const live = fakeLive(true);
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "1"),
    (o) => developerResponse(o.cwd, "c.cs", "2"),
    (o) => developerResponse(o.cwd, "a.cs", "duzeltme-1"),
    (o) => developerResponse(o.cwd, "a.cs", "duzeltme-2"),
  ], "true", { live, liveProfile: true });
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t.job().state, "LiveTest");

    // 1. red → düzeltme safhası → Developer → build → safha kapısı
    const r1 = t.engine.decide(t.pending()[0]!.id, "reject", "buton yanlış yerde", undefined);
    assert.equal(r1.state, "Developing");
    await r1.developing;
    const fix = t.calls[3]!;
    assert.match(fix.prompt, /<feedback>[\s\S]*buton yanlış yerde/);
    assert.match(fix.prompt, /Canlı test düzeltmesi 1/);
    assert.equal(t.job().state, "Developing");
    assert.equal(t.pending()[0]?.kind, "phase");
    assert.deepEqual(t.job().loopCounts, { live: 1 });

    // düzeltme safhası onayı → tekrar canlı (round 2)
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t.job().state, "LiveTest");
    assert.equal((t.pending()[0]!.payload as { round: number }).round, 2);

    // 2. red → düzeltme 2 → onay → canlı (round 3); 3. red tavanı aşar
    await t.engine.decide(t.pending()[0]!.id, "reject", "hâlâ yanlış", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t.job().state, "LiveTest");
    const r3 = t.engine.decide(t.pending()[0]!.id, "reject", "olmadı", undefined);
    assert.equal(r3.state, "NeedsAttention");
    assert.equal(t.job().errorCode, "live_loop");
    assert.equal(live.calls.filter((c) => c === "start").length, 3);
  } finally {
    t.cleanup();
  }
});

test("canlı test: ortam hazır olmazsa NeedsAttention, ortam yıkılmaz", async () => {
  const live = fakeLive(false);
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "1"),
    (o) => developerResponse(o.cwd, "c.cs", "2"),
  ], "true", { live, liveProfile: true });
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t.job().state, "NeedsAttention");
    assert.equal(t.job().errorCode, "live_not_ready");
    assert.deepEqual(live.calls, ["start"], "hazır olmayan ortam yıkılmamalı");
  } finally {
    t.cleanup();
  }
});

test("kırmızı build: Developer'a log ile döner, düzeltince yeşil; sayaç işler", async () => {
  // ok.txt yoksa build düşer; Developer ikinci turda yazar.
  const build = js("process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)");
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "x"),
    (o) => developerResponse(o.cwd, "ok.txt", "tamam"),
  ], build);
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;

    assert.equal(t.job().state, "Developing");
    assert.equal(t.job().phase, "waiting");
    assert.deepEqual(t.job().loopCounts, { build: 1 });
    const fix = t.calls[2]!;
    assert.match(fix.prompt, /<feedback>[\s\S]*Build KIRMIZI[\s\S]*Düşen adım: derle/);
    assert.equal(fix.resumeSessionId, "sdk-developer");
    const builds = t.db.select().from(schema.builds).where(eq(schema.builds.jobId, t.jobId)).all();
    assert.deepEqual(builds.map((b) => b.exitCode), [1, 0]);
  } finally {
    t.cleanup();
  }
});

test("kırmızı build tavanı: NeedsAttention", async () => {
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "1"),
    (o) => developerResponse(o.cwd, "a.cs", "2"),
    (o) => developerResponse(o.cwd, "a.cs", "3"),
  ], js("process.exit(1)"));
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t.job().state, "NeedsAttention");
    assert.equal(t.job().errorCode, "build_loop");
    assert.equal(t.calls.length, 4, "tavan sonrası Developer yine çağrıldı");
  } finally {
    t.cleanup();
  }
});

test("handoff yoksa diff'ten sentezlenir ve işaretlenir; safha reddi aynı safhayı yorumla yeniden koşturur", async () => {
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "1", false),
    (o) => developerResponse(o.cwd, "a.cs", "2"),
  ]);
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;

    const g = t.pending()[0]!;
    const p = g.payload as PhaseGatePayload;
    assert.equal(p.handoff.synthesized, true);
    assert.deepEqual(p.handoff.filesTouched, ["a.cs"]);
    const arts = t.db.select().from(schema.artifacts).where(eq(schema.artifacts.jobId, t.jobId)).all();
    assert.equal(arts[0]?.type, "handoff");

    await t.engine.decide(g.id, "reject", "isim kötü", undefined).developing;
    assert.match(t.calls[2]!.prompt, /<feedback>[\s\S]*isim kötü/);
    const g2 = t.pending()[0]!;
    assert.equal((g2.payload as PhaseGatePayload).order, 0, "red sonrası aynı safha olmalı");
    assert.equal((g2.payload as PhaseGatePayload).handoff.synthesized, false);
  } finally {
    t.cleanup();
  }
});

test("onay + düzenleme: insanın planı doğrulanıp onaylı yeni sürüm olur", async () => {
  const t = setup([planBlock("v1"), (o) => developerResponse(o.cwd, "a.cs", "x")]);
  try {
    await t.engine.start(t.jobId).planning;
    const gate = t.pending()[0]!;
    const edited = { ...(gate.payload as { plan: Record<string, unknown> }).plan, summary: "insan düzeltti" };
    await t.engine.decide(gate.id, "approve", "", edited).developing;
    const ps = t.plans();
    assert.deepEqual(ps.map((p) => [p.version, p.status]), [[1, "superseded"], [2, "approved"]]);
    assert.equal((ps[1]?.document as { summary: string }).summary, "insan düzeltti");

    // Bozuk düzenleme reddedilir.
    const t2 = setup([planBlock("v1")]);
    try {
      await t2.engine.start(t2.jobId).planning;
      const g2 = t2.pending()[0]!;
      assert.throws(() => t2.engine.decide(g2.id, "approve", "", { summary: "" }), (e: unknown) => e instanceof EngineError && e.code === "bad_edits");
      assert.equal(t2.job().state, "PlanReview");
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test("blok yok: bir kez dürtülür, yine yoksa NeedsAttention", async () => {
  const t = setup(["plan yazdım ama blok yok", "yine yok"]);
  try {
    await t.engine.start(t.jobId).planning;
    assert.equal(t.job().state, "NeedsAttention");
    assert.equal(t.job().errorCode, "no_plan");
    assert.equal(t.calls.length, 2);
    assert.match(t.calls[1]!.prompt, /PLAN_JSON bloğu bulunamadı/);
    assert.equal(t.calls[1]!.resumeSessionId, "sdk-planner");
  } finally {
    t.cleanup();
  }
});

test("yeniden dene: plansız NeedsAttention baştan planlar, hata damgası silinir", async () => {
  // Planlama düşmüş (blok yok) iş, dış engel giderilince çöpe gitmemeli.
  const t = setup(["blok yok", "yine yok", planBlock("v1")]);
  try {
    await t.engine.start(t.jobId).planning;
    assert.equal(t.job().state, "NeedsAttention");
    assert.equal(t.job().errorCode, "no_plan");

    const r = t.engine.retry(t.jobId);
    assert.equal(r.state, "Planning");
    assert.equal(t.job().errorCode, null, "hata damgası temizlenmedi");
    assert.equal(t.job().errorMessage, null);
    await r.work;

    assert.equal(t.job().state, "PlanReview");
    assert.equal(t.pending()[0]?.kind, "plan");
  } finally {
    t.cleanup();
  }
});

test("yeniden dene: onaylı planı olan NeedsAttention geliştirmeden sürer; NeedsAttention olmayan iş reddedilir", async () => {
  const t = setup([
    planBlock("v1"),
    (o) => developerResponse(o.cwd, "a.cs", "1"),
    (o) => developerResponse(o.cwd, "a.cs", "2"),
    (o) => developerResponse(o.cwd, "a.cs", "3"),
  ], js("process.exit(1)"));
  try {
    await t.engine.start(t.jobId).planning;
    assert.throws(() => t.engine.retry(t.jobId), (e: unknown) => e instanceof EngineError && e.code === "bad_state");

    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t.job().state, "NeedsAttention");
    assert.equal(t.job().errorCode, "build_loop");

    // Plan onaylı: yeniden planlanmaz, geliştirmeye döner.
    const r = t.engine.retry(t.jobId);
    assert.equal(r.state, "Developing");
    await r.work;
    assert.equal(t.plans().length, 1, "onaylı plan varken yeni sürüm üretildi");
  } finally {
    t.cleanup();
  }
});

test("dosya tavanı: agent 'aşmıyor' dese de sayı konuşur", async () => {
  const t = setup([planBlock("v1", ["a", "b", "c", "d", "e", "f"])]);
  try {
    await t.engine.start(t.jobId).planning;
    const phases = t.db.select().from(schema.planPhases).where(eq(schema.planPhases.jobId, t.jobId)).all();
    assert.equal(phases.find((p) => p.order === 0)?.exceedsFileCap, true);
    assert.equal(phases.find((p) => p.order === 1)?.exceedsFileCap, false);
  } finally {
    t.cleanup();
  }
});

test("sohbet: PlanReview'da Planner aynı oturumdan cevaplar; Draft'ta reddedilir ve kalıcılaşmaz; koşu sırasında kanala düşer", async () => {
  const seen: { midRun?: { accepted: boolean; reason: string } } = {};
  const t = setup([
    // Planner koşarken gelen mesaj kanala düşmeli (tur sınırında işlenir).
    () => { seen.midRun = t.engine.chat(t.jobId, "koşarken soru"); return planBlock("v1"); },
    planBlock("v2 — soruya göre"),
  ]);
  const midRun = () => seen.midRun;
  try {
    const early = t.engine.chat(t.jobId, "merhaba");
    assert.equal(early.accepted, false);
    assert.throws(() => t.engine.chat("olmayan-is", "x"), (e: unknown) => e instanceof EngineError && e.code === "not_found");

    await t.engine.start(t.jobId).planning;
    assert.ok(midRun(), "koşu sırasında chat çağrılmadı");
    assert.equal(midRun()!.accepted, true);
    assert.match(midRun()!.reason, /tur sınırında/);
    assert.ok(t.calls[0]!.channel, "Planner canlı kanalsız koştu");
    assert.ok(t.calls[0]!.onTurn, "tur sonu geri çağrısı yok");
    assert.equal(t.engine.interrupt(t.jobId), false, "koşu bitince kesilecek kanal kalmamalı");

    const r = t.engine.chat(t.jobId, "safha 2'yi çıkar");
    assert.equal(r.accepted, true);
    await r.turn;
    assert.equal(t.job().state, "PlanReview");
    assert.match(t.calls[1]!.prompt, /safha 2'yi çıkar/);
    assert.equal(t.plans().length, 2);

    const msgs = t.db.select().from(schema.messages).where(eq(schema.messages.jobId, t.jobId)).all();
    assert.ok(msgs.some((m) => m.role === "user" && m.content === "safha 2'yi çıkar"));
    assert.ok(msgs.some((m) => m.content === "koşarken soru"));
    assert.ok(!msgs.some((m) => m.content === "merhaba"), "reddedilen mesaj kalıcılaştı");
  } finally {
    t.cleanup();
  }
});

test("kesme: Planner koşarken interrupt kanalı kapatır", async () => {
  const seen: { interrupted?: boolean } = {};
  const t = setup([() => { seen.interrupted = t.engine.interrupt(t.jobId); return planBlock("v1"); }]);
  try {
    await t.engine.start(t.jobId).planning;
    assert.equal(seen.interrupted, true);
  } finally {
    t.cleanup();
  }
});

test("başlat: Draft olmayan iş başlatılamaz", async () => {
  const t = setup([planBlock("v1")]);
  try {
    await t.engine.start(t.jobId).planning;
    assert.throws(() => t.engine.start(t.jobId), (e: unknown) => e instanceof EngineError && e.code === "bad_state");
  } finally {
    t.cleanup();
  }
});

/** Draft'tan PRReview'a kadar standart akış; sahte agent yanıtları sırayla. */
async function runToPrReview(t: ReturnType<typeof setup>) {
  await t.engine.start(t.jobId).planning;
  await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
  await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
  await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
  await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
  assert.equal(t.job().state, "PRReview");
}
const prPipeline = () => [
  planBlock("v1"),
  (o: RunOptions) => developerResponse(o.cwd, "a.cs", "1"),
  (o: RunOptions) => developerResponse(o.cwd, "c.cs", "2"),
  qaCasesBlock(),
  (o: RunOptions) => qaTestsResponse(o.cwd, "OK"),
];

test("PR: onay → QA testleri commit'lenir, gerçek remote'a push, draft PR, CI izlenir → Done", async () => {
  const gh = fakeGithub([[ "pending", "pending" ], [ "success", "pending" ], [ "success", "success" ]]);
  const t = setup(prPipeline(), "true", { github: gh });
  try {
    await runToPrReview(t);
    const r = t.engine.decide(t.pending()[0]!.id, "approve", "", undefined);
    // PR PRReview'da açılır; inceleme sağlayıcısı yok → doğrudan CIWatch.
    assert.equal(r.state, "PRReview");
    await r.developing;

    assert.equal(t.job().state, "Done");
    const wt = t.job().worktreePath!;
    const log = execFileSync("git", ["log", "--oneline"], { cwd: wt, encoding: "utf8" }).trim().split("\n");
    assert.match(log[0] ?? "", /test: QA testleri/, "QA testleri commit'lenmedi");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(), "", "worktree kirli kaldı");

    const push = gh.calls.find((c) => c.kind === "push")!.args as { remote: string; branch: string };
    assert.equal(push.remote, "https://github.com/acme/app.git", "mirror'a değil gerçek remote'a push");
    assert.match(push.branch, /^ahtapot\//);
    const pr = gh.calls.find((c) => c.kind === "pr")!.args as { repo: string; base: string; head: string; title: string; body: string; labels: string[] };
    assert.equal(pr.repo, "acme/app");
    assert.equal(pr.base, "main");
    assert.equal(pr.head, push.branch);
    assert.equal(pr.title, "Login ekranı");
    assert.deepEqual(pr.labels, ["ahtapot"]);
    assert.match(pr.body, /## Plan[\s\S]*1\. Model[\s\S]*## Testler[\s\S]*unit: /);

    const rows = t.db.select().from(schema.pullRequests).where(eq(schema.pullRequests.jobId, t.jobId)).all();
    assert.equal(rows[0]?.number, 42);
    assert.equal(rows[0]?.ciStatus, "success");
    assert.equal(gh.calls.filter((c) => c.kind === "checks").length, 3, "CI yoklaması sırayla ilerlemeli");
    assert.ok(t.job().completedAt);
  } finally {
    t.cleanup();
  }
});

test("PR: CI kırmızı → NeedsAttention (ci_failed); check'i olmayan repo → Done", async () => {
  const bad = setup(prPipeline(), "true", { github: fakeGithub([[ "success", "failure" ]]) });
  try {
    await runToPrReview(bad);
    await bad.engine.decide(bad.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(bad.job().state, "NeedsAttention");
    assert.equal(bad.job().errorCode, "ci_failed");
    assert.match(bad.job().errorMessage ?? "", /check-1/);
  } finally {
    bad.cleanup();
  }
  const none = setup(prPipeline(), "true", { github: fakeGithub([[]]) });
  try {
    await runToPrReview(none);
    await none.engine.decide(none.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(none.job().state, "Done");
  } finally {
    none.cleanup();
  }
});

test("PR: sağlayıcı none ise PR açılmaz, onay işi bitirir; red düzeltme safhası açar", async () => {
  const gh = fakeGithub();
  const t = setup([...prPipeline(), (o: RunOptions) => developerResponse(o.cwd, "a.cs", "pr-fix")], "true", { github: gh, prProvider: "none" });
  try {
    await runToPrReview(t);
    const rej = t.engine.decide(t.pending()[0]!.id, "reject", "değişken adı kötü", undefined);
    assert.equal(rej.state, "Developing");
    await rej.developing;
    assert.match(t.calls[5]!.prompt, /PR incelemesinde kusur[\s\S]*değişken adı kötü/);
    assert.equal(t.pending()[0]?.kind, "phase");
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;
    // Düzeltme sonrası QA yeniden (liste sorulmadan) → kuyruk bitti → QA metni boş → handoff sentezlenir, test yeşil → PRReview
    assert.equal(t.job().state, "PRReview");
    const done = t.engine.decide(t.pending()[0]!.id, "approve", "", undefined);
    assert.equal(done.state, "Done");
    assert.equal(gh.calls.length, 0, "sağlayıcı none iken GitHub'a dokunulmamalı");
  } finally {
    t.cleanup();
  }
});

test("DevOps: CI kırmızı → log ile düzeltme → commit + push → yeşil → Done; tavan → NeedsAttention", async () => {
  // 1. yoklama kırmızı, DevOps düzeltir, 2. yoklama yeşil.
  const gh = fakeGithub([[ "failure" ], [ "success" ]]);
  const t = setup([...prPipeline(), (o: RunOptions) => developerResponse(o.cwd, "ci.yml", "fixed")], "true", { github: gh });
  try {
    await runToPrReview(t);
    await t.engine.decide(t.pending()[0]!.id, "approve", "", undefined).developing;

    assert.equal(t.job().state, "Done");
    const devops = t.calls[5]!;
    assert.equal(devops.role, "devops");
    assert.equal(devops.resumeSessionId, null, "DevOps iterasyon başına yeni oturum");
    assert.match(devops.prompt, /check-0/);
    assert.match(devops.prompt, /noktalı virgül eksik/);
    assert.ok(devops.disallowedTools?.some((x) => x.includes("gh pr merge")), "gh pr merge yasağı yok");
    assert.ok(devops.disallowedTools?.some((x) => x.includes("git push")), "git push yasağı yok");

    const wt = t.job().worktreePath!;
    const log = execFileSync("git", ["log", "--oneline"], { cwd: wt, encoding: "utf8" }).trim().split("\n");
    assert.match(log[0] ?? "", /ci: DevOps düzeltmesi 1/);
    assert.equal(gh.calls.filter((c) => c.kind === "push").length, 2, "düzeltme push'lanmadı");
    assert.deepEqual(gh.calls.find((c) => c.kind === "logs")!.args, ["check-0"]);
    const pr = t.db.select().from(schema.pullRequests).where(eq(schema.pullRequests.jobId, t.jobId)).all()[0];
    assert.equal(pr?.ciStatus, "success");
  } finally {
    t.cleanup();
  }

  // Hep kırmızı: maxIterations (2) sonra NeedsAttention, DevOps tam 2 kez çağrılır.
  const gh2 = fakeGithub([[ "failure" ]]);
  const t2 = setup([...prPipeline(), (o: RunOptions) => developerResponse(o.cwd, "ci.yml", "1"), (o: RunOptions) => developerResponse(o.cwd, "ci.yml", "2")], "true", { github: gh2 });
  try {
    await runToPrReview(t2);
    await t2.engine.decide(t2.pending()[0]!.id, "approve", "", undefined).developing;
    assert.equal(t2.job().state, "NeedsAttention");
    assert.equal(t2.job().errorCode, "ci_failed");
    assert.equal(t2.calls.filter((c) => c.role === "devops").length, 2);
    assert.equal(gh2.calls.filter((c) => c.kind === "push").length, 3);
  } finally {
    t2.cleanup();
  }
});

test("soru: agent askUser ile sorar, answer() çözer; süre dolunca varsayımla devam; yanlış kimlik false", async () => {
  const seen: { answer?: Promise<string> } = {};
  const t = setup([
    (o) => { seen.answer = o.askUser!({ questionId: "q-x", text: "Hangi yol?", options: ["A", "B"] }); return planBlock("v1"); },
  ]);
  try {
    const { planning } = t.engine.start(t.jobId);
    // Worktree hazırlığı (git clone) soru sorulmadan önce sürer; soruyu yokla.
    for (let i = 0; i < 200 && t.engine.pendingQuestions(t.jobId).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(t.engine.pendingQuestions(t.jobId), ["q-x"]);
    assert.equal(t.engine.answer("yok", "x"), false);
    assert.equal(t.engine.answer("q-x", "B"), true);
    assert.equal(await seen.answer, "B");
    assert.deepEqual(t.engine.pendingQuestions(t.jobId), []);
    await planning;
    assert.equal(t.calls[0]!.askTimeoutMinutes, 30, "profil askTimeoutMinutes runner'a gitmeli");
  } finally {
    t.cleanup();
  }
});

test("referans depolar Planner promptuna salt okunur olarak basılır", () => {
  const profile = ProjectProfileSchema.parse({
    version: 1, slug: "t", name: "T",
    workspace: {
      root: "/ws", rootIsRepo: true,
      repos: [{ name: "app", path: ".", defaultBranch: "main", primary: true }],
      referenceRepos: [
        { name: "Contoso", gitUrl: "https://github.com/org/contoso.git", note: "kaynak sistem", searchPaths: ["Modules", "Plugins"] },
        { name: "Eski", gitUrl: "https://github.com/org/eski.git" },
      ],
    },
    exec: { image: "x" },
    build: { steps: [{ name: "derle", run: "echo" }] },
    workflow: { developing: "phased", phaseMaxFiles: 4 },
  });
  const job = { title: "Collection", description: "", targetRepos: [], referencePaths: [] } as unknown as typeof schema.jobs.$inferSelect;
  const prompt = renderPlannerPrompt(job, profile, "/wt");

  assert.match(prompt, /SALT OKUNUR/);
  assert.match(prompt, /Contoso: \/references\/Contoso — kaynak sistem/);
  assert.match(prompt, /Modules, Plugins/);
  assert.match(prompt, /Eski: \/references\/Eski/, "notsuz referans depo da basılmalı");
  // Değişikliğin nereye yazılacağı belirsiz kalmamalı.
  assert.match(prompt, /Değişiklik YALNIZ buraya/);
});

test("referans depo yoksa prompta başlık bile eklenmez", () => {
  const profile = ProjectProfileSchema.parse({
    version: 1, slug: "t", name: "T",
    workspace: { root: "/ws", rootIsRepo: true, repos: [{ name: "app", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: "x" },
    build: { steps: [{ name: "derle", run: "echo" }] },
    workflow: { developing: "phased", phaseMaxFiles: 4 },
  });
  const job = { title: "X", description: "", targetRepos: [], referencePaths: [] } as unknown as typeof schema.jobs.$inferSelect;
  assert.doesNotMatch(renderPlannerPrompt(job, profile, "/wt"), /Referans depolar/);
});

test("açık sorular: düz metin de nesne de okunur (eski planlar kırılmaz)", () => {
  const doc = PlanDocumentSchema.parse({
    summary: "s",
    phases: [{ id: "p1", order: 0, title: "p", files: ["a.cs"] }],
    openQuestions: [
      "eski biçim: düz dize",
      { question: "yeni biçim", options: ["A", "B"], recommended: "A", assumption: "A varsayılır", blocksPlan: true },
    ],
  });
  assert.equal(doc.openQuestions[0]?.question, "eski biçim: düz dize");
  assert.deepEqual(doc.openQuestions[0]?.options, [], "dizeden gelen soruda şık olmaz");
  assert.equal(doc.openQuestions[0]?.blocksPlan, false);
  assert.equal(doc.openQuestions[1]?.recommended, "A");
  assert.equal(doc.openQuestions[1]?.blocksPlan, true);
});

test("soru cevabı: plan superseded, kapı answered, Planner cevaplarla yeniden koşar", async () => {
  const t = setup([
    planBlock("v1"),
    (o) => {
      // Cevaplar soru-cevap çifti olarak gitmeli: Planner eşleştirmek zorunda kalmasın.
      assert.match(o.prompt, /<answers>/);
      assert.match(o.prompt, /S: Hangi motor\?/);
      assert.match(o.prompt, /C: ES/);
      assert.match(o.prompt, /<comment>\nacele yok\n<\/comment>/);
      return planBlock("v2 — cevaplara göre");
    },
  ]);
  try {
    await t.engine.start(t.jobId).planning;
    assert.equal(t.job().state, "PlanReview");
    const gateId = t.pending()[0]!.id;

    const r = t.engine.answerPlanQuestions(t.jobId, [{ question: "Hangi motor?", answer: "ES" }], "acele yok");
    assert.equal(r.state, "Planning");
    await r.planning;

    const gate = t.db.select().from(schema.approvals).where(eq(schema.approvals.id, gateId)).all()[0];
    assert.equal(gate?.status, "answered", "kapı reddedilmiş sayılmamalı");

    const plans = t.plans();
    assert.equal(plans.length, 2, "yeni plan sürümü üretilmedi");
    assert.equal(plans.find((p) => p.version === 1)?.status, "superseded");
    assert.equal(t.job().state, "PlanReview");
  } finally {
    t.cleanup();
  }
});

test("soru cevabı: PlanReview dışında reddedilir", async () => {
  const t = setup([planBlock("v1")]);
  try {
    assert.throws(
      () => t.engine.answerPlanQuestions(t.jobId, [{ question: "q", answer: "a" }], ""),
      (e: unknown) => e instanceof EngineError && e.code === "bad_state",
    );
  } finally {
    t.cleanup();
  }
});

test("açık soru biçimi devam eden turda da hatırlatılır (aynı oturum eski promptla koşar)", async () => {
  // Ölçüldü: v3'te 12 sorunun hepsi düz dizeydi, çünkü planner.md yalnız YENİ
  // oturumda okunuyor. Feedback turunda biçim tekrar basılmazsa şık hiç gelmez.
  const seen: string[] = [];
  const t = setup([
    planBlock("v1"),
    (o) => { seen.push(o.prompt); return planBlock("v2"); },
    (o) => { seen.push(o.prompt); return planBlock("v3"); },
  ]);
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.answerPlanQuestions(t.jobId, [{ question: "q", answer: "a" }], "").planning;
    assert.match(seen[0] ?? "", /openQuestions biçimi/, "cevap turunda biçim yok");
    assert.match(seen[0] ?? "", /blocksPlan/);

    await t.engine.decide(t.pending()[0]!.id, "reject", "beğenmedim", undefined).planning;
    assert.match(seen[1] ?? "", /openQuestions biçimi/, "red turunda biçim yok");
  } finally {
    t.cleanup();
  }
});

test("soru cevabı: NeedsAttention'a düşmüş iş de cevaplanabilir, hata damgası silinir", async () => {
  // YAŞANDI: sunucu yeniden başlayınca PlanReview'daki iş NeedsAttention'a
  // düştü ama plan kapısı AÇIK kaldı. Operatör ekranda soruları görüyor,
  // "cevapları gönder" diyor, 409 yiyordu — üstelik UI hatayı göstermiyordu.
  const t = setup([planBlock("v1"), planBlock("v2")]);
  try {
    await t.engine.start(t.jobId).planning;
    assert.equal(t.job().state, "PlanReview");

    // Yarıda kalma benzetimi: uzlaştırma işi NeedsAttention'a alır, kapı kalır.
    t.db.update(schema.jobs)
      .set({ state: "NeedsAttention", phase: "waiting", errorCode: "interrupted", errorMessage: "sunucu yeniden başladı" })
      .where(eq(schema.jobs.id, t.jobId)).run();
    assert.equal(t.pending().length, 1, "kapı kapanmamalıydı");

    const r = t.engine.answerPlanQuestions(t.jobId, [{ question: "q", answer: "a" }], "");
    assert.equal(r.state, "Planning");
    assert.equal(t.job().errorCode, null, "hata damgası silinmedi");
    assert.equal(t.job().errorMessage, null);
    await r.planning;
    assert.equal(t.job().state, "PlanReview");
  } finally {
    t.cleanup();
  }
});

test("cevaplar süreç ölse de kaybolmaz: retry aynı cevaplarla planlar", async () => {
  // YAŞANDI: cevaplar gönderildi, plan superseded oldu, sunucu yeniden başladı
  // ve Planner turu öldü. Üç sürüm de superseded kaldı; cevaplar denetim izinde
  // yalnız SAYI olarak duruyordu, yani insanın emeği kayıptı.
  let second = "";
  const t = setup([
    planBlock("v1"),
    () => { throw new Error("süreç öldü"); },
    (o) => { second = o.prompt; return planBlock("v2"); },
  ]);
  try {
    await t.engine.start(t.jobId).planning;
    await t.engine.answerPlanQuestions(t.jobId, [{ question: "Hangi motor?", answer: "ES" }], "acele yok").planning;
    assert.equal(t.job().state, "NeedsAttention", "düşen tur NeedsAttention'a almalıydı");

    const r = t.engine.retry(t.jobId);
    await r.work;
    assert.match(second, /S: Hangi motor\?/, "cevaplar yeniden denemede verilmedi");
    assert.match(second, /C: ES/);
    assert.match(second, /acele yok/, "ek not kayboldu");
    assert.equal(t.job().state, "PlanReview");
  } finally {
    t.cleanup();
  }
});

/** Triage'ın ölçüm bloğu. */
function triageBlock(tier: string, over: Record<string, unknown> = {}): string {
  const doc = { recommendedTier: tier, rationale: `test: ${tier}`, confidence: "high", ...over };
  return `Ölçtüm.\n\`\`\`TRIAGE_JSON\n${JSON.stringify(doc)}\n\`\`\``;
}

test("triage KAPALI: tur koşmaz, planner sabit modelinde kalır", async () => {
  // Opt-in bayrağının sızması: mevcut profiller sürüm yükseltince sessizce
  // model değiştirmemeli.
  const t = setup([planBlock("v1")]);
  try {
    await t.engine.start(t.jobId).planning;
    assert.equal(t.calls.filter((c) => c.role === "triage").length, 0, "triage koştu");
    const planner = t.calls.find((c) => c.role === "planner")!;
    assert.equal(planner.model, "claude-opus-5-5");
    assert.equal(planner.effort, "high");
    assert.equal(t.db.select().from(schema.triageResults).all().length, 0, "kayıt yazıldı");
  } finally {
    t.cleanup();
  }
});

test("triage AÇIK: intake planner'ı, postplan developer'ı seçer", async () => {
  const t = setup(
    [triageBlock("cheap"), planBlock("v1"), triageBlock("standard")],
    "true",
    { triage: { enabled: true } },
  );
  try {
    await t.engine.start(t.jobId).planning;

    const triageRuns = t.calls.filter((c) => c.role === "triage");
    assert.equal(triageRuns.length, 2, "iki aşama koşmadı");
    // Triage kendi ucuz modeliyle koşar — yoksa varlık sebebi ortadan kalkar.
    assert.equal(triageRuns[0]!.model, "claude-haiku-5-5");
    // Salt okunur: yazma araçları reddedilmeli.
    assert.ok(triageRuns[0]!.disallowedTools?.includes("Write"));
    // `git log` açık: "bu dosya kaç kez patch edilmiş" ölçülebilmeli.
    assert.ok(triageRuns[0]!.allowedTools?.some((x) => x.startsWith("Bash(git log")));
    // Oturum sürdürmez: iki aşama bağımsız ölçüm.
    assert.equal(triageRuns[0]!.resumeSessionId, null);

    // intake `cheap` dedi → planner haiku ile koştu.
    const planner = t.calls.find((c) => c.role === "planner")!;
    assert.equal(planner.model, "claude-haiku-5-5");
    assert.equal(planner.effort, "medium");

    // İki ölçüm de kaydedildi; postplan plana bağlı.
    const rows = t.db.select().from(schema.triageResults).all();
    assert.equal(rows.length, 2);
    const intake = rows.find((r) => r.stage === "intake")!;
    const postplan = rows.find((r) => r.stage === "postplan")!;
    assert.equal(intake.tier, "cheap");
    assert.equal(intake.subjectId, null);
    assert.equal(postplan.tier, "standard");
    assert.equal(postplan.subjectId, t.plans()[0]!.id, "postplan plana bağlanmadı");

    // Kapı yükü öneriyi TAŞIR: insan planı okurken aynı ekranda görür.
    const gate = t.pending()[0]!;
    const mc = (gate.payload as { modelChoice?: { tier: string; model: string } }).modelChoice;
    assert.equal(mc?.tier, "standard");
    assert.equal(mc?.model, "claude-sonnet-5-5");
  } finally {
    t.cleanup();
  }
});

test("triage ÇÖKERSE iş SÜRER: blok yoksa varsayılan seviyeye düşülür", async () => {
  // Bu planın en önemli güvencesi: triage bir DANIŞMANDIR. Çökmesi işi
  // öldürmemeli, yalnız tasarruf olmamalı.
  const t = setup(
    ["Ölçemedim, blok da yazmadım.", planBlock("v1"), "yine blok yok"],
    "true",
    { triage: { enabled: true } },
  );
  try {
    await t.engine.start(t.jobId).planning;
    assert.equal(t.job().state, "PlanReview", "iş düştü");
    // `fallbackTier: "deep"` → bugünkü davranış.
    const planner = t.calls.find((c) => c.role === "planner")!;
    assert.equal(planner.model, "claude-opus-5-5");
    // Ölçüm yok, kayıt da yok.
    assert.equal(t.db.select().from(schema.triageResults).all().length, 0);
    // Kapı yükünde öneri olmaz — UI şeridi çizmez.
    const gate = t.pending()[0]!;
    assert.equal((gate.payload as { modelChoice?: unknown }).modelChoice, undefined);
  } finally {
    t.cleanup();
  }
});

test("maxTier: triage frontier dese de profil tavanı uygulanır", async () => {
  // Kör maliyet freninin uygulanmaması doğrudan para kaybı.
  const t = setup(
    [triageBlock("frontier"), planBlock("v1"), triageBlock("frontier")],
    "true",
    { triage: { enabled: true, maxTier: "standard" } },
  );
  try {
    await t.engine.start(t.jobId).planning;
    const planner = t.calls.find((c) => c.role === "planner")!;
    assert.equal(planner.model, "claude-sonnet-5-5", "tavan aşıldı");
    const rows = t.db.select().from(schema.triageResults).all();
    assert.ok(rows.every((r) => r.tier === "standard"), rows.map((r) => r.tier).join(","));
    // Tavan zaten kesiyorsa insana sorulacak bir şey kalmaz.
    assert.ok(rows.every((r) => !r.requiresApproval));
  } finally {
    t.cleanup();
  }
});

test("pahalı seviye onay ister ve onaydan ÖNCE uygulanmaz", async () => {
  // Fable'ın sessizce onaysız seçilmesi bütçe kontrolünü anlamsız kılardı.
  const t = setup(
    [triageBlock("standard"), planBlock("v1"), triageBlock("frontier"),
      (o: RunOptions) => developerResponse(o.cwd, "src/a.cs", "x")],
    "true",
    { triage: { enabled: true } },
  );
  try {
    await t.engine.start(t.jobId).planning;
    const postplan = t.db.select().from(schema.triageResults).all().find((r) => r.stage === "postplan")!;
    assert.equal(postplan.tier, "frontier");
    assert.equal(postplan.requiresApproval, true, "onay işaretlenmedi");

    const gate = t.pending()[0]!;
    const mc = (gate.payload as { modelChoice?: { requiresApproval: boolean } }).modelChoice;
    assert.equal(mc?.requiresApproval, true, "kapı uyarıyı taşımıyor");

    // Onaydan sonra developer o modelle koşar.
    const res = t.engine.decide(gate.id, "approve", "", undefined);
    await res.developing;
    const dev = t.calls.find((c) => c.role === "developer")!;
    assert.equal(dev.model, "claude-fable-5-1");
    assert.equal(dev.effort, "max");

    // Denetim izine yazıldı: "bu iş neden Fable'a gitti" sorulabilmeli.
    const audit = t.db.select().from(schema.auditLog).all().filter((a) => a.action === "model.approve");
    assert.equal(audit.length, 1);
  } finally {
    t.cleanup();
  }
});

test("plan reddi: intake ölçümü TEKRARLANMAZ, seviye bir basamak yükselir", async () => {
  // Aynı girdi için ikinci kez ödemek saçma; ama red bir sinyaldir.
  const t = setup(
    [triageBlock("cheap"), planBlock("v1"), triageBlock("cheap"), planBlock("v2"), triageBlock("cheap")],
    "true",
    { triage: { enabled: true } },
  );
  try {
    await t.engine.start(t.jobId).planning;
    const gate = t.pending()[0]!;
    const before = t.calls.filter((c) => c.role === "triage").length;

    const res = t.engine.decide(gate.id, "reject", "eksik", undefined);
    await res.planning;

    const intakeRuns = t.db.select().from(schema.triageResults).all().filter((r) => r.stage === "intake");
    assert.equal(intakeRuns.length, 1, "intake yeniden koştu");

    // Redden sonraki planner turu bir basamak yukarıda.
    const planners = t.calls.filter((c) => c.role === "planner");
    assert.equal(planners[0]!.model, "claude-haiku-5-5");
    assert.equal(planners[1]!.model, "claude-sonnet-5-5", "red sonrası yükselmedi");
    // Postplan yine koştu (plan yeni bir plan).
    assert.ok(t.calls.filter((c) => c.role === "triage").length > before);
  } finally {
    t.cleanup();
  }
});
