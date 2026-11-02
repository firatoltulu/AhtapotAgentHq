import { eq } from "drizzle-orm";

import { schema, type Db } from "../db/index.js";

export interface WorkedTime {
  /** İş açılışından bitişe (bitmediyse şimdiye) — ms. */
  wallMs: number;
  /** Agent koşularının toplamı — paralel koşular ayrı ayrı sayılır. */
  agentMs: number;
  /** Onay kapılarında insanın beklenmesi. */
  humanWaitMs: number;
}

const span = (from: string, to: string | null | undefined, nowMs: number): number =>
  Math.max(0, (to ? Date.parse(to) : nowMs) - Date.parse(from));

export function workedTime(db: Db, jobId: string, nowMs = Date.now()): WorkedTime | null {
  const job = db
    .select({ createdAt: schema.jobs.createdAt, completedAt: schema.jobs.completedAt })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .get();
  if (!job) return null;
  const runs = db
    .select({ startedAt: schema.agentRuns.startedAt, endedAt: schema.agentRuns.endedAt })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.jobId, jobId))
    .all();
  const gates = db
    .select({ requestedAt: schema.approvals.requestedAt, decidedAt: schema.approvals.decidedAt })
    .from(schema.approvals)
    .where(eq(schema.approvals.jobId, jobId))
    .all();
  return {
    wallMs: span(job.createdAt, job.completedAt, nowMs),
    agentMs: runs.reduce((a, r) => a + span(r.startedAt, r.endedAt, nowMs), 0),
    humanWaitMs: gates.reduce((a, g) => a + span(g.requestedAt, g.decidedAt, nowMs), 0),
  };
}

/** `2 sa 14 dk` · `3 g 4 sa` · `<1 dk` */
export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1 dk";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d} g ${h} sa` : `${d} g`;
  if (h > 0) return m > 0 ? `${h} sa ${m} dk` : `${h} sa`;
  return `${m} dk`;
}

export function renderWorkedTime(t: WorkedTime): string {
  return [
    "| | Süre |",
    "|---|---|",
    `| Toplam (açılıştan) | ${formatDuration(t.wallMs)} |`,
    `| Agent çalışması | ${formatDuration(t.agentMs)} |`,
    `| İnsan onayı beklemesi | ${formatDuration(t.humanWaitMs)} |`,
  ].join("\n");
}
