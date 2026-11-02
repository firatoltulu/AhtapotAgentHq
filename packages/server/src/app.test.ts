import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ServerEvent } from "@ahtapot/shared";

import { buildApp, type App } from "./app.js";
import { ConfigSchema } from "./config/index.js";
import { newId, schema } from "./db/index.js";

/** Gerçek bir sunucu ayağa kaldırır: sahte değil, dinleyen bir port. */
async function startApp() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-app-"));
  const config = ConfigSchema.parse({
    dbPath: join(dir, "app.sqlite"),
    dataRoot: dir,
    // Testlerde log gürültüsü istemiyoruz; "fatal" en sessiz geçerli seviye.
    logLevel: "fatal",
  });
  // Konteyner taraması kapalı: paralel testin konteynerini yetim sayıp silmesin.
  const app = await buildApp(config, { reconcileContainers: false });
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = app.fastify.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    app,
    port,
    base: `http://127.0.0.1:${port}`,
    async cleanup() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let slugCounter = 0;

function seedJob(app: App): string {
  const projectId = newId();
  app.db
    .insert(schema.projects)
    // UUIDv7 zaman sıralı: art arda üretilen iki id'nin öneki aynı olabilir,
    // bu yüzden slug id'den değil sayaçtan türetiliyor.
    .values({ id: projectId, slug: `p-${slugCounter++}`, name: "Northwind", workspaceRoot: "/w" })
    .run();
  const jobId = newId();
  app.db.insert(schema.jobs).values({ id: jobId, projectId, title: "iş" }).run();
  return jobId;
}

/** Soket açar ve gelen olayları toplar. */
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: ServerEvent[] = [];
  ws.onmessage = (e) => void events.push(JSON.parse(String(e.data)) as ServerEvent);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WS bağlantısı kurulamadı"));
    void delay(3000).then(() => reject(new Error("WS bağlantı zaman aşımı")));
  });
  return { ws, events };
}

test("health: sunucu yanıt verir", async () => {
  const t = await startApp();
  try {
    const body = (await (await fetch(`${t.base}/health`)).json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await t.cleanup();
  }
});

test("web: SPA yolları index.html'e düşer, API yolları JSON 404 kalır", async (tc) => {
  const t = await startApp();
  try {
    const home = await fetch(`${t.base}/`);
    if (home.status === 404) return tc.skip("web dist yok (npm run build -w @ahtapot/web)");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);

    const deep = await fetch(`${t.base}/jobs/olmayan-id`);
    assert.equal(deep.status, 200, "SPA derin yolu index.html vermeli");
    assert.match(await deep.text(), /<div id="root">/);

    const api = await fetch(`${t.base}/api/olmayan`);
    assert.equal(api.status, 404);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    await t.cleanup();
  }
});

test("ws: abone olan istemci canlı olayı alır", async () => {
  const t = await startApp();
  try {
    const jobId = seedJob(t.app);
    const c = await connect(t.port);
    c.ws.send(JSON.stringify({ type: "subscribe", jobId }));
    await delay(100);

    t.app.hub.publish(jobId, {
      type: "job.state", state: "Planning", phase: "starting", loopCounts: {},
    });
    await delay(150);

    assert.ok(c.events.some((e) => e.type === "job.state"));
    c.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("ws: sır uçtan uca maskelenir", async () => {
  const t = await startApp();
  try {
    const jobId = seedJob(t.app);
    const c = await connect(t.port);
    c.ws.send(JSON.stringify({ type: "subscribe", jobId }));
    await delay(100);

    t.app.hub.publish(jobId, {
      type: "build.log", stream: "stdout", line: "key=sk-ant-oat01-SIZINTIDEGERI",
    });
    await delay(150);

    const log = c.events.find((e) => e.type === "build.log");
    assert.ok(log, "build.log olayı gelmedi");
    assert.ok(!JSON.stringify(log).includes("SIZINTIDEGERI"), "sır sokete sızdı");
    c.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("ws: yeniden bağlanan istemci kaçırdığını replay ile alır", async () => {
  const t = await startApp();
  try {
    const jobId = seedJob(t.app);
    // İstemci bağlı değilken iki olay olup bitiyor.
    t.app.hub.publish(jobId, { type: "job.state", state: "Planning", phase: "starting", loopCounts: {} });
    t.app.hub.publish(jobId, { type: "job.state", state: "PlanReview", phase: "waiting", loopCounts: {} });

    const c = await connect(t.port);
    c.ws.send(JSON.stringify({ type: "subscribe", jobId, sinceSeq: 1 }));
    await delay(200);

    assert.equal(c.events.length, 1, "yalnız kaçırılan olay gelmeli");
    assert.equal(c.events[0]?.seq, 2);
    c.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("ws: bozuk mesaj sunucuyu düşürmez", async () => {
  const t = await startApp();
  try {
    const c = await connect(t.port);
    c.ws.send("bu JSON değil");
    c.ws.send(JSON.stringify({ type: "bilinmeyen_tip" }));
    await delay(150);

    const res = await fetch(`${t.base}/health`);
    assert.equal(res.ok, true, "sunucu bozuk girdiyle düşmemeli");
    c.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("ws: abonelik iş bazında yalıtılmış", async () => {
  const t = await startApp();
  try {
    const jobA = seedJob(t.app);
    const jobB = seedJob(t.app);
    const c = await connect(t.port);
    c.ws.send(JSON.stringify({ type: "subscribe", jobId: jobA }));
    await delay(100);

    t.app.hub.publish(jobB, { type: "job.state", state: "Planning", phase: "starting", loopCounts: {} });
    await delay(150);

    assert.equal(c.events.length, 0, "başka işin olayı sızdı");
    c.ws.close();
  } finally {
    await t.cleanup();
  }
});
