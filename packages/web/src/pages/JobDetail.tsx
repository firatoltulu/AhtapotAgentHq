import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { REOPEN_TARGETS, containerName } from "@ahtapot/shared";
import type { JobState, ModelTier, ReopenTarget, ServerEvent } from "@ahtapot/shared";

import {
  api,
  type Approval,
  type BuildRow,
  type Job,
  type JobAttachment,
  type PlanView,
  type QaCaseRow,
  type Transition,
} from "../api";
import { useJobStream } from "../ws";
import {
  Badge,
  Button,
  Card,
  Clamp,
  Dot,
  EmptyState,
  ErrorText,
  Field,
  FullscreenButton,
  Modal,
  Select,
  Skeleton,
  Tag,
  Textarea,
  fmtAge,
  fmtClock,
  fmtDuration,
  fmtTime,
  jobTone,
  useFullscreen,
  useLocalState,
  type Tone,
} from "../ui";
import { PIPELINE, Pipeline } from "../components/Pipeline";
import { DeltaRow, StreamFilters, StreamRow, useAutoScroll } from "../components/Stream";
import { countByGroup, groupOf, pairTools, summarize, type StreamGroup } from "../components/streamGroups";
import { normalize } from "../components/questions";
import { AttentionButton, AttentionCard, GATE_LABELS, type Fact } from "../components/Attention";
import { DiffView, type LineComment } from "../components/Diff";
import { parseDiff } from "../components/parseDiff";
import {
  groupRuns,
  lastErrorLines,
  parseStepLog,
  stepViews,
  type LogEntry,
  type LogKind,
  type StepStatus,
  type StepView,
} from "../components/buildRuns";
import { AttachmentDrop, discardUploads, splitRelatedFiles, type UploadedFile } from "../components/JobExtras";
import { PlanTab, answersNote, modelChoiceOf, reshapingAnswers, type PlanAnswers, type PlanAskContext } from "../components/PlanTab";
import { groupOf as jobGroupOf } from "../components/jobGroups";
import { TestScenariosCard } from "../components/TestScenarios";
import { Markdown } from "../components/Markdown";
import { QaWorkbench } from "../components/QaWorkbench";
import { LiveEnvCard } from "../components/LiveEnv";
import { ModelTierPicker, tierSummary } from "../components/ModelTier";
import { shortModel, useNextPhase } from "../components/NextPhase";
import {
  LiveTestPanel,
  PhaseEvidence,
  phasePayload,
  BlockedPanel,
  MergePanel,
  PrPanel,
  ReviewRoundPanel,
  SecurityPanel,
  QaCasesPanel,
  type QaCaseEdit,
} from "../components/GatePanels";

/**
 * İş detayı — operatör ekranı.
 *
 * Tasarımın düzeni: solda iş listesi, sağda durum şeridi + kapı banner'ı +
 * sekmeli gövde + sohbet çubuğu. Kapı en üstte ve tam genişlikte: insan
 * hamlesi bekleyen bir iş sekmeler arasında kaybolmamalı.
 */

const TAB_IDS = ["detay", "akis", "degisiklikler", "plan", "build", "qa"] as const;
type Tab = (typeof TAB_IDS)[number];

