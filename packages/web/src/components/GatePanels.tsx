import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ModelChoice, PlanDocument, PlanGatePayload } from "@ahtapot/shared";

import { Button, Clamp, Dot, Input, fmtTime } from "../ui";
import { api, type Approval, type PlanPhaseRow } from "../api";
import { PlanReader } from "./PlanReader";
import { QuestionWizard } from "./QuestionWizard";

/**
 * Kapı yükü panelleri.
 *
 * Her kapı türünün insanın karar vermek için görmesi gereken farklı bir şeyi
 * var: planda safha listesi, safhada diff + handoff, canlı testte URL, QA'da
 * case listesi, PR'da test sonuçları. Karar düğmeleri banner'da, ayrıntı burada.
 */

/** Kapı yükünden türetilir: satır biçimi tek kaynaktan (shared şeması). */
export type PhaseModelRow = PlanGatePayload["phaseModels"][number];

/** Safha durumunun işareti — tasarımdaki kare kutu. */
const PHASE_MARKS: Record<string, { mark: string; cls: string }> = {
  done: { mark: "✓", cls: "bg-brand-tint-soft text-brand-ink" },
  running: { mark: "▸", cls: "bg-accent-tint-soft text-accent-ink" },
  awaiting_approval: { mark: "!", cls: "bg-wait-tint text-wait-ink" },
  pending: { mark: "·", cls: "bg-chip text-ink-muted" },
};

