import { MODEL_TIER_ORDER, type ModelTier } from "@ahtapot/shared";

import type { SchemaFieldProps } from "./types";
import { Button, Input, Select } from "../../ui";

/**
 * `agents.triage.ladder` — `partialRecord(ModelTierSchema, TierRungSchema)`.
 * Anahtarlar SABİT (4 tier, `MODEL_TIER_ORDER`) — genel `record` render'ının
 * "anahtar ekle/çıkar" arayüzü burada yanlış olurdu, satır sayısı hep 4.
 * Bir tier tanımsızsa (partial) "tanımla" butonuyla `TierRungSchema`
 * varsayılanı atanır; hiçbir zaman satır kaybolmaz.
 */

interface TierRung {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

const TIER_LABELS: Record<ModelTier, string> = {
  cheap: "Ucuz",
  standard: "Standart",
  deep: "Derin",
  frontier: "Sınır (frontier)",
};

export function TriageLadderTable({ value, path, onChange }: SchemaFieldProps) {
  const ladder = (value ?? {}) as Partial<Record<ModelTier, TierRung>>;

  function update(tier: ModelTier, patch: Partial<TierRung>) {
    const current = ladder[tier] ?? { model: "", effort: "high" as const };
    onChange(path, { ...ladder, [tier]: { ...current, ...patch } });
  }

  function define(tier: ModelTier) {
    onChange(path, { ...ladder, [tier]: { model: "", effort: "high" } });
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">Model merdiveni</span>
      {MODEL_TIER_ORDER.map((tier) => {
        const rung = ladder[tier];
        return (
          <div key={tier} className="flex items-center gap-2 rounded-lg border border-edge-control p-2">
            <span className="w-[110px] shrink-0 text-[12.5px] text-ink-muted">{TIER_LABELS[tier]}</span>
            {rung ? (
              <>
                {/* `inputClass`taki `w-full` buraya verilen genişliği eziyordu: shrink-0
                    select satırı kaplıyor, model alanı sıfıra iniyordu. Genişlik
                    sarmalayıcıda tutulur. */}
                <div className="min-w-0 flex-1">
                  <Input value={rung.model} onChange={(e) => update(tier, { model: e.target.value })} />
                </div>
                <div className="w-[104px] shrink-0">
                  <Select
                    value={rung.effort}
                    onChange={(e) => update(tier, { effort: e.target.value as TierRung["effort"] })}
                  >
                    {EFFORT_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            ) : (
              <>
                <span className="flex-1 text-[12px] text-ink-dim">tanımsız — fallback kullanılır</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => define(tier)}>
                  tanımla
                </Button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
