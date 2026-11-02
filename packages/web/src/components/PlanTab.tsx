import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ModelChoiceSchema, PlanGatePayloadSchema } from "@ahtapot/shared";
import type { ModelChoice, ProjectProfile } from "@ahtapot/shared";

import { api, type Approval, type PlanPhaseRow, type PlanView } from "../api";
import { Dot, EmptyState, ErrorText, Skeleton, fmtClock } from "../ui";
import { TIER_TR, TierPicker, type PhaseModelRow } from "./GatePanels";
import { NextPhaseCard, shortModel } from "./NextPhase";
import { TestScenariosCard } from "./TestScenarios";
import { CritiqueCard } from "./CritiqueCard";
import { normalize, splitOption, type Question } from "./questions";

/**
 * Plan sekmesi — tasarım Tur 2, ekran 2b (masaüstü) ve 2e (mobil).
 *
 * Masaüstünde iki sütun: solda sürümler, açık soru özeti ve safha listesi;
 * sağda hedef, açık sorular ve seçili safhanın dosya/kabul kriterleri.
 * Sorular okuma akışının İÇİNDE: ayrı bir sihirbaz ekranında kalınca insan
 * planı okuyup onaylarken soruları hiç görmüyordu.
 *
 * Mobilde tek sütun ve Özet / Sorular / Safhalar segmenti; onay düğmeleri
 * sayfanın alt çubuğunda (dikkat yuvası çizer).
 *
 * Cevaplar burada TUTULMAZ: onay düğmesi dikkat yuvasında ve cevaplar onay
 * notuna yazılıyor. İkisi ayrı alt ağaç, durum `JobDetail`de.
 */

export type PlanAnswers = Record<string, string>;

/** Alttaki sohbet çubuğunun bağlamı: ne hakkında soruluyor. */
export interface PlanAskContext {
  label: string;
  hint: string;
  /** Mesajın başına eklenir: Planner hangi soru/safhadan söz edildiğini bilsin. */
  prefix: string;
}

/**
 * Plan kapısının yükünden model önerisini çıkarır.
 *
 * Yük sunucudan `unknown` gelir ve ESKİ kapılarda bu alan HİÇ YOKTUR
 * (triage'dan önce açılmış işler). Alan eksikse sessizce çizilmez — eski
 * işler UI'da bozulmamalı.
 */
