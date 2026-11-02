import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";

import {
  AsyncQueue,
  BridgeToServerSchema,
  type BridgeToServer,
  type ServerToBridge,
} from "@ahtapot/shared";

import { schema, type Db } from "../db/index.js";
import type { Socket } from "../ws/hub.js";

/**
 * Köprü kaydı — sunucu tarafı.
 *
 * Konteyner kurulurken iş için bir token üretilir ve ortam değişkeniyle
 * konteynere verilir. Köprü bağlanınca `bridge.hello` ile token'ı sunar;
 * uymazsa soket kapanır. Token yalnız o işin konteynerine yarar: bir
 * konteyner başka işin oturumunu ele geçiremez.
 *
 * Yeniden bağlanma: aynı iş için ikinci hello eskisini düşürür — sunucu
 * yeniden başladığında ya da soket koptuğunda köprü tekrar gelir.
 */

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export type QuestionHandler = (q: { questionId: string; text: string; options: string[] }) => Promise<void>;

export class BridgeSession {
  private readonly runs = new Map<string, AsyncQueue<Record<string, unknown>>>();
  private readonly questions = new Map<string, QuestionHandler>();
  private open = true;

  constructor(
    readonly jobId: string,
    private readonly socket: Socket,
    /**
     * Köprünün `bridge.hello`da bildirdiği CANLI koşu — sunucu yeniden
     * başladıysa konteynerde hâlâ çalışan tur. `null` ise devralınacak bir şey
     * yok. `reconcile` bunu okuyup işi `NeedsAttention`a düşürmek yerine
     * akışı üstlenebilir.
     */
    readonly activeRunId: string | null = null,
    readonly droppedEvents = 0,
    /** Köprünün `bridge.hello`da bildirdiği isteğe bağlı mesajlar (ör. `guide`). */
    readonly capabilities: readonly string[] = [],
  ) {}

  /**
   * Köprüde süren koşuyu devral: `run.attach` yollanır, köprü tampondaki
   * olayları `sinceSeq`ten sonrasından tekrar verir. Dönen akış `startRun`
   * ile aynı sözleşmeyi taşır.
   */
  attachRun(runId: string, sinceSeq = 0, onQuestion?: QuestionHandler): AsyncIterable<Record<string, unknown>> {
    const queue = new AsyncQueue<Record<string, unknown>>();
    this.runs.set(runId, queue);
    if (onQuestion) this.questions.set(runId, onQuestion);
    try {
      this.send({ type: "run.attach", runId, sinceSeq });
    } catch (err) {
      this.runs.delete(runId);
      throw err;
    }
    return queue;
  }

  get connected(): boolean {
    return this.open;
  }

