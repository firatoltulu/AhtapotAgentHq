import type { BuildRow } from "../api";

/**
 * Build sekmesinin saf yardımcıları: adım satırlarını koşulara ayırmak ve
 * adım log dosyasını satırlara çözmek.
 */

export type StepStatus = "ok" | "fail" | "skip";

/** Ekranda çizilen adım: DB satırı ya da koşmadan kalan plan adımı. */
export interface StepView {
  /** DB satırının kimliği; koşmadan kalan adımda `null` (log yok). */
  id: string | null;
  stepName: string;
  command: string;
  status: StepStatus;
  note: string;
  exitCode: number | null;
  durationMs: number | null;
  /** Adımın BAŞLADIĞI an (ms); bilinmiyorsa `null`. */
  startMs: number | null;
  hasLog: boolean;
}

export function stepStatus(b: Pick<BuildRow, "skipped" | "exitCode">): StepStatus {
  if (b.skipped) return "skip";
  return b.exitCode === 0 ? "ok" : "fail";
}

/**
 * Adım satırlarını koşulara böler.
 *
 * `builds` tablosunda koşu kimliği yok; her kırmızı build yeni bir tur açıyor
 * ve adımlar aynı işe art arda yazılıyor. Bir adım adı mevcut koşuda ikinci
 * kez görülürse ya da safha değişirse yeni koşu başlamıştır.
 */
export function groupRuns(rows: BuildRow[]): BuildRow[][] {
  const runs: BuildRow[][] = [];
  let cur: BuildRow[] = [];
  for (const r of rows) {
    const first = cur[0];
    if (first && (first.phaseId !== r.phaseId || cur.some((c) => c.stepName === r.stepName))) {
      runs.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length > 0) runs.push(cur);
  return runs;
}

/**
 * Koşuyu ekran adımlarına çevirir.
 *
 * Kırılan adımdan sonrakiler DB'ye HİÇ yazılmıyor (build kapısı ilk kırmızıda
 * döner). Profildeki plan verilirse onlar "önceki adım kırıldı" notuyla atlanmış
 * olarak eklenir; yoksa operatör kaç adımın koşmadığını göremez.
 */
export function stepViews(run: BuildRow[], planned: { name: string; run: string }[] = []): StepView[] {
  const views: StepView[] = run.map((b) => {
    const status = stepStatus(b);
    // `createdAt` adım BİTİNCE yazılıyor; başlangıç süreden geri hesaplanır.
    const end = Date.parse(b.createdAt);
    const startMs = Number.isNaN(end) ? null : status === "skip" ? end : end - (b.durationMs ?? 0);
    return {
      id: b.id,
      stepName: b.stepName,
      command: b.command,
      status,
      note: b.skipped ? `Atlandı: ${b.skipReason ?? ""}`.replace(/: $/, "") : "",
      exitCode: b.exitCode,
      durationMs: b.skipped ? null : b.durationMs,
      startMs,
      hasLog: b.hasLog,
    };
  });
  if (!views.some((v) => v.status === "fail")) return views;
  const seen = new Set(run.map((b) => b.stepName));
  const lastIdx = planned.findIndex((p) => p.name === run[run.length - 1]?.stepName);
  if (lastIdx < 0) return views;
  for (const p of planned.slice(lastIdx + 1)) {
    if (seen.has(p.name)) continue;
    views.push({
      id: null,
      stepName: p.name,
      command: p.run,
      status: "skip",
      note: "Atlandı: önceki adım kırıldı.",
      exitCode: null,
      durationMs: null,
      startMs: null,
      hasLog: false,
    });
  }
  return views;
}

export type LogKind = "cmd" | "out" | "err" | "end";

export interface LogEntry {
  /** Satırın saati (ms); çözülemezse `null`. */
  atMs: number | null;
  text: string;
  kind: LogKind;
}

/**
 * Hata satırı sezgisi.
 *
 * Log dosyası stdout/stderr ayrımını tutmuyor (`build/gate.ts` tek dosyaya
 * yazıyor); kırmızıya boyanacak satırı metinden tanımak zorundayız. Derleyici
 * ve paket yöneticilerinin ortak kalıpları: `error CS0246`, `ERR!`, `FAILED`.
 */
// Küçük harfli `failed` bilerek yok: test özetindeki "0 failed" kırmızı olurdu.
const ERROR_LINE = /\berror\b|\bERR!|\bFAILED\b|Exception:|^\s*✖/;

/**
 * Adım log dosyasını satırlara çözer.
 *
 * Biçim (`build/gate.ts`): ilk satır `=== ad | ISO | komut`, çıktı satırları
 * `[m:ss.d] metin` (adım başından geçen süre), son satır
 * `--- ad: çıkış N, ms | bitiş ISO`. Geçen süre başlangıca eklenerek saate
 * çevrilir; tasarım her satırda saat gösteriyor.
 */
export function parseStepLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  let start: number | null = null;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    const head = /^=== (.*?) \| (\S+) \| (.*)$/.exec(raw);
    if (head) {
      const t = Date.parse(head[2] ?? "");
      start = Number.isNaN(t) ? null : t;
      out.push({ atMs: start, text: `$ ${head[3] ?? ""}`, kind: "cmd" });
      continue;
    }
    const tail = /^--- .*?: (.*?) \| bitiş (\S+)$/.exec(raw);
    if (tail) {
      // Kapanış satırı hata satırı sayılmaz: "çıkış 1, 26000 ms" teşhis
      // kartında hatanın yerini alırdı.
      const t = Date.parse(tail[2] ?? "");
      out.push({ atMs: Number.isNaN(t) ? null : t, text: tail[1] ?? raw, kind: "end" });
      continue;
    }
    const line = /^\[(\d+):(\d+(?:\.\d+)?)\] ?(.*)$/.exec(raw);
    if (line) {
      const ms = (Number(line[1]) * 60 + Number(line[2])) * 1000;
      const body = line[3] ?? "";
      out.push({ atMs: start === null ? null : start + ms, text: body, kind: ERROR_LINE.test(body) ? "err" : "out" });
      continue;
    }
    out.push({ atMs: null, text: raw, kind: ERROR_LINE.test(raw) ? "err" : "out" });
  }
  return out;
}

/**
 * Teşhis kartındaki "son hata satırları": hata kalıbına uyan son üç satır.
 * Hiçbiri uymuyorsa çıktının son üç satırı — boş kutu hiçbir şey söylemez.
 */
export function lastErrorLines(entries: LogEntry[], n = 3): LogEntry[] {
  const body = entries.filter((e) => e.kind !== "cmd" && e.kind !== "end");
  const errs = body.filter((e) => e.kind === "err");
  return (errs.length > 0 ? errs : body).slice(-n);
}
