import type { ServerEvent } from "@ahtapot/shared";

/**
 * Akış filtreleri.
 *
 * Akış filtresizdi: uzun bir işte yüzlerce olay birikiyor ve operatör aradığı
 * satırı bulamıyordu. Gruplar "ne aradığına" göre: komutu mu, dosya işini mi,
 * agent'ın sözünü mü, yoksa kapıyı mı.
 */

export type StreamGroup = "cmd" | "file" | "msg" | "gate";

/** Dosya okuyan/yazan araçlar — Dosya işleri grubuna bunlar girer. */
const FILE_TOOLS = new Set(["read", "edit", "write", "notebookread", "notebookedit", "multiedit", "glob", "grep"]);

export function isFileTool(name: string): boolean {
  return FILE_TOOLS.has(name.toLowerCase());
}

/** Kabuk komutu çalıştıran araçlar — Komutlar grubuna bunlar girer. */
const SHELL_TOOLS = new Set(["bash", "bashoutput", "powershell"]);

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name.toLowerCase());
}

/**
 * Olayın hangi gruba düştüğü.
 *
 * `build.log` ayrı kanalda (`ws.ts`) ve kendi sekmesinde; akışa hiç girmediği
 * için burada da yer almaz — grubu yine de tanımlı, replay'de eski kayıtlardan
 * gelirse Komutlar'a düşsün.
 */
export function groupOf(e: ServerEvent): StreamGroup {
  switch (e.type) {
    case "agent.tool_use":
      if (isShellTool(e.name)) return "cmd";
      // Tanınmayan araç (MCP, ask_user…) dosya işi sayılır: "Araçlar" diye
      // ayrı bir grup operatöre bir şey söylemiyordu — aradığı şey ya komut,
      // ya dosya, ya söz, ya kapı.
      return "file";
    case "agent.tool_result":
      return "file";
    case "build.log":
      return "cmd";
    case "agent.message":
    case "agent.thinking":
    case "agent.start":
    case "agent.end":
      return "msg";
    case "agent.question":
    case "agent.stuck":
    case "agent.mentor":
    case "approval.required":
      return "gate";
    default:
      // job.state, job.error, live.ready, cost.update
      return "msg";
  }
}

export const GROUP_LABELS: { key: StreamGroup | "all"; label: string }[] = [
  { key: "all", label: "Tümü" },
  { key: "cmd", label: "Komutlar" },
  { key: "file", label: "Dosya işleri" },
  { key: "msg", label: "Mesajlar" },
  { key: "gate", label: "Kapılar" },
];

/**
 * Komut çağrısını sonucuyla eşleştirir.
 *
 * Tasarım komutu ve çıktısını TEK kutuda gösteriyor; telde ikisi ayrı olay
 * (`agent.tool_use` → `agent.tool_result`, `toolId` ile eşleşir). Eşleşen
 * sonuç akışta ayrıca satır olarak çizilmez — aynı şey iki kere görünmemeli.
 */
export interface PairedStream {
  /** Çizilecek olaylar — eşleşmiş sonuçlar çıkarılmış hâlde. */
  rows: ServerEvent[];
  /** toolId → o çağrının sonucu. */
  results: Map<string, Extract<ServerEvent, { type: "agent.tool_result" }>>;
}

export function pairTools(events: ServerEvent[]): PairedStream {
  const results = new Map<string, Extract<ServerEvent, { type: "agent.tool_result" }>>();
  for (const e of events) {
    if (e.type === "agent.tool_result" && e.toolId) results.set(e.toolId, e);
  }
  // Sonucu bir çağrıya bağlanabilenler ayrı satır olmaz; yetim sonuç kalırsa
  // (çağrısı replay penceresinden düşmüşse) kendi satırında görünmeye devam eder.
  const used = new Set<string>();
  for (const e of events) {
    if (e.type === "agent.tool_use" && e.toolId && results.has(e.toolId)) used.add(e.toolId);
  }
  const rows = events.filter((e) => !(e.type === "agent.tool_result" && used.has(e.toolId)));
  return { rows, results };
}

/** Grup sayaçları — filtre şeridindeki rozetler. */
export function countByGroup(events: ServerEvent[]): Record<StreamGroup | "all", number> {
  const out: Record<StreamGroup | "all", number> = { all: events.length, cmd: 0, file: 0, msg: 0, gate: 0 };
  for (const e of events) out[groupOf(e)]++;
  return out;
}

/**
 * Liste üstündeki tek satır özet — "9 olay · seq 7601–7622 · 2 komut, 2 dosya işi".
 *
 * Zaman çizgisi kaydırılırken nerede olunduğu kayboluyor; seq aralığı
 * operatörün replay'de "hangi pencereye bakıyorum" sorusunu cevaplar.
 */
export function summarize(events: ServerEvent[]): string {
  if (events.length === 0) return "";
  const c = countByGroup(events);
  const seqs = events.map((e) => e.seq).filter((s) => s > 0);
  const parts = [`${events.length} olay`];
  if (seqs.length > 0) {
    const lo = Math.min(...seqs);
    const hi = Math.max(...seqs);
    parts.push(lo === hi ? `seq ${lo}` : `seq ${lo}–${hi}`);
  }
  const kinds = [
    c.cmd > 0 ? `${c.cmd} komut` : "",
    c.file > 0 ? `${c.file} dosya işi` : "",
    c.gate > 0 ? `${c.gate} kapı` : "",
  ].filter(Boolean);
  if (kinds.length > 0) parts.push(kinds.join(", "));
  return parts.join(" · ");
}