export function JobDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const job = useQuery({ queryKey: ["job", id], queryFn: () => api.job(id) });
  const plan = useQuery({ queryKey: ["plan", id], queryFn: () => api.plan(id), retry: false });
  const jobs = useQuery({ queryKey: ["jobs", ""], queryFn: () => api.jobs(), refetchInterval: 10_000 });
  // Ekler iş açılırken sabitlenir; sekme sayacı da aynı sorguyu okur.
  const attachments = useQuery({ queryKey: ["attachments", id], queryFn: () => api.jobAttachments(id), staleTime: Infinity });
  const stream = useJobStream(id);
  // `?tab=qa` gibi bir bağlantı sekmeyi doğrudan açar (tasarım: /jobs/:id?tab=qa);
  // açılış dışında URL'ye yazılmaz — sekme geçişi geçmişi doldurmasın.
  const [search] = useSearchParams();
  const linkedTab = TAB_IDS.find((t) => t === search.get("tab"));
  const [tab, setTabRaw] = useState<Tab>(linkedTab ?? "akis");
  // Kullanıcı sekme seçmediyse iş açılınca kapının sekmesi açılır (tasarım:
  // plan kapısında Plan sekmesi). Seçtiyse dokunulmaz — sekme altından kaymasın.
  const tabTouched = useRef(!!linkedTab);
  const setTab = (t: Tab): void => {
    tabTouched.current = true;
    setTabRaw(t);
  };
  const fs = useFullscreen();
  // QA case düzenlemeleri BURADA yaşıyor, kapı banner'ında değil: liste QA
  // sekmesinde çiziliyor ama onay düğmesi banner'da — ikisi ayrı alt ağaç.
  // Yeni kapıda sıfırlanması için anahtar olarak kapı kimliği tutuluyor.
  const [caseEdits, setCaseEdits] = useState<{ gateId: string; cases: QaCaseEdit[] } | null>(null);
  // Ray tercihi yeniden yüklemede korunur: operatör dar ekranda gövdeye yer
  // açmak için kapatıyor ve her sayfa yenilemesinde tekrar kapatmak istemiyor.
  const [railOpen, setRailOpen] = useLocalState("aht.jobRail", true);
  // Satır yorumları da `caseEdits` gibi burada: Değişiklikler sekmesinde
  // yazılıyor, dikkat yuvasındaki red gerekçesine giriyor. Kapıya bağlı;
  // yeni kapı eski yorumu taşımaz.
  const [comments, setComments] = useState<{ gateId: string; items: LineComment[] } | null>(null);
  // İkinci gözün (§42) işaretli bulguları — aynı kalıp: Plan sekmesinde
  // işaretlenir, red gerekçesine girer; plan kapısına bağlı.
  const [critiquePicks, setCritiquePicks] = useState<{ gateId: string; items: string[] } | null>(null);
  // "Görüldü" kapı kimliğine bağlı ve yeniden yüklemede korunur: uzun bir
  // safhayı gözden geçirirken sayfa yenilenince baştan başlamak anlamsız.
  // Yalnız son kapılar tutulur, depo büyümesin.
  const [seenAll, setSeenAll] = useLocalState<Record<string, string[]>>("aht.seen", {});
  // Plan sorularının cevapları da kapıya bağlı ve yeniden yüklemede korunur:
  // mobilde sekme değişimi ya da sayfa yenilenmesi cevapları silmesin. Onay
  // düğmesi dikkat yuvasında, sorular Plan sekmesinde — durum burada.
  const [answersAll, setAnswersAll] = useLocalState<Record<string, PlanAnswers>>("aht.planAnswers", {});
  // Plan sekmesindeki odak (soru/safha) sohbet çubuğunun bağlam çipi olur.
  const [planCtx, setPlanCtx] = useState<PlanAskContext | null>(null);
  // Mobilde sohbet çubuğu kapalı gelir, alt çubuktaki "Agent'a sor" açar.
  const [askOpen, setAskOpen] = useState(false);
  // Mobil alt çubuk (onay düğmeleri) sayfanın en altında; dikkat yuvası
  // düğmelerini buraya taşır (portal) ki durum tek bileşende kalsın.
  const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);

  // Durum/kapı/hata olayı → REST tazele. Akış canlı, ama plan ve safha
  // durumları REST'ten geliyor.
  // `seq` iş İÇİNDE monoton: kimliği de tutulmazsa, sıra numarası daha düşük
  // olan başka bir işe geçildiğinde yeni olaylar "eski" sayılır ve kapı
  // banner'ı ile iş durumu tazelenmez.
  //
  // YALNIZ SON OLAYA bakmak yetmiyor: motor geçişi yazıp hemen ardından
  // bildirim yolluyor (`Done` → "İş tamamlandı"). İkisi aynı render'a düşünce
  // son olay bildirim olur, geçiş atlanır ve ekran eski durumda kalır
  // (yaşandı 2026-09-25: merge sonrası "İş tamamlandı" görünürken şerit CI'da).
  // Son görülen `seq`ten sonraki TÜM olaylar taranır; son olay kalıcı olmayan
  // bir delta da olabilir (`seq` 0), ona göre erken dönmek aynı kaçırmayı yapar.
  const lastSeq = useRef({ jobId: "", seq: 0 });
  useEffect(() => {
    if (lastSeq.current.jobId !== id) lastSeq.current = { jobId: id, seq: 0 };
    const since = lastSeq.current.seq;
    let max = since;
    let changed = false;
    let critique = false;
    for (const e of stream.events) {
      if (e.jobId !== id || e.seq <= since) continue;
      if (e.seq > max) max = e.seq;
      if (e.type === "job.state" || e.type === "approval.required" || e.type === "job.error") changed = true;
      if (e.type === "critique.updated") critique = true;
    }
    lastSeq.current = { jobId: id, seq: max };
    // İkinci göz (§42) iş durumunu değiştirmez; yalnız kendi kartı tazelenir.
    if (critique) void qc.invalidateQueries({ queryKey: ["critiques", id] });
    if (changed) {
      void qc.invalidateQueries({ queryKey: ["job", id] });
      void qc.invalidateQueries({ queryKey: ["plan", id] });
      // Sıradaki safhanın modeli zorlama ya da elle seçimle değişebilir.
      void qc.invalidateQueries({ queryKey: ["nextPhase", id] });
      void qc.invalidateQueries({ queryKey: ["jobs", ""] });
      // Canlı ortam durum değişiminde kalkar/iner; başlıktaki "ortam" ona bakıyor.
      void qc.invalidateQueries({ queryKey: ["live", id] });
      // Build bitince durum değişir (Developing/onay/NeedsAttention): yeni adım satırları.
      void qc.invalidateQueries({ queryKey: ["builds", id] });
    }
  }, [stream.events, id, qc]);

  // İş silindi (iptal = silme): burada beklemenin anlamı yok, liste tazelenip
  // operatör anasayfaya döner — silinmiş işin ekranında kalmak "iş bulunamadı"
  // hatasından başka bir şey göstermezdi.
  useEffect(() => {
    if (!stream.deleted) return;
    void qc.invalidateQueries({ queryKey: ["jobs", ""] });
    qc.removeQueries({ queryKey: ["job", id] });
    navigate("/", { replace: true });
  }, [stream.deleted, id, qc, navigate]);

  const j = job.data;
  const gate = plan.data?.pendingApproval ?? null;
  // `normalize` ham diziyi de kurtarıyor (eski planlarda `openQuestions` düz
  // dize dizisi); sayaç ile panelin gösterdiği soru sayısı aynı olmalı.
  const planQuestions = useMemo(
    () => (plan.data ? normalize(plan.data.document.openQuestions).length : 0),
    [plan.data],
  );

  const gateKind = gate?.kind;
  const tabJob = useRef(id);
  useEffect(() => {
    // Başka işe geçildi: seçim o işe ait değildi, sıfırlanır.
    if (tabJob.current !== id) {
      tabJob.current = id;
      tabTouched.current = false;
      setAskOpen(false);
    }
    if (!tabTouched.current) setTabRaw(gateKind ? (GATE_TAB[gateKind] ?? "akis") : "akis");
  }, [id, gateKind]);

  const planAnswers = gate?.kind === "plan" ? (answersAll[gate.id] ?? {}) : {};
  const setPlanAnswer = (question: string, answer: string | null): void => {
    if (!gate || gate.kind !== "plan") return;
    setAnswersAll((prev) => {
      const cur = { ...(prev[gate.id] ?? {}) };
      if (answer === null) delete cur[question];
      else cur[question] = answer;
      const rest = Object.entries(prev).filter(([k]) => k !== gate.id).slice(-9);
      return Object.fromEntries([...rest, [gate.id, cur]]);
    });
  };

  const gateComments = gate && comments?.gateId === gate.id ? comments.items : [];
  // Canlı test kapısında QA tezgâhı da (kimliksiz elemanlar) aynı yoldan ekler.
  const gatePicks =
    (gate?.kind === "plan" || gate?.kind === "live_test") && critiquePicks?.gateId === gate.id ? critiquePicks.items : [];
  const gateSeen = gate ? (seenAll[gate.id] ?? []) : [];
  const setGateSeen = (path: string, on: boolean): void => {
    if (!gate) return;
    setSeenAll((prev) => {
      const cur = prev[gate.id] ?? [];
      const next = on ? [...new Set([...cur, path])] : cur.filter((p) => p !== path);
      const rest = Object.entries(prev).filter(([k]) => k !== gate.id).slice(-19);
      return Object.fromEntries([...rest, [gate.id, next]]);
    });
  };

  // Build satırları ARTIK ayrı kanalda (`ws.ts`): ana akışa hiç girmiyorlar,
  // bu yüzden burada filtrelemeye gerek yok. Kuyruk sınırı da orada.
  // Bu sekme koşan build'i gösterir; biten build'lerin tam logu REST'ten
  // (`/api/jobs/:id/builds/:buildId/log`) okunur.
  const buildLines = stream.buildLines;

  // Build geçmişi sayfa düzeyinde: sekme sayacı, sekmedeki kırmızı nokta ve
  // dikkat yuvasının "Build kırıldı" başlığı aynı sorguyu okur.
  const builds = useQuery({ queryKey: ["builds", id], queryFn: () => api.builds(id) });
  const profile = useJobProfile(j?.profileId ?? null);
  const planned = useMemo(() => {
    const b = profile.data?.document.build;
    return b ? [...b.preSteps, ...b.steps].map((s) => ({ name: s.name, run: s.run })) : [];
  }, [profile.data]);
  const runs = useMemo(() => groupRuns(builds.data ?? []), [builds.data]);
  const lastSteps = useMemo(() => stepViews(runs[runs.length - 1] ?? [], planned), [runs, planned]);
  const lastFail = lastSteps.find((s) => s.status === "fail");

  return (
    // Tek gövde sütunu: sohbet sağ sütunda ayrı bir panel değil, işin ALTINDA
    // tam genişlikte duruyor (tasarım böyle). Sağ sütun varken akış sekmesi
    // ortadan kalkıyordu ve aynı akış iki yerde çiziliyordu.
    <div
      className={`grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] ${
        railOpen ? "lg:grid-cols-[232px_minmax(0,1fr)]" : "lg:grid-cols-[56px_minmax(0,1fr)]"
      }`}
    >
      <JobSidebar jobs={jobs.data} activeId={id} open={railOpen} onToggle={() => setRailOpen((v) => !v)} />

      <div className="flex min-h-0 min-w-0 flex-col">
        {job.isLoading ? (
          <div className="p-6">
            <Skeleton />
          </div>
        ) : job.isError ? (
          <EmptyState title="İş açılamadı">
            <ErrorText error={job.error} />
          </EmptyState>
        ) : j ? (
          <>
            <JobHeader job={j} connected={stream.connected} plan={plan.data} gate={gate} />

            {/* Tek dikkat yuvası: kapı › hata › koşuyor. "Koşuyor" HANGİ
                SEKMEDE olursa olsun görünmeli; Plan sekmesine gömülüyken
                operatör "hiçbir şey olmuyor" sanıyordu (yaşandı, iki kez).
                `key`: yeni kapıda red yorumu sıfırlansın, aksi hâlde operatör
                yeni kapıyı eski yorumla onaylar. */}
            <AttentionSlot
              key={gate?.id ?? "none"}
              job={j}
              gate={gate}
              plan={plan.data}
              planQuestions={planQuestions}
              planAnswers={planAnswers}
              onTab={setTab}
              dock={dockEl}
              onAsk={() => {
                // Plan kapısında soru Planner'a plan bağlamıyla gider; diğer
                // kapılarda sohbet Akış sekmesinde.
                if (gate?.kind === "plan") {
                  setTab("plan");
                  setAskOpen(true);
                } else setTab("akis");
              }}
              caseEdits={gate && caseEdits?.gateId === gate.id ? caseEdits.cases : null}
              comments={gateComments}
              critiqueNotes={gatePicks}
              seen={gateSeen}
              buildFail={lastFail}
            />

            {/* Sekme çubuğu + gövde + sohbet TEK birim olarak tam ekrana geçer:
                mobilde dar sütunda plan ve diff okunmuyordu. Aynı eleman
                `fixed` olur, sekme içeriği yeniden bağlanmaz. */}
            <div className={`flex min-h-0 flex-1 flex-col ${fs.frameClass}`}>
            <TabBar
              tab={tab}
              onTab={setTab}
              fullscreen={fs}
              counts={{
                detay: attachments.data && attachments.data.length > 0 ? `${attachments.data.length} görsel` : "—",
                akis: stream.connected ? "canlı" : String(stream.events.length),
                degisiklikler: gate?.kind === "phase" ? "kapıda" : "—",
                // Tasarım: safha sayısı. Cevap bekleyen sorular dikkat
                // yuvasındaki "4 soru · 2 cevaplı" çipinde ve sekme noktasında.
                plan: plan.data ? String(plan.data.phases.length) : "—",
                build: lastSteps.length > 0 ? String(lastSteps.length) : buildLines.length > 0 ? "canlı" : "—",
                qa: gate?.kind === "qa_cases" || gate?.kind === "blocked"
                  ? "kapıda"
                  : (plan.data?.qaCases.filter((c) => c.included).length ?? 0) > 0
                    ? String(plan.data!.qaCases.filter((c) => c.included).length)
                    : "—",
              }}
              // Tasarımdaki sekme noktaları: canlı akış yeşil nabız, kapının
              // beklediği sekme mor, kırık build kırmızı.
              dots={{
                ...(stream.connected ? { akis: { tone: "ok" as const, pulse: true } } : {}),
                ...(gate?.kind === "phase" ? { degisiklikler: { tone: "run" as const } } : {}),
                ...(gate?.kind === "plan" ? { plan: { tone: "run" as const } } : {}),
                ...(gate && ["qa_cases", "blocked", "live_test", "security"].includes(gate.kind) ? { qa: { tone: "run" as const } } : {}),
                ...(lastFail && !isClosed(j.state) ? { build: { tone: "err" as const } } : {}),
              }}
            />

            {/* Build sekmesi kaydırmayı KENDİ log kutusunda yapar (alta yapışsın
                diye); burada `overflow-auto` kalırsa taşan dış kutu olur ve iç
                kutu hiç kaydırma çubuğu almaz. Plan da aynı: rail ve okuma
                paneli ayrı ayrı kaydırır, dış kutu kaydırırsa rail yukarı
                kaçar. Diğer sekmeler eskisi gibi. */}
            {/* Değişiklikler kenardan kenara: ağaç ve kod paneli kendi
                kaydırmasını yapar, dış boşluk yalnız kod genişliği yer. */}
            <div
              className={`min-h-0 flex-1 ${
                tab === "degisiklikler" || tab === "build" || tab === "plan"
                  ? "overflow-hidden"
                  : "overflow-auto px-4 py-4 md:px-5.5 md:py-4.5"
              }`}
            >
              {tab === "detay" && (
                <DetailsTab job={j} attachments={attachments.data} loading={attachments.isLoading} error={attachments.error} />
              )}
              {tab === "akis" && <StreamTab events={stream.events} deltas={stream.deltas} jobId={id} />}
              {tab === "degisiklikler" && (
                <ChangesTab
                  key={gate?.id ?? "live"}
                  gate={gate}
                  jobId={id}
                  running={j.phase === "running" || j.phase === "starting"}
                  seen={gateSeen}
                  onSeen={setGateSeen}
                  comments={gateComments}
                  onComments={(items) => gate && setComments({ gateId: gate.id, items })}
                />
              )}
              {tab === "plan" && (
                <PlanTab
                  jobId={id}
                  running={j.phase === "running" || j.phase === "starting"}
                  answers={planAnswers}
                  onAnswer={setPlanAnswer}
                  onAsk={setPlanCtx}
                  ladder={profile.data?.document.agents.triage.ladder}
                  critiquePicks={gatePicks}
                  {...(gate?.kind === "plan"
                    ? { onCritiquePicks: (items: string[]) => setCritiquePicks({ gateId: gate.id, items }) }
                    : {})}
                />
              )}
              {tab === "build" && (
                <BuildTab
                  lines={buildLines}
                  jobId={id}
                  job={j}
                  runs={runs}
                  planned={planned}
                  loading={builds.isLoading}
                  error={builds.error}
                  maxBuilds={loopMax(profile.data?.document, "build")}
                />
              )}
              {tab === "qa" && (
                <QaTab
                  gate={gate}
                  job={j}
                  jobId={id}
                  cases={plan.data?.qaCases ?? []}
                  caseEdits={gate && caseEdits?.gateId === gate.id ? caseEdits.cases : null}
                  onCaseEdits={(cases) => gate && setCaseEdits({ gateId: gate.id, cases })}
                  onRejectNotes={(lines) =>
                    gate &&
                    setCritiquePicks((prev) => {
                      const cur = prev?.gateId === gate.id ? prev.items : [];
                      return { gateId: gate.id, items: [...cur, ...lines.filter((l) => !cur.includes(l))] };
                    })
                  }
                />
              )}
            </div>

            {/* Sohbet Akış sekmesinde her zaman; Plan sekmesinde bağlam çipiyle
                (tasarım 2b: "Plan · S3 ×"). Mobilde Plan sekmesinde kapalı gelir,
                alt çubuktaki "Agent'a sor" açar — dar ekranda plan okunmalı. */}
            {tab === "akis" && <Composer jobId={id} state={j.state} connected={stream.connected} />}
            {tab === "plan" && (
              <div className={askOpen ? "" : "hidden md:block"}>
                <Composer
                  jobId={id}
                  state={j.state}
                  connected={stream.connected}
                  context={planCtx}
                  onClose={() => setAskOpen(false)}
                />
              </div>
            )}
            </div>

            <div ref={setDockEl} className="shrink-0 md:hidden" />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Sol sütun ────────────────────────────────────────────────────────────────

/**
 * Raydaki üç kova. Kırık iş "Seni bekleyen"in içinde: rayda ayrı bir kova
 * yerine kırmızı noktasıyla ayrılıyor; operatör için ikisi de "sıra bende".
 */
const RAIL_GROUPS: { key: "wait" | "run" | "done"; label: string; ink: string }[] = [
  { key: "wait", label: "Seni bekleyen", ink: "text-wait-ink" },
  { key: "run", label: "Koşan", ink: "text-run-ink" },
  { key: "done", label: "Bitmiş", ink: "text-ink-muted" },
];

/** Bitmiş kova uzar gider; rayda son birkaçı yeter, tamamı İşler ekranında. */
const RAIL_DONE_MAX = 8;

const RAIL_RUN_LABEL: Partial<Record<JobState, string>> = {
  Planning: "planner",
  Developing: "developer",
  Building: "build",
  QA: "QA",
  CIWatch: "CI",
};

/** Satırın ikinci satırındaki "ne oluyor" parçası — tasarımdaki "safha onayı", "build kırık". */
function railWhat(j: Job): string {
  const g = jobGroupOf(j);
  if (g === "err") return j.errorCode === "build_loop" ? "build kırık" : (j.errorCode?.replace(/_/g, " ") ?? "dikkat");
  if (g === "done") return j.state === "Done" ? "tamamlandı" : "iptal";
  if (j.state === "Draft") return "taslak";
  if (j.state === "PlanReview") return "plan onayı";
  if (j.state === "LiveTest") return "canlı test";
  if (j.state === "QACases") return "QA vakaları";
  if (j.state === "PRReview") return j.phase === "waiting" ? "PR kararı" : "PR incelemesi";
  if (j.phase === "waiting") return j.state === "Developing" ? "safha onayı" : "cevap bekliyor";
  return RAIL_RUN_LABEL[j.state] ?? j.state;
}

/**
 * Sol iş rayı — kapanabilir, duruma göre gruplu.
 *
 * Kapalıyken yalnız durum noktaları kalır ve gövde genişler: akış satırları ve
 * diff dar ekranda buna muhtaç. İş başlığı `title` özniteliğinde durduğu için
 * kapalı rayda da hangi iş olduğu okunur; gruplar ince çizgiyle ayrılır.
 */
function JobSidebar({
  jobs,
  activeId,
  open,
  onToggle,
}: {
  jobs: Job[] | undefined;
  activeId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, staleTime: 60_000 });
  // Workspace seçimi yeniden yüklemede korunur: tek projede çalışan operatör
  // her seferinde yeniden seçmesin.
  const [ws, setWs] = useLocalState("aht.railWs", "all");
  const nameOf = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "";
  const list = (jobs ?? []).filter((j) => ws === "all" || j.projectId === ws || j.id === activeId);

  const groups = RAIL_GROUPS.map((g) => {
    const all = list.filter((j) => {
      const k = jobGroupOf(j);
      return g.key === "wait" ? k === "wait" || k === "err" : k === g.key;
    });
    // Seçili iş bitmişler arasında kesilen kısımda kalsa bile görünür.
    const items =
      g.key === "done" && all.length > RAIL_DONE_MAX
        ? all.filter((j, i) => i < RAIL_DONE_MAX || j.id === activeId)
        : all;
    return { ...g, n: all.length, items, more: all.length - items.length };
  }).filter((g) => g.n > 0);

  return (
    <aside className="hidden min-h-0 flex-col border-r border-edge bg-raised lg:flex">
      <div className={`flex shrink-0 items-center gap-2 border-b border-edge p-3 ${open ? "" : "justify-center"}`}>
        <button
          onClick={onToggle}
          title="İş listesini aç/kapat"
          aria-label="İş listesini aç/kapat"
          aria-expanded={open}
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-edge-strong bg-surface text-[13px] text-ink-muted transition-colors hover:text-ink"
        >
          {open ? "«" : "»"}
        </button>
        {open && (
          <span className="relative min-w-0 flex-1">
            <select
              value={ws}
              onChange={(e) => setWs(e.target.value)}
              aria-label="Workspace"
              className="h-[30px] w-full cursor-pointer appearance-none truncate rounded-[9px] border border-edge-strong bg-surface pr-6 pl-2.5 text-[12.5px] text-ink-body outline-none focus:border-brand-edge"
            >
              <option value="all">Tüm workspace'ler</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[10px] text-ink-muted">▾</span>
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-2 py-2.5">
        {jobs?.length === 0 || (jobs && groups.length === 0) ? (
          open ? (
            <div className="px-2.5 py-6 text-center text-[12.5px] text-ink-muted">iş yok</div>
          ) : (
            <div className="py-6 text-center font-mono text-[12.5px] text-ink-muted">0</div>
          )
        ) : null}
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-0.5">
            {open ? (
              <div className="flex items-center gap-1.5 px-2 pb-1">
                <span className={`font-mono text-[10.5px] uppercase tracking-[.1em] ${g.ink}`}>{g.label}</span>
                <span className="flex-1" />
                <span className="font-mono text-[10.5px] text-ink-muted">{g.n}</span>
              </div>
            ) : (
              <div className="mx-1.5 mb-1 h-px bg-edge" />
            )}
            {g.items.map((j) => {
              const tone = jobTone(j.state, j.phase);
              const project = nameOf(j.projectId);
              const meta = [project, railWhat(j), jobGroupOf(j) === "run" ? "" : fmtAge(j.updatedAt)].filter(Boolean);
              return (
                <Link
                  key={j.id}
                  to={`/jobs/${j.id}`}
                  title={open ? undefined : `${j.title} · ${meta.join(" · ")}`}
                  className={`flex items-center gap-[9px] rounded-[9px] border px-[9px] py-2 no-underline transition-colors ${
                    open ? "" : "justify-center"
                  } ${j.id === activeId ? "border-brand-edge bg-brand-tint" : "border-transparent hover:bg-chip"}`}
                >
                  <Dot tone={tone} pulse={tone === "run"} />
                  {open && (
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate text-[12.5px] font-medium leading-[1.3] text-ink">{j.title}</span>
                      <span className="truncate font-mono text-[10.5px] text-ink-muted">{meta.join(" · ")}</span>
                    </span>
                  )}
                </Link>
              );
            })}
            {open && g.more > 0 && (
              <Link to="/jobs" className="px-2 pt-1 font-mono text-[10.5px] text-ink-muted hover:text-ink">
                +{g.more} iş daha · tümü →
              </Link>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-edge px-3 py-2.5">
        <Link
          to="/jobs"
          title="Yeni iş"
          className="flex h-[30px] items-center justify-center rounded-[9px] border border-brand-edge text-[12.5px] font-semibold text-brand no-underline hover:bg-brand-tint"
        >
          {open ? "+ Yeni iş" : "+"}
        </Link>
      </div>
    </aside>
  );
}

type JobWithTransitions = Job & { transitions: Transition[] };

const isClosed = (state: JobState): boolean => state === "Done" || state === "Cancelled";

/**
 * Canlı ortam. Başlıktaki "ortam" ve dikkat yuvasındaki "Canlı ortamı yık"
 * aynı sorguyu okur. Kapalı işte ortam da kaldırılmıştır, sorulmaz.
 */
function useLive(job: Job) {
  return useQuery({ queryKey: ["live", job.id], queryFn: () => api.live(job.id), enabled: !isClosed(job.state) });
}

/**
 * İşin koştuğu profil belgesi: döngü sınırları (`limits.maxLoops`) orada.
 * İş doğduğu sürüme bağlı; projenin güncel profili değil, bu okunmalı.
 */
function useJobProfile(profileId: string | null) {
  return useQuery({
    queryKey: ["profileDoc", profileId],
    queryFn: () => api.profile(profileId ?? ""),
    enabled: profileId !== null,
    staleTime: Infinity,
  });
}

/** Döngü sınırı: profil yüklenmediyse ya da alan yoksa `undefined`. */
function loopMax(doc: { limits: { maxLoops: Record<string, number> } } | undefined, key: string): number | undefined {
  return doc?.limits.maxLoops[key];
}

/**
 * `NeedsAttention`a hangi düğümden düşüldü.
 *
 * Durum makinesi bunu işte tutmuyor ama geçiş kaydı tutuyor. Rayda olmayan bir
 * durumdan gelindiyse bilinmiyor sayılır: yanlış düğümü kırmızı çizmek, hiç
 * çizmemekten kötü.
 */
function brokenAt(job: JobWithTransitions): JobState | undefined {
  if (job.state !== "NeedsAttention") return undefined;
  let last: Transition | undefined;
  for (const t of job.transitions) {
    if (t.toState === "NeedsAttention" && (!last || t.createdAt > last.createdAt)) last = t;
  }
  const from = last?.fromState;
  return from && (PIPELINE as string[]).includes(from) ? (from as JobState) : undefined;
}

/** İşin başladığı an: ilk `Draft→` geçişi; kaydı yoksa oluşturulma anı. */
function startedAt(job: JobWithTransitions): string {
  let first: string | undefined;
  for (const t of job.transitions) {
    if (t.fromState === "Draft" && (!first || t.createdAt < first)) first = t.createdAt;
  }
  return first ?? job.createdAt;
}

/** Geçen süre: "45sn", "12dk", "3s 12dk", "2g 4s". */
function fmtElapsed(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return `${Math.max(0, Math.floor(ms / 1000))}sn`;
  if (min < 60) return `${min}dk`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}s ${min % 60}dk`;
  return `${Math.floor(hours / 24)}g ${hours % 24}s`;
}

/**
 * Sayının yönelme hâli eki: "safha 3'e", "v2'ye", "safha 6'ya".
 *
 * Ek, sayının OKUNUŞUNUN son hecesine uyar; sabit "'e" yazmak "2'e" gibi
 * yanlış metin üretiyordu.
 */
function dative(n: number): string {
  const ones = ["", "e", "ye", "e", "e", "e", "ya", "ye", "e", "a"];
  const tens = ["", "a", "ye", "a", "a", "ye", "a", "e", "e", "a"];
  if (n % 10 !== 0) return `${n}'${ones[n % 10]}`;
  if (n % 100 !== 0) return `${n}'${tens[Math.floor(n / 10) % 10]}`;
  return `${n}'e`;
}

/** Kapalı işte durur; açıkken dakikalık süre gösterimi için yarım dakikada bir tazelenir. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

/** Açılır parça: dışarı tıklama ve Esc kapatır. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** Başlık sayacı: üstte "anahtar değer", altında sınıra oranla dolan 3px çubuk. */
function Meter({ k, v, pct, wait = false, title }: { k: string; v: string; pct?: number; wait?: boolean; title?: string }) {
  return (
    <div className="flex min-w-[74px] flex-col gap-1" title={title}>
      <div className="flex items-baseline gap-1.5 font-mono text-[10.5px]">
        <span className="text-ink-muted">{k}</span>
        <span className={`font-semibold ${wait ? "text-wait-ink" : "text-ink-body"}`}>{v}</span>
      </div>
      {/* Sınırı olmayan sayaçta çubuk yok ama yeri korunur: sayaçlar aynı hizada okunur. */}
      <div className={`h-[3px] overflow-hidden rounded-sm ${pct === undefined ? "" : "bg-edge"}`}>
        {pct !== undefined && (
          <div className={`h-full ${wait ? "bg-wait" : "bg-meter"}`} style={{ width: `${Math.min(100, Math.max(4, pct))}%` }} />
        )}
      </div>
    </div>
  );
}

/** Adım başına ne olacağı — insan seçmeden önce bedelini görsün. */
const REOPEN_HINTS: Record<ReopenTarget, string> = {
  Planning: "Planner onaylı planı yorumunla günceller; yeni plan yeniden onaya gelir.",
  Developing: "Planın sonuna düzeltme safhası eklenir ve Developer yorumunla koşar. Yorum zorunlu.",
  LiveTest: "Canlı ortam yeniden kalkar ve test kapısı açılır.",
  QACases: "QA case listesini yeniden çıkarır; yorum varsa listeyi ona göre günceller.",
  QA: "QA onaylı case listesiyle testleri yeniden yazar ve koşturur.",
  PRReview: "PR onay kapısı yeniden açılır. Profil remote'u düzeltildiyse önce güncel profile yükselt.",
};

function ReopenDialog({
  job,
  onClose,
  initial,
}: {
  job: Job;
  onClose: () => void;
  /** Hata kartından açılınca adım ve sebep hazır gelir. */
  initial?: { target: ReopenTarget; comment: string };
}) {
  const qc = useQueryClient();
  // Varsayılan PR adımı: en sık sebep PR açılmadan kapanan iş (remote GitHub
  // değildi, profil sonradan düzeltildi).
  const [target, setTarget] = useState<ReopenTarget>(initial?.target ?? (job.state === "Done" ? "PRReview" : "Developing"));
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [images, setImages] = useState<UploadedFile[]>([]);
  const [tier, setTier] = useState<ModelTier | null>(job.modelTier);
  const ladder = useJobProfile(job.profileId).data?.document.agents.triage.ladder;
  const reopen = useMutation({
    mutationFn: () =>
      api.reopenJob(job.id, { target, comment, modelTier: tier, attachmentIds: images.map((i) => i.id) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["job", job.id] });
      void qc.invalidateQueries({ queryKey: ["approvals", job.id] });
      onClose();
    },
  });
  const needsComment = target === "Developing" && comment.trim() === "";
  const cancel = (): void => {
    discardUploads(images);
    onClose();
  };

  return (
    <Modal
      title="İşi yeniden aç"
      subtitle={`${job.state} → seçilen adım · aynı dal ve worktree`}
      onClose={cancel}
      footer={
        <>
          <span className="min-w-0 flex-1">{reopen.error != null && <ErrorText error={reopen.error} />}</span>
          <Button variant="neutral" size="md" onClick={cancel}>
            Vazgeç
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={reopen.isPending || needsComment}
            onClick={() => reopen.mutate()}
          >
            {reopen.isPending ? "açılıyor…" : "Yeniden aç"}
          </Button>
        </>
      }
    >
      <Field label="Adım">
        <Select value={target} onChange={(e) => setTarget(e.target.value as ReopenTarget)}>
          {REOPEN_TARGETS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-[12.5px] leading-relaxed text-ink-soft">{REOPEN_HINTS[target]}</p>
      <Field label={target === "Developing" ? "Ne düzeltilecek" : "Yorum (isteğe bağlı)"}>
        <Textarea rows={5} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <AttachmentDrop attachments={images} onChange={setImages} imagesOnly />
      <Field label="Model">
        <ModelTierPicker value={tier} onChange={setTier} ladder={ladder} />
      </Field>
    </Modal>
  );
}

/**
 * "Yeniden dene", model seçerek.
 *
 * Döngüye girip düşen iş (CI kırmızısı, bot yorumu, kırık test) aynı modelle
 * yeniden denenince çoğu zaman aynı yerde takılıyor. Seçim İŞ BOYUNCA kalır;
 * yeni seviye seçilirse döngü sayaçları sıfırlanır (tavan eski modelle doldu).
 */
function RetryDialog({ job, onClose }: { job: Job; onClose: () => void }) {
  const qc = useQueryClient();
  const [tier, setTier] = useState<ModelTier | null>(job.modelTier);
  const ladder = useJobProfile(job.profileId).data?.document.agents.triage.ladder;
  const retry = useMutation({
    mutationFn: () => api.retryJob(job.id, tier),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["job", job.id] });
      void qc.invalidateQueries({ queryKey: ["plan", job.id] });
      onClose();
    },
  });
  return (
    <Modal
      title="Modelle yeniden dene"
      subtitle={`şu an: ${tierSummary(job.modelTier, ladder)}`}
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1">{retry.error != null && <ErrorText error={retry.error} />}</span>
          <Button variant="neutral" size="md" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant="primary" size="md" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending ? "başlıyor…" : "Yeniden dene"}
          </Button>
        </>
      }
    >
      <ModelTierPicker value={tier} onChange={setTier} ladder={ladder} />
      <p className="text-[12.5px] leading-relaxed text-ink-soft">
        Seçim işin geri kalanında Planner, Developer, QA ve DevOps için geçerli (CI düzeltmesi, inceleme yorumları,
        test düzeltmesi dahil). Seviye seçersen döngü sayaçları sıfırlanır; "Profil" zorlamayı kaldırır.
      </p>
    </Modal>
  );
}

