import { and, eq } from "drizzle-orm";

import type { AgentRoleName, BrowserRunConfig, CodeGraphRunConfig, PermissionMode } from "@ahtapot/shared";

import { newId, isoNow, toMicroUsd, type Db, schema } from "../db/index.js";
import { nextMessageSeq } from "../engine/transition.js";
import type { EventHub } from "../ws/hub.js";
import { AllIdentitiesExhausted, detectQuota, type IdentityPool } from "./identity.js";
import { LiveInputChannel, LocalTransport, type AgentTransport } from "./transport.js";
import { toolFields } from "./toolFields.js";
import type { AskUser } from "./askUser.js";
import { StuckDetector, targetOf, type StuckSignal, type StuckThresholds } from "./stuck.js";
import type { ConsultRequest } from "./mentor.js";
import type { GuideControl } from "./transport.js";

export { LiveInputChannel } from "./transport.js";

/**
 * Agent turu sürücüsü.
 *
 * SDK'yı taşıma katmanı üzerinden çağırır (host'ta ya da konteynerde),
 * olayları WS'e akıtır, maliyeti ve token'ları kaydeder. Kimlik her çağrıya
 * AYRI verilir: paralel işler birbirinin kimliğini ezmez ve kota devretmesi
 * oturumu koparmaz.
 */

export interface RunOptions {
  jobId: string | null;
  role: AgentRoleName;
  prompt: string;
  model: string;
  effort?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Mesaj akışı bu kadar dakika susarsa tur kesilir (varsayılan 5). */
  idleTimeoutMinutes?: number;
  cwd: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string | null;
  /**
   * Oturum bırakılıp baştan konuşulursa gönderilecek prompt. `resume` turunun
   * prompt'u çoğu zaman yalnız devamı taşır ("düzelt" + geri bildirim); yeni
   * oturum o hâliyle safhanın ne olduğunu bilmez. Verilmezse `prompt` gider.
   */
  freshPrompt?: string;
  /** Canlı sohbet isteniyorsa verilir; yoksa tek atışlık çalışır. */
  channel?: LiveInputChannel;
  /** Verilmezse yapıcıdaki varsayılan (host'ta `query()`). İş konteynerinde köprü. */
  transport?: AgentTransport;
  /**
   * Canlı koşuda her tur sonunda (SDK `result`) çağrılır; o turun asistan
   * metnini alır. Çağıran "bu tur işi bitirdi mi" kararını buradan verir ve
   * kanalı kapatır — aksi hâlde koşu kullanıcı mesajı bekleyerek açık kalır.
   */
  onTurn?: (turn: { text: string; subtype: string; numTurns: number }) => void;
  /** Agent sorusu; runner olayı yayınlar ve mesajı kaydeder, cevabı çağıran verir. */
  askUser?: AskUser;
  askTimeoutMinutes?: number;
  /**
   * Başka bir koşunun içinden açılan yan koşu (mentor). İptal kolunu
   * (`running`) EZMEZ — aynı işin asıl koşusu kesilemez hâle gelirdi — akışa
   * agent.start/end/message yazmaz (UI asıl koşu bitti sanmasın) ve döngü
   * tespiti koşmaz. Maliyet ve koşu kaydı yine tutulur.
   */
  nested?: boolean;
  /** Playwright MCP; taşıma `browser` yeteneğini bildirmiyorsa düşer (bkz. `AgentTransport.supports`). */
  browser?: BrowserRunConfig;
  /** Trail MCP; taşıma `codegraph` yeteneğini bildirmiyorsa düşer. */
  codeGraph?: CodeGraphRunConfig;
}

export interface RunResult {
  runId: string;
  sessionId: string | null;
  subtype: string;
  /** Son asistan metni — yapılandırılmış çıktı buradan ayrıştırılır. */
  text: string;
  costMicroUsd: number;
  numTurns: number;
  quota: boolean;
  /**
   * Koşu başarısızsa sebebi — SDK'nın fırlattığı hata ya da `result`
   * mesajının gövdesi. Motor bunu işin hata mesajına koyar; yoksa insan
   * yalnız "(error)" görür ve teşhis için DB'ye bakmak zorunda kalır.
   */
  errorMessage?: string;
}

