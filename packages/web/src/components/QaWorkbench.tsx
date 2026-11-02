import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  scenarioKey,
  type BrowserRunSummary,
  type DastRisk,
  type DastSummary,
  type ScenarioMark,
  type TestScenario,
} from "@ahtapot/shared";

import { api, type Approval, type TestScenariosView } from "../api";
import { ErrorText, Textarea } from "../ui";

/**
 * QA sekmesinin tezgâhı (tasarım "İş detayı · QA sekmesi", 4a–4c): üstte üç
 * kutucuk — Senaryolar (robot), Güvenlik, QA case'leri — altında seçilen
 * kutucuğun filtre + liste + ayrıntı görünümü.
 *
 * Eskiden canlı test kapısında tarayıcı özeti, DAST ve senaryo listesi alt
 * alta diziliyordu; SAST ayrı kapıda kaybolup gidiyordu. Veri yeni uç
 * istemiyor: senaryolar kendi sorgusundan, DAST ve tarayıcı özeti son
 * `live_test` kapısının yükünden, SAST son `security` kapısının yükünden
 * (kapı kapandıktan sonra da `approvals` geçmişinde durur), case'ler plandan.
 */

type View = "sen" | "guv" | "case";

/** Senaryonun görünen durumu: işaret yoksa "sonuçsuz". */
type ScState = "fail" | "unsure" | "none" | "retest" | "pass";
type HumanMark = "pass" | "fail" | "unsure";

const ST: Record<ScState, { label: string; chip: string; dot: string }> = {
  fail: { label: "kaldı", chip: "border-err-edge bg-err-tint text-err-ink", dot: "bg-err" },
  unsure: { label: "kararsız", chip: "border-wait-edge bg-wait-tint text-wait-ink", dot: "bg-wait" },
  none: { label: "sonuçsuz", chip: "border-edge-strong bg-chip text-off-ink", dot: "bg-ink-faint" },
  retest: { label: "yeniden", chip: "border-accent-edge bg-accent-tint text-accent-ink", dot: "bg-run" },
  pass: { label: "geçti", chip: "border-brand-edge bg-brand-tint text-brand-ink", dot: "bg-ok" },
};
const ST_ORDER: ScState[] = ["fail", "unsure", "none", "retest", "pass"];

const PRIORITY: Record<TestScenario["priority"], { label: string; cls: string }> = {
  high: { label: "yüksek", cls: "text-err-ink" },
  medium: { label: "orta", cls: "text-off-ink" },
  low: { label: "düşük", cls: "text-ink-faint" },
};

const RISK: Record<DastRisk, { label: string; cls: string; bar: string }> = {
  high: { label: "yüksek", cls: "bg-err-tint text-err-ink", bar: "bg-err" },
  medium: { label: "orta", cls: "bg-wait-tint text-wait-ink", bar: "bg-wait" },
  low: { label: "düşük", cls: "bg-chip text-ink-body", bar: "bg-line-no" },
  info: { label: "bilgi", cls: "bg-canvas text-ink-muted", bar: "bg-edge-strong" },
};
const RISK_RANK: Record<DastRisk, number> = { info: 0, low: 1, medium: 2, high: 3 };
const RISKS: DastRisk[] = ["high", "medium", "low", "info"];

interface LivePayload {
  round: number;
  dast?: DastSummary;
  browserRun?: BrowserRunSummary;
}
interface SecurityPayload {
  rounds: number;
  failed: string[];
  threads: { path: string; line: number | null; severity: string; author: string; body: string }[];
}

/** DAST ve SAST bulgusu tek tabloda: alanlar ortak biçime indirgenir. */
interface Finding {
  id: string;
  kind: "DAST" | "SAST";
  tool: string;
  rule: string;
  risk: DastRisk;
  title: string;
  loc: string;
  count: number | null;
  detail: string;
  blocking: boolean;
}

export interface QaCaseView {
  id: string;
  title: string;
  rationale: string;
  origin: "agent" | "human";
  included: boolean;
}

