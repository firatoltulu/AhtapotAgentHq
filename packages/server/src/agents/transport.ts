import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue, GuideGate, type BrowserRunConfig, type CodeGraphRunConfig, type PermissionMode, type AgentRoleName } from "@ahtapot/shared";

import type { BridgeSession } from "../exec/bridge.js";
import { askUserServer, type AskUser } from "./askUser.js";

/**
 * Taşıma katmanı — SDK nerede koşuyor?
 *
 * Runner'ın işi kimlik, kota, maliyet ve kalıcılıktır; SDK'nın host'ta mı
 * konteynerde mi koştuğunu bilmez. İki taşıma aynı arayüzü verir:
 *
 *  • LocalTransport: `query()` bu süreçte. Analyst (salt okunur) ve testler.
 *  • ContainerTransport: `run.start` köprüye gider, olaylar köprüden gelir.
 *
 * Her ikisinde de kimlik çağrı başına verilir; `process.env`e yazılmaz.
 */

export interface Identity {
  envName: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
  value: string;
}

export interface TransportRunOptions {
  runId: string;
  role: AgentRoleName;
  prompt: string;
  model: string;
  effort?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** HOST yolu; konteyner taşıması bunu kendi yoluna çevirir. */
  cwd: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string | null;
  /** Varsa canlı oturum: kanal kapanana kadar koşu bitmez. */
  channel?: LiveInputChannel;
  identity: Identity;
  /** Agent soru sorunca çağrılır; cevap promise'i tur boyunca bekletilir. */
  askUser?: AskUser;
  askTimeoutMinutes?: number;
  /** Playwright MCP. Yalnız `supports("browser")` olan taşıma uygular. */
  browser?: BrowserRunConfig;
  /** Trail MCP. Yalnız `supports("codegraph")` olan taşıma uygular. */
  codeGraph?: CodeGraphRunConfig;
}

export interface StartedRun {
  messages: AsyncIterable<Record<string, unknown>>;
  /** Turu keser. Canlı kanal varsa kapatır. */
  abort(reason: string): Promise<void>;
  /**
   * Mentor önerisinin teslim kolu: `hold` sıradaki araç çağrısını
   * bekletir, `release` öneriyi o çağrıya ek bağlam olarak bırakır. Yoksa
   * (eski köprü) bu koşuya öneri teslim edilemez.
   */
  guide?: GuideControl;
}

export interface GuideControl {
  hold(timeoutMs: number): void;
  release(text: string | null): void;
}

/**
 * Kapıyı bekleyen `PreToolUse` kancası. Kancanın zaman aşımı kapınınkinden
 * uzun: kapı süresi dolunca zaten kendiliğinden açılır. Köprüdeki eşi
 * `bridge/main.ts` içinde (köprü sunucu kodunu içermez).
 */
function guideHooks(gate: GuideGate) {
  return {
    PreToolUse: [{
      timeout: 3600,
      hooks: [async () => {
        const text = await gate.take();
        return text ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, additionalContext: text } } : {};
      }],
    }],
  };
}

export interface AgentTransport {
  start(opts: TransportRunOptions): StartedRun;
  /**
   * İsteğe bağlı yetenek (`browser`). Motor koşudan ÖNCE sorar: yeteneği
   * olmayan taşımaya `browser` vermek agent'ı tarayıcısız koşturur.
   */
  supports?(capability: string): boolean;
}

/**
 * Canlı giriş kanalı — kullanıcı agent koşarken mesaj gönderebilsin.
 *
 * Kısıt dürüstçe: mesaj tur ORTASINDA görülmez, ancak mevcut tur bittiğinde
 * işlenir. Anında etki için `interrupt` gerekir (UI bunu açıkça gösteriyor).
 */
export class LiveInputChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queue = new AsyncQueue<SDKUserMessage>();
  /** Konteyner taşıması `interrupt` bayrağını köprüye taşımak için dinler. */
  readonly interrupts = new AsyncQueue<string>();
  /**
   * Kanala düşen mesaj sayısı. Runner'ın sessizlik gözcüsü turlar arasında
   * susar; yeni mesaj geldiğinde saymaya yeniden başlaması için buna bakar.
   */
  pushes = 0;

  push(text: string, interrupt = false): void {
    this.pushes++;
    if (interrupt) this.interrupts.push(text);
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    } as unknown as SDKUserMessage);
  }

  close(): void {
    this.queue.end();
    this.interrupts.end();
  }

  get closed(): boolean {
    return this.queue.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this.queue[Symbol.asyncIterator]();
  }
}

