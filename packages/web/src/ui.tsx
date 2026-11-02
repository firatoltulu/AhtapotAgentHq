import { useEffect, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import type { JobPhase, JobState } from "@ahtapot/shared";

/**
 * Tasarım dizgesinin bileşen seti.
 *
 * Renk sınıfları `styles.css` içindeki `@theme` değişkenlerinden gelir; burada
 * ham hex yok. Her bileşen tek bir görsel kararı temsil eder, böylece ekranlar
 * arasında aynı şey iki farklı görünmez.
 */

// ── Durum tonları ────────────────────────────────────────────────────────────

/** Görsel ton: parlak nokta + okunur metin + zemin + kenar dörtlüsü. */
export type Tone = "run" | "wait" | "ok" | "err" | "off";

interface ToneClasses {
  dot: string;
  badge: string;
}

const TONES: Record<Tone, ToneClasses> = {
  run: { dot: "bg-run", badge: "bg-run/12 text-run-ink border-run/40" },
  wait: { dot: "bg-wait", badge: "bg-wait/12 text-wait-ink border-wait/40" },
  ok: { dot: "bg-ok", badge: "bg-ok/12 text-ok-ink border-ok/40" },
  err: { dot: "bg-err", badge: "bg-err/12 text-err-ink border-err/40" },
  off: { dot: "bg-off", badge: "bg-off/12 text-off-ink border-off/40" },
};

/**
 * Durum makinesinin adımı hangi tona düşer.
 *
 * Bekleyen kapı (`*Review`, `QACases`, `LiveTest`) sarıdır: insan hamlesi
 * bekliyor. Koşan adımlar mor, biten yeşil, kırılan kırmızı.
 */
const STATE_TONES: Record<string, Tone> = {
  Draft: "off",
  Planning: "run",
  PlanReview: "wait",
  Developing: "run",
  Building: "run",
  LiveTest: "wait",
  QACases: "wait",
  QA: "run",
  PRReview: "wait",
  CIWatch: "run",
  Done: "ok",
  NeedsAttention: "err",
  Cancelled: "off",
};

/** Faz tonu — `starting` görülen iş yarıda kalmıştır, o yüzden ayrı değil koşan sayılır. */
const PHASE_TONES: Record<string, Tone> = {
  starting: "run",
  running: "run",
  waiting: "wait",
  awaiting_approval: "wait",
  paused: "err",
  done: "ok",
};

export function stateTone(state: string): Tone {
  return STATE_TONES[state] ?? "off";
}

/** Durumun insan tarafından açılması gereken bir onay kapısında olması. */
export function isGateState(state: JobState): boolean {
  return state === "PlanReview" || state === "LiveTest" || state === "QACases" || state === "PRReview";
}

/** Kapı durumunun operatöre görünen kısa etiketi — Anasayfa'daki bekleyen iş satırı. */
const GATE_LABELS: Partial<Record<JobState, string>> = {
  PlanReview: "Plan onayı bekliyor",
  LiveTest: "Canlı ortam testi bekliyor",
  QACases: "QA vakaları onay bekliyor",
  PRReview: "PR incelemesi bekliyor",
};

export function gateLabel(state: JobState): string {
  return GATE_LABELS[state] ?? state;
}

export function phaseTone(phase: string): Tone {
  return PHASE_TONES[phase] ?? "off";
}

/** İş satırının tonu: kırık durum fazı ezer, yoksa durum belirler. */
export function jobTone(state: JobState, phase: JobPhase): Tone {
  if (state === "NeedsAttention" || phase === "paused") return "err";
  return stateTone(state);
}

// ── Atomlar ──────────────────────────────────────────────────────────────────

export function Dot({ tone, pulse = false, size = 7 }: { tone: Tone; pulse?: boolean; size?: number }) {
  return (
    <span
      className={`shrink-0 rounded-full ${TONES[tone].dot} ${pulse ? "aht-pulse" : ""}`}
      style={{ width: size, height: size }}
    />
  );
}

export function Badge({ value, tone, className = "" }: { value: string; tone?: Tone; className?: string }) {
  const t = TONES[tone ?? stateTone(value)];
  return (
    <span className={`inline-block shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${t.badge} ${className}`}>
      {value}
    </span>
  );
}

/** Küçük mono etiket — tasarımdaki "onay kapısı · phase" türü rozetler. */
export function Tag({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block rounded-[5px] px-[7px] py-[3px] font-mono text-[10px] tracking-[.1em] uppercase ${className}`}>
      {children}
    </span>
  );
}

/** Satır sınırı — Tailwind sınıfı olarak (dinamik değer JIT'te üretilmez). */
const CLAMP_LINES: Record<number, string> = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
};

/**
 * Uzun metni satırla sınırlar, tamamını tooltip'e koyar.
 *
 * Başlık alanlarına serbest metin giriyor: plan özeti, safha başlığı, QA case
 * adı, soru metni. Bunların hiçbirinde uzunluk sınırı yok (Planner bir paragraf
 * yazabiliyor) ve başlık ölçüsünde çizilince kutudan aşağı sarkıyorlardı.
 *
 * Kırpma metni GİZLEMEZ: tam hâli `title` ile imleçte durur. Metin zaten
 * sığıyorsa tooltip verilmez — her başlıkta gereksiz balon çıkmasın.
 */
export function Clamp({
  as: Tag = "span",
  lines = 2,
  text,
  className = "",
}: {
  as?: "span" | "div" | "h1" | "h2" | "h3" | "h4" | "p";
  lines?: 1 | 2 | 3 | 4;
  text: string;
  className?: string;
}) {
  // Eşik: kırpılma ihtimali olan uzunluk. Kısa metne tooltip takmak, imleç
  // her başlıkta balon açtığı için okumayı zorlaştırıyor.
  const long = text.length > 60;
  return (
    <Tag
      className={`${CLAMP_LINES[lines] ?? "line-clamp-2"} ${className}`}
      {...(long ? { title: text } : {})}
    >
      {text}
    </Tag>
  );
}

type ButtonVariant = "primary" | "neutral" | "ghost" | "danger" | "danger-solid";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-brand text-white hover:bg-brand-ink",
  neutral: "border-edge-control bg-surface text-ink-body hover:bg-raised",
  ghost: "border-brand-edge bg-transparent text-brand hover:bg-brand-tint",
  danger: "border-err-edge bg-transparent text-err-ink hover:bg-err-tint",
  "danger-solid": "border-transparent bg-err text-white hover:bg-err-ink",
};

const BUTTON_SIZES = { sm: "h-[30px] px-3 text-[12px]", md: "h-[34px] px-4 text-[13px]", lg: "h-[38px] px-5 text-[13.5px]" };

export function Button({
  variant = "neutral",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: keyof typeof BUTTON_SIZES }) {
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-[9px] border font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

export const inputClass =
  "w-full rounded-[10px] border border-edge-control bg-surface px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputClass} ${className}`} {...rest} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${inputClass} leading-relaxed ${className}`} {...rest} />;
}

/** `Jobs.tsx`teki ham `<select>`in genellenmiş hâli — aynı `inputClass` düzeni. */
export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${inputClass} ${className}`} {...rest}>
      {children}
    </select>
  );
}