export function PhaseList({ phases }: { phases: PlanPhaseRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      {phases.map((p) => {
        const m = PHASE_MARKS[p.status] ?? PHASE_MARKS.pending!;
        const gate = p.status === "awaiting_approval";
        return (
          <div
            key={p.id}
            className={`flex flex-col gap-[7px] rounded-xl border px-4 py-3.5 ${
              gate ? "border-wait-edge bg-wait-tint" : "border-edge bg-raised"
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className={`mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[11px] font-semibold ${m.cls}`}>
                {m.mark}
              </span>
              {/* Safha başlığı Planner'ın yazdığı serbest metin: iki satırda
                  kırpılır, tamamı tooltip'te. */}
              <Clamp
                lines={2}
                text={`${p.order + 1} · ${p.title}`}
                className="min-w-0 flex-1 text-[14px] font-semibold text-ink"
              />
              <span className="shrink-0 font-mono text-[11px] text-ink-muted">
                {p.files.length} dosya · risk {p.risk}
                {p.exceedsFileCap && <span className="ml-1 text-wait-ink">· tavan aşımı</span>}
              </span>
            </div>
            {p.rationale && <p className="pl-[26px] text-[12.5px] leading-[1.6] text-ink-muted">{p.rationale}</p>}
            {p.files.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 pl-[26px] font-mono text-[11px] text-ink-muted">
                {p.files.map((f) => <span key={f}>{f}</span>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Plan paneli.
 *
 * İki yerde çiziliyor ve ikisinin yeri aynı değil: Plan SEKMESİ tam yüksekliği
 * alır, orada rail'li okuma ekranı (`PlanReader`) açılır. Kapı banner'ının
 * altındaki dar şeritte ise rail'e yer yok — orada eski yığın düzeni kalır.
 * `reader` bu ayrımı taşır.
 */
/** Seviyenin insan okuyacağı adı ve tonu. */
export const TIER_TR: Record<string, { label: string; tone: string }> = {
  cheap: { label: "ucuz", tone: "bg-ok-tint text-ok-text" },
  standard: { label: "standart", tone: "bg-raised text-ink-body" },
  deep: { label: "derin", tone: "bg-accent-tint text-ink" },
  frontier: { label: "en üst", tone: "bg-wait-tint text-wait-ink" },
};

/**
 * Triage'ın seçtiği model — plan kapısının içinde.
 *
 * Ayrı bir kapı değil bilinçli: insan planı okurken "bunu kim yazacak"
 * sorusunu AYNI ekranda görür. `requiresApproval` ise şerit uyarı tonuna
 * geçer — onay düğmesi yukarıdaki banner'da, karar oraya ait.
 */
export function ModelStrip({ choice }: { choice: ModelChoice }) {
  const tier = TIER_TR[choice.tier] ?? { label: choice.tier, tone: "bg-raised text-ink-body" };
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        choice.requiresApproval ? "border-wait-edge bg-wait-tint" : "border-edge bg-raised"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">
          Geliştirme modeli
        </span>
        <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium ${tier.tone}`}>{tier.label}</span>
        <span className="font-mono text-[12px] text-ink">{choice.model}</span>
        <span className="text-[12px] text-ink-muted">effort {choice.effort}</span>
      </div>
      {choice.requiresApproval && (
        <p className="mt-2 text-[12.5px] font-medium text-wait-ink">
          Bu seviye pahalıdır ve insan onayı gerektirir. Planı onaylarsanız bu modelle çalışılır.
        </p>
      )}
      {choice.rationale && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-body">{choice.rationale}</p>
      )}
    </div>
  );
}

/**
 * Safha başına model tablosu — `stages.perPhase` açıkken.
 *
 * `ModelStrip` iş geneli seçimi gösterir; bu tablo onun kırılımıdır. İkisi
 * birlikte görünür: şerit "varsayılan bu", tablo "ama safhalar şöyle dağılıyor"
 * der. Onay düğmesi yine yukarıdaki banner'da — bu tablo karar DEĞİL, gerekçe.
 */
/** Seviye sırası — seçici bunu çizer, karşılaştırma motorda. */
const TIERS: PhaseModelRow["tier"][] = ["cheap", "standard", "deep", "frontier"];

/**
 * Tek safhanın seviye seçicisi.
 *
 * Dört düğme, açılır liste değil: seçenek sayısı sabit ve dört, ve seçimin
 * PAHALILIK SIRASI bilginin kendisi — açılır listede "ucuz mu pahalı mı"
 * görmek için listeyi açmak gerekirdi. Soldan sağa ucuzdan pahalıya.
 */
export function TierPicker({
  row,
  disabled,
  onPick,
}: {
  row: PhaseModelRow;
  disabled: boolean;
  onPick: (tier: PhaseModelRow["tier"] | null) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {TIERS.map((t) => {
        const on = t === row.tier;
        const tone = TIER_TR[t] ?? { label: t, tone: "" };
        return (
          <button
            key={t}
            type="button"
            disabled={disabled}
            onClick={() => onPick(t)}
            title={tone.label}
            className={`rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50 ${
              on ? tone.tone : "bg-chip text-ink-muted hover:text-ink"
            }`}
          >
            {tone.label}
          </button>
        );
      })}
      {/* Geri al yalnız müdahale varken: motorun ölçümü zaten geçerliyse
          basılacak bir şey yok ve boş düğme tabloyu gürültülendirirdi. */}
      {row.source === "human" && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick(null)}
          title={
            row.derivedTier
              ? `motorun ölçümü: ${TIER_TR[row.derivedTier]?.label ?? row.derivedTier}`
              : "motorun ölçümüne dön"
          }
          className="rounded-[5px] px-1.5 py-0.5 font-mono text-[11px] text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          ↺
        </button>
      )}
    </div>
  );
}

export function PhaseModelTable({ rows, jobId }: { rows: PhaseModelRow[]; jobId?: string }) {
  const qc = useQueryClient();
  /**
   * Hangi safhanın isteği uçuyor — satır bazında kilit.
   *
   * Tek bir `isPending` bayrağı tüm tabloyu kilitlerdi; beş safhalı bir planda
   * ard arda üç düzeltme yapmak istenen normal bir kullanım ve her birinde
   * tablonun tamamının donması gereksiz.
   */
  const [busy, setBusy] = useState<number | null>(null);
  const override = useMutation({
    mutationFn: (v: { order: number; tier: PhaseModelRow["tier"] | null }) =>
      api.overridePhaseTiers(jobId ?? "", { overrides: [v], comment: "" }),
    onSettled: () => {
      setBusy(null);
      // Kapı yükü sunucuda yeniden yazıldı: plan ve kapı listesi tazelenmeli,
      // yoksa tablo eski seviyeyi gösterip onay yeni seviyeyle koşar.
      void qc.invalidateQueries({ queryKey: ["plan", jobId] });
      void qc.invalidateQueries({ queryKey: ["approvals", jobId] });
    },
  });

  if (rows.length === 0) return null;
  const pricey = rows.filter((r) => r.requiresApproval);
  const editable = Boolean(jobId);
  return (
    <div
      className={`rounded-xl border ${
        pricey.length > 0 ? "border-wait-edge bg-wait-tint" : "border-edge bg-raised"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">
          Safha başına model
        </span>
        {editable && (
          <span className="text-[11.5px] text-ink-muted">
            · seviyeye tıklayarak değiştirebilirsiniz
          </span>
        )}
      </div>
      <div className="mt-2 divide-y divide-edge">
        {rows.map((r) => {
          const tier = TIER_TR[r.tier] ?? { label: r.tier, tone: "bg-raised text-ink-body" };
          return (
            <div key={r.order} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <span className="w-5 shrink-0 font-mono text-[12px] text-ink-muted">{r.order + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-body">{r.title}</span>
              {/* İnsan dokunduysa işaretlenir: ikinci turda "bunu ben mi
                  değiştirmiştim yoksa motor mu ölçtü" sorusu kalmasın. */}
              {r.source === "human" && (
                <span className="shrink-0 font-mono text-[10.5px] tracking-[.04em] uppercase text-ink-muted">
                  elle
                </span>
              )}
              {editable ? (
                <TierPicker
                  row={r}
                  disabled={busy !== null}
                  onPick={(t) => {
                    // Aynı seviyeye tıklamak isteksiz bir tur olurdu.
                    if (t === r.tier) return;
                    setBusy(r.order);
                    override.mutate({ order: r.order, tier: t });
                  }}
                />
              ) : (
                <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium ${tier.tone}`}>{tier.label}</span>
              )}
              <span className={`font-mono text-[12px] text-ink ${busy === r.order ? "opacity-50" : ""}`}>{r.model}</span>
              <span className="text-[12px] text-ink-muted">effort {r.effort}</span>
            </div>
          );
        })}
      </div>
      {override.error && (
        <p className="px-4 pt-2 text-[12.5px] text-bad-text">
          {override.error instanceof Error ? override.error.message : "seviye değiştirilemedi"}
        </p>
      )}
      {pricey.length > 0 && (
        <p className="px-4 pb-3 pt-2 text-[12.5px] font-medium text-wait-ink">
          {pricey.length} safha pahalı seviyede ve insan onayı gerektirir. Planı onaylarsanız bu
          modellerle çalışılır.
        </p>
      )}
    </div>
  );
}