  send(msg: ServerToBridge): void {
    if (!this.open) throw new BridgeError("disconnected", `köprü bağlı değil: iş ${this.jobId}`);
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * Koşu başlatır; dönen akış köprüden gelen ham SDK mesajlarıdır.
   * `bridge.done` akışı bitirir, `bridge.error` hatayla bitirir.
   */
  startRun(msg: Extract<ServerToBridge, { type: "run.start" }>, onQuestion?: QuestionHandler): AsyncIterable<Record<string, unknown>> {
    const queue = new AsyncQueue<Record<string, unknown>>();
    this.runs.set(msg.runId, queue);
    if (onQuestion) this.questions.set(msg.runId, onQuestion);
    try {
      this.send(msg);
    } catch (err) {
      this.runs.delete(msg.runId);
      throw err;
    }
    return queue;
  }

  /** Köprüden gelen ham mesaj. Şemaya uymayan mesaj yok sayılır, koşu düşmez. */
  handle(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = BridgeToServerSchema.safeParse(parsed);
    if (!result.success) return;
    this.dispatch(result.data);
  }

  private dispatch(msg: BridgeToServer): void {
    switch (msg.type) {
      case "bridge.hello":
        // İkinci hello: aynı soket; kayıt zaten yapıldı.
        return;
      case "bridge.event": {
        const q = this.runs.get(msg.runId);
        if (q && msg.event && typeof msg.event === "object") q.push(msg.event as Record<string, unknown>);
        return;
      }
      case "bridge.done": {
        const q = this.runs.get(msg.runId);
        q?.end();
        this.runs.delete(msg.runId);
        this.questions.delete(msg.runId);
        return;
      }
      case "bridge.question": {
        const h = this.questions.get(msg.runId);
        // İşleyici yoksa köprü kendi zaman aşımıyla sürer.
        if (h) void h({ questionId: msg.questionId, text: msg.text, options: msg.options }).catch(() => {});
        return;
      }
      case "bridge.error": {
        if (msg.runId) {
          const q = this.runs.get(msg.runId);
          q?.fail(new BridgeError(msg.code, msg.message));
          this.runs.delete(msg.runId);
        }
        return;
      }
    }
  }

  /** Soket kapandı: bekleyen her koşu hatayla biter, sonsuza dek asılı kalmaz. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const [runId, q] of this.runs) {
      q.fail(new BridgeError("disconnected", `köprü bağlantısı koptu (koşu ${runId})`));
    }
    this.runs.clear();
  }
}

/** Token'ın DB'de saklanan biçimi. Ham token ASLA yazılmaz (kural 4). */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class BridgeRegistry {
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly waiters = new Map<string, ((s: BridgeSession) => void)[]>();

  /**
   * `db` verilmezse token yalnız bellekte tutulur (testler ve DB'siz kurulum).
   * Üretimde DB bağlıdır: sunucu yeniden başlayınca ayakta kalan köprü aynı
   * token'la doğrulanabilsin diye.
   */
  constructor(private readonly db: Db | null = null) {}

  private readonly memTokens = new Map<string, string>();

  /** Konteyner kurulmadan önce çağrılır; token ortam değişkeniyle konteynere gider. */
  issueToken(jobId: string): string {
    const token = randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    this.memTokens.set(jobId, tokenHash);
    if (this.db) {
      // Aynı iş yeniden kurulursa token tazelenir; eski hash geçersizleşir.
      this.db
        .insert(schema.bridgeTokens)
        .values({ jobId, tokenHash })
        .onConflictDoUpdate({ target: schema.bridgeTokens.jobId, set: { tokenHash } })
        .run();
    }
    return token;
  }

  revoke(jobId: string): void {
    this.memTokens.delete(jobId);
    if (this.db) this.db.delete(schema.bridgeTokens).where(eq(schema.bridgeTokens.jobId, jobId)).run();
    this.sessions.get(jobId)?.close();
    this.sessions.delete(jobId);
  }

  /** Beklenen hash — bellekte yoksa DB'den (restart sonrası tek yol budur). */
  private expectedHash(jobId: string): string | null {
    const cached = this.memTokens.get(jobId);
    if (cached) return cached;
    if (!this.db) return null;
    const row = this.db
      .select({ tokenHash: schema.bridgeTokens.tokenHash })
      .from(schema.bridgeTokens)
      .where(eq(schema.bridgeTokens.jobId, jobId))
      .all()[0];
    if (!row) return null;
    this.memTokens.set(jobId, row.tokenHash);
    return row.tokenHash;
  }

  /**
   * Hello'yu doğrular ve oturumu kaydeder. Token uymazsa `null` — çağıran
   * soketi kapatır. Karşılaştırma sabit zamanlı: token uzunluğu sızmasın.
   */
  attach(
    socket: Socket,
    hello: { jobId: string; token: string; activeRunId?: string | null | undefined; droppedEvents?: number | undefined; capabilities?: string[] | undefined },
  ): BridgeSession | null {
    const expectedHex = this.expectedHash(hello.jobId);
    if (!expectedHex) return null;
    const expected = Buffer.from(expectedHex, "hex");
    const given = Buffer.from(hashToken(hello.token), "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    this.sessions.get(hello.jobId)?.close();
    const session = new BridgeSession(
      hello.jobId,
      socket,
      hello.activeRunId ?? null,
      hello.droppedEvents ?? 0,
      hello.capabilities ?? [],
    );
    this.sessions.set(hello.jobId, session);

    const ws = this.waiters.get(hello.jobId) ?? [];
    this.waiters.delete(hello.jobId);
    for (const w of ws) w(session);
    return session;
  }

  detach(session: BridgeSession): void {
    session.close();
    if (this.sessions.get(session.jobId) === session) this.sessions.delete(session.jobId);
  }

  get(jobId: string): BridgeSession | undefined {
    const s = this.sessions.get(jobId);
    return s?.connected ? s : undefined;
  }

  /** Köprü bağlanana kadar bekler — konteyner yeni kalkmış olabilir. */
  waitFor(jobId: string, timeoutMs: number): Promise<BridgeSession> {
    const existing = this.get(jobId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(jobId) ?? [];
        this.waiters.set(jobId, list.filter((w) => w !== onAttach));
        reject(new BridgeError("timeout", `köprü ${timeoutMs} ms içinde bağlanmadı: iş ${jobId}`));
      }, timeoutMs);
      const onAttach = (s: BridgeSession) => {
        clearTimeout(timer);
        resolve(s);
      };
      const list = this.waiters.get(jobId) ?? [];
      list.push(onAttach);
      this.waiters.set(jobId, list);
    });
  }
}