/**
 * İş + rol için döngü tespiti açık mı? `null` → izlenmez.
 *
 * Runner profili bilmez; karar motorun. Her koşunun başında bir kez sorulur.
 */
export type StuckPolicy = (jobId: string, role: AgentRoleName) => StuckPolicyResult | null;

export interface StuckPolicyResult {
  thresholds: StuckThresholds;
  expectWrites: boolean;
  /**
   * Danışma modu (`consult`) açıksa: motor mentoru koşar, agent'a gidecek
   * metni ya da (atlandıysa) `null` döner. Yoksa yalnız gözlem.
   */
  consult?: {
    run: (req: ConsultRequest) => Promise<string | null>;
    maxPerRun: number;
    holdTimeoutMs: number;
  };
}

export class AgentRunner {
  private stuckPolicy: StuckPolicy | null = null;

  /** Motor kurulunca bağlanır; runner motordan önce kuruluyor. */
  setStuckPolicy(policy: StuckPolicy): void {
    this.stuckPolicy = policy;
  }

  constructor(
    private readonly db: Db,
    private readonly pool: IdentityPool,
    private readonly hub: EventHub | null,
    private readonly defaultTransport: AgentTransport = new LocalTransport(),
  ) {}

  /**
   * İş başına koşan turun iptal kolu.
   *
   * İptal DB'ye durum yazmakla bitmiyordu: iş `Cancelled` göründüğü hâlde agent
   * turu arka planda koşmaya devam ediyor, kimlik ve bütçe yanıyordu. Ölçüldü
   * (Sevkiyat, 2026-09-16): iptalden sonra motor işi hâlâ `busy` sayıp profil
   * değişimini reddetti.
   */
  private readonly running = new Map<string, (reason: string) => Promise<void>>();

  /**
   * Koşan turu keser. Dönen değer kesilecek bir tur BULUNUP bulunmadığıdır —
   * çağıran "iptal ettim" derken yalan söylemesin.
   */
  async abortJob(jobId: string, reason: string): Promise<boolean> {
    const abort = this.running.get(jobId);
    if (!abort) return false;
    await abort(reason).catch(() => {});
    return true;
  }

  /**
   * Bir agent turu koşar.
   *
   * Kota yakalanırsa kimlik dinlenmeye alınır ve sıradakiyle AYNI oturumdan
   * devam edilir — iş baştan başlamaz. Tüm kimlikler kotadaysa hata yükselir
   * ve iş bekletilir (deneme hakkı boşa yakılmaz).
   */
  async run(opts: RunOptions): Promise<RunResult> {
    const attempted = new Set<number>();
    let sessionRetried = false;

    for (;;) {
      const identity = this.pool.acquire();
      if (attempted.has(identity.index)) {
        // Havuzdaki her kimlik denendi ve hepsi kotaya girdi.
        throw new AllIdentitiesExhausted(this.pool.nextResetAt());
      }
      attempted.add(identity.index);

      const result = await this.runOnce(opts, identity);

      // KAYIP OTURUM ÖLÜMCÜL DEĞİL.
      //
      // `resume` bir iyileştirme, koşmanın ön şartı değil: transcript yoksa
      // iş baştan konuşur, ama KOŞAR. Transcript SDK'nın `CLAUDE_CONFIG_DIR`
      // dizininde durur ve o dizin kalıcı olmayabilir — worktree named
      // volume'e taşınınca eski bind-mount'taki transcript'ler geride kaldı,
      // DB'deki oturum kimlikleri ise duruyordu. Sonuç: her deneme
      // "No conversation found with session ID" ile anında düşüyordu;
      // kendi kendine çıkamayan bir kilit (yaşandı 2026-09-17).
      //
      // TAŞMIŞ OTURUM DA AYNI KİLİT. Transcript model bağlamını aşınca devralan
      // her tur ilk istekte "Prompt is too long" ile düşer; yeniden deneme aynı
      // transcript'i devraldığı için insan hiçbir şey yapamaz (yaşandı
      // 2026-09-25: Developer, haiku, "oturum devralındı" → 55 sn sonra aynı hata).
      // Çıkış oturumu bırakmak; ağaçtaki iş kaybolmaz, bağlamı `freshPrompt` taşır.
      //
      // Bir kez: ikinci kez düşerse sebep oturum değildir.
      if (
        !sessionRetried && opts.resumeSessionId &&
        (isMissingSession(result.errorMessage) || isContextOverflow(result.errorMessage))
      ) {
        sessionRetried = true;
        attempted.delete(identity.index);
        opts = { ...opts, resumeSessionId: null, prompt: opts.freshPrompt ?? opts.prompt };
        continue;
      }

      if (!result.quota) return result;
      // Kota: kimlik dinlenmeye alındı, aynı oturumdan devam edilecek.
      opts = { ...opts, resumeSessionId: result.sessionId ?? opts.resumeSessionId ?? null };
    }
  }

