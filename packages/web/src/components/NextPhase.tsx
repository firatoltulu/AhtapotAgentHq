import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ModelTier, NextPhaseView, ProjectProfile } from "@ahtapot/shared";

import { api, type Approval } from "../api";
import { ErrorText } from "../ui";
import { TIER_TR } from "./GatePanels";
import { ModelTierPicker } from "./ModelTier";

type Ladder = ProjectProfile["agents"]["triage"]["ladder"];

/**
 * Safha kapısındaki sıradaki safha — yalnız safha kapısı açıkken sorgulanır.
 *
 * Anahtar kapı kimliğini taşır: her safha onayı yeni bir kapı açar ve
 * "sıradaki" değişir. Model seçimi kapıyı değiştirmediği için o yol ayrıca
 * tazeler (`NextPhaseCard`).
 */
export function useNextPhase(jobId: string, gate: Approval | null | undefined) {
  const gateId = gate?.kind === "phase" ? gate.id : null;
  return useQuery({
    queryKey: ["nextPhase", jobId, gateId],
    queryFn: () => api.nextPhase(jobId),
    enabled: gateId !== null,
    select: (r) => r.next,
  });
}

/** "claude-sonnet-4-6" → "sonnet-4-6": çipte model ailesi yeter. */
export function shortModel(m: string): string {
  return m.replace(/^claude-/, "");
}

/** Modeli kimin belirlediği — insan "neden bu model" sorusunu buradan okur. */
function sourceLabel(n: NextPhaseView): string {
  switch (n.model.source) {
    case "forced":
      return "iş geneli zorlama";
    case "phase":
      return n.phaseTierSource === "human" ? "bu safha için elle seçildi" : "safha ölçümü";
    case "postplan":
      return "plan triage önerisi";
    case "role":
      return "profil rolü";
  }
}

/**
 * Sıradaki safha kartı: plan ayrıntısı + koşacağı model + seçici.
 *
 * NEDEN SAFHA KAPISINDA: 48 safhalı bir planda modele yalnız plan kapısında
 * karar verilebiliyordu. Fable seçilince günlük kota planın ortasında bitti;
 * insanın "bundan sonrası Sonnet'le" diyebileceği yer, her safhada zaten
 * durduğu bu kapı. Seçim kapıyı KAPATMAZ — hemen kaydedilir, onay sıradaki
 * safhayı o modelle başlatır.
 *
 * "Kalanların hepsi" kapsamı: tek tek 36 safhayı seçmek pratik değil. İş
 * geneli zorlamadan (`JobModelCard`) farkı yalnız Developer'ı etkilemesi ve
 * sonraki kapılarda safha safha geri alınabilmesi.
 */