export function PlanPanel({
  doc,
  phases,
  jobId,
  reader = false,
  modelChoice,
  phaseModels = [],
}: {
  doc: PlanDocument;
  phases: PlanPhaseRow[];
  jobId?: string;
  reader?: boolean;
  /** Postplan triage koştuysa öneri; yoksa şerit hiç çizilmez. */
  modelChoice?: ModelChoice;
  /** Safha başına seçim; `perPhase` kapalıysa boş gelir ve tablo çizilmez. */
  phaseModels?: PhaseModelRow[];
}) {
  const qc = useQueryClient();
  const answer = useMutation({
    mutationFn: (v: { answers: { question: string; answer: string }[]; comment: string }) =>
      api.answerPlanQuestions(jobId ?? "", v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["plan", jobId] });
      void qc.invalidateQueries({ queryKey: ["job", jobId] });
    },
  });

  if (reader) {
    // Şerit okuma ekranında da görünür ama ÜSTTE: planı okumaya başlamadan
    // önce "bunu kim yazacak" bilinmeli, özellikle pahalı seviye önerildiyse.
    const table = phaseModels.length > 0
      ? <PhaseModelTable rows={phaseModels} {...(jobId ? { jobId } : {})} />
      : null;
    const strip = modelChoice || table ? (
      <div className="flex flex-col gap-3">
        {modelChoice && <ModelStrip choice={modelChoice} />}
        {table}
      </div>
    ) : null;
    const body = (
      <PlanReader
        doc={doc}
        phases={phases}
        {...(jobId ? { jobId } : {})}
        pending={answer.isPending}
        error={answer.error}
        onSubmit={(answers, comment) => answer.mutate({ answers, comment })}
      />
    );
    if (!strip) return body;
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="shrink-0">{strip}</div>
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">{doc.summary}</p>
      {modelChoice && <ModelStrip choice={modelChoice} />}
      {phaseModels.length > 0 && <PhaseModelTable rows={phaseModels} {...(jobId ? { jobId } : {})} />}
      <PhaseList phases={phases} />
      {doc.testStrategy && (
        <div className="rounded-xl border border-edge bg-raised px-4 py-3 text-[12.5px] leading-relaxed text-ink-body">
          <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">Test stratejisi</span>
          <div className="mt-1">{doc.testStrategy}</div>
        </div>
      )}
      {doc.openQuestions.length > 0 && (
        jobId ? (
          <QuestionWizard
            questions={doc.openQuestions}
            pending={answer.isPending}
            error={answer.error}
            onSubmit={(answers, comment) => answer.mutate({ answers, comment })}
          />
        ) : (
          <div className="rounded-xl border border-wait-edge bg-wait-tint px-4 py-3">
            <span className="font-mono text-[11px] tracking-[.06em] uppercase text-wait-ink">Açık sorular</span>
            <ul className="mt-1.5 flex flex-col gap-1 text-[12.5px] text-ink-body">
              {/* Ham kayıtta düz dize olabilir — `q.question` okumak patlar. */}
              {doc.openQuestions.map((q, i) => {
                const text = typeof q === "string" ? q : q.question;
                return <li key={`${i}-${text}`}>· {text}</li>;
              })}
            </ul>
          </div>
        )
      )}
    </div>
  );
}

/** Eski kapı yüklerinde alan yok → isteğe bağlı okunur. */
export interface AcceptanceEvidenceRow {
  index: number;
  criterion: string;
  met: "yes" | "no" | "unknown";
  evidence: string;
  synthesized: boolean;
}

/** Eski kapı yüklerinde alan yok → isteğe bağlı okunur. */
export interface DeviationRow {
  planned: string;
  actual: string;
  reason: string;
  category: "library" | "pattern" | "security" | "architecture" | "implementation" | "unknown";
  impact: "low" | "medium" | "high" | "unknown";
}

export interface PhasePayload {
  title?: string;
  order?: number;
  handoff?: { completedSteps: string[]; keyDecisions: string[]; gotchas: string[]; filesTouched: string[]; synthesized: boolean; acceptanceEvidence?: AcceptanceEvidenceRow[]; deviations?: DeviationRow[] };
  diff?: { stat: string; patch: string; truncated: boolean; untracked: string[] };
  build?: { stepName: string; exitCode: number | null; skipped: boolean; skipReason: string }[];
  /** Safhanın dosya sınırı dışında değişenler (git'ten). Eski yüklerde yok. */
  outOfPlanFiles?: string[];
}

/** Safha kapısının yükü. Sunucudan `unknown` gelir; alanların hepsi isteğe bağlı okunur. */
export function phasePayload(gate: Approval): PhasePayload {
  return (gate.payload ?? {}) as PhasePayload;
}