  private async runOnce(
    opts: RunOptions,
    identity: ReturnType<IdentityPool["acquire"]>,
  ): Promise<RunResult> {
    const runId = newId();
    const quiet = opts.nested === true;
    const sessionRow = opts.jobId ? this.ensureSession(opts, runId) : null;

    this.db
      .insert(schema.agentRuns)
      .values({
        id: runId,
        sessionId: sessionRow,
        jobId: opts.jobId,
        role: opts.role,
        model: opts.model,
        effort: opts.effort ?? null,
        identityIndex: identity.index,
        status: "running",
      })
      .run();

    if (opts.jobId && this.hub && !quiet) {
      this.hub.publish(opts.jobId, {
        type: "agent.start",
        runId,
        role: opts.role,
        model: opts.model,
        sessionId: opts.resumeSessionId ?? null,
      });
    }

    const started = Date.now();
    let sessionId: string | null = opts.resumeSessionId ?? null;
    let lastText = "";
    let turnText = "";
    let costMicroUsd = 0;
    let numTurns = 0;
    let subtype = "unknown";
    let quota = false;
    let quotaEpoch: number | null = null;
    let errorMessage: string | null = null;
    /** toolId → çağrının başladığı an; sonucun süresi buradan çıkar. */
    const toolStartedAt = new Map<string, number>();

    const transport = opts.transport ?? this.defaultTransport;

    // Tespit düşerse koşu düşmemeli: politika hatası yalnız izlemeyi kapatır.
    let stuck: StuckDetector | null = null;
    let policy: StuckPolicyResult | null = null;
    if (opts.jobId && this.hub && this.stuckPolicy && !quiet) {
      try {
        policy = this.stuckPolicy(opts.jobId, opts.role);
        if (policy) stuck = new StuckDetector(policy.thresholds, policy.expectWrites);
      } catch {
        policy = null;
        stuck = null;
      }
    }

    // Danışma için kanıt: hedef başına son sonuç ve agent'ın son sözleri.
    // Mentor araçsız koşar; dosyayı ve hatayı yalnız buradan görür.
    const toolTarget = new Map<string, string>();
    const lastResult = new Map<string, string>();
    let lastAnyResult = "";
    const recentText: string[] = [];
    const consultAttempts = new Map<string, number>();
    let consultsInRun = 0;
    let consultInFlight = false;
    const skipNoted = new Set<string>();
    let guide: GuideControl | undefined;

    const noteSkip = (sig: StuckSignal, reason: string): void => {
      // Aynı sebep koşu başına bir kez: sinyal her eşik katında tekrar düşer.
      if (skipNoted.has(reason) || !opts.jobId || !this.hub) return;
      skipNoted.add(reason);
      this.hub.publish(opts.jobId, {
        type: "agent.mentor", runId, role: opts.role, juniorModel: opts.model,
        mentorModel: "", signal: sig.signal, target: sig.target, outcome: "skipped",
        advice: "", reason, costMicroUsd: 0,
      });
    };

    const consult = (sig: StuckSignal): void => {
      const c = policy?.consult;
      if (!c) return;
      if (consultInFlight) return;
      if (consultsInRun >= c.maxPerRun) return noteSkip(sig, `koşu tavanı (${c.maxPerRun} danışma)`);
      if (!guide) return noteSkip(sig, "köprü öneri teslimini desteklemiyor (imaj eski)");
      const g = guide;
      const key = `${sig.signal}\u0000${sig.target}`;
      const attempt = (consultAttempts.get(key) ?? 0) + 1;
      consultAttempts.set(key, attempt);
      consultsInRun++;
      consultInFlight = true;
      // Agent'ın SIRADAKİ araç çağrısı öneriyi bekler; gözcü bunu bilinçli
      // bekleme sayar (ask_user gibi), takılmış tur değil.
      g.hold(c.holdTimeoutMs);
      askHook(1);
      const evidence = sig.signal === "no_progress" ? lastAnyResult : (lastResult.get(sig.target) ?? lastAnyResult);
      void c.run({ runId, role: opts.role, juniorModel: opts.model, signal: sig, attempt, evidence, recentText: [...recentText] })
        .then((text) => g.release(text))
        .catch(() => g.release(null))
        .finally(() => {
          askHook(-1);
          consultInFlight = false;
        });
    };

    const reportStuck = (sig: StuckSignal | null): void => {
      if (!sig || !opts.jobId || !this.hub) return;
      this.hub.publish(opts.jobId, { type: "agent.stuck", runId, role: opts.role, model: opts.model, ...sig });
      consult(sig);
    };

    // BİLİNÇLİ BEKLEME sessizlik sayılmaz. İki durumda akış susar ama tur
    // takılmış değildir:
    //  - agent soru sordu ve cevap bekliyor (`askUser`, kendi zaman aşımı var);
    //  - canlı kanalda tur bitti, blok (HANDOFF_JSON vb.) yok, motor insan
    //    mesajı bekliyor (`onLiveTurn`, `askTimeoutMinutes` sonra dürter).
    // YAŞANDI (2026-09-24): Developer kodu yazıp turu bloksuz bitirdi; motor
    // 30 dk beklerken gözcü 5 dk'da koşuyu "takılmış tur" diye kesti. Yeniden
    // denemede aynısı oldu — iş her seferinde developer_error'a düştü.
    let pendingAsks = 0;
    let idleSince: number | null = null;
    let pushesAtTurnEnd = -1;
    const waitingOnPurpose = (): boolean => {
      if (pendingAsks > 0) return true;
      const ch = opts.channel;
      return pushesAtTurnEnd >= 0 && !!ch && !ch.closed && ch.pushes === pushesAtTurnEnd;
    };
    const askHook = (delta: 1 | -1): void => {
      pendingAsks += delta;
      idleSince = Date.now();
    };

    try {
      // Kimlik YALNIZ bu çağrıya verilir; taşıma katmanı onu process.env'e yazmaz.
      const started = transport.start({
        runId,
        role: opts.role,
        prompt: opts.prompt,
        model: opts.model,
        ...(opts.effort ? { effort: opts.effort } : {}),
        maxTurns: opts.maxTurns,
        maxBudgetUsd: opts.maxBudgetUsd,
        cwd: opts.cwd,
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
        ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
        resumeSessionId: opts.resumeSessionId ?? null,
        ...(opts.channel ? { channel: opts.channel } : {}),
        identity: { envName: identity.envName, value: identity.value },
        ...(opts.askUser ? { askUser: this.wrapAskUser(opts, runId, opts.askUser, askHook) } : {}),
        ...(opts.askTimeoutMinutes ? { askTimeoutMinutes: opts.askTimeoutMinutes } : {}),
        ...(opts.browser ? { browser: opts.browser } : {}),
        ...(opts.codeGraph ? { codeGraph: opts.codeGraph } : {}),
      });
      guide = started.guide;

      // Sessizlik gözcüsü: tur sonsuza dek asılı kalmasın.
      // ÖLÇÜLDÜ: Planner bu ortamda olmayan bir aracı (WebSearch) çağırdı, çağrı
      // hiç dönmedi ve iş 11 dakika "koşuyor" göründü. Kimse tamamlamayacağı
      // hâlde ilerleme yokken ekranda çalışıyormuş gibi durmak, sistemin en
      // pahalı yalanı.
      const idleMs = (opts.idleTimeoutMinutes ?? 5) * 60_000;
      let lastMsgAt = Date.now();
      let idleAbort: string | null = null;
      const watchdog = setInterval(() => {
        // Bekleme bitince (cevap geldi, kanala mesaj düştü) saat baştan başlar;
        // beklemeden önceki sessizlik sonrakine eklenmez.
        if (waitingOnPurpose()) {
          idleSince = Date.now();
          return;
        }
        if (idleSince !== null) {
          lastMsgAt = Math.max(lastMsgAt, idleSince);
          idleSince = null;
        }
        if (Date.now() - lastMsgAt < idleMs) return;
        idleAbort = `agent ${idleMs / 60_000} dk boyunca hiçbir mesaj üretmedi (takılmış tur)`;
        void started.abort(idleAbort).catch(() => {});
      }, Math.min(15_000, Math.max(50, idleMs / 2)));
      // Süreç kapanışını engellemesin.
      watchdog.unref?.();

      // Dışarıdan iptal (insan "iptal" dedi) aynı kolu çeker. `idleAbort`
      // paylaşılır: kesilen tur ne olursa olsun başarı sayılmaz.
      if (opts.jobId && !quiet) {
        this.running.set(opts.jobId, async (reason) => {
          idleAbort = reason;
          await started.abort(reason);
        });
      }

      try {
      for await (const msg of started.messages) {
        lastMsgAt = Date.now();
        pushesAtTurnEnd = -1;
        const type = String(msg["type"] ?? "");

        if (type === "system" && msg["session_id"]) {
          sessionId = String(msg["session_id"]);
          // HEMEN yazılır, koşu bitince değil: sunucu turun ORTASINDA ölürse
          // (restart, çökme) oturum kimliği kaydedilmemiş olur ve konteynerde
          // duran koşu resume edilemez — devralmanın önündeki en sessiz engel
          // buydu. Aynı değer tekrar yazılabilir, idempotent.
          if (sessionRow) {
            this.db
              .update(schema.agentSessions)
              .set({ sdkSessionId: sessionId })
              .where(eq(schema.agentSessions.id, sessionRow))
              .run();
          }
        }

        if (type === "stream_event" && opts.jobId && this.hub && !quiet) {
          const ev = msg["event"] as Record<string, unknown> | undefined;
          const delta = ev?.["delta"] as Record<string, unknown> | undefined;
          if (delta && delta["type"] === "text_delta") {
            this.hub.publish(opts.jobId, {
              type: "agent.delta",
              runId,
              blockIndex: Number(ev?.["index"] ?? 0),
              text: String(delta["text"] ?? ""),
            });
          }
        }

        if (type === "assistant") {
          const message = msg["message"] as { content?: unknown[] } | undefined;
          for (const block of message?.content ?? []) {
            const b = block as Record<string, unknown>;
            if (b["type"] === "text") {
              lastText += String(b["text"] ?? "");
              turnText += String(b["text"] ?? "");
              if (stuck) {
                recentText.push(String(b["text"] ?? "").slice(0, 1500));
                if (recentText.length > 3) recentText.shift();
              }
              if (opts.jobId && this.hub && !quiet) {
                this.hub.publish(opts.jobId, {
                  type: "agent.message",
                  runId,
                  role: "assistant",
                  content: String(b["text"] ?? ""),
                });
              }
            } else if (b["type"] === "tool_use" && opts.jobId && this.hub && !quiet) {
              const toolId = String(b["id"] ?? "");
              const name = String(b["name"] ?? "");
              // Süre ölçümü sonucunda kullanılacak: eşleşme toolId üzerinden.
              toolStartedAt.set(toolId, Date.now());
              this.hub.publish(opts.jobId, {
                type: "agent.tool_use",
                runId,
                toolId,
                name,
                // Araç girdisi ÖZETLENİR: tam içerik hem hacimli hem sır taşıyabilir.
                inputSummary: summarizeInput(b["input"]),
                // Araca özel okunabilir alanlar (komut, dosya, fark). Kesilmemiş
                // girdiyi yalnız burası gördüğü için çıkarım üretici tarafta.
                ...toolFields(name, b["input"]),
              });
              if (stuck) {
                const inp = (b["input"] && typeof b["input"] === "object" ? b["input"] : {}) as Record<string, unknown>;
                toolTarget.set(toolId, targetOf(name, inp));
              }
              reportStuck(stuck?.onToolUse(toolId, name, b["input"]) ?? null);
            }
          }
        }

        /**
         * Araç SONUÇLARI burada.
         *
         * SDK sonucu `user` rolünde bir mesajın `tool_result` bloklarıyla
         * döndürüyor; bu dal yoktu, dolayısıyla `agent.tool_result` şemada
         * tanımlı olmasına rağmen HİÇ yayınlanmıyordu. Akışta komut görünüyor,
         * sonucu görünmüyordu — operatör "koştu mu, kırıldı mı" sorusunu
         * cevaplayamıyordu.
         */
        if (type === "user" && opts.jobId && this.hub && !quiet) {
          const message = msg["message"] as { content?: unknown[] } | undefined;
          for (const block of message?.content ?? []) {
            const b = block as Record<string, unknown>;
            if (b["type"] !== "tool_result") continue;
            const toolId = String(b["tool_use_id"] ?? "");
            const text = resultText(b["content"]);
            const startedAt = toolStartedAt.get(toolId);
            toolStartedAt.delete(toolId);
            const exit = exitCodeOf(text);
            this.hub.publish(opts.jobId, {
              type: "agent.tool_result",
              runId,
              toolId,
              ok: b["is_error"] !== true,
              summary: summarizeResult(text),
              chars: text.length,
              ...(exit === undefined ? {} : { exitCode: exit }),
              ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
            });
            if (stuck) {
              const target = toolTarget.get(toolId);
              toolTarget.delete(toolId);
              const kept = text.slice(-20_000);
              lastAnyResult = kept;
              if (target !== undefined) {
                lastResult.set(target, kept);
                // Uzun koşuda sınırsız büyümesin; en eski hedef düşer.
                if (lastResult.size > 64) lastResult.delete(lastResult.keys().next().value!);
              }
            }
            reportStuck(stuck?.onToolResult(toolId, b["is_error"] !== true, text, exit) ?? null);
          }
        }

        if (type === "result") {
          subtype = String(msg["subtype"] ?? "unknown");
          numTurns = Number(msg["num_turns"] ?? 0);
          costMicroUsd = toMicroUsd(Number(msg["total_cost_usd"] ?? 0));
          if (typeof msg["result"] === "string" && msg["result"].length > 0) {
            lastText = msg["result"];
          }
          // SDK HATAYI FIRLATMADAN da bildirebilir: `result` mesajı
          // `subtype: "error"` taşır ve akış normal biter — `catch` bloğuna
          // hiç girilmez. Sebep buraya yazılmazsa HİÇBİR YERE yazılmıyordu:
          // DB'de `error_message` boş, olayda yalnız "error" (yaşandı
          // 2026-09-17: Developer 2,5 sn'de sıfır turla düştü, log sessiz).
          if (subtype !== "success" && !errorMessage) {
            const body =
              typeof msg["result"] === "string" && msg["result"].length > 0
                ? msg["result"]
                : JSON.stringify(msg["error"] ?? msg["result"] ?? msg);
            errorMessage = `SDK sonucu: ${subtype} — ${body.slice(0, 2000)}`;
          }
          // Kota imzası YALNIZ burada ve hata nesnesinde aranır.
          const probe = detectQuota(`${subtype} ${JSON.stringify(msg["result"] ?? "")}`);
          if (probe.quota) {
            quota = true;
            quotaEpoch = probe.resetEpoch;
          }
          const usage = msg["usage"] as Record<string, number> | undefined;
          if (usage) this.recordUsage(runId, usage);
          // Canlı koşuda tur bitti; karar çağıranın (kanalı kapatır ya da bekler).
          if (opts.onTurn) {
            const text = turnText || lastText;
            turnText = "";
            opts.onTurn({ text, subtype, numTurns });
          }
          // Kanal açık kaldıysa (onTurn kapatmadıysa) tur bitti, insan bekleniyor.
          if (opts.channel && !opts.channel.closed) pushesAtTurnEnd = opts.channel.pushes;
        }
      }
      } finally {
        clearInterval(watchdog);
        guide?.release(null);
        if (opts.jobId && !quiet) this.running.delete(opts.jobId);
      }
      // Gözcü ya da insan kestiyse akış sessizce biter; bunu başarı sayma.
      if (idleAbort) throw new Error(idleAbort);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      const probe = detectQuota(errorMessage);
      if (probe.quota) {
        quota = true;
        quotaEpoch = probe.resetEpoch;
      }
      subtype = quota ? "quota" : "error";
    }

    this.db
      .update(schema.agentRuns)
      .set({
        status: quota ? "quota" : errorMessage ? "error" : "success",
        endedAt: isoNow(),
        numTurns,
        costMicroUsd,
        stopReason: subtype,
        errorMessage,
      })
      .where(eq(schema.agentRuns.id, runId))
      .run();

    if (quota) {
      this.pool.markCooldown(identity.index, quotaEpoch);
    } else if (!errorMessage) {
      this.pool.markSuccess(identity.index, costMicroUsd);
    }

    // Oturum kimliği artık öğrenilir öğrenilmez yazılıyor (yukarıda, `system`
    // mesajında). Burada yalnız `resume` ile gelen ve hiç `system` mesajı
    // görmeyen koşular için güvence kalıyor.
    if (sessionRow && sessionId) {
      this.db
        .update(schema.agentSessions)
        .set({ sdkSessionId: sessionId })
        .where(eq(schema.agentSessions.id, sessionRow))
        .run();
    }

    if (opts.jobId) {
      this.recordCost(opts, runId, costMicroUsd);
      if (this.hub && !quiet) {
        this.hub.publish(opts.jobId, {
          type: "agent.end",
          runId,
          subtype,
          costMicroUsd,
          numTurns,
          durationMs: Date.now() - started,
        });
      }
      if (lastText && !quiet) this.persistMessage(opts.jobId, runId, lastText);
    }

    return { runId, sessionId, subtype, text: lastText, costMicroUsd, numTurns, quota, ...(errorMessage ? { errorMessage } : {}) };
  }

