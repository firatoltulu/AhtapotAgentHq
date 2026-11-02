import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSdkMcpServer, query, tool, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  AsyncQueue,
  GuideGate,
  ServerToBridgeSchema,
  type BridgeToServer,
  type BrowserRunConfig,
  type CodeGraphRunConfig,
  type ServerToBridge,
} from "@ahtapot/shared";

/**
 * Konteyner içi köprü.
 *
 * Sunucuya DIŞARI DOĞRU WebSocket açar, `run.start` gelince SDK'yı çağırır ve
 * her SDK mesajını olduğu gibi geri iletir. Yorum yapmaz: kota, maliyet,
 * kalıcılık sunucunun işi. Konteyner iş boyunca ayakta kalır; sunucu düşüp
 * kalkarsa köprü yeniden bağlanır.
 *
 * Kimlik `identity.set` ile gelir ve YALNIZ `options.env`e girer — konteyner
 * tek anahtar görür, `process.env`e yazılmaz.
 */

const BRIDGE_VERSION = "0.4.0";

/**
 * Taban imajın kurduğu Playwright MCP (`docker/agent/Dockerfile`). Dosya
 * yoksa (imaj tazelenmemiş) `browser` yeteneği bildirilmez ve sunucu
 * tarayıcı turunu atlar — alanı alıp tarayıcısız koşmak sessiz bir yanlış
 * "geçti" üretirdi.
 */
const PLAYWRIGHT_MCP = process.env["AHTAPOT_PLAYWRIGHT_MCP"] ?? "/opt/playwright-mcp/node_modules/@playwright/mcp/cli.js";

/**
 * Taban imajın kurduğu Trail CLI (karar §44). Yoksa `codegraph` yeteneği
 * bildirilmez; sunucu grafik kurmaz, prompt'a da araçları yazmaz.
 */
const TRAIL_BIN = process.env["AHTAPOT_TRAIL_BIN"] ?? "/opt/trail-code/node_modules/.bin/trail";

/** Sunucu yalnız burada bildirilen isteğe bağlı mesajları gönderir. */
const CAPABILITIES = [
  "guide",
  ...(existsSync(PLAYWRIGHT_MCP) ? ["browser"] : []),
  ...(existsSync(TRAIL_BIN) ? ["codegraph"] : []),
];

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`köprü: ${name} tanımlı değil`);
    process.exit(2);
  }
  return v;
}

const serverUrl = must("AHTAPOT_BRIDGE_URL");
const jobId = must("AHTAPOT_JOB_ID");
const token = must("AHTAPOT_BRIDGE_TOKEN");

/** Sunucudan gelen kimlik; anahtarın kendisi log'a asla yazılmaz. */
let identity: { envName: string; value: string } | null = null;

/**
 * Sunucusuz geçen sürede biriken olay sayısı tavanı.
 *
 * Ölçüldü (2026-09-17): en uzun Developer turu 38 dk / 25 tur. 10.000 olay o
 * turun birkaç katını taşır. Taşarsa EN ESKİLER atılır ve `droppedEvents` ile
 * bildirilir — koşu kesilmez, kayıp sessiz kalmaz (kural 3).
 */
const BUFFER_LIMIT = 10_000;

/**
 * Sunucu hiç dönmezse koşu sonsuza dek kota yakmasın: tampon DOLU ve bu kadar
 * süredir bağlantı yoksa köprü kendini kapatır. İkisi birden aranır — kısa bir
 * restart sırasında sessizce biriken bir koşu kesilmemeli.
 */
const ORPHAN_TIMEOUT_MS = 30 * 60_000;

interface ActiveRun {
  runId: string;
  q: Query;
  channel: AsyncQueue<SDKUserMessage> | null;
  /** Mentor önerisinin teslim kapısı (karar §33). */
  gate: GuideGate;
  /** Koşu içi olay sırası; devralmada `sinceSeq` bununla karşılaştırılır. */
  seq: number;
  /** Sunucu yokken biriken olaylar. */
  buffer: { seq: number; event: unknown }[];
  /** Tampon taşınca atılan olay sayısı. */
  dropped: number;
}
let active: ActiveRun | null = null;

