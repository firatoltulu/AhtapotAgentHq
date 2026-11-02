import type { JobState } from "@ahtapot/shared";

/**
 * Durum makinesi şeridi.
 *
 * Tasarımın kararı: düğümler arasında boşluk YOK; her düğümün 2px üst kenarı
 * bitişiktir, böylece kenarlar tek bir sürekli ray oluşturur ve renk değişimi
 * ilerlemeyi gösterir. Ayrı bağlayıcı elemana gerek kalmıyor.
 */

export const PIPELINE: JobState[] = [
  "Draft",
  "Planning",
  "PlanReview",
  "Developing",
  "Building",
  "LiveTest",
  "QACases",
  "QA",
  "PRReview",
  "CIWatch",
  "Done",
];

/** Şeritte olmayan durumlar (`NeedsAttention`, `Cancelled`) rayın sonuna ayrı düğüm olarak eklenir. */
const OFF_RAIL: Record<string, "err" | "off"> = { NeedsAttention: "err", Cancelled: "off" };

export function Pipeline({ state, brokenAt }: { state: JobState; brokenAt?: JobState | undefined }) {
  // Kırıldığı düğüm rayda biliniyorsa iş O düğümde kırmızı durur: operatör
  // "nerede kırıldı"yı sondaki ayrı `NeedsAttention` düğümünden okuyamıyordu.
  const brokenIdx = state === "NeedsAttention" && brokenAt ? PIPELINE.indexOf(brokenAt) : -1;
  const derail = brokenIdx >= 0 ? undefined : OFF_RAIL[state];
  const idx = brokenIdx >= 0 ? brokenIdx : PIPELINE.indexOf(state);

  /**
   * Kırılma düğümü bilinmiyorsa (geçiş kaydı yok ya da ray dışından gelinmiş)
   * ray nötr kalır ve durum sonda ayrı düğümle gösterilir; yanlış bir düğümü
   * "şimdiki" işaretlemekten iyidir.
   */
  return (
    <div className="flex items-stretch gap-0">
      {PIPELINE.map((s, i) => {
        const done = !derail && i < idx;
        const active = !derail && i === idx;
        const broken = active && brokenIdx >= 0;

        const rail = broken ? "border-t-err" : active ? "border-t-ok" : done ? "border-t-brand-done" : "border-t-edge-strong";
        const text = broken
          ? "font-semibold text-err-text"
          : active
            ? "font-semibold text-ok-ink"
            : done
              ? "text-brand-done-ink"
              : "text-gutter";
        const bg = broken ? "bg-err-tint" : active ? "bg-brand-tint" : "";

        return (
          <div
            key={s}
            title={broken ? `${s} adımında durdu (NeedsAttention)` : s}
            className={`min-w-0 flex-1 truncate border-t-2 px-[3px] py-1.5 text-center font-mono text-[10.5px] tracking-[.02em] ${rail} ${text} ${bg}`}
          >
            {broken ? `${s} ✕` : s}
          </div>
        );
      })}
      {derail && (
        <div
          className={`min-w-0 flex-1 truncate border-t-2 px-[3px] py-1.5 text-center font-mono text-[10.5px] font-semibold tracking-[.02em] ${
            derail === "err" ? "border-t-err bg-err-tint text-err-text" : "border-t-edge-strong bg-chip text-off-ink"
          }`}
        >
          {state}
        </div>
      )}
    </div>
  );
}