export class LocalTransport implements AgentTransport {
  start(opts: TransportRunOptions): StartedRun {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env["ANTHROPIC_API_KEY"];
    delete env["CLAUDE_CODE_OAUTH_TOKEN"];
    env[opts.identity.envName] = opts.identity.value;

    // Canlı kanalda ilk mesaj prompt'un kendisidir — köprü de aynısını yapar.
    if (opts.channel) opts.channel.push(opts.prompt);

    const timeoutMs = (opts.askTimeoutMinutes ?? 30) * 60_000;
    const gate = new GuideGate();
    const q = query({
      prompt: opts.channel ?? opts.prompt,
      options: {
        model: opts.model,
        // YAŞANDI: bu alan profilde tanımlı, DB'ye yazılıyor ve köprüye
        // gönderiliyordu — ama iki `query()` çağrısının hiçbirinde
        // `options`'a girmiyordu. Yani hiçbir rolde effort etkili değildi.
        // `as never` cast'i tip hatasını yuttuğu için kusur uzun yaşadı.
        ...(opts.effort ? { effort: opts.effort } : {}),
        cwd: opts.cwd,
        maxTurns: opts.maxTurns,
        // Bütçe YALNIZ mentorda SDK'ya verilir: danışma başına tavan mentor tasarımının
        // parçası. Diğer rollerin `maxBudgetUsd`i bugün iki taşımada da SDK'ya
        // gitmiyor (köprü de okumuyor); onu açmak ayrı bir karar — analiz ya
        // da triage turu sürüm yükseltmede yarıda kesilmeye başlamamalı.
        ...(opts.role === "mentor" ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
        env,
        includePartialMessages: Boolean(opts.channel),
        ...(opts.askUser ? { mcpServers: { ahtapot: askUserServer(opts.askUser, timeoutMs) } } : {}),
        hooks: guideHooks(gate),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
        ...(opts.appendSystemPrompt
          ? { systemPrompt: { type: "preset", preset: "claude_code", append: opts.appendSystemPrompt } }
          : {}),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
      } as never,
    });

    if (opts.channel) {
      // Kesme bayrağı SDK'ya doğrudan: mesaj kuyruğa girmeden tur kesilir.
      const ch = opts.channel;
      void (async () => {
        for await (const _ of ch.interrupts) await q.interrupt().catch(() => {});
      })();
    }

    return {
      messages: q as AsyncIterable<Record<string, unknown>>,
      async abort() {
        gate.release(null);
        await q.interrupt().catch(() => {});
        opts.channel?.close();
      },
      guide: { hold: (ms) => gate.hold(ms), release: (t) => gate.release(t) },
    };
  }
}

/**
 * Köprü üzerinden konteyner içi SDK.
 *
 * Worktree named volume'de yaşadığından yollar ZATEN konteyner yollarıdır
 * (`/workspace/<repo>`); host karşılığı yok. Çeviri yine de duruyor çünkü
 * motor mantıksal yol taşır ve kökün dışına çıkan bir yol hata olmalı —
 * eskiden bu host önekiyle denetlenirdi, şimdi konteyner köküyle.
 *
 * Kimlik `identity.set` ile ayrıca gider; `run.start` anahtar taşımaz.
 */
export class ContainerTransport implements AgentTransport {
  constructor(
    private readonly session: BridgeSession,
    private readonly paths: { containerRoot: string },
  ) {}

  toContainerPath(path: string): string {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "");
    const p = norm(path);
    const root = norm(this.paths.containerRoot);
    if (p === root) return this.paths.containerRoot;
    if (p.startsWith(`${root}/`)) return p;
    throw new Error(`yol iş dizininin dışında: ${path}`);
  }

  supports(capability: string): boolean {
    return this.session.capabilities.includes(capability);
  }

  start(opts: TransportRunOptions): StartedRun {
    this.session.send({ type: "identity.set", envName: opts.identity.envName, value: opts.identity.value });

    const live = Boolean(opts.channel);
    const messages = this.session.startRun({
      type: "run.start",
      askTimeoutMinutes: opts.askTimeoutMinutes ?? 30,
      runId: opts.runId,
      // Köprü rolü KULLANMIYOR, yalnız şemada doğruluyor. `tester` sonradan
      // eklendi: imajı tazelenmeden kurulmuş (ayakta kalan) konteynerlerdeki
      // eski köprü mesajı reddeder, koşu sessizlik gözcüsüne dek asılı kalırdı.
      // Kayıt (`agent_runs.role`) sunucuda, doğru rolle tutuluyor.
      role: opts.role === "tester" ? "qa" : opts.role,
      prompt: opts.prompt,
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort } : {}),
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      cwd: this.toContainerPath(opts.cwd),
      live,
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
      resumeSessionId: opts.resumeSessionId ?? null,
      ...(opts.browser && this.supports("browser") ? { browser: opts.browser } : {}),
      ...(opts.codeGraph && this.supports("codegraph") ? { codeGraph: opts.codeGraph } : {}),
    }, opts.askUser
      ? async (q) => {
          const answer = await opts.askUser!(q);
          this.session.send({ type: "run.answer", questionId: q.questionId, answer });
        }
      : undefined);

    if (opts.channel) {
      // Host kanalındaki her mesaj köprüye pompalanır; kanal kapanınca run.close.
      const ch = opts.channel;
      const runId = opts.runId;
      void (async () => {
        try {
          for await (const m of ch) {
            const text = extractText(m);
            this.session.send({ type: "run.input", runId, text, interrupt: false });
          }
          this.session.send({ type: "run.close", runId });
        } catch {
          // Köprü koptu; koşu zaten hatayla biter.
        }
      })();
      void (async () => {
        try {
          for await (const _ of ch.interrupts) {
            this.session.send({ type: "run.input", runId, text: "", interrupt: true });
          }
        } catch {
          /* aynı */
        }
      })();
    }

    // İmajı tazelenmemiş köprü `run.hold`u tanımaz; ona hiç gönderilmez.
    const runId = opts.runId;
    const guide: GuideControl | undefined = this.session.capabilities.includes("guide")
      ? {
          hold: (timeoutMs) => {
            try { this.session.send({ type: "run.hold", runId, timeoutMs }); } catch { /* köprü koptu */ }
          },
          release: (text) => {
            try { this.session.send({ type: "run.guide", runId, text: text ?? "" }); } catch { /* aynı */ }
          },
        }
      : undefined;

    return {
      messages,
      abort: async (reason) => {
        this.session.send({ type: "run.abort", runId: opts.runId, reason });
        opts.channel?.close();
      },
      ...(guide ? { guide } : {}),
    };
  }
}

function extractText(m: SDKUserMessage): string {
  const content = (m as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}