/**
 * Model seviyesini deneme başlatmadan değiştirir — "bir tur daha" kapısı gibi
 * onayla sürecek yerlerde. Seçim hemen kaydedilir; onay onu kullanır.
 */
function JobModelCard({ job, hint }: { job: Job; hint: string }) {
  const qc = useQueryClient();
  const ladder = useJobProfile(job.profileId).data?.document.agents.triage.ladder;
  const set = useMutation({
    mutationFn: (tier: ModelTier | null) => api.setModelTier(job.id, tier),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["job", job.id] }),
  });
  return (
    <div className="flex max-w-[840px] flex-col gap-2 rounded-xl border border-edge bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">Model</span>
        <span className="font-mono text-[11.5px] text-ink-muted">{tierSummary(job.modelTier, ladder)}</span>
      </div>
      <ModelTierPicker value={job.modelTier} onChange={(t) => set.mutate(t)} ladder={ladder} disabled={set.isPending} />
      <p className="text-[12px] leading-relaxed text-ink-soft">{hint}</p>
      <ErrorText error={set.error} />
    </div>
  );
}

function JobHeader({
  job,
  connected,
  plan,
  gate,
}: {
  job: JobWithTransitions;
  connected: boolean;
  plan: PlanView | undefined;
  gate: Approval | null;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Proje adı başlıkta bağlam veriyor: aynı anda birden çok projede iş koşarken
  // hangisine baktığı yalnız iş başlığından anlaşılmıyordu.
  const project = useQuery({
    queryKey: ["project", job.projectId],
    queryFn: () => api.project(job.projectId),
    staleTime: 60_000,
  });
  const profile = useJobProfile(job.profileId);
  const cancel = useMutation({
    mutationFn: () => api.cancelJob(job.id, "UI'dan iptal"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["job", job.id] }),
  });
  // Profil sürümlenmiş bir belge ve iş DOĞDUĞU ANDAKİ sürüme bağlı kalıyor:
  // düzeltme onaylansa bile eski profille koşmayı sürdürür. Bunu yapan uç
  // vardı ama UI'dan çağrılmıyordu, taşımak DB'den elle güncellemek demekti.
  const retarget = useMutation({
    mutationFn: () => api.retargetJob(job.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["job", job.id] }),
  });
  // Hazır olmayan canlı ortam tanı için ayakta bırakılıyor; loglara bakıldıktan
  // sonra işi iptal etmeden kapatmanın yolu bu. LiveTest'te menüde yok:
  // orada ortamı kapı kararı kapatır.
  const live = useLive(job);
  const stopLive = useMutation({
    mutationFn: () => api.stopLive(job.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["live", job.id] }),
  });

  // Otopilot işe özel ve yalnız geliştirme adımında etkili; dışında açık
  // kalabilir (ör. plan onayından önce açılır), etkisi Developing'de başlar.
  const autopilot = useMutation({
    mutationFn: (enabled: boolean) => api.setAutopilot(job.id, enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["job", job.id] }),
  });
  const devStep = job.state === "Developing" || job.state === "Building";
  const autopilotTitle = job.autopilot
    ? `Otopilot açık${devStep ? "" : " — geliştirme adımında devreye girer"}: safhalar kendiliğinden onaylanır, Developer soruları kendi kararıyla geçer. Canlı test, QA ve PR kapıları insanda kalır. Tıklayınca kapanır.`
    : "Otopilot kapalı. Açılırsa geliştirme adımında safha onayı ve Developer soruları insanı beklemez; bekleyen safha kapısı hemen onaylanır.";

  // Kapanmış ya da takılmış işi seçilen adımdan yeniden aç. `retry` motora
  // "kaldığın yerden" der; bu insanın "şu adımı yeniden yap" kararı.
  const [reopenOpen, setReopenOpen] = useState(false);

  const done = isClosed(job.state);
  const now = useNow(!done);
  // Profili eskimiş mi? İptal edilmiş işte göstermenin anlamı yok — profili
  // tarihsel kayıt. Done'da gösterilir: yeniden açılmadan önce düzeltilmiş
  // profile taşımak (ör. remote'u GitHub'a çevirmek) çoğu zaman sebebin ta
  // kendisi.
  const staleProfile =
    job.state !== "Cancelled" && project.data?.activeProfile != null && job.profileId !== project.data.activeProfile.id;
  const nextVersion = project.data?.activeProfile?.version;

  // Sayaçlar: plan ilerlemesi, build döngüsü sınırıyla, geçen süre. Bütçe
  // sayacı yok: işin bütçe sınırı tutulmuyor, sınırsız bir "$" çubuğu yanıltırdı.
  const phases = plan?.phases ?? [];
  const phasesDone = phases.filter((p) => p.status === "approved" || p.status === "skipped").length;
  const builds = job.loopCounts.build ?? 0;
  const maxBuilds = loopMax(profile.data?.document, "build");
  const elapsed = (done ? new Date(job.updatedAt).getTime() : now) - new Date(startedAt(job)).getTime();

  const activeLive = live.data?.active ?? null;
  const menu: MenuItem[] = [];
  if (job.state === "Done" || job.state === "NeedsAttention") {
    menu.push({
      label: "Yeniden aç…",
      title: "İşi seçtiğin adımdan yeniden aç — aynı dal ve worktree ile sürer",
      onClick: () => setReopenOpen(true),
    });
  }
  if (activeLive && job.state !== "LiveTest") {
    menu.push({
      label: stopLive.isPending ? "yıkılıyor…" : "Canlı ortamı yık",
      danger: true,
      disabled: stopLive.isPending,
      title: `Canlı ortam ayakta (${activeLive.status}) — ${activeLive.appUrl}`,
      onClick: () => {
        if (confirm("Canlı ortamın konteynerleri yıkılsın mı? İş durumu değişmez.")) stopLive.mutate();
      },
    });
  }
  if (!done) {
    menu.push({
      label: "İptal",
      danger: true,
      disabled: cancel.isPending,
      onClick: () => {
        if (confirm("İş iptal edilsin mi? Bu işlem geri alınamaz: işe ait tüm kayıtlar, worktree ve konteyner silinir."))
          cancel.mutate();
      },
    });
  }

  // Alt satırın parçaları "·" ile ayrılır; olmayan parça ayırıcı bırakmaz.
  const meta: ReactNode[] = [];
  if (job.branchName) {
    meta.push(
      <Clamp key="branch" lines={1} text={job.branchName} className="min-w-0 max-w-[320px] text-accent-ink" />,
    );
  }
  if (job.worktreePath) {
    meta.push(
      <span key="wt" title={job.worktreePath}>
        worktree {done ? "bırakıldı" : "kilitli"}
      </span>,
    );
  }
  // Konteyner adı DB'de tutulmuyor; `jobId`den türetiliyor (`brand.ts`, "tek
  // yerden üretilir"). Docker'da `docker logs` ile aranacak ad bu; operatör
  // onu elle kurmak zorunda kalıyordu. Kapalı işte konteyner de kaldırılmıştır.
  if (!done) {
    meta.push(
      <span key="ctr" title={`docker logs -f ${containerName.agent(job.id)}`}>
        {containerName.agent(job.id)}
      </span>,
    );
  }
  meta.push(
    <span key="ws" className="flex items-center gap-1.5">
      <Dot tone={connected ? "ok" : "err"} size={6} />
      {connected ? "WS bağlı" : "bağlantı yok"}
    </span>,
  );
  const refLabel = job.externalRef ? `${job.source === "github_issue" ? "issue" : job.source} ${job.externalRef}` : null;
  if (job.externalUrl) {
    meta.push(
      <a
        key="ref"
        href={job.externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink"
        title="Bağlı kayıt"
      >
        {refLabel ?? job.source} ↗
      </a>,
    );
  } else if (refLabel) {
    meta.push(<span key="ref">{refLabel}</span>);
  }

  // Mobil ⋯: masaüstünde başlıkta duran eylemler dar ekranda menüye iner.
  const mobileMenu: MenuItem[] = [];
  if (staleProfile && nextVersion !== undefined) {
    mobileMenu.push({
      label: retarget.isPending ? "taşınıyor…" : `Profili v${dative(nextVersion)} yükselt`,
      disabled: retarget.isPending,
      onClick: () => {
        if (confirm(`İş, profil v${dative(nextVersion)} taşınsın mı? Loop sayaçları sıfırlanır.`)) retarget.mutate();
      },
    });
  }
  if (activeLive) {
    mobileMenu.push({ label: "Canlı ortamı aç ↗", onClick: () => window.open(activeLive.appUrl, "_blank", "noopener") });
  }
  if (job.externalUrl) {
    const url = job.externalUrl;
    mobileMenu.push({ label: `${refLabel ?? job.source} ↗`, onClick: () => window.open(url, "_blank", "noopener") });
  }
  if (!done) {
    mobileMenu.push({
      label: autopilot.isPending ? "değiştiriliyor…" : job.autopilot ? "Otopilotu kapat" : "Otopilotu aç",
      disabled: autopilot.isPending,
      title: autopilotTitle,
      onClick: () => autopilot.mutate(!job.autopilot),
    });
  }
  mobileMenu.push(...menu);
  const mobileMeta = [
    project.data?.name,
    job.state,
    phases.length > 0 ? `plan ${phasesDone}/${phases.length}` : maxBuilds !== undefined && builds > 0 ? `build ${builds}/${maxBuilds}` : "",
  ].filter(Boolean);

  return (
    <>
    {/* ── Mobil başlık (tasarım 2e): tek satır, 44px dokunma hedefleri, şerit
        yalnız ilerleme çubukları. Sayaçlar ve meta satırı dar ekranda başlığı
        dört satıra çıkarıp planın yerini yiyordu. */}
    <div className="flex shrink-0 flex-col md:hidden">
      <div className="flex items-center gap-2.5 border-b border-edge px-4 pt-1.5 pb-2.5">
        <button
          onClick={() => navigate(-1)}
          aria-label="Geri"
          className="-ml-2.5 flex h-11 w-11 shrink-0 items-center justify-center text-[18px] text-ink-body"
        >
          ←
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="truncate text-[15px] font-semibold text-ink" title={job.title}>
            {job.title}
          </h1>
          <span className="truncate font-mono text-[11px] text-ink-muted">{mobileMeta.join(" · ")}</span>
        </div>
        <JobMenu items={mobileMenu} mobile />
      </div>
      <MiniPipeline state={job.state} brokenAt={brokenAt(job)} />
      <ErrorText error={cancel.error ?? stopLive.error ?? retarget.error ?? autopilot.error} />
    </div>

    <div className="hidden shrink-0 flex-col gap-[9px] px-5.5 pt-3.5 md:flex">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          aria-label="Geri"
          className="shrink-0 text-[13px] text-ink-muted hover:text-ink"
        >
          ←
        </button>
        <span className="flex min-w-0 flex-1 basis-[280px] items-baseline gap-2.5">
          {/* Başlık serbest metin ve uzun geliyor; tek satırda kırpılır, tamamı tooltip'te. */}
          <Clamp
            as="h1"
            lines={1}
            text={job.title}
            className="min-w-0 text-[19px] font-semibold tracking-[-.015em] text-ink"
          />
          {project.data && (
            <Link
              to={`/projects/${job.projectId}`}
              title={job.profileVersion !== null ? `profil v${job.profileVersion}` : undefined}
              className="shrink-0 font-mono text-[12px] text-ink-muted no-underline hover:text-ink"
            >
              / {project.data.name}
            </Link>
          )}
          {/* Eskimiş profil SESSİZ KALMAMALI: iş düzeltilmiş profille değil
              kendi sürümüyle koşuyor. Metin EYLEM söyler: önceki hâli ("profil
              eski → v5") bilgi çipi gibi okunuyordu ve tıklanabilir olduğu
              belli değildi. */}
          {staleProfile && nextVersion !== undefined && (
            <button
              className="shrink-0 cursor-pointer self-center rounded-[5px] border border-wait-edge bg-wait-tint px-2 py-0.5 text-[11.5px] font-medium text-wait-ink hover:bg-wait hover:text-white disabled:cursor-default disabled:opacity-60"
              disabled={retarget.isPending}
              title={`Bu iş profil v${job.profileVersion ?? "?"} ile koşuyor; projenin onaylı profili v${nextVersion}. Tıklayınca güncel profile taşınır ve loop sayaçları sıfırlanır.`}
              onClick={() => {
                if (confirm(`İş, profil v${dative(nextVersion)} taşınsın mı? Loop sayaçları sıfırlanır.`)) {
                  retarget.mutate();
                }
              }}
            >
              {retarget.isPending
                ? "taşınıyor…"
                : `profil v${job.profileVersion ?? "?"} · v${dative(nextVersion)} yükselt`}
            </button>
          )}
          {/* Reddedilen taşıma SESSİZ KALMAMALI.
              YAŞANDI: sunucu 409 ile "iş koşuyor; profil değiştirilemez"
              diyordu ve UI hiçbir şey göstermiyordu. */}
          {retarget.error != null && (
            <span
              className="min-w-0 max-w-[420px] self-center truncate rounded-[5px] border border-err-edge bg-err-tint px-1.5 py-0.5 font-mono text-[10.5px] text-err-text"
              title={retarget.error instanceof Error ? retarget.error.message : String(retarget.error)}
            >
              taşınamadı: {retarget.error instanceof Error ? retarget.error.message : String(retarget.error)}
            </span>
          )}
        </span>

        <div className="flex shrink-0 items-center gap-3.5">
          {phases.length > 0 && (
            <Meter
              k="plan"
              v={`${phasesDone}/${phases.length}`}
              pct={(phasesDone / phases.length) * 100}
              wait={gate?.kind === "plan"}
              title="onaylanan safha / toplam safha"
            />
          )}
          <Meter
            k="build"
            v={maxBuilds !== undefined ? `${builds}/${maxBuilds}` : String(builds)}
            {...(maxBuilds !== undefined ? { pct: (builds / maxBuilds) * 100 } : {})}
            wait={builds > 0}
            title="build döngüsü / profildeki sınır"
          />
          <Meter
            k="süre"
            v={fmtElapsed(elapsed)}
            title={`başlangıç ${fmtTime(startedAt(job))}${done ? ` · bitiş ${fmtTime(job.updatedAt)}` : ""}`}
          />
        </div>

        {!done && (
          <button
            role="switch"
            aria-checked={job.autopilot}
            disabled={autopilot.isPending}
            title={autopilotTitle}
            onClick={() => autopilot.mutate(!job.autopilot)}
            className={`shrink-0 cursor-pointer rounded-[5px] border px-2 py-0.5 font-mono text-[11.5px] disabled:cursor-default disabled:opacity-60 ${
              job.autopilot
                ? devStep
                  ? "border-accent bg-accent-tint text-accent-ink"
                  : "border-accent-edge text-accent-ink"
                : "border-edge text-ink-muted hover:text-ink"
            }`}
          >
            otopilot {job.autopilot ? "açık" : "kapalı"}
          </button>
        )}

        <JobMenu items={menu} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[25px] font-mono text-[11px] text-ink-muted">
        {meta.map((m, i) => (
          <span key={i} className="flex min-w-0 items-center gap-3">
            {i > 0 && <span aria-hidden>·</span>}
            {m}
          </span>
        ))}
        <span className="flex-1" />
        {activeLive && <LiveEnvMenu status={activeLive.status} appUrl={activeLive.appUrl} />}
      </div>

      <div className="mt-[3px]">
        <Pipeline state={job.state} brokenAt={brokenAt(job)} />
      </div>
      <ErrorText error={cancel.error ?? stopLive.error ?? autopilot.error} />
    </div>

    {reopenOpen && <ReopenDialog job={job} onClose={() => setReopenOpen(false)} />}
    </>
  );
}