  /**
   * İş + rol için açık oturum satırı. Resume kimliğiyle ya da (iş, rol, açık)
   * üçlüsüyle bulunur; yoksa açılır. Her koşuda yeni satır açmak, "bu rolün
   * oturumu hangisi" sorusunu cevapsız bırakırdı.
   */
  /** Soru UI'a düşer ve mesaj olarak kalır; cevap da. Bekletme çağıranın. */
  private wrapAskUser(opts: RunOptions, runId: string, ask: AskUser, hook: (delta: 1 | -1) => void): AskUser {
    return async (q) => {
      if (opts.jobId) {
        this.hub?.publish(opts.jobId, { type: "agent.question", runId, questionId: q.questionId, text: q.text, options: q.options });
        this.persistMessage(opts.jobId, runId, q.text, "assistant", "question", { questionId: q.questionId, options: q.options });
      }
      // Cevap beklenirken gözcü susar; beklemenin sınırı `askTimeoutMinutes`.
      hook(1);
      let answer: string;
      try {
        answer = await ask(q);
      } finally {
        hook(-1);
      }
      if (opts.jobId) this.persistMessage(opts.jobId, runId, answer, "user", "answer", { questionId: q.questionId });
      return answer;
    };
  }

  private ensureSession(opts: RunOptions, _runId: string): string {
    const existing = opts.resumeSessionId
      ? this.db
          .select({ id: schema.agentSessions.id })
          .from(schema.agentSessions)
          .where(eq(schema.agentSessions.sdkSessionId, opts.resumeSessionId))
          .all()
      : this.db
          .select({ id: schema.agentSessions.id })
          .from(schema.agentSessions)
          .where(
            and(
              eq(schema.agentSessions.jobId, opts.jobId!),
              eq(schema.agentSessions.role, opts.role),
              eq(schema.agentSessions.status, "open"),
            ),
          )
          .all();

    const found = existing[0];
    if (found) return found.id;

    const id = newId();
    this.db
      .insert(schema.agentSessions)
      .values({
        id,
        jobId: opts.jobId!,
        role: opts.role,
        sdkSessionId: opts.resumeSessionId ?? null,
        model: opts.model,
      })
      .run();
    return id;
  }