/** `GatePanels.tsx`teki checkbox deseni — `label` opsiyonel, yoksa yalnız kutu döner. */
export function Checkbox({
  label,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const box = (
    <input type="checkbox" className={`h-[17px] w-[17px] shrink-0 accent-[var(--color-brand)] ${className}`} {...rest} />
  );
  if (!label) return box;
  return (
    <label className="flex items-center gap-2 text-[13px] text-ink-body">
      {box}
      {label}
    </label>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

/** Popup: koyu yarı saydam zemin üstünde ortalı kart. `Esc` ve zemine tıklama kapatır. */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(18,32,25,.42)] p-10"
      onClick={onClose}
    >
      <div
        className="flex max-h-full flex-col overflow-hidden rounded-2xl border border-edge-strong bg-surface shadow-2xl"
        style={{ width, maxWidth: "100%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-edge bg-raised px-5 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[16px] font-semibold tracking-tight text-ink">{title}</span>
            {subtitle && <span className="text-[12.5px] text-ink-soft">{subtitle}</span>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-edge bg-surface font-mono text-[14px] leading-none text-ink-muted hover:bg-raised"
          >
            ×
          </button>
        </div>
        <div className="flex flex-col gap-4 overflow-auto p-5">{children}</div>
        {footer && (
          <div className="flex items-center gap-3 border-t border-edge bg-raised px-5 py-3.5">{footer}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Bir bölümü tam ekrana alma. Aynı eleman `fixed inset-0`a geçer, portal ya da
 * modal değil: içerik yeniden bağlanmaz, kaydırma ve seçim korunur. Mobilde
 * dar sütunda diff/plan okunmuyordu; tek dokunuşla tüm ekran.
 */
export function useFullscreen() {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  return {
    full,
    toggle: () => setFull((f) => !f),
    /** Kartın kök elemanına eklenir; kapalıyken boş. */
    frameClass: full ? "fixed inset-0 z-40 bg-surface rounded-none! border-0!" : "",
  };
}

export function FullscreenButton({ full, onClick }: { full: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={full ? "Küçült (Esc)" : "Tam ekran"}
      aria-label={full ? "Tam ekrandan çık" : "Tam ekran"}
      className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] border border-edge bg-surface font-mono text-[13px] leading-none text-ink-muted hover:bg-raised hover:text-ink"
    >
      {full ? "⤡" : "⤢"}
    </button>
  );
}

export function Card({
  title,
  right,
  children,
  className = "",
  bodyClassName = "p-4",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`rounded-xl border border-edge bg-surface ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
          <h2 className="truncate text-[13px] font-semibold text-ink">{title}</h2>
          {right}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="mt-2 rounded-lg border border-err-edge bg-err-tint px-3 py-2 text-[12.5px] text-err-text">{msg}</div>
  );
}

/** Boş durum: başlık + açıklama + (varsa) tek eylem. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-10 py-16 text-center">
      <div className="text-[17px] font-semibold text-ink">{title}</div>
      {children && <p className="max-w-[360px] text-[13px] leading-relaxed text-ink-dim">{children}</p>}
      {action}
    </div>
  );
}

/** Yükleniyor: tasarımdaki kademeli parıltı blokları. */
export function Skeleton({ heights = [78, 120, 54, 96, 140, 62] }: { heights?: number[] }) {
  return (
    <div className="flex flex-col gap-3">
      {heights.map((h, i) => (
        <div
          key={i}
          className="aht-shimmer rounded-xl border border-edge bg-skeleton"
          style={{ height: h, animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  );
}

// ── Kalıcı tercih ────────────────────────────────────────────────────────────

/**
 * Yeniden yüklemede korunan yerel tercih.
 *
 * Sol rayın açık/kapalı olması gibi görünüm tercihleri sunucuya ait değil —
 * iş verisi değiller ve makineye özgüler. `localStorage` erişimi SAVUNMACI
 * sarılır: gizli pencerede ve site verisi engellendiğinde okuma da yazma da
 * fırlatır, ve bu yüzden ekranın hiç açılmaması kabul edilemez.
 */
export function useLocalState<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });

  const set = (next: T | ((prev: T) => T)): void => {
    setValue((prev) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Yazılamadı: tercih bu oturumda yaşar, ekran yine çalışır.
      }
      return resolved;
    });
  };

  return [value, set];
}

// ── Biçimlendirme ────────────────────────────────────────────────────────────

/** `1.14.5` → `v1.14.5`; `v…`, `dev`, dal adı olduğu gibi. */
export function fmtVersion(v: string): string {
  return /^\d/.test(v) ? `v${v}` : v;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("tr-TR", { hour12: false });
}

/** Yalnız saat — akış satırlarında tarih gürültü. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("tr-TR", { hour12: false });
}

export function fmtUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(3)}`;
}

/** "14dk", "3s", "dün" — iş listesinde mutlak zaman yer kaplıyor. */
export function fmtAge(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "şimdi";
  if (min < 60) return `${min}dk`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}s`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "dün" : `${days}g`;
}

/** Süre: build adımları saniye, agent turları dakika ölçeğinde. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 59.95) return `${s.toFixed(1)}s`;
  // ÖNCE yuvarla, SONRA birimlere böl: 59999ms "60.0s", 3599999ms "59dk 60s"
  // olurdu — ikisi de var olmayan değerler.
  const total = Math.round(s);
  return `${Math.floor(total / 60)}dk ${total % 60}s`;
}