/** Mobil şerit: düğüm adları sığmaz, 11 ince çubuk ilerlemeyi söyler. */
function MiniPipeline({ state, brokenAt: broken }: { state: JobState; brokenAt: JobState | undefined }) {
  const at = PIPELINE.indexOf(state === "NeedsAttention" && broken ? broken : state);
  return (
    <div className="flex gap-0.5 px-4" title={state}>
      {PIPELINE.map((s, i) => (
        <span
          key={s}
          className={`h-[3px] flex-1 rounded-sm ${
            at < 0
              ? "bg-edge"
              : i < at
                ? "bg-meter"
                : i === at
                  ? state === "NeedsAttention"
                    ? "bg-err"
                    : "bg-ok"
                  : "bg-edge"
          }`}
        />
      ))}
    </div>
  );
}

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

/**
 * ⋯ menüsü: yıkıcı ve seyrek eylemler.
 *
 * Başlıkta tek bir birincil eylem kalsın diye (o da dikkat yuvasında) İptal
 * gibi eylemler burada. Yanlışlıkla basılan "İptal" işi siliyor.
 */
function JobMenu({ items, mobile = false }: { items: MenuItem[]; mobile?: boolean }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className={`relative shrink-0 ${mobile ? "-mr-2.5" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={items.length === 0}
        aria-label="Diğer eylemler"
        aria-expanded={open}
        className={
          mobile
            ? "flex h-11 w-11 items-center justify-center text-[18px] text-ink-muted disabled:opacity-40"
            : "flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge-strong bg-surface text-[15px] text-ink-muted hover:text-ink disabled:opacity-40"
        }
      >
        ⋯
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 flex min-w-[190px] flex-col rounded-[10px] border border-edge-strong bg-surface p-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={`rounded-md px-3 text-left font-medium hover:bg-raised disabled:opacity-40 ${
                mobile ? "min-h-11 text-[14.5px]" : "py-2 text-[13px]"
              } ${
                it.danger ? "text-err-ink" : "text-ink-body"
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "ortam ▾": ayaktaki canlı ortamın adresi. Yalnız ortam varken çizilir. */
function LiveEnvMenu({ status, appUrl }: { status: string; appUrl: string }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="font-sans text-[11.5px] text-ink-muted hover:text-ink"
      >
        ortam ▾
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 flex min-w-[240px] flex-col gap-1.5 rounded-[10px] border border-edge-strong bg-surface px-3 py-2.5 font-sans shadow-lg">
          <span className="font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase">canlı ortam · {status}</span>
          <a
            href={appUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-mono text-[12px] text-brand-ink underline underline-offset-2"
          >
            {appUrl} ↗
          </a>
        </div>
      )}
    </div>
  );
}

// ── Dikkat yuvası ────────────────────────────────────────────────────────────

/** Kapı türü hangi sekmeyi açmalı: karar için gereken ayrıntı oradadır. */
const GATE_TAB: Record<string, Tab> = {
  phase: "degisiklikler",
  plan: "plan",
  qa_cases: "qa",
  pr_open: "qa",
  pr_merge: "qa",
  security: "qa",
  review_round: "qa",
  live_test: "qa",
  blocked: "qa",
};

/**
 * Başlığın altındaki TEK kart. Öncelik: kapı › hata › koşuyor › taslak.
 *
 * Kapıdayken kararı veren kanıtın özeti (dosya, build, görülmeyen dosya) kartın
 * içinde; ayrıntı sekmede. Hata varken birincil eylem "Yeniden dene".
 */
function AttentionSlot({
  job,
  gate,
  plan,
  planQuestions,
  planAnswers,
  onTab,
  dock,
  onAsk,
  caseEdits,
  comments,
  critiqueNotes,
  seen,
  buildFail,
}: {
  job: JobWithTransitions;
  gate: Approval | null;
  plan: PlanView | undefined;
  planQuestions: number;
  /** Plan sekmesinde işaretlenen cevaplar; onay notuna yazılır. */
  planAnswers: PlanAnswers;
  onTab: (t: Tab) => void;
  /** Mobil alt çubuğun yeri (sayfanın en altı); yoksa çubuk çizilmez. */
  dock: HTMLElement | null;
  /** Alt çubuktaki "Agent'a sor". */
  onAsk: () => void;
  /** QA sekmesindeki düzenlemeler; onay gönderilirken buradan okunur. */
  caseEdits: QaCaseEdit[] | null;
  /** Değişiklikler sekmesindeki satır yorumları; red gerekçesine girer. */
  comments: LineComment[];
  /** Plan sekmesinde işaretlenen ikinci göz bulguları; red gerekçesine girer. */
  critiqueNotes: string[];
  /** Görüldü işaretli dosyalar. */
  seen: string[];
  /** Son build koşusunda kırılan adım; hata kartının başlığı onu söyler. */
  buildFail: StepView | undefined;
}) {
  const qc = useQueryClient();
  const live = useLive(job);
  const profile = useJobProfile(job.profileId);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  // Red paneli AÇIKKEN işaretlenen ikinci göz bulgusu da gerekçeye girer:
  // bulgular Plan sekmesinde işaretlendiği için panel açıkken seçim olağan.
  // Yalnız YENİ işaret eklenir; insanın sildiği satır geri gelmez.
  const prevNotes = useRef(critiqueNotes);
  useEffect(() => {
    const added = critiqueNotes.filter((n) => !prevNotes.current.includes(n));
    prevNotes.current = critiqueNotes;
    if (!rejecting || added.length === 0) return;
    setComment((c) => {
      const fresh = added.filter((n) => !c.includes(n));
      return fresh.length === 0 ? c : `${c.trimEnd()}${c.trim() ? "\n" : ""}${fresh.join("\n")}\n\n`;
    });
  }, [critiqueNotes, rejecting]);
  // Red gerekçesine eklenen ekran görüntüleri: agent onları `/resources`ten
  // Read ile açar. "Şu ekran bozuk"u yazıyla anlatmak eksik kalıyordu.
  const [images, setImages] = useState<UploadedFile[]>([]);
  // Canlı testte "kaldı" işaretli senaryolar red gerekçesi olarak Developer'a
  // gider; varsa yorum zorunlu değil. Senaryo kartıyla aynı sorgu (önbellek ortak).
  const scenarios = useQuery({
    queryKey: ["testScenarios", job.id],
    queryFn: () => api.testScenarios(job.id),
    enabled: gate?.kind === "live_test",
  });
  const failedScenarios =
    gate?.kind === "live_test" && scenarios.data?.latest?.status === "ready"
      ? Object.values(scenarios.data.latest.marks).filter((m) => m.state === "fail").length
      : 0;

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["job", job.id] });
    void qc.invalidateQueries({ queryKey: ["plan", job.id] });
  };
  const decide = useMutation({
    mutationFn: ({ decision, text }: { decision: "approve" | "reject"; text: string }) =>
      api.decide(gate?.id ?? "", {
        decision,
        comment: text,
        // QA case kapısında insanın listesi TAM OLARAK gider.
        ...(gate?.kind === "qa_cases" && decision === "approve" && caseEdits ? { edits: { cases: caseEdits } } : {}),
        ...(decision === "reject" && images.length > 0 ? { attachmentIds: images.map((i) => i.id) } : {}),
      }),
    onSuccess: (_r, { decision }) => {
      // Onayda gönderilmeyen görseller (red açıkken onaya basıldı) bırakılır.
      if (decision === "approve") discardUploads(images);
      setImages([]);
      setRejecting(false);
      setComment("");
      refresh();
    },
  });
  const cancelReject = (): void => {
    discardUploads(images);
    setImages([]);
    setRejecting(false);
    setComment("");
  };
  const start = useMutation({ mutationFn: () => api.startJob(job.id), onSuccess: refresh });
  // Dış engel (kimlik yok, Docker kapalı) giderildiğinde iş çöpe gitmesin.
  const retry = useMutation({ mutationFn: () => api.retryJob(job.id), onSuccess: refresh });
  const [retryOpen, setRetryOpen] = useState(false);
  // Ortam kalkarken alınan hata çoğu zaman kodun/yapılandırmanın kusurudur;
  // salt "yeniden kaldır" aynı hatayla döngüye girer. Hata mesajı sebep olarak
  // önceden yazılır, insan düzenleyip Developer'a gönderir.
  const [devOpen, setDevOpen] = useState(false);
  // Yeniden denemenin aşamadığı döngülerde (kırık CI, bozuk worktree) PR'ı
  // olduğu gibi merge kapısına taşır; kapı kırmızıları gösterir.
  const mergeGate = useMutation({
    mutationFn: () => api.openMergeGate(job.id),
    onSuccess: refresh,
    onError: (err) => alert(`Merge kapısı açılamadı: ${err instanceof Error ? err.message : String(err)}`),
  });
  // Yalnız CI adımında düşen işte: başka adımda düşmüş işin PR'ı yoktur ya da
  // eski/incelenmemiş bir ucu taşır; orada çıkış "Yeniden dene"dir.
  const canMerge = profile.data?.document.git.pr.mergeApproval === true && brokenAt(job) === "CIWatch";
  const askMerge = (): void => {
    if (confirm("İş yeniden denenmeden merge onay kapısına alınsın mı? Kırmızı check'ler kapıda listelenir; merge kapıyı onaylayınca yapılır.")) {
      mergeGate.mutate();
    }
  };
  const stopLive = useMutation({
    mutationFn: () => api.stopLive(job.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["live", job.id] }),
  });

  const phaseFiles = useMemo(
    () => (gate?.kind === "phase" ? parseDiff(phasePayload(gate).diff?.patch ?? "") : []),
    [gate],
  );
  // Plan sekmesindeki kartla aynı sorgu (önbellek ortak).
  const next = useNextPhase(job.id, gate);

  const questions = useMemo(() => (plan ? normalize(plan.document.openQuestions) : []), [plan]);
  const answeredCount = questions.filter((q) => (planAnswers[q.question] ?? "").trim().length > 0).length;
  // Onay notu: plan kapısında cevaplar + (varsa) operatörün notu. Cevaplar
  // Developer'a bu notla ulaşır; onay yeniden planlatmaz.
  const approveText = (): string =>
    gate?.kind === "plan" ? [answersNote(questions, planAnswers), comment.trim()].filter(Boolean).join("\n\n") : comment;
  // Şekli değiştiren soruda varsayımdan farklı cevap varsa onay yerine yeniden
  // planlatılır: not, varsayıma göre yazılmış safhaları düzeltmez.
  const reshaping = gate?.kind === "plan" ? reshapingAnswers(questions, planAnswers) : [];
  const replan = useMutation({
    mutationFn: () =>
      api.answerPlanQuestions(job.id, {
        answers: questions
          .map((q) => ({ question: q.question, answer: (planAnswers[q.question] ?? "").trim() }))
          .filter((x) => x.answer.length > 0),
        comment: comment.trim(),
      }),
    onSuccess: () => {
      setComment("");
      refresh();
    },
  });
  const primaryPending = decide.isPending || replan.isPending;
  const runPrimary = (): void => {
    if (reshaping.length > 0) replan.mutate();
    else decide.mutate({ decision: "approve", text: approveText() });
  };

  const running = job.phase === "running" || job.phase === "starting";
  const errorNote =
    job.errorMessage != null && job.errorMessage !== ""
      ? { text: `Önceki deneme ${job.errorCode ?? "hata"} ile bitti: ${job.errorMessage}`, tone: "err" as const }
      : null;

  let card: ReactNode = null;
  // Mobil alt çubuk (tasarım 2e): kartın eylemleri dar ekranda buraya iner.
  let dockBody: ReactNode = null;

  if (gate) {
    const label = GATE_LABELS[gate.kind] ?? { title: gate.kind, approve: "Onayla" };
    const rejectLabel = label.reject ?? "Reddet";
    // `review_round` / `security` reddi agent'a gitmez, akış sürer: yorum yalnız geçiş notu.
    const rejectNeedsComment = gate.kind !== "review_round" && gate.kind !== "security" && failedScenarios === 0;
    const rejectPlaceholder =
      failedScenarios > 0
        ? `${failedScenarios} "kaldı" senaryosu adımları ve notlarıyla Developer'a gider. Ek yorum (isteğe bağlı).`
        : rejectNeedsComment
          ? "Neyi düzeltmeli? Bu metin agent'a gider — red için zorunlu."
          : "Açık yorumlarla CI'a geçilir. Not (isteğe bağlı) — agent'a gitmez.";
    const rejectBlocked = decide.isPending || (rejectNeedsComment && !comment.trim());
    // Görsel yalnız reddin agent'a gittiği kapılarda: bu dördünde red bir not
    // ya da durdurmadır, görseli okuyacak kimse yok.
    const rejectTakesImages = !["review_round", "security", "pr_merge", "blocked"].includes(gate.kind);
    const totalPhases = plan?.phases.length ?? 0;
    let tag = `onay kapısı · ${gate.kind}`;
    let title = label.title;
    let approve = label.approve;
    const facts: Fact[] = [];

    if (gate.kind === "phase") {
      const p = phasePayload(gate);
      const toChanges = () => onTab("degisiklikler");
      if (p.order !== undefined) {
        tag = `onay kapısı · safha ${p.order}/${totalPhases || "?"}`;
        if (totalPhases > p.order) approve = `Onayla, safha ${dative(p.order + 1)} geç`;
      }
      if (p.title) title = `${p.title}: safha onayı`;
      if (phaseFiles.length > 0) {
        const added = phaseFiles.reduce((a, f) => a + f.added, 0);
        const removed = phaseFiles.reduce((a, f) => a + f.removed, 0);
        facts.push({ text: `${phaseFiles.length} dosya · +${added} −${removed}`, onClick: toChanges });
      }
      const steps = (p.build ?? []).filter((b) => !b.skipped);
      if (steps.length > 0) {
        const failed = steps.filter((b) => b.exitCode !== 0).length;
        facts.push(
          failed > 0
            ? { text: `build ✕ ${failed}/${steps.length}`, tone: "err" }
            : { text: `build ✓ ${steps.length}/${steps.length}`, tone: "ok" },
        );
      }
      const unseen = phaseFiles.filter((f) => !seen.includes(f.path)).length;
      if (unseen > 0) facts.push({ text: `${unseen} dosya görülmedi`, tone: "wait", onClick: toChanges });
      // Sıradaki safha ve koşacağı model: onay onu başlatıyor. Pahalı seviye
      // uyarı tonunda — kota tükenmeden fark edilsin; tıklayınca Plan
      // sekmesinde ayrıntı ve model seçici.
      const n = next.data;
      if (n) {
        facts.push({
          text: `sıradaki ${n.order + 1}: ${shortModel(n.model.model)} · model değiştir →`,
          title: n.title,
          ...(n.model.tier === "frontier" ? { tone: "wait" as const } : {}),
          onClick: () => onTab("plan"),
        });
      }
    } else if (gate.kind === "plan") {
      if (plan) tag = `onay kapısı · plan v${plan.version}`;
      if (totalPhases > 0) {
        title = `Plan onayı: ${totalPhases} safha`;
        facts.push({ text: `${totalPhases} safha`, onClick: () => onTab("plan") });
      }
      if (planQuestions > 0) {
        facts.push({
          text: `${planQuestions} soru · ${answeredCount} cevaplı`,
          tone: answeredCount < planQuestions ? "wait" : "ok",
          onClick: () => onTab("plan"),
        });
      }
      const mc = modelChoiceOf(gate);
      if (mc) facts.push({ text: `model önerisi ${mc.model}`, title: mc.rationale });
      if (reshaping.length > 0) {
        approve = "Planı güncelle";
        facts.push({
          text: `${reshaping.length} cevap planı değiştiriyor`,
          title: reshaping.map((q) => q.question).join("\n"),
          tone: "wait",
          onClick: () => onTab("plan"),
        });
      }
    } else {
      facts.push({ text: "ayrıntıyı gör →", onClick: () => onTab(GATE_TAB[gate.kind] ?? "akis") });
    }

    // Satır yorumları red gerekçesinin başına: agent neyin yanlış olduğunu
    // satır satır görsün, operatör de yollamadan önce okuyup düzeltebilsin.
    const openReject = (): void => {
      const seeded = [...comments.map((c) => `${c.path}:${c.line} — ${c.text}`), ...critiqueNotes];
      if (!rejecting && !comment.trim() && seeded.length > 0) {
        setComment(`${seeded.join("\n")}\n\n`);
      }
      setRejecting((v) => !v);
    };

    const open = planQuestions - answeredCount;
    const mobileLine =
      gate.kind === "plan"
        ? open > 0
          ? { text: `${open} soru cevap bekliyor. Cevapsız kalırsa varsayılan seçilir.`, tone: "wait" as const }
          : null
        : facts.length > 0
          ? { text: facts.map((f) => f.text).join(" · "), tone: "off" as const }
          : null;

    dockBody = (
      <>
        {rejecting ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={rejectPlaceholder}
              className="h-24 w-full rounded-xl border border-accent-edge bg-surface px-3 py-2 text-[16px] text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
            {rejectTakesImages && <AttachmentDrop attachments={images} onChange={setImages} imagesOnly />}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={cancelReject}
                className="h-[46px] flex-1 rounded-xl border border-edge-control bg-surface text-[14.5px] font-semibold text-ink-body"
              >
                Vazgeç
              </button>
              <button
                type="button"
                disabled={rejectBlocked}
                onClick={() => decide.mutate({ decision: "reject", text: comment })}
                className="h-[46px] flex-[2] rounded-xl bg-err text-[14.5px] font-semibold text-white disabled:opacity-40"
              >
                {label.reject ? `${label.reject} ve sürdür` : "Reddet ve geri gönder"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={decide.isPending}
              onClick={openReject}
              className="h-[46px] flex-1 rounded-xl border border-err-edge bg-surface text-[14.5px] font-semibold text-err-ink disabled:opacity-40"
            >
              {rejectLabel}…
            </button>
            <button
              type="button"
              disabled={primaryPending}
              onClick={runPrimary}
              className="h-[46px] flex-[2] truncate rounded-xl bg-brand px-3 text-[14.5px] font-semibold text-white disabled:opacity-40"
            >
              {approve}
            </button>
          </div>
        )}
        <button type="button" onClick={onAsk} className="h-6 text-center text-[12px] text-ink-dim">
          Agent'a sor · {gate.kind === "plan" ? "Plan" : "Akış"} bağlamıyla
        </button>
      </>
    );

    card = (
      <AttentionCard
        tone="gate"
        docked
        tag={tag}
        mobileTag={gate.kind === "plan" && plan ? `plan v${plan.version}` : tag.replace(/^onay kapısı · /, "")}
        mobileLine={mobileLine}
        age={`${fmtAge(gate.requestedAt)} bekliyor`}
        title={title}
        facts={facts}
        note={
          replan.error
            ? { text: `Plan güncellenemedi: ${replan.error instanceof Error ? replan.error.message : String(replan.error)}`, tone: "err" }
            : comments.length > 0
              ? { text: `${comments.length} satır yorumun var; reddedersen red gerekçesine eklenecek.`, tone: "run" }
              : errorNote
        }
        actions={
          <>
            <AttentionButton kind="danger" disabled={decide.isPending} onClick={openReject}>
              {rejectLabel}…
            </AttentionButton>
            <AttentionButton kind="primary" disabled={primaryPending} onClick={runPrimary}>
              {approve}
            </AttentionButton>
          </>
        }
      >
        {/* Red yorumu zorunlu: agent neyin yanlış olduğunu bilmeden aynı
            safhayı tekrar üretir. Onayda ve `review_round` reddinde isteğe bağlı. */}
        {rejecting && (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={rejectPlaceholder}
              className="h-24 w-full rounded-[10px] border border-accent-edge bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
            {rejectTakesImages && <AttachmentDrop attachments={images} onChange={setImages} imagesOnly />}
            <div className="flex items-center justify-end gap-2.5">
              <Button variant="ghost" size="md" onClick={cancelReject}>
                Vazgeç
              </Button>
              <Button
                variant="danger-solid"
                size="md"
                disabled={rejectBlocked}
                onClick={() => decide.mutate({ decision: "reject", text: comment })}
              >
                {label.reject ? `${label.reject} ve sürdür` : "Reddet ve geri gönder"}
              </Button>
            </div>
          </div>
        )}
      </AttentionCard>
    );
  } else if (job.state === "NeedsAttention" || (errorNote && !running)) {
    const broken = brokenAt(job);
    const facts: Fact[] = Object.entries(job.loopCounts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => {
        const max = loopMax(profile.data?.document, k);
        return { text: `${k} denemesi ${max !== undefined ? `${n}/${max}` : n}`, tone: "wait" as const };
      });
    // Build'de kırıldıysa başlık kırılan adımı söyler (tasarım: "Build kırıldı:
    // dotnet build · exit 1"); `build_loop` kodu tek başına hangi komutun
    // düştüğünü söylemiyordu.
    const buildBroke = buildFail !== undefined && (broken === "Building" || job.errorCode === "build_loop");
    if (broken === "Building" || buildBroke) {
      facts.push({ text: "build logu →", tone: "err", onClick: () => onTab("build") });
    }
    if (job.errorCode === "live_not_ready") {
      facts.push({ text: "ortam değişkenleri →", tone: "wait", onClick: () => onTab("qa") });
    }
    if (job.modelTier) {
      facts.push({
        text: `model: ${tierSummary(job.modelTier, profile.data?.document.agents.triage.ladder)}`,
        tone: "off",
        onClick: () => setRetryOpen(true),
      });
    }
    const builds = job.loopCounts.build ?? 0;
    const maxBuilds = loopMax(profile.data?.document, "build");
    const activeLive = live.data?.active ?? null;
    const killLive = (): void => {
      if (confirm("Canlı ortamın konteynerleri yıkılsın mı? İş durumu değişmez.")) stopLive.mutate();
    };

    if (activeLive || job.state === "NeedsAttention") {
      dockBody = (
        <div className="flex gap-2">
          {activeLive && (
            <button
              type="button"
              disabled={stopLive.isPending}
              onClick={killLive}
              className="h-[46px] flex-1 rounded-xl border border-err-edge bg-surface text-[14.5px] font-semibold text-err-ink disabled:opacity-40"
            >
              {stopLive.isPending ? "yıkılıyor…" : "Ortamı yık"}
            </button>
          )}
          {job.state === "NeedsAttention" && (
            <>
              <button
                type="button"
                disabled={retry.isPending}
                onClick={() => setRetryOpen(true)}
                className="h-[46px] flex-1 rounded-xl border border-edge-control bg-surface text-[14.5px] font-semibold text-ink-body disabled:opacity-40"
              >
                Model…
              </button>
              {canMerge && (
                <button
                  type="button"
                  disabled={mergeGate.isPending || retry.isPending}
                  onClick={askMerge}
                  className="h-[46px] flex-1 rounded-xl border border-edge-control bg-surface text-[14.5px] font-semibold text-ink-body disabled:opacity-40"
                >
                  {mergeGate.isPending ? "açılıyor…" : "Merge…"}
                </button>
              )}
              <button
                type="button"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
                className="h-[46px] flex-[2] rounded-xl bg-brand text-[14.5px] font-semibold text-white disabled:opacity-40"
              >
                {job.errorCode === "live_not_ready" ? "Ortamı yeniden kaldır" : "Yeniden dene"}
              </button>
            </>
          )}
        </div>
      );
    }

    card = (
      <AttentionCard
        tone="err"
        docked={dockBody !== null}
        mobileLine={facts.length > 0 ? { text: facts.map((f) => f.text).join(" · "), tone: "wait" } : null}
        tag={
          job.state === "NeedsAttention"
            ? `NeedsAttention${buildBroke ? " · build" : broken ? ` · ${broken}` : ""}`
            : "job.error"
        }
        age={`${fmtAge(job.updatedAt)} önce`}
        title={
          buildBroke
            ? `Build kırıldı: ${buildFail.stepName} · ${exitText(buildFail)}`
            : (job.errorCode ?? "İş durdu, kararını bekliyor")
        }
        body={
          job.errorMessage ? (
            <p className="aht-wrap max-h-[72px] overflow-auto font-mono text-[12px] leading-[1.65] text-err-body md:max-h-[120px]">
              {job.errorMessage}
            </p>
          ) : undefined
        }
        facts={facts}
        note={
          maxBuilds !== undefined && builds > 0 && builds === maxBuilds - 1
            ? { text: "Bir deneme daha kırılırsa iş durur ve senin kararını bekler.", tone: "wait" }
            : null
        }
        actions={
          <>
            {activeLive && (
              <AttentionButton
                kind="danger"
                disabled={stopLive.isPending}
                title={`Canlı ortam ayakta (${activeLive.status}) — ${activeLive.appUrl}`}
                onClick={killLive}
              >
                {stopLive.isPending ? "yıkılıyor…" : "Canlı ortamı yık"}
              </AttentionButton>
            )}
            {job.state === "NeedsAttention" && (
              <>
                {/* Aynı modelle yeniden denemek döngüde takılan işte çoğu zaman
                    aynı yerde durur; daha güçlü modeli seçmenin yolu. */}
                <AttentionButton kind="secondary" disabled={retry.isPending} onClick={() => setRetryOpen(true)}>
                  Modelle dene…
                </AttentionButton>
                {job.errorCode === "live_not_ready" && (
                  <AttentionButton
                    kind="secondary"
                    title="Ortam kalkarken hata aldıysa kodda ya da yapılandırmada olabilir: sebebi yazıp Developer'a gönder"
                    onClick={() => setDevOpen(true)}
                  >
                    Developer'a gönder…
                  </AttentionButton>
                )}
                {canMerge && (
                  <AttentionButton
                    kind="secondary"
                    disabled={mergeGate.isPending || retry.isPending}
                    title="Yeniden denemeden PR'ı merge onay kapısına al; kırmızı check'ler kapıda listelenir"
                    onClick={askMerge}
                  >
                    {mergeGate.isPending ? "açılıyor…" : "Merge…"}
                  </AttentionButton>
                )}
                <AttentionButton kind="primary" disabled={retry.isPending} onClick={() => retry.mutate()}>
                  {job.errorCode === "live_not_ready" ? "Canlı ortamı yeniden kaldır" : "Yeniden dene"}
                </AttentionButton>
              </>
            )}
          </>
        }
      />
    );
  } else if (running) {
    card = (
      <AttentionCard
        tone="run"
        pulse
        tag="koşuyor"
        title={`${runningLabel(job.state)}…`}
        facts={[{ text: "akışta canlı izle →", onClick: () => onTab("akis") }]}
        note={errorNote}
      />
    );
  } else if (job.state === "Draft") {
    dockBody = (
      <button
        type="button"
        disabled={start.isPending}
        onClick={() => start.mutate()}
        className="h-[46px] w-full rounded-xl bg-brand text-[14.5px] font-semibold text-white disabled:opacity-40"
      >
        Başlat
      </button>
    );
    card = (
      <AttentionCard
        tone="off"
        docked
        tag="taslak"
        title="İş henüz başlamadı"
        body={<span className="text-[12.5px] text-ink-soft">Başlatınca Planner planı yazmaya koyulur.</span>}
        actions={
          <AttentionButton kind="primary" disabled={start.isPending} onClick={() => start.mutate()}>
            Başlat
          </AttentionButton>
        }
      />
    );
  }

  if (!card) return null;
  const error = decide.error ?? start.error ?? retry.error ?? stopLive.error;
  return (
    <div className="shrink-0 px-4 pt-3 md:px-5.5">
      {card}
      <ErrorText error={error} />
      {retryOpen && <RetryDialog job={job} onClose={() => setRetryOpen(false)} />}
      {devOpen && (
        <ReopenDialog
          job={job}
          onClose={() => setDevOpen(false)}
          initial={{
            target: "Developing",
            comment: `Canlı ortam kalkmadı. Hata:\n${job.errorMessage ?? job.errorCode ?? ""}\n\nÖnce sebebi bul ve düzelt; uygulama konteyneri bu hatayla çöküyor.`,
          }}
        />
      )}
      {/* Alt çubuk sayfanın dibine taşınır (portal): başparmak oraya uzanır ve
          kart yukarıda plan okumasına yer bırakır. Yalnız mobilde görünür. */}
      {dock &&
        dockBody &&
        createPortal(
          <div className="flex flex-col gap-2 border-t border-edge bg-surface px-4 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))]">
            {dockBody}
            {error != null && <ErrorText error={error} />}
          </div>,
          dock,
        )}
    </div>
  );
}