/**
 * Safha kapısının diff dışı kanıtı: devir notu ve build sonucu.
 *
 * Diff artık Değişiklikler sekmesinin ana panelinde; bu blok dosya ağacının
 * dibinde duruyor. Kararı veren bilgi kapıyla birlikte görünmeli.
 */
export function PhaseEvidence({ gate }: { gate: Approval }) {
  const p = phasePayload(gate);
  const outOfPlan = p.outOfPlanFiles ?? [];
  if (!p.handoff && !(p.build && p.build.length > 0) && outOfPlan.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 px-3.5 py-3">
      {p.handoff && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10.5px] tracking-[.1em] uppercase text-ink-muted">Devir notu</span>
            {/*
              Sentezlenmiş handoff, agent'ın bloğu yazmadığı anlamına gelir —
              üretici taraf güvenilmez, bu bilgi insandan saklanmaz.
            */}
            {p.handoff.synthesized && (
              <span className="rounded-[5px] bg-wait-tint px-2 py-0.5 font-mono text-[10px] text-wait-ink">
                agent yazmadı · diff'ten sentezlendi
              </span>
            )}
          </div>
          <AcceptanceList rows={p.handoff.acceptanceEvidence ?? []} />
          <DeviationList rows={p.handoff.deviations ?? []} />
          <HandoffList label="Yapılan" items={p.handoff.completedSteps} />
          <HandoffList label="Kararlar" items={p.handoff.keyDecisions} />
          <HandoffList label="Tuzaklar" items={p.handoff.gotchas} />
        </div>
      )}

      {outOfPlan.length > 0 && (
        <div className="rounded-[5px] bg-wait-tint px-2.5 py-2 text-[12.5px] leading-relaxed text-wait-ink">
          <span className="font-mono text-[10.5px] tracking-[.1em] uppercase">Plan dışı dosyalar</span>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {outOfPlan.map((f) => <li key={f} className="font-mono text-[11.5px]">· {f}</li>)}
          </ul>
        </div>
      )}

      {p.build && p.build.length > 0 && <BuildSteps steps={p.build} />}
    </div>
  );
}

