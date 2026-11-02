import type { Release } from "@ahtapot/shared";

/**
 * Zamanlı yayın takvimi — saf fonksiyonlar, saat dilimi `Intl` ile.
 *
 * Takvim SABİTTİR ("her pazartesi 10:00"): profilin onay anına ya da son
 * yayına göre kaymaz. Profil başka bir sebeple yeniden onaylandığında
 * yayın günü değişmemeli.
 *
 * Yaz saati geçişinde var olmayan yerel saat (ileri alınan 02:30) bir saat
 * kayar; yuva yine o gün içindedir ve bir kez tetiklenir.
 */
export type Schedule = Release["schedule"];

interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number;
}

const DAY_MS = 86_400_000;

function localParts(at: Date, timeZone: string): LocalDate & { h: number; mi: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute") };
}

/** Saat diliminin `at` anındaki UTC farkı (ms). */
function offsetAt(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** Yerel takvim günü + saat → UTC anı. Fark geçişte değişebilir; bir kez düzeltilir. */
function zonedInstant(day: LocalDate, time: string, timeZone: string): Date {
  const [h = 0, mi = 0] = time.split(":").map(Number);
  const naive = Date.UTC(day.y, day.m - 1, day.d, h, mi);
  let at = naive - offsetAt(new Date(naive), timeZone);
  const second = naive - offsetAt(new Date(at), timeZone);
  if (second !== at) at = second;
  return new Date(at);
}

function addDays(day: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekday(day: LocalDate): number {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
}

/** Ayın `dayOfMonth`u; kısa ayda son gün (31 → Şubat 28/29). */
function monthDay(y: number, m: number, dayOfMonth: number): LocalDate {
  const norm = new Date(Date.UTC(y, m - 1, 1));
  const ny = norm.getUTCFullYear();
  const nm = norm.getUTCMonth() + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return { y: ny, m: nm, d: Math.min(dayOfMonth, last) };
}

/** Aday yuvalar, `now`ın yerel gününe göre — geriye ve ileriye birer dönem. */
function candidates(s: Schedule, now: Date): Date[] {
  const today = localParts(now, s.timezone);
  const out: Date[] = [];
  if (s.mode === "weekly") {
    for (let k = -7; k <= 7; k++) {
      const day = addDays(today, k);
      if (weekday(day) === s.weekday) out.push(zonedInstant(day, s.time, s.timezone));
    }
  } else if (s.mode === "monthly") {
    for (let k = -2; k <= 2; k++) {
      out.push(zonedInstant(monthDay(today.y, today.m + k, s.dayOfMonth), s.time, s.timezone));
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** `now`a eşit ya da önceki en son yuva; takvim kapalıysa null. */
export function lastSlotAtOrBefore(s: Schedule, now: Date): Date | null {
  const past = candidates(s, now).filter((t) => t.getTime() <= now.getTime());
  return past.at(-1) ?? null;
}

/** `now`dan sonraki ilk yuva; takvim kapalıysa null. */
export function nextSlotAfter(s: Schedule, now: Date): Date | null {
  return candidates(s, now).find((t) => t.getTime() > now.getTime()) ?? null;
}
