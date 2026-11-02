import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { openDb, newId, toMicroUsd, fromMicroUsd, schema } from "./index.js";
import { runMigrations } from "./migrate.js";

/** Her test kendi geçici veritabanını alır — testler birbirini kirletmesin. */
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-db-"));
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

async function seedProject(db: ReturnType<typeof freshDb>["db"]) {
  const projectId = newId();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "northwind",
    name: "Northwind",
    workspaceRoot: "C:/src/northwind",
  });
  return projectId;
}

test("migration: şema kurulur ve tablolar oluşur", () => {
  const t = freshDb();
  try {
    const rows = t.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const expected of ["projects", "jobs", "resource_leases", "messages", "identities"]) {
      assert.ok(names.includes(expected), `${expected} tablosu yok`);
    }
  } finally {
    t.cleanup();
  }
});

test("pragma: WAL ve foreign_keys açık", () => {
  const t = freshDb();
  try {
    assert.equal(String(t.sqlite.pragma("journal_mode", { simple: true })).toLowerCase(), "wal");
    // SQLite'ta foreign_keys VARSAYILAN KAPALIDIR; açılmazsa references() belge kalır.
    assert.equal(t.sqlite.pragma("foreign_keys", { simple: true }), 1);
  } finally {
    t.cleanup();
  }
});

test("kaynak kirası: aynı kaynak iki işe birden verilemez", async () => {
  const t = freshDb();
  try {
    const projectId = await seedProject(t.db);
    const jobA = newId();
    const jobB = newId();
    for (const id of [jobA, jobB]) {
      await t.db.insert(schema.jobs).values({ id, projectId, title: `iş ${id.slice(0, 4)}` });
    }

    await t.db.insert(schema.resourceLeases).values({
      id: newId(), jobId: jobA, kind: "port", value: "18042", state: "held",
    });

    // Kısmi benzersiz index (WHERE state='held') bunu DB seviyesinde engeller.
    await assert.rejects(
      t.db.insert(schema.resourceLeases).values({
        id: newId(), jobId: jobB, kind: "port", value: "18042", state: "held",
      }),
      /UNIQUE|constraint/i,
      "aynı port iki işe birden kiralandı",
    );
  } finally {
    t.cleanup();
  }
});

test("kaynak kirası: serbest bırakılan kaynak yeniden kiralanabilir", async () => {
  const t = freshDb();
  try {
    const projectId = await seedProject(t.db);
    const jobA = newId();
    const jobB = newId();
    for (const id of [jobA, jobB]) {
      await t.db.insert(schema.jobs).values({ id, projectId, title: "iş" });
    }

    const leaseId = newId();
    await t.db.insert(schema.resourceLeases).values({
      id: leaseId, jobId: jobA, kind: "port", value: "18042", state: "held",
    });
    await t.db
      .update(schema.resourceLeases)
      .set({ state: "released", releasedAt: new Date().toISOString() })
      .where(eq(schema.resourceLeases.id, leaseId));

    // Kısmi index yalnız 'held' satırları kapsar: serbest kalan değer yeniden alınabilir.
    await t.db.insert(schema.resourceLeases).values({
      id: newId(), jobId: jobB, kind: "port", value: "18042", state: "held",
    });

    const held = await t.db
      .select()
      .from(schema.resourceLeases)
      .where(eq(schema.resourceLeases.state, "held"));
    assert.equal(held.length, 1);
    assert.equal(held[0]?.jobId, jobB);
  } finally {
    t.cleanup();
  }
});

test("mesaj sırası: aynı iş içinde seq benzersiz", async () => {
  const t = freshDb();
  try {
    const projectId = await seedProject(t.db);
    const jobId = newId();
    await t.db.insert(schema.jobs).values({ id: jobId, projectId, title: "iş" });

    await t.db.insert(schema.messages).values({
      id: newId(), jobId, seq: 1, role: "assistant", kind: "text", content: "merhaba",
    });
    await assert.rejects(
      t.db.insert(schema.messages).values({
        id: newId(), jobId, seq: 1, role: "assistant", kind: "text", content: "çakışma",
      }),
      /UNIQUE|constraint/i,
      "aynı seq iki kez yazıldı — WS replay bozulurdu",
    );
  } finally {
    t.cleanup();
  }
});

test("foreign key: olmayan projeye iş açılamaz", async () => {
  const t = freshDb();
  try {
    await assert.rejects(
      t.db.insert(schema.jobs).values({ id: newId(), projectId: newId(), title: "yetim" }),
      /FOREIGN KEY|constraint/i,
    );
  } finally {
    t.cleanup();
  }
});

test("zaman damgaları ISO-8601 UTC biçiminde", async () => {
  const t = freshDb();
  try {
    const projectId = await seedProject(t.db);
    const [row] = await t.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    assert.match(row!.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    t.cleanup();
  }
});

test("UUIDv7 zaman sıralı — index parçalanmasını önler", () => {
  const ids = Array.from({ length: 50 }, () => newId());
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "v7 üretim sırası leksikografik sırayla aynı olmalı");
});

test("para mikro-dolar olarak tam sayı taşınır", () => {
  assert.equal(toMicroUsd(1.23), 1_230_000);
  assert.equal(fromMicroUsd(1_230_000), 1.23);
  // Float toplamanın klasik tuzağı: 0.1 + 0.2 !== 0.3
  assert.equal(toMicroUsd(0.1) + toMicroUsd(0.2), toMicroUsd(0.3));
});