export function QaWorkbench({
  jobId,
  gate,
  cases,
  onRejectNotes,
}: {
  jobId: string;
  /** Bekleyen kapı; işaret yalnız `live_test` kapısında konur (sunucu da öyle ister). */
  gate: Approval | null;
  cases: QaCaseView[];
  /** "Red yorumuna ekle": satırlar dikkat yuvasındaki red gerekçesine girer. */
  onRejectNotes?: (lines: string[]) => void;
}) {
  const qc = useQueryClient();
  const live = gate?.kind === "live_test";
  // Senaryo kartı ve dikkat yuvasıyla aynı anahtar: önbellek ortak.
  const scenarios = useQuery({
    queryKey: ["testScenarios", jobId],
    queryFn: () => api.testScenarios(jobId),
    refetchInterval: (query) => (query.state.data?.latest?.status === "running" ? 3000 : false),
  });
  // Kapanmış kapıların yükü: DAST/SAST sonucu kapı kapandıktan sonra da görünsün.
  const approvals = useQuery({ queryKey: ["approvals", jobId, gate?.id ?? ""], queryFn: () => api.approvals(jobId) });

  const lastOf = (kind: string): Approval | undefined =>
    gate?.kind === kind ? gate : approvals.data?.find((a) => a.kind === kind);
  const liveGate = lastOf("live_test");
  const secGate = lastOf("security");
  const livePayload = liveGate?.payload as LivePayload | undefined;
  const dast = livePayload?.dast;
  const browser = livePayload?.browserRun;
  const sec = secGate?.payload as SecurityPayload | undefined;
  const secOpen = gate?.kind === "security";

  const row = scenarios.data?.latest?.status === "ready" ? scenarios.data.latest : null;
  const doc = row?.document ?? null;
  const marks = row?.marks ?? {};
  const items = useMemo(
    () =>
      (doc?.scenarios ?? []).map((s, i) => {
        const key = scenarioKey(i);
        const mark = marks[key];
        return { s, key, mark, state: (mark?.state ?? "none") as ScState };
      }),
    [doc, marks],
  );
  const count = (st: ScState): number => items.filter((x) => x.state === st).length;

  const findings = useMemo<Finding[]>(() => {
    const out: Finding[] = [];
    (dast?.findings ?? []).forEach((f, i) =>
      out.push({
        id: `d${i}`,
        kind: "DAST",
        tool: f.tool,
        rule: f.rule,
        risk: f.risk,
        title: f.title,
        loc: f.url ?? "",
        count: f.count ?? null,
        detail: f.detail,
        blocking: RISK_RANK[f.risk] >= RISK_RANK[dast!.minRisk],
      }),
    );
    // SAST iş parçacığı gövdesi `[kural] mesaj` (review/static.ts). Kapıda
    // kalan her bulgu adımın `minLevel` eşiğini zaten geçmiştir.
    (sec?.threads ?? []).forEach((t, i) => {
      const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(t.body);
      const message = m?.[2] ?? t.body;
      out.push({
        id: `s${i}`,
        kind: "SAST",
        tool: t.author,
        rule: m?.[1] ?? "",
        risk: t.severity === "major" || t.severity === "critical" ? "high" : "medium",
        title: message.split("\n")[0] ?? message,
        loc: t.line != null ? `${t.path}:${t.line}` : t.path,
        count: null,
        detail: message,
        blocking: true,
      });
    });
    return out.sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);
  }, [dast, sec]);
  const failures = [
    ...(dast?.failures ?? []).map((f) => ({ kind: "DAST", step: f.step, reason: f.reason })),
    ...(sec?.failed ?? []).map((s) => ({ kind: "SAST", step: s, reason: "koşamadı" })),
  ];

  const included = cases.filter((c) => c.included).length;
  const [view, setView] = useState<View>("sen");

  const mark = useMutation({
    mutationFn: ({ key, state, note }: { key: string; state: HumanMark | null; note: string }) =>
      api.setScenarioMark(jobId, row!.id, key, state, note),
    onSuccess: ({ marks: next }) =>
      qc.setQueryData<TestScenariosView>(["testScenarios", jobId], (prev) =>
        prev?.latest?.id === row?.id && prev?.latest ? { ...prev, latest: { ...prev.latest, marks: next } } : prev,
      ),
  });

  const dastBlocking = findings.filter((f) => f.kind === "DAST" && f.blocking).length;
  const sastBlocking = findings.filter((f) => f.kind === "SAST").length;

  const tiles: TileProps[] = [
    {
      k: "sen",
      title: "Senaryolar",
      where: browser
        ? browser.skipped
          ? `robot atlandı · ${browser.skipped}`
          : `robot · tur ${browser.round} · ${Math.round(browser.durationMs / 60_000)} dk`
        : row
          ? `tur ${row.round}`
          : "",
      badge: !row ? ["henüz yok", "off"] : count("fail") > 0 ? [`${count("fail")} kaldı`, "err"] : [`${count("pass")} geçti`, "ok"],
      bar: ST_ORDER.map((st) => ({ n: count(st), cls: ST[st].dot })),
      line: row
        ? `${items.length} senaryo · ${count("pass")} geçti · ${count("unsure")} kararsız · ${count("none")} sonuçsuz · ${count("retest")} yeniden`
        : "Canlı testte ya da planda çıkarılır",
    },
    {
      k: "guv",
      title: "Güvenlik",
      where: "DAST canlı · SAST PR öncesi",
      badge:
        !dast && !sec
          ? ["henüz yok", "off"]
          : dastBlocking + sastBlocking > 0
            ? [`${dastBlocking + sastBlocking} eşik üstü`, "err"]
            : failures.length > 0
              ? [`${failures.length} koşamadı`, "wait"]
              : ["temiz", "ok"],
      bar: RISKS.map((r) => ({ n: findings.filter((f) => f.risk === r).length, cls: RISK[r].bar })),
      line: [
        dast ? (dast.ran ? `DAST ${findings.filter((f) => f.kind === "DAST").length} bulgu` : "DAST sonuç yok") : "DAST koşmadı",
        sec ? `SAST ${sastBlocking} bulgu` : "SAST henüz koşmadı",
        ...(failures.length > 0 ? [`${failures.length} araç koşamadı`] : []),
      ].join(" · "),
    },
    {
      k: "case",
      title: "QA case'leri",
      where: "otomatik test",
      badge: cases.length === 0 ? ["henüz yok", "off"] : [`${included}/${cases.length} dahil`, "ok"],
      bar: [
        { n: included, cls: "bg-ok" },
        { n: cases.length - included, cls: "bg-edge-strong" },
      ],
      line:
        cases.length === 0
          ? "Canlı testten sonra yazılır"
          : `canlı testten sonra yazılır · ${cases.filter((c) => c.origin === "human").length} insan ekledi`,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {tiles.map((t) => (
          <Tile key={t.k} {...t} active={view === t.k} onClick={() => setView(t.k)} />
        ))}
      </div>
      <ErrorText error={scenarios.error ?? approvals.error} />
      <div className="flex h-[72vh] min-h-[520px] flex-col overflow-hidden rounded-xl border border-edge bg-surface">
        {view === "sen" && (
          <ScenarioView
            jobId={jobId}
            items={items}
            round={row?.round ?? 0}
            missing={browser?.missingSelectors ?? []}
            canMark={live && !!row && !mark.isPending}
            markError={mark.error}
            onMark={(key, state, note) => mark.mutate({ key, state, note })}
            {...(live && onRejectNotes ? { onRejectNotes } : {})}
            loading={scenarios.isLoading}
          />
        )}
        {view === "guv" && (
          <SecurityView
            findings={findings}
            failures={failures}
            dast={dast}
            liveRound={livePayload?.round ?? null}
            secRounds={sec?.rounds ?? null}
            secOpen={secOpen}
            loading={approvals.isLoading}
          />
        )}
        {view === "case" && <CaseView cases={cases} />}
      </div>
    </div>
  );
}

