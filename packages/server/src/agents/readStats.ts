import { and, desc, eq, inArray } from "drizzle-orm";

import { schema, type Db } from "../db/index.js";

/**
 * Bir rolün işler arasında tekrar tekrar okuduğu dosyaların ölçümü.
 *
 * Soru: Planner her işte aynı dosyaları mı okuyor, ve bu ne kadar tutuyor?
 * Kod haritası / doküman gömme kararı (bkz. kararlar) bu ölçüme dayanmalı,
 * sezgiye değil. Veri zaten `job_events`te: `agent.tool_use` dosya yolunu,
 * `agent.tool_result` (2026-10-12'den sonra) sonucun boyunu taşıyor.
 *
 * Salt okunur; hiçbir şey yazmaz.
 */

export interface ReadStatsOptions {
  role: string;
  /** En son kaç işe bakılır. */
  jobs: number;
  /** Listede kaç dosya/arama döner. */
  top: number;
}

export interface FileReadStat {
  /** Worktree önekinden arındırılmış yol: `<repo>/yol/dosya.cs`. */
  path: string;
  /** Kaç farklı işte okundu. */
  jobs: number;
  /** Toplam okuma sayısı (aynı işte tekrarlar dahil). */
  reads: number;
  /** Bilinen sonuç boylarının toplamı (karakter); boy kaydı olmayan okumalar sayılmaz. */
  chars: number;
  /** İşlerin kaçında ilk 15 araç çağrısında okundu — yönlenme okuması mı? */
  earlyJobs: number;
}

export interface ReadStats {
  role: string;
  jobsAnalyzed: number;
  runsAnalyzed: number;
  totals: {
    toolCalls: number;
    reads: number;
    /** Dosyaların en az yarısındaki işlerde okunan dosyalara giden okuma payı (0-1). */
    repeatedShare: number;
    /** Boy kaydı olan okumaların toplam karakteri ve kaba token karşılığı (~4 kr/token). */
    readChars: number;
    readTokensApprox: number;
    /** Koşuların API kullanımı — tekrarın toplam içindeki yerini görmek için. */
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costMicroUsd: number;
    /** Trail kod grafiği araç çağrıları (karar §44) — grafikli/grafiksiz işleri ayırmak için. */
    graphCalls: number;
  };
  files: FileReadStat[];
  searches: Array<{ tool: string; query: string; jobs: number; calls: number }>;
  perJob: Array<{ jobId: string; title: string; toolCalls: number; reads: number; distinctFiles: number; inputTokens: number; graphCalls: number }>;
}

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const EARLY_CALLS = 15;

/**
 * Trail MCP araçları: `mcp__trail__trail_find_code`, çok repoda
 * `mcp__trail-<repo>__…`. Arama sayılır; kısa adla (`trail_find_code`) gruplanır.
 */
export function graphToolName(name: string): string | null {
  const m = /^mcp__trail(?:-[a-z0-9_-]+)?__(.+)$/.exec(name);
  return m ? m[1]! : null;
}