export function modelChoiceOf(gate: Approval | null | undefined): ModelChoice | undefined {
  if (!gate || gate.kind !== "plan") return undefined;
  const raw = (gate.payload as { modelChoice?: unknown } | null)?.modelChoice;
  const parsed = ModelChoiceSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Safha-model tablosu; `perPhase` kapalıysa ve eski kapılarda boş döner. */
export function phaseModelsOf(gate: Approval | null | undefined): PhaseModelRow[] {
  if (!gate || gate.kind !== "plan") return [];
  const raw = (gate.payload as { phaseModels?: unknown } | null)?.phaseModels;
  const parsed = PlanGatePayloadSchema.shape.phaseModels.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/**
 * Onay notu: cevaplanan sorular "soru → cevap" satırları olarak.
 *
 * Onay yeniden planlatmıyor; cevap Developer'a bu notla ulaşır (sunucu notu
 * Developer promptunun "Plan kararları" bölümüne koyar).
 */
export function answersNote(questions: Question[], answers: PlanAnswers): string {
  const lines = questions
    .map((q, i) => ({ i, q: q.question, a: (answers[q.question] ?? "").trim() }))
    .filter((x) => x.a.length > 0)
    .map((x) => `- S${x.i + 1} · ${x.q} → ${x.a}`);
  return lines.length > 0 ? `Açık soru cevapları:\n${lines.join("\n")}` : "";
}

/** Cevapsız soruda geçerli olan: Planner'ın varsayımı ya da önerdiği şık. */
function fallbackOf(q: Question): string {
  return q.assumption || q.recommended;
}

/**
 * Planı geçersiz kılan cevaplar: `blocksPlan` sorusunda Planner'ın varsayımından
 * FARKLI seçim.
 *
 * Plan varsayıma göre yazıldı; varsayımı onaylayan cevap planı değiştirmez.
 * Ama şekli değiştiren soruda başka şık seçilince onay notu yetmez — Developer
 * eski safhaları, notta yazan kararla çelişerek uygular. Bunlar varken plan
 * kapısının birincil eylemi onay değil, yeniden planlatmaktır.
 */
export function reshapingAnswers(questions: Question[], answers: PlanAnswers): Question[] {
  const norm = (s: string): string => s.trim().toLocaleLowerCase("tr");
  return questions.filter((q) => {
    if (!q.blocksPlan) return false;
    const a = (answers[q.question] ?? "").trim();
    if (!a) return false;
    const fb = fallbackOf(q);
    return !fb || norm(a) !== norm(fb);
  });
}

/**
 * Safhanın kabul kriterleri. Belge DB'den ham JSON olarak geliyor ve alan
 * eklenmeden önce yazılmış planlarda HİÇ YOK — şema tipi dizi dese de.
 */
function acceptanceOf(view: PlanView, order: number): string[] {
  const raw: unknown = view.document.phases.find((d) => d.order === order)?.acceptance;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}


/** Önceki sürüme göre safhanın değişimi: aynı başlık yoksa yeni ya da değişmiş. */
type PhaseChange = "yeni" | "değişti";

function phaseChanges(cur: PlanPhaseRow[], prev: PlanPhaseRow[] | undefined): Map<number, PhaseChange> {
  const out = new Map<number, PhaseChange>();
  if (!prev) return out;
  const titles = new Set(prev.map((p) => p.title.trim().toLowerCase()));
  for (const p of cur) {
    if (titles.has(p.title.trim().toLowerCase())) continue;
    out.set(p.order, prev.some((x) => x.order === p.order) ? "değişti" : "yeni");
  }
  return out;
}

/** "v1→v2: safha 2 değişti, safha 3 eklendi. Sebep: senin red yorumun." */
function versionNote(
  cur: PlanView,
  prev: PlanView | undefined,
  prevStatus: string | undefined,
  changes: Map<number, PhaseChange>,
): string {
  if (!prev) return "";
  const parts: string[] = [];
  for (const [order, c] of [...changes.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(`safha ${order + 1} ${c === "yeni" ? "eklendi" : "değişti"}`);
  }
  const curTitles = new Set(cur.phases.map((p) => p.title.trim().toLowerCase()));
  const dropped = prev.phases.filter(
    (p) => !curTitles.has(p.title.trim().toLowerCase()) && !cur.phases.some((x) => x.order === p.order),
  ).length;
  if (dropped > 0) parts.push(`${dropped} safha çıkarıldı`);
  if (parts.length === 0) parts.push("safhalar aynı, metin güncellendi");
  // Sürüm neden değişti: önceki sürümün son durumu söylüyor.
  const why =
    prevStatus === "rejected" ? "senin red yorumun" : prevStatus === "superseded" ? "soru cevapların ya da sohbet" : "";
  return `v${prev.version}→v${cur.version}: ${parts.join(", ")}.${why ? ` Sebep: ${why}.` : ""}`;
}

/** Hedef metnindeki `kod` parçaları çip olarak — tasarımdaki `TransferService.Approve`. */
function withCode(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code
        key={i}
        className="rounded-[5px] border border-edge bg-chip px-[5px] py-px font-mono text-[12px] text-ink"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

const SECTION = "font-mono text-[10.5px] tracking-[.1em] text-ink-muted uppercase";

const PHASE_STATUS: Record<string, { label: string; cls: string }> = {
  approved: { label: "tamam", cls: "text-brand-ink" },
  done: { label: "tamam", cls: "text-brand-ink" },
  running: { label: "koşuyor", cls: "text-run-ink" },
  awaiting_approval: { label: "onay bekliyor", cls: "text-wait-ink" },
  skipped: { label: "atlandı", cls: "text-ink-muted" },
  rejected: { label: "reddedildi", cls: "text-err-ink" },
};

type Segment = "ozet" | "sorular" | "safhalar";

export function PlanTab({
  jobId,
  running,
  answers,
  onAnswer,
  onAsk,
  ladder,
  critiquePicks,
  onCritiquePicks,
}: {
  jobId: string;
  running: boolean;
  /** İkinci gözün işaretli bulguları — red gerekçesine girer. */
  critiquePicks: string[];
  onCritiquePicks?: (items: string[]) => void;
  /** Profilin model merdiveni — safha kapısındaki model seçicisi için. */
  ladder: ProjectProfile["agents"]["triage"]["ladder"] | undefined;
  /** Kapıdaki cevaplar (soru metni → cevap); kapı yoksa boş. */
  answers: PlanAnswers;
  onAnswer: (question: string, answer: string | null) => void;
  /** Soru ya da safha seçilince sohbet çubuğunun bağlamı. */
  onAsk: (ctx: PlanAskContext | null) => void;
}) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["plan", jobId], queryFn: () => api.plan(jobId), retry: false });
  const [picked, setPicked] = useState<string | null>(null);
  const cur = plan.data;
  const isOld = Boolean(cur && picked && picked !== cur.id);
  const older = useQuery({
    queryKey: ["planVersion", jobId, picked],
    queryFn: () => api.planVersion(jobId, picked ?? ""),
    enabled: isOld,
  });
  const shown = isOld ? older.data : cur;

  // Sürüm farkı için bir önceki sürüm: rayda "v1→v2: …" ve safha çipleri.
  const versions = useMemo(() => [...(cur?.versions ?? [])].sort((a, b) => a.version - b.version), [cur]);
  const prevMeta = shown ? versions.filter((v) => v.version < shown.version).pop() : undefined;
  const prev = useQuery({
    queryKey: ["planVersion", jobId, prevMeta?.id ?? null],
    queryFn: () => api.planVersion(jobId, prevMeta?.id ?? ""),
    enabled: Boolean(prevMeta),
    staleTime: Infinity,
  });

  const [phaseAt, setPhaseAt] = useState<number | null>(null);
  const [qFocus, setQFocus] = useState<number | null>(null);
  const [seg, setSeg] = useState<Segment | null>(null);
  const questionsRef = useRef<HTMLDivElement>(null);

  const gate = cur?.pendingApproval?.kind === "plan" ? cur.pendingApproval : null;
  const canAnswer = Boolean(gate) && !isOld;
  const questions = useMemo(() => (shown ? normalize(shown.document.openQuestions) : []), [shown]);
  const answerOf = (q: Question): string => (canAnswer ? (answers[q.question] ?? "").trim() : "");
  const answered = questions.filter((q) => answerOf(q).length > 0).length;
  const firstOpen = questions.findIndex((q) => answerOf(q).length === 0);

  const phaseModels = useMemo(() => (isOld ? [] : phaseModelsOf(gate)), [gate, isOld]);
  const modelChoice = isOld ? undefined : modelChoiceOf(gate);
  const changes = useMemo(
    () => (shown ? phaseChanges(shown.phases, prev.data?.phases) : new Map<number, PhaseChange>()),
    [shown, prev.data],
  );

  // Seçili safha: kullanıcı seçmediyse onay bekleyen/koşan, yoksa ilki.
  const phases = shown?.phases ?? [];
  const defaultPhase =
    phases.find((p) => p.status === "awaiting_approval" || p.status === "running")?.order ?? phases[0]?.order ?? 0;
  const selOrder = phaseAt !== null && phases.some((p) => p.order === phaseAt) ? phaseAt : defaultPhase;

  // Sohbet bağlamı: odaktaki soru, yoksa seçili safha.
  const planVersion = shown?.version;
  const focusQ = qFocus ?? (firstOpen >= 0 ? firstOpen : null);
  const focusQuestion = focusQ !== null ? questions[focusQ] : undefined;
  const selPhase = phases.find((p) => p.order === selOrder);
  useEffect(() => {
    if (planVersion === undefined) {
      onAsk(null);
      return;
    }
    if (focusQuestion && focusQ !== null) {
      onAsk({
        label: `Plan · S${focusQ + 1}`,
        hint: "Bu soru hakkında Planner'a sor…",
        prefix: `[Plan v${planVersion} · S${focusQ + 1}: ${focusQuestion.question}]`,
      });
    } else if (selPhase) {
      onAsk({
        label: `Plan · safha ${selPhase.order + 1}`,
        hint: "Bu safha hakkında Planner'a sor…",
        prefix: `[Plan v${planVersion} · safha ${selPhase.order + 1}: ${selPhase.title}]`,
      });
    } else {
      onAsk({ label: "Plan", hint: "Plan hakkında Planner'a sor…", prefix: `[Plan v${planVersion}]` });
    }
    // `onAsk` her çizimde yeni fonksiyon; bağlam yalnız odak değişince yazılır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planVersion, focusQ, focusQuestion?.question, selPhase?.order, selPhase?.title]);
  useEffect(() => () => onAsk(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cevaplarla yeniden planlatmak: soru planın ŞEKLİNİ değiştiriyorsa onay
  // notu yetmez, Planner safhaları yeniden yazmalı.
  const replan = useMutation({
    mutationFn: () =>
      api.answerPlanQuestions(jobId, {
        answers: questions
          .map((q) => ({ question: q.question, answer: answerOf(q) }))
          .filter((x) => x.answer.length > 0),
        comment: "",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["plan", jobId] });
      void qc.invalidateQueries({ queryKey: ["job", jobId] });
    },
  });

  if (plan.isLoading) return <Skeleton heights={[54, 96, 96, 96]} />;
  if (!cur) {
    return running ? (
      <div className="p-5">
        <div className="flex items-center gap-2.5 rounded-xl border border-accent-edge bg-accent-tint px-4 py-3">
          <Dot tone="run" pulse />
          <span className="text-[13px] font-medium text-ink">Planner planı yazıyor…</span>
        </div>
      </div>
    ) : (
      <EmptyState title="Plan yok">
        Planner koştuktan sonra plan ve safhalar burada görünür. İş <span className="font-mono">Draft</span>{" "}
        durumundaysa önce başlat.
      </EmptyState>
    );
  }
  if (isOld && older.isLoading) return <Skeleton heights={[54, 96, 96]} />;
  if (!shown) return <ErrorText error={older.error} />;

  const blocking = questions.filter((q) => q.blocksPlan && answerOf(q).length === 0).length;
  const segment: Segment = seg ?? (questions.length > 0 && answered < questions.length ? "sorular" : "ozet");
  const note = versionNote(shown, prev.data, prevMeta?.status, changes);

  const goQuestions = (): void => {
    setSeg("sorular");
    questionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const versionBlock = (
    <VersionBlock
      versions={versions}
      shownId={shown.id}
      currentId={cur.id}
      note={note}
      onPick={(id) => setPicked(id === cur.id ? null : id)}
    />
  );

  const oldBanner = isOld && (
    <p className="rounded-[9px] border border-edge bg-raised px-3 py-2 text-[12px] text-ink-muted">
      Geçmiş sürüm görüntüleniyor; yerine yenisi geçti. Cevap ve onay yalnız güncel sürümde.{" "}
      <button onClick={() => setPicked(null)} className="font-semibold text-brand-ink underline">
        güncele dön
      </button>
    </p>
  );

  const questionList = (mobile: boolean) =>
    questions.length > 0 && (
      <QuestionList
        mobile={mobile}
        questions={questions}
        answerOf={answerOf}
        canAnswer={canAnswer}
        focus={focusQ}
        onFocus={setQFocus}
        onAnswer={onAnswer}
        answered={answered}
        blocking={blocking}
        replan={
          canAnswer && answered > 0
            ? { pending: replan.isPending, error: replan.error, run: () => replan.mutate() }
            : undefined
        }
      />
    );

  const phaseCard = (p: PlanPhaseRow) => (
    <PhaseCard
      jobId={jobId}
      phase={p}
      acceptance={acceptanceOf(shown, p.order)}
      change={changes.get(p.order)}
      version={shown.version}
      model={phaseModels.find((m) => m.order === p.order)}
      editable={canAnswer}
    />
  );

  // Safha kapısı açıkken sıradaki safha en üstte: insan onaylamadan önce
  // "sırada ne var, hangi modelle" sorusunu burada cevaplar ve modeli
  // değiştirebilir. Eski sürüme bakarken çizilmez — kart güncel plana ait.
  const phaseGate = !isOld && cur.pendingApproval?.kind === "phase" ? cur.pendingApproval : null;
  const nextCard = phaseGate && (
    <NextPhaseCard jobId={jobId} gate={phaseGate} ladder={ladder} total={cur.phases.length} />
  );

  // Senaryo kartı yalnız GÜNCEL sürümde: eski sürüme bakarken istenen liste
  // yine de son plana göre üretilir, yanıltıcı olurdu.
  // İkinci göz sürüme bağlı: eski sürüme bakarken onun eleştirisi görünür ama
  // bulgu işaretlenemez — red yalnız güncel sürüme.
  const extras = (
    <>
      <PlanExtras view={shown} modelChoice={modelChoice} />
      <CritiqueCard
        jobId={jobId}
        subject="plan"
        subjectId={shown.id}
        picks={critiquePicks}
        {...(canAnswer && onCritiquePicks ? { onPicks: onCritiquePicks } : {})}
      />
      {!isOld && <TestScenariosCard jobId={jobId} canGenerate={canAnswer && !running} />}
    </>
  );

  return (
    <>
      {/* ── Masaüstü (2b) ── */}
      <div className="hidden h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] md:grid">
        <div className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-auto border-r border-edge bg-pane p-3.5">
          {versionBlock}

          {questions.length > 0 && (
            <OpenQuestionsCard answered={answered} total={questions.length} onClick={goQuestions} />
          )}

          <div className="flex flex-col gap-1.5">
            <span className={SECTION}>Safhalar · {phases.length}</span>
            {phases.map((p) => (
              <PhaseRow
                key={p.id}
                phase={p}
                on={p.order === selOrder}
                criteria={acceptanceOf(shown, p.order).length}
                model={phaseModels.find((m) => m.order === p.order)?.model ?? modelChoice?.model}
                change={changes.get(p.order)}
                onClick={() => {
                  setPhaseAt(p.order);
                  setQFocus(null);
                }}
              />
            ))}
          </div>
        </div>

        <div className="min-h-0 min-w-0 overflow-auto px-6.5 pt-4.5 pb-6.5">
          <div className="flex max-w-[80ch] flex-col gap-4.5">
            {oldBanner}
            {nextCard}
            <Goal summary={shown.document.summary} />
            <div ref={questionsRef} className="scroll-mt-4">
              {questionList(false)}
            </div>
            {selPhase && phaseCard(selPhase)}
            {extras}
          </div>
        </div>
      </div>

      {/* ── Mobil (2e) ── */}
      <div className="flex h-full min-h-0 flex-col md:hidden">
        <div className="mx-4 mt-3 flex shrink-0 rounded-xl border border-edge-strong bg-raised p-[3px]">
          <SegButton on={segment === "ozet"} onClick={() => setSeg("ozet")}>
            Özet
          </SegButton>
          <SegButton on={segment === "sorular"} onClick={() => setSeg("sorular")}>
            Sorular
            {questions.length > 0 && (
              <span
                className={`rounded-[5px] px-1.5 py-px font-mono text-[10.5px] font-normal ${
                  answered < questions.length ? "bg-wait-tint text-wait-ink" : "text-ink-muted"
                }`}
              >
                {questions.length - answered}
              </span>
            )}
          </SegButton>
          <SegButton on={segment === "safhalar"} onClick={() => setSeg("safhalar")}>
            Safhalar
            <span className="font-mono text-[10.5px] font-normal text-ink-muted">{phases.length}</span>
          </SegButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pt-3.5 pb-4">
          {oldBanner}
          {nextCard}
          {segment === "ozet" && (
            <>
              <Goal summary={shown.document.summary} />
              {versionBlock}
              {questions.length > 0 && (
                <OpenQuestionsCard answered={answered} total={questions.length} onClick={() => setSeg("sorular")} />
              )}
              {extras}
            </>
          )}
          {segment === "sorular" &&
            (questions.length > 0 ? (
              questionList(true)
            ) : (
              <p className="py-6 text-center text-[13px] text-ink-muted">Bu planda açık soru yok.</p>
            ))}
          {segment === "safhalar" &&
            phases.map((p) =>
              p.order === selOrder ? (
                <Fragment key={p.id}>{phaseCard(p)}</Fragment>
              ) : (
                <PhaseRow
                  key={p.id}
                  mobile
                  phase={p}
                  on={false}
                  criteria={acceptanceOf(shown, p.order).length}
                  model={phaseModels.find((m) => m.order === p.order)?.model ?? modelChoice?.model}
                  change={changes.get(p.order)}
                  onClick={() => {
                    setPhaseAt(p.order);
                    setQFocus(null);
                  }}
                />
              ),
            )}
        </div>
      </div>
    </>
  );
}

function SegButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex h-[38px] flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[13.5px] transition-colors ${
        on ? "bg-surface font-semibold text-ink shadow-xs" : "text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
}

function VersionBlock({
  versions,
  shownId,
  currentId,
  note,
  onPick,
}: {
  versions: PlanView["versions"];
  shownId: string;
  currentId: string;
  note: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-[7px]">
      <div className="flex flex-wrap items-center gap-1.5">
        {versions.map((v) => {
          const on = v.id === shownId;
          // Yerine yenisi geçen sürüm üstü çizili: "bu artık geçerli değil".
          const gone = v.id !== currentId && (v.status === "superseded" || v.status === "rejected");
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onPick(v.id)}
              title={`${v.status} · ${fmtClock(v.createdAt)}`}
              className={`rounded-[5px] px-[7px] py-0.5 font-mono text-[11px] transition-colors ${
                on ? "bg-brand text-white" : `bg-chip text-ink-muted hover:text-ink ${gone ? "line-through" : ""}`
              }`}
            >
              v{v.version}
            </button>
          );
        })}
      </div>
      {note && <span className="text-[12px] leading-normal text-off-ink">{note}</span>}
    </div>
  );
}

function OpenQuestionsCard({ answered, total, onClick }: { answered: number; total: number; onClick: () => void }) {
  const open = answered < total;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-[9px] rounded-[10px] border px-[11px] py-2.5 text-left ${
        open ? "border-wait-edge bg-wait-tint" : "border-brand-edge bg-brand-tint"
      }`}
    >
      <Dot tone={open ? "wait" : "ok"} />
      <span className="text-[12.5px] font-semibold text-ink">Açık sorular</span>
      <span className="flex-1" />
      <span className={`font-mono text-[11px] ${open ? "text-wait-ink" : "text-ok-ink"}`}>
        {answered}/{total} cevaplı
      </span>
    </button>
  );
}

function Goal({ summary }: { summary: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={SECTION}>Hedef</span>
      <p className="aht-wrap text-[14px] leading-[1.7] text-ink-body text-pretty">{withCode(summary)}</p>
    </div>
  );
}

function ChangeChip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-wait-edge bg-wait-tint px-1.5 py-px font-mono text-[10px] text-wait-ink">
      {children}
    </span>
  );
}

function PhaseRow({
  phase: p,
  on,
  criteria,
  model,
  change,
  mobile = false,
  onClick,
}: {
  phase: PlanPhaseRow;
  on: boolean;
  criteria: number;
  model: string | undefined;
  change: PhaseChange | undefined;
  mobile?: boolean;
  onClick: () => void;
}) {
  const st = PHASE_STATUS[p.status];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex flex-col gap-[5px] rounded-[10px] border px-[11px] text-left transition-colors ${
        mobile ? "min-h-[52px] justify-center py-3" : "py-2.5"
      } ${on ? "border-brand-edge bg-brand-tint" : "border-edge bg-surface hover:border-edge-strong"}`}
    >
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-ink-muted">{p.order + 1}</span>
        <span className={`min-w-0 flex-1 leading-[1.35] font-semibold text-ink ${mobile ? "text-[14px]" : "text-[13px]"}`}>
          {p.title}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5 pl-4">
        {model && (
          <span className="rounded-sm bg-accent-tint px-1.5 py-px font-mono text-[10px] text-accent-ink">
            {shortModel(model)}
          </span>
        )}
        <span className="font-mono text-[10px] text-ink-muted">
          {p.files.length} dosya · {criteria > 0 ? `${criteria} kriter` : `risk ${p.risk}`}
        </span>
        {change && <ChangeChip>{change === "yeni" ? "yeni" : "değişti"}</ChangeChip>}
        {st && <span className={`font-mono text-[10px] ${st.cls}`}>· {st.label}</span>}
      </span>
    </button>
  );
}

/** Seçili safha: dosyalar ve kabul kriterleri yan yana, model seviyesi altta. */
function PhaseCard({
  jobId,
  phase: p,
  acceptance,
  change,
  version,
  model,
  editable,
}: {
  jobId: string;
  phase: PlanPhaseRow;
  acceptance: string[];
  change: PhaseChange | undefined;
  version: number;
  model: PhaseModelRow | undefined;
  editable: boolean;
}) {
  const qc = useQueryClient();
  const override = useMutation({
    mutationFn: (tier: PhaseModelRow["tier"] | null) =>
      api.overridePhaseTiers(jobId, { overrides: [{ order: p.order, tier }], comment: "" }),
    // Kapı yükü sunucuda yeniden yazıldı: tazelenmezse ekran eski seviyeyi
    // gösterip onay yeni seviyeyle koşar.
    onSettled: () => void qc.invalidateQueries({ queryKey: ["plan", jobId] }),
  });
  const tier = model ? (TIER_TR[model.tier] ?? { label: model.tier, tone: "bg-raised text-ink-body" }) : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-brand-edge bg-pane px-[17px] py-[15px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="min-w-0 text-[15px] font-semibold text-ink">
          Safha {p.order + 1} · {p.title}
        </span>
        {change && <ChangeChip>v{version}'de {change === "yeni" ? "eklendi" : "değişti"}</ChangeChip>}
        {p.exceedsFileCap && <ChangeChip>dosya tavanı aşılıyor</ChangeChip>}
      </div>
      {p.rationale && <p className="aht-wrap text-[13px] leading-[1.6] text-ink-soft text-pretty">{p.rationale}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase">Dokunacağı dosyalar</span>
          {p.files.length > 0 ? (
            p.files.map((f) => (
              <span key={f} className="aht-wrap font-mono text-[11.5px] text-ink">
                {f}
              </span>
            ))
          ) : (
            <span className="text-[12.5px] text-ink-muted">Planner dosya yazmadı.</span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase">Kabul kriterleri</span>
          {acceptance.length > 0 ? (
            acceptance.map((c) => (
              <span key={c} className="flex gap-2 text-[13px] leading-normal text-ink-body">
                <span className="font-mono text-[11px] text-ok-ink">□</span>
                <span className="aht-wrap min-w-0">{c}</span>
              </span>
            ))
          ) : (
            // Eski planlarda alan yok: boş kutu "kriter yok" değil, "yazılmamış".
            <span className="text-[12.5px] text-ink-muted">Bu plan sürümünde kabul kriteri yazılmamış.</span>
          )}
        </div>
      </div>

      {model && tier && (
        <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-2.5">
          <span className="font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase">Model</span>
          <span className="font-mono text-[12px] text-ink">{shortModel(model.model)}</span>
          <span className="text-[12px] text-ink-muted">effort {model.effort}</span>
          {model.source === "human" && (
            <span className="font-mono text-[10.5px] tracking-[.04em] text-ink-muted uppercase">elle</span>
          )}
          <span className="flex-1" />
          {editable ? (
            <TierPicker
              row={model}
              disabled={override.isPending}
              onPick={(t) => {
                if (t !== model.tier) override.mutate(t);
              }}
            />
          ) : (
            <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium ${tier.tone}`}>{tier.label}</span>
          )}
          {model.requiresApproval && (
            <span className="w-full text-[12px] font-medium text-wait-ink">
              Pahalı seviye: planı onaylarsan bu safha bu modelle koşar.
            </span>
          )}
          <ErrorText error={override.error} />
        </div>
      )}
    </div>
  );
}

function QuestionList({
  mobile,
  questions,
  answerOf,
  canAnswer,
  focus,
  onFocus,
  onAnswer,
  answered,
  blocking,
  replan,
}: {
  mobile: boolean;
  questions: Question[];
  answerOf: (q: Question) => string;
  canAnswer: boolean;
  focus: number | null;
  onFocus: (i: number) => void;
  onAnswer: (question: string, answer: string | null) => void;
  answered: number;
  blocking: number;
  replan: { pending: boolean; error: unknown; run: () => void } | undefined;
}) {
  const replanLink = replan && (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={replan.pending}
        onClick={replan.run}
        title="Cevaplar Planner'a gider ve plan yeniden yazılır; onaylarsan ise cevaplar onay notuyla Developer'a gider."
        className="w-fit text-[12px] font-semibold text-brand-ink underline underline-offset-2 disabled:opacity-50"
      >
        {replan.pending ? "gönderiliyor…" : `${answered} cevapla yeniden planlat`}
      </button>
      <ErrorText error={replan.error} />
    </div>
  );
  const blockingNote = blocking > 0 && (
    <p className="text-[12px] text-err-text">
      {blocking} soru planın şeklini değiştiriyor ve cevapsız; onaylamadan önce cevaplayıp yeniden planlat.
    </p>
  );

  if (mobile) {
    // Mobil: cevap bekleyenler üstte büyük kartlar, cevaplananlar altta tek satır.
    const open = questions.map((q, i) => ({ q, i })).filter((x) => !answerOf(x.q));
    const done = questions.map((q, i) => ({ q, i })).filter((x) => answerOf(x.q));
    return (
      <div className="flex flex-col gap-3">
        {open.map(({ q, i }) => (
          <MobileQuestion
            key={q.question}
            q={q}
            n={i + 1}
            focus={i === focus}
            canAnswer={canAnswer}
            onAnswer={(a) => {
              onFocus(i);
              onAnswer(q.question, a);
            }}
          />
        ))}
        {blockingNote}
        {done.length > 0 && (
          <>
            <span className="pt-1 font-mono text-[11px] tracking-[.08em] text-ink-muted uppercase">Cevapladıkların</span>
            {done.map(({ q, i }) => (
              <div
                key={q.question}
                className="flex min-h-[52px] items-center gap-[11px] rounded-xl border border-edge bg-pane px-[13px] py-2"
              >
                <span className="shrink-0 font-mono text-[12px] text-ok-ink">✓</span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="aht-wrap text-[13px] text-ink-soft">
                    S{i + 1} · {q.question}
                  </span>
                  <span className="aht-wrap text-[14px] font-semibold text-ink">{answerOf(q)}</span>
                </div>
                {canAnswer && (
                  <button
                    type="button"
                    onClick={() => onAnswer(q.question, null)}
                    className="flex h-11 shrink-0 items-center px-1 text-[13px] font-semibold text-ok-ink"
                  >
                    Değiştir
                  </button>
                )}
              </div>
            ))}
            {replanLink}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[9px]">
      <div className="flex flex-wrap items-baseline gap-[9px]">
        <span className={SECTION}>Açık sorular</span>
        <span className="text-[12px] text-wait-ink">cevapsız kalanlarda Planner varsayılanı seçer</span>
        <span className="flex-1" />
        {replanLink}
      </div>
      {questions.map((q, i) => (
        <DesktopQuestion
          key={q.question}
          q={q}
          n={i + 1}
          answer={answerOf(q)}
          focus={i === focus}
          canAnswer={canAnswer}
          onFocus={() => onFocus(i)}
          onAnswer={(a) => onAnswer(q.question, a)}
        />
      ))}
      {blockingNote}
    </div>
  );
}

/** Şık etiketi: Planner "etiket — sonuç · bedeli: …" yazıyor, düğmeye etiket sığar. */
function optionLabel(o: string): string {
  return splitOption(o).label;
}

function DesktopQuestion({
  q,
  n,
  answer,
  focus,
  canAnswer,
  onFocus,
  onAnswer,
}: {
  q: Question;
  n: number;
  answer: string;
  focus: boolean;
  canAnswer: boolean;
  onFocus: () => void;
  onAnswer: (a: string | null) => void;
}) {
  const free = answer.length > 0 && !q.options.includes(answer);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(free ? answer : "");
  const [why, setWhy] = useState(false);
  const fb = fallbackOf(q);

  const pill = (on: boolean) =>
    `rounded-lg border px-[11px] py-[5px] text-left text-[12.5px] transition-colors ${
      on
        ? "border-brand bg-brand-tint font-semibold text-ok-ink"
        : "border-edge-strong bg-surface text-ink-body enabled:hover:border-brand-edge"
    }`;

  return (
    <div
      onClick={onFocus}
      className={`flex flex-col gap-[9px] rounded-xl border bg-surface px-3.5 py-3 ${
        focus && !answer ? "border-wait-edge ring-3 ring-wait/15" : "border-edge"
      }`}
    >
      <div className="flex items-baseline gap-[9px]">
        <span className="shrink-0 font-mono text-[11px] text-ink-muted">S{n}</span>
        <span className="aht-wrap min-w-0 flex-1 text-[13.5px] font-semibold text-ink">{q.question}</span>
        {q.blocksPlan && !answer && (
          <span className="shrink-0 rounded-[5px] bg-err-tint px-1.5 py-px font-mono text-[10px] text-err-text">
            planı değiştirir
          </span>
        )}
        <span className={`shrink-0 font-mono text-[10.5px] ${answer ? "text-ok-ink" : "text-wait-ink"}`}>
          {answer ? "cevaplandı · sen" : "cevap bekliyor"}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5 pl-6">
        {q.options.map((o) => (
          <button
            key={o}
            type="button"
            disabled={!canAnswer}
            title={o}
            onClick={() => onAnswer(answer === o ? null : o)}
            className={pill(answer === o)}
          >
            {optionLabel(o)}
          </button>
        ))}
        {free && !writing && (
          <button type="button" disabled={!canAnswer} onClick={() => setWriting(true)} className={pill(true)}>
            {answer}
          </button>
        )}
        {canAnswer &&
          (writing ? (
            <form
              className="flex min-w-[240px] flex-1 gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) onAnswer(draft.trim());
                setWriting(false);
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setWriting(false);
                }}
                placeholder="Cevabın"
                className="h-[30px] min-w-0 flex-1 rounded-lg border border-edge-control bg-surface px-2.5 text-[12.5px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                className="h-[30px] shrink-0 rounded-lg bg-brand px-3 text-[12px] font-semibold text-white disabled:opacity-40"
              >
                Kaydet
              </button>
            </form>
          ) : (
            !free && (
              <button
                type="button"
                onClick={() => setWriting(true)}
                className="rounded-lg border border-dashed border-edge-control px-[11px] py-[5px] text-[12.5px] text-ink-dim hover:text-ink"
              >
                serbest cevap…
              </button>
            )
          ))}
      </div>

      {!answer && fb && <span className="aht-wrap pl-6 text-[12px] text-wait-ink">Cevapsız kalırsa: {fb}</span>}

      {q.context && (
        <div className="pl-6">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setWhy((v) => !v);
            }}
            className="text-[12px] text-ink-muted hover:text-ink"
          >
            {why ? "gerekçeyi gizle ▴" : "gerekçe ▾"}
          </button>
          {why && <p className="aht-wrap mt-1 text-[12.5px] leading-[1.65] text-ink-soft">{q.context}</p>}
        </div>
      )}
    </div>
  );
}

function MobileQuestion({
  q,
  n,
  focus,
  canAnswer,
  onAnswer,
}: {
  q: Question;
  n: number;
  focus: boolean;
  canAnswer: boolean;
  onAnswer: (a: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [why, setWhy] = useState(false);
  // Cevapsız soruda Planner'ın önerisi seçili görünür: cevaplamazsan geçerli olan bu.
  const def = q.recommended;

  return (
    <div
      className={`flex flex-col gap-2.5 rounded-[14px] border bg-surface p-3.5 ${
        focus ? "border-wait-edge" : "border-edge"
      }`}
    >
      <div className="flex flex-col gap-[3px]">
        <span className="font-mono text-[11px] text-wait-ink">
          S{n} · cevap bekliyor{q.blocksPlan ? " · planı değiştirir" : ""}
        </span>
        <span className="aht-wrap text-[16px] leading-[1.4] font-semibold text-ink text-pretty">{q.question}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {q.options.map((o) => {
          const on = o === def;
          return (
            <button
              key={o}
              type="button"
              disabled={!canAnswer}
              onClick={() => onAnswer(o)}
              className={`flex min-h-[46px] items-center gap-[11px] rounded-[11px] border px-[13px] py-2 text-left ${
                on ? "border-brand bg-brand-tint" : "border-edge-strong bg-surface"
              }`}
            >
              <span
                className={`h-[18px] w-[18px] shrink-0 rounded-full border shadow-[inset_0_0_0_4px_var(--color-surface)] ${
                  on ? "border-brand bg-brand" : "border-edge-control bg-surface"
                }`}
              />
              <span className="aht-wrap min-w-0 flex-1 text-[14.5px] text-ink">{optionLabel(o)}</span>
              {on && <span className="shrink-0 font-mono text-[10.5px] text-wait-ink">varsayılan</span>}
            </button>
          );
        })}
        {canAnswer &&
          (writing ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) onAnswer(draft.trim());
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Cevabın"
                className="h-[46px] min-w-0 flex-1 rounded-[11px] border border-edge-control bg-surface px-[13px] text-[16px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                className="h-[46px] shrink-0 rounded-[11px] bg-brand px-4 text-[14px] font-semibold text-white disabled:opacity-40"
              >
                Kaydet
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setWriting(true)}
              className="flex min-h-[46px] items-center rounded-[11px] border border-dashed border-edge-control px-[13px] text-left text-[14px] text-ink-dim"
            >
              Serbest cevap yaz…
            </button>
          ))}
      </div>
      {!def && fallbackOf(q) && <span className="aht-wrap text-[12.5px] text-wait-ink">Cevapsız kalırsa: {fallbackOf(q)}</span>}
      {q.context && (
        <>
          <button
            type="button"
            onClick={() => setWhy((v) => !v)}
            className="flex h-9 w-fit items-center text-[13px] text-ink-muted"
          >
            {why ? "gerekçeyi gizle ▴" : "gerekçe ▾"}
          </button>
          {why && <p className="aht-wrap text-[13px] leading-[1.65] text-ink-soft">{q.context}</p>}
        </>
      )}
    </div>
  );
}

/** Şemanın kalan alanları: model önerisi, test stratejisi, kapsam. Boşsa çizilmez. */
/**
 * Gereksinimler: iş tanımı nasıl anlaşıldı. Alıntı ham metne geri
 * bağlar; hiçbir safhanın karşılamadığı gereksinim öne çıkar — planın
 * atladığı istek onaydan önce görünsün. Eski planlarda liste yok.
 */
function Requirements({ doc }: { doc: PlanView["document"] }) {
  if (doc.requirements.length === 0) return null;
  const coveredBy = new Map<string, number[]>();
  for (const p of doc.phases) {
    for (const id of p.covers) coveredBy.set(id, [...(coveredBy.get(id) ?? []), p.order + 1]);
  }
  const uncovered = doc.requirements.filter((r) => !coveredBy.has(r.id)).length;
  return (
    <div className="flex flex-col gap-1.5">
      <span className={SECTION}>
        Gereksinimler · {doc.requirements.length}
        {uncovered > 0 && <span className="text-wait-ink"> · {uncovered} karşılanmamış</span>}
      </span>
      {doc.requirements.map((r) => {
        const by = coveredBy.get(r.id) ?? [];
        return (
          <div key={r.id} className="flex gap-2 text-[13px] leading-normal">
            <span className={`font-mono text-[11px] ${by.length === 0 ? "text-wait-ink" : "text-ink-muted"}`}>{r.id}</span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="aht-wrap text-ink-body">{r.text}</span>
              <span className="aht-wrap text-[12px] text-ink-dim">
                {r.source ? `“${r.source}”` : "örtük — açıklamada geçmiyor"} ·{" "}
                {by.length > 0 ? (
                  `safha ${by.join(", ")}`
                ) : (
                  <span className="font-medium text-wait-ink">hiçbir safha karşılamıyor</span>
                )}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PlanExtras({ view, modelChoice }: { view: PlanView; modelChoice: ModelChoice | undefined }) {
  const d = view.document;
  const blocks: ReactNode[] = [];
  if (d.requirements.length > 0) blocks.push(<Requirements key="req" doc={d} />);
  if (modelChoice) {
    const tier = TIER_TR[modelChoice.tier];
    blocks.push(
      <div key="model" className="flex flex-col gap-1.5">
        <span className={SECTION}>Geliştirme modeli</span>
        <span className="flex flex-wrap items-center gap-2 text-[13px] text-ink-body">
          <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium ${tier?.tone ?? "bg-raised"}`}>
            {tier?.label ?? modelChoice.tier}
          </span>
          <span className="font-mono text-[12px] text-ink">{shortModel(modelChoice.model)}</span>
          <span className="text-ink-muted">effort {modelChoice.effort}</span>
        </span>
        {modelChoice.requiresApproval && (
          <span className="text-[12.5px] font-medium text-wait-ink">
            Bu seviye pahalıdır; planı onaylarsan bu modelle çalışılır.
          </span>
        )}
        {modelChoice.rationale && <p className="aht-wrap text-[12.5px] leading-[1.6] text-ink-soft">{modelChoice.rationale}</p>}
      </div>,
    );
  }
  if (d.testStrategy) {
    blocks.push(
      <div key="test" className="flex flex-col gap-1.5">
        <span className={SECTION}>Test stratejisi</span>
        <p className="aht-wrap text-[13.5px] leading-[1.65] text-ink-body">{withCode(d.testStrategy)}</p>
      </div>,
    );
  }
  if (d.targetRepos.length > 0 || d.outOfScope.length > 0) {
    blocks.push(
      <div key="scope" className="flex flex-col gap-1.5">
        <span className={SECTION}>Kapsam</span>
        {d.targetRepos.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {d.targetRepos.map((r) => (
              <span key={r} className="rounded-md border border-edge bg-chip px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                {r}
              </span>
            ))}
          </span>
        )}
        {d.outOfScope.map((o) => (
          <span key={o} className="flex gap-2 text-[13px] leading-normal text-ink-body">
            <span className="font-mono text-[11px] text-ink-muted">×</span>
            <span className="aht-wrap min-w-0">{o}</span>
          </span>
        ))}
      </div>,
    );
  }
  return blocks.length > 0 ? <div className="flex flex-col gap-4.5 border-t border-edge pt-4">{blocks}</div> : null;
}
