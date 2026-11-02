import { eq, sql } from "drizzle-orm";

import {
  canTransition,
  type JobPhase,
  type JobState,
} from "@ahtapot/shared";

import { newId, type Db, type Executor, schema } from "../db/index.js";

/**
 * Durum geçişleri — TEK GİRİŞ NOKTASI.
 *
 * Motorun hiçbir yeri `jobs.state` alanını doğrudan yazmaz. Üç güvence buradan
 * gelir:
 *
 *  1. Geçersiz geçiş reddedilir (ALLOWED_TRANSITIONS dışına çıkılamaz).
 *  2. Durum ve denetim izi AYNI transaction'da yazılır — biri yazılıp diğeri
 *     yazılmadan çökülemez.
 *  3. Durum yazılmadan hiçbir WS olayı yayınlanmaz. Tersi olsaydı istemci var
 *     olmayan bir duruma göre çizerdi ve yenilendiğinde geri sıçrardı.
 */

export class TransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
    readonly jobId: string,
  ) {
    super(`geçersiz geçiş: ${from} → ${to} (iş ${jobId})`);
    this.name = "TransitionError";
  }
}

export interface TransitionInput {
  jobId: string;
  to: JobState;
  reason?: string;
  actorType?: "human" | "agent" | "system";
  actor?: string;
  payload?: unknown;
  /** Geçişle birlikte ayarlanacak alt-faz. Verilmezse "starting". */
  phase?: JobPhase;
}

export interface TransitionResult {
  jobId: string;
  from: JobState;
  to: JobState;
  phase: JobPhase;
}

/**
 * İşi yeni duruma taşır.
 *
 * Varsayılan `phase` bilinçli olarak "starting": bir duruma girildiğinde ÖNCE
 * niyet yazılır, sonra iş yapılır. Açılışta `starting` görülen bir iş yarıda
 * kalmıştır ve `reconcile()` onu NeedsAttention'a düşürür. Sonuç yazılmadan
 * çöken bir süreç böylece sessizce "çalışıyor" görünmez.
 *
 * `within` aynı transaction'da koşar: durumla birlikte kalıcılaşması gereken
 * şey (replay için `job.state` olayı) buraya yazılır. Durum commit edilip olay
 * edilmezse istemci yeniden bağlandığında geçişi hiç görmez ve geçiş artık
 * geçersiz olduğu için tekrar da üretilemez.
 */
export function transition(
  db: Db,
  input: TransitionInput,
  within?: (tx: Executor) => void,
): TransitionResult {
  const { jobId, to } = input;
  const phase: JobPhase = input.phase ?? "starting";

  return db.transaction((tx) => {
    const rows = tx
      .select({ state: schema.jobs.state })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .all();

    const current = rows[0];
    if (!current) throw new Error(`iş bulunamadı: ${jobId}`);

    const from = current.state as JobState;
    if (!canTransition(from, to)) throw new TransitionError(from, to, jobId);

    tx.update(schema.jobs)
      .set({
        state: to,
        phase,
        ...(to === "Done" || to === "Cancelled"
          ? { completedAt: new Date().toISOString() }
          : {}),
      })
      .where(eq(schema.jobs.id, jobId))
      .run();

    tx.insert(schema.jobTransitions)
      .values({
        id: newId(),
        jobId,
        fromState: from,
        toState: to,
        reason: input.reason ?? "",
        actorType: input.actorType ?? "system",
        actor: input.actor ?? null,
        payload: (input.payload ?? null) as never,
      })
      .run();

    within?.(tx);

    return { jobId, from, to, phase };
  });
}

/**
 * Alt-fazı değiştirir (durum aynı kalır).
 *
 * `starting` → `running` → `waiting`/`done` akışı, çökme sonrası "bu iş nerede
 * kalmıştı" sorusunun cevabıdır.
 */
export function setPhase(db: Db, jobId: string, phase: JobPhase): void {
  db.update(schema.jobs).set({ phase }).where(eq(schema.jobs.id, jobId)).run();
}

/**
 * Döngü sayacını artırır ve tavanı aşıp aşmadığını söyler.
 *
 * Sonsuz otonom döngü bütçe yakar: build kırmızı → düzelt → yine kırmızı...
 * Tavana gelindiğinde insan çağrılır. DevAgent'ın MaxAttempts=2 dersinin
 * genelleştirilmiş hâli.
 */
export function bumpLoop(
  db: Db,
  jobId: string,
  key: "build" | "qa" | "live" | "local_review" | "static_review" | "quality_review" | "ci" | "ci_merge" | "fix_push" | "pre_pr_merge",
  max: number,
): { count: number; exceeded: boolean } {
  return db.transaction((tx) => {
    const rows = tx
      .select({ loopCounts: schema.jobs.loopCounts })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .all();

    const row = rows[0];
    if (!row) throw new Error(`iş bulunamadı: ${jobId}`);

    const counts = (row.loopCounts ?? {}) as Record<string, number>;
    const count = (counts[key] ?? 0) + 1;
    counts[key] = count;

    tx.update(schema.jobs)
      .set({ loopCounts: counts as never })
      .where(eq(schema.jobs.id, jobId))
      .run();

    return { count, exceeded: count > max };
  });
}

/**
 * Bir sonraki olay sırası (`seq`).
 *
 * İş içinde monoton artar; WS yeniden bağlanmasında `sinceSeq` ile eksikler
 * replay edilir. Aynı transaction içinde okunup yazıldığı için iki eşzamanlı
 * yayın aynı numarayı alamaz — `ux_events_job_seq` bunu ayrıca garanti eder.
 */
export function nextEventSeq(db: Executor, jobId: string): number {
  const rows = db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${schema.jobEvents.seq}), 0)` })
    .from(schema.jobEvents)
    .where(eq(schema.jobEvents.jobId, jobId))
    .all();
  return (rows[0]?.maxSeq ?? 0) + 1;
}

export function nextMessageSeq(db: Executor, jobId: string): number {
  const rows = db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${schema.messages.seq}), 0)` })
    .from(schema.messages)
    .where(eq(schema.messages.jobId, jobId))
    .all();
  return (rows[0]?.maxSeq ?? 0) + 1;
}
