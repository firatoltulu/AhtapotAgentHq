import { useMemo, useState } from "react";

import { Button, ErrorText } from "../ui";
import { normalize } from "./questions";

/**
 * Açık soru sihirbazı.
 *
 * Sorular düz metin listesiydi ve cevaplanamıyordu; ölçüldü (Collection işi):
 * Planner 12 soru üretti, çoğu şıklıydı, bazıları planın şeklini değiştiriyordu.
 * Tek tek gezdirmenin sebebi uzunluk: o sorular birer paragraf, yan yana
 * dizilince hiçbiri okunmuyor.
 *
 * Cevaplar biriktirilip TEK turda gönderilir — her cevap için ayrı bir Planner
 * turu hem pahalı olurdu hem de sonraki soruların cevabını eskitirdi.
 */
export function QuestionWizard({
  questions: raw,
  onSubmit,
  pending,
  error,
}: {
  questions: unknown;
  onSubmit: (answers: { question: string; answer: string }[], comment: string) => void;
  pending: boolean;
  /** Gönderim reddedildiyse sebebi. Sessiz başarısızlık "hiçbir şey olmadı" gibi görünüyordu. */
  error?: unknown;
}) {
  const questions = useMemo(() => normalize(raw), [raw]);
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [comment, setComment] = useState("");
  /** Hangi sorularda "Diğer" açık — şıklı soruda input yalnız o zaman görünür. */
  const [other, setOther] = useState<Record<string, boolean>>({});

  const q = questions[Math.min(at, Math.max(0, questions.length - 1))];
  const answered = useMemo(() => questions.filter((x) => (answers[x.question] ?? "").trim().length > 0).length, [questions, answers]);
  const blocking = useMemo(() => questions.filter((x) => x.blocksPlan), [questions]);
  const blockingLeft = useMemo(
    () => blocking.filter((x) => !(answers[x.question] ?? "").trim()).length,
    [blocking, answers],
  );

  if (!q) return null;

  const current = answers[q.question] ?? "";
  // Cevap şıklardan biri değilse serbest yazılmıştır: "Diğer" seçili sayılır.
  const isOther = (other[q.question] ?? false) || (current.length > 0 && !q.options.includes(current));

  function record(value: string): void {
    if (!q) return;
    setAnswers((prev) => ({ ...prev, [q.question]: value }));
    setDraft("");
    setOther((prev) => ({ ...prev, [q.question]: false }));
    if (at < questions.length - 1) setAt(at + 1);
  }

  function send(): void {
    const payload = questions
      .map((x) => ({ question: x.question, answer: (answers[x.question] ?? "").trim() }))
      .filter((x) => x.answer.length > 0);
    if (payload.length > 0) onSubmit(payload, comment);
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-wait-edge bg-wait-tint px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[.06em] text-wait-ink">
          Açık soru {at + 1}/{questions.length}
        </span>
        {q.blocksPlan && (
          <span className="rounded-[5px] bg-err-tint px-1.5 py-0.5 font-mono text-[10px] font-semibold text-err-text">
            planı değiştirir
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-muted">{answered} cevaplandı</span>
      </div>

      {/* Gezinme: soruları atlayabilmek gerek — biri diğerinin cevabını belirliyor olabilir. */}
      <div className="flex flex-wrap gap-1">
        {questions.map((x, i) => {
          const done = (answers[x.question] ?? "").trim().length > 0;
          return (
            <button
              key={x.question}
              onClick={() => setAt(i)}
              title={x.question.slice(0, 120)}
              className={`h-[22px] w-[22px] rounded-[5px] font-mono text-[10px] transition-colors ${
                i === at
                  ? "bg-brand text-white"
                  : done
                    ? "bg-brand-tint-soft text-brand-ink"
                    : x.blocksPlan
                      ? "bg-err-tint text-err-text"
                      : "bg-chip text-ink-muted"
              }`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <p className="aht-wrap text-[13px] font-medium leading-[1.7] text-ink">{q.question}</p>

      {q.context && (
        <details className="rounded-[9px] border border-edge bg-surface px-3 py-2">
          <summary className="cursor-pointer text-[12px] text-ink-muted">Gerekçe ve ölçümler</summary>
          <p className="aht-wrap mt-1.5 text-[12px] leading-[1.7] text-ink-body">{q.context}</p>
        </details>
      )}

      {q.assumption && (
        <p className="text-[12px] leading-relaxed text-ink-muted">
          <span className="font-semibold">Cevaplamazsan:</span> {q.assumption}
        </p>
      )}

      {q.options.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {q.options.map((o) => (
            <button
              key={o}
              onClick={() => record(o)}
              className={`aht-wrap rounded-[9px] border px-3 py-2 text-left text-[12.5px] leading-relaxed transition-colors ${
                current === o
                  ? "border-brand bg-brand-tint-soft text-brand-ink"
                  : "border-edge-control bg-surface text-ink-body hover:border-brand"
              }`}
            >
              {o}
              {o === q.recommended && (
                <span className="ml-2 font-mono text-[10px] text-ink-muted">· Planner önerisi</span>
              )}
            </button>
          ))}
          {/* "Diğer" de bir şık: şıklar arasında dolaşırken serbest cevap
              görünmez bir metin kutusuna değil, seçilebilir bir seçeneğe karşılık
              gelsin. Seçiliyse input açılır. */}
          <button
            onClick={() => {
              setOther((prev) => ({ ...prev, [q.question]: true }));
              setDraft(isOther ? current : "");
            }}
            className={`aht-wrap rounded-[9px] border px-3 py-2 text-left text-[12.5px] leading-relaxed transition-colors ${
              isOther
                ? "border-brand bg-brand-tint-soft text-brand-ink"
                : "border-edge-control bg-surface text-ink-body hover:border-brand"
            }`}
          >
            Diğer…
          </button>
        </div>
      )}

      {/* Şıksız soruda input her zaman; şıklıda yalnız "Diğer" seçiliyken. */}
      {(q.options.length === 0 || isOther) && (
        <div className="flex gap-2">
          <input
            autoFocus={isOther}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) record(draft.trim());
            }}
            placeholder="Cevabın"
            className="h-9 flex-1 rounded-[9px] border border-edge-control bg-surface px-3 text-[13px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none"
          />
          <Button size="md" disabled={!draft.trim()} onClick={() => record(draft.trim())}>
            Kaydet
          </Button>
        </div>
      )}

      {current && (
        <p className="aht-wrap text-[12px] text-ink-muted">
          <span className="font-semibold text-ink-body">Cevabın:</span> {current}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-wait-edge pt-3">
        <Button size="md" variant="ghost" disabled={at === 0} onClick={() => setAt(at - 1)}>
          ← Önceki
        </Button>
        <Button size="md" variant="ghost" disabled={at >= questions.length - 1} onClick={() => setAt(at + 1)}>
          Sonraki →
        </Button>
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Ek not (isteğe bağlı)"
          className="h-9 min-w-[160px] flex-1 rounded-[9px] border border-edge-control bg-surface px-3 text-[13px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none"
        />
        <Button size="md" variant="primary" disabled={answered === 0 || pending} onClick={send}>
          {pending ? "Gönderiliyor…" : `${answered} cevabı gönder`}
        </Button>
      </div>

      <ErrorText error={error} />

      {blockingLeft > 0 && (
        <p className="text-[12px] text-err-text">
          {blockingLeft} soru planın şeklini değiştiriyor ve cevapsız — onaylamadan önce cevaplayın,
          yoksa onayladığınız plan yeniden yazılacak.
        </p>
      )}
    </div>
  );
}
