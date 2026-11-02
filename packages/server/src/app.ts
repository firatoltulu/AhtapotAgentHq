import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Dockerode from "dockerode";
import { and, isNotNull, isNull } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";

import { BRAND, BridgeHelloSchema, ClientMessageSchema } from "@ahtapot/shared";

import type { Config } from "./config/index.js";
import { openDb, schema, type Db, type DbHandle } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { EventHub, type Socket } from "./ws/hub.js";
import { IdentityPool } from "./agents/identity.js";
import { readReviewKey } from "./review/ocr.js";
import { AgentRunner } from "./agents/runner.js";
import { Analyst, activeProfile, reconcileInterruptedAnalyses } from "./analyst/analyst.js";
import { CodeMapper } from "./codemap/mapper.js";
import { reconcileInterruptedImageBuilds } from "./analyst/imageBuild.js";
import { reconcile } from "./engine/reconcile.js";
import { checkRemoteReachable, validateProfile } from "./analyst/validate.js";
import { registerApi } from "./api/index.js";
import { BridgeRegistry } from "./exec/bridge.js";
import { ContainerManager } from "./exec/docker.js";
import { AgentImages } from "./exec/agentBase.js";
import { JobEngine, type LiveController } from "./engine/job.js";
import { DockerRuntime, type DeveloperRuntime } from "./engine/runtime.js";
import { LiveEnvironments } from "./live/environment.js";
import { GoldenDb } from "./live/golden.js";
import { TemplateDb } from "./live/templateDb.js";
import { TemplateSuiteDatabases } from "./live/suiteDb.js";
import { DockerSuiteServices } from "./live/suiteServices.js";
import { PortPool } from "./resources/ports.js";
import { BuildGate } from "./build/gate.js";
import { TestGate } from "./build/tests.js";
import { HostExecutor } from "./build/executor.js";
import { GhCliClient, resolveToken, type GitHubClient } from "./git/github.js";
import { WorktreeManager } from "./workspace/worktree.js";
import { reconcileInterruptedClones } from "./workspace/clone.js";
import { watchSourceSync } from "./workspace/sourceSync.js";
import { AuthService } from "./auth/service.js";
import { Notifier } from "./notify/notifier.js";
import { PUBLIC_AUTH_PATHS, bearerFrom, registerAuthRoutes, sessionFrom } from "./api/auth.js";
import { registerBadgeRoutes } from "./api/badge.js";
import { GithubIssueTracker } from "./tracker/github.js";
import { TrackerSync } from "./tracker/sync.js";
import { ReleaseService, reconcileInterruptedReleases, watchReleases } from "./release/service.js";
import { resolveAppVersion } from "./version.js";

export interface App {
  fastify: FastifyInstance;
  db: Db;
  hub: EventHub;
  pool: IdentityPool;
  bridges: BridgeRegistry;
  containers: ContainerManager;
  engine: JobEngine;
  auth: AuthService;
  notifier: Notifier;
  close(): Promise<void>;
}

/**
 * Test ve araçlar için değiştirilebilir parçalar. Gerçek SDK sürücüsü yerine
 * sahte runner verilebilir; API testleri böylece anahtar ve ağ olmadan koşar.
 */
export interface AppOverrides {
  runner?: AgentRunner;
  /** Docker yerine host yürütücü: motor testleri konteynersiz koşar. */
  runtime?: DeveloperRuntime;
  /** Sahte canlı ortam; verilmezse gerçek compose. */
  live?: LiveController;
  /** Sahte GitHub; verilmezse `gh` CLI. */
  github?: GitHubClient;
  /** Sahte push/ntfy gönderimi; verilmezse gerçek ağ. */
  pushSend?: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;
  /**
   * Açılışta yetim konteyner taraması. Testlerde KAPALI olmalı: tarama
   * "DB'de yok = yetim" der, her test kendi DB'siyle koştuğu için paralel bir
   * testin konteynerini yetim sayıp siler (yaşandı: docker.test.js 404).
   * Aynı risk üretimde de var — tek Docker'ı paylaşan iki kurulum.
   */
  reconcileContainers?: boolean;
}

