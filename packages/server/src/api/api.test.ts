import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { eq } from "drizzle-orm";

import { buildApp, type AppOverrides } from "../app.js";
import { ConfigSchema } from "../config/index.js";
import { newId, schema } from "../db/index.js";
import type { AgentRunner, RunOptions, RunResult } from "../agents/runner.js";

/**
 * REST katmanı testleri — gerçek bir sunucu, gerçek HTTP, sahte SDK.
 *
 * Kapılar burada sınanır: onaysız profille iş açılamaz, taslak olmayan
 * profil onaylanamaz, aynı projede iki analiz sürmez, token varken tokensiz
 * istek geçmez.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-api-ws-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, ".gitignore"), ".run/\n");
  writeFileSync(join(dir, "App.slnx"), "<Solution />");
  mkdirSync(join(dir, ".run"), { recursive: true });
  writeFileSync(join(dir, ".run", "at.txt"), "token");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "ilk", "--no-gpg-sign"]);
  return dir;
}

/** SDK'yı çağırmadan sabit metin döndüren sahte runner. */
function fakeRunner(text: string | (() => Promise<string>)): AgentRunner {
  return {
    async run(_opts: RunOptions): Promise<RunResult> {
      const out = typeof text === "function" ? await text() : text;
      return {
        runId: newId(), sessionId: "s1", subtype: "success",
        text: out, costMicroUsd: 1_000, numTurns: 3, quota: false,
      };
    },
    // Sahte runner'da koşan tur yok: kesilecek bir şey bulunamadı.
    // `as unknown as` tip denetimini sustuğu için bu eksik ancak ÇALIŞMA
    // ZAMANINDA yakalandı (iptal ucu 500 döndü) — sahteyi gerçek arayüzle
    // aynı hizada tutmak gerekiyor.
    async abortJob(_jobId: string, _reason: string): Promise<boolean> {
      return false;
    },
  } as unknown as AgentRunner;
}

