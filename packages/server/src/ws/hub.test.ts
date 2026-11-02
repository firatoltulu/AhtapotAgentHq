import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { openDb, newId, schema, type Db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { EventHub, type Socket } from "./hub.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-ws-"));
  const file = join(dir, "test.sqlite");
  runMigrations(file);
  const handle = openDb(file);
  return {
    ...handle,
    cleanup: () => {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let slugCounter = 0;

function seedJob(db: Db): string {
  const projectId = newId();
  db.insert(schema.projects)
    .values({
      id: projectId,
      // slug benzersiz: aynı testte iki proje açılabilsin.
      slug: `northwind-${slugCounter++}`,
      name: "Northwind",
      workspaceRoot: "C:/src/northwind",
    })
    .run();
  const jobId = newId();
  db.insert(schema.jobs).values({ id: jobId, projectId, title: "iş" }).run();
  return jobId;
}

/** Gönderilenleri toplayan sahte soket; backpressure simülasyonu için ayarlanabilir. */
function fakeSocket(bufferedAmount = 0) {
  const sent: string[] = [];
  const socket: Socket = {
    send: (d) => void sent.push(d),
    get bufferedAmount() {
      return bufferedAmount;
    },
  };
  return { socket, sent, types: () => sent.map((s) => JSON.parse(s).type as string) };
}

test("yayın: abone olayı alır", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const a = fakeSocket();
    hub.subscribe(jobId, a.socket);

    hub.publish(jobId, { type: "job.state", state: "Planning", phase: "starting", loopCounts: {} });
    assert.equal(a.sent.length, 1);
    assert.equal(a.types()[0], "job.state");
  } finally {
    t.cleanup();
  }
});

test("yayın: başka işin abonesine gitmez", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobA = seedJob(t.db);
    const jobB = seedJob(t.db);
    const a = fakeSocket();
    const b = fakeSocket();
    hub.subscribe(jobA, a.socket);
    hub.subscribe(jobB, b.socket);

    hub.publish(jobA, { type: "job.state", state: "Planning", phase: "starting", loopCounts: {} });
    assert.equal(a.sent.length, 1);
    assert.equal(b.sent.length, 0, "olay yanlış odaya sızdı");
  } finally {
    t.cleanup();
  }
});

test("seq: iş içinde monoton artar", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const e1 = hub.publish(jobId, { type: "job.state", state: "Planning", phase: "starting", loopCounts: {} });
    const e2 = hub.publish(jobId, { type: "job.state", state: "PlanReview", phase: "waiting", loopCounts: {} });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
  } finally {
    t.cleanup();
  }
});

test("delta: DB'ye yazılmaz ama canlı izleyiciye gider", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const a = fakeSocket();
    hub.subscribe(jobId, a.socket);

    hub.publish(jobId, { type: "agent.delta", runId: "r1", blockIndex: 0, text: "mer" });
    hub.publish(jobId, { type: "agent.delta", runId: "r1", blockIndex: 0, text: "haba" });

    assert.equal(a.sent.length, 2, "canlı izleyici delta'ları görmeli");

    const rows = t.db
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, jobId))
      .all();
    assert.equal(rows.length, 0, "token akışı kalıcılaştırılmamalı (hacim)");
  } finally {
    t.cleanup();
  }
});

test("replay: sinceSeq'ten sonrasını sırayla döndürür", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    for (const state of ["Planning", "PlanReview", "Developing"] as const) {
      hub.publish(jobId, { type: "job.state", state, phase: "starting", loopCounts: {} });
    }

    // İstemci ilk olaydan sonra koptu, şimdi geri geliyor.
    const missed = hub.replay(jobId, 1);
    assert.equal(missed.length, 2);
    assert.deepEqual(missed.map((e) => e.seq), [2, 3]);
  } finally {
    t.cleanup();
  }
});

test("replay: delta'lar geçmişte yok, nihai mesaj var", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    hub.publish(jobId, { type: "agent.delta", runId: "r1", blockIndex: 0, text: "yarım" });
    hub.publish(jobId, {
      type: "agent.message", runId: "r1", role: "assistant", content: "yarım cümle tamamlandı",
    });

    const all = hub.replay(jobId, 0);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.type, "agent.message", "içerik kaybı olmamalı");
  } finally {
    t.cleanup();
  }
});

test("maskeleme: olaydaki sır DB'ye ve sokete maskeli gider", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const a = fakeSocket();
    hub.subscribe(jobId, a.socket);

    hub.publish(jobId, {
      type: "build.log",
      stream: "stdout",
      line: "token=sk-ant-oat01-COKGIZLIDEGER kullanıldı",
    });

    assert.ok(!a.sent[0]!.includes("COKGIZLIDEGER"), "sır sokete sızdı");

    const rows = t.db
      .select({ payload: schema.jobEvents.payload })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, jobId))
      .all();
    assert.ok(
      !JSON.stringify(rows[0]?.payload).includes("COKGIZLIDEGER"),
      "sır veritabanına sızdı",
    );
  } finally {
    t.cleanup();
  }
});

