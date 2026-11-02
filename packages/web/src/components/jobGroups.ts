import type { Job } from "../api";
import { isGateState } from "../ui";

/**
 * İşin durum kovası — İşler ekranının filtresi ile iş detayındaki sol ray aynı
 * kuralı okur. İki yerde ayrı yazılınca aynı iş listede "Kırık", rayda
 * "Koşan" görünebilirdi.
 */
export type JobGroup = "wait" | "run" | "err" | "done";

export function isFinished(state: string): boolean {
  return state === "Done" || state === "Cancelled";
}

/**
 * "Seni bekleyen" = insan hamlesi olmadan ilerlemeyen her şey: onay kapıları,
 * cevap bekleyen sorular, başlatılmamış taslak. Kırık faz (`paused`) durumu
 * ezer — kapıda duran ama kırılmış iş önce kırık görünmeli.
 */
export function groupOf(j: Job): JobGroup {
  if (isFinished(j.state)) return "done";
  if (j.state === "NeedsAttention" || j.phase === "paused") return "err";
  if (j.state === "Draft" || isGateState(j.state) || j.phase === "waiting") return "wait";
  return "run";
}
