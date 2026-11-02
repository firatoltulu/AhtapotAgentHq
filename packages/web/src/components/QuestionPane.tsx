import { useMemo, useState } from "react";

import { Clamp, ErrorText } from "../ui";
import { splitOption, type Question } from "./questions";

/**
 * Açık soru paneli — plan okumasıyla aynı genişlikte, tek soru.
 *
 * Sorular dar bir kutuda üst üsteydi; her biri birer paragraf olduğu için
 * hiçbiri okunmuyordu. Panel tek soruyu tam genişlikte açar: soru, NEDEN
 * sorulduğu, etkilediği yerler, cevaplanmazsa ne varsayılacağı, sonra şıklar.
 *
 * Şıkkın "sonuç" ve "bedel" satırları `splitOption` ile metinden ayrıştırılır —
 * şema şıkları düz dize tutuyor. Ayrışmazsa şık sade etiket kalır.
 *
 * Cevaplar biriktirilip TEK turda gönderilir: her cevap için ayrı Planner turu
 * hem pahalı olurdu hem sonraki soruların cevabını eskitirdi.
 */
export function QuestionPane({
  questions,
  at,
  answers,
  answered,
  readOnly,
  pending,
  error,
  onAt,
  onAnswer,
  onBackToPlan,
  onSubmit,
}: {
  questions: Question[];
  at: number;
  answers: Record<string, string>;
  answered: number;
  /** Geçmiş plan sürümünde cevap verilemez — panel salt okunur çizilir. */
  readOnly: boolean;
  pending: boolean;
  error?: unknown;
  onAt: (i: number) => void;
  onAnswer: (question: string, value: string) => void;
  onBackToPlan: () => void;
  onSubmit: (answers: { question: string; answer: string }[], comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const q = questions[at];

  const blockingLeft = useMemo(
    () => questions.filter((x) => x.blocksPlan && !(answers[x.question] ?? "").trim()).length,
    [questions, answers],
  );

  if (!q) return null;

  const current = answers[q.question] ?? "";
  const done = current.trim().length > 0;
  const allAnswered = answered === questions.length;

  function send(): void {
    const payload = questions
      .map((x) => ({ question: x.question, answer: (answers[x.question] ?? "").trim() }))
      .filter((x) => x.answer.length > 0);
    if (payload.length > 0) onSubmit(payload, comment);
  }

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-accent-edge bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-accent-edge bg-accent-tint px-5 py-3.5">
        <span className="rounded-[5px] bg-accent px-2 py-[3px] font-mono text-[10px] uppercase tracking-[.11em] text-white">
          soru {at + 1}/{questions.length}
        </span>
        {q.blocksPlan && (
          <span className="rounded-[5px] bg-err-tint px-2 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[.06em] text-err-text">
            planı değiştirir
          </span>
        )}
        <span
          className={`rounded-[5px] px-2 py-[3px] font-mono text-[10px] uppercase tracking-[.06em] ${
            done ? "bg-brand-tint-soft text-brand-ink" : "bg-wait-tint text-wait-ink"
          }`}
        >
          {done ? "cevaplandı" : "açık"}
        </span>
        <span className="flex-1" />
        <button
          onClick={onBackToPlan}
          className="h-[30px] shrink-0 rounded-[9px] border border-edge-strong bg-surface px-3.5 text-[12px] font-medium text-ink-body transition-colors hover:bg-chip"
        >
          ← Plan okumasına dön
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4.5 overflow-auto px-6 py-5.5">
        {/* Soru metni bir paragraf olabiliyor (`split` başlığı kısaltır ama
            garanti etmez); dört satırda kırpılır, tamamı tooltip'te. */}
        <Clamp
          as="h3"
          lines={4}
          text={q.question}
          className="max-w-[52ch] text-[19px] font-semibold leading-[1.35] tracking-[-.015em] text-ink"
        />

        {/* Gerekçe kutusu: neden soruluyor, nereyi etkiliyor, cevaplanmazsa ne olur. */}
        {(q.context || q.assumption) && (
          <div className="flex max-w-[74ch] flex-col gap-2.5 rounded-[11px] border border-edge bg-raised px-4 py-3.5">
            {q.context && (
              <>
                <span className="font-mono text-[10px] uppercase tracking-[.1em] text-ink-muted">
                  Neden soruyorum
                </span>
                <p className="aht-wrap text-[14px] leading-[1.7] text-ink-body text-pretty">{q.context}</p>
              </>
            )}
            {q.assumption && (
              <div className="flex items-start gap-2.5 border-t border-edge pt-2.5">
                <span className="shrink-0 rounded-[5px] bg-wait-tint px-[7px] py-0.5 font-mono text-[10.5px] font-semibold text-wait-ink">
                  cevaplamazsan
                </span>
                <span className="aht-wrap text-[13px] leading-[1.6] text-ink-body text-pretty">
                  {q.assumption}
                </span>
              </div>
            )}
          </div>
        )}

        {q.options.length > 0 && (
          <div className="flex max-w-[74ch] flex-col gap-2.5">
            {q.options.map((o) => (
              <OptionRow
                key={o}
                raw={o}
                selected={current === o}
                recommended={o === q.recommended}
                disabled={readOnly}
                onPick={() => onAnswer(q.question, o)}
              />
            ))}
          </div>
        )}

        {/* Serbest cevap şıkları EZER: insan şıkların hiçbirini istemiyor olabilir. */}
        <div className="flex max-w-[74ch] flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[.1em] text-ink-muted">
            {q.options.length > 0 ? "Kendi cevabınız · seçenekleri ezer" : "Cevabınız"}
          </span>
          <textarea
            rows={3}
            disabled={readOnly}
            value={q.options.includes(current) ? "" : current}
            onChange={(e) => onAnswer(q.question, e.target.value)}
            placeholder="Örn. A ile git ama derleme kırılmasın — eksik alanı build uyarısı olarak bas."
            className="resize-y rounded-[10px] border border-edge-strong bg-surface px-3.5 py-2.5 text-[13.5px] leading-[1.6] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none disabled:bg-chip disabled:text-ink-muted"
          />
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-t border-accent-edge bg-accent-tint px-5 py-3.5">
        <button
          disabled={at === 0}
          onClick={() => onAt(at - 1)}
          className="h-9 rounded-[9px] border border-edge-strong bg-surface px-3.5 text-[13px] font-medium text-ink-body transition-colors hover:bg-chip disabled:text-ink-dim disabled:hover:bg-surface"
        >
          ← Önceki
        </button>
        <button
          disabled={at >= questions.length - 1}
          onClick={() => onAt(at + 1)}
          className="h-9 rounded-[9px] border border-accent-edge bg-accent-tint-soft px-3.5 text-[13px] font-semibold text-[#3a2b85] transition-colors hover:bg-accent-tint disabled:text-ink-dim"
        >
          Sonraki →
        </button>
        <input
          value={comment}
          disabled={readOnly}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Tüm sorulara ek not (isteğe bağlı)"
          className="h-9 min-w-[180px] flex-1 rounded-[9px] border border-edge-strong bg-surface px-3 text-[13px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none disabled:bg-chip"
        />
        <button
          disabled={readOnly || answered === 0 || pending}
          onClick={send}
          className="h-9 rounded-[9px] bg-brand px-4.5 text-[13px] font-semibold text-white transition-colors hover:bg-brand-ink disabled:bg-edge disabled:text-ink-dim"
        >
          {pending
            ? "Gönderiliyor…"
            : allAnswered
              ? `${questions.length} cevabı Planner'a gönder`
              : `${answered} cevabı gönder · ${questions.length - answered} açık`}
        </button>
      </div>

      {(error !== undefined || blockingLeft > 0 || readOnly) && (
        <div className="shrink-0 border-t border-edge px-5 py-2.5">
          <ErrorText error={error} />
          {readOnly && (
            <p className="text-[12px] text-ink-muted">
              Geçmiş plan sürümü — cevap ve onay yalnız güncel sürümde verilir.
            </p>
          )}
          {!readOnly && blockingLeft > 0 && (
            <p className="text-[12px] text-err-text">
              {blockingLeft} soru planın şeklini değiştiriyor ve cevapsız — onaylamadan önce cevaplayın,
              yoksa onayladığınız plan yeniden yazılacak.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Tek şık: etiket + sonuç + bedel. İkincisi ayrışmadıysa yalnız etiket çizilir. */
function OptionRow({
  raw,
  selected,
  recommended,
  disabled,
  onPick,
}: {
  raw: string;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const parts = useMemo(() => splitOption(raw), [raw]);
  // Şıkkın harfi ("A) …") varsa kutuya o yazılır; yoksa seçim işareti.
  const letter = /^([A-E])\)/.exec(parts.label)?.[1] ?? "";
  const label = letter ? parts.label.replace(/^[A-E]\)\s*/, "") : parts.label;

  return (
    <button
      disabled={disabled}
      onClick={onPick}
      className={`flex items-start gap-3 rounded-[11px] border px-4 py-3.5 text-left transition-colors ${
        selected
          ? "border-accent bg-[#f5f2ff] shadow-[0_0_0_1px_var(--color-accent)]"
          : "border-edge-strong bg-surface hover:border-accent-edge"
      } ${disabled ? "cursor-default opacity-70" : ""}`}
    >
      <span
        className={`mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-semibold ${
          selected ? "bg-accent text-white" : "bg-chip text-ink-muted"
        }`}
      >
        {letter || (selected ? "✓" : "·")}
      </span>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          {/* Şık etiketi de serbest metin: `splitOption` ayıramazsa tüm şık
              buraya düşer ve düğmeyi uzatır. */}
          <Clamp lines={2} text={label} className="text-[14px] font-semibold leading-[1.4] text-ink" />
          {recommended && <span className="font-mono text-[10px] text-ink-muted">· Planner önerisi</span>}
        </span>
        {parts.result && (
          <span className="flex items-start gap-2">
            <span className="w-[46px] shrink-0 font-mono text-[10.5px] text-brand-ink">sonuç</span>
            <span className="aht-wrap text-[12.5px] leading-[1.6] text-[#2f6d5c] text-pretty">{parts.result}</span>
          </span>
        )}
        {parts.cost && (
          <span className="flex items-start gap-2">
            <span className="w-[46px] shrink-0 font-mono text-[10.5px] text-wait-ink">bedeli</span>
            <span className="aht-wrap text-[12.5px] leading-[1.6] text-wait-ink text-pretty">{parts.cost}</span>
          </span>
        )}
      </span>
    </button>
  );
}