// ── Sekmeler ─────────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string }[] = [
  { key: "detay", label: "İşin detayları" },
  { key: "akis", label: "Akış" },
  { key: "degisiklikler", label: "Değişiklikler" },
  { key: "plan", label: "Plan" },
  { key: "build", label: "Build logu" },
  { key: "qa", label: "QA" },
];

function TabBar({
  tab,
  onTab,
  counts,
  dots = {},
  fullscreen,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  counts: Record<Tab, string>;
  /** Sekme adının önündeki nokta: o sekmede bir şey bekliyor ya da canlı. */
  dots?: Partial<Record<Tab, { tone: Tone; pulse?: boolean }>>;
  fullscreen: { full: boolean; toggle: () => void };
}) {
  return (
    <div className="mt-0.5 flex shrink-0 items-end gap-1.5 border-b border-edge px-3 pt-2 md:px-5.5 md:pt-4">
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
      {TABS.map((t) => {
        const active = t.key === tab;
        return (
          <button
            key={t.key}
            onClick={() => onTab(t.key)}
            className={`flex shrink-0 items-center gap-[7px] border-b-2 px-3.5 pb-2.5 pt-2 text-[13px] transition-colors ${
              active ? "border-b-ok font-semibold text-[#0d3b31]" : "border-b-transparent font-medium text-ink-dim hover:text-ink"
            }`}
          >
            {dots[t.key] && <Dot tone={dots[t.key]!.tone} pulse={dots[t.key]!.pulse ?? false} />}
            {t.label}
            <span
              className={`rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] ${
                active ? "bg-brand-tint-soft text-brand-ink" : "bg-chip text-ink-muted"
              }`}
            >
              {counts[t.key]}
            </span>
          </button>
        );
      })}
      </div>
      <span className="shrink-0 pb-1.5">
        <FullscreenButton full={fullscreen.full} onClick={fullscreen.toggle} />
      </span>
    </div>
  );
}