export function NextPhaseCard({
  jobId,
  gate,
  ladder,
  total,
}: {
  jobId: string;
  gate: Approval | null;
  ladder: Ladder | undefined;
  /** Plandaki toplam safha sayısı — "13/48" için. */
  total: number;
}) {
  const qc = useQueryClient();
  const q = useNextPhase(jobId, gate);
  const [scope, setScope] = useState<"one" | "rest">("one");
  const set = useMutation({
    mutationFn: (v: { orders: number[]; tier: ModelTier | null }) =>
      api.overridePhaseTiers(jobId, { overrides: v.orders.map((order) => ({ order, tier: v.tier })), comment: "" }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["nextPhase", jobId] });
      void qc.invalidateQueries({ queryKey: ["plan", jobId] });
    },
  });

  // İş geneli zorlama safha seçimini önceler; kaldırılmadıkça seçici etkisiz.
  const unforce = useMutation({
    mutationFn: () => api.setModelTier(jobId, null),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["nextPhase", jobId] });
      void qc.invalidateQueries({ queryKey: ["job", jobId] });
    },
  });

  if (gate?.kind !== "phase") return null;
  const n = q.data;
  if (q.isLoading) return null;
  if (!n) {
    if (q.error) return <ErrorText error={q.error} />;
    // Son safhanın kapısı: sırada safha yok, onay build/QA'ya geçirir.
    return null;
  }

  const tier = n.model.tier ? TIER_TR[n.model.tier] : undefined;
  const value = n.phaseTierSource === "human" ? n.phaseTier : null;
  const rest = n.pendingOrders.length;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-wait-edge bg-wait-tint px-[17px] py-[15px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] tracking-[.06em] text-wait-ink uppercase">
          Sıradaki safha · {n.order + 1}/{total || "?"}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-ink-muted">
          {n.files.length} dosya · risk {n.risk}
          {n.exceedsFileCap && " · tavan aşımı"}
        </span>
      </div>
      <span className="text-[15px] font-semibold text-ink">{n.title}</span>
      {n.rationale && <p className="aht-wrap text-[13px] leading-[1.6] text-ink-soft text-pretty">{n.rationale}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase">Dokunacağı dosyalar</span>
          {n.files.length > 0 ? (
            n.files.map((f) => (
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
          {n.acceptance.length > 0 ? (
            n.acceptance.map((c) => (
              <span key={c} className="flex gap-2 text-[13px] leading-normal text-ink-body">
                <span className="font-mono text-[11px] text-ok-ink">□</span>
                <span className="aht-wrap min-w-0">{c}</span>
              </span>
            ))
          ) : (
            <span className="text-[12.5px] text-ink-muted">Bu plan sürümünde kabul kriteri yazılmamış.</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-wait-edge pt-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase">Koşacak model</span>
          {tier && <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium ${tier.tone}`}>{tier.label}</span>}
          <span className="font-mono text-[12px] text-ink">{shortModel(n.model.model)}</span>
          <span className="text-[12px] text-ink-muted">effort {n.model.effort}</span>
          <span className="text-[12px] text-ink-muted">· {sourceLabel(n)}</span>
        </div>

        {n.model.source === "forced" && (
          <p className="text-[12px] font-medium text-wait-ink">
            İşe model zorlaması var; o sürdükçe safha seçimi uygulanmaz (QA ve DevOps da zorlanan modelle koşar).{" "}
            <button
              type="button"
              disabled={unforce.isPending}
              onClick={() => unforce.mutate()}
              className="font-semibold underline disabled:opacity-50"
            >
              Zorlamayı kaldır
            </button>
          </p>
        )}

        {rest > 1 && (
          <div className="flex w-fit rounded-[9px] border border-edge-strong bg-surface p-[3px]">
            {(
              [
                ["one", "Yalnız bu safha"],
                ["rest", `Kalan ${rest} safhanın hepsi`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setScope(k)}
                aria-pressed={scope === k}
                className={`rounded-md px-2.5 py-[5px] text-[12px] ${
                  scope === k ? "bg-accent-tint font-semibold text-accent-ink" : "text-ink-soft hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <ModelTierPicker
          value={value}
          ladder={ladder}
          disabled={set.isPending}
          nullOption={{ label: "Otomatik", sub: "ölçüm / plan önerisi" }}
          onChange={(t) => {
            // Tek safhada aynı seçime tıklamak isteksiz bir tur olurdu; toplu
            // kapsamda ise sonraki safhalar farklı olabilir, istek gider.
            if (scope === "one" && t === value) return;
            set.mutate({ orders: scope === "rest" ? n.pendingOrders : [n.order], tier: t });
          }}
        />
        <p className="text-[12px] leading-relaxed text-ink-soft">
          Seçim hemen kaydedilir, kapı açık kalır. Bu safhayı onayladığında sıradaki safha seçilen modelle başlar.
          Yalnız Developer'ı etkiler; QA ve DevOps kendi ayarıyla koşar.
        </p>
        <ErrorText error={set.error ?? unforce.error} />
      </div>
    </div>
  );
}