// ── Kutucuk ──────────────────────────────────────────────────────────────────

type BadgeTone = "ok" | "err" | "wait" | "off";
const BADGE: Record<BadgeTone, string> = {
  ok: "border-brand-edge bg-brand-tint text-brand-ink",
  err: "border-err-edge bg-err-tint text-err-ink",
  wait: "border-wait-edge bg-wait-tint text-wait-ink",
  off: "border-edge-strong bg-chip text-off-ink",
};

interface TileProps {
  k: View;
  title: string;
  where: string;
  badge: [string, BadgeTone];
  bar: { n: number; cls: string }[];
  line: string;
}

function Tile({ title, where, badge, bar, line, active, onClick }: TileProps & { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col gap-2 rounded-xl border bg-surface px-3.5 py-3 text-left ${
        active ? "border-brand ring-2 ring-brand-edge" : "border-edge hover:border-edge-control"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">{title}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-muted">{where}</span>
        <span className="flex-1" />
        <span className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${BADGE[badge[1]]}`}>{badge[0]}</span>
      </span>
      <span className="flex h-1.5 gap-0.5 overflow-hidden rounded-sm bg-chip">
        {bar.filter((b) => b.n > 0).map((b, i) => (
          <span key={i} className={b.cls} style={{ flex: b.n }} />
        ))}
      </span>
      <span className="text-[12.5px] text-off-ink">{line}</span>
    </button>
  );
}

// ── Ortak parçalar ───────────────────────────────────────────────────────────

function Chip({ label, n, active, dot, onClick }: { label: string; n: number; active: boolean; dot?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-[30px] items-center gap-1.5 rounded-full border px-[11px] text-[12.5px] ${
        active ? "border-brand bg-brand-tint font-semibold text-brand-ink" : "border-edge-strong bg-surface font-medium text-ink-body hover:bg-raised"
      }`}
    >
      {dot && <span className={`size-[7px] rounded-full ${dot}`} />}
      {label}
      <span className="font-mono text-[11px]">{n}</span>
    </button>
  );
}

