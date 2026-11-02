import { useMemo, useState } from "react";

import type { PlanDocument } from "@ahtapot/shared";

import type { PlanPhaseRow } from "../api";
import { Clamp } from "../ui";
import { buildDocSections, type DocBlock, type DocSection, type Mark } from "./planDoc";
import { normalize } from "./questions";
import { QuestionPane } from "./QuestionPane";

/**
 * Plan okuma ekranı — solda rail, sağda tek bir şey.
 *
 * Plan ve açık sorular üst üste diziliydi: plan uzun, sorular altta kalıyor ve
 * insan onaylamadan önce soruları hiç görmüyordu. Rail ikisini aynı seviyeye
 * çıkarır — "Plan okuması" ve "Planner soruları" iki bölüm, seçilen sağda
 * TEK BAŞINA açılır. Soru cevaplarken planın ilgili bölümüne dönebilmek
 * gerektiği için iki yönlü geçiş düğmesi var.
 */

/** Satır işaretinin rengi. */
const MARK_TONES: Record<Mark, string> = {
  "✓": "bg-brand-tint-soft text-brand-ink",
  "×": "bg-chip text-ink-muted",
  "→": "bg-accent-tint-soft text-accent-ink",
  "!": "bg-wait-tint text-wait-ink",
  "·": "bg-chip text-ink-muted",
};

/** Safha rozetinin rengi. */
const TAG_TONES: Record<string, string> = {
  tamam: "bg-brand-tint-soft text-brand-ink",
  koşuyor: "bg-accent-tint-soft text-accent-ink",
  "onay bekliyor": "bg-wait-tint text-wait-ink",
  reddedildi: "bg-err-tint text-err-text",
};

export function PlanReader({
  doc,
  phases,
  jobId,
  onSubmit,
  pending,
  error,
}: {
  doc: PlanDocument;
  phases: PlanPhaseRow[];
  /** Yoksa salt okunur: geçmiş sürümde cevap verilemez. */
  jobId?: string;
  onSubmit: (answers: { question: string; answer: string }[], comment: string) => void;
  pending: boolean;
  error?: unknown;
}) {
  const sections = useMemo(() => buildDocSections(doc, phases), [doc, phases]);
  const questions = useMemo(() => normalize(doc.openQuestions), [doc.openQuestions]);

  /** Seçim: `doc:<id>` bir plan bölümü, `q` soru paneli. */
  const [sel, setSel] = useState<string>(() => (sections[0] ? `doc:${sections[0].id}` : "q"));
  const [qAt, setQAt] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const onQ = sel === "q";
  const section = sections.find((s) => `doc:${s.id}` === sel) ?? sections[0];
  const answered = questions.filter((x) => (answers[x.question] ?? "").trim().length > 0).length;
  const canAnswer = Boolean(jobId) && questions.length > 0;

  return (
    // `grid-rows-[minmax(0,1fr)]`: grid'in tek satırı `auto` kalırsa Rail/DocPane
    // içeriğine göre büyüyüp dış kutuyu taşırıyordu ve iç `overflow-auto`lar hiç
    // devreye girmiyordu — Plan sekmesi kaydırma yerine tüm sayfayı uzatıyordu.
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] items-stretch gap-4 lg:grid-cols-[286px_minmax(0,1fr)]">
      <Rail
        sections={sections}
        questions={questions}
        sel={sel}
        qAt={qAt}
        answers={answers}
        answered={answered}
        planVersionLabel={`${phases.length} safha`}
        onPickDoc={(id) => setSel(`doc:${id}`)}
        onPickQuestion={(i) => {
          setSel("q");
          setQAt(i);
        }}
      />

      {onQ && questions.length > 0 ? (
        <QuestionPane
          questions={questions}
          at={Math.min(qAt, questions.length - 1)}
          answers={answers}
          answered={answered}
          readOnly={!canAnswer}
          pending={pending}
          error={error}
          onAt={setQAt}
          onAnswer={(q, v) => setAnswers((prev) => ({ ...prev, [q]: v }))}
          onBackToPlan={() => setSel(sections[0] ? `doc:${sections[0].id}` : "q")}
          onSubmit={onSubmit}
        />
      ) : section ? (
        <DocPane
          section={section}
          answered={answered}
          total={questions.length}
          onGoQuestions={questions.length > 0 ? () => setSel("q") : undefined}
        />
      ) : null}
    </div>
  );
}

