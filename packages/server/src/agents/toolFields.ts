/**
 * Araç girdisini akışta okunabilir alanlara çevirir.
 *
 * `inputSummary` girdinin 200 karakterde kesilmiş JSON'u. Operatör akışta
 * "ne oldu" sorusunu oradan cevaplayamıyordu: `Edit` satırı
 * `{"replace_all":false,"file_path":…,"old_string":"…` basıyor, tek satıra
 * sığmadığı için kesiliyor ve komut kartıyla dosya kartı ayırt edilemiyordu.
 *
 * Çıkarım ÜRETİCİ tarafta yapılır çünkü kesilmemiş girdiyi yalnız burası
 * görür. İstemci 200 karakterlik kesikten farkı geri kuramaz — kesme çoğu
 * zaman `old_string` değerinin ortasına düşer.
 *
 * Tanınmayan araçta hiçbir alan yazılmaz: UI o zaman eski davranışa
 * (`inputSummary`) düşer. Yanlış çıkarım, çıkarmamaktan kötüdür.
 */

/** Kabuk komutu çalıştıran araçlar — girdisindeki `command` ham taşınır. */
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "PowerShell"]);

/** Dosya okuyan araçlar — yol ve okunan aralık. */
const READ_TOOLS = new Set(["Read", "NotebookRead"]);

/** Dosyaya yazan araçlar — yol ve fark. */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** Akışa giren fark en fazla bu kadar satır taşır — gerisini UI zaten kırpar. */
const MAX_DIFF_LINES = 24;
/** Fark satırı bu uzunlukta kesilir; kutu yatay kaymasın. */
const MAX_DIFF_LINE = 400;
/** Komut bu uzunlukta kesilir — JSON'un ortasından değil, metnin sonundan. */
const MAX_COMMAND = 2000;

/**
 * Olaya eklenecek alanlar.
 *
 * `meta` ve `diff` DAİMA dolu (boş dizi olabilir): şemada `.default([])` var,
 * yani çıktı tipinde zorunlular. Opsiyonel bırakılırsa `exactOptionalPropertyTypes`
 * altında yayın çağrısı tip hatası verir.
 */
export interface ToolFields {
  command?: string;
  cwd?: string;
  file?: string;
  meta: string[];
  diff: [("-" | "+"), string][];
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

function num(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Satırlara böler; sondaki boş satır sayılmaz (dosya sonu `\n` fark değil). */
function lines(text: string): string[] {
  const out = text.split("\n");
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

function clip(line: string): string {
  return line.length > MAX_DIFF_LINE ? `${line.slice(0, MAX_DIFF_LINE)}…` : line;
}

/**
 * `old_string` → `new_string` farkını satır satır üretir.
 *
 * Ortak ön ve son ekler atılır: tek kelimelik bir değişiklikte 30 satırlık
 * bağlamı fark diye göstermek, neyin değiştiğini gizler. Kalan orta parça
 * `−` ve `+` blokları olarak basılır — satır bazlı eşleme (LCS) yapılmaz,
 * akıştaki mini kutu için gereğinden pahalı olurdu.
 */
export function diffLines(oldText: string, newText: string): [("-" | "+"), string][] {
  const a = lines(oldText);
  const b = lines(newText);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);

  const out: [("-" | "+"), string][] = [];
  for (const l of removed) out.push(["-", clip(l)]);
  for (const l of added) out.push(["+", clip(l)]);
  return out.slice(0, MAX_DIFF_LINES);
}

/** `+6 −2` çipi — fark satırlarından sayılır, boşsa çip yazılmaz. */
function diffMeta(diff: [("-" | "+"), string][]): string[] {
  const minus = diff.filter(([m]) => m === "-").length;
  const plus = diff.filter(([m]) => m === "+").length;
  if (minus === 0 && plus === 0) return [];
  return [`+${plus} −${minus}`];
}

const NONE: ToolFields = { meta: [], diff: [] };

function shell(o: Record<string, unknown>): ToolFields {
  const command = str(o, "command");
  const cwd = str(o, "cwd");
  return {
    ...NONE,
    ...(command ? { command: command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND)}…` : command } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function read(o: Record<string, unknown>): ToolFields {
  const file = str(o, "file_path") || str(o, "notebook_path");
  if (!file) return NONE;
  const offset = num(o, "offset");
  const limit = num(o, "limit");
  const meta: string[] = [];
  // "satır 40–96 okundu": kısmi okuma tam okumadan ayrılmalı — agent dosyanın
  // tamamını gördü sanmak yanlış sonuç çıkarttırıyor.
  if (offset !== undefined && limit !== undefined) meta.push(`satır ${offset}–${offset + limit} okundu`);
  else if (limit !== undefined) meta.push(`${limit} satır okundu`);
  else if (offset !== undefined) meta.push(`satır ${offset}'ten sonrası`);
  return { file, meta, diff: [] };
}

function edit(name: string, o: Record<string, unknown>): ToolFields {
  const file = str(o, "file_path") || str(o, "notebook_path");
  if (!file) return NONE;

  // Write: eski içerik yok, tamamı eklenmiş sayılır.
  if (name === "Write") {
    const content = str(o, "content");
    return { file, diff: diffLines("", content), meta: [`${lines(content).length} satır yazıldı`] };
  }

  const oldText = str(o, "old_string") || str(o, "old_source");
  const newText = str(o, "new_string") || str(o, "new_source");
  if (!oldText && !newText) return { file, meta: [], diff: [] };

  const diff = diffLines(oldText, newText);
  const meta = diffMeta(diff);
  // `replace_all` sessizce tüm dosyayı değiştirebilir; operatör bunu görmeli.
  if (o["replace_all"] === true) meta.push("replace_all: evet");
  return { file, diff, meta };
}

/** Araç adına göre akışa giren alanlar. Tanınmayan araçta yalnız boş varsayılanlar. */
export function toolFields(name: string, input: unknown): ToolFields {
  if (!input || typeof input !== "object") return NONE;
  const o = input as Record<string, unknown>;
  if (SHELL_TOOLS.has(name)) return shell(o);
  if (READ_TOOLS.has(name)) return read(o);
  if (EDIT_TOOLS.has(name)) return edit(name, o);
  return NONE;
}