/**
 * İş açılırken girilenler: başlık, konu, referanslar, dosyalar, görseller.
 *
 * Başka sekmeler agent'ın ÜRETTİĞİNİ gösteriyordu; operatör planı onaylarken
 * işin ne istediğini görmek için listeye dönmek zorundaydı.
 */
function DetailsTab({
  job,
  attachments,
  loading,
  error,
}: {
  job: Job;
  attachments: JobAttachment[] | undefined;
  loading: boolean;
  error: unknown;
}) {
  const { description, files } = useMemo(() => splitRelatedFiles(job.description), [job.description]);
  const external = job.externalRef || job.externalUrl
    ? `${job.source === "github_issue" ? "issue" : job.source} ${job.externalRef ?? ""}`.trim()
    : null;

  return (
    <div className="flex max-w-[980px] flex-col gap-3.5">
      <Card title="Başlık">
        <p className="aht-wrap text-[15px] font-semibold leading-snug text-ink">{job.title}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px] text-ink-muted">
          <span>kaynak {job.source}</span>
          {external && (job.externalUrl ? (
            <a
              href={job.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              {external} ↗
            </a>
          ) : (
            <span>{external}</span>
          ))}
          <span title={job.createdAt}>açıldı {fmtAge(job.createdAt)}</span>
          {job.branchName && <span>dal {job.branchName}</span>}
        </div>
      </Card>

      <Card title="Konu">
        {description.trim() ? (
          <div className="aht-wrap text-[13px] leading-relaxed text-ink-body">
            <Markdown baseUrl={job.externalUrl ?? undefined}>{description}</Markdown>
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-muted">Açıklama girilmemiş.</p>
        )}
      </Card>

      <Card title="Referans repo">
        <DetailList
          label="Hedef repolar"
          empty="Belirtilmemiş — Planner seçer."
          items={job.targetRepos}
        />
        <div className="mt-3">
          <DetailList
            label="Emsal yolları · salt okunur"
            empty="Emsal verilmemiş."
            items={job.referencePaths}
          />
        </div>
      </Card>

      <Card title="Dosyalar" right={<span className="font-mono text-[11px] text-ink-muted">ilk okunacaklar</span>}>
        <DetailList empty="İlgili dosya verilmemiş." items={files} />
      </Card>

      <Card title="Ekler" right={attachments && attachments.length > 0 ? <span className="font-mono text-[11px] text-ink-muted">{attachments.length}</span> : undefined}>
        {loading ? (
          <Skeleton heights={[120]} />
        ) : error ? (
          <ErrorText error={error} />
        ) : !attachments || attachments.length === 0 ? (
          <p className="text-[12.5px] text-ink-muted">Ek dosya yok.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {attachments.map((a) => (
              <a
                key={a.id}
                href={api.uploadFileUrl(a.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-edge bg-raised hover:border-edge-control"
                title={`${a.fileName} — tam boyut için tıkla`}
              >
                {a.mimeType.startsWith("image/") ? (
                  <img
                    src={api.uploadFileUrl(a.id)}
                    alt={a.fileName}
                    loading="lazy"
                    className="h-[130px] w-full bg-chip object-contain"
                  />
                ) : (
                  <span className="flex h-[130px] w-full items-center justify-center bg-chip font-mono text-[13px] uppercase text-ink-muted">
                    {a.fileName.split(".").pop()}
                  </span>
                )}
                <span className="truncate border-t border-edge px-2.5 py-1.5 text-[11.5px] text-ink-body">
                  {a.fileName}{" "}
                  <span className="font-mono text-[10.5px] text-ink-muted">· {Math.max(1, Math.round(a.sizeBytes / 1024))} KB</span>
                </span>
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function DetailList({ label, items, empty }: { label?: string; items: string[]; empty: string }) {
  return (
    <div>
      {label && <div className="mb-1.5 text-[11.5px] font-medium text-ink-dim">{label}</div>}
      {items.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((it) => (
            <li key={it} className="aht-wrap rounded-md bg-chip px-2.5 py-1.5 font-mono text-[12px] text-ink-body">
              {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StreamTab({ events, deltas, jobId }: { events: ServerEvent[]; deltas: Record<string, string>; jobId: string }) {
  // Build logu ayrı kanalda (`ws.ts`): bu diziye hiç girmiyor.
  // Akış agent'ın anlatısı olarak kalır.
  const [group, setGroup] = useState<StreamGroup | "all">("all");
  // Komut ve sonucu tek kutuda birleşir; eşleşen sonuç ayrı satır olmaz.
  const { rows, results } = useMemo(() => pairTools(events), [events]);
  const counts = useMemo(() => countByGroup(rows), [rows]);
  const visible = useMemo(
    () => (group === "all" ? rows : rows.filter((e) => groupOf(e) === group)),
    [rows, group],
  );
  // Özet GÖRÜNEN satırları anlatır, tümünü değil: filtre daraltıldığında
  // "9 olay" yazıp 2 satır göstermek operatöre yalan söyler.
  const summary = useMemo(() => summarize(visible), [visible]);
  const { ref, onScroll } = useAutoScroll([visible.length, deltas]);

  if (events.length === 0 && Object.keys(deltas).length === 0) {
    return (
      <EmptyState title="Akış boş">
        İş başladığında agent'ın her adımı burada görünür — düşünme, araç çağrısı, mesaj.
      </EmptyState>
    );
  }

  const streaming = Object.keys(deltas).length > 0;

  return (
    <div className="flex h-full flex-col gap-3">
      <StreamFilters active={group} counts={counts} onPick={setGroup} />
      {summary && <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">{summary}</span>}
      <div ref={ref} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col overflow-auto">
        {visible.length === 0 ? (
          <p className="py-6 text-center font-mono text-[12px] text-ink-muted">
            bu filtrede olay yok — başka bir grup seçin
          </p>
        ) : (
          visible.map((e, i) => {
            // Son satırda dikey bağlantı çizgisi çizilmez — akan token satırı
            // varsa çizgi ona kadar sürmeli, bu yüzden "son" ona göre belirlenir.
            const last = i === visible.length - 1 && !streaming;
            return e.type === "agent.question" ? (
              <StreamRow key={`${e.seq}-${e.type}`} e={e} last={last}>
                <QuestionBox e={e} jobId={jobId} />
              </StreamRow>
            ) : (
              <StreamRow
                key={`${e.seq}-${e.type}`}
                e={e}
                last={last}
                {...(e.type === "agent.tool_use" ? { result: results.get(e.toolId) } : {})}
              />
            );
          })
        )}
        {/* Akan token'lar filtreden bağımsız: "şu an yazıyor" her grupta görünür. */}
        {Object.entries(deltas).map(([runId, text]) => (
          <DeltaRow key={runId} text={text} />
        ))}
      </div>
    </div>
  );
}

/** Agent sorusu: seçenek düğmeleri ya da serbest cevap. Cevap gidene dek tur askıda. */
function QuestionBox({ e, jobId }: { e: Extract<ServerEvent, { type: "agent.question" }>; jobId: string }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const answer = useMutation({
    mutationFn: (a: string) => api.answer(jobId, { questionId: e.questionId, answer: a }),
    onSuccess: () => setSent(true),
  });

  if (sent) return <div className="font-mono text-[11px] text-brand-ink">cevap gönderildi</div>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {e.options.map((o) => (
        <Button key={o} variant="ghost" size="sm" disabled={answer.isPending} onClick={() => answer.mutate(o)}>
          {o}
        </Button>
      ))}
      <input
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && text.trim()) answer.mutate(text);
        }}
        placeholder="serbest cevap"
        className="h-[30px] w-56 rounded-lg border border-edge-control bg-surface px-2.5 text-[12px] text-ink focus:border-brand focus:outline-none"
      />
      <Button variant="neutral" size="sm" disabled={answer.isPending || !text.trim()} onClick={() => answer.mutate(text)}>
        Cevapla
      </Button>
      <ErrorText error={answer.error} />
    </div>
  );
}

function ChangesTab({
  gate,
  jobId,
  running,
  seen,
  onSeen,
  comments,
  onComments,
}: {
  gate: Approval | null;
  jobId: string;
  running: boolean;
  seen: string[];
  onSeen: (path: string, on: boolean) => void;
  comments: LineComment[];
  onComments: (next: LineComment[]) => void;
}) {
  const phaseGate = gate?.kind === "phase" ? gate : null;
  // Kapı varsa varsayılan ONAY ANININ diff'i: karar o yüke göre veriliyor,
  // altından değişen canlı ağaç değil. Canlı ağaç yine bir tık uzakta.
  const [source, setSource] = useState<"gate" | "live">("gate");
  // Canlı ağacın "görüldü"sü kapıya bağlı değil; yalnız bu oturumda yaşar.
  const [liveSeen, setLiveSeen] = useState<string[]>([]);

  const segment = phaseGate ? (
    <div className="flex rounded-[9px] border border-edge-strong bg-surface p-[3px]">
      {(
        [
          ["gate", `Onay anı · ${fmtClock(phaseGate.requestedAt).slice(0, 5)}`],
          ["live", "Canlı ağaç"],
        ] as const
      ).map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => setSource(k)}
          aria-pressed={source === k}
          className={`flex-1 rounded-md px-1.5 py-[5px] text-center text-[12px] ${
            source === k ? "bg-accent-tint font-semibold text-accent-ink" : "text-ink-soft hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  ) : null;

  if (phaseGate && source === "gate") {
    const p = phasePayload(phaseGate);
    const hasEvidence = p.handoff !== undefined || (p.build?.length ?? 0) > 0;
    return (
      <DiffView
        patch={p.diff?.patch ?? ""}
        untracked={p.diff?.untracked ?? []}
        truncated={p.diff?.truncated ?? false}
        seen={seen}
        onSeen={onSeen}
        comments={comments}
        onComments={onComments}
        header={segment}
        footer={hasEvidence ? <PhaseEvidence gate={phaseGate} /> : undefined}
      />
    );
  }
  return (
    <LiveDiff
      jobId={jobId}
      running={running}
      segment={segment}
      seen={liveSeen}
      onSeen={(path, on) => setLiveSeen((prev) => (on ? [...new Set([...prev, path])] : prev.filter((x) => x !== path)))}
    />
  );
}

/**
 * Developer yazarken worktree'nin o anki hâli.
 *
 * Eskiden bu sekme yalnız safha kapısında doluyordu; Developer koşarken
 * operatör dosyaları göremiyor, sadece araç çağrılarını okuyabiliyordu.
 * Satır yorumu yok: yorumun gideceği bir red kapısı canlı ağaçta yok.
 */
function LiveDiff({
  jobId,
  running,
  segment,
  seen,
  onSeen,
}: {
  jobId: string;
  running: boolean;
  segment: ReactNode;
  seen: string[];
  onSeen: (path: string, on: boolean) => void;
}) {
  const q = useQuery({
    queryKey: ["liveDiff", jobId],
    queryFn: () => api.liveDiff(jobId),
    // Koşarken tazele; dururken boşuna git çalıştırma.
    refetchInterval: running ? 8_000 : false,
  });

  // Boş/yükleniyor hâllerinde de kaynak seçimi görünür kalmalı: yoksa canlı
  // ağaca geçen operatör onay anına dönemez.
  const frame = (node: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {segment && <div className="shrink-0 border-b border-edge bg-pane px-3.5 py-3 lg:w-[300px]">{segment}</div>}
      <div className="min-h-0 flex-1 overflow-auto px-5.5 py-4.5">{node}</div>
    </div>
  );

  if (q.isLoading) return frame(<Skeleton heights={[36, 220]} />);
  if (q.isError) return frame(<ErrorText error={q.error} />);
  if (!q.data?.ready) {
    return frame(<EmptyState title="Çalışma ağacı yok">{q.data?.reason ?? "İş henüz başlamadı."}</EmptyState>);
  }

  const d = q.data.diff;
  const empty = !d || (!d.patch.trim() && d.untracked.length === 0);
  if (empty) {
    return frame(
      <EmptyState title="Henüz değişiklik yok">
        {running ? "Developer çalışıyor; dosyalar yazıldıkça burada görünür." : "Worktree temiz."}
      </EmptyState>,
    );
  }

  return (
    <DiffView
      patch={d.patch}
      untracked={d.untracked}
      truncated={d.truncated}
      seen={seen}
      onSeen={onSeen}
      header={
        <>
          {segment}
          <div className="flex flex-wrap items-center gap-2">
            <Tag className="bg-chip text-ink-muted">çalışma ağacı</Tag>
            {running && <span className="font-mono text-[10.5px] text-ink-muted">8 sn'de bir tazelenir</span>}
          </div>
        </>
      }
    />
  );
}

/** Hangi rolün koştuğunu duruma göre söyler. */
function runningLabel(state: string): string {
  switch (state) {
    case "Planning": return "Planner planı yazıyor";
    case "Developing": return "Developer kod yazıyor";
    case "Building": return "Derleniyor";
    case "QACases": case "QA": return "QA çalışıyor";
    case "CIWatch": return "CI izleniyor";
    case "LiveTest": return "Canlı ortam hazırlanıyor";
    default: return "Agent çalışıyor";
  }
}

/**
 * Olayın ISO damgasından yerel saat — `SS:dd:ss`.
 *
 * Sunucu UTC yazıyor; kullanıcı kendi saatini bekliyor. Tarih gösterilmez:
 * build logu tek oturumda okunuyor ve her satırda tarih tekrarlamak yeri
 * metinden çalardı.
 */
function clock(at: string | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("tr-TR", { hour12: false });
}

/** Saat, ms'den: log satırları ve adım başlangıcı için. */
function clockMs(ms: number | null): string {
  return ms === null ? "" : clock(new Date(ms).toISOString());
}

/** Build adımı filtresi — tasarımdaki "Tümü/Geçenler/Kırılanlar/Atlananlar" şeridi. */
type BuildFilter = "all" | StepStatus;

/**
 * Build sekmesi: BİTEN koşu adım adım, KOŞAN build canlı.
 *
 * `build.log` DB'ye yazılmıyor (hub `EPHEMERAL_TYPES` — olayların %93'ü oydu
 * ve replay penceresini dolduruyordu). Canlı satırlar WS'ten ayrı kanalda
 * gelir; biten adımın çıktısı `builds.logRef`in gösterdiği dosyadan okunur.
 *
 * Tasarımın sırası: kırık koşuda en üstte teşhis kartı (son hata satırları),
 * altında filtre şeridi ve zaman çizgisi. Geçen adımlar kapalı, kırılan adım
 * saatli satırlarıyla açık gelir: ilk bakılacak yer orası.
 */
function BuildTab({
  lines,
  jobId,
  job,
  runs,
  planned,
  loading,
  error,
  maxBuilds,
}: {
  lines: ServerEvent[];
  jobId: string;
  job: Job;
  runs: BuildRow[][];
  planned: { name: string; run: string }[];
  loading: boolean;
  error: unknown;
  maxBuilds: number | undefined;
}) {
  const { ref, onScroll } = useAutoScroll([lines.length]);
  // Varsayılan son koşu; operatör eski bir denemeye bakabilir.
  const [runPick, setRunPick] = useState<number | null>(null);
  const runIdx = runPick !== null && runPick < runs.length ? runPick : runs.length - 1;
  const latest = runIdx === runs.length - 1;
  const steps = useMemo(() => stepViews(runs[runIdx] ?? [], planned), [runs, runIdx, planned]);
  const [filter, setFilter] = useState<BuildFilter>("all");
  const [fullId, setFullId] = useState<string | null>(null);

  const failIdx = steps.findIndex((s) => s.status === "fail");
  const failed = steps[failIdx];
  const visible = filter === "all" ? steps : steps.filter((s) => s.status === filter);

  if (fullId !== null) {
    const s = steps.find((x) => x.id === fullId);
    return <FullStepLog jobId={jobId} id={fullId} step={s} onBack={() => setFullId(null)} />;
  }

  if (lines.length === 0 && runs.length === 0) {
    return loading ? (
      <div className="px-5.5 py-4.5">
        <Skeleton />
      </div>
    ) : error ? (
      <div className="px-5.5 py-4.5">
        <ErrorText error={error} />
      </div>
    ) : (
      <EmptyState title="Build logu boş">
        Build kapısı koştuğunda komutların çıktısı satır satır burada akar — her satır{" "}
        <span className="font-mono">scrubSecrets</span>'ten geçmiş hâliyle.
      </EmptyState>
    );
  }

  return (
    // `h-full min-h-0`: kaydırma bu sekmede İÇ kutuya ait. Dış kapsayıcı da
    // kaydırırsa iç kutu sınırsız uzar ve `useAutoScroll` kaydırmayan bir
    // elemana `scrollTo` çağırır (yaşandı).
    <div ref={ref} onScroll={onScroll} className="flex h-full min-h-0 flex-col gap-3.5 overflow-auto px-5.5 pt-4 pb-5">
      {failed && (
        <BuildDiagnosis
          key={failed.id ?? failed.stepName}
          jobId={jobId}
          step={failed}
          index={failIdx}
          total={steps.length}
          next={latest ? nextAfterFail(job, maxBuilds) : ""}
          onFull={failed.id !== null && failed.hasLog ? () => setFullId(failed.id) : undefined}
        />
      )}

      {steps.length > 0 && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <BuildFilterBar steps={steps} active={filter} onPick={setFilter} />
            <span className="flex-1" />
            {runs.length > 1 && <RunPicker idx={runIdx} total={runs.length} onPick={setRunPick} />}
            <span className="font-mono text-[11px] text-ink-muted">{buildHeadline(steps)}</span>
          </div>
          <div className="flex shrink-0 flex-col">
            {visible.length === 0 ? (
              <p className="py-4 text-center font-mono text-[12px] text-ink-muted">bu filtrede adım yok</p>
            ) : (
              visible.map((s, i) => (
                <BuildStepRow
                  // Koşu değişince satırlar yeniden bağlanır: açık/kapalı durumu
                  // başka koşunun adımına taşınmasın.
                  key={`${runIdx}:${s.id ?? s.stepName}`}
                  s={s}
                  jobId={jobId}
                  last={i === visible.length - 1}
                  defaultOpen={s === failed}
                  onFull={() => s.id !== null && setFullId(s.id)}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* Koşan build / canlı ortam akışı — biten koşunun altında, aynı desende:
          her aşama bir satır, çıktısı düğmenin ardında. */}
      {lines.length > 0 && <LiveSegments lines={lines} />}
      <p className="shrink-0 font-mono text-[11px] text-ink-muted">
        {lines.length > 0 && "koşan build · "}
        log satır satır scrubSecrets'ten geçti · yasak bayraklar profilde reddedilir
      </p>
    </div>
  );
}

/**
 * Kırmızı build'den sonra ne olacağı. Tasarımdaki "olası neden" alanının
 * karşılığı bizde yok (teşhis üreten bir agent yok); onun yerine motorun
 * gerçekten yapacağı şey yazılır.
 */
function nextAfterFail(job: Job, maxBuilds: number | undefined): string {
  const n = job.loopCounts.build ?? 0;
  const tries = maxBuilds !== undefined ? ` (deneme ${n}/${maxBuilds})` : "";
  if (job.state === "NeedsAttention") return `Deneme tavanı doldu${tries}; iş durdu ve senin kararını bekliyor.`;
  if (job.state === "Developing" || job.state === "Building") {
    return `Developer bu çıktıyla düzeltmeye gönderildi${tries}.`;
  }
  return "";
}

function exitText(s: StepView): string {
  return s.exitCode === null ? "zaman aşımı" : `exit ${s.exitCode}`;
}

const SECTION_LABEL = "font-mono text-[10.5px] uppercase tracking-[.06em] text-ink-muted";

/** Teşhis kartı: kırılan adım, son hata satırları ve sonraki adım. */
function BuildDiagnosis({
  jobId,
  step,
  index,
  total,
  next,
  onFull,
}: {
  jobId: string;
  step: StepView;
  index: number;
  total: number;
  next: string;
  onFull: (() => void) | undefined;
}) {
  const log = useStepLog(jobId, step.id !== null && step.hasLog ? step.id : null);
  const errs = useMemo(() => (log.data ? lastErrorLines(parseStepLog(log.data)) : []), [log.data]);
  const endMs = step.startMs !== null && step.durationMs !== null ? step.startMs + step.durationMs : null;
  const meta = [
    step.durationMs !== null ? fmtDuration(step.durationMs) : "",
    clockMs(endMs),
    `adım ${index + 1}/${total}`,
  ].filter(Boolean);

  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-err-edge bg-surface">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-err-edge bg-err-tint px-3.5 py-2.5">
        <span className="rounded-[5px] bg-err-edge/60 px-[7px] py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[.07em] text-err-text">
          teşhis
        </span>
        <span className="min-w-0 text-[13.5px] font-semibold text-ink">
          {step.stepName} · {exitText(step)}
        </span>
        <span className="font-mono text-[11px] text-err-body">{meta.join(" · ")}</span>
        <span className="flex-1" />
        {onFull && (
          <button onClick={onFull} className="text-[12px] font-semibold text-err-ink hover:underline">
            Tam logu aç ↗
          </button>
        )}
      </div>
      <div className="grid gap-[18px] px-3.5 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={SECTION_LABEL}>Son hata satırları</span>
          <div className="flex flex-col rounded-[9px] border border-edge bg-log px-[11px] py-[9px] font-mono text-[11.5px] leading-[1.65]">
            {log.isLoading ? (
              <span className="text-ink-muted">log okunuyor…</span>
            ) : log.isError ? (
              <ErrorText error={log.error} />
            ) : errs.length === 0 ? (
              <span className="text-ink-muted">bu adımın log dosyası yok</span>
            ) : (
              errs.map((e, i) => (
                <span key={i} className={`aht-wrap ${e.kind === "err" ? "text-log-err" : "text-off-ink"}`}>
                  {e.text}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={SECTION_LABEL}>Kırılan komut · sonraki adım</span>
          <span className="aht-wrap font-mono text-[11.5px] leading-[1.6] text-ink">$ {step.command}</span>
          {next && <span className="text-[13px] leading-[1.6] text-ink-body [text-wrap:pretty]">{next}</span>}
        </div>
      </div>
    </div>
  );
}

/** Adım log dosyası. Biten adımın logu değişmez: bir kez okunur. */
function useStepLog(jobId: string, id: string | null) {
  return useQuery({
    queryKey: ["buildLog", jobId, id],
    queryFn: () => api.buildLog(jobId, id ?? ""),
    enabled: id !== null,
    staleTime: Infinity,
  });
}

/** Birden çok koşu varsa: ‹ deneme 2/3 ›. */
function RunPicker({ idx, total, onPick }: { idx: number; total: number; onPick: (i: number) => void }) {
  const btn = "px-1.5 text-ink-muted hover:text-ink disabled:cursor-default disabled:opacity-30";
  return (
    <span className="flex items-center rounded-lg border border-edge-strong bg-surface py-[3px] font-mono text-[11px] text-ink-body">
      <button className={btn} disabled={idx === 0} onClick={() => onPick(idx - 1)} aria-label="Önceki deneme">
        ‹
      </button>
      deneme {idx + 1}/{total}
      <button className={btn} disabled={idx === total - 1} onClick={() => onPick(idx + 1)} aria-label="Sonraki deneme">
        ›
      </button>
    </span>
  );
}

/** Bir adımın TAM logu ayrı görünümde — zaman çizgisindeki kutu kuyruğu gösterir. */
function FullStepLog({
  jobId,
  id,
  step,
  onBack,
}: {
  jobId: string;
  id: string;
  step: StepView | undefined;
  onBack: () => void;
}) {
  const log = useStepLog(jobId, id);
  const entries = useMemo(() => (log.data ? parseStepLog(log.data) : []), [log.data]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-5.5 py-4.5">
      <div className="flex shrink-0 items-center gap-2.5">
        <button
          onClick={onBack}
          className="rounded-lg border border-edge-strong bg-surface px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink"
        >
          ← adımlara dön
        </button>
        {/* Adım adı profilden geliyor ve uzun olabiliyor; tamamı tooltip'te. */}
        <Clamp lines={1} text={step?.stepName ?? ""} className="min-w-0 flex-1 text-[13.5px] font-semibold text-ink" />
        {step?.durationMs != null && (
          <span className="shrink-0 font-mono text-[11px] text-ink-muted">{fmtDuration(step.durationMs)}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-[10px] border border-edge bg-log px-3 py-[9px]">
        {log.isLoading ? <Skeleton /> : log.isError ? <ErrorText error={log.error} /> : <LogLines entries={entries} />}
      </div>
    </div>
  );
}

const LOG_INK: Record<LogKind, string> = {
  cmd: "font-semibold text-ink",
  out: "text-off-ink",
  err: "text-log-err",
  end: "text-ink-muted",
};

function LogLines({ entries }: { entries: LogEntry[] }) {
  return (
    <div className="flex flex-col gap-px">
      {entries.map((e, i) => (
        <div key={i} className="flex gap-3 font-mono text-[11px] leading-[1.65]">
          {/* Saat, geçen süre değil: sunucu logu ya da konteyner kaydıyla eşleşsin. */}
          <span className="w-[58px] shrink-0 tabular-nums text-ink-faint">{clockMs(e.atMs)}</span>
          <span className={`aht-wrap min-w-0 ${LOG_INK[e.kind]}`}>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

type LogLine = Extract<ServerEvent, { type: "build.log" }>;
type SegStatus = "ok" | "fail" | "skip" | "warn" | "info" | "running";
interface LogSegment {
  head: LogLine | null;
  body: LogLine[];
  /** `▶ X` bir `■ X` ile kapandıysa kapanış satırı — sonucu o söyler. */
  end: LogLine | null;
  status: SegStatus;
}

/**
 * Sunucu her aşamanın başını işaretli bir satırla basıyor (`build/gate.ts`,
 * `live/environment.ts`, `build/tests.ts`): ▶ başladı, ■ bitti/kilometre
 * taşı, ▷ atlandı, ✖ düştü, ⚠ uyarı, `── başlık ──` teşhis dökümü. Akış bu
 * işaretlerden bölünür; ara satırlar önceki aşamanın çıktısıdır.
 */
const SEGMENT_MARK = /^(▶|■|▷|✖|⚠|──)\s/;

/** `▶ npm: ./build.sh npm` ile `■ npm: çıkış 0` aynı adım — adı ilk `:`e kadar. */
function markName(line: string): string {
  const rest = line.replace(SEGMENT_MARK, "");
  const i = rest.indexOf(":");
  return i < 0 ? "" : rest.slice(0, i).trim();
}

function segmentLog(lines: ServerEvent[]): LogSegment[] {
  const segs: LogSegment[] = [];
  for (const e of lines) {
    if (e.type !== "build.log") continue;
    const m = SEGMENT_MARK.exec(e.line);
    const cur = segs[segs.length - 1];
    if (!m) {
      if (cur && !cur.end) cur.body.push(e);
      else segs.push({ head: null, body: [e], end: null, status: "info" });
      continue;
    }
    const mark = m[1];
    if (mark === "■" && cur?.head?.line.startsWith("▶") && !cur.end) {
      const name = markName(cur.head.line);
      if (name && name === markName(e.line)) {
        cur.end = e;
        continue;
      }
    }
    segs.push({ head: e, body: [], end: null, status: "info" });
  }
  segs.forEach((s, i) => {
    const mark = s.head ? SEGMENT_MARK.exec(s.head.line)?.[1] : undefined;
    const last = i === segs.length - 1;
    if (mark === "✖") s.status = "fail";
    else if (mark === "▷") s.status = "skip";
    else if (mark === "⚠") s.status = "warn";
    else if (mark === "──" || !mark) s.status = "info";
    else if (s.end) s.status = s.end.stream === "stderr" ? "fail" : "ok";
    // Açık kalan son aşama hâlâ koşuyor. `■ … bekleniyor` da bir bekleyiş:
    // healthcheck satırları onun altına akıyor.
    else if (last && (mark === "▶" || s.head!.line.includes("bekleniyor"))) s.status = "running";
    else s.status = "ok";
  });
  return segs;
}

function LiveSegments({ lines }: { lines: ServerEvent[] }) {
  const segs = useMemo(() => segmentLog(lines), [lines]);
  return (
    <div className="flex shrink-0 flex-col">
      {segs.map((s, i) => (
        // İndeks anahtar: `build.log` ephemeral, `seq` hep 0; bölütler yalnız
        // sona eklenir, yani indeks kararlı.
        <LiveSegmentRow key={i} seg={s} last={i === segs.length - 1} />
      ))}
    </div>
  );
}

function LiveSegmentRow({ seg, last }: { seg: LogSegment; last: boolean }) {
  // Düşen aşamanın çıktısı açık gelir: ilk bakılacak yer orası.
  const [open, setOpen] = useState(seg.status === "fail");
  const st = SEG_STYLE[seg.status];
  const title = seg.head ? seg.head.line.replace(SEGMENT_MARK, "").replace(/\s*──$/, "") : "çıktı";
  const out = seg.end ? [...seg.body, seg.end] : seg.body;
  const at = seg.head?.at ?? seg.body[0]?.at;

  return (
    <div className={`flex gap-[13px] ${last ? "" : "pb-5"}`}>
      <div className="flex w-[9px] shrink-0 flex-col items-center">
        <span
          className={`mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full ${seg.status === "running" ? "animate-pulse" : ""}`}
          style={{ background: st.dot, boxShadow: `0 0 0 3px ${st.dot}22` }}
        />
        {!last && <span className="w-px flex-1 bg-[#dfe6e2]" />}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`rounded-[5px] px-[7px] py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[.07em] ${st.badge}`}>
            {st.label}
          </span>
          <Clamp lines={2} text={title} className="min-w-0 flex-1 text-[13.5px] font-semibold text-ink" />
          <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">{clock(at)}</span>
        </div>

        {out.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="w-fit rounded-[5px] border border-edge bg-surface px-[7px] py-0.5 font-mono text-[10.5px] text-ink-muted hover:text-ink"
          >
            {open ? "çıktıyı gizle" : `çıktıyı göster · ${out.length} satır`}
          </button>
        )}

        {open && out.length > 0 && (
          <div className="flex max-h-[360px] flex-col gap-1 overflow-auto rounded-xl border border-edge bg-log px-4 py-3.5">
            {out.map((e, i) => (
              <div
                key={i}
                className={`aht-wrap flex gap-2 font-mono text-[11px] leading-[1.6] ${
                  e.stream === "stderr" ? "text-[#bb3527]" : "text-off-ink"
                }`}
              >
                {/* Saat, geçen süre değil: sunucu logu ya da konteyner kaydıyla
                    eşleştirilebiliyor. `at` her olayda var (hub doldurur). */}
                <span className="shrink-0 tabular-nums text-ink-muted">{clock(e.at)}</span>
                <span className="min-w-0">{e.line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Filtre çipleri — tasarımdaki gibi her çipte sayaç. */
function BuildFilterBar({
  steps,
  active,
  onPick,
}: {
  steps: StepView[];
  active: BuildFilter;
  onPick: (f: BuildFilter) => void;
}) {
  const counts: Record<BuildFilter, number> = { all: steps.length, ok: 0, fail: 0, skip: 0 };
  for (const s of steps) counts[s.status]++;
  const defs: [BuildFilter, string][] = [
    ["all", "Tümü"],
    ["ok", "Geçenler"],
    ["fail", "Kırılanlar"],
    ["skip", "Atlananlar"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {defs.map(([k, label]) => {
        const on = active === k;
        return (
          <button
            key={k}
            onClick={() => onPick(k)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-[5px] text-[12px] transition-colors ${
              on
                ? "border-brand-edge bg-brand-tint font-semibold text-brand-ink"
                : "border-edge-strong bg-surface font-medium text-ink-muted hover:text-ink"
            }`}
          >
            {label}
            <span className="rounded-[4px] bg-chip px-[5px] py-px font-mono text-[10px] text-ink-muted">{counts[k]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Şerit özeti — tasarımdaki "6 adım · 1 kırıldı, 3 geçti, 2 atlandı · toplam 41.4s". */
function buildHeadline(steps: StepView[]): string {
  const n = (st: StepStatus) => steps.filter((s) => s.status === st).length;
  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const bits = [
    n("fail") > 0 ? `${n("fail")} kırıldı` : "",
    n("ok") > 0 ? `${n("ok")} geçti` : "",
    n("skip") > 0 ? `${n("skip")} atlandı` : "",
  ].filter(Boolean);
  return [`${steps.length} adım`, ...(bits.length > 0 ? [bits.join(", ")] : []), `toplam ${fmtDuration(totalMs)}`].join(" · ");
}

const BUILD_STATUS_STYLE: Record<"ok" | "fail" | "skip", { dot: string; label: string; badge: string }> = {
  ok: { dot: "#0b7c63", label: "geçti", badge: "bg-brand-tint-soft text-brand-ink" },
  fail: { dot: "#a3241a", label: "kırıldı", badge: "bg-err-edge/45 text-err-text" },
  skip: { dot: "#b3bfba", label: "atlandı", badge: "bg-chip text-off-ink" },
};

// `BUILD_STATUS_STYLE`ten SONRA: modül yüklenirken yayılıyor.
const SEG_STYLE: Record<SegStatus, { dot: string; label: string; badge: string }> = {
  ...BUILD_STATUS_STYLE,
  warn: { dot: "#b7791f", label: "uyarı", badge: "bg-[#fbf1dc] text-[#8a5a12]" },
  info: { dot: "#8fa39a", label: "çıktı", badge: "bg-chip text-off-ink" },
  running: { dot: "#0b7c63", label: "sürüyor", badge: "bg-brand-tint text-brand-ink" },
};

const STEP_STYLE: Record<StepStatus, { dot: string; badge: string; label: string }> = {
  ok: { dot: "bg-brand ring-brand/13", badge: "bg-brand-tint-soft text-brand-ink", label: "geçti" },
  fail: { dot: "bg-err-ink ring-err-ink/13", badge: "bg-err-edge/55 text-err-text", label: "kırıldı" },
  skip: { dot: "bg-skip ring-skip/20", badge: "bg-chip text-off-ink", label: "atlandı" },
};

/** Kutuda gösterilen kuyruk: binlerce satırlık `npm ci` çıktısı sekmeyi kilitlemesin. */
const LOG_TAIL = 400;

/** Tek build adımı: nokta+ray, rozet, ad, komut, süre, başlangıç saati, aç/kapa. */
function BuildStepRow({
  s,
  jobId,
  last,
  defaultOpen,
  onFull,
}: {
  s: StepView;
  jobId: string;
  last: boolean;
  defaultOpen: boolean;
  onFull: () => void;
}) {
  const canOpen = s.id !== null && s.hasLog;
  const [open, setOpen] = useState(defaultOpen && canOpen);
  const st = STEP_STYLE[s.status];

  return (
    <div className="flex gap-[13px]">
      <div className="flex w-[9px] shrink-0 flex-col items-center">
        <span className={`mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full ring-3 ${st.dot}`} />
        {!last && <span className="w-px flex-1 bg-rail-line" />}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-3">
        <div className="flex items-center gap-2.5">
          <span className={`shrink-0 rounded-[5px] px-[7px] py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[.07em] ${st.badge}`}>
            {st.label}
          </span>
          <span className="max-w-[45%] shrink-0 truncate text-[13.5px] font-semibold text-ink" title={s.stepName}>
            {s.stepName}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted" title={s.command}>
            {s.command}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-ink-muted">
            {s.durationMs !== null ? fmtDuration(s.durationMs) : "—"}
          </span>
          <span className="hidden w-[58px] shrink-0 text-right font-mono text-[11px] text-ink-faint sm:inline">
            {clockMs(s.startMs) || "—"}
          </span>
          <span className="w-[70px] shrink-0 text-right">
            {canOpen && (
              <button onClick={() => setOpen((v) => !v)} className="text-[11.5px] font-semibold text-brand-ink hover:underline">
                {open ? "daralt ▴" : "çıktı ▾"}
              </button>
            )}
          </span>
        </div>

        {s.note && <span className="text-[12px] text-ink-dim">{s.note}</span>}

        {open && s.id !== null && <StepLogBox jobId={jobId} id={s.id} onFull={onFull} />}
      </div>
    </div>
  );
}

function StepLogBox({ jobId, id, onFull }: { jobId: string; id: string; onFull: () => void }) {
  const log = useStepLog(jobId, id);
  const entries = useMemo(() => (log.data ? parseStepLog(log.data) : []), [log.data]);
  const hidden = Math.max(0, entries.length - LOG_TAIL);
  return (
    <div className="flex max-h-[420px] flex-col overflow-auto rounded-[10px] border border-edge bg-log px-3 py-[9px]">
      {log.isLoading ? (
        <Skeleton />
      ) : log.isError ? (
        <ErrorText error={log.error} />
      ) : (
        <>
          {hidden > 0 && (
            <button onClick={onFull} className="mb-1 w-fit font-mono text-[11px] text-ink-muted underline hover:text-ink">
              ilk {hidden} satır gizli · tam logu aç ↗
            </button>
          )}
          <LogLines entries={hidden > 0 ? entries.slice(-LOG_TAIL) : entries} />
        </>
      )}
    </div>
  );
}

function QaTab({
  gate,
  job,
  jobId,
  cases,
  caseEdits,
  onCaseEdits,
  onRejectNotes,
}: {
  gate: Approval | null;
  job: Job;
  jobId: string;
  /** Kalıcı liste (`qa_cases` tablosu) — kapı kapandıktan sonra da durur. */
  cases: QaCaseRow[];
  caseEdits: QaCaseEdit[] | null;
  onCaseEdits: (cases: QaCaseEdit[]) => void;
  /** Tezgâhtan red gerekçesine giden satırlar (ör. kimliksiz elemanlar). */
  onRejectNotes: (lines: string[]) => void;
}) {
  const qc = useQueryClient();
  // Tezgâh ve senaryo kartıyla aynı anahtar: önbellek ortak.
  const scenarios = useQuery({ queryKey: ["testScenarios", jobId], queryFn: () => api.testScenarios(jobId) });
  const hasScenarios = !!scenarios.data?.latest;
  // `retry` değil: o Developing'den geçip build'i yeniden koşturur. Ortamı
  // doğrudan kaldıran yol LiveTest'e yeniden açmak.
  const retryLive = useMutation({
    mutationFn: () => api.reopenJob(jobId, { target: "LiveTest", comment: "işe özel ortam değişkenleriyle yeniden kaldırılıyor" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["job", jobId] });
      void qc.invalidateQueries({ queryKey: ["plan", jobId] });
    },
  });
  const relaunch = useMutation({
    mutationFn: () => api.relaunchLive(jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["job", jobId] });
      void qc.invalidateQueries({ queryKey: ["plan", jobId] });
    },
  });

  // Kapı AÇIK: düzenlenebilir liste burada. Onay düğmesi yukarıdaki banner'da
  // kalır (karar oraya ait); düzenleme durumu üst bileşende tutulduğu için
  // ikisi aynı veriyi görür.
  if (gate?.kind === "qa_cases") {
    return <QaCasesPanel gate={gate} value={caseEdits} onChange={onCaseEdits} />;
  }

  // Canlı ortam hazır olmadı: değişken eksik/yanlışsa insan burada düzeltip
  // yeniden dener — profili değiştirmeden.
  if (!gate && job.state === "NeedsAttention" && job.errorCode === "live_not_ready")
    return (
      <LiveEnvCard
        job={job}
        hint="Canlı ortam hazır olmadı. Eksik ya da yanlış bir değişken sebepse burada düzeltip yeniden dene; değerler profilin ve orkestratörün değerlerini yalnız bu iş için ezer."
        onApply={{ label: "Canlı ortamı yeniden kaldır", run: () => retryLive.mutate() }}
        applying={retryLive.isPending}
      />
    );
  // Güvenlik kapısı: karar metni üstte, bulgular tezgâhın Güvenlik görünümünde.
  if (gate?.kind === "security")
    return (
      <div className="flex flex-col gap-4">
        <SecurityPanel gate={gate} />
        <QaWorkbench jobId={jobId} gate={gate} cases={cases} />
      </div>
    );
  if (gate?.kind === "live_test")
    return (
      <div className="flex flex-col gap-4">
        <LiveTestPanel
          gate={gate}
          onExtend={(m) => void api.extendLive(jobId, m).then(() => qc.invalidateQueries({ queryKey: ["plan", jobId] }))}
          onRelaunch={() => relaunch.mutate()}
          relaunching={relaunch.isPending}
        />
        {/* Tasarım 4a–4c: senaryolar, DAST + SAST ve case'ler tek tezgâhta. */}
        <QaWorkbench jobId={jobId} gate={gate} cases={cases} onRejectNotes={onRejectNotes} />
        {/* İnsan porttan test ederken "neyi denemeliyim" burada cevaplanır;
            liste tezgâhta, kart yalnız yeniden çıkarma ve ikinci göz için. */}
        <TestScenariosCard jobId={jobId} canGenerate={!relaunch.isPending} canMark listless />
        <LiveEnvCard
          job={job}
          hint="Profildeki değerleri ve orkestratörün ürettiklerini (DB bağlantısı dahil) yalnız bu iş için ezer. Koşan ortama geçmez; yeniden kaldırınca uygulanır. Değerde $jobId gibi yer tutucular çözülür."
          onApply={{
            label: "Yeniden kaldır",
            run: () => {
              if (confirm("Canlı ortam yıkılıp yeni değişkenlerle yeniden kaldırılsın mı? Build zinciri baştan koşar.")) relaunch.mutate();
            },
          }}
          applying={relaunch.isPending}
        />
      </div>
    );

  // Kapı KAPANDI ama case'ler/senaryolar duruyor: onaylanan liste görünür
  // kalmalı. Eskiden burada "QA aşamasına gelinmedi" yazıyordu — QA o sırada
  // tam da bu case'lerle test yazıyorken (yaşandı 2026-09-17). Diğer kapılarda
  // (PR, birleştirme, inceleme turu) iz panelin altında durur.
  const trail = cases.length > 0 || hasScenarios;
  const workbench = trail ? <QaWorkbench jobId={jobId} gate={gate} cases={cases} /> : null;
  if (gate?.kind === "blocked") return <div className="flex flex-col gap-4"><BlockedPanel gate={gate} />{workbench}</div>;
  if (gate?.kind === "pr_open") return <div className="flex flex-col gap-4"><PrPanel gate={gate} />{workbench}</div>;
  if (gate?.kind === "pr_merge") return <div className="flex flex-col gap-4"><MergePanel gate={gate} />{workbench}</div>;
  if (gate?.kind === "review_round")
    return (
      <div className="flex flex-col gap-4">
        <ReviewRoundPanel gate={gate} />
        <JobModelCard
          job={job}
          hint="Önceki turlar bu yorumları çözemediyse daha güçlü bir seviye seç, sonra onayla. Seçim iş boyunca geçerli."
        />
        {workbench}
      </div>
    );
  if (workbench) return workbench;

  return (
    <EmptyState title="QA aşamasına gelinmedi">
      Son safha onaylandıktan sonra QA case listesi çıkarır, testleri yazar ve baseline'lı tek koşuyla doğrular.
    </EmptyState>
  );
}

// ── Sohbet çubuğu ────────────────────────────────────────────────────────────

/**
 * Sohbet: "kes" işaretliyse tur kesilir ve mesaj hemen işlenir, değilse agent
 * onu tur sınırında görür. Gönderilen mesaj iyimser olarak baloncuk gösterir —
 * sunucu kabul etmezse hata görünür.
 */
function Composer({
  jobId,
  state,
  connected,
  context,
  onClose,
}: {
  jobId: string;
  state: Job["state"];
  /** WS durumu: mesaj gitmeden önce bağlantının koptuğu görünmeli. */
  connected: boolean;
  /**
   * Bağlam çipi (Plan sekmesi): mesajın başına neyin sorulduğu eklenir.
   * Verildiyse tasarımın tek satırlık çubuğu çizilir.
   */
  context?: PlanAskContext | null;
  /** Mobilde çubuğu kapatır. */
  onClose?: () => void;
}) {
  const [text, setText] = useState("");
  const [interrupt, setInterrupt] = useState(false);
  // Çip "×" ile düşürülür; bağlam değişince (başka soru) geri gelir.
  const [dropped, setDropped] = useState<string | null>(null);

  const chat = useMutation({
    mutationFn: (v: { text: string; interrupt: boolean }) => api.chat(jobId, v),
    onSuccess: () => setText(""),
  });

  const closed = state === "Done" || state === "Cancelled";
  if (closed) return null;

  if (context !== undefined) {
    const ctx = context && dropped !== context.prefix ? context : null;
    return (
      <form
        className="flex shrink-0 flex-col gap-1.5 border-t border-edge bg-raised px-4 py-2.5 md:px-5.5"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (t) chat.mutate({ text: ctx ? `${ctx.prefix}\n${t}` : t, interrupt: false });
        }}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-[38px] min-w-0 flex-1 items-center gap-[9px] rounded-[10px] border border-edge-control bg-surface px-1.5 focus-within:border-brand">
            {ctx && (
              <button
                type="button"
                onClick={() => setDropped(ctx.prefix)}
                title="Bağlamı çıkar"
                className="shrink-0 rounded-md bg-accent-tint px-2 py-[3px] font-mono text-[10.5px] text-accent-ink"
              >
                {ctx.label} ×
              </button>
            )}
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={ctx?.hint ?? "Agent'a yaz…"}
              className="h-full min-w-0 flex-1 bg-transparent px-1 text-[16px] text-ink placeholder:text-ink-dim focus:outline-none md:text-[13px]"
            />
          </span>
          <Button type="submit" variant="primary" size="lg" disabled={chat.isPending || !text.trim()}>
            Gönder
          </Button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Sohbeti kapat"
              className="-mr-2 flex h-11 w-9 shrink-0 items-center justify-center text-[16px] text-ink-muted md:hidden"
            >
              ×
            </button>
          )}
        </div>
        {!connected && <span className="font-mono text-[11px] text-err-ink">bağlantı yok</span>}
        <ErrorText error={chat.error} />
      </form>
    );
  }

  return (
    <div className="shrink-0 border-t border-edge bg-raised px-5.5 pb-3.5 pt-3">
      {/* Bağlantı göstergesi sağ sütun kalkınca kayboldu; sohbetin başına
          taşındı — mesaj gitmeden önce WS'in kopuk olduğu görünmeli. */}
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[12.5px] font-semibold text-ink">Sohbet</h2>
        <Dot tone={connected ? "ok" : "err"} pulse={connected} />
        <span className="font-mono text-[11px] text-ink-muted">{connected ? "canlı" : "bağlantı yok"}</span>
      </div>
      <form
        className="flex items-center gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) chat.mutate({ text: text.trim(), interrupt });
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Agent koşarken yön ver…"
          className="h-10 flex-1 rounded-[10px] border border-edge-control bg-surface px-3 text-[13.5px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none"
        />
        <label className="flex shrink-0 cursor-pointer items-center gap-[7px]" title="Mevcut turu kes, mesajı hemen işlet">
          <input
            type="checkbox"
            checked={interrupt}
            onChange={(e) => setInterrupt(e.target.checked)}
            className="h-[15px] w-[15px] accent-[var(--color-accent)]"
          />
          <span className="text-[12px] text-ink-soft">kes</span>
        </label>
        <Button type="submit" variant="primary" size="lg" disabled={chat.isPending || !text.trim()}>
          Gönder
        </Button>
      </form>
      <ErrorText error={chat.error} />
    </div>
  );
}
