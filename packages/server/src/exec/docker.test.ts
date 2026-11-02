import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../app.js";
import { ConfigSchema } from "../config/index.js";
import { newId, schema } from "../db/index.js";
import { AgentRunner } from "../agents/runner.js";
import { ContainerTransport } from "../agents/transport.js";
import { ContainerExecutor } from "../build/executor.js";
import { ContainerManager, parseCpus, parseMemory, toDockerPath } from "./docker.js";

/**
 * Gerçek konteyner testi.
 *
 * Docker ve `ahtapot/agent-base:latest` imajı yoksa ATLANIR (`npm run
 * docker:build`). Claude anahtarı GEREKMEZ: sahte anahtarla SDK 401 alır ve bu
 * hata köprüden geri gelir — döngünün tamamı (konteyner → köprü hello →
 * identity.set → run.start → SDK → bridge.error → runner) bir kuruş harcamadan
 * doğrulanır.
 */

test("bellek/cpu/yol dönüşümleri", () => {
  assert.equal(parseMemory("8g"), 8 * 1024 ** 3);
  assert.equal(parseMemory("512m"), 512 * 1024 ** 2);
  assert.throws(() => parseMemory("çok"));
  assert.equal(parseCpus("4"), 4e9);
  assert.equal(parseCpus("0.5"), 5e8);
  assert.equal(toDockerPath("C:\\src\\x\\data"), "C:/src/x/data");
});

test("konteyner: köprü bağlanır, sahte anahtarla SDK hatası runner'a döner", async (t) => {
  const containers = new ContainerManager();
  if (!(await containers.available())) return t.skip("Docker erişilemiyor");
  const image = "ahtapot/agent-base:latest";
  if (!(await containers.imageExists(image))) return t.skip(`imaj yok: ${image} (npm run docker:build)`);

  const dir = mkdtempSync(join(tmpdir(), "ahtapot-docker-"));
  writeFileSync(join(dir, "keys.txt"), "sk-ant-api03-SAHTE-0000\n");
  const config = ConfigSchema.parse({
    dbPath: join(dir, "app.sqlite"), dataRoot: dir, keysFile: join(dir, "keys.txt"), logLevel: "fatal",
  });
  // Konteyner taraması kapalı: paralel testin konteynerini yetim sayıp silmesin.
  const app = await buildApp(config, { reconcileContainers: false });
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = app.fastify.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const projectId = newId();
  app.db.insert(schema.projects).values({ id: projectId, slug: "p", name: "P", workspaceRoot: dir }).run();
  const jobId = newId();
  app.db.insert(schema.jobs).values({ id: jobId, projectId, title: "iş" }).run();

  // Worktree artık named volume'de: host'ta dizin YOK. İçerik konteyner
  // ayağa kalktıktan sonra, konteynerin içinden yaratılır.
  const jobVolume = await containers.ensureVolume(jobId);

  try {
    const token = app.bridges.issueToken(jobId);
    const { created } = await containers.ensure({
      jobId, image, jobVolume, workdir: "/workspace",
      resources: { memory: "1g", cpus: "1", pidsLimit: 256 },
      caches: [], env: {},
      bridgeUrl: `ws://${config.bridgeHost}:${port}/bridge`,
      bridgeToken: token,
    });
    assert.equal(created, true);

    // İkinci ensure yeni konteyner yaratmaz.
    const again = await containers.ensure({
      jobId, image, jobVolume, workdir: "/workspace",
      resources: { memory: "1g", cpus: "1", pidsLimit: 256 },
      caches: [], env: {}, bridgeUrl: "ws://x", bridgeToken: "x",
    });
    assert.equal(again.created, false);

    const session = await app.bridges.waitFor(jobId, 30_000);

    // Worktree içeriği konteynerin İÇİNDEN yaratılır: volume'de host tarafı yok.
    const boot = await containers.containerFor(jobId);
    assert.ok(boot, "konteyner bulunamadı");
    await new ContainerExecutor(boot).run({
      command: "mkdir -p /workspace/app && printf '# test' > /workspace/app/README.md",
      cwd: "/", env: {}, timeoutMs: 30_000, onLine: () => {},
    });

    const runner = new AgentRunner(app.db, app.pool, app.hub);
    const transport = new ContainerTransport(session, { containerRoot: "/workspace" });
    const res = await runner.run({
      jobId, role: "developer", prompt: "Sadece 'merhaba' yaz.", model: "claude-sonnet-5-5",
      maxTurns: 1, maxBudgetUsd: 0.01, cwd: "/workspace/app",
      permissionMode: "bypassPermissions", transport,
    });

    // Sahte anahtar: başarı OLMAMALI; hata köprüden geldi, kota sayılmadı.
    assert.notEqual(res.subtype, "success", "sahte anahtarla başarı döndü");
    assert.equal(res.quota, false);
    const runs = app.db.select().from(schema.agentRuns).all();
    assert.equal(runs[0]?.status, "error");

    // Sır DB'ye sızmadı.
    assert.ok(!JSON.stringify(runs).includes("SAHTE-0000"), "anahtar DB'ye yazıldı");

    const owned = await containers.listOwned();
    assert.ok(owned.some((c) => c.jobId === jobId));

    // Build/test komutları aynı konteynerde koşar: docker exec çoklanmış akışı satırlara iner.
    const c = await containers.containerFor(jobId);
    assert.ok(c, "konteyner bulunamadı");
    const lines: string[] = [];
    const ex = await new ContainerExecutor(c).run({
      command: "echo out-satir; echo err-satir 1>&2; cat README.md; exit 7",
      cwd: "/workspace/app", env: { X: "1" }, timeoutMs: 30_000,
      onLine: (s, l) => lines.push(`${s}:${l}`),
    });
    assert.equal(ex.exitCode, 7);
    assert.ok(lines.includes("stdout:out-satir"));
    assert.ok(lines.includes("stderr:err-satir"));
    assert.ok(lines.includes("stdout:# test"), "volume içeriği konteynerden okunamadı");
    const logs = await containers.logs(jobId, 50);
    assert.match(logs, /köprü: bağlandı/);
  } finally {
    await containers.remove(jobId).catch(() => {});
    // Volume konteynerden SONRA silinir: kullanımdayken Docker reddeder.
    await containers.removeVolume(jobId).catch(() => {});
    app.bridges.revoke(jobId);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