let ws: WebSocket | null = null;
let closing = false;
/** Soketin koptuğu an; yetim koşu gözcüsü bunu kullanır. */
let disconnectedAt: number | null = null;

/** Bekleyen `ask_user` soruları: cevap `run.answer` ile gelir. */
const pendingAnswers = new Map<string, (answer: string) => void>();

/**
 * `ask_user` MCP aracı: soruyu sunucuya iletir, cevabı bekler. Sunucu kendi
 * zaman aşımında "varsayımınla devam et" cevabını gönderir; buradaki süre
 * yalnız emniyet (sunucu düşerse tur sonsuza asılı kalmasın).
 */
function askUserServer(runId: string, timeoutMinutes: number) {
  return createSdkMcpServer({
    name: "ahtapot",
    version: "1.0.0",
    tools: [
      tool(
        "ask_user",
        "İnsana soru sor ve cevabı bekle. Kararı tek başına veremediğinde kullan; tahmin etme.",
        { question: z.string().min(1), options: z.array(z.string()).optional() },
        async (args) => {
          const questionId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const answer = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              pendingAnswers.delete(questionId);
              resolve("Cevap gelmedi. Varsayımınla devam et, varsayımı raporunda belirt.");
            }, (timeoutMinutes + 5) * 60_000);
            pendingAnswers.set(questionId, (a) => { clearTimeout(timer); pendingAnswers.delete(questionId); resolve(a); });
            send({ type: "bridge.question", runId, questionId, text: args.question, options: args.options ?? [] });
          });
          return { content: [{ type: "text", text: answer }] };
        },
      ),
    ],
  });
}

function send(msg: BridgeToServer): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * SDK olayını sıralar, tamponlar ve (bağlıysa) yollar.
 *
 * Tampon sunucu koptuğunda da dolmaya devam eder: koşu sürer, yeniden
 * bağlanınca `run.attach` ile buradan devredilir.
 */
function sendEvent(run: ActiveRun, event: unknown): void {
  run.seq += 1;
  run.buffer.push({ seq: run.seq, event });
  if (run.buffer.length > BUFFER_LIMIT) {
    run.dropped += run.buffer.length - BUFFER_LIMIT;
    run.buffer.splice(0, run.buffer.length - BUFFER_LIMIT);
  }
  send({ type: "bridge.event", runId: run.runId, event, seq: run.seq });
}

