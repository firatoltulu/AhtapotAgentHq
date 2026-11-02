import { and, eq } from "drizzle-orm";

import { newId, isoNow, type Db, schema } from "../db/index.js";

/**
 * Kaynak kiraları — TEK TAHSİS OTORİTESİ.
 *
 * Port, DB, worktree, ağ ve canlı ortam buradan kiralanır. Hiçbir modül kendi
 * başına "bu port boş görünüyor" diye seçim yapmaz: iki iş aynı anda aynı
 * karara varır ve çakışma ancak çalışma zamanında anlaşılır.
 *
 * Biriciklik veritabanında: `ux_lease_kind_value_held` kısmi index'i aynı
 * kaynağın iki `held` kirasını imkânsız kılar. Buradaki kod yarışı kazanmaya
 * çalışmaz, index'in reddini `LeaseConflict`e çevirir.
 */

export type LeaseKind = "port" | "db" | "worktree" | "network" | "identity" | "live_env";

export class LeaseConflict extends Error {
  constructor(readonly kind: LeaseKind, readonly value: string) {
    super(`kaynak zaten kirada: ${kind}=${value}`);
    this.name = "LeaseConflict";
  }
}

export interface Lease {
  id: string;
  jobId: string | null;
  kind: LeaseKind;
  value: string;
}

export function acquireLease(
  db: Db,
  input: { jobId: string | null; kind: LeaseKind; value: string; expiresAt?: string },
): Lease {
  const id = newId();
  try {
    db.insert(schema.resourceLeases)
      .values({
        id,
        jobId: input.jobId,
        kind: input.kind,
        value: input.value,
        state: "held",
        expiresAt: input.expiresAt ?? null,
      })
      .run();
  } catch (err) {
    // SQLite: "UNIQUE constraint failed"; PG: "duplicate key value". İkisi de
    // aynı anlama gelir — kaynak başkasında.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|duplicate key/i.test(msg)) throw new LeaseConflict(input.kind, input.value);
    throw err;
  }
  return { id, jobId: input.jobId, kind: input.kind, value: input.value };
}

/** Kirayı bırakır. Zaten bırakılmışsa sessizce geçer — idempotent olmalı. */
export function releaseLease(db: Db, kind: LeaseKind, value: string): boolean {
  const result = db
    .update(schema.resourceLeases)
    .set({ state: "released", releasedAt: isoNow() })
    .where(
      and(
        eq(schema.resourceLeases.kind, kind),
        eq(schema.resourceLeases.value, value),
        eq(schema.resourceLeases.state, "held"),
      ),
    )
    .run();
  return result.changes > 0;
}

/** Bir işin tuttuğu kiralar (türe göre süzülebilir). */
export function heldLeases(db: Db, jobId: string, kind?: LeaseKind): Lease[] {
  const rows = db
    .select()
    .from(schema.resourceLeases)
    .where(
      and(
        eq(schema.resourceLeases.jobId, jobId),
        eq(schema.resourceLeases.state, "held"),
        ...(kind ? [eq(schema.resourceLeases.kind, kind)] : []),
      ),
    )
    .all();
  return rows.map((r) => ({ id: r.id, jobId: r.jobId, kind: r.kind as LeaseKind, value: r.value }));
}
