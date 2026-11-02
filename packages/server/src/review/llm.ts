import { z } from "zod";

import { scrubSecrets, type LocalReview } from "@ahtapot/shared";

/**
 * Yerel incelemede tanımlı sağlayıcıyla DOĞRUDAN konuşan ince istemci.
 *
 * OCR yapılandırmayı CLI'ya geçiriyor, isteği araç yapıyor; ikinci gözün
 * (§42) girdisi yalnız metin, konteyner ve worktree gerekmiyor — sunucu
 * kendisi çağırır. Anahtar yalnız isteğin başlığına girer: `process.env`'e
 * ve log'a yazılmaz (kural 5).
 */

export type Protocol = LocalReview["protocol"];

/** Protokolün resmî adresi — profil `baseUrl` vermezse. OCR de buradan okur. */
export const DEFAULT_BASE_URL: Record<Protocol, string> = {
  "openai": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic": "https://api.anthropic.com",
};

export interface CompleteTextInput {
  protocol: Protocol;
  baseUrl?: string | undefined;
  model: string;
  key: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Test için; varsayılan global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface Usage {
  input: number;
  output: number;
}

export type CompleteTextOutcome =
  | { ok: true; text: string; usage: Usage | null; truncated: boolean }
  /**
   * `kind`: `parse` — sağlayıcı cevap verdi ama gövde okunamadı; diğerleri
   * (HTTP, bağlantı, zaman aşımı) sağlayıcıya ulaşılamadığını söyler. Yedeğe
   * düşmek yalnız ikincisinde anlamlı (§42).
   */
  | { ok: false; reason: string; kind: "transport" | "parse" };

// Yanıt gövdeleri: yalnız okuduğumuz alanlar; gerisi atılır. Sağlayıcı yeni
// alan eklerse yanıt düşmesin.
const ResponsesBody = z.object({
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).nullish(),
});

const ChatBody = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({ content: z.string().nullish() }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

const MessagesBody = z.object({
  stop_reason: z.string().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).nullish(),
});

const join = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;

/**
 * Tek istek, tek yanıt. FIRLATMAZ: ikinci göz danışmandır, düşerse akış
 * sürer — sebep insana gösterilir, maskeli (kural 4). Anahtar ayrıca açıkça
 * silinir: `scrubSecrets` her sağlayıcının anahtar biçimini tanımayabilir.
 *
 * `temperature` GÖNDERİLMEZ: GPT-6 `temperature: 0`ı 400 ile reddediyor
 * (§20, ölçüldü). Token tavanının adı protokole göre değişir.
 */
export async function completeText(input: CompleteTextInput): Promise<CompleteTextOutcome> {
  const { protocol, model, key, system, user, maxOutputTokens } = input;
  const base = input.baseUrl ?? DEFAULT_BASE_URL[protocol];
  const mask = (s: string): string => scrubSecrets(key ? s.replaceAll(key, "***") : s);
  const doFetch = input.fetchImpl ?? fetch;

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  switch (protocol) {
    case "openai-responses":
      url = join(base, "/responses");
      headers = { authorization: `Bearer ${key}` };
      body = { model, instructions: system, input: user, max_output_tokens: maxOutputTokens };
      break;
    case "openai":
      url = join(base, "/chat/completions");
      headers = { authorization: `Bearer ${key}` };
      body = {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_completion_tokens: maxOutputTokens,
      };
      break;
    case "anthropic":
      // OCR'ın kuralı: `baseUrl` `/v1`siz verilir. Elle `/v1` yazılmışsa
      // ikilenmesin.
      url = join(base, /\/v1\/?$/.test(base) ? "/messages" : "/v1/messages");
      headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
      body = { model, system, messages: [{ role: "user", content: user }], max_tokens: maxOutputTokens };
      break;
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, kind: "transport", reason: `${Math.round(input.timeoutMs / 1000)} sn içinde yanıt gelmedi` };
    }
    return { ok: false, kind: "transport", reason: `istek gönderilemedi: ${mask(err instanceof Error ? err.message : String(err))}` };
  }

  const raw = await res.text().catch(() => "");
  // Kota/hata yalnız HTTP durumundan ve hata gövdesinden okunur (kural 6).
  if (!res.ok) return { ok: false, kind: "transport", reason: `HTTP ${res.status}: ${mask(raw).slice(0, 500) || "(gövde boş)"}` };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "parse", reason: `yanıt JSON değil: ${mask(raw).slice(0, 300)}` };
  }
  return parseBody(protocol, json);
}

/** Protokolün yanıt gövdesinden metni ve kullanımı çıkarır. Dışa açık: test edilebilsin. */
export function parseBody(protocol: Protocol, json: unknown): CompleteTextOutcome {
  const shape = (err: z.ZodError): CompleteTextOutcome =>
    ({ ok: false, kind: "parse", reason: `yanıt beklenen biçimde değil: ${err.issues[0]?.message ?? "?"}` });

  if (protocol === "openai-responses") {
    const p = ResponsesBody.safeParse(json);
    if (!p.success) return shape(p.error);
    const text = p.data.output
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("");
    const usage = p.data.usage ? { input: p.data.usage.input_tokens, output: p.data.usage.output_tokens } : null;
    return { ok: true, text, usage, truncated: p.data.status === "incomplete" };
  }
  if (protocol === "openai") {
    const p = ChatBody.safeParse(json);
    if (!p.success) return shape(p.error);
    const choice = p.data.choices[0];
    const usage = p.data.usage ? { input: p.data.usage.prompt_tokens, output: p.data.usage.completion_tokens } : null;
    return { ok: true, text: choice?.message.content ?? "", usage, truncated: choice?.finish_reason === "length" };
  }
  const p = MessagesBody.safeParse(json);
  if (!p.success) return shape(p.error);
  const text = p.data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  const usage = p.data.usage ? { input: p.data.usage.input_tokens, output: p.data.usage.output_tokens } : null;
  return { ok: true, text, usage, truncated: p.data.stop_reason === "max_tokens" };
}
