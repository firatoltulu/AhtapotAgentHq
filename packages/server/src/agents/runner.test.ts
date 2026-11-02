import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { IdentityPool } from "./identity.js";
import { AgentRunner } from "./runner.js";
import type { AgentTransport, StartedRun } from "./transport.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-runner-"));
  const dbPath = join(dir, "t.sqlite");
  runMigrations(dbPath);
  const handle = openDb(dbPath);
  const keys = join(dir, "keys.txt");
  writeFileSync(keys, "sk-ant-oat-testkey\n", "utf8");
  const pool = new IdentityPool(handle.db, keys, 60);
  pool.load();
  // Windows açık SQLite dosyasını silmiyor (EPERM); temizlik testi düşürmesin.
  return {
    dir, db: handle.db, pool,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* geçici dizin */ } },
  };
}

/** Hiç mesaj üretmeyen, abort edilene kadar asılı kalan taşıma. */
function hangingTransport(): { transport: AgentTransport; aborted: () => string | null } {
  let abortReason: string | null = null;
  let release: (() => void) | null = null;
  let abortedEarly = false;
  const transport: AgentTransport = {
    start(): StartedRun {
      return {
        messages: {
          async *[Symbol.asyncIterator]() {
            // Tek bir "system" mesajı, sonra süresiz sessizlik.
            yield { type: "system", session_id: "s1" } as Record<string, unknown>;
            if (abortedEarly) return;
            await new Promise<void>((r) => { release = r; });
          },
        },
        async abort(reason: string) {
          abortReason = reason;
          // `release` henüz kurulmamış olabilir (akış ilk mesajı vermeden
          // kesildi): bayrağı bırak, akış oraya varınca kendi kendine bitsin.
          // Aksi hâlde kesme çağrısı hiçbir şeyi serbest bırakmıyor ve tur
          // gerçekten asılı kalıyor — bu testi yazarken 20 sn zaman aşımı.
          abortedEarly = true;
          release?.();
        },
      };
    },
  };
  return { transport, aborted: () => abortReason };
}

test("gözcü: mesaj akışı susan tur kesilir ve hata yazılır", async () => {
  // YAŞANDI: Planner bu ortamda olmayan WebSearch'ü çağırdı, çağrı hiç dönmedi,
  // iş 11 dakika "koşuyor" göründü. Zaman aşımı yoktu.
  const t = setup();
  const h = hangingTransport();
  try {
    const jobId = newId();
    t.db.insert(schema.projects).values({ id: "p1", name: "P", slug: "p", workspaceRoot: "/ws" }).run();
    t.db.insert(schema.jobs).values({ id: jobId, projectId: "p1", title: "T", state: "Planning", phase: "running" }).run();

    const runner = new AgentRunner(t.db, t.pool, null, h.transport);
    const res = await runner.run({
      jobId, role: "planner", prompt: "p", model: "claude-opus-5-5",
      maxTurns: 10, maxBudgetUsd: 1, cwd: t.dir,
      idleTimeoutMinutes: 0.005, // ~0.3 sn: gözcü 15 sn'de bir bakar, ilk turda keser
    });

    assert.ok(h.aborted(), "tur kesilmedi");
    assert.match(h.aborted() ?? "", /hiçbir mesaj üretmedi/);
    assert.equal(res.subtype, "error", "takılan tur hata olarak işaretlenmedi");

    const row = t.db.select().from(schema.agentRuns).all()[0];
    assert.equal(row?.status, "error", "takılan tur başarı sayıldı");
  } finally {
    t.cleanup();
  }
});

test("iptal: dışarıdan kesilen tur başarı sayılmaz", async () => {
  // YAŞANDI (Sevkiyat, 2026-09-16): iptal yalnız DB'ye durum yazıyordu; agent
  // arka planda koşmaya devam etti, kimlik ve bütçe yandı, dahası motor işi
  // hâlâ `busy` sayıp profil değişimini reddetti.
  const t = setup();
  const h = hangingTransport();
  try {
    const jobId = newId();
    t.db.insert(schema.projects).values({ id: "p1", name: "P", slug: "p", workspaceRoot: "/ws" }).run();
    t.db.insert(schema.jobs).values({ id: jobId, projectId: "p1", title: "T", state: "Developing", phase: "running" }).run();

    const runner = new AgentRunner(t.db, t.pool, null, h.transport);
    // Gözcü karışmasın: kesen şey insan iptali olmalı, zaman aşımı değil.
    const running = runner.run({
      jobId, role: "developer", prompt: "p", model: "claude-opus-5-5",
      maxTurns: 10, maxBudgetUsd: 1, cwd: t.dir, idleTimeoutMinutes: 60,
    });

    // Akışın sessizliğe oturmasını bekle. Erken `abort` işe yaramaz: sahte
    // taşıma `release`'i ancak ilk mesajdan SONRA kurar, öncesinde kesme
    // çağrısı hiçbir şeyi serbest bırakmaz ve tur gerçekten asılı kalır
    // (bu testi yazarken yaşandı — 20 sn zaman aşımı).
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await runner.abortJob(jobId, "insan iptal etti"), true, "koşan tur bulunamadı");

    const res = await running;
    assert.match(h.aborted() ?? "", /insan iptal etti/, "tur insan gerekçesiyle kesilmedi");
    assert.equal(res.subtype, "error", "kesilen tur başarı sayıldı");

    const row = t.db.select().from(schema.agentRuns).all()[0];
    assert.equal(row?.status, "error");

    // Bitmiş turda kesilecek bir şey kalmaz: kol temizlenmeli.
    assert.equal(await runner.abortJob(jobId, "ikinci kez"), false, "bitmiş tur hâlâ kesilebilir görünüyor");
  } finally {
    t.cleanup();
  }
});
