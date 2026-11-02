import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { PortPool, PortsExhausted, probePort } from "./ports.js";

/**
 * Port havuzu testleri — gerçek soketler.
 *
 * Aralık yüksek ve dar tutuldu; bir portu gerçekten dinleyerek "kira tablosu
 * boş ama host dolu" durumunu üretiyoruz. Windows'ta WinNAT'ın hariç
 * aralıkları da aynı yoldan (EACCES) yakalanır.
 */

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-ports-"));
  const file = join(dir, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  const projectId = newId();
  h.db.insert(schema.projects).values({ id: projectId, slug: "p", name: "P", workspaceRoot: dir }).run();
  const newJob = () => {
    const id = newId();
    h.db.insert(schema.jobs).values({ id, projectId, title: "iş" }).run();
    return id;
  };
  return { db: h.db, newJob, cleanup() { h.sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ port, host: "0.0.0.0" }, () => resolve(s));
  });
}

test("probe: boş port evet, dinlenen port hayır", async () => {
  const s = await listen(0);
  const port = (s.address() as { port: number }).port;
  try {
    assert.equal(await probePort(port), false);
  } finally {
    await new Promise((r) => s.close(r));
  }
  assert.equal(await probePort(port), true);
});

test("havuz: iki iş farklı port alır, host'ta dolu port atlanır, bırakılan geri gelir", async () => {
  const t = setup();
  const base = 47100;
  const busy = await listen(base); // aralığın ilk portu host'ta dolu
  try {
    const pool = new PortPool(t.db, { from: base, to: base + 5 });
    const a = t.newJob();
    const b = t.newJob();
    const pa = await pool.acquire(a, 2);
    assert.deepEqual(pa, [base + 1, base + 2], "dolu port atlanmalı");
    const pb = await pool.acquire(b, 1);
    assert.deepEqual(pb, [base + 3]);
    assert.deepEqual(pool.held(a), [base + 1, base + 2]);

    assert.equal(pool.release(a), 2);
    const pc = await pool.acquire(t.newJob(), 1);
    assert.equal(pc[0], base + 1, "bırakılan port yeniden verilmeli");
  } finally {
    await new Promise((r) => busy.close(r));
    t.cleanup();
  }
});

test("havuz: yetmezse hiçbiri verilmez (yarım tahsis sızıntı olur)", async () => {
  const t = setup();
  try {
    const pool = new PortPool(t.db, { from: 47200, to: 47201 }, async () => true);
    const a = t.newJob();
    await assert.rejects(() => pool.acquire(a, 3), PortsExhausted);
    assert.deepEqual(pool.held(a), [], "başarısız tahsis kira bırakmamalı");
    assert.deepEqual(await pool.acquire(a, 2), [47200, 47201]);
  } finally {
    t.cleanup();
  }
});

test("havuz: probe beklenmedik hata fırlatırsa alınan kiralar geri verilir, hata korunur", async () => {
  const t = setup();
  try {
    let n = 0;
    const pool = new PortPool(t.db, { from: 47210, to: 47215 }, async () => {
      if (++n === 2) throw new Error("probe patladı");
      return true;
    });
    const a = t.newJob();
    await assert.rejects(() => pool.acquire(a, 2), /probe patladı/);
    assert.deepEqual(pool.held(a), [], "ilk port kirada kalmamalı");
  } finally {
    t.cleanup();
  }
});

test("havuz: geçersiz aralık reddedilir", () => {
  const t = setup();
  try {
    assert.throws(() => new PortPool(t.db, { from: 10, to: 5 }));
    assert.throws(() => new PortPool(t.db, { from: 0, to: 5 }));
  } finally {
    t.cleanup();
  }
});