/**
 * Worktree her işte farklı dizinde (`<root>/worktrees/<jobId>/<repo>`):
 * yol olduğu gibi gruplanırsa aynı dosya her işte "farklı" görünür.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^.*?\/worktrees\/[^/]+\//, "");
}

export function computeReadStats(db: Db, projectId: string, opts: ReadStatsOptions): ReadStats {
  const runs = db.select({
    id: schema.agentRuns.id,
    jobId: schema.agentRuns.jobId,
    inputTokens: schema.agentRuns.inputTokens,
    cacheReadTokens: schema.agentRuns.cacheReadTokens,
    cacheCreationTokens: schema.agentRuns.cacheCreationTokens,
    costMicroUsd: schema.agentRuns.costMicroUsd,
    title: schema.jobs.title,
  })
    .from(schema.agentRuns)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.agentRuns.jobId))
    .where(and(eq(schema.jobs.projectId, projectId), eq(schema.agentRuns.role, opts.role)))
    .orderBy(desc(schema.agentRuns.startedAt))
    .all();

  // Son N iş — koşu sayısına göre değil; bir işte birden çok Planner turu olabilir.
  const jobIds: string[] = [];
  for (const r of runs) {
    if (r.jobId && !jobIds.includes(r.jobId)) jobIds.push(r.jobId);
    if (jobIds.length >= opts.jobs) break;
  }
  const keptRuns = runs.filter((r) => r.jobId && jobIds.includes(r.jobId));
  const runIds = new Set(keptRuns.map((r) => r.id));

  const events = jobIds.length === 0 ? [] : db.select({
    jobId: schema.jobEvents.jobId,
    seq: schema.jobEvents.seq,
    type: schema.jobEvents.type,
    payload: schema.jobEvents.payload,
  })
    .from(schema.jobEvents)
    .where(and(
      inArray(schema.jobEvents.jobId, jobIds),
      inArray(schema.jobEvents.type, ["agent.tool_use", "agent.tool_result"]),
    ))
    .all()
    .sort((a, b) => a.seq - b.seq);

  // Sonuç boyları toolId ile eşlenir.
  const charsByTool = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "agent.tool_result") continue;
    const p = e.payload as Record<string, unknown>;
    if (typeof p["chars"] === "number") charsByTool.set(String(p["toolId"]), p["chars"]);
  }

  const files = new Map<string, { jobs: Set<string>; reads: number; chars: number; early: Set<string> }>();
  const searches = new Map<string, { tool: string; query: string; jobs: Set<string>; calls: number }>();
  const perJob = new Map<string, { toolCalls: number; reads: number; files: Set<string>; graphCalls: number }>();
  let toolCalls = 0;
  let graphCalls = 0;
  let reads = 0;
  let readChars = 0;

  for (const e of events) {
    if (e.type !== "agent.tool_use") continue;
    const p = e.payload as Record<string, unknown>;
    if (!runIds.has(String(p["runId"]))) continue;
    const name = String(p["name"] ?? "");
    const job = perJob.get(e.jobId) ?? { toolCalls: 0, reads: 0, files: new Set<string>(), graphCalls: 0 };
    perJob.set(e.jobId, job);
    job.toolCalls += 1;
    toolCalls += 1;

    if (READ_TOOLS.has(name) && typeof p["file"] === "string") {
      const path = normalizePath(p["file"]);
      const f = files.get(path) ?? { jobs: new Set<string>(), reads: 0, chars: 0, early: new Set<string>() };
      files.set(path, f);
      f.jobs.add(e.jobId);
      f.reads += 1;
      if (job.toolCalls <= EARLY_CALLS) f.early.add(e.jobId);
      const chars = charsByTool.get(String(p["toolId"]));
      if (chars !== undefined) {
        f.chars += chars;
        readChars += chars;
      }
      job.reads += 1;
      job.files.add(path);
      reads += 1;
    } else if (SEARCH_TOOLS.has(name) || graphToolName(name)) {
      const tool = graphToolName(name) ?? name;
      if (tool !== name) {
        job.graphCalls += 1;
        graphCalls += 1;
      }
      const query = normalizePath(String(p["inputSummary"] ?? ""));
      const key = `${tool}\u0000${query}`;
      const s = searches.get(key) ?? { tool, query, jobs: new Set<string>(), calls: 0 };
      searches.set(key, s);
      s.jobs.add(e.jobId);
      s.calls += 1;
    }
  }

  const analyzed = perJob.size;
  const half = Math.max(2, Math.ceil(analyzed / 2));
  const repeatedReads = [...files.values()].filter((f) => f.jobs.size >= half).reduce((n, f) => n + f.reads, 0);

  const sum = (k: "inputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "costMicroUsd") =>
    keptRuns.reduce((n, r) => n + r[k], 0);
  const titles = new Map(keptRuns.map((r) => [r.jobId!, r.title]));
  const inputByJob = new Map<string, number>();
  for (const r of keptRuns) inputByJob.set(r.jobId!, (inputByJob.get(r.jobId!) ?? 0) + r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens);

  return {
    role: opts.role,
    jobsAnalyzed: analyzed,
    runsAnalyzed: keptRuns.length,
    totals: {
      toolCalls,
      reads,
      repeatedShare: reads === 0 ? 0 : Number((repeatedReads / reads).toFixed(3)),
      readChars,
      readTokensApprox: Math.round(readChars / 4),
      inputTokens: sum("inputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      costMicroUsd: sum("costMicroUsd"),
      graphCalls,
    },
    files: [...files.entries()]
      .map(([path, f]) => ({ path, jobs: f.jobs.size, reads: f.reads, chars: f.chars, earlyJobs: f.early.size }))
      .sort((a, b) => b.jobs - a.jobs || b.reads - a.reads)
      .slice(0, opts.top),
    searches: [...searches.values()]
      .filter((s) => s.jobs.size >= 2)
      .map((s) => ({ tool: s.tool, query: s.query, jobs: s.jobs.size, calls: s.calls }))
      .sort((a, b) => b.jobs - a.jobs || b.calls - a.calls)
      .slice(0, opts.top),
    perJob: jobIds.filter((id) => perJob.has(id)).map((id) => {
      const j = perJob.get(id)!;
      return { jobId: id, title: titles.get(id) ?? "", toolCalls: j.toolCalls, reads: j.reads, distinctFiles: j.files.size, inputTokens: inputByJob.get(id) ?? 0, graphCalls: j.graphCalls };
    }),
  };
}