/**
 * Maskeleme SABİT bir alan listesine bağlıydı (`text`, `content`, `line`…) ve
 * yeni metin alanı eklendiğinde listeyi güncellemek unutuluyordu: `command`,
 * `cwd` ve araç alanları maskelenmeden geçiyordu. `.env` düzenleyen bir `Edit`
 * olayı, farkıyla birlikte sırrı hem DB'ye hem UI'a taşırdı.
 */
test("maskeleme: araç alanları da (komut, dizin, fark) maskelenir", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const a = fakeSocket();
    hub.subscribe(jobId, a.socket);

    hub.publish(jobId, {
      type: "agent.tool_use",
      runId: "r",
      toolId: "t",
      name: "Edit",
      inputSummary: "{}",
      file: ".env",
      command: "export TOKEN=sk-ant-oat01-KOMUTTAKISIR",
      cwd: "/w",
      meta: ["+1 −1"],
      diff: [
        ["-", "TOKEN=sk-ant-oat01-ESKISIR"],
        ["+", "TOKEN=sk-ant-oat01-YENISIR"],
      ],
    });

    const wire = a.sent[0] ?? "";
    assert.ok(!wire.includes("KOMUTTAKISIR"), "komuttaki sır sokete sızdı");
    assert.ok(!wire.includes("ESKISIR"), "fark satırındaki sır sokete sızdı");
    assert.ok(!wire.includes("YENISIR"), "fark satırındaki sır sokete sızdı");

    const rows = t.db
      .select({ payload: schema.jobEvents.payload })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, jobId))
      .all();
    const stored = JSON.stringify(rows[0]?.payload);
    assert.ok(!stored.includes("KOMUTTAKISIR"), "komuttaki sır veritabanına sızdı");
    assert.ok(!stored.includes("ESKISIR"), "fark satırındaki sır veritabanına sızdı");
  } finally {
    t.cleanup();
  }
});

/**
 * Maskeleme makine kimliklerine DOKUNMAMALI: `scrubSecrets` bir `toolId`yi
 * ya da `runId`yi sır sanıp bozarsa komut sonucuyla eşleşmez ve akışta
 * "koşuyor" diye asılı kalır.
 */
test("maskeleme: kimlik alanları bozulmaz", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const a = fakeSocket();
    hub.subscribe(jobId, a.socket);

    hub.publish(jobId, {
      type: "agent.tool_use",
      runId: "run-01a0a989",
      toolId: "toolu_01ABCdefGHIjklMNOpqrs",
      name: "Bash",
      inputSummary: "{}",
      command: "npm run build",
      meta: [],
      diff: [],
    });

    const sent = JSON.parse(a.sent[0] ?? "{}") as Record<string, unknown>;
    assert.equal(sent["toolId"], "toolu_01ABCdefGHIjklMNOpqrs");
    assert.equal(sent["runId"], "run-01a0a989");
    assert.equal(sent["jobId"], jobId);
  } finally {
    t.cleanup();
  }
});

test("backpressure: yavaş istemcide delta atlanır, mesaj atlanmaz", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    // Tampon dolu bir istemci.
    const slow = fakeSocket(5_000_000);
    hub.subscribe(jobId, slow.socket);

    hub.publish(jobId, { type: "agent.delta", runId: "r1", blockIndex: 0, text: "atlanacak" });
    assert.equal(slow.sent.length, 0, "delta yavaş istemciye zorlanmamalı");

    hub.publish(jobId, {
      type: "agent.message", runId: "r1", role: "assistant", content: "bu gitmeli",
    });
    assert.equal(slow.sent.length, 1, "nihai içerik her durumda gitmeli");
  } finally {
    t.cleanup();
  }
});

test("abonelik: unsubscribe sonrası olay gitmez", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const a = fakeSocket();
    const sub = hub.subscribe(jobId, a.socket);
    assert.equal(hub.subscriberCount(jobId), 1);

    hub.unsubscribe(sub);
    assert.equal(hub.subscriberCount(jobId), 0);

    hub.publish(jobId, { type: "job.state", state: "Planning", phase: "starting", loopCounts: {} });
    assert.equal(a.sent.length, 0);
  } finally {
    t.cleanup();
  }
});

test("kopmuş soket yayını engellemez", () => {
  const t = freshDb();
  try {
    const hub = new EventHub(t.db);
    const jobId = seedJob(t.db);
    const broken: Socket = {
      send() {
        throw new Error("soket kapalı");
      },
    };
    const good = fakeSocket();
    hub.subscribe(jobId, broken);
    hub.subscribe(jobId, good.socket);

    hub.publish(jobId, { type: "job.state", state: "Planning", phase: "starting", loopCounts: {} });
    assert.equal(good.sent.length, 1, "bir abonenin hatası diğerini etkilememeli");
    assert.equal(hub.subscriberCount(jobId), 1, "kopmuş abone temizlenmeli");
  } finally {
    t.cleanup();
  }
});
