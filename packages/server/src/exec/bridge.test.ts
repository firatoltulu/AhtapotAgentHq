import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ServerToBridgeSchema, type ServerToBridge, type BridgeToServer } from "@ahtapot/shared";

import { buildApp } from "../app.js";
import { ConfigSchema } from "../config/index.js";
import { newId, schema } from "../db/index.js";
import { AgentRunner } from "../agents/runner.js";
import { ContainerTransport, LiveInputChannel } from "../agents/transport.js";
import { BridgeError } from "./bridge.js";

/**
 * Köprü protokolü testleri — Docker YOK, SDK YOK.
 *
 * Testteki "sahte köprü" konteynerdeki köprünün yaptığını yapar: WS açar,
 * hello gönderir, `run.start` alınca uydurma SDK mesajları döker. Böylece
 * sunucu tarafı (kayıt, token, koşu akışı, runner entegrasyonu) anahtar ve
 * imaj olmadan sınanır. Gerçek konteyner testi `docker.test.ts`te.
 */

async function startApp() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-bridge-"));
  // Sahte kimlik: runner havuzdan bir kimlik almadan taşımaya ulaşmaz.
  writeFileSync(join(dir, "keys.txt"), "sk-ant-api03-SAHTE-ANAHTAR-0000\n");
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

  return {
    app, port, jobId, dir,
    url: `ws://127.0.0.1:${port}/bridge`,
    async cleanup() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Konteyner köprüsünü taklit eden istemci. */
function fakeBridge(url: string, onStart: (msg: Extract<ServerToBridge, { type: "run.start" }>, send: (m: BridgeToServer) => void) => void) {
  const ws = new WebSocket(url);
  const received: ServerToBridge[] = [];
  const send = (m: BridgeToServer) => ws.send(JSON.stringify(m));
  ws.onmessage = (ev) => {
    const parsed = ServerToBridgeSchema.safeParse(JSON.parse(String(ev.data)));
    if (!parsed.success) return;
    received.push(parsed.data);
    if (parsed.data.type === "run.start") onStart(parsed.data, send);
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WS açılamadı"));
  });
  const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
  return { ws, send, received, opened, closed };
}

test("köprü: doğru token kabul, yanlış token soketi kapatır", async () => {
  const t = await startApp();
  try {
    const token = t.app.bridges.issueToken(t.jobId);

    const bad = fakeBridge(t.url, () => {});
    await bad.opened;
    bad.send({ type: "bridge.hello", jobId: t.jobId, token: "yanlis", bridgeVersion: "t" });
    await Promise.race([bad.closed, delay(2000).then(() => { throw new Error("yanlış token'la soket açık kaldı"); })]);
    assert.equal(t.app.bridges.get(t.jobId), undefined);

    const good = fakeBridge(t.url, () => {});
    await good.opened;
    good.send({ type: "bridge.hello", jobId: t.jobId, token, bridgeVersion: "t" });
    const session = await t.app.bridges.waitFor(t.jobId, 2000);
    assert.equal(session.jobId, t.jobId);
    good.ws.close();
    await delay(100);
    assert.equal(t.app.bridges.get(t.jobId), undefined, "kapanan oturum kayıtta kaldı");
  } finally {
    await t.cleanup();
  }
});

test("köprü: hello gelmeden mesaj atan soket kapatılır", async () => {
  const t = await startApp();
  try {
    const b = fakeBridge(t.url, () => {});
    await b.opened;
    b.send({ type: "bridge.event", runId: "x", event: {} });
    await Promise.race([b.closed, delay(2000).then(() => { throw new Error("hello'suz soket açık kaldı"); })]);
  } finally {
    await t.cleanup();
  }
});