/** Kabul ölçütleri: `unknown` ve `no` satırları vurgulu — insan onayı bunlara bakarak verir. */
function AcceptanceList({ rows }: { rows: AcceptanceEvidenceRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="text-[12.5px] leading-relaxed">
      <span className="text-ink-muted">Kabul ölçütleri:</span>
      <ul className="mt-0.5 flex flex-col gap-1 text-ink-body">
        {rows.map((r) => (
          <li
            key={r.index}
            className={r.met === "yes" ? "" : "rounded-[5px] bg-err-tint px-2 py-1 text-err-ink"}
          >
            <span className="font-mono text-[10.5px] mr-1.5">
              {r.met === "yes" ? "✓ kanıtlı" : r.met === "no" ? "✗ yapılmadı" : "? bilinmiyor"}
            </span>
            {r.criterion}
            {r.evidence && <div className="pl-3 text-ink-muted">{r.evidence}</div>}
            {r.synthesized && <div className="pl-3 font-mono text-[10px] text-ink-muted">agent bu madde için yazmadı</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Plandan sapmalar. Güvenlik, mimari ya da yüksek etki kırmızı: engel değil, vurgu — kapı zaten insanda. */
function DeviationList({ rows }: { rows: DeviationRow[] }) {
  if (rows.length === 0) return null;
  // Sınıflanmamış sapma da kırmızı: belirsizlik "önemsiz" sayılmaz.
  const hot = (d: DeviationRow) =>
    d.category === "security" || d.category === "architecture" || d.category === "unknown" || d.impact === "high" || d.impact === "unknown";
  return (
    <div className="text-[12.5px] leading-relaxed">
      <span className="text-ink-muted">Plandan sapmalar:</span>
      <ul className="mt-0.5 flex flex-col gap-1 text-ink-body">
        {rows.map((d, i) => (
          <li key={i} className={hot(d) ? "rounded-[5px] bg-err-tint px-2 py-1 text-err-ink" : ""}>
            <span className="font-mono text-[10.5px] mr-1.5">{d.category} · {d.impact}</span>
            <div className="pl-3">Plan: {d.planned}</div>
            <div className="pl-3">Yapılan: {d.actual}</div>
            {d.reason && <div className="pl-3 text-ink-muted">Neden: {d.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HandoffList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="text-[12.5px] leading-relaxed">
      <span className="text-ink-muted">{label}:</span>
      <ul className="mt-0.5 flex flex-col gap-0.5 pl-3 text-ink-body">
        {items.map((s, i) => <li key={i}>· {s}</li>)}
      </ul>
    </div>
  );
}

/** Build adımları — tasarımdaki nokta + komut + not çipleri. */
export function BuildSteps({ steps }: { steps: { stepName: string; exitCode: number | null; skipped: boolean; skipReason: string }[] }) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {steps.map((b) => (
        <div
          key={b.stepName}
          className="flex max-w-full items-center gap-2 rounded-[9px] border border-edge bg-raised px-3 py-2"
        >
          <Dot tone={b.skipped ? "off" : b.exitCode === 0 ? "ok" : "err"} />
          {/* Adım adı ve atlama gerekçesi profilden; ikisi de uzun olabiliyor
              ve çipi satır boyunca uzatıyordu. */}
          <Clamp lines={1} text={b.stepName} className="min-w-0 font-mono text-[11.5px] text-ink-body" />
          <Clamp
            lines={1}
            text={b.skipped ? `atlandı · ${b.skipReason}` : b.exitCode === 0 ? "geçti" : `çıkış ${b.exitCode}`}
            className="min-w-0 shrink font-mono text-[10.5px] text-ink-muted"
          />
        </div>
      ))}
    </div>
  );
}

/** Canlı test kapısı: uygulamayı aç + süre uzat. */
export function LiveTestPanel({
  gate,
  onExtend,
  onRelaunch,
  relaunching,
}: {
  gate: Approval;
  onExtend: (minutes: number) => void;
  onRelaunch: () => void;
  relaunching: boolean;
}) {
  // `apiUrl` İSTEĞE BAĞLI: panel arayüz (UI) portunu birincil gösterir, API
  // ayrı verilirse ikinci bağlantı olarak çıkar. Northwind'de ikisi ayrı port —
  // 5173 Vite, 5080 backend — ve insan panelden girer.
  //
  // `publicUrl` Traefik üzerinden domain adresi (bkz. profildeki
  // `live.traefik`) — sunucuya kurulu bir orkestratörde 127.0.0.1 dışarıdan
  // erişilemez; verilmişse birincil bağlantı budur, appUrl ikinci sırada.
  const p = gate.payload as {
    appUrl: string; apiUrl?: string; publicUrl?: string; round: number; expiresAt: string;
  };
  const primaryUrl = p.publicUrl ?? p.appUrl;
  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">
        Uygulama kendi portunda ve kendi veritabanıyla ayakta. Tarayıcından test et; kusur varsa yorumla reddet,
        Developer düzeltir.
      </p>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-edge bg-raised px-4 py-3.5">
        <a
          href={primaryUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-[34px] shrink-0 items-center rounded-[9px] bg-brand px-4 text-[13px] font-semibold text-white no-underline hover:bg-brand-ink"
        >
          Uygulamayı aç ↗
        </a>
        {p.apiUrl && (
          <a
            href={p.apiUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[34px] shrink-0 items-center rounded-[9px] border border-edge px-4 text-[13px] font-semibold text-ink-body no-underline hover:bg-sunken"
          >
            API ↗
          </a>
        )}
        <span className="font-mono text-[11.5px] text-ink-muted">
          {p.publicUrl ? <>{p.publicUrl} · dahili {p.appUrl}</> : p.appUrl}
          {p.apiUrl && <> · API {p.apiUrl}</>} · tur {p.round} · süre sonu {fmtTime(p.expiresAt)}
        </span>
        <span className="flex-1" />
        <Button variant="neutral" size="sm" onClick={() => onExtend(60)}>
          +60 dk
        </Button>
        {/* Koşan ortam kalktığı andaki yapılandırmayla kalır: profil ya da
            motor değişikliği (ör. Traefik adı, ortam değişkeni) ancak yıkıp
            yeniden kaldırınca geçer. Traefik dosyası da yeniden yazılır. */}
        <Button
          variant="neutral"
          size="sm"
          disabled={relaunching}
          onClick={() => {
            if (confirm("Canlı ortam yıkılıp yeniden kaldırılsın mı? Build zinciri baştan koşar.")) onRelaunch();
          }}
        >
          {relaunching ? "yeniden kalkıyor…" : "Yeniden kaldır"}
        </Button>
      </div>
    </div>
  );
}

export interface QaCaseEdit {
  id: string;
  title: string;
  rationale: string;
  origin: "agent" | "human";
  included: boolean;
}

/**
 * QA case listesi — dahil et/çıkar, kendi case'ini ekle.
 *
 * Liste TAM OLARAK onayla gider: testler yalnız dahil olanlar için yazılır.
 */
export function QaCasesPanel({
  gate,
  value,
  onChange,
}: {
  gate: Approval;
  value: QaCaseEdit[] | null;
  onChange: (v: QaCaseEdit[]) => void;
}) {
  const initial = (gate.payload as { cases: QaCaseEdit[] }).cases;
  const cases = value ?? initial;
  const [title, setTitle] = useState("");

  const add = () => {
    if (!title.trim()) return;
    onChange([...cases, { id: `human-${Date.now()}`, title: title.trim(), rationale: "insan ekledi", origin: "human", included: true }]);
    setTitle("");
  };

  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">
        QA'nın önerdiği case'ler. İstemediğini çıkar, eksik olanı ekle; testler yalnız dahil olanlar için yazılır.
      </p>

      {cases.map((c) => (
        <label
          key={c.id}
          className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors ${
            c.included ? "border-brand-edge bg-brand-tint" : "border-edge-control bg-chip"
          }`}
        >
          <input
            type="checkbox"
            checked={c.included}
            onChange={(e) => onChange(cases.map((x) => (x.id === c.id ? { ...x, included: e.target.checked } : x)))}
            className="mt-0.5 h-[19px] w-[19px] shrink-0 accent-[var(--color-brand)]"
          />
          <span className="min-w-0 flex-1">
            {/* Case başlığı QA'nın ürettiği serbest metin — üç satırda kırpılır,
                tamamı tooltip'te. Kutudan sarkıyordu. */}
            <Clamp
              as="div"
              lines={3}
              text={c.title}
              className={`text-[13.5px] leading-[1.4] ${c.included ? "text-ink" : "text-ink-muted line-through"}`}
            />
            <span className="mt-0.5 block font-mono text-[11px] text-ink-muted">
              {c.origin === "human" ? "insan ekledi" : "QA önerdi"}
              {c.rationale && c.origin === "agent" ? ` · ${c.rationale}` : ""}
            </span>
          </span>
        </label>
      ))}

      <div className="flex gap-2.5">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="yeni case başlığı"
          className="h-[34px]"
        />
        <Button variant="neutral" size="md" onClick={add} disabled={!title.trim()}>
          Ekle
        </Button>
      </div>
      <p className="font-mono text-[11px] text-ink-muted">
        baseline'da kırık testler ayrı gösterilir — agent'ın sorumluluğu değil
      </p>
    </div>
  );
}

/** PR kapısı: test takımı sonuçları. */
/**
 * Merge kapısı: CI yeşil, insan birleştirme ve temizliği onaylıyor.
 *
 * Silinecekler AÇIKÇA sayılır — merge ve dal silme geri alınamaz, insan neyi
 * onayladığını görmeden düğmeye basmamalı.
 */
/**
 * Engel kapısı: agent "bunu ben çözemem" dedi, insan ne yapılacağına karar
 * veriyor.
 *
 * Diğer panellerden farklı olarak burada asıl bilgi KARARIN KENDİSİ değil,
 * kararın gerekçesi: agent'ın teşhisi tam metin olarak görünür. Kısaltılmaz —
 * "yetkim dışında" diyen bir cümlenin yarısı hiçbir şey anlatmaz.
 */
export function BlockedPanel({ gate }: { gate: Approval }) {
  const p = gate.payload as {
    state: string;
    role: string;
    blockers: { what: string; why: string; needsRole: string; refs: string[] }[];
    results: { suiteId: string; passed: number; total: number; failed: number; failedNames: string[] }[];
  };
  const blockers = p.blockers ?? [];
  const red = (p.results ?? []).filter((r) => r.failed > 0);
  const toDeveloper = blockers.filter((b) => b.needsRole === "developer");

  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">
        <strong>{p.role}</strong> rolü {blockers.length} maddeyi kendi yetkisiyle çözemedi.{" "}
        {toDeveloper.length > 0
          ? <>Onay bunları <strong>Developer'a</strong> gönderir (plana düzeltme safhası eklenir); red engeli yok sayar ve akış olduğu gibi sürer.</>
          : <>Hiçbiri bir agent'a devredilemiyor — onay işi <strong>insana</strong> bırakır (NeedsAttention); red engeli yok sayar.</>}
      </p>

      <div className="flex flex-col gap-2">
        {blockers.map((b, i) => (
          <div key={i} className="rounded-xl border border-err-edge bg-err-tint px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-err-text/10 px-1.5 py-0.5 font-mono text-[11px] text-err-text">
                → {b.needsRole}
              </span>
              {b.refs.map((r) => (
                <span key={r} className="font-mono text-[11px] text-err-body">{r}</span>
              ))}
            </div>
            {/* `aht-wrap`: uzun dosya yolu/tip adı taşımasın. */}
            <div className="aht-wrap mt-1.5 text-[13.5px] font-semibold leading-[1.6] text-err-text">{b.what}</div>
            {b.why && <div className="aht-wrap mt-1 text-[12.5px] leading-[1.65] text-err-body">{b.why}</div>}
          </div>
        ))}
      </div>

      {red.length > 0 && (
        <div className="rounded-xl border border-edge bg-raised px-4 py-3">
          <div className="text-[13px] font-semibold text-ink">
            Engel yüzünden kırmızı kalan testler — kanıt, hata değil
          </div>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {red.map((r) => (
              <li key={r.suiteId} className="aht-wrap font-mono text-[11.5px] text-ink-muted">
                · {r.suiteId}: {r.failed} kırık
                {r.failedNames.length > 0 && ` — ${r.failedNames.slice(0, 8).join(", ")}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function MergePanel({ gate }: { gate: Approval }) {
  const p = gate.payload as {
    prNumber: number;
    prUrl: string;
    repo: string;
    method: string;
    cleanup: { remoteBranch: boolean; localBranch: boolean; container: boolean };
    checks: { name: string; status: string }[];
    // `id`/`title` eski kapı yüklerinde yok: o kayıtlarda seçim kapalı, liste salt okunur.
    unresolvedBelowThreshold?: { id?: string; path: string; line: number | null; severity: string; title?: string }[];
    ciUnfixed?: string[];
    reviewUnfixed?: string[];
    botChangesRequested?: { author: string; submittedAt: string }[];
  };
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  // Seçilenleri düzelt = merge'ü RED + seçim; sunucu tek tur koşturup kapıyı yeniden açar.
  const fix = useMutation({
    mutationFn: () => api.decide(gate.id, { decision: "reject", comment: "", edits: { fixThreads: picked } }),
    onSuccess: () => {
      // Kapı tipi işin kimliğini taşımıyor; önek eşleşmesiyle hepsi tazelenir.
      void qc.invalidateQueries({ queryKey: ["job"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => alert(`Düzeltme başlatılamadı: ${err instanceof Error ? err.message : String(err)}`),
  });
  const toggle = (id: string): void =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const botBlocks = p.botChangesRequested ?? [];
  const open = p.unresolvedBelowThreshold ?? [];
  const selectable = open.some((t) => t.id);
  const ciUnfixed = p.ciUnfixed ?? [];
  const reviewUnfixed = p.reviewUnfixed ?? [];
  const willRemove = [
    p.cleanup.remoteBranch && "uzak dal (origin)",
    p.cleanup.localBranch && "yerel dal + çalışma ağacı",
    p.cleanup.container && "konteyner + volume + canlı ortam",
  ].filter(Boolean) as string[];

  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">
        CI yeşil. Onay PR'ı <strong>{p.method}</strong> ile birleştirir; red PR'ı açık bırakır.
      </p>
      <a
        href={p.prUrl}
        target="_blank"
        rel="noreferrer"
        className="self-start font-mono text-[12px] text-[#52469a] underline hover:no-underline"
      >
        {p.repo}#{p.prNumber} ↗
      </a>

      <div className="flex flex-col gap-1 rounded-xl border border-edge bg-raised px-4 py-3">
        {p.checks.map((c) => (
          <div key={c.name} className="flex items-center gap-2.5">
            <Dot tone={c.status === "success" ? "ok" : c.status === "failure" ? "err" : "off"} />
            <Clamp lines={1} text={c.name} className="min-w-0 font-mono text-[12px] text-ink" />
            <span className="flex-1" />
            <span className="shrink-0 font-mono text-[11.5px] text-ink-muted">{c.status}</span>
          </div>
        ))}
      </div>

      {(ciUnfixed.length > 0 || reviewUnfixed.length > 0) && (
        <div className="rounded-xl border border-err-edge bg-err-tint px-4 py-3">
          <div className="text-[13px] font-semibold text-err-text">
            DevOps çözemedi — merge edersen bunlar açık kalır
          </div>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {ciUnfixed.map((n) => (
              <li key={`ci-${n}`} className="font-mono text-[11.5px] text-err-body">
                · CI kırmızı: {n}
              </li>
            ))}
            {reviewUnfixed.map((n) => (
              <li key={`rv-${n}`} className="font-mono text-[11.5px] text-err-body">
                · yorum açık: {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      {botBlocks.length > 0 && (
        <div className="rounded-xl border border-edge bg-raised px-4 py-3">
          <div className="text-[13px] font-semibold text-ink">
            Bot değişiklik talebi merge'ü kilitliyor — onay onu kaldırır (dismiss)
          </div>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {botBlocks.map((r) => (
              <li key={r.author} className="font-mono text-[11px] text-ink-muted">
                · {r.author} · {r.submittedAt.slice(0, 16).replace("T", " ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {open.length > 0 && (
        <div className="rounded-xl border border-edge bg-raised px-4 py-3">
          <div className="text-[13px] font-semibold text-ink">
            {open.length} inceleme yorumu hâlâ açık — eşiğin altında kaldığı için ele alınmadı
          </div>
          {selectable && (
            <div className="mt-0.5 text-[12px] text-ink-muted">
              Düzeltilmesini istediklerini seç: merge edilmez, DevOps yalnız bunları tek turda çözer ve kapı yeniden açılır.
            </div>
          )}
          {/* Seçim için hepsi görünmeli: ilk 8 ile kısıtlamak 9. yorumu seçilemez yapardı. */}
          <ul className="mt-1.5 flex max-h-[320px] flex-col gap-1 overflow-y-auto">
            {open.map((t, i) => {
              const id = t.id;
              return (
                <li key={id ?? `${t.path}:${t.line}:${i}`} className="flex items-start gap-2">
                  {id ? (
                    <input
                      type="checkbox"
                      className="mt-[3px] shrink-0"
                      checked={picked.includes(id)}
                      onChange={() => toggle(id)}
                      disabled={fix.isPending}
                    />
                  ) : (
                    <span className="font-mono text-[11px] text-ink-muted">·</span>
                  )}
                  <label className="min-w-0 flex-1" onClick={() => id && !fix.isPending && toggle(id)}>
                    <span className="font-mono text-[11px] text-ink-muted">
                      [{t.severity}] {t.path}:{t.line ?? "?"}
                    </span>
                    {t.title && <Clamp lines={2} text={t.title} className="text-[12px] text-ink-body" />}
                  </label>
                </li>
              );
            })}
          </ul>
          {selectable && (
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={picked.length === 0 || fix.isPending}
                onClick={() => fix.mutate()}
              >
                {fix.isPending ? "Gönderiliyor…" : `Seçilenleri düzelt (${picked.length})`}
              </Button>
              {picked.length > 0 && !fix.isPending && (
                <button type="button" className="text-[12px] text-ink-muted underline" onClick={() => setPicked([])}>
                  seçimi temizle
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {willRemove.length > 0 ? (
        <div className="rounded-xl border border-err-edge bg-err-tint px-4 py-3">
          <div className="text-[13px] font-semibold text-err-text">Merge sonrası silinecek — geri alınamaz</div>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {willRemove.map((w) => (
              <li key={w} className="font-mono text-[11.5px] text-err-body">
                · {w}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="font-mono text-[11.5px] text-ink-muted">temizlik kapalı: hiçbir şey silinmeyecek</div>
      )}
    </div>
  );
}

/** İnceleme tavanı: turlar bitti, eşiği aşan yorumlar hâlâ açık. */
export function ReviewRoundPanel({ gate }: { gate: Approval }) {
  const p = gate.payload as {
    prNumber: number;
    prUrl: string;
    repo: string;
    rounds: number;
    threads: { path: string; line: number | null; severity: string; author: string }[];
  };
  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">
        {p.rounds} düzeltme turundan sonra {p.threads.length} inceleme yorumu hâlâ açık. Onay bir tur daha
        koşturur (yazdığın not Developer'a gider); red yorumları açık bırakıp CI izlemeye geçer.
      </p>
      <a
        href={p.prUrl}
        target="_blank"
        rel="noreferrer"
        className="self-start font-mono text-[12px] text-[#52469a] underline hover:no-underline"
      >
        {p.repo}#{p.prNumber} ↗
      </a>
      <div className="flex flex-col gap-1 rounded-xl border border-edge bg-raised px-4 py-3">
        {p.threads.map((t) => (
          <div key={`${t.path}:${t.line}:${t.author}`} className="flex items-center gap-2.5">
            <Dot tone={t.severity === "critical" ? "err" : t.severity === "major" ? "wait" : "off"} />
            <Clamp lines={1} text={`${t.path}:${t.line ?? "?"}`} className="min-w-0 font-mono text-[12px] text-ink" />
            <span className="flex-1" />
            <span className="shrink-0 font-mono text-[11.5px] text-ink-muted">
              {t.severity} · {t.author}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Güvenlik kapısı: SAST turları bitti, bulgu kaldı ya da bir araç koşamadı. */
export function SecurityPanel({ gate }: { gate: Approval }) {
  const p = gate.payload as {
    rounds: number;
    failed: string[];
    threads: { path: string; line: number | null; severity: string; author: string; body: string }[];
  };
  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">
        {p.rounds} güvenlik düzeltme turundan sonra {p.threads.length} bulgu kaldı
        {p.failed.length > 0 && <> ve {p.failed.length} araç koşamadı</>}. PR henüz açılmadı. Onay bir güvenlik turu
        daha koşturur (yazdığın not Developer'a gider); red kalan bulgularla kod kalitesi denetimine ve PR'a geçer.
      </p>
      {p.failed.length > 0 && (
        <div className="rounded-xl border border-wait-edge bg-wait-tint px-4 py-2.5 text-[12.5px] text-wait-ink">
          Koşamayan: <span className="font-mono">{p.failed.join(", ")}</span> — bu araçların sonucu yok, temiz DEĞİL.
        </div>
      )}
      {p.threads.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-edge bg-raised px-4 py-3">
          {p.threads.map((t, i) => (
            <div key={`${t.path}:${t.line}:${t.author}:${i}`} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2.5">
                <Dot tone={t.severity === "major" || t.severity === "critical" ? "err" : "wait"} />
                <Clamp lines={1} text={`${t.path}:${t.line ?? "?"}`} className="min-w-0 font-mono text-[12px] text-ink" />
                <span className="flex-1" />
                <span className="shrink-0 font-mono text-[11.5px] text-ink-muted">{t.author}</span>
              </div>
              <Clamp lines={2} text={t.body} className="pl-5 text-[12px] text-ink-body" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PrPanel({ gate }: { gate: Approval }) {
  const p = gate.payload as {
    branch: string | null;
    results: { suiteId: string; total: number; passed: number; failed: number; preexistingFailures: string[]; skippedReason: string }[];
  };
  return (
    <div className="flex max-w-[840px] flex-col gap-3">
      <p className="text-[14px] leading-[1.65] text-ink-body">
        Testler yeşil. Onay PR'ı açar; red düzeltme safhası açar.
      </p>
      <div className="font-mono text-[12px] text-ink-muted">dal {p.branch ?? "—"}</div>
      {p.results.map((r) => (
        <div key={r.suiteId} className="flex flex-col gap-1 rounded-xl border border-edge bg-raised px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Dot tone={r.skippedReason ? "off" : r.failed > 0 ? "err" : "ok"} />
            <Clamp lines={1} text={r.suiteId} className="min-w-0 font-mono text-[12px] text-ink" />
            <span className="flex-1" />
            {/* Atlama gerekçesi uzun olabiliyor; iki satırda kırpılır. */}
            <Clamp
              lines={2}
              text={r.skippedReason ? `atlandı — ${r.skippedReason}` : `${r.passed}/${r.total} geçti · ${r.failed} kırık`}
              className="min-w-0 max-w-[60%] shrink-0 text-right font-mono text-[11.5px] text-ink-muted"
            />
          </div>
          {r.preexistingFailures.length > 0 && (
            <div className="pl-[17px] font-mono text-[11px] text-ink-muted">
              önceden kırık: {r.preexistingFailures.join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
