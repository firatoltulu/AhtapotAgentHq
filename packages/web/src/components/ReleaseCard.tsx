import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ReleaseBump, ReleaseStatus } from "@ahtapot/shared";

import { api, type ReleasePlan, type ReleaseRow } from "../api";
import { Badge, Button, ErrorText, fmtTime, type Tone } from "../ui";

/**
 * Hedef repodaki release workflow'u: zamanlı yayının durumu, elle tetik,
 * duraklatma ve geçmiş.
 *
 * Elle tetik iki adımlı: önce dry-run planı gösterilir (sürüm, workflow,
 * dal, uyarılar), insan onu görüp tetikler. Yayın geri alınamayan bir dış
 * eylem — körlemesine tek tık olmamalı.
 */
const WEEKDAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
const PAUSE_WEEK_MS = 7 * 86_400_000;

const STATUS: Record<ReleaseStatus, { label: string; tone: Tone }> = {
  starting: { label: "başlıyor", tone: "run" },
  dispatched: { label: "tetiklendi", tone: "run" },
  running: { label: "koşuyor", tone: "run" },
  succeeded: { label: "yayınlandı", tone: "ok" },
  failed: { label: "düştü", tone: "err" },
  skipped: { label: "atlandı", tone: "off" },
  unknown: { label: "bilinmiyor", tone: "wait" },
};

