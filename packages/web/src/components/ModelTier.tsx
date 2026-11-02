import { MODEL_TIER_ORDER, type ModelTier, type ProjectProfile } from "@ahtapot/shared";

import { TIER_TR } from "./GatePanels";

type Ladder = ProjectProfile["agents"]["triage"]["ladder"];

/**
 * İşe zorlanacak model seviyesi — "Profil" + dört basamak.
 *
 * Seviye seçilir, model adı değil: ad profilin merdiveninden gelir ve her
 * düğmenin altında yazılı, insan neyi seçtiğini görür. Merdivende olmayan
 * basamak kapalıdır (sunucu da reddeder). Soldan sağa ucuzdan pahalıya —
 * `TierPicker` ile aynı gerekçe.
 */
export function ModelTierPicker({
  value,
  onChange,
  ladder,
  disabled = false,
  nullOption = { label: "Profil", sub: "triage / rol ayarı" },
}: {
  value: ModelTier | null;
  onChange: (tier: ModelTier | null) => void;
  ladder: Ladder | undefined;
  disabled?: boolean;
  /** `null` seçeneğinin adı — safha seçicide "elle seçimi kaldır" anlamına gelir. */
  nullOption?: { label: string; sub: string };
}) {
  const option = (key: string, on: boolean, label: string, sub: string, tone: string, pick: () => void, off = false) => (
    <button
      key={key}
      type="button"
      disabled={disabled || off}
      onClick={pick}
      className={`flex min-w-[88px] flex-1 flex-col items-start rounded-[9px] border px-2.5 py-1.5 text-left transition-colors disabled:opacity-40 ${
        on ? `border-brand ${tone}` : "border-edge bg-surface hover:bg-raised"
      }`}
    >
      <span className="text-[12.5px] font-semibold text-ink">{label}</span>
      <span className="truncate font-mono text-[10.5px] text-ink-muted">{sub}</span>
    </button>
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {option("profile", value === null, nullOption.label, nullOption.sub, "bg-raised", () => onChange(null))}
      {MODEL_TIER_ORDER.map((t) => {
        const rung = ladder?.[t];
        const tr = TIER_TR[t] ?? { label: t, tone: "" };
        return option(t, value === t, tr.label, rung ? rung.model : "tanımsız", tr.tone, () => onChange(t), !rung);
      })}
    </div>
  );
}

/** Seçimin tek satırlık özeti — kartlarda ve diyalog notunda. */
export function tierSummary(tier: ModelTier | null, ladder: Ladder | undefined): string {
  if (!tier) return "profil ayarı";
  const rung = ladder?.[tier];
  return `${TIER_TR[tier]?.label ?? tier}${rung ? ` · ${rung.model} (effort ${rung.effort})` : ""}`;
}
