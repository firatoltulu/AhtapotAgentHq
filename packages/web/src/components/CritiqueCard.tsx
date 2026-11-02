import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CritiqueFinding, CritiqueSubject } from "@ahtapot/shared";

import { api, type CritiqueRow } from "../api";
import { Badge, Button, ErrorText, fmtClock, type Tone } from "../ui";

/**
 * İkinci göz (karar §42) — planı ya da senaryo listesini başka bir modelin
 * eleştirisi. DANIŞMANDIR: kapıyı bekletmez, bulgu Planner'a kendiliğinden
 * gitmez. İnsan işaretlediği bulguları red gerekçesine taşır.
 *
 * Konuya ait satır yoksa kart HİÇ çizilmez: profil bayrağı kapalıdır ve
 * söylenecek bir şey yoktur.
 */

const KIND_TR: Record<CritiqueFinding["kind"], string> = {
  missing_requirement: "atlanan istek",
  unrequested_scope: "istenmemiş kapsam",
  hidden_assumption: "sessiz varsayım",
  ambiguity: "belirsizlik",
  uncovered_requirement: "karşılanmayan gereksinim",
  missing_edge_case: "eksik sınır durumu",
  wrong_expectation: "yanlış beklenti",
  other: "diğer",
};

const STATUS: Record<CritiqueRow["status"], { label: string; tone: Tone }> = {
  running: { label: "inceleniyor", tone: "run" },
  ready: { label: "hazır", tone: "ok" },
  failed: { label: "koşamadı", tone: "err" },
  skipped: { label: "atlandı", tone: "off" },
};

/** Red gerekçesine giden satır — bulgunun kimliği de bu metin. */
export function critiqueNote(f: CritiqueFinding): string {
  const ref = f.ref ? ` · ${f.ref}` : "";
  const fix = f.suggestion ? ` — öneri: ${f.suggestion}` : "";
  return `[İkinci göz · ${KIND_TR[f.kind]}${ref}] ${f.text}${fix}`;
}

export function CritiqueCard({
  jobId,
  subject,
  subjectId,
  picks,
  onPicks,
}: {
  jobId: string;
  subject: CritiqueSubject;
  subjectId: string;
  /** İşaretli bulgular (`critiqueNote` metni). */
  picks?: string[];
  /** Yoksa işaretlenemez: kapı yok ya da geçmiş sürüm. */
  onPicks?: (items: string[]) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["critiques", jobId],
    queryFn: () => api.critiques(jobId),
    // Olay (`critique.updated`) tazeler; olay kaçarsa yoklama yakalar.
    refetchInterval: (query) => (query.state.data?.critiques.some((c) => c.status === "running") ? 4000 : false),
  });
  const rerun = useMutation({
    mutationFn: () => api.requestCritique(jobId, subject, subjectId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["critiques", jobId] }),
  });

  const latest = q.data?.critiques.find((c) => c.subject === subject && c.subjectId === subjectId);

  // Seçim kapıya bağlı, eleştiri ise yeniden incelemeyle yenilenir: eski
  // satırın bulgusu yeni belgede yoksa red gerekçesine sızmasın. Yeni satır
  // hazır değilken seçim boşalır.
  const allowed = latest?.status === "ready" && latest.document ? latest.document.findings.map(critiqueNote) : [];
  // JSON: bulgu metni satır sonu taşıyabilir, düz birleştirme bölünürdü.
  const allowedKey = JSON.stringify(allowed);
  useEffect(() => {
    if (!onPicks || !picks || picks.length === 0 || !latest) return;
    const ok = new Set(JSON.parse(allowedKey) as string[]);
    const next = picks.filter((p) => ok.has(p));
    if (next.length !== picks.length) onPicks(next);
  }, [latest?.id, allowedKey, picks, onPicks]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!latest) return null;

  const running = latest.status === "running" || rerun.isPending;
  const doc = latest.status === "ready" ? latest.document : null;
  const picked = new Set(picks ?? []);
  const toggle = (note: string): void => {
    if (!onPicks) return;
    const next = new Set(picked);
    if (next.has(note)) next.delete(note);
    else next.add(note);
    onPicks([...next]);
  };
  const tokens = latest.inputTokens !== null && latest.outputTokens !== null ? latest.inputTokens + latest.outputTokens : null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-edge bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-[13.5px] font-semibold text-ink">İkinci göz</h2>
        <Badge value={running ? STATUS.running.label : STATUS[latest.status].label} tone={running ? "run" : STATUS[latest.status].tone} />
        <span className="font-mono text-[11px] text-ink-muted">
          {latest.model || "model yok"} · {fmtClock(latest.createdAt)}
          {tokens !== null ? ` · ${tokens} token` : ""}
        </span>
        <span className="flex-1" />
        <Button variant="neutral" size="sm" disabled={running} onClick={() => rerun.mutate()}>
          {running ? "inceleniyor…" : "Yeniden incele"}
        </Button>
      </header>

      <p className="text-[12.5px] leading-relaxed text-ink-dim">
        {subject === "plan"
          ? "Başka bir model ham iş tanımını, gereksinimleri ve planı karşılaştırdı. Danışman notudur; karar senin."
          : "Başka bir model gereksinimlerin senaryolarca karşılanmasını denetledi. Danışman notudur; karar senin."}
      </p>

      {running && <p className="text-[13px] text-ink-dim">İnceleniyor; bitince burada görünür.</p>}
      {!running && (latest.status === "failed" || latest.status === "skipped") && (
        <ErrorText error={`İkinci göz ${latest.status === "skipped" ? "koşmadı" : "koşamadı"}: ${latest.error || "bilinmeyen sebep"}`} />
      )}
      {!running && latest.status === "ready" && !doc && <ErrorText error="Kayıtlı eleştiri okunamadı; yeniden incele." />}
      <ErrorText error={rerun.error ?? q.error} />

      {!running && doc && doc.findings.length === 0 && (
        <p className="text-[13px] text-ink-body">Bulgu yok — ham metinle {subject === "plan" ? "plan" : "senaryolar"} tutarlı görünüyor.</p>
      )}
      {!running && doc && doc.findings.length > 0 && (
        <ul className="flex flex-col gap-2">
          {doc.findings.map((f, i) => {
            const note = critiqueNote(f);
            return (
              <li key={i} className="flex gap-2.5 rounded-lg border border-edge bg-raised px-3 py-2">
                {onPicks && (
                  <input
                    type="checkbox"
                    aria-label="red gerekçesine ekle"
                    checked={picked.has(note)}
                    onChange={() => toggle(note)}
                    className="mt-[3px] shrink-0 accent-[var(--color-brand)]"
                  />
                )}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge value={KIND_TR[f.kind]} tone="wait" />
                    {f.ref && <span className="font-mono text-[11px] text-ink-muted">{f.ref}</span>}
                  </span>
                  <p className="aht-wrap text-[13px] leading-[1.6] text-ink-body">{f.text}</p>
                  {f.suggestion && <p className="aht-wrap text-[12.5px] leading-[1.55] text-ink-soft">Öneri: {f.suggestion}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!running && doc?.notes && <p className="aht-wrap text-[12.5px] text-ink-dim">{doc.notes}</p>}
      {onPicks && picked.size > 0 && (
        <p className="text-[12.5px] font-medium text-accent-ink">
          {picked.size} bulgu işaretli — "Reddet"e basınca gerekçeye eklenir.
        </p>
      )}
    </section>
  );
}