test("koşu: runner köprü üzerinden SDK akışını tüketir, maliyeti ve mesajı kaydeder", async () => {
  const t = await startApp();
  try {
    const token = t.app.bridges.issueToken(t.jobId);
    const b = fakeBridge(t.url, (msg, send) => {
      // Sahte SDK: cwd konteyner yoluna çevrilmiş olmalı, anahtar burada OLMAMALI.
      assert.equal(msg.cwd, "/workspace/app");
      assert.ok(!JSON.stringify(msg).includes("SAHTE-ANAHTAR"), "run.start anahtar taşıyor");
      send({ type: "bridge.event", runId: msg.runId, event: { type: "system", subtype: "init", session_id: "sdk-sess-1" } });
      send({ type: "bridge.event", runId: msg.runId, event: { type: "assistant", message: { content: [{ type: "text", text: "Merhaba " }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }] } } });
      send({ type: "bridge.event", runId: msg.runId, event: { type: "result", subtype: "success", num_turns: 2, total_cost_usd: 0.0123, result: "Merhaba dünya", usage: { input_tokens: 10, output_tokens: 5 } } });
      send({ type: "bridge.done", runId: msg.runId });
    });
    await b.opened;
    b.send({ type: "bridge.hello", jobId: t.jobId, token, bridgeVersion: "t" });
    const session = await t.app.bridges.waitFor(t.jobId, 2000);

    const runner = new AgentRunner(t.app.db, t.app.pool, t.app.hub);
    const transport = new ContainerTransport(session, { containerRoot: "/workspace" });
    const res = await runner.run({
      jobId: t.jobId, role: "developer", prompt: "selam", model: "claude-opus-5-5",
      maxTurns: 5, maxBudgetUsd: 1, cwd: join(t.dir, "worktrees", t.jobId, "app"), transport,
    });

    assert.equal(res.subtype, "success");
    assert.equal(res.text, "Merhaba dünya");
    assert.equal(res.sessionId, "sdk-sess-1");
    assert.equal(res.costMicroUsd, 12_300);
    assert.equal(res.quota, false);

    // Kimlik köprüye AYRI mesajla gitti, run.start'tan önce.
    const types = b.received.map((m) => m.type);
    assert.deepEqual(types.slice(0, 2), ["identity.set", "run.start"]);

    // Olaylar hub'a düştü ve DB'ye yazıldı; sır yok.
    const events = t.app.hub.replay(t.jobId, 0);
    assert.ok(events.some((e) => e.type === "agent.tool_use"), "araç çağrısı yayınlanmadı");
    assert.ok(events.some((e) => e.type === "agent.end"), "bitiş yayınlanmadı");
    const runs = t.app.db.select().from(schema.agentRuns).all();
    assert.equal(runs[0]?.status, "success");
    assert.equal(runs[0]?.inputTokens, 10);
    b.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("koşu: köprü hata bildirirse runner 'error' ile biter, kota değil", async () => {
  const t = await startApp();
  try {
    const token = t.app.bridges.issueToken(t.jobId);
    const b = fakeBridge(t.url, (msg, send) => {
      send({ type: "bridge.error", runId: msg.runId, code: "sdk", message: "Claude Code process exited with code 1: invalid x-api-key" });
      send({ type: "bridge.done", runId: msg.runId });
    });
    await b.opened;
    b.send({ type: "bridge.hello", jobId: t.jobId, token, bridgeVersion: "t" });
    const session = await t.app.bridges.waitFor(t.jobId, 2000);

    const runner = new AgentRunner(t.app.db, t.app.pool, t.app.hub);
    const transport = new ContainerTransport(session, { containerRoot: "/workspace" });
    const res = await runner.run({
      jobId: t.jobId, role: "developer", prompt: "selam", model: "m",
      maxTurns: 1, maxBudgetUsd: 1, cwd: t.dir, transport,
    });
    assert.equal(res.subtype, "error");
    assert.equal(res.quota, false);
    const runs = t.app.db.select().from(schema.agentRuns).all();
    assert.match(runs[0]?.errorMessage ?? "", /x-api-key/);
    b.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("koşu: kota imzası result'ta gelirse kimlik dinlenmeye alınır ve sıradakine geçilir", async () => {
  const t = await startApp();
  try {
    // İki kimlik: ilki kotaya girer, ikincisi aynı oturumu sürdürür.
    writeFileSync(join(t.dir, "keys.txt"), "sk-ant-api03-BIR-0000\nsk-ant-api03-IKI-0000\n");
    t.app.pool.load();

    const token = t.app.bridges.issueToken(t.jobId);
    let calls = 0;
    const identities: string[] = [];
    const b = fakeBridge(t.url, (msg, send) => {
      calls++;
      if (calls === 1) {
        send({ type: "bridge.event", runId: msg.runId, event: { type: "system", session_id: "s-1" } });
        send({ type: "bridge.event", runId: msg.runId, event: { type: "result", subtype: "error_during_execution", result: "usage limit reached|1900000000" } });
      } else {
        assert.equal(msg.resumeSessionId, "s-1", "ikinci deneme aynı oturumdan sürmeli");
        send({ type: "bridge.event", runId: msg.runId, event: { type: "result", subtype: "success", result: "devam", total_cost_usd: 0 } });
      }
      send({ type: "bridge.done", runId: msg.runId });
    });
    b.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string; value?: string };
      if (m.type === "identity.set" && m.value) identities.push(m.value);
    });
    await b.opened;
    b.send({ type: "bridge.hello", jobId: t.jobId, token, bridgeVersion: "t" });
    const session = await t.app.bridges.waitFor(t.jobId, 2000);

    const runner = new AgentRunner(t.app.db, t.app.pool, t.app.hub);
    const transport = new ContainerTransport(session, { containerRoot: "/workspace" });
    const res = await runner.run({
      jobId: t.jobId, role: "planner", prompt: "plan", model: "m",
      maxTurns: 1, maxBudgetUsd: 1, cwd: t.dir, transport,
    });
    assert.equal(res.subtype, "success");
    assert.equal(res.text, "devam");
    assert.equal(calls, 2);
    assert.deepEqual(identities, ["sk-ant-api03-BIR-0000", "sk-ant-api03-IKI-0000"]);
    assert.equal(t.app.pool.status().available, 1, "kotaya giren kimlik dinlenmeye alınmadı");
    b.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("koşu: canlı kanal mesajları run.input olarak gider, kapanınca run.close", async () => {
  const t = await startApp();
  try {
    const token = t.app.bridges.issueToken(t.jobId);
    let runId = "";
    const b = fakeBridge(t.url, (msg, send) => {
      runId = msg.runId;
      assert.equal(msg.live, true);
      // Sahte SDK kanal kapanınca sonucu verir; bunu run.close gelince yapar.
      b.ws.addEventListener("message", (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string };
        if (m.type === "run.close") {
          send({ type: "bridge.event", runId: msg.runId, event: { type: "result", subtype: "success", result: "bitti" } });
          send({ type: "bridge.done", runId: msg.runId });
        }
      });
    });
    await b.opened;
    b.send({ type: "bridge.hello", jobId: t.jobId, token, bridgeVersion: "t" });
    const session = await t.app.bridges.waitFor(t.jobId, 2000);

    const channel = new LiveInputChannel();
    const runner = new AgentRunner(t.app.db, t.app.pool, t.app.hub);
    const transport = new ContainerTransport(session, { containerRoot: "/workspace" });
    const pending = runner.run({
      jobId: t.jobId, role: "developer", prompt: "başla", model: "m",
      maxTurns: 9, maxBudgetUsd: 1, cwd: t.dir, transport, channel,
    });

    await delay(100);
    channel.push("şu butonu düzelt");
    channel.push("şimdi kes", true);
    await delay(100);
    channel.close();

    const res = await pending;
    assert.equal(res.text, "bitti");
    const inputs = b.received.filter((m): m is Extract<ServerToBridge, { type: "run.input" }> => m.type === "run.input");
    assert.ok(inputs.some((m) => m.text === "şu butonu düzelt" && !m.interrupt));
    assert.ok(inputs.some((m) => m.interrupt), "kesme bayrağı köprüye gitmedi");
    assert.ok(b.received.some((m) => m.type === "run.close" && m.runId === runId));
    b.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("soru: köprüden bridge.question gelir, askUser cevabı run.answer olarak döner, olay ve mesajlar kaydedilir", async () => {
  const t = await startApp();
  try {
    const token = t.app.bridges.issueToken(t.jobId);
    let answered: string | null = null;
    const b = fakeBridge(t.url, (msg, send) => {
      assert.equal(msg.askTimeoutMinutes, 7, "askTimeoutMinutes run.start ile gitmeli");
      // Sahte SDK: soru sorar, cevabı bekler, sonra sonucu verir.
      b.ws.addEventListener("message", (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; questionId?: string; answer?: string };
        if (m.type === "run.answer" && m.questionId === "q-1") {
          answered = m.answer ?? null;
          send({ type: "bridge.event", runId: msg.runId, event: { type: "result", subtype: "success", result: `cevap: ${m.answer}` } });
          send({ type: "bridge.done", runId: msg.runId });
        }
      });
      send({ type: "bridge.question", runId: msg.runId, questionId: "q-1", text: "Hangi DB?", options: ["Postgres", "SQLite"] });
    });
    await b.opened;
    b.send({ type: "bridge.hello", jobId: t.jobId, token, bridgeVersion: "t" });
    const session = await t.app.bridges.waitFor(t.jobId, 2000);

    const runner = new AgentRunner(t.app.db, t.app.pool, t.app.hub);
    const transport = new ContainerTransport(session, { containerRoot: "/workspace" });
    const res = await runner.run({
      jobId: t.jobId, role: "developer", prompt: "x", model: "m", maxTurns: 3, maxBudgetUsd: 1, cwd: t.dir, transport,
      askTimeoutMinutes: 7,
      askUser: async (q) => { assert.equal(q.text, "Hangi DB?"); assert.deepEqual(q.options, ["Postgres", "SQLite"]); return "Postgres"; },
    });
    assert.equal(res.text, "cevap: Postgres");
    assert.equal(answered, "Postgres");

    const events = t.app.hub.replay(t.jobId, 0);
    const q = events.find((e) => e.type === "agent.question");
    assert.ok(q && q.type === "agent.question" && q.questionId === "q-1" && q.options.length === 2, "agent.question yayınlanmadı");
    const msgs = t.app.db.select().from(schema.messages).all();
    assert.ok(msgs.some((m) => m.kind === "question" && m.content === "Hangi DB?"));
    assert.ok(msgs.some((m) => m.kind === "answer" && m.content === "Postgres" && m.role === "user"));
    b.ws.close();
  } finally {
    await t.cleanup();
  }
});

test("koşu: köprü koparsa bekleyen koşu asılı kalmaz", async () => {
  const t = await startApp();
  try {
    const token = t.app.bridges.issueToken(t.jobId);
    const b = fakeBridge(t.url, () => {
      // Hiç cevap vermeden kop.
      setTimeout(() => b.ws.close(), 50);
    });
    await b.opened;
    b.send({ type: "bridge.hello", jobId: t.jobId, token, bridgeVersion: "t" });
    const session = await t.app.bridges.waitFor(t.jobId, 2000);

    const runner = new AgentRunner(t.app.db, t.app.pool, t.app.hub);
    const transport = new ContainerTransport(session, { containerRoot: "/workspace" });
    const res = await Promise.race([
      runner.run({ jobId: t.jobId, role: "qa", prompt: "x", model: "m", maxTurns: 1, maxBudgetUsd: 1, cwd: t.dir, transport }),
      delay(3000).then(() => { throw new Error("koşu asılı kaldı"); }),
    ]);
    assert.equal(res.subtype, "error");
    const runs = t.app.db.select().from(schema.agentRuns).all();
    assert.match(runs[0]?.errorMessage ?? "", /koptu/);
    assert.ok(new BridgeError("x", "y") instanceof Error);
  } finally {
    await t.cleanup();
  }
});
