import { useSyncExternalStore } from "react";

import { Dot, type Tone } from "./ui";

/**
 * Kısa ömürlü bilgilendirme — "iş açıldı" gibi bir eylemin sonucu.
 *
 * Kabukta (`Layout`) çizilir, sayfada değil: eylem çoğu zaman başka sayfaya
 * yönlendiriyor ve sayfa içi bir mesaj yönlendirmeyle birlikte kaybolurdu.
 * Depo modül düzeyinde; çağıran hook'a ya da context'e bağlanmak zorunda
 * kalmasın (mutation `onSuccess`inden de çağrılabilsin).
 */

export interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  detail?: string;
}

const DURATION_MS = 5000;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: ToastItem[]) {
  items = next;
  for (const l of listeners) l();
}

function dismiss(id: number) {
  publish(items.filter((t) => t.id !== id));
}

export function toast(input: Omit<ToastItem, "id">): void {
  const id = nextId++;
  // Hata tonu kendiliğinden kaybolmaz: okunmadan gitmesi, olmamış sayılması demek.
  publish([...items, { ...input, id }].slice(-4));
  if (input.tone !== "err") setTimeout(() => dismiss(id), DURATION_MS);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items);
  if (list.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-edge bg-surface px-3.5 py-3 shadow-[0_8px_24px_rgba(0,0,0,.12)]"
        >
          <span className="mt-[5px]">
            <Dot tone={t.tone} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-ink">{t.title}</span>
            {t.detail && <span className="text-[12px] leading-[1.5] break-words text-ink-soft">{t.detail}</span>}
          </div>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            className="shrink-0 font-mono text-[12px] text-ink-muted hover:text-ink"
            aria-label="Bildirimi kapat"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