/** Devralma: tampondan `sinceSeq` SONRASINI yeniden yolla. */
function replayBuffer(run: ActiveRun, sinceSeq: number): void {
  if (run.dropped > 0) {
    send({
      type: "bridge.error",
      runId: run.runId,
      code: "buffer_overflow",
      message: `tampon taştı, ${run.dropped} olay atlandı`,
    });
  }
  for (const b of run.buffer) {
    if (b.seq > sinceSeq) send({ type: "bridge.event", runId: run.runId, event: b.event, seq: b.seq });
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as unknown as SDKUserMessage;
}

/**
 * Mentor önerisi kancası (karar §33): kapı tutuluyorsa araç çağrısı bekler,
 * öneri geldiyse o çağrıya ek bağlam olarak düşer. Kancanın kendi zaman
 * aşımı kapınınkinden uzun: kapı süresi dolunca zaten kendiliğinden açılır.
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

/**
 * Koşu başına Playwright MCP (karar §41).
 *
 * Süreç kanıt dizininde başlar: `browser_take_screenshot`ın dosya adları
 * MCP'nin çalışma köküne göre çözülüyor; worktree'de başlasaydı görüntüler
 * diff'e girerdi. SDK'nın stdio yapılandırması `cwd` almadığı için `sh`.
 *
 * `--isolated`: profil bellekte, koşular arası oturum sızmaz. Tarayıcı
 * `chromium` (Chrome for Testing); Linux'ta bu kanalda Chromium sandbox'ı
 * Playwright kendisi kapatıyor — sınır konteynerin kendisi.
 */
function playwrightServer(cfg: BrowserRunConfig, runId: string): { server: Record<string, unknown>; cleanup: () => void } {
  mkdirSync(cfg.outputDir, { recursive: true });
  const args = [
    PLAYWRIGHT_MCP, "--headless", "--browser", "chromium", "--isolated",
    "--output-dir", cfg.outputDir,
    ...(cfg.allowedOrigins.length > 0 ? ["--allowed-origins", cfg.allowedOrigins.join(";")] : []),
    ...(cfg.viewport ? ["--viewport-size", cfg.viewport] : []),
    ...(cfg.testIdAttribute ? ["--test-id-attribute", cfg.testIdAttribute] : []),
  ];
  let secretsFile: string | null = null;
  if (Object.keys(cfg.secrets).length > 0) {
    secretsFile = join(tmpdir(), `ahtapot-secrets-${runId}.env`);
    // dotenv kaçış dizisi tanımıyor (çift tırnakta yalnız `\n` açılıyor);
    // değer, içinde geçmeyen bir tırnakla sarılır. Satır sonu yalnız çift
    // tırnakta `\n` olarak yazılabilir. Yazılamayan değer atlanır ama adı
    // log'a düşer: agent o adı görür, alan boş kalır — sessiz kalmamalı.
    const skipped: string[] = [];
    const body = Object.entries(cfg.secrets)
      .flatMap(([k, v]) => {
        if (v.includes("\n") || v.includes("\r")) {
          if (v.includes('"') || v.includes("\\n") || v.includes("\r")) {
            skipped.push(k);
            return [];
          }
          return [`${k}="${v.replaceAll("\n", "\\n")}"`];
        }
        const q = ["'", "`", '"'].find((c) => !v.includes(c));
        if (!q) {
          skipped.push(k);
          return [];
        }
        return [`${k}=${q}${v}${q}`];
      })
      .join("\n");
    if (skipped.length > 0) {
      console.error(`[bridge] tarayıcı sırları yazılamadı (dotenv'de kodlanamıyor): ${skipped.join(", ")}`);
    }
    writeFileSync(secretsFile, `${body}\n`, { mode: 0o600 });
    args.push("--secrets", secretsFile);
  }
  const file = secretsFile;
  return {
    server: {
      type: "stdio",
      command: "sh",
      args: ["-c", 'cd "$1" && shift && exec node "$@"', "sh", cfg.outputDir, ...args],
    },
    cleanup: () => {
      if (file) rmSync(file, { force: true });
    },
  };
}

/**
 * Koşu başına Trail MCP sunucuları (karar §44), repo başına bir tane.
 *
 * Grafik motor tarafından önceden kurulmuştur; burada yalnız sunulur. Her
 * sorgu çalışma ağacına bakıp değişeni kendisi tazeler, yazdığı tek yer
 * `--dir` (worktree dışı). `DO_NOT_TRACK`: Trail'in anonim kullanım
 * istatistiği konteynerden çıkmasın.
 */
function codeGraphServers(cfg: CodeGraphRunConfig, env: Record<string, string>): Record<string, Record<string, unknown>> {
  // Kimlik anahtarı Trail'e gitmez: `--deep` kullanılmıyor, ihtiyacı yok.
  // Silmek yetmez — CLI stdio sunucusuna kendi ortamını da miras bırakabilir
  // ve orada anahtar var; boş değer ikisini de ezer. Köprü token'ı da aynı
  // sebeple: sunucuya köprü adına bağlanmayı sağlıyor, Trail'in işi değil.
  const clean: Record<string, string> = {
    ...env, DO_NOT_TRACK: "1", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", AHTAPOT_BRIDGE_TOKEN: "",
  };
  return Object.fromEntries(cfg.servers.map((s) => [s.name, {
    type: "stdio",
    command: TRAIL_BIN,
    args: ["--dir", s.graphDir, "mcp", s.repoDir],
    env: clean,
  }]));
}

function startRun(msg: Extract<ServerToBridge, { type: "run.start" }>): void {
  if (active) {
    send({ type: "bridge.error", runId: msg.runId, code: "busy", message: `koşu zaten sürüyor: ${active.runId}` });
    send({ type: "bridge.done", runId: msg.runId });
    return;
  }

  // Kimlik yalnız bu çağrıya: konteyner ortamında ne varsa temizlenir.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env["ANTHROPIC_API_KEY"];
  delete env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (identity) env[identity.envName] = identity.value;

  const channel = msg.live ? new AsyncQueue<SDKUserMessage>() : null;
  if (channel) channel.push(userMessage(msg.prompt));
  const gate = new GuideGate();
  const browser = msg.browser && CAPABILITIES.includes("browser") ? playwrightServer(msg.browser, msg.runId) : null;

  const q = query({
    prompt: channel ?? msg.prompt,
    options: {
      model: msg.model,
      // `run.start` effort'u taşıyordu ama burada okunmuyordu: sunucu tarafı
      // gönderiyor, köprü yere düşürüyordu. Üretimde koşan yol bu olduğu için
      // effort pratikte hiç uygulanmamıştı.
      ...(msg.effort ? { effort: msg.effort } : {}),
      cwd: msg.cwd,
      maxTurns: msg.maxTurns,
      env,
      includePartialMessages: Boolean(channel),
      mcpServers: {
        ahtapot: askUserServer(msg.runId, msg.askTimeoutMinutes),
        ...(browser ? { playwright: browser.server } : {}),
        ...(msg.codeGraph && CAPABILITIES.includes("codegraph") ? codeGraphServers(msg.codeGraph, env) : {}),
      },
      hooks: guideHooks(gate),
      ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
      ...(msg.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(msg.allowedTools ? { allowedTools: msg.allowedTools } : {}),
      ...(msg.disallowedTools ? { disallowedTools: msg.disallowedTools } : {}),
      ...(msg.systemPrompt ? { systemPrompt: msg.systemPrompt } : {}),
      ...(msg.appendSystemPrompt
        ? { systemPrompt: { type: "preset", preset: "claude_code", append: msg.appendSystemPrompt } }
        : {}),
      ...(msg.resumeSessionId ? { resume: msg.resumeSessionId } : {}),
    } as never,
  });

  const run: ActiveRun = { runId: msg.runId, q, channel, gate, seq: 0, buffer: [], dropped: 0 };
  active = run;

  void (async () => {
    try {
      for await (const event of q as AsyncIterable<unknown>) {
        sendEvent(run, event);
      }
    } catch (err) {
      send({
        type: "bridge.error",
        runId: msg.runId,
        code: "sdk",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      gate.release(null);
      browser?.cleanup();
      if (active?.runId === msg.runId) active = null;
      send({ type: "bridge.done", runId: msg.runId });
    }
  })();
}

function handle(msg: ServerToBridge): void {
  switch (msg.type) {
    case "identity.set":
      identity = { envName: msg.envName, value: msg.value };
      console.log(`köprü: kimlik alındı (${msg.envName})`);
      return;
    case "run.start":
      startRun(msg);
      return;
    case "run.input":
      if (!active || active.runId !== msg.runId) return;
      if (msg.interrupt) void active.q.interrupt().catch(() => {});
      active.channel?.push(userMessage(msg.text));
      return;
    case "run.close":
      if (active?.runId === msg.runId) active.channel?.end();
      return;
    case "run.abort":
      if (active?.runId === msg.runId) {
        void active.q.interrupt().catch(() => {});
        active.channel?.end();
      }
      return;
    case "run.attach":
      // Sunucu canlı koşuyu devraldı: tampondan kaçırdıklarını geri yolla.
      if (active?.runId === msg.runId) {
        console.log(`köprü: koşu ${msg.runId} devralındı (seq>${msg.sinceSeq})`);
        replayBuffer(active, msg.sinceSeq);
      } else {
        send({
          type: "bridge.error",
          runId: msg.runId,
          code: "no_such_run",
          message: "devralınacak canlı koşu yok",
        });
        send({ type: "bridge.done", runId: msg.runId });
      }
      return;
    case "run.answer": {
      const resolve = pendingAnswers.get(msg.questionId);
      if (resolve) resolve(msg.answer);
      return;
    }
    case "run.hold":
      if (active?.runId === msg.runId) active.gate.hold(msg.timeoutMs);
      return;
    case "run.guide":
      if (active?.runId === msg.runId) active.gate.release(msg.text || null);
      return;
  }
}

function connect(attempt = 0): void {
  if (closing) return;
  const socket = new WebSocket(serverUrl);
  ws = socket;

  socket.onopen = () => {
    console.log(`köprü: bağlandı → ${serverUrl}`);
    disconnectedAt = null;
    // Canlı koşu varsa bildir: sunucu `run.attach` ile devralır. Tamponun ilk
    // sırası ve atılan olay sayısı da gider — sunucu boşluğu görebilsin.
    send({
      type: "bridge.hello",
      jobId,
      token,
      bridgeVersion: BRIDGE_VERSION,
      activeRunId: active?.runId ?? null,
      bufferedFrom: active?.buffer[0]?.seq ?? 0,
      droppedEvents: active?.dropped ?? 0,
      capabilities: CAPABILITIES,
    });
  };

  socket.onmessage = (ev) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const result = ServerToBridgeSchema.safeParse(parsed);
    if (!result.success) {
      send({ type: "bridge.error", runId: null, code: "bad_message", message: "sunucu mesajı şemaya uymuyor" });
      return;
    }
    handle(result.data);
  };

  socket.onclose = () => {
    if (closing) return;
    // KOŞU KESİLMEZ. Eskiden burada `q.interrupt()` vardı ve 2 saniyelik bir
    // sunucu yeniden başlatması 38 dakikalık turu öldürüyordu. Agent konteynerde
    // çalışmaya devam eder, olaylar tamponda birikir, yeniden bağlanınca
    // `run.attach` ile devredilir.
    if (active) {
      disconnectedAt ??= Date.now();
      console.log(`köprü: sunucu gitti, koşu ${active.runId} SÜRÜYOR (tampon ${active.buffer.length})`);
    }
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    console.log(`köprü: bağlantı koptu, ${delay} ms sonra yeniden`);
    setTimeout(() => connect(attempt + 1), delay);
  };

  socket.onerror = () => {
    // onclose zaten yeniden bağlanacak; burada gürültü üretme.
  };
}

/**
 * Yetim koşu gözcüsü.
 *
 * Koşu artık sunucusuz da sürüyor — bu, sunucu HİÇ dönmezse konteynerin
 * sonsuza dek kota yakması demek. İki koşul BİRLİKTE arandığında kesilir:
 * tampon dolmuş VE uzun süredir bağlantı yok. Tek başına süre yetmez; kısa bir
 * restart sırasında sessizce ilerleyen bir tur kesilmemeli.
 */
setInterval(() => {
  if (!active || disconnectedAt === null) return;
  const away = Date.now() - disconnectedAt;
  if (away < ORPHAN_TIMEOUT_MS) return;
  if (active.buffer.length < BUFFER_LIMIT) return;
  console.error(
    `köprü: ${Math.round(away / 60_000)} dk sunucusuz ve tampon dolu — koşu ${active.runId} kesiliyor`,
  );
  void active.q.interrupt().catch(() => {});
  active.channel?.end();
  active = null;
}, 60_000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    closing = true;
    if (active) void active.q.interrupt().catch(() => {});
    ws?.close();
    process.exit(0);
  });
}

connect();
