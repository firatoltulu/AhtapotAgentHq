import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Dot, type Tone } from "../ui";

/**
 * Dikkat yuvası: başlığın altındaki TEK kart.
 *
 * Kapı, hata ve "koşuyor" bilgisi eskiden üç ayrı şerit olarak üst üste
 * biniyordu. Aynı anda birden fazlası görünüyor ve hangisinin karar beklediği
 * belli olmuyordu. Artık öncelik sırasıyla (kapı › hata › koşuyor) yalnız biri
 * çizilir ve kararı veren kanıt özeti de kartın içinde durur. Mantık
 * çağıranda; burası yalnız sunum.
 */

/** Kapı türünün insan okuyacağı adı ve onay düğmesinin metni. */
export const GATE_LABELS: Record<string, { title: string; approve: string; reject?: string }> = {
  plan: { title: "Plan onayı", approve: "Planı onayla" },
  phase: { title: "Safha onayı", approve: "Onayla ve sonraki safhaya geç" },
  live_test: { title: "Canlı test onayı", approve: "Test geçti, onayla" },
  qa_cases: { title: "QA case listesi", approve: "Listeyi onayla" },
  pr_open: { title: "PR onayı", approve: "Onayla" },
  pr_merge: { title: "Merge onayı", approve: "Merge et ve temizle" },
  // Bu kapıda "Onayla/Reddet" anlamsız: soru "ne yapayım?". Onay = engeli
  // çözecek role gönder, red = engeli yok say ve akışı sürdür.
  blocked: { title: "Agent engele takıldı — ne yapılsın?", approve: "Developer'a gönder", reject: "Engeli yok say" },
  review_round: { title: "İnceleme yorumları hâlâ açık", approve: "Bir tur daha", reject: "CI'a geç" },
  security: { title: "Güvenlik bulguları kaldı (PR öncesi)", approve: "Bir güvenlik turu daha", reject: "Kalanlarla devam et" },
};

export type AttentionTone = "gate" | "err" | "run" | "off";

const CARD: Record<AttentionTone, { card: string; edge: string; tag: string; age: string }> = {
  gate: {
    card: "border-accent-edge bg-gradient-to-b from-gate-from to-gate-to",
    edge: "border-accent-edge",
    tag: "bg-accent",
    age: "text-gate-ink",
  },
  err: { card: "border-err-edge bg-err-tint", edge: "border-err-edge", tag: "bg-err", age: "text-err-ink" },
  run: { card: "border-accent-edge bg-accent-tint", edge: "border-accent-edge", tag: "bg-run", age: "text-run-ink" },
  off: { card: "border-edge bg-raised", edge: "border-edge", tag: "bg-off", age: "text-ink-muted" },
};

export type FactTone = "ok" | "wait" | "err" | "off";

const FACT: Record<FactTone, string> = {
  ok: "border-brand-edge text-ok-ink",
  wait: "border-wait-edge text-wait-ink",
  err: "border-err-edge text-err-ink",
  off: "border-edge text-off-ink",
};

export interface Fact {
  text: string;
  tone?: FactTone;
  /** Varsa çip ilgili sekmeye götürür. */
  onClick?: () => void;
  title?: string;
}

export interface Note {
  text: string;
  tone: Tone;
}