/**
 * Uygulamayı kurar.
 *
 * Migration açılışta koşar: şemanın koddan geri kalması, sessizce yanlış
 * davranan bir sisteme yol açar.
 */
export async function buildApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  runMigrations(config.dbPath);

  const handle: DbHandle = openDb(config.dbPath);
  const hub = new EventHub(handle.db);

  const fastify = Fastify({
    logger: { level: config.logLevel },
    // Ters proxy arkasında da doğru istemci adresi görülsün.
    trustProxy: true,
  });

  const pool = new IdentityPool(handle.db, config.keysFile, config.keyCooldownMinutes);
  const keyCount = pool.load();
  if (keyCount === 0) {
    fastify.log.warn("Claude kimliği tanımlı değil — agent turları koşamaz (AHTAPOT_KEYS)");
  }

  const runner = overrides.runner ?? new AgentRunner(handle.db, pool, hub);
  // Analyst'in ürettiği Dockerfile'lar buraya yazılır — hedef workspace'e
  // DEĞİL (bkz. Analyst constructor'ındaki yorum, `dockerfileAbsPath`).
  const artifactsDir = join(config.dataRoot, "artifacts");
  // Analyst'ten önce kurulur (taslak profil bildirimi); hub'a uzlaştırmadan
  // ÖNCE bağlanır — açılışta NeedsAttention'a alınan işler de insanı bekliyor.
  const notifier = new Notifier(handle.db, {
    vapidSubject: config.vapidSubject,
    ntfyUrl: config.ntfyUrl,
    ntfyToken: config.ntfyToken,
    publicUrl: config.publicUrl,
    log: (obj, msg) => fastify.log.warn(obj, msg),
    ...(overrides.pushSend ? { send: overrides.pushSend } : {}),
  });
  const analyst = new Analyst(handle.db, runner, artifactsDir, (projectId, profileId) =>
    notifier.profileDraft(projectId, profileId),
  );
  const bridges = new BridgeRegistry(handle.db);
  // Docker'a ilk kullanımda bağlanır; Docker olmayan makinede sunucu yine kalkar.
  const containers = new ContainerManager();
  // Canlı ortam katmanı Docker API'sini doğrudan kullanıyor (compose
  // konteynerlerini bulmak, volume yaratmak). `ContainerManager` agent
  // konteynerlerinin yaşam döngüsüne ait; ikisi ayrı sorumluluk.
  const dockerApi = new Dockerode();
  // Worktree artık named volume'de yaşıyor; `dataRoot` yalnız mirror ve
  // artifact için kullanılıyor, worktree yolu konteyner içi.
  const worktrees = new WorktreeManager(handle.db);
  // Worktree'nin aksine bu HOST'ta koşar: proje oluştururken workspaceRoot
  // yoksa `gitUrl`den klonlamak için — henüz worktree/konteyner devrede değil.
  const hostExec = new HostExecutor(true);
  // Köprü adresi dinleme anında bilinir (testlerde port 0); çağrı anında okunur.
  const bridgeUrl = () => {
    const addr = fastify.server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    return `ws://${config.bridgeHost}:${port}/bridge`;
  };
  const ports = new PortPool(handle.db, { from: config.portRangeFrom, to: config.portRangeTo });
  // Şablon DB tek yerde: canlı ortam klonunu da test takımlarının klonunu da
  // aynı şablondan alır (kararlar §37).
  const templates = new TemplateDb({ docker: dockerApi, log: (l) => fastify.log.info({ template: l }) });
  const suiteDatabases = new TemplateSuiteDatabases({ docker: dockerApi, templates });
  const live = overrides.live ?? new LiveEnvironments({
    db: handle.db, hub, ports, artifactsDir,
    // Şablon DB (postgres projeleri): ortam iki aşamada kalkar, migrate+seed
    // canlı ortamın içinde koşar. Bkz. docs/plan/04-template-db.md
    docker: dockerApi,
    templates,
    // Golden ESKİ YOL; postgres olmayan projeler için duruyor.
    golden: new GoldenDb({ log: (l) => fastify.log.info({ golden: l }) }),
    ...(config.traefikDynamicDir ? { traefikDynamicDir: config.traefikDynamicDir } : {}),
    traefikBackendHost: config.traefikBackendHost,
    ...(config.liveNetwork ? { probeNetwork: config.liveNetwork } : {}),
    ...(config.liveHost ? { publishHost: config.liveHost } : {}),
  });
  // Canlı uygulama (test edilen, GÜVENİLMEYEN kod) sunucunun ağına takılıyor
  // ve `ahtapot-server:7717`yi adıyla çözebiliyor. Token yoksa API ona açık.
  // Erişim yeni değil (7717 host'ta 0.0.0.0'a yayınlı, edge ağının egress'i
  // açık) ama ad çözümü onu kolaylaştırıyor; sessiz kalmamalı.
  if (config.liveNetwork && !config.adminToken) {
    fastify.log.warn(
      { liveNetwork: config.liveNetwork },
      "AHTAPOT_LIVE_NETWORK açık ama AHTAPOT_ADMIN_TOKEN yok — canlı ortam uygulaması sunucu API'sine kimliksiz ulaşabilir",
    );
  }
  // Agent tabanı sunucunun kendi dosyalarından build edilir; proje imajları
  // taban değişince iş başlamadan yeniden build edilir (bkz. agentBase.ts).
  const agentImages = new AgentImages({
    docker: dockerApi, db: handle.db, artifactsDir,
    log: (obj, msg) => fastify.log.info(obj, msg),
  });
  const github = overrides.github ?? new GhCliClient();
  // Kod haritası (karar §35): Analyst gibi host'ta, kaynak checkout üzerinde.
  const codeMap = new CodeMapper({
    runner, exec: hostExec, artifactsDir,
    log: (level, obj, msg) => fastify.log[level](obj, msg),
  });
  const engine = new JobEngine({
    db: handle.db,
    hub,
    runner,
    worktrees,
    runtime: overrides.runtime ?? new DockerRuntime({ containers, bridges, bridgeUrl, images: agentImages }),
    gate: new BuildGate(handle.db, hub),
    tests: new TestGate(handle.db, hub, suiteDatabases, new DockerSuiteServices(dockerApi)),
    artifactsDir,
    live,
    github,
    reviewKey: (ref) => readReviewKey(config.reviewKeysFile, ref),
    hostExec,
    codeMap,
  });
  // Runner motordan önce kuruluyor (Analyst de kullanıyor); politika sonradan.
  // Sahte runner'da (API testleri) yöntem olmayabilir.
  runner.setStuckPolicy?.((jobId, role) => engine.stuckPolicy(jobId, role));

  const auth = new AuthService(handle.db, { adminToken: config.adminToken, sessionTtlHours: config.sessionTtlHours });
  if (config.resetTotp && auth.resetTotp()) {
    fastify.log.warn("AHTAPOT_RESET_2FA: iki adımlı doğrulama kaldırıldı, tüm oturumlar kapatıldı — değişkeni geri alın");
  }
  if (auth.isOpen() && !["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    fastify.log.error(
      { host: config.host },
      "sunucu dışarı açık ama hiçbir doğrulama yok — AHTAPOT_ADMIN_TOKEN tanımlayın ya da UI'dan iki adımlı doğrulamayı bağlayın",
    );
  }

  notifier.attach(hub);
  // Issue'dan açılan işler kayıtla senkron: atama, aşama etiketi, notlar.
  // Yeni takipçi (Jira, ClickUp) = listeye yeni adaptör.
  const trackerSync = new TrackerSync(handle.db, [new GithubIssueTracker(handle.db, github)], {
    publicUrl: config.publicUrl,
    log: (obj, msg) => fastify.log.warn(obj, msg),
  });
  trackerSync.attach(hub);
  // Canlı test kararı issue etiketiyle de gelebilir; UI'daki kapı kararıyla aynı yol.
  const stopVerdicts = trackerSync.watchVerdicts((gateId, decision, comment, actor) => {
    const r = engine.decide(gateId, decision, comment, undefined, actor);
    r.developing?.catch((err: unknown) => fastify.log.error(err, "etiket kararı sonrası akış düştü"));
    r.planning?.catch((err: unknown) => fastify.log.error(err, "etiket kararı sonrası akış düştü"));
  });

  // Hedef repodaki release workflow'u: elle tetik (REST) ve zamanlı yuvalar.
  // `starting`te kalan satır dispatch'in yapılıp yapılmadığını bilmiyor —
  // `unknown`a çekilir, yeniden denenmez (ikinci yayın riski).
  const interruptedReleases = reconcileInterruptedReleases(handle.db);
  if (interruptedReleases > 0) fastify.log.warn({ interruptedReleases }, "yarıda kalmış yayınlar unknown'a alındı");
  const releases = new ReleaseService({
    db: handle.db, github, hostExec,
    log: (obj, msg) => fastify.log.warn(obj, msg),
  });
  const stopReleases = watchReleases(releases, handle.db);

  // Kaynak workspace'ler saatte bir uzaktaki uca: taban iş açılışını beklemeden
  // güncel kalsın. Yalnız onaylı profili olan, arşivlenmemiş projeler (kural 8).
  const stopSourceSync = watchSourceSync(
    hostExec,
    () => handle.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(isNotNull(schema.projects.activeProfileId), isNull(schema.projects.archivedAt)))
      .all()
      .flatMap((p) => activeProfile(handle.db, p.id) ?? []),
    (level, obj, msg) => fastify.log[level](obj, msg),
  );

  // Önceki süreçte yarıda kalan analizler sonsuza dek "sürüyor" görünmesin.
  const interrupted = reconcileInterruptedAnalyses(handle.db);
  if (interrupted > 0) fastify.log.warn({ interrupted }, "yarıda kalmış analizler kapatıldı");

  // İmaj build'leri de aynı sınıf: satır "running"da kalırsa profil sonsuza
  // dek "imaj build ediliyor" görünür ve kimse yeniden denemeyi düşünmez.
  const interruptedImageBuilds = reconcileInterruptedImageBuilds(handle.db);
  if (interruptedImageBuilds > 0) {
    fastify.log.warn({ interruptedImageBuilds }, "yarıda kalmış imaj build'leri kapatıldı");
  }

  // Aynı sınıf hata, klonlar için: süreç ölürse `workspaceStatus` "pending"de kalır.
  const interruptedClones = reconcileInterruptedClones(handle.db);
  if (interruptedClones > 0) fastify.log.warn({ interruptedClones }, "yarıda kalmış klonlar kapatıldı");

  // Yarıda kalan İŞLER de aynı şekilde. YAŞANDI: sunucu yeniden başlatılınca
  // koşan Planner süreci öldü ama iş `Planning|running` kaldı — kimse
  // tamamlamayacağı hâlde "çalışıyor" göründü ve kurtarılamadı. `reconcile`
  // yazılmış ve test edilmişti, yalnızca çağrılmıyordu.
  const scanContainers = overrides.reconcileContainers !== false && (await containers.available());
  const report = await reconcile(handle.db, hub, scanContainers ? containers : null);
  if (report.interruptedJobs.length > 0 || report.releasedLeases > 0 || report.removedContainers.length > 0) {
    fastify.log.warn(
      { jobs: report.interruptedJobs.length, leases: report.releasedLeases, containers: report.removedContainers.length },
      "yarıda kalmış işler NeedsAttention'a alındı",
    );
  }
  if (report.containerError) fastify.log.warn({ err: report.containerError }, "yetim konteyner taraması düştü");

  // Taban build'i açılışta ARKA PLANDA başlar: ilk iş beklemesin, ama açılış
  // da build'i (dakikalar) beklemesin. Düşerse ilk iş yeniden dener ve hata
  // o işin mesajında görünür. Testlerde (konteyner taraması kapalı) koşmaz.
  if (scanContainers) {
    agentImages.ensureBase().catch((err: unknown) =>
      fastify.log.warn({ err: err instanceof Error ? err.message : String(err) }, "agent tabanı hazırlanamadı"),
    );
  }

  await fastify.register(websocket);
  // Ek görseller (ekran görüntüsü, tasarım): mockup 5 MB sınır çiziyor;
  // `fileSize` burada, tekil dosya kontrolü upload ucunda tekrar yapılır
  // (kural 3 — üretici taraf güvenilmez, sınır iki yerde de zorlanır).
  await fastify.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  registerAuthRoutes(fastify, { auth, notifier, sessionTtlHours: config.sessionTtlHours });
  registerBadgeRoutes(fastify, handle.db);
  // Açılışta bir kez: `git describe` süreç ömrü boyunca değişmez.
  const appVersion = resolveAppVersion();
  registerApi(fastify, {
    appVersion,
    db: handle.db, hub, analyst, pool, engine, artifactsDir, hostExec, github, releases, codeMap,
    // Canlı ortamla AYNI istemci: ikinci bir Dockerode açmak aynı daemon'a
    // ikinci bir bağlantı havuzu demek, kazancı yok.
    docker: dockerApi,
    agentImages,
    ...(config.workspacesRoot ? { workspacesRoot: config.workspacesRoot } : {}),
    validate: async (profile) =>
      validateProfile(profile, {
        imageExists: (await containers.available()) ? (image) => containers.imageExists(image) : null,
        imageHasCommand: (await containers.available())
          ? (image, command) => containers.imageHasCommand(image, command)
          : null,
        portRange: { from: config.portRangeFrom, to: config.portRangeTo },
        remoteReachable: async (remote) => checkRemoteReachable(remote, await resolveToken()),
      }),
  });

  /**
   * Web UI: derlenmiş `packages/web/dist` aynı origin'den servis edilir.
   * Yoksa (yalnız API kurulumu) sessizce atlanır. SPA: bilinmeyen yollar
   * index.html'e düşer, API/WS yolları hariç.
   */
  const webDist = config.webDist ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  if (existsSync(join(webDist, "index.html"))) {
    // `wildcard: false` alt dizinleri servis ETMEZ: /assets/... 404'e düşer ve
    // tarayıcı boş sayfa görür (ölçüldü). Joker açık; bilinmeyen yolu SPA'ya
    // düşürmeyi 404 işleyicisi yapıyor.
    await fastify.register(fastifyStatic, { root: webDist, prefix: "/" });
    fastify.setNotFoundHandler((req, reply) => {
      // Eksik bir bundle dosyası HTML olarak dönmemeli — tarayıcı sessizce bozuk kalır.
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws") || req.url.startsWith("/bridge") || req.url.startsWith("/assets/")) {
        return reply.code(404).send({ error: "bulunamadı" });
      }
      return reply.sendFile("index.html");
    });
    fastify.log.info({ webDist }, "web UI servis ediliyor");
  }

  /**
   * Kimlik doğrulama kapısı — yalnız API ve canlı akış.
   *
   * Statik dosyalar (UI kabuğu, service worker, manifest) KORUNMAZ: giriş
   * ekranının kendisi oradan yükleniyor. ESKİ kanca her isteği koruyordu ve
   * token tanımlıyken tarayıcı `/` isteğinde 401 JSON alıp boş kalıyordu.
   * Bundle'da sır yok; veri yalnız `/api` ve `/ws`ten gelir.
   *
   * Köprü (`/bridge`) iş başına kendi token'ıyla doğrulanır (hello).
   */
  fastify.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const guarded = path.startsWith("/api/") || path === "/ws";
    if (!guarded || PUBLIC_AUTH_PATHS.has(path)) return;

    const r = auth.authenticate(sessionFrom(req), bearerFrom(req));
    if (!r.ok) {
      await reply.code(401).send({ error: r.reason });
      return;
    }

    // WS ele geçirme savunması: çerez başka bir siteden açılan sokete de
    // gidebilir (SameSite'ı uygulamayan tarayıcılar). Origin varsa bu
    // sunucunun adresiyle aynı olmalı.
    if (path === "/ws" && r.via === "session") {
      const origin = req.headers.origin;
      const host = req.headers["x-forwarded-host"] ?? req.headers.host;
      if (origin && host && new URL(origin).host !== String(host).split(",")[0]?.trim()) {
        await reply.code(403).send({ error: "farklı origin" });
      }
    }
  });

  /**
   * PWA manifest'i sunucudan üretilir, statik dosya değil: ad `brand.ts`te
   * tek kaynak. iOS push yalnız ana ekrana eklenmiş uygulamada çalışıyor ve
   * ana ekrana ekleme `display: standalone` manifest'i istiyor.
   */
  fastify.get("/manifest.webmanifest", async (_req, reply) => {
    reply.type("application/manifest+json");
    return {
      name: BRAND.displayName,
      short_name: BRAND.displayName,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f2f5f3",
      theme_color: "#0b7c63",
      icons: [
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
      ],
    };
  });

  fastify.get("/health", async () => ({
    ok: true,
    brand: BRAND.displayName,
    version: appVersion,
    at: new Date().toISOString(),
  }));

  /**
   * Canlı akış kanalı.
   *
   * Token QUERY STRING'DE TAŞINMAZ — erişim log'larına düşer. Tarayıcı
   * WebSocket API'si özel başlık göndermeye izin vermediği için kimlik, aynı
   * origin'den gelen oturum çerezinden ya da ilk mesajdaki el sıkışmadan alınır.
   */
  fastify.get("/ws", { websocket: true }, (connection, req) => {
    const socket = connection as unknown as Socket;
    const subs = new Set<ReturnType<EventHub["subscribe"]>>();

    connection.on("message", (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "geçersiz JSON" }));
        return;
      }

      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        socket.send(JSON.stringify({ type: "error", message: "geçersiz mesaj" }));
        return;
      }

      const msg = result.data;
      switch (msg.type) {
        case "subscribe": {
          const sub = hub.subscribe(msg.jobId, socket);
          subs.add(sub);
          // Kaçırılan olaylar önce gönderilir; istemci akışı kayıpsız kurar.
          if (msg.sinceSeq !== undefined) {
            for (const e of hub.replay(msg.jobId, msg.sinceSeq)) {
              socket.send(JSON.stringify(e));
            }
          }
          break;
        }
        case "unsubscribe": {
          for (const sub of subs) {
            if (sub.jobId === msg.jobId) {
              hub.unsubscribe(sub);
              subs.delete(sub);
            }
          }
          break;
        }
        case "chat.send": {
          // Reddedilen mesaj sessizce yutulmaz: istemci nedenini görür.
          try {
            const r = engine.chat(msg.jobId, msg.text, msg.interrupt);
            r.turn?.catch((err: unknown) => req.log.error(err, "sohbet turu düştü"));
            if (!r.accepted) socket.send(JSON.stringify({ type: "error", message: r.reason }));
          } catch (err) {
            socket.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
          }
          break;
        }
        case "approval.decide": {
          try {
            const r = engine.decide(msg.gateId, msg.decision, msg.comment, msg.edits, "human", msg.attachmentIds ?? []);
            r.planning?.catch((err: unknown) => req.log.error(err, "yeniden planlama düştü"));
          } catch (err) {
            socket.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
          }
          break;
        }
        case "job.interrupt": {
          if (!engine.interrupt(msg.jobId)) {
            socket.send(JSON.stringify({ type: "error", message: "kesilecek koşu yok" }));
          }
          break;
        }
        case "live.extend": {
          if (!engine.extendLive(msg.jobId, msg.minutes)) {
            socket.send(JSON.stringify({ type: "error", message: "uzatılacak canlı ortam yok" }));
          }
          break;
        }
        case "question.answer": {
          if (!engine.answer(msg.questionId, msg.answer)) {
            socket.send(JSON.stringify({ type: "error", message: "bekleyen soru yok (süresi dolmuş olabilir)" }));
          }
          break;
        }
      }
    });

    connection.on("close", () => {
      for (const sub of subs) hub.unsubscribe(sub);
      subs.clear();
    });
  });

  /**
   * Konteyner köprüsü kanalı.
   *
   * Konteyner DIŞARI DOĞRU bağlanır; ilk mesaj `bridge.hello` olmalı ve iş
   * başına üretilen token'ı taşımalı. Süre içinde hello gelmezse ya da token
   * uymazsa soket kapanır — kimliği belirsiz bir köprüye koşu verilmez.
   */
  fastify.get("/bridge", { websocket: true }, (connection, req) => {
    const socket = connection as unknown as Socket;
    let session: ReturnType<BridgeRegistry["attach"]> = null;
    const helloTimer = setTimeout(() => {
      if (!session) connection.close();
    }, 5_000);

    connection.on("message", (raw: Buffer) => {
      if (session) {
        session.handle(raw.toString("utf8"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        connection.close();
        return;
      }
      const hello = BridgeHelloSchema.safeParse(parsed);
      if (!hello.success) {
        connection.close();
        return;
      }
      session = bridges.attach(socket, hello.data);
      clearTimeout(helloTimer);
      if (!session) {
        req.log.warn({ jobId: hello.data.jobId }, "köprü token'ı uyuşmadı");
        connection.close();
        return;
      }
      req.log.info({ jobId: hello.data.jobId, bridgeVersion: hello.data.bridgeVersion }, "köprü bağlandı");

      // DEVRALMA: köprü konteynerde canlı bir koşu bildirdiyse, `reconcile`ın
      // az önce `NeedsAttention`a aldığı iş geri alınır. Sunucu yeniden
      // başlarken konteynerdeki agent ARTIK ÖLMÜYOR (köprü kopmada kesmiyor),
      // bu yüzden "yarıda kaldı" varsayımı burada ölçümle düzeltilebiliyor.
      if (hello.data.activeRunId) {
        const took = engine.takeOver(hello.data.jobId, hello.data.activeRunId);
        req.log.warn(
          {
            jobId: hello.data.jobId,
            runId: hello.data.activeRunId,
            dropped: hello.data.droppedEvents,
            took,
          },
          took ? "konteynerde koşan tur devralındı" : "koşu bildirildi ama devralınamadı",
        );
      }
    });

    connection.on("close", () => {
      clearTimeout(helloTimer);
      if (session) {
        bridges.detach(session);
        // DEVRALINAN KOŞUNUN İŞARETİ BURADA KALKAR.
        //
        // `takeOver` işi `busy` işaretliyor ama o turu BU SÜREÇ yönetmiyor —
        // koşu konteynerde, köprünün ucunda sürüyor. Bu yüzden işareti
        // kaldıracak bir `finally` de yok: iş, sunucu yeniden başlatılana
        // kadar kalıcı olarak "koşuyor" sayılıyordu ve `busy`ye bakan her
        // işlem (retarget, chat, yeniden dene, kapı kararı) 409 ile
        // reddediliyordu. YAŞANDI: "profil eski" düğmesi basılıyor, sunucu
        // "iş koşuyor; profil değiştirilemez" diyor, oysa koşu çoktan bitmiş.
        //
        // Köprünün kopması "o koşuyu artık izlemiyoruz" demektir; bitmiş de
        // olabilir, konteyner de ölmüş olabilir. İkisinde de işareti tutmanın
        // bir faydası yok: gerçekten koşan bir tur varsa köprü yeniden
        // bağlanıp `takeOver` ile onu tekrar bildirir.
        engine.releaseAdopted(session.jobId);
      }
    });
  });

  return {
    fastify,
    db: handle.db,
    hub,
    pool,
    bridges,
    containers,
    engine,
    auth,
    notifier,
    async close() {
      stopVerdicts();
      stopReleases();
      stopSourceSync();
      await fastify.close();
      handle.sqlite.close();
    },
  };
}