function profileBlock(root: string, slug: string): string {
  const profile = {
    version: 1, slug, name: "Test",
    workspace: { root, rootIsRepo: true, repos: [{ name: "Test", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: "ahtapot/exec:latest" },
    build: { steps: [{ name: "derle", run: "dotnet build App.slnx -c Debug" }] },
  };
  return ["```PROFILE_JSON", JSON.stringify(profile), "```", "```RATIONALE_JSON", "{}", "```"].join("\n");
}

async function startApp(overrides: AppOverrides = {}, adminToken?: string) {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-api-"));
  const config = ConfigSchema.parse({
    dbPath: join(dir, "app.sqlite"),
    dataRoot: dir,
    keysFile: join(dir, "yok.txt"),
    logLevel: "fatal",
    ...(adminToken ? { adminToken } : {}),
  });
  // Konteyner taraması kapalı: paralel Docker testinin konteynerini silmesin.
  const app = await buildApp(config, { reconcileContainers: false, ...overrides });
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = app.fastify.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  async function call<T = unknown>(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as T;
    return { status: res.status, body: json };
  }

  return {
    app, base, call,
    async cleanup() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Analiz arka planda sürer; bitene kadar yoklar. */
async function waitAnalysis(t: Awaited<ReturnType<typeof startApp>>, analysisId: string) {
  for (let i = 0; i < 50; i++) {
    const r = await t.call<{ status: string; error: string | null; profile: { id: string } | null }>(
      "GET", `/api/analyses/${analysisId}`,
    );
    if (r.body.status !== "running") return r.body;
    await delay(50);
  }
  throw new Error("analiz bitmedi");
}

type ProjectRow = { id: string; slug: string; activeProfileId: string | null };

async function createProject(t: Awaited<ReturnType<typeof startApp>>, root: string, slug = "test") {
  const r = await t.call<ProjectRow>("POST", "/api/projects", { slug, name: "Test", workspaceRoot: root });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test("proje: geçerli workspace bağlanır, var olmayan yol reddedilir", async () => {
  const root = makeWorkspace();
  const t = await startApp();
  try {
    const p = await createProject(t, root);
    assert.equal(p.slug, "test");
    assert.equal(p.activeProfileId, null);

    const bad = await t.call<{ error: string }>("POST", "/api/projects", {
      slug: "yok", name: "Yok", workspaceRoot: join(root, "boyle-bir-dizin-yok"),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /workspace/);

    const dup = await t.call("POST", "/api/projects", { slug: "test", name: "T", workspaceRoot: root });
    assert.equal(dup.status, 409);

    const invalid = await t.call<{ issues: { path: string }[] }>("POST", "/api/projects", {
      slug: "Büyük Harf", name: "", workspaceRoot: root,
    });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.issues.some((i) => i.path === "slug"), "alan bazlı hata yok");
  } finally {
    await t.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("analiz → taslak → onay → iş: uçtan uca kapılar", async () => {
  const root = makeWorkspace();
  const t = await startApp({ runner: fakeRunner(profileBlock(root, "test")) });
  try {
    const p = await createProject(t, root);

    // ONAY KAPISI: profil yokken iş açılamaz.
    const early = await t.call<{ error: string }>("POST", "/api/jobs", { projectId: p.id, title: "erken" });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /onaylı profil/);

    const started = await t.call<{ analysisId: string; status: string }>("POST", `/api/projects/${p.id}/analyze`, {});
    assert.equal(started.status, 202);
    assert.equal(started.body.status, "running");

    // Satır 202 döner dönmez var — istemci hemen sorgulayabilir.
    const immediate = await t.call<{ status: string }>("GET", `/api/analyses/${started.body.analysisId}`);
    assert.equal(immediate.status, 200);

    const done = await waitAnalysis(t, started.body.analysisId);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.ok(done.profile, "analizden taslak doğmadı");

    // Taslak listede, ama proje hâlâ profilsiz.
    const list = await t.call<{ id: string; status: string; version: number }[]>("GET", `/api/projects/${p.id}/profiles`);
    assert.equal(list.body[0]?.status, "draft");
    const detailBefore = await t.call<{ activeProfile: unknown }>("GET", `/api/projects/${p.id}`);
    assert.equal(detailBefore.body.activeProfile, null);

    const approved = await t.call<{ status: string }>("POST", `/api/profiles/${done.profile.id}/decision`, { decision: "approve" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "approved");

    // Aynı taslak ikinci kez onaylanamaz: taslak değil artık.
    const twice = await t.call("POST", `/api/profiles/${done.profile.id}/decision`, { decision: "approve" });
    assert.equal(twice.status, 409);

    const detailAfter = await t.call<{ activeProfile: { id: string; version: number } }>("GET", `/api/projects/${p.id}`);
    assert.equal(detailAfter.body.activeProfile.id, done.profile.id);

    // Artık iş açılır ve o andaki profil sürümünü taşır.
    const job = await t.call<{ id: string; state: string; profileId: string }>("POST", "/api/jobs", {
      projectId: p.id, title: "Login ekranı", description: "…", externalRef: "CU-123", source: "clickup",
    });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.equal(job.body.state, "Draft");
    assert.equal(job.body.profileId, done.profile.id);

    const jobs = await t.call<{ id: string }[]>("GET", `/api/jobs?projectId=${p.id}&state=Draft`);
    assert.equal(jobs.body.length, 1);

    // İptal transition() üzerinden geçer ve denetim izine düşer.
    const cancel = await t.call<{ from: string; to: string; stopped: boolean }>("POST", `/api/jobs/${job.body.id}/cancel`, { reason: "vazgeçildi" });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.to, "Cancelled");
    // Koşmayan işte kesilecek tur yok; iptal yine de "durdurdum" DEMEZ.
    assert.equal(cancel.body.stopped, false);

    const detail = await t.call<{ state: string; transitions: { toState: string; reason: string }[] }>("GET", `/api/jobs/${job.body.id}`);
    assert.equal(detail.body.state, "Cancelled");
    assert.equal(detail.body.transitions[0]?.reason, "vazgeçildi");

    // Replay için olay durumla birlikte yazıldı: Draft (seq 1) + Cancelled (seq 2).
    const replay = t.app.hub.replay(job.body.id, 0);
    assert.deepEqual(
      replay.map((e) => (e.type === "job.state" ? `${e.seq}:${e.state}` : e.type)),
      ["1:Draft", "2:Cancelled"],
    );

    // Bitmiş iş yeniden iptal edilemez — geçersiz geçiş 409.
    const again = await t.call("POST", `/api/jobs/${job.body.id}/cancel`, {});
    assert.equal(again.status, 409);
  } finally {
    await t.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("analiz: sürücü fırlatırsa satır 'running'da KALMAZ", async () => {
  const root = makeWorkspace();
  const t = await startApp({
    runner: fakeRunner(async () => { throw new Error("tüm Claude kimlikleri kotada"); }),
  });
  try {
    const p = await createProject(t, root);
    const started = await t.call<{ analysisId: string }>("POST", `/api/projects/${p.id}/analyze`, {});
    const done = await waitAnalysis(t, started.body.analysisId);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /kotada/);
  } finally {
    await t.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("analiz: aynı projede ikinci analiz sürerken reddedilir", async () => {
  const root = makeWorkspace();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const t = await startApp({
    runner: fakeRunner(async () => { await gate; return profileBlock(root, "test"); }),
  });
  try {
    const p = await createProject(t, root);
    const first = await t.call<{ analysisId: string }>("POST", `/api/projects/${p.id}/analyze`, {});
    assert.equal(first.status, 202);

    const second = await t.call<{ error: string }>("POST", `/api/projects/${p.id}/analyze`, {});
    assert.equal(second.status, 409);

    const detail = await t.call<{ runningAnalysisId: string | null }>("GET", `/api/projects/${p.id}`);
    assert.equal(detail.body.runningAnalysisId, first.body.analysisId);

    release();
    await waitAnalysis(t, first.body.analysisId);

    // Bitince kilit kalkar.
    const third = await t.call("POST", `/api/projects/${p.id}/analyze`, {});
    assert.equal(third.status, 202);
  } finally {
    release();
    await t.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("profil: elle yazılan taslak şemadan geçer, uymayan reddedilir", async () => {
  const root = makeWorkspace();
  const t = await startApp();
  try {
    const p = await createProject(t, root);

    const bad = await t.call<{ issues: { path: string }[] }>("POST", `/api/projects/${p.id}/profiles`, {
      document: { version: 1, slug: "test", name: "T" },
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.issues.some((i) => i.path.startsWith("document.")), "alan yolu yok");

    const wrongSlug = await t.call<{ error: string }>("POST", `/api/projects/${p.id}/profiles`, {
      document: JSON.parse(profileBlock(root, "baska").split("\n")[1]!),
    });
    assert.equal(wrongSlug.status, 400);
    assert.match(wrongSlug.body.error, /slug/);

    const ok = await t.call<{ id: string; status: string; version: number }>("POST", `/api/projects/${p.id}/profiles`, {
      document: JSON.parse(profileBlock(root, "test").split("\n")[1]!),
      note: "CI'dan elle çıkardım",
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "draft");
    assert.equal(ok.body.version, 1);

    const rejected = await t.call<{ status: string }>("POST", `/api/profiles/${ok.body.id}/decision`, {
      decision: "reject", comment: "build komutu yanlış",
    });
    assert.equal(rejected.body.status, "rejected");

    // Reddedilmiş taslak onaylanamaz.
    const late = await t.call("POST", `/api/profiles/${ok.body.id}/decision`, { decision: "approve" });
    assert.equal(late.status, 409);

    // Elle yazılan profilin analizi yok → bayatlık BİLİNEMEZ, "bayat" denmez.
    const full = await t.call<{ analysisId: string | null }>("GET", `/api/profiles/${ok.body.id}`);
    assert.equal(full.body.analysisId, null);
  } finally {
    await t.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bayatlık: solution değişince onaylı profil bayat sayılır", async () => {
  const root = makeWorkspace();
  const t = await startApp({ runner: fakeRunner(profileBlock(root, "test")) });
  try {
    const p = await createProject(t, root);
    const started = await t.call<{ analysisId: string }>("POST", `/api/projects/${p.id}/analyze`, {});
    const done = await waitAnalysis(t, started.body.analysisId);
    await t.call("POST", `/api/profiles/${done.profile!.id}/decision`, { decision: "approve" });

    const fresh = await t.call<{ known: boolean; stale: boolean }>("GET", `/api/projects/${p.id}/drift`);
    assert.equal(fresh.body.known, true);
    assert.equal(fresh.body.stale, false);

    writeFileSync(join(root, "App.slnx"), "<Solution><Project Path='Yeni.csproj'/></Solution>");

    const after = await t.call<{ stale: boolean; changed: string[] }>("GET", `/api/projects/${p.id}/drift`);
    assert.equal(after.body.stale, true);
    assert.deepEqual(after.body.changed, ["App.slnx"]);

    // Workspace silinirse bayatlık BİLİNEMEZ — 500 değil, known:false.
    rmSync(root, { recursive: true, force: true });
    const gone = await t.call<{ known: boolean }>("GET", `/api/projects/${p.id}/drift`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.known, false);
  } finally {
    await t.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("yetki: token tanımlıysa tokensiz istek 401, /health serbest", async () => {
  const t = await startApp({}, "gizli-token");
  try {
    const noToken = await t.call("GET", "/api/projects");
    assert.equal(noToken.status, 401);

    const wrong = await t.call("GET", "/api/projects", undefined, "yanlis");
    assert.equal(wrong.status, 401);

    const ok = await t.call("GET", "/api/projects", undefined, "gizli-token");
    assert.equal(ok.status, 200);

    const health = await t.call<{ ok: boolean }>("GET", "/health");
    assert.equal(health.body.ok, true);
  } finally {
    await t.cleanup();
  }
});

test("sistem: kimlik durumu anahtar değeri taşımaz", async () => {
  const t = await startApp();
  try {
    const r = await t.call<{ identities: { total: number; available: number } }>("GET", "/api/system");
    assert.equal(r.status, 200);
    assert.equal(r.body.identities.total, 0);
    assert.ok(!JSON.stringify(r.body).includes("sk-ant"), "anahtar sızdı");
  } finally {
    await t.cleanup();
  }
});

test("hata zarfı: bozuk JSON 400, bilinmeyen yol 404", async () => {
  const t = await startApp();
  try {
    const res = await fetch(`${t.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{bozuk",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error, "hata zarfı yok");

    const missing = await t.call("GET", `/api/jobs/${newId()}`);
    assert.equal(missing.status, 404);
  } finally {
    await t.cleanup();
  }
});

test("plan ucu: eski düz metin openQuestions nesneye çevrilerek döner", async () => {
  // Yaşandı: DB'deki ham belge şemadan geçmeden dönünce UI `q.question`
  // okuyup patladı ("can't access property slice, e.question is undefined").
  const h = await startApp();
  try {
    const projectId = newId();
    h.app.db.insert(schema.projects).values({ id: projectId, name: "P", slug: "p", workspaceRoot: "/ws" }).run();
    const jobId = newId();
    h.app.db.insert(schema.jobs).values({ id: jobId, projectId, title: "T", state: "PlanReview", phase: "waiting" }).run();
    h.app.db.insert(schema.plans).values({
      id: newId(), jobId, version: 1, status: "under_review",
      document: {
        summary: "s",
        phases: [{ id: "p1", order: 0, title: "t", files: [] }],
        openQuestions: ["düz metin soru"],
      } as never,
    }).run();

    const res = await h.call<{ document: { openQuestions: { question: string; options: string[]; blocksPlan: boolean }[] } }>("GET", `/api/jobs/${jobId}/plan`);
    assert.equal(res.status, 200);
    const q = res.body.document.openQuestions[0];
    assert.ok(q && typeof q === "object", "düz dize nesneye çevrilmedi");
    assert.equal(q.question, "düz metin soru");
    assert.deepEqual(q.options, []);
    assert.equal(q.blocksPlan, false);
  } finally {
    await h.cleanup();
  }
});

test("açılış: yarıda kalmış iş NeedsAttention'a alınır (reconcile bağlı)", async () => {
  // YAŞANDI: `reconcile` yazılmış ve test edilmişti ama app.ts'ten hiç
  // çağrılmıyordu. Sunucu yeniden başlatılınca koşan Planner süreci ölüyor,
  // iş sonsuza dek `Planning|running` kalıyor ve kurtarılamıyordu.
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-rec-"));
  const config = ConfigSchema.parse({
    dbPath: join(dir, "app.sqlite"), dataRoot: dir, keysFile: join(dir, "yok.txt"), logLevel: "fatal",
  });
  try {
    // 1) İlk süreç: koşuyormuş gibi bir iş bırak.
    const first = await buildApp(config, { reconcileContainers: false });
    const projectId = newId();
    first.db.insert(schema.projects).values({ id: projectId, name: "P", slug: "p", workspaceRoot: "/ws" }).run();
    const jobId = newId();
    first.db.insert(schema.jobs).values({ id: jobId, projectId, title: "T", state: "Planning", phase: "running" }).run();
    await first.close();

    // 2) İkinci süreç açılışta uzlaştırmalı.
    const second = await buildApp(config, { reconcileContainers: false });
    try {
      const job = second.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).all()[0];
      assert.equal(job?.state, "NeedsAttention", "yarıda kalan iş hâlâ koşuyor görünüyor");
      assert.equal(job?.phase, "waiting");
      assert.equal(job?.errorCode, "interrupted");
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