/** Sol rail: plan bölümleri + soru listesi, ilerleme başlıkta. */
function Rail({
  sections,
  questions,
  sel,
  qAt,
  answers,
  answered,
  planVersionLabel,
  onPickDoc,
  onPickQuestion,
}: {
  sections: DocSection[];
  questions: ReturnType<typeof normalize>;
  sel: string;
  qAt: number;
  answers: Record<string, string>;
  answered: number;
  planVersionLabel: string;
  onPickDoc: (id: string) => void;
  onPickQuestion: (i: number) => void;
}) {
  const pct = questions.length > 0 ? Math.round((answered / questions.length) * 100) : 0;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-edge bg-raised">
      <div className="flex shrink-0 flex-col gap-[7px] border-b border-edge p-3">
        <span className="font-mono text-[10px] uppercase tracking-[.11em] text-ink-muted">
          Plan · {planVersionLabel}
        </span>
        {questions.length > 0 ? (
          <>
            <span className="text-[12.5px] text-ink-body">
              {answered}/{questions.length} soru cevaplandı
            </span>
            <div className="h-1 overflow-hidden rounded-[2px] bg-edge">
              <div className="h-full rounded-[2px] bg-brand transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : (
          <span className="text-[12.5px] text-ink-muted">açık soru yok</span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5">
        <RailLabel>Plan okuması</RailLabel>
        {sections.map((s) => {
          const on = sel === `doc:${s.id}`;
          return (
            <button
              key={s.id}
              onClick={() => onPickDoc(s.id)}
              className={`flex items-center gap-2.5 rounded-[9px] border px-2.5 py-2.5 text-left transition-colors ${
                on ? "border-brand-edge bg-brand-tint" : "border-transparent hover:bg-chip"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-[10px] font-semibold ${
                  on ? "bg-brand text-white" : "bg-chip text-ink-muted"
                }`}
              >
                {s.num}
              </span>
              <Clamp
                lines={1}
                text={s.title}
                className={`min-w-0 flex-1 text-[12.5px] leading-[1.35] ${
                  on ? "font-semibold text-[#0d3b31]" : "font-medium text-ink-body"
                }`}
              />
              {s.meta && <span className="shrink-0 font-mono text-[10px] text-ink-muted">{s.meta}</span>}
            </button>
          );
        })}

        {questions.length > 0 && (
          <>
            <RailLabel className="pt-3.5">Planner soruları</RailLabel>
            {questions.map((q, i) => {
              const on = sel === "q" && i === qAt;
              const done = (answers[q.question] ?? "").trim().length > 0;
              return (
                <button
                  key={q.question}
                  onClick={() => onPickQuestion(i)}
                  className={`flex items-start gap-2.5 rounded-[9px] border px-2.5 py-2.5 text-left transition-colors ${
                    on ? "border-accent-edge bg-accent-tint" : "border-transparent hover:bg-chip"
                  }`}
                >
                  <span
                    className={`mt-px flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[10.5px] font-semibold ${
                      done
                        ? "bg-brand text-white"
                        : on
                          ? "bg-accent text-white"
                          : q.blocksPlan
                            ? "bg-err-tint text-err-text"
                            : "bg-chip text-ink-muted"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    {q.blocksPlan && (
                      <span className="font-mono text-[10px] uppercase tracking-[.06em] text-err-text">
                        planı değiştirir
                      </span>
                    )}
                    <Clamp
                      lines={3}
                      text={q.question}
                      className={`text-[12.5px] leading-[1.4] ${
                        on ? "font-semibold text-accent-deep" : "text-ink-body"
                      }`}
                    />
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function RailLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[.1em] text-ink-dim ${className}`}
    >
      {children}
    </span>
  );
}

/** Sağ panel: seçili plan bölümünün okuması. */
function DocPane({
  section,
  answered,
  total,
  onGoQuestions,
}: {
  section: DocSection;
  answered: number;
  total: number;
  onGoQuestions?: (() => void) | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-edge bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-edge bg-raised px-5 py-3.5">
        <span className="rounded-[5px] bg-brand-tint-soft px-2 py-[3px] font-mono text-[10px] uppercase tracking-[.11em] text-brand-ink">
          {section.num} · {section.title}
        </span>
        {section.meta && <span className="font-mono text-[11px] text-ink-muted">{section.meta}</span>}
        <span className="flex-1" />
        {onGoQuestions && (
          <button
            onClick={onGoQuestions}
            className="h-[30px] shrink-0 rounded-[9px] border border-accent-edge bg-accent-tint px-3.5 text-[12px] font-semibold text-[#3a2b85] transition-colors hover:bg-accent-tint-soft"
          >
            {answered}/{total} soru cevaplandı · sorulara geç →
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4.5 overflow-auto px-7 py-6">
        {/* Başlık serbest metin (özet bölümünde `doc.summary`) ve paragraf
            uzunluğunda gelebiliyor; başlık ölçüsünde çizilince kutudan
            sarkıyordu. Üç satırda kırpılır, tamamı tooltip'te. */}
        <Clamp
          as="h3"
          lines={3}
          text={section.head}
          className="max-w-[34ch] text-[19px] font-semibold leading-[1.3] tracking-[-.015em] text-ink"
        />
        {section.lead && (
          <p className="aht-wrap max-w-[70ch] text-[15px] leading-[1.75] text-ink-body text-pretty">
            {section.lead}
          </p>
        )}
        {section.blocks.map((b, i) => (
          <Block key={`${b.head}-${i}`} block={b} />
        ))}
      </div>
    </div>
  );
}

function Block({ block: b }: { block: DocBlock }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-edge bg-[#fbfdfc] px-4.5 py-4">
      {b.head && (
        <div className="flex items-start gap-2.5">
          {/* Safha başlığı da serbest metin — iki satırda kırpılır. */}
          <Clamp
            as="h4"
            lines={2}
            text={b.head}
            className="min-w-0 flex-1 text-[15px] font-semibold leading-[1.35] text-ink"
          />
          {b.tag && (
            <span
              className={`shrink-0 rounded-[5px] px-2 py-[3px] font-mono text-[10px] uppercase tracking-[.06em] ${
                TAG_TONES[b.tag] ?? "bg-chip text-ink-muted"
              }`}
            >
              {b.tag}
            </span>
          )}
        </div>
      )}
      {b.body && (
        <p className="aht-wrap max-w-[72ch] text-[14px] leading-[1.75] text-ink-body text-pretty">{b.body}</p>
      )}
      {b.lines.map((l, i) => (
        <div key={`${l.title}-${i}`} className="flex items-start gap-2.5">
          <span
            className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-[10.5px] font-semibold ${MARK_TONES[l.mark]}`}
          >
            {l.mark}
          </span>
          <div className="flex min-w-0 max-w-[68ch] flex-col gap-[3px]">
            <span className="aht-wrap text-[14px] font-medium leading-[1.45] text-ink">{l.title}</span>
            {l.note && (
              <span className="aht-wrap text-[13px] leading-[1.7] text-ink-muted text-pretty">{l.note}</span>
            )}
          </div>
        </div>
      ))}
      {b.chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {b.chips.map((c) => (
            <span
              key={c}
              className="rounded-[7px] border border-edge bg-chip px-2.5 py-1 font-mono text-[11px] text-ink-muted"
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