function Segmented<T extends string>({ options, value, onChange }: { options: [T, string, number?][]; value: T; onChange: (v: T) => void }) {
  return (
    <span className="flex rounded-lg border border-edge-strong p-0.5">
      {options.map(([k, label, n]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          aria-pressed={value === k}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] ${
            value === k ? "bg-brand-tint font-semibold text-brand-ink" : "font-medium text-ink-soft hover:bg-raised"
          }`}
        >
          {label}
          {n !== undefined && <span className="font-mono text-[10.5px]">{n}</span>}
        </button>
      ))}
    </span>
  );
}

function Pick({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="flex h-[30px] items-center gap-1.5 rounded-lg border border-edge-strong px-2.5 text-[12.5px] text-ink-body">
      <span className="text-ink-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="max-w-[140px] bg-transparent text-ink-body outline-none">
        <option value="">Tümü</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-[10.5px] tracking-[.08em] text-ink-muted uppercase">{children}</span>
);

const HEAD = "font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase";

// ── 4a Senaryolar ────────────────────────────────────────────────────────────

interface ScItem {
  s: TestScenario;
  key: string;
  mark: ScenarioMark | undefined;
  state: ScState;
}

type ScFilter = "issue" | ScState | "all";

function ScenarioView({
  jobId,
  items,
  round,
  missing,
  canMark,
  markError,
  onMark,
  onRejectNotes,
  loading,
}: {
  jobId: string;
  items: ScItem[];
  round: number;
  missing: string[];
  canMark: boolean;
  markError: unknown;
  onMark: (key: string, state: HumanMark | null, note: string) => void;
  onRejectNotes?: (lines: string[]) => void;
  loading: boolean;
}) {
  // Varsayılan "Sorunlu": canlı testte insanın bakması gereken satırlar.
  const [sf, setSf] = useState<ScFilter>("issue");
  const [src, setSrc] = useState<"all" | "agent" | "human">("all");
  const [q, setQ] = useState("");
  const [area, setArea] = useState("");
  const [prio, setPrio] = useState("");
  const [req, setReq] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [lb, setLb] = useState(-1);

  const count = (st: ScState): number => items.filter((x) => x.state === st).length;
  const areas = [...new Set(items.map((x) => x.s.area || "Genel"))];
  const reqs = [...new Set(items.flatMap((x) => x.s.covers))].sort();
  const needle = q.trim().toLocaleLowerCase("tr");
  const rows = items.filter(
    (x) =>
      (sf === "all" || (sf === "issue" ? x.state !== "pass" : x.state === sf)) &&
      (src === "all" || (x.mark && x.mark.state !== "retest" && x.mark.source === src)) &&
      (!area || (x.s.area || "Genel") === area) &&
      (!prio || PRIORITY[x.s.priority].label === prio) &&
      (!req || x.s.covers.includes(req)) &&
      (!needle ||
        [x.s.title, ...x.s.steps, x.mark?.note ?? ""].some((t) => t.toLocaleLowerCase("tr").includes(needle))),
  );
  const cur = items.find((x) => x.key === sel) ?? rows[0] ?? null;

  if (loading) return <p className="p-10 text-center text-[13px] text-ink-muted">Senaryolar yükleniyor…</p>;
  if (items.length === 0)
    return (
      <p className="p-10 text-center text-[13px] text-ink-muted">
        Henüz senaryo yok. Canlı test kapısında aşağıdaki karttan çıkarılabilir.
      </p>
    );

  const cols = "md:grid-cols-[96px_minmax(0,1fr)_128px_64px_72px_74px_44px]";
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_440px]">
      <div className="flex min-h-0 min-w-0 flex-col border-edge md:border-r">
        <div className="flex flex-col gap-2.5 border-b border-edge px-4.5 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip label="Sorunlu" n={items.length - count("pass")} dot="bg-err" active={sf === "issue"} onClick={() => setSf("issue")} />
            <Chip label="Kaldı" n={count("fail")} dot={ST.fail.dot} active={sf === "fail"} onClick={() => setSf("fail")} />
            <Chip label="Kararsız" n={count("unsure")} dot={ST.unsure.dot} active={sf === "unsure"} onClick={() => setSf("unsure")} />
            <Chip label="Sonuçsuz" n={count("none")} dot={ST.none.dot} active={sf === "none"} onClick={() => setSf("none")} />
            <Chip label="Yeniden dene" n={count("retest")} dot={ST.retest.dot} active={sf === "retest"} onClick={() => setSf("retest")} />
            <Chip label="Geçti" n={count("pass")} dot={ST.pass.dot} active={sf === "pass"} onClick={() => setSf("pass")} />
            <Chip label="Tümü" n={items.length} active={sf === "all"} onClick={() => setSf("all")} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ara: başlık, adım, not…"
              className="h-[30px] w-full max-w-[280px] min-w-[160px] flex-1 rounded-lg border border-edge-strong px-2.5 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
            />
            <Segmented
              options={[
                ["all", "Tümü"],
                ["agent", "Robot"],
                ["human", "Sen"],
              ]}
              value={src}
              onChange={setSrc}
            />
            <Pick label="Alan" value={area} options={areas} onChange={setArea} />
            <Pick label="Öncelik" value={prio} options={["yüksek", "orta", "düşük"]} onChange={setPrio} />
            {reqs.length > 0 && <Pick label="Gereksinim" value={req} options={reqs} onChange={setReq} />}
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-ink-muted">
              {rows.length} / {items.length}
            </span>
          </div>
        </div>
        <div className={`hidden gap-2.5 border-b border-edge bg-raised px-4.5 py-2 md:grid ${cols} ${HEAD}`}>
          <span>durum</span>
          <span>senaryo</span>
          <span>alan</span>
          <span>öncelik</span>
          <span>karşılar</span>
          <span>işaret</span>
          <span>kanıt</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((x) => {
            const on = cur?.key === x.key;
            const st = ST[x.state];
            return (
              <button
                key={x.key}
                onClick={() => {
                  setSel(x.key);
                  setLb(-1);
                }}
                className={`grid w-full grid-cols-[96px_minmax(0,1fr)] items-center gap-2.5 border-b border-chip px-4.5 py-2.5 text-left ${cols} ${
                  on ? "bg-brand-tint/50 shadow-[inset_3px_0_0_var(--color-brand)]" : "bg-surface hover:bg-raised"
                }`}
              >
                <span className={`justify-self-start rounded-md border px-2 py-0.5 text-[11.5px] font-semibold ${st.chip}`}>{st.label}</span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-[13px] font-medium text-ink">{x.s.title}</span>
                  {x.mark?.note && <span className="truncate text-[11.5px] text-ink-muted">{x.mark.note}</span>}
                </span>
                <span className="hidden truncate text-[12px] text-off-ink md:block">{x.s.area || "Genel"}</span>
                <span className={`hidden text-[12px] md:block ${PRIORITY[x.s.priority].cls}`}>{PRIORITY[x.s.priority].label}</span>
                <span className="hidden truncate font-mono text-[11px] text-off-ink md:block">{x.s.covers.join(", ") || "—"}</span>
                <span className={`hidden font-mono text-[11px] md:block ${x.mark?.source === "human" && x.state !== "retest" ? "text-brand-ink" : "text-ink-muted"}`}>
                  {!x.mark ? "—" : x.state === "retest" ? "motor" : x.mark.source === "agent" ? "robot" : "sen"}
                </span>
                <span className="hidden font-mono text-[11px] text-ink-muted md:block">{x.mark?.evidence.length || "—"}</span>
              </button>
            );
          })}
          {rows.length === 0 && <p className="p-10 text-center text-[13px] text-ink-muted">Bu filtrede senaryo yok.</p>}
        </div>
        {missing.length > 0 && (
          <div className="flex items-center gap-2.5 border-t border-edge bg-pane px-4.5 py-2.5 text-[12px] text-off-ink">
            <span className="shrink-0 font-semibold text-ink">Kimliksiz elemanlar ({missing.length})</span>
            <span className="min-w-0 truncate font-mono text-[11.5px]" title={missing.join("\n")}>
              {missing.join(" · ")}
            </span>
            <span className="flex-1" />
            {onRejectNotes && (
              <button
                onClick={() => onRejectNotes([`Kimliksiz elemanlar (test kimliği eklenmeli): ${missing.join(" · ")}`])}
                className="shrink-0 font-semibold text-brand-ink hover:underline"
              >
                Red yorumuna ekle
              </button>
            )}
          </div>
        )}
      </div>

      {cur && (
        <ScenarioDetail
          key={cur.key}
          jobId={jobId}
          item={cur}
          round={round}
          canMark={canMark}
          markError={markError}
          onMark={(state, note) => onMark(cur.key, state, note)}
          onOpen={setLb}
        />
      )}
      {cur && lb >= 0 && lb < (cur.mark?.evidence.length ?? 0) && (
        <Lightbox jobId={jobId} refs={cur.mark!.evidence} index={lb} caption={cur.s.title} onIndex={setLb} />
      )}
    </div>
  );
}

function ScenarioDetail({
  jobId,
  item,
  round,
  canMark,
  markError,
  onMark,
  onOpen,
}: {
  jobId: string;
  item: ScItem;
  round: number;
  canMark: boolean;
  markError: unknown;
  onMark: (state: HumanMark | null, note: string) => void;
  onOpen: (index: number) => void;
}) {
  const { s, mark, state, key } = item;
  const st = ST[state];
  const [note, setNote] = useState(mark?.note ?? "");
  useEffect(() => setNote(mark?.note ?? ""), [mark?.note]);
  const human = mark?.source === "human";
  const markBy = !mark
    ? ""
    : state === "retest"
      ? "Motor: düzeltmeden etkilenmiş olabilir"
      : `${human ? "Sen" : "Robot"}: ${st.label}`;
  const stale = mark && state !== "retest" && mark.round < round;

  // Aynı düğmeye ikinci basış işareti kaldırır; robotun işaretinde ise
  // benimser (kaynak insan olur). Not durum değişirken korunur.
  const press = (m: HumanMark): void => {
    if (mark?.state === m && human) onMark(null, "");
    else onMark(m, note.trim());
  };
  const MARK_BTN: Record<HumanMark, [string, string, string]> = {
    pass: ["Geçti", "border-brand-edge text-brand-ink", "bg-brand-tint"],
    fail: ["Kaldı", "border-err-edge text-err-ink", "bg-err-tint"],
    unsure: ["Kararsız", "border-wait-edge text-wait-ink", "bg-wait-tint"],
  };
  const wantsNote = canMark && (state === "fail" || state === "unsure");

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-auto border-t border-edge px-5 py-4 md:border-t-0">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-md border px-2 py-0.5 text-[11.5px] font-semibold ${st.chip}`}>{st.label}</span>
          <span className="font-mono text-[11px] text-ink-muted">
            {key} · {s.area || "Genel"} · {PRIORITY[s.priority].label}
            {s.account && ` · hesap: ${s.account}`}
          </span>
        </div>
        <span className="text-[17px] leading-[1.35] font-semibold text-pretty text-ink">{s.title}</span>
        {s.covers.length > 0 && <span className="font-mono text-[11px] text-ink-muted">karşılar {s.covers.join(", ")}</span>}
      </div>

      {mark && (mark.note || state !== "pass") && (
        <div className={`flex flex-col gap-1.5 rounded-[11px] border px-3 py-2.5 ${st.chip}`}>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold">{markBy}</span>
            <span className="flex-1" />
            <span className="font-mono text-[10.5px] text-ink-muted">
              tur {mark.round}
              {stale && " · önceki tur"}
            </span>
          </div>
          {mark.note && <span className="text-[13px] leading-[1.55] text-ink-body">{mark.note}</span>}
        </div>
      )}

      {mark && mark.evidence.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {mark.evidence.map((ref, i) => (
            <button key={ref} onClick={() => onOpen(i)} className="flex cursor-zoom-in flex-col gap-1 text-left">
              <img
                src={api.liveEvidenceUrl(jobId, ref)}
                alt={`kanıt ${ref}`}
                loading="lazy"
                className="h-[110px] w-full rounded-[9px] border border-edge-strong bg-chip object-cover hover:border-brand"
              />
              <span className="truncate font-mono text-[10.5px] text-ink-muted">{ref}</span>
            </button>
          ))}
        </div>
      )}

      {s.preconditions.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionLabel>Ön koşul</SectionLabel>
          {s.preconditions.map((p, i) => (
            <span key={i} className="text-[13px] leading-normal text-ink-body">
              · {p}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Adımlar</SectionLabel>
        {s.steps.map((t, i) => (
          <div key={i} className="grid grid-cols-[20px_minmax(0,1fr)] gap-1.5 text-[13px] leading-normal text-ink-body">
            <span className="pt-0.5 font-mono text-[11px] text-ink-faint">{i + 1}</span>
            <span>{t}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <SectionLabel>Beklenen</SectionLabel>
        <span className="text-[13px] leading-[1.55] whitespace-pre-line text-ink">{s.expected}</span>
      </div>

      {canMark && (
        <div className="mt-auto flex flex-col gap-2 border-t border-edge pt-3">
          <span className="text-[12px] text-ink-muted">Senin işaretin robotunkinin üstündedir.</span>
          {wantsNote && (
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => {
                if (mark && mark.state !== "retest" && note.trim() !== mark.note) onMark(mark.state, note.trim());
              }}
              placeholder={state === "fail" ? "Ne oldu? (Developer'a gider)" : "Neden kararsız?"}
            />
          )}
          <div className="flex gap-1.5">
            {(Object.keys(MARK_BTN) as HumanMark[]).map((m) => {
              const [label, cls, on] = MARK_BTN[m];
              const active = human && mark?.state === m;
              return (
                <button
                  key={m}
                  onClick={() => press(m)}
                  aria-pressed={active}
                  className={`h-[34px] flex-1 rounded-[9px] border text-[12.5px] font-semibold ${cls} ${active ? on : "bg-surface hover:bg-raised"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {mark?.source === "agent" && (state === "pass" || state === "fail" || state === "unsure") && (
            <button
              onClick={() => onMark(state, mark.note)}
              className="h-[34px] rounded-[9px] bg-brand text-[12.5px] font-semibold text-white hover:bg-brand-ink"
            >
              Robotun işaretini benimse
            </button>
          )}
          <ErrorText error={markError} />
        </div>
      )}
    </div>
  );
}

/** Kanıt görüntüsü tam boy. Esc kapatır, ← → gezinir. */
function Lightbox({
  jobId,
  refs,
  index,
  caption,
  onIndex,
}: {
  jobId: string;
  refs: string[];
  index: number;
  caption: string;
  onIndex: (i: number) => void;
}) {
  const n = refs.length;
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onIndex(-1);
      else if (e.key === "ArrowRight") onIndex((index + 1) % n);
      else if (e.key === "ArrowLeft") onIndex((index - 1 + n) % n);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, n, onIndex]);
  const ref = refs[index] ?? "";
  const stop = (e: MouseEvent): void => e.stopPropagation();
  const nav = "absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-ink/70 text-[20px] text-white";
  return (
    <div onClick={() => onIndex(-1)} className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3.5 bg-ink/85 p-4 md:p-10">
      <div onClick={stop} className="flex w-full max-w-[1040px] items-center gap-3 text-white">
        <span className="font-mono text-[13px]">{ref}</span>
        <span className="min-w-0 truncate text-[13px] text-white/75">{caption}</span>
        <span className="flex-1" />
        <span className="font-mono text-[12px] text-white/75">
          {index + 1} / {n}
        </span>
        <button onClick={() => onIndex(-1)} aria-label="Kapat" className="flex size-9 items-center justify-center rounded-[10px] border border-white/30">
          ✕
        </button>
      </div>
      <div onClick={stop} className="relative flex w-full max-w-[1040px] items-center justify-center">
        <img src={api.liveEvidenceUrl(jobId, ref)} alt={`kanıt ${ref}`} className="max-h-[78vh] max-w-full rounded-xl bg-chip object-contain" />
        {n > 1 && (
          <>
            <button onClick={() => onIndex((index - 1 + n) % n)} aria-label="Önceki" className={`${nav} left-3`}>
              ‹
            </button>
            <button onClick={() => onIndex((index + 1) % n)} aria-label="Sonraki" className={`${nav} right-3`}>
              ›
            </button>
          </>
        )}
      </div>
      <span className="text-[12px] text-white/75">Esc kapatır · ← → gezinir</span>
    </div>
  );
}

// ── 4b Güvenlik ──────────────────────────────────────────────────────────────

const KIND_CLS = { DAST: "border-accent-edge text-accent-ink", SAST: "border-brand-edge text-brand-ink" } as const;

function SecurityView({
  findings,
  failures,
  dast,
  liveRound,
  secRounds,
  secOpen,
  loading,
}: {
  findings: Finding[];
  failures: { kind: string; step: string; reason: string }[];
  dast: DastSummary | undefined;
  liveRound: number | null;
  secRounds: number | null;
  secOpen: boolean;
  loading: boolean;
}) {
  const [kind, setKind] = useState<"all" | "DAST" | "SAST">("all");
  const [risk, setRisk] = useState<"all" | DastRisk>("all");
  const [blockOnly, setBlockOnly] = useState(false);
  const [sel, setSel] = useState<string | null>(null);

  const rows = findings.filter(
    (f) => (kind === "all" || f.kind === kind) && (risk === "all" || f.risk === risk) && (!blockOnly || f.blocking),
  );
  const cur = findings.find((f) => f.id === sel) ?? rows[0] ?? null;
  const ofKind = (k: Finding["kind"]): number => findings.filter((f) => f.kind === k).length;

  if (loading) return <p className="p-10 text-center text-[13px] text-ink-muted">Güvenlik sonuçları yükleniyor…</p>;
  if (findings.length === 0 && failures.length === 0)
    return (
      <p className="p-10 text-center text-[13px] text-ink-muted">
        {dast || secRounds !== null
          ? "Bulgu yok."
          : "Henüz güvenlik taraması yok: DAST canlı testte, SAST PR öncesinde koşar."}
      </p>
    );

  const cols = "md:grid-cols-[72px_58px_96px_minmax(0,1fr)_220px_40px]";
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_440px]">
      <div className="flex min-h-0 min-w-0 flex-col border-edge md:border-r">
        <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4.5 py-3">
          <Segmented
            options={[
              ["all", "Tümü", findings.length],
              ["DAST", "DAST", ofKind("DAST")],
              ["SAST", "SAST", ofKind("SAST")],
            ]}
            value={kind}
            onChange={setKind}
          />
          <span className="h-[22px] w-px bg-edge" />
          <Chip label="Tüm riskler" n={findings.length} active={risk === "all"} onClick={() => setRisk("all")} />
          {RISKS.map((r) => (
            <Chip
              key={r}
              label={RISK[r].label[0]!.toLocaleUpperCase("tr") + RISK[r].label.slice(1)}
              n={findings.filter((f) => f.risk === r).length}
              active={risk === r}
              onClick={() => setRisk(r)}
            />
          ))}
          <button
            onClick={() => setBlockOnly((v) => !v)}
            aria-pressed={blockOnly}
            className={`flex h-[30px] items-center gap-[7px] rounded-lg border px-[11px] text-[12.5px] ${
              blockOnly ? "border-err-edge bg-err-tint font-semibold text-err-ink" : "border-edge-strong bg-surface font-medium text-ink-body"
            }`}
          >
            <span
              className={`flex size-3.5 items-center justify-center rounded border-[1.5px] text-[10px] text-white ${
                blockOnly ? "border-err-ink bg-err-ink" : "border-line-no bg-surface"
              }`}
            >
              {blockOnly ? "✓" : ""}
            </span>
            Yalnız eşik üstü
          </button>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-ink-muted">
            {rows.length} / {findings.length}
          </span>
        </div>
        <div className={`hidden gap-2.5 border-b border-edge bg-raised px-4.5 py-2 md:grid ${cols} ${HEAD}`}>
          <span>risk</span>
          <span>tür</span>
          <span>araç</span>
          <span>bulgu</span>
          <span>konum</span>
          <span>adet</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((f) => {
            const on = cur?.id === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setSel(f.id)}
                className={`grid w-full grid-cols-[72px_58px_minmax(0,1fr)] items-center gap-2.5 border-b border-chip px-4.5 py-2.5 text-left ${cols} ${
                  on ? "bg-brand-tint/50 shadow-[inset_3px_0_0_var(--color-brand)]" : "bg-surface hover:bg-raised"
                }`}
              >
                <span className={`justify-self-start rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${RISK[f.risk].cls}`}>{RISK[f.risk].label}</span>
                <span className={`justify-self-start rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold ${KIND_CLS[f.kind]}`}>{f.kind}</span>
                <span className="hidden truncate font-mono text-[11.5px] text-off-ink md:block">{f.tool}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink">{f.title}</span>
                  {f.blocking && (
                    <span className="shrink-0 rounded-[5px] border border-err-edge px-1.5 py-px text-[10.5px] font-semibold text-err-ink">eşik üstü</span>
                  )}
                </span>
                {/* Uzun yolun SONU anlamlı: soldan kırpılır. */}
                <span className="hidden truncate text-left font-mono text-[11px] text-ink-muted [direction:rtl] md:block">
                  <bdi>{f.loc || "—"}</bdi>
                </span>
                <span className="hidden font-mono text-[11px] text-ink-muted md:block">{f.count ?? "—"}</span>
              </button>
            );
          })}
          {rows.length === 0 && <p className="p-10 text-center text-[13px] text-ink-muted">Bu filtrede bulgu yok.</p>}
        </div>
        {failures.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-edge bg-pane px-4.5 py-2.5">
            {failures.map((x) => (
              <div key={`${x.kind}:${x.step}`} className="flex items-center gap-2 text-[12px] text-wait-ink">
                <span className="size-[7px] shrink-0 rounded-full bg-wait" />
                <span className="font-mono text-[11px] font-semibold">
                  {x.kind} · {x.step}
                </span>
                <span className="min-w-0 truncate">{x.reason} — sonucu yok, temiz değil</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {cur && (
        <div className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-auto border-t border-edge px-5 py-4 md:border-t-0">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${RISK[cur.risk].cls}`}>{RISK[cur.risk].label}</span>
              <span className={`rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold ${KIND_CLS[cur.kind]}`}>{cur.kind}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-ink-muted">
                {cur.tool}
                {cur.rule && ` · ${cur.rule}`}
              </span>
            </div>
            <span className="text-[17px] leading-[1.35] font-semibold text-pretty text-ink">{cur.title}</span>
          </div>
          {cur.loc && (
            <div className="flex flex-col gap-1 rounded-[10px] border border-edge bg-raised px-3 py-2.5">
              <SectionLabel>{cur.kind === "DAST" ? "Örnek adres" : "Dosya:satır"}</SectionLabel>
              <span className="font-mono text-[12px] [overflow-wrap:anywhere] text-ink">{cur.loc}</span>
              {cur.count && <span className="text-[12px] text-ink-muted">{cur.count} örnek</span>}
            </div>
          )}
          {cur.detail && (
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Ayrıntı</SectionLabel>
              <span className="text-[13px] leading-[1.6] whitespace-pre-wrap text-ink-body">{cur.detail}</span>
            </div>
          )}
          <Fate f={cur} dast={dast} secOpen={secOpen} />
          <div className="mt-auto flex flex-col gap-1 border-t border-edge pt-3">
            <SectionLabel>{cur.kind === "DAST" ? "DAST koşusu" : "SAST turu"}</SectionLabel>
            <span className="text-[12.5px] leading-normal text-off-ink">
              {cur.kind === "DAST"
                ? [
                    liveRound !== null ? `Canlı test tur ${liveRound}` : "",
                    dast?.scope
                      ? dast.scope.mode === "branch"
                        ? `kapsam: dalın ${dast.scope.paths.length} ucu (${dast.scope.paths.slice(0, 6).join(", ")}${dast.scope.paths.length > 6 ? ", …" : ""})`
                        : `kapsam: tüm uygulama${dast.scope.reason ? ` (${dast.scope.reason})` : ""}`
                      : "",
                    dast ? `artifacts/${dast.reportDir}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : `PR öncesi güvenlik · ${secRounds ?? 0} tur${failures.some((x) => x.kind === "SAST") ? ` · ${failures.filter((x) => x.kind === "SAST").map((x) => x.step).join(", ")} koşamadı` : ""}`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Bulgunun kaderi: kapıda ne olacağını söyler — insan kararını buna göre verir. */
function Fate({ f, dast, secOpen }: { f: Finding; dast: DastSummary | undefined; secOpen: boolean }) {
  const title = f.blocking
    ? f.kind === "DAST" && dast
      ? `Eşik üstü (${RISK[dast.minRisk].label}+)`
      : "Eşik üstü"
    : "Eşiğin altında";
  const text =
    f.kind === "DAST"
      ? f.blocking
        ? "Canlı testi reddedersen bu bulgu geri bildirime kendiliğinden eklenir."
        : "Kapıyı etkilemez; raporda kalır."
      : secOpen
        ? "Güvenlik kapısında kaldı. Onay bir güvenlik turu daha koşturur; red kalanlarla PR'a geçer."
        : "Güvenlik kapısında kalan bulgulardandı; kapı kapandı.";
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-[10px] border px-3 py-2.5 ${
        f.blocking ? "border-err-edge bg-err-tint" : "border-edge bg-raised"
      }`}
    >
      <span className={`text-[12.5px] font-semibold ${f.blocking ? "text-err-ink" : "text-off-ink"}`}>{title}</span>
      <span className="text-[12.5px] leading-normal text-ink-body">{text}</span>
    </div>
  );
}

// ── 4c QA case'leri ──────────────────────────────────────────────────────────

function CaseView({ cases }: { cases: QaCaseView[] }) {
  const [cf, setCf] = useState<"all" | "in" | "out" | "human">("all");
  const included = cases.filter((c) => c.included).length;
  const human = cases.filter((c) => c.origin === "human").length;
  // Kimlik UUID; okunur kısa ad listedeki sıradan (`c1`, `c2`…).
  const rows = cases
    .map((c, i) => ({ ...c, short: `c${i + 1}` }))
    .filter((c) => cf === "all" || (cf === "in" && c.included) || (cf === "out" && !c.included) || (cf === "human" && c.origin === "human"));
  if (cases.length === 0)
    return (
      <p className="p-10 text-center text-[13px] text-ink-muted">
        Henüz QA case'i yok. Son safha onaylanıp canlı test geçince QA listeyi çıkarır.
      </p>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-5.5 py-3">
        <Chip label="Tümü" n={cases.length} active={cf === "all"} onClick={() => setCf("all")} />
        <Chip label="Dahil" n={included} active={cf === "in"} onClick={() => setCf("in")} />
        <Chip label="Çıkarılmış" n={cases.length - included} active={cf === "out"} onClick={() => setCf("out")} />
        <Chip label="İnsan ekledi" n={human} active={cf === "human"} onClick={() => setCf("human")} />
        <span className="flex-1" />
        <span className="text-[12.5px] text-ink-muted">Testler yalnız dahil olanlar için yazılır · QA vakaları kapısında düzenlenir</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {rows.map((c) => (
          <div key={c.short} className={`flex items-start gap-3 border-b border-chip px-5.5 py-[11px] ${c.included ? "" : "opacity-60"}`}>
            <span
              className={`mt-px flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border-[1.5px] text-[11px] text-white ${
                c.included ? "border-brand bg-brand" : "border-line-no bg-surface"
              }`}
            >
              {c.included ? "✓" : ""}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className={`text-[13.5px] leading-[1.4] text-ink ${c.included ? "" : "line-through"}`}>{c.title}</span>
              <span className="font-mono text-[11px] text-ink-muted">
                {c.origin === "human" ? "insan ekledi" : "QA önerdi"}
                {c.rationale && ` · ${c.rationale}`}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">{c.short}</span>
          </div>
        ))}
        {rows.length === 0 && <p className="p-10 text-center text-[13px] text-ink-muted">Bu filtrede case yok.</p>}
      </div>
    </div>
  );
}
