import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectProfileSchema, type ProjectProfile } from "@ahtapot/shared";

import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { heldLeases } from "../resources/leases.js";
import { PortPool } from "../resources/ports.js";
import { EventHub } from "../ws/hub.js";
import { LiveEnvironments } from "./environment.js";

function profileWithLive(worktree: string, live: Record<string, unknown>): ProjectProfile {
  return ProjectProfileSchema.parse({
    version: 1, slug: "t", name: "T",
    workspace: { root: worktree, rootIsRepo: true, repos: [{ name: "app", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: "x" },
    build: { steps: [{ name: "b", run: "true" }] },
    live,
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-live-"));
  const file = join(dir, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  const projectId = newId();
  h.db.insert(schema.projects).values({ id: projectId, slug: "t", name: "T", workspaceRoot: dir }).run();
  const jobId = newId();
  h.db.insert(schema.jobs).values({ id: jobId, projectId, title: "iş" }).run();
  const hub = new EventHub(h.db);
  return {
    db: h.db, hub, jobId, dir,
    ports: new PortPool(h.db, { from: 47300, to: 47310 }, async () => true),
    cleanup() { h.sqlite.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("canlı ortam (sahte compose): override yazılır, up çağrılır, hazır olunca kayıt + kira + olay; uzat; yık", async () => {
  const t = setup();
  try {
    const calls: string[][] = [];
    let appLog = "Registered 42 endpoints";
    const compose = async (args: string[]) => {
      calls.push(args);
      return { stdout: args.includes("logs") ? appLog : "ok", stderr: "" };
    };
    const fetchImpl = (async () => new Response("pong", { status: 200 })) as unknown as typeof fetch;
    const envs = new LiveEnvironments({ db: t.db, hub: t.hub, ports: t.ports, artifactsDir: join(t.dir, "art"), compose, fetchImpl });
    const profile = profileWithLive(t.dir, {
      compose: { base: "deploy/docker-compose.yml" },
      app: { service: "host", containerPort: 5080 },
      healthcheck: { path: "/api/ping", intervalSeconds: 1, timeoutMinutes: 1 },
      readiness: { logPattern: "Registered (\\d+) endpoints" },
      ttlMinutes: 30,
    });

    const s = await envs.start({ jobId: t.jobId, profile, worktreePath: t.dir, readinessOverride: { intervalMs: 20, timeoutMs: 2000 } });
    assert.equal(s.ready, true, s.reason);
    assert.deepEqual(s.ports, [47300]);
    assert.equal(s.appUrl, "http://127.0.0.1:47300");

    const overridePath = join(t.dir, "art", t.jobId, "live", "compose.override.yml");
    assert.ok(existsSync(overridePath), "override yazılmadı");
    assert.match(readFileSync(overridePath, "utf8"), /127\.0\.0\.1:47300:5080/);

    const up = calls.find((c) => c.includes("up"))!;
    assert.deepEqual(up.slice(0, 6), ["-p", `ahtapot-${t.jobId}`, "-f", "deploy/docker-compose.yml", "-f", overridePath]);

    const row = envs.active(t.jobId)!;
    assert.equal(row.status, "ready");
    assert.equal(heldLeases(t.db, t.jobId, "live_env").length, 1);
    assert.equal(heldLeases(t.db, t.jobId, "port").length, 1);
    const events = t.hub.replay(t.jobId, 0);
    assert.ok(events.some((e) => e.type === "live.ready"), "live.ready yayınlanmadı");

    const later = envs.extend(t.jobId, 60)!;
    assert.ok(new Date(later) > new Date(s.expiresAt), "TTL uzamadı");

    appLog = "";
    assert.equal(await envs.stop(t.jobId, t.dir, profile.live), true);
    assert.ok(calls.some((c) => c.includes("down") && c.includes("-v")), "compose down çağrılmadı");
    assert.equal(envs.active(t.jobId), undefined);
    assert.equal(heldLeases(t.db, t.jobId).length, 0, "kiralar bırakılmadı");
    assert.equal(await envs.stop(t.jobId, t.dir, profile.live), false, "ikinci stop sessiz geçmeli");
  } finally {
    t.cleanup();
  }
});

test("canlı ortam (sahte compose): hazır olmazsa unhealthy kalır, yıkılmaz, port tutulur", async () => {
  const t = setup();
  try {
    const compose = async (args: string[]) => ({ stdout: args.includes("logs") ? "Unhandled exception: boom" : "", stderr: "" });
    const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const envs = new LiveEnvironments({ db: t.db, hub: t.hub, ports: t.ports, artifactsDir: join(t.dir, "art"), compose, fetchImpl });
    const profile = profileWithLive(t.dir, {
      app: { containerPort: 8080 },
      healthcheck: { path: "/", intervalSeconds: 1, timeoutMinutes: 1 },
      readiness: { logPattern: "Ready", failPatterns: ["Unhandled exception"] },
    });
    const s = await envs.start({ jobId: t.jobId, profile, worktreePath: t.dir, readinessOverride: { intervalMs: 20, timeoutMs: 2000 } });
    assert.equal(s.ready, false);
    assert.match(s.reason, /başarısızlık deseni/);
    assert.equal(envs.active(t.jobId)?.status, "unhealthy");
    assert.equal(heldLeases(t.db, t.jobId, "port").length, 1, "hata ayıklama için port tutulmalı");
    assert.ok(!t.hub.replay(t.jobId, 0).some((e) => e.type === "live.ready"));
  } finally {
    t.cleanup();
  }
});

test("canlı ortam (gerçek Docker): httpd ayağa kalkar, hazır olur, yıkılır", async (tc) => {
  try {
    // `compose version` yalnız CLI'ın varlığına bakar; daemon kapalıyken de
    // geçer ve test "compose up düştü" diye kırmızı yanardı. `info` daemon'a
    // gerçekten bağlanır (ölçüldü: Docker Desktop kapalıyken yakalandı).
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
  } catch {
    return tc.skip("Docker daemon ya da compose yok");
  }
  const t = setup();
  const wt = join(t.dir, "wt");
  try {
    rmSync(wt, { recursive: true, force: true });
    execFileSync("git", ["init", "-q", wt]);
    writeFileSync(join(wt, "docker-compose.yml"), "services:\n  app:\n    image: httpd:2.4-alpine\n");
    // Gerçek port: havuz gerçekten bağlanmayı dener.
    const ports = new PortPool(t.db, { from: 47400, to: 47410 });
    const envs = new LiveEnvironments({ db: t.db, hub: t.hub, ports, artifactsDir: join(t.dir, "art") });
    const profile = profileWithLive(wt, {
      compose: { base: "docker-compose.yml" },
      app: { service: "app", containerPort: 80 },
      healthcheck: { path: "/", intervalSeconds: 1, timeoutMinutes: 2 },
      ttlMinutes: 5,
    });
    const s = await envs.start({ jobId: t.jobId, profile, worktreePath: wt, readinessOverride: { intervalMs: 500, timeoutMs: 90_000 } });
    try {
      assert.equal(s.ready, true, s.reason);
      const res = await fetch(s.appUrl);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /It works/);
    } finally {
      await envs.stop(t.jobId, wt, profile.live);
    }
    const left = execFileSync("docker", ["ps", "-a", "--filter", `label=ahtapot.job=${t.jobId}`, "-q"], { encoding: "utf8" }).trim();
    assert.equal(left, "", "konteyner kaldı");
  } finally {
    t.cleanup();
  }
});

test("canlı ortam: golden verilmişse iş DB'si klondan bağlanır, ortam yıkılınca klon silinir", async () => {
  const t = setup();
  try {
    const calls: string[] = [];
    const golden = {
      async ensure() { calls.push("ensure"); return { volume: "ahtapot-golden-t", stale: false, rebuilt: false }; },
      async clone(_slug: string, jobId: string) { calls.push("clone"); return `ahtapot-db-${jobId}`; },
      async removeJobVolume(_jobId: string) { calls.push("remove"); return true; },
    };
    let overrideYaml = "";
    const compose = async (args: string[]) => {
      if (args.includes("up")) overrideYaml = readFileSync(join(t.dir, "art", t.jobId, "live", "compose.override.yml"), "utf8");
      return { stdout: args.includes("logs") ? "hazır" : "ok", stderr: "" };
    };
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const envs = new LiveEnvironments({ db: t.db, hub: t.hub, ports: t.ports, artifactsDir: join(t.dir, "art"), compose, fetchImpl, golden });
    const profile = profileWithLive(t.dir, {
      app: { service: "app", containerPort: 8080 },
      healthcheck: { path: "/", intervalSeconds: 1, timeoutMinutes: 1 },
      dependencies: [{ service: "postgres", image: "postgres:16", internalPort: 5432, dataPath: "/var/lib/postgresql/data" }],
    });
    // Golden yalnız database.kind tanımlıyken devreye girer.
    const withDb = { ...profile, database: { ...profile.database, kind: "postgres" as const } };

    const s = await envs.start({ jobId: t.jobId, profile: withDb, worktreePath: t.dir, readinessOverride: { intervalMs: 20, timeoutMs: 2000 } });
    assert.equal(s.ready, true, s.reason);
    assert.deepEqual(calls, ["ensure", "clone"], "golden hazırlanıp klonlanmalı");
    // Klon volume'ü DB servisine bağlandı; golden'ın kendisi DEĞİL.
    assert.match(overrideYaml, new RegExp(`ahtapot-db-${t.jobId}:/var/lib/postgresql/data`));
    assert.ok(!overrideYaml.includes("ahtapot-golden-t:"), "golden doğrudan bağlanmamalı");

    await envs.stop(t.jobId, t.dir, withDb.live);
    assert.deepEqual(calls, ["ensure", "clone", "remove"], "yıkımda klon silinmeli");
  } finally {
    t.cleanup();
  }
});

test("canlı ortam: golden klonu düşerse port ve yarım volume bırakılmaz", async () => {
  const t = setup();
  try {
    const calls: string[] = [];
    const golden = {
      async ensure() { calls.push("ensure"); return { volume: "ahtapot-golden-t", stale: false, rebuilt: false }; },
      // Klon yarıda düşer: volume yaratılmış ama doldurulmamış olabilir.
      async clone() { calls.push("clone"); throw new Error("cp -a düştü"); },
      async removeJobVolume(_jobId: string) { calls.push("remove"); return true; },
    };
    const envs = new LiveEnvironments({
      db: t.db, hub: t.hub, ports: t.ports, artifactsDir: join(t.dir, "art"),
      compose: async () => ({ stdout: "", stderr: "" }), golden,
    });
    const profile = profileWithLive(t.dir, {
      app: { service: "app", containerPort: 8080 },
      healthcheck: { path: "/", intervalSeconds: 1, timeoutMinutes: 1 },
      dependencies: [{ service: "postgres", image: "postgres:16", internalPort: 5432, dataPath: "/var/lib/postgresql/data" }],
    });
    const withDb = { ...profile, database: { ...profile.database, kind: "postgres" as const } };

    await assert.rejects(
      () => envs.start({ jobId: t.jobId, profile: withDb, worktreePath: t.dir }),
      /cp -a düştü/,
    );
    assert.deepEqual(calls, ["ensure", "clone", "remove"], "yarım klon temizlenmeli");
    assert.equal(heldLeases(t.db, t.jobId, "port").length, 0, "port kirada kalmamalı");
  } finally {
    t.cleanup();
  }
});
