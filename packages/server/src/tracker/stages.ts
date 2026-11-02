import type { JobState } from "@ahtapot/shared";

/**
 * İnsana gösterilen aşama — durum makinesinden kaba.
 *
 * Issue okuyan kişi `Building` ile `Developing` arasındaki farkı umursamaz;
 * build döngüsünde etiket her turda değişseydi issue geçmişi gürültüye
 * boğulurdu. Rozet ve etiket AYNI tablodan okur.
 */
export type StageKey = "queued" | "plan" | "develop" | "live" | "qa" | "pr" | "done" | "attention" | "cancelled";

export interface Stage {
  label: string;
  /** Altı haneli hex, `#` yok — GitHub etiket rengi. */
  color: string;
}

export const STAGES: Record<StageKey, Stage> = {
  queued: { label: "Sırada", color: "9ca3af" },
  plan: { label: "Plan", color: "8b5cf6" },
  develop: { label: "Geliştirme", color: "3b82f6" },
  live: { label: "Canlı Test", color: "f59e0b" },
  qa: { label: "QA", color: "06b6d4" },
  pr: { label: "PR", color: "6366f1" },
  done: { label: "Tamam", color: "22c55e" },
  attention: { label: "Dikkat", color: "ef4444" },
  cancelled: { label: "İptal", color: "6b7280" },
};

const BY_STATE: Record<JobState, StageKey> = {
  Draft: "queued",
  Planning: "plan",
  PlanReview: "plan",
  Developing: "develop",
  Building: "develop",
  LiveTest: "live",
  QACases: "qa",
  QA: "qa",
  PRReview: "pr",
  CIWatch: "pr",
  Done: "done",
  NeedsAttention: "attention",
  Cancelled: "cancelled",
};

export function stageOf(state: JobState): StageKey {
  return BY_STATE[state];
}

export function stageLabelName(prefix: string, stage: StageKey): string {
  return `${prefix}: ${STAGES[stage].label}`;
}