  private recordUsage(runId: string, usage: Record<string, number>): void {
    this.db
      .update(schema.agentRuns)
      .set({
        inputTokens: Number(usage["input_tokens"] ?? 0),
        outputTokens: Number(usage["output_tokens"] ?? 0),
        cacheReadTokens: Number(usage["cache_read_input_tokens"] ?? 0),
        cacheCreationTokens: Number(usage["cache_creation_input_tokens"] ?? 0),
      })
      .where(eq(schema.agentRuns.id, runId))
      .run();
  }

  private recordCost(opts: RunOptions, runId: string, micro: number): void {
    if (micro <= 0) return;
    this.db
      .insert(schema.costRecords)
      .values({
        id: newId(),
        jobId: opts.jobId,
        runId,
        role: opts.role,
        model: opts.model,
        microUsd: micro,
      })
      .run();
  }

  private persistMessage(jobId: string, runId: string, text: string, role = "assistant", kind = "text", metadata: unknown = null): void {
    // 64 KB üstü içerik satıra sığmaz; özet bırakılır (tamamı artifact'e gider).
    const content = text.length > 64_000 ? `${text.slice(0, 64_000)}\n…[kesildi]` : text;
    this.db
      .insert(schema.messages)
      .values({
        id: newId(),
        jobId,
        runId,
        seq: nextMessageSeq(this.db, jobId),
        role,
        kind,
        content,
        metadata: metadata as never,
      })
      .run();
  }
}

