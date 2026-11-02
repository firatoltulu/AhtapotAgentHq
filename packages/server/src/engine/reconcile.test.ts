import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { acquireLease, heldLeases } from "../resources/leases.js";
import { EventHub } from "../ws/hub.js";
import { reconcile } from "./reconcile.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-rec-"));
  const file = join(dir, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  const projectId = newId();
  h.db.insert(schema.projects).values({ id: projectId, slug: "p", name: "P", workspaceRoot: dir }).run();
  const job = (state: string, phase: string) => {
    const id = newId();
    h.db.insert(schema.jobs).values({ id, projectId, title: state, state, phase }).run();
    return id;
  };
  const stateOf = (id: string) => h.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).all()[0]!;
  return { db: h.db, hub: new EventHub(h.db), job, stateOf, cleanup() { h.sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("yarıda kalan işler NeedsAttention'a düşer, bekleyenler ve bitmişler dokunulmaz", async () => {
  const t = setup();
  try {
    const running = t.job("Developing", "running");
    const starting = t.job("Planning", "starting");
    const waiting = t.job("PlanReview", "waiting");
    const done = t.job("Done", "done");
    const attention = t.job("NeedsAttention", "running"); // olağan dışı ama olabilir

    const r = await reconcile(t.db, t.hub, null);

    assert.deepEqual(r.interruptedJobs.sort(), [running, starting].sort());
    assert.equal(t.stateOf(running).state, "NeedsAttention");
    assert.equal(t.stateOf(running).phase, "waiting");
    assert.equal(t.stateOf(running).errorCode, "interrupted");
    assert.equal(t.stateOf(starting).state, "NeedsAttention");
    assert.equal(t.stateOf(waiting).state, "PlanReview", "bekleyen işe dokunulmamalı");
    assert.equal(t.stateOf(done).state, "Done");
    assert.equal(t.stateOf(attention).state, "NeedsAttention");
    assert.equal(t.stateOf(attention).phase, "waiting", "faz normalize edilmeli");

    // Geçiş izi ve replay olayı yazıldı.
    const tr = t.db.select().from(schema.jobTransitions).where(eq(schema.jobTransitions.jobId, running)).all();
    assert.equal(tr[0]?.toState, "NeedsAttention");
    assert.ok(t.hub.replay(running, 0).some((e) => e.type === "job.state"));
  } finally {
    t.cleanup();
  }
});

test("bitmiş işlerin kiraları bırakılır; NeedsAttention'ınki post-mortem için kalır", async () => {
  const t = setup();
  try {
    const done = t.job("Done", "done");
    const cancelled = t.job("Cancelled", "done");
    const attention = t.job("NeedsAttention", "waiting");
    const live = t.job("Developing", "waiting");
    acquireLease(t.db, { jobId: done, kind: "port", value: "1" });
    acquireLease(t.db, { jobId: done, kind: "worktree", value: "/w/1" });
    acquireLease(t.db, { jobId: cancelled, kind: "port", value: "2" });
    acquireLease(t.db, { jobId: attention, kind: "worktree", value: "/w/3" });
    acquireLease(t.db, { jobId: live, kind: "port", value: "4" });

    const r = await reconcile(t.db, null, null);
    assert.equal(r.releasedLeases, 3);
    assert.equal(heldLeases(t.db, done).length, 0);
    assert.equal(heldLeases(t.db, cancelled).length, 0);
    assert.equal(heldLeases(t.db, attention).length, 1, "post-mortem kirası bırakılmamalı");
    assert.equal(heldLeases(t.db, live).length, 1);
  } finally {
    t.cleanup();
  }
});

test("yetim konteynerler kaldırılır; süren ve post-mortem işlerinki kalır; Docker hatası raporlanır", async () => {
  const t = setup();
  try {
    const dev = t.job("Developing", "waiting");
    const done = t.job("Done", "done");
    const attention = t.job("NeedsAttention", "waiting");
    const removed: string[] = [];
    const fake = {
      async listOwned() {
        return [
          { id: "1", jobId: dev, name: "c-dev", state: "running" },
          { id: "2", jobId: done, name: "c-done", state: "exited" },
          { id: "3", jobId: attention, name: "c-att", state: "exited" },
          { id: "4", jobId: "bilinmeyen", name: "c-yetim", state: "running" },
        ];
      },
      async remove(jobId: string) { removed.push(jobId); return true; },
    };
    const r = await reconcile(t.db, null, fake);
    assert.deepEqual(r.removedContainers.sort(), ["c-done", "c-yetim"]);
    assert.deepEqual(removed.sort(), [done, "bilinmeyen"].sort());
    assert.equal(r.containerError, null);

    const broken = { async listOwned(): Promise<never[]> { throw new Error("docker yok"); }, async remove() { return false; } };
    const r2 = await reconcile(t.db, null, broken);
    assert.match(r2.containerError ?? "", /docker yok/);

    // Bir konteyner kaldırılamazsa diğerleri yine kaldırılır, hata raporlanır.
    const removed2: string[] = [];
    const flaky = {
      async listOwned() {
        return [
          { id: "1", jobId: "yetim-1", name: "c-1", state: "exited" },
          { id: "2", jobId: "yetim-2", name: "c-2", state: "exited" },
        ];
      },
      async remove(jobId: string) { if (jobId === "yetim-1") throw new Error("meşgul"); removed2.push(jobId); return true; },
    };
    const r3 = await reconcile(t.db, null, flaky);
    assert.deepEqual(removed2, ["yetim-2"]);
    assert.deepEqual(r3.removedContainers, ["c-2"]);
    assert.match(r3.containerError ?? "", /c-1: meşgul/);
  } finally {
    t.cleanup();
  }
});