export function AttentionCard({
  tone,
  tag,
  pulse = false,
  age,
  title,
  body,
  facts = [],
  actions,
  note,
  children,
  docked = false,
  mobileTag,
  mobileLine,
}: {
  tone: AttentionTone;
  tag: string;
  /** Etiketin önünde nabız atan nokta: iş şu an koşuyor. */
  pulse?: boolean;
  age?: string;
  title: ReactNode;
  body?: ReactNode;
  facts?: Fact[];
  actions?: ReactNode;
  note?: Note | null;
  /** Kartın altında açılan bölüm (red gerekçesi). */
  children?: ReactNode;
  /**
   * Mobilde eylemler alt çubukta (tasarım 2e): kart yalnız etiket, başlık ve
   * tek satırlık özet taşır. Dar ekranda düğmeler ve çipler kartı üç katına
   * çıkarıyor, planın kendisine yer kalmıyordu.
   */
  docked?: boolean;
  /** Mobildeki kısa etiket ("plan v2"); yoksa `tag`. */
  mobileTag?: string;
  /** Mobilde çiplerin yerini alan tek cümle. */
  mobileLine?: Note | null;
}) {
  const s = CARD[tone];
  // Yalnız masaüstünde görünenler; mobilde alt çubuk ve `mobileLine` karşılar.
  const wide = docked ? "hidden md:flex" : "flex";
  return (
    <div className={`overflow-hidden rounded-[13px] border ${s.card}`}>
      <div className="flex flex-wrap items-center gap-[18px] px-3.5 py-3 md:px-4 md:py-[13px]">
        <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            {pulse && <Dot tone="run" pulse />}
            <span
              className={`rounded-[5px] px-2 py-[3px] font-mono text-[10px] font-semibold tracking-[.07em] text-white uppercase md:text-[10.5px] ${s.tag}`}
            >
              {mobileTag ? (
                <>
                  <span className="md:hidden">{mobileTag}</span>
                  <span className="hidden md:inline">{tag}</span>
                </>
              ) : (
                tag
              )}
            </span>
            {age && <span className={`font-mono text-[11px] ${s.age}`}>{age}</span>}
          </div>
          <div className="text-[15px] font-semibold text-ink md:text-[15.5px]">{title}</div>
          {body}
          {docked && mobileLine && (
            <span className={`text-[13px] md:hidden ${NOTE_INK[mobileLine.tone]}`}>{mobileLine.text}</span>
          )}
          {facts.length > 0 && (
            <div className={`${wide} flex-wrap gap-1.5`}>
              {facts.map((f) => {
                const cls = `rounded-md border bg-surface px-2 py-0.5 font-mono text-[11px] ${FACT[f.tone ?? "off"]}`;
                return f.onClick ? (
                  <button
                    key={f.text}
                    type="button"
                    onClick={f.onClick}
                    title={f.title ?? "ayrıntıyı gör"}
                    className={`${cls} cursor-pointer hover:underline`}
                  >
                    {f.text}
                  </button>
                ) : (
                  <span key={f.text} title={f.title} className={cls}>
                    {f.text}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {actions && <div className={`${wide} shrink-0 flex-wrap items-center gap-2.5`}>{actions}</div>}
      </div>

      {note && (
        <div className={`${wide} items-center gap-[9px] border-t bg-white/60 px-4 py-2 text-[12.5px] ${s.edge} ${NOTE_INK[note.tone]}`}>
          <Dot tone={note.tone} size={6} />
          {/* Önceki hatanın mesajı uzun olabiliyor; kart iki satırdan fazla büyümesin. */}
          <span className="line-clamp-2 min-w-0 flex-1" title={note.text}>
            {note.text}
          </span>
        </div>
      )}

      {children && (
        <div className={`border-t px-4 pt-3 pb-3.5 ${docked ? "hidden md:block" : ""} ${s.edge}`}>{children}</div>
      )}
    </div>
  );
}

const NOTE_INK: Record<Tone, string> = {
  run: "text-run-ink",
  wait: "text-wait-ink",
  ok: "text-ok-ink",
  err: "text-err-ink",
  off: "text-off-ink",
};

/** Kart düğmesi (36px): birincil dolu marka, ikincil beyaz; `danger` kırmızı kenarlı. */
export function AttentionButton({
  kind,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind: "primary" | "secondary" | "danger" }) {
  const look =
    kind === "primary"
      ? "border-transparent bg-brand text-white hover:bg-brand-ink"
      : kind === "danger"
        ? "border-err-edge bg-surface text-err-ink hover:bg-err-tint"
        : "border-edge-control bg-surface text-ink-body hover:bg-raised";
  return (
    <button
      type="button"
      className={`flex h-9 shrink-0 items-center rounded-[10px] border px-[15px] text-[13px] font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${look} ${className}`}
      {...rest}
    />
  );
}