/** Araç girdisini kısa ve sırsız bir satıra indirger. */
/**
 * SDK "o oturum yok" mu diyor?
 *
 * `resume` edilen transcript silinmiş ya da başka bir diske taşınmışsa SDK
 * koşuyu anında reddeder. Bu, işin kendisiyle ilgili bir hata DEĞİL: oturumsuz
 * yeniden denenebilir.
 */
function isMissingSession(message: string | undefined): boolean {
  if (!message) return false;
  return /No conversation found with session ID|session .* not found/i.test(message);
}

/**
 * SDK "istek model bağlamına sığmıyor" mu diyor?
 *
 * Kural 6 gibi YALNIZ hata nesnesi / `result` gövdesinde aranır; asistan
 * metnindeki "prompt is too long" (ör. bu konudaki bir iş) oturumu bıraktırmaz.
 */
function isContextOverflow(message: string | undefined): boolean {
  if (!message) return false;
  return /Prompt is too long|prompt_too_long|context (?:length|window) exceeded/i.test(message);
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * SDK `tool_result` bloğunun içeriğini düz metne indirger.
 *
 * İçerik ya dize ya da `{type:"text",text}` blokları dizisi olabilir; ikisi de
 * görüldü. Tanınmayan şekil sessizce boş dönmemeli — operatör "sonuç geldi mi"
 * sorusunu olayın varlığından cevaplıyor, metni boş olsa bile.
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (typeof b["text"] === "string") parts.push(b["text"]);
    }
  }
  return parts.join("\n");
}

/** Sonuç metnini akışa sığacak kadar kısaltır — baş ve son korunur. */
function summarizeResult(text: string): string {
  const t = text.trim();
  if (t.length <= 600) return t;
  // Ortası atılır: hata çoğu zaman SONDA, komut yankısı BAŞTA olur.
  return `${t.slice(0, 380)}\n…\n${t.slice(-180)}`;
}

/** Çıkış kodunu sonuç metninden çıkarır; bulunamazsa alan yazılmaz. */
function exitCodeOf(text: string): number | undefined {
  const m = /(?:^|\n)\s*(?:exit code|exit status|Exit code)[:\s]+(\d{1,3})\b/.exec(text);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : undefined;
}
