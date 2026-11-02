import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Dockerode from "dockerode";

import { ProjectProfileSchema } from "@ahtapot/shared";

import { GoldenDb, dbDependency, demux, goldenVolumeName, jobDbVolumeName } from "./golden.js";

/**
 * Golden DB e2e — gerçek Docker + postgres:16-alpine (önbellekte).
 *
 * Araç konteyneri olarak da postgres imajı kullanılır (psql var). Migration
 * bir tablo kurar, seed bir satır ekler; klon ayrı volume'de aynı satırı
 * göstermeli; golden ise klondaki değişiklikten etkilenmemeli.
 */

const PG = "postgres:16-alpine";

function profileFor(root: string) {
  return ProjectProfileSchema.parse({
    version: 1, slug: "gtest", name: "G",
    workspace: { root, rootIsRepo: true, repos: [{ name: "a", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: PG, workdir: "/workspace" },
    build: { steps: [{ name: "b", run: "true" }] },
    live: {
      app: { containerPort: 80 },
      healthcheck: { path: "/" },
      dependencies: [{
        service: "postgres", image: PG, internalPort: 5432,
        env: { POSTGRES_PASSWORD: "gizli", POSTGRES_USER: "app", POSTGRES_DB: "app" },
        healthCmd: "pg_isready -U app -d app", dataPath: "/var/lib/postgresql/data",
      }],
    },
    database: {
      kind: "postgres",
      migrate: { name: "migrate", run: "psql -h postgres -U app -d app -f /workspace/migrate.sql", env: { PGPASSWORD: "gizli" }, timeoutMinutes: 2 },
      seed: { name: "seed", run: "psql -h postgres -U app -d app -c \"insert into t(x) values (42)\"", env: { PGPASSWORD: "gizli" }, timeoutMinutes: 2 },
      goldenMaxAgeDays: 7,
    },
  });
}

async function query(docker: Dockerode, volume: string, sql: string): Promise<string> {
  // Klonu bağlayıp tek seferlik postgres kaldır, sorguyu içeriden koş.
  const c = await docker.createContainer({
    Image: PG, Env: ["POSTGRES_PASSWORD=gizli", "POSTGRES_USER=app", "POSTGRES_DB=app"],
    HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: "/var/lib/postgresql/data" }], AutoRemove: false },
  });
  try {
    await c.start();
    for (let i = 0; i < 60; i++) {
      const e = await c.exec({ Cmd: ["sh", "-c", "pg_isready -U app -d app"], AttachStdout: true });
      const s = await e.start({ hijack: true, stdin: false });
      await new Promise<void>((r) => { s.on("data", () => {}); s.on("end", r); s.on("close", r); });
      if ((await e.inspect()).ExitCode === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const e = await c.exec({ Cmd: ["sh", "-c", `psql -U app -d app -tA -c "${sql}"`], AttachStdout: true, AttachStderr: true });
    const s = await e.start({ hijack: true, stdin: false });
    // Akış çoklanmış ve çerçeve sınırları `data` olaylarıyla hizalı DEĞİL:
    // her parçadan 8 bayt kesmek çıktıyı bozar. Tamamını biriktirip çöz.
    const chunks: Buffer[] = [];
    await new Promise<void>((r) => { s.on("data", (d: Buffer) => { chunks.push(d); }); s.on("end", r); s.on("close", r); });
    return demux(Buffer.concat(chunks)).trim();
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

test("golden DB: kur (migrate + seed) → klonla → klon veriyi taşır, golden klondan etkilenmez; bayatlık; temizlik", async (t) => {
  const docker = new Dockerode();
  try {
    await docker.ping();
    await docker.getImage(PG).inspect();
  } catch {
    return t.skip("Docker ya da postgres:16-alpine yok");
  }
  const root = mkdtempSync(join(tmpdir(), "ahtapot-golden-"));
  writeFileSync(join(root, "migrate.sql"), "create table t (x int);\n");
  const profile = profileFor(root);
  const golden = new GoldenDb({ docker, healthIntervalMs: 500, healthTimeoutMs: 60_000, log: () => {} });
  const jobId = "job-golden-test";
  try {
    await docker.getVolume(goldenVolumeName("gtest")).remove({ force: true }).catch(() => {});
    assert.equal(dbDependency(profile)?.name, "postgres");

    const first = await golden.ensure(profile, root);
    assert.equal(first.rebuilt, true);
    assert.equal(first.stale, false);

    // İkinci ensure: yeniden kurmaz.
    const second = await golden.ensure(profile, root);
    assert.equal(second.rebuilt, false);
    assert.equal(second.volume, first.volume);

    const cloneVol = await golden.clone("gtest", jobId);
    assert.equal(cloneVol, jobDbVolumeName(jobId));
    assert.equal(await query(docker, cloneVol, "select x from t"), "42", "klon tohumu taşımalı");

    // Klonda değişiklik golden'a sızmaz.
    await query(docker, cloneVol, "insert into t(x) values (7)");
    assert.equal(await query(docker, cloneVol, "select count(*) from t"), "2");
    assert.equal(await query(docker, first.volume, "select count(*) from t"), "1", "golden klondan etkilendi");

    // Bayatlık: maxAge 0 gün → bayat.
    const info = await golden.inspect("gtest", 0);
    assert.equal(info?.stale, true);

    assert.equal(await golden.removeJobVolume(jobId), true);
    assert.equal(await golden.removeJobVolume(jobId), false);
  } finally {
    await docker.getVolume(jobDbVolumeName(jobId)).remove({ force: true }).catch(() => {});
    await docker.getVolume(goldenVolumeName("gtest")).remove({ force: true }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("golden DB: tanımsız veritabanı ve dataPath'siz bağımlılık anlaşılır hata verir", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahtapot-golden2-"));
  try {
    const none = ProjectProfileSchema.parse({ ...profileFor(root), database: { kind: "none" } });
    const g = new GoldenDb({ docker: new Dockerode() });
    await assert.rejects(() => g.ensure(none, root), /database.kind = none/);
    const noPath = profileFor(root);
    delete (noPath.services[0] as { dataPath?: string }).dataPath;
    await assert.rejects(() => g.ensure(noPath, root), /dataPath/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
