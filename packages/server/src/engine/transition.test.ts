import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { openDb, newId, schema, type Db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { transition, setPhase, bumpLoop, nextEventSeq, TransitionError } from "./transition.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-eng-"));
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

function seedJob(db: Db): string {
  const projectId = newId();
  db.insert(schema.projects)
    .values({ id: projectId, slug: "northwind", name: "Northwind", workspaceRoot: "C:/src/northwind" })
    .run();
  const jobId = newId();
  db.insert(schema.jobs).values({ id: jobId, projectId, title: "test işi" }).run();
  return jobId;
}

function stateOf(db: Db, jobId: string) {
  const rows = db
    .select({ state: schema.jobs.state, phase: schema.jobs.phase })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .all();
  return rows[0]!;
}

test("geçiş: durum değişir ve denetim izi yazılır", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    const r = transition(t.db, { jobId, to: "Planning", reason: "kullanıcı başlattı", actorType: "human" });

    assert.equal(r.from, "Draft");
    assert.equal(r.to, "Planning");
    assert.equal(stateOf(t.db, jobId).state, "Planning");

    const trs = t.db
      .select()
      .from(schema.jobTransitions)
      .where(eq(schema.jobTransitions.jobId, jobId))
      .all();
    assert.equal(trs.length, 1);
    assert.equal(trs[0]?.fromState, "Draft");
    assert.equal(trs[0]?.reason, "kullanıcı başlattı");
    assert.equal(trs[0]?.actorType, "human");
  } finally {
    t.cleanup();
  }
});

test("geçiş: geçersiz hedef reddedilir ve HİÇBİR ŞEY yazılmaz", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    assert.throws(() => transition(t.db, { jobId, to: "QA" }), TransitionError);

    // Durum korunmalı ve yarım bir denetim izi kalmamalı.
    assert.equal(stateOf(t.db, jobId).state, "Draft");
    const trs = t.db
      .select()
      .from(schema.jobTransitions)
      .where(eq(schema.jobTransitions.jobId, jobId))
      .all();
    assert.equal(trs.length, 0, "reddedilen geçiş iz bırakmamalı");
  } finally {
    t.cleanup();
  }
});

test("geçiş: yeni duruma girerken faz 'starting' olur", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    transition(t.db, { jobId, to: "Planning" });
    // Kesinti dayanıklılığı: önce niyet yazılır, sonra iş yapılır. Açılışta
    // 'starting' görülen iş yarıda kalmıştır.
    assert.equal(stateOf(t.db, jobId).phase, "starting");

    setPhase(t.db, jobId, "running");
    assert.equal(stateOf(t.db, jobId).phase, "running");
  } finally {
    t.cleanup();
  }
});

test("geçiş: terminal durumda completedAt damgalanır", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    transition(t.db, { jobId, to: "Cancelled", reason: "vazgeçildi" });
    const rows = t.db
      .select({ completedAt: schema.jobs.completedAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .all();
    assert.ok(rows[0]?.completedAt, "completedAt yazılmadı");
  } finally {
    t.cleanup();
  }
});

test("geçiş: tam pipeline akışı yürür", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    const path = [
      "Planning", "PlanReview", "Developing", "Building",
      "LiveTest", "QACases", "QA", "PRReview", "CIWatch", "Done",
    ] as const;
    for (const to of path) transition(t.db, { jobId, to });
    assert.equal(stateOf(t.db, jobId).state, "Done");

    const trs = t.db
      .select()
      .from(schema.jobTransitions)
      .where(eq(schema.jobTransitions.jobId, jobId))
      .all();
    assert.equal(trs.length, path.length);
  } finally {
    t.cleanup();
  }
});

test("geçiş: kırmızı build Developing'e geri döndürür", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    for (const to of ["Planning", "PlanReview", "Developing", "Building"] as const) {
      transition(t.db, { jobId, to });
    }
    transition(t.db, { jobId, to: "Developing", reason: "build kırmızı" });
    assert.equal(stateOf(t.db, jobId).state, "Developing");
  } finally {
    t.cleanup();
  }
});

test("döngü sayacı: tavan aşıldığında bildirir", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    assert.deepEqual(bumpLoop(t.db, jobId, "build", 3), { count: 1, exceeded: false });
    assert.deepEqual(bumpLoop(t.db, jobId, "build", 3), { count: 2, exceeded: false });
    assert.deepEqual(bumpLoop(t.db, jobId, "build", 3), { count: 3, exceeded: false });
    // Dördüncü deneme tavanı aşar → insan çağrılır.
    assert.deepEqual(bumpLoop(t.db, jobId, "build", 3), { count: 4, exceeded: true });
  } finally {
    t.cleanup();
  }
});

test("döngü sayacı: anahtarlar birbirinden bağımsız", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    bumpLoop(t.db, jobId, "build", 3);
    bumpLoop(t.db, jobId, "build", 3);
    const qa = bumpLoop(t.db, jobId, "qa", 3);
    assert.equal(qa.count, 1, "qa sayacı build'den etkilenmemeli");
  } finally {
    t.cleanup();
  }
});

test("olay sırası: boş işte 1'den başlar ve artar", () => {
  const t = freshDb();
  try {
    const jobId = seedJob(t.db);
    assert.equal(nextEventSeq(t.db, jobId), 1);

    t.db.insert(schema.jobEvents)
      .values({ id: newId(), jobId, seq: 1, type: "job.state", payload: {} as never })
      .run();
    assert.equal(nextEventSeq(t.db, jobId), 2);
  } finally {
    t.cleanup();
  }
});