export function ReleaseCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ["release", projectId];
  const info = useQuery({
    queryKey: key,
    queryFn: () => api.release(projectId),
    retry: false,
    // Uçuştaki yayın sık yoklanır; sonuç zamanlayıcıdan da gelebildiği için seyrek de yoklanır.
    refetchInterval: (q) => (q.state.data?.inFlight ? 3_000 : 60_000),
  });
  // Uçuştaki yayın bitince liste/başlıktaki sürüm rozeti de tazelensin.
  const flying = Boolean(info.data?.inFlight);
  const wasFlying = useRef(false);
  useEffect(() => {
    if (wasFlying.current && !flying) void qc.invalidateQueries({ queryKey: ["project-versions"] });
    wasFlying.current = flying;
  }, [flying, qc]);
  const [preview, setPreview] = useState<{ bump: ReleaseBump | null; plan: ReleasePlan; warnings: string[] } | null>(null);

  const dryRun = useMutation({
    mutationFn: (bump: ReleaseBump | null) => api.releaseDryRun(projectId, bump ?? undefined),
    onSuccess: (res, bump) => setPreview({ bump, plan: res.plan, warnings: res.warnings }),
  });
  const start = useMutation({
    mutationFn: (bump: ReleaseBump) => api.startRelease(projectId, bump),
    onSuccess: () => {
      setPreview(null);
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const pause = useMutation({
    mutationFn: (until: string | null) => api.pauseRelease(projectId, until),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const data = info.data;
  const cfg = data?.config ?? null;
  const schedule = cfg?.schedule;
  const paused = data?.pausedUntil && data.pausedUntil > new Date().toISOString() ? data.pausedUntil : null;
  const scheduleText = !schedule || schedule.mode === "off"
    ? "yalnız elle"
    : schedule.mode === "weekly"
      ? `her ${WEEKDAYS[schedule.weekday] ?? "?"} ${schedule.time}`
      : `her ayın ${schedule.dayOfMonth}. günü ${schedule.time}`;
  const busy = Boolean(data?.inFlight) || start.isPending;

  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex items-center gap-2 border-b border-edge bg-raised px-[13px] py-2.5">
        <h2 className="text-[12.5px] font-semibold text-ink">Release</h2>
        <div className="flex-1" />
        {cfg && <Badge value={!cfg.enabled ? "kapalı" : paused ? "duraklatıldı" : scheduleText} tone={!cfg.enabled ? "off" : paused ? "wait" : "ok"} />}
      </header>
      <div className="flex flex-col gap-2 px-[13px] py-[11px] text-[12px] text-ink-body">
        {info.isLoading && <span className="text-ink-muted">Yükleniyor…</span>}
        {data && !cfg && <span className="text-ink-muted">Onaylı profil yok.</span>}
        {cfg && !cfg.enabled && (
          <span className="text-ink-muted">
            Profilde kapalı. Profil düzenleyicide <span className="font-mono">release</span> bölümünden workflow dosyasını ve takvimi verip onaylayın.
          </span>
        )}

        {data?.current && (
          <span>
            Güncel sürüm: <span className="font-mono text-[11px] text-ink">{data.current.tag ?? "tag yok"}</span>
            <span className="text-ink-muted"> · {data.current.repo}</span>
          </span>
        )}

        {cfg?.enabled && (
          <>
            <div className="flex flex-col gap-0.5">
              <span>
                Workflow: <span className="font-mono text-[11px]">{cfg.workflow.file}</span> · tag <span className="font-mono text-[11px]">{cfg.tagPattern}</span>
              </span>
              {schedule && schedule.mode !== "off" && (
                <span className="text-ink-muted">
                  {paused ? `${fmtTime(paused)} tarihine dek duraklatıldı. ` : ""}
                  Sonraki zamanlı tur: {data?.nextRunAt ? `${fmtTime(data.nextRunAt)} (${schedule.timezone})` : "—"}
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(["patch", "minor", "major"] as const).map((b) => (
                <Button key={b} size="sm" variant="ghost" disabled={busy || dryRun.isPending} onClick={() => dryRun.mutate(b)}>
                  {b}
                </Button>
              ))}
              {schedule && schedule.mode !== "off" && (
                <>
                  <Button size="sm" variant="neutral" disabled={dryRun.isPending} onClick={() => dryRun.mutate(null)}>
                    Zamanlı tur ne yapar?
                  </Button>
                  {paused ? (
                    <Button size="sm" variant="neutral" disabled={pause.isPending} onClick={() => pause.mutate(null)}>Sürdür</Button>
                  ) : (
                    <Button size="sm" variant="neutral" disabled={pause.isPending} onClick={() => pause.mutate(new Date(Date.now() + PAUSE_WEEK_MS).toISOString())}>
                      1 hafta duraklat
                    </Button>
                  )}
                </>
              )}
            </div>
            {dryRun.isPending && <span className="text-ink-muted">GitHub'a bakılıyor…</span>}

            {preview && (
              <PlanPreview
                preview={preview}
                starting={start.isPending}
                onStart={(b) => start.mutate(b)}
                onClose={() => setPreview(null)}
              />
            )}
          </>
        )}

        {data && data.history.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-edge pt-2">
            {data.history.slice(0, 6).map((r) => <HistoryItem key={r.id} r={r} />)}
          </ul>
        )}

        <ErrorText error={info.error} />
        <ErrorText error={dryRun.error} />
        <ErrorText error={start.error} />
        <ErrorText error={pause.error} />
      </div>
    </section>
  );
}

function PlanPreview({
  preview, starting, onStart, onClose,
}: {
  preview: { bump: ReleaseBump | null; plan: ReleasePlan; warnings: string[] };
  starting: boolean;
  onStart: (bump: ReleaseBump) => void;
  onClose: () => void;
}) {
  const { plan, warnings, bump } = preview;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-edge bg-raised px-2.5 py-2">
      <span className="font-semibold text-ink">
        {plan.fromTag ?? "(tag yok)"} → {plan.toVersion}
        {plan.estimated ? " (tahmini — sürümü workflow belirler)" : ""}
      </span>
      <span className="text-ink-muted">
        {plan.repo} · <span className="font-mono text-[11px]">{plan.workflowFile}</span> @ {plan.ref} · {plan.bump}
        {plan.commits != null ? ` · son tag'den beri ${plan.commits} commit` : ""}
        {plan.ci ? ` · CI: ${plan.ci}` : ""}
      </span>
      {Object.keys(plan.inputs).length > 0 && (
        <span className="font-mono text-[11px] text-ink-muted">
          {Object.entries(plan.inputs).map(([k, v]) => `${k}=${v}`).join("  ")}
        </span>
      )}
      {plan.skipReason && <span className="text-wait-ink">Zamanlı tur atlanır: {plan.skipReason}</span>}
      {warnings.map((w) => <span key={w} className="text-err-ink">{w}</span>)}
      <div className="flex gap-1.5 pt-1">
        {bump && (
          <Button size="sm" variant="primary" disabled={starting} onClick={() => onStart(bump)}>
            {starting ? "Tetikleniyor…" : "Workflow'u tetikle"}
          </Button>
        )}
        <Button size="sm" variant="neutral" onClick={onClose}>Kapat</Button>
      </div>
    </div>
  );
}

function HistoryItem({ r }: { r: ReleaseRow }) {
  const s = STATUS[r.status];
  const version = r.tag ?? (r.toVersion ? `${r.toVersion}${r.status === "succeeded" ? "" : "?"}` : "—");
  const note = r.skipReason ?? r.error;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <Badge value={s.label} tone={s.tone} />
        <span className="font-mono text-[11px]">{version}</span>
        <span className="text-ink-muted">{r.trigger === "schedule" ? "zamanlı" : "elle"} · {fmtTime(r.createdAt)}</span>
        {r.runUrl && (
          <a href={r.runUrl} target="_blank" rel="noreferrer" className="text-brand-ink">koşu ↗</a>
        )}
      </div>
      {note && <span className="aht-wrap text-[11px] text-ink-muted">{note}</span>}
    </li>
  );
}
