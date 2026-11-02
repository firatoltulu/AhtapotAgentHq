/**
 * Agent mesajındaki makine bloklarını (```HANDOFF_JSON, ```PLAN_JSON …) metinden
 * ayırır.
 *
 * Bloklar motor için yazılıyor; akışta ham basılınca bir handoff 30-40 satır
 * JSON olarak anlatının ortasına düşüyor ve operatör akışı izleyemiyordu.
 * Ayrılan blok UI'da katlanmış bir düğme olur, açılınca biçimli gösterilir.
 */

export type MessagePart =
  | { kind: "text"; text: string }
  /** `pending`: kapanış çiti henüz gelmedi (akan token'lar). */
  | { kind: "block"; name: string; raw: string; pending: boolean };

const FENCE = /```([A-Z][A-Z0-9_]*_JSON)[^\n]*\n([\s\S]*?)(```|$)/g;

export function splitMessage(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let at = 0;
  for (const m of text.matchAll(FENCE)) {
    const before = text.slice(at, m.index).trim();
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "block", name: m[1] ?? "", raw: (m[2] ?? "").trim(), pending: m[3] !== "```" });
    at = m.index + m[0].length;
  }
  const rest = text.slice(at).trim();
  if (rest) parts.push({ kind: "text", text: rest });
  return parts;
}

/** Blok JSON'u; bozuksa `null` — ham metin gösterilir (üretici güvenilmez). */
export function parseBlock(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
