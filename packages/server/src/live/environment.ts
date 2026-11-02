import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type Dockerode from "dockerode";
import { and, eq } from "drizzle-orm";

import {
  DB_CLONE_PLACEHOLDER, ProjectProfileSchema, composeProject, containerName, dbCloneEnvKeys, resolveEnvPlaceholders,
  resolveJobPlaceholders, resolvePlaceholders, resolveServices, scrubSecrets, unresolvedPlaceholders,
  type DastSummary, type Live, type ProjectProfile,
} from "@ahtapot/shared";

import { newId, isoNow, type Db, schema } from "../db/index.js";
import { acquireLease, releaseLease } from "../resources/leases.js";
import type { PortPool } from "../resources/ports.js";
import type { EventHub } from "../ws/hub.js";
import { shellQuote, type CommandExecutor } from "../build/executor.js";
import { assertNoForbiddenFlags } from "../build/gate.js";
import { jobVolumeName } from "../exec/docker.js";
import { FAIL_SENTINEL, parseFailedStep, renderBuildChain } from "./buildChain.js";
import { runDast, type DastTargets } from "./dast.js";
import { liveWorkingDir, renderComposeOverride } from "./compose.js";
import { dbDependency, demux } from "./golden.js";
import { dbNamesFor, pgConnString, pgCredsFrom, startPsqlHelper, type PgCreds } from "./templateDb.js";
import { waitForReady } from "./readiness.js";
import { livePublicHost, renderTraefikRoute } from "./traefik.js";

const execFileAsync = promisify(execFile);

/** Proje başına kalıcı Postgres verisi; şablon burada yaşar. */
export function pgDataVolume(slug: string): string {
  return `ahtapot-pgdata-${slug}`;
}

/** Windows yolu compose'a ileri eğik çizgiyle gider (`exec/docker.ts` ile aynı kural). */
function toComposePath(hostPath: string): string {
  return hostPath.replace(/\\/g, "/");
}

/**
 * Canlı ortam orkestratörü.
 *
 * Build yeşil → port kiralanır → override üretilir → `docker compose up -d`
 * → hazırlık ölçütü → `live.ready` → UI "Uygulamayı aç". TTL dolunca yıkılır;
 * kullanıcı uzatabilir. Docker'ı yalnız bu modül ve `exec/` bilir.
 *
 * Compose CLI'ı (v2) kullanılır, Engine API değil: compose dosyasının
 * anlamını (depends_on koşulları, healthcheck, ağ) yeniden yazmak
 * yerine Docker'ın kendi yorumcusu koşar. Bedeli bir alt süreç.
 */

export interface LiveDeps {
  db: Db;
  hub: EventHub | null;
  ports: PortPool;
  /** Override dosyaları ve loglar: `<artifactsDir>/<jobId>/live/`. */
  artifactsDir: string;
  /** Compose komutunu koşturan; test sahtesi verebilir. */
  compose?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  fetchImpl?: typeof fetch;
  /**
   * Golden DB (ESKİ YOL — volume klonu). Şablon DB modeline geçildi; bu alan
   * yalnız `database.kind` postgres OLMAYAN projeler ve mevcut testler için
   * duruyor.
   */
  golden?: GoldenLike | null;
  /**
   * Şablon DB. Verilirse ve profil postgres kullanıyorsa ortam iki aşamada
   * kalkar: bağımlılıklar → şablon + klon → uygulama. Null ise eski yol.
   */
  templates?: TemplateLike | null;
  /** Compose konteynerlerini bulmak için; şablon yolu bunu ister. */
  docker?: Dockerode | null;
  /**
   * Natlanmış Traefik'in file-provider izlediği HOST dizini
   * (`AHTAPOT_TRAEFIK_DYNAMIC_DIR`). Boşsa Traefik dosyası hiç üretilmez —
   * profildeki `live.traefik.enabled` de açık olsa fark etmez.
   */
  traefikDynamicDir?: string | null;
  /**
   * Traefik'in AhtapotAgent sunucusuna ulaşacağı adres
   * (`AHTAPOT_TRAEFIK_BACKEND_HOST`). Traefik ayrı konteyner/host'ta
   * koşuyorsa `127.0.0.1` ERİŞİLEMEZ olur; varsayılan yerel geliştirme için.
   */
  traefikBackendHost?: string;
  /**
   * Sunucunun bağlı olduğu Docker ağı (`AHTAPOT_LIVE_NETWORK`). Sunucu
   * konteynerde koşuyorsa ZORUNLU: yayınlanan portlar host loopback'ine bağlı
   * ve konteynerin içinden sağlık yoklaması hiç ulaşamıyordu (yaşandı
   * 2026-09-22). Boşsa sunucu host'ta sayılır ve `127.0.0.1` yoklanır.
   */
  probeNetwork?: string;
  /** Portların yayınlandığı host adresi (`AHTAPOT_LIVE_HOST`); bkz. `ComposeInput.publishHost`. */
  publishHost?: string;
}

/** Şablon DB'nin canlı ortama bakan yüzü — `TemplateDb` bunu sağlar. */
export interface TemplateLike {
  ready(containerId: string, creds: PgCreds): Promise<{ ok: true } | { ok: false; reason: string }>;
  templateExists(containerId: string, name: string, creds: PgCreds): Promise<boolean>;
  dropTemplate(containerId: string, name: string, creds: PgCreds): Promise<void>;
  createEmptyTemplate(containerId: string, name: string, creds: PgCreds): Promise<string>;
  cloneFromTemplate(containerId: string, template: string, target: string, creds: PgCreds): Promise<string>;
  dropJobDb(containerId: string, target: string, creds: PgCreds): Promise<boolean>;
}

/** Golden DB'nin canlı ortama bakan yüzü — `GoldenDb` bunu sağlar. */
export interface GoldenLike {
  ensure(profile: ProjectProfile, worktreePath: string, opts?: { force?: boolean }): Promise<{ volume: string; stale: boolean; rebuilt: boolean }>;
  clone(slug: string, jobId: string): Promise<string>;
  removeJobVolume(jobId: string): Promise<boolean>;
}

export interface StartInput {
  jobId: string;
  profile: ProjectProfile;
  /**
   * Worktree yolu — artık KONTEYNER içi (named volume).
   *
   * Compose CLI host'ta koşuyor ve base dosyasını host'ta görmek zorunda;
   * `executor` verilirse dosya volume'den çıkarılıp artifact dizinine yazılır.
   */
  worktreePath: string;
  /** Worktree'yi gören yürütücü; compose base dosyasını çıkarmak için. */
  executor?: CommandExecutor;
  extraEnv?: Record<string, string>;
  /**
   * İnsanın bu işe verdiği değişkenler (`jobs.live_env`). EN SON uygulanır:
   * profili ve orkestratörün ürettiklerini (DB bağlantısı dahil) ezer —
   * insan açıkça yazdı, bilerek yazdı.
   */
  jobEnv?: Record<string, string>;
  volumes?: Record<string, { volume: string; mountPath: string }>;
  /** Testler kısaltır. */
  readinessOverride?: { intervalMs?: number; timeoutMs?: number };
}

export interface StartedLive {
  id: string;
  appUrl: string;
  /** Traefik üzerinden domain adresi — yalnız `live.traefik.enabled` ve dizin verilmişse. */
  publicUrl?: string;
  ports: number[];
  expiresAt: string;
  ready: boolean;
  reason: string;
  /**
   * Ortam BUILD'de düştü — uygulama hatası değil.
   *
   * Build canlı konteynerin `command`'ında koşuyor (bkz. `buildChain.ts`);
   * kırmızı build ile "uygulama kalkmadı" aynı `ready:false` altında
   * toplanırsa iş `NeedsAttention`a düşer, oysa kırmızı build Developer'ın
   * düzeltebileceği bir şeydir ve ona dönmelidir.
   */
  buildFailed?: boolean;
  /** Düşen build adımının adı — geri bildirimde Developer'a gider. */
  failedStep?: string;
  /** Konteyner logunun kuyruğu; kırmızı build geri bildirimi bunu taşır. */
  logTail?: string;
}

/** `docker` ikilisi PATH'te yok — compose'un kendisi değil, CLI eksik. */
class DockerCliMissingError extends Error {}

async function defaultCompose(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["compose", ...args], { cwd, encoding: "utf8", maxBuffer: 64_000_000 });
    return { stdout, stderr };
  } catch (err) {
    // Ham "spawn docker ENOENT" UI'da hiçbir şey söylemiyordu (yaşandı
    // 2026-09-22): dockerode soketten konuştuğu için agent konteyneri ve psql
    // yardımcısı sorunsuz kalkıyor, yalnız BU yol CLI istiyor — server imajında
    // `docker` yokken log "compose up düştü" demekle kalıyordu. `spawn gh
    // ENOENT` ile aynı sınıf kusur (4a99045).
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Node var olmayan `cwd` için de AYNI metni basar ("spawn docker
      // ENOENT"); ikisi ayrılmazsa mesaj yanlış tanı koyar (bkz. c836e87).
      if (!existsSync(cwd)) throw new Error(`compose çalışma dizini yok: ${cwd}`);
      throw new DockerCliMissingError(
        "`docker` komutu sunucunun PATH'inde yok — canlı ortam `docker compose` CLI'sını çağırır (dockerode yetmez). "
        + "Sunucu konteynerde koşuyorsa imajda `docker-ce-cli` + `docker-compose-plugin` kurulu olmalı (docker/server/Dockerfile); "
        + "host'ta koşuyorsa Docker CLI'ı kurup PATH'e ekleyin.",
      );
    }
    throw err;
  }
}

/**
 * Bu sürecin Docker konteyner kimliği, `hostname`den bağımsız.
 *
 * Docker `/etc/hostname` ve `/etc/resolv.conf`u
 * `/var/lib/docker/containers/<kimlik>/` altından bağlar; yol cgroup v1/v2
 * farkından etkilenmez. cgroup v1'de `/proc/self/cgroup` da kimliği taşır.
 */
function ownContainerId(): string | null {
  for (const [file, re] of [
    ["/proc/self/mountinfo", /\/containers\/([0-9a-f]{64})\//],
    ["/proc/self/cgroup", /docker[-/]([0-9a-f]{64})/],
  ] as const) {
    try {
      const m = re.exec(readFileSync(file, "utf8"));
      if (m?.[1]) return m[1];
    } catch {
      // Linux dışı ya da erişim yok: bir sonrakini dene.
    }
  }
  return null;
}

export class LiveEnvironments {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly compose: NonNullable<LiveDeps["compose"]>;
  /** İş → klonlanmış DB adı; `stop()` onu düşürmek için okur. */
  private readonly jobDbNames = new Map<string, string>();

  constructor(private readonly deps: LiveDeps) {
    this.compose = deps.compose ?? defaultCompose;
  }

  /** Her satır maskelenir: canlı ortam log'u UI'da görünüyor ve DB'ye yazılıyor. */
  private log(jobId: string, line: string, stream: "stdout" | "stderr" = "stdout"): void {
    this.deps.hub?.publish(jobId, { type: "build.log", stream, line: scrubSecrets(line) });
  }

  private composeArgs(jobId: string, live: Live, overridePath: string, basePath?: string): string[] {
    const base = basePath ?? live.compose?.base;
    const files = base ? ["-f", base, "-f", overridePath] : ["-f", overridePath];
    return ["-p", `ahtapot-${jobId}`, ...files];
  }

  /**
   * Compose base dosyasını worktree'den (volume) host'a çıkarır.
   *
   * Compose CLI host'ta koşuyor: `-f` ile verilen yolu ve `cwd`yi host'ta
   * görmek zorunda. Worktree named volume'e taşındıktan sonra o dosya host'ta
   * YOK — yürütücüden okunup artifact dizinine yazılır ve compose oradan
   * çalıştırılır.
   *
   * Yürütücü verilmezse (testler, eski çağrılar) yol olduğu gibi kullanılır.
   */
  private async materializeComposeBase(
    jobId: string,
    live: Live,
    dir: string,
    input: StartInput,
  ): Promise<string | undefined> {
    if (!live.compose?.base) return undefined;
    if (!input.executor) return live.compose.base;
    const lines: string[] = [];
    const res = await input.executor.run({
      command: `cat ${shellQuote(live.compose.base)}`,
      cwd: input.worktreePath,
      env: {},
      timeoutMs: 60_000,
      onLine: (_s, l) => {
        lines.push(l);
      },
    });
    if (res.exitCode !== 0) {
      throw new Error(`compose base dosyası worktree'de okunamadı: ${live.compose.base}`);
    }
    const out = join(dir, "compose.base.yml");
    writeFileSync(out, lines.join("\n"));
    this.log(jobId, `▶ compose base worktree'den çıkarıldı: ${live.compose.base}`);
    return out;
  }

  /**
   * Şablon DB'yi hazırlar ve işin kendi veritabanını klonlar.
   *
   * Çağrıldığında bağımlılıklar AYAKTA, uygulama HENÜZ DEĞİL. Sıra:
   *
   *  1. Postgres cevap verene kadar bekle (compose healthcheck'i yetmiyor:
   *     `pg_isready` başlatma betikleri koşarken de 0 dönüyor — `golden.ts`
   *     bunu iki başarı şartıyla çözmüştü, aynı ders burada da geçerli).
   *  2. Şablon yoksa: boş yarat, migrate + install koştur. Varsa olduğu
   *     gibi kullanılır — yaşına bakılmaz, silinmez.
   *     Bu adım uygulamanın kendisini çalıştırır ve Redis + Elasticsearch'e
   *     ihtiyaç duyar — ikisi de aynı compose ağında ayakta.
   *  3. `CREATE DATABASE ... TEMPLATE` ile işin DB'sini klonla.
   *
   * 2. adım KİLİTLİ: iki iş aynı anda şablonu kurmaya kalkarsa ikisi de yarım
   * bırakır. `resource_leases` tek tahsis otoritesi (kural: hiçbir modül kendi
   * başına kaynak seçmez).
   */
  private async prepareDatabase(
    jobId: string,
    profile: ProjectProfile,
    rendered: { project: string; appService: string },
    args: string[],
    worktreePath: string,
    log: (line: string) => void,
  ): Promise<void> {
    const templates = this.deps.templates;
    const creds = pgCredsFrom(profile);
    const dep = dbDependency(profile);
    if (!templates || !creds || !dep) throw new Error("şablon DB için postgres bağımlılığı ve kimlik gerekli");

    // `psql` NEREDE koşacak?
    //
    // Postgres dışarıdaysa ona ait bir konteyner YOK ve uygulama konteyneri de
    // bu aşamada henüz kalkmamıştır (aşama 1: yalnız bağımlılıklar). Bu yüzden
    // kısa ömürlü bir konteyner açılıyor — proje imajında `psql` kurulu ve
    // `host-gateway` ile host'a çıkabiliyor.
    const cid = dep.externalHost
      ? await this.throwawayPsqlContainer(profile)
      : await this.dbContainerId(rendered.project, dep.name);
    if (!cid) throw new Error(`postgres konteyneri bulunamadı (${dep.name})`);
    const disposable = Boolean(dep.externalHost);
    try {

    // 1) Gerçekten hazır mı?
    //
    // Bekleme süresi servisin NEREDE olduğuna göre ayrılır: compose'un yeni
    // kaldırdığı bir konteyner ilk saniyelerde cevap vermez ve 120 s hak eder,
    // ama DIŞARIDA zaten koşan bir servis ya vardır ya yoktur. Erişilemeyen bir
    // adresi iki dakika beklemek teşhisi geciktirmekten başka işe yaramıyordu.
    const waitMs = dep.externalHost ? 20_000 : 120_000;
    const deadline = Date.now() + waitMs;
    let last = "";
    for (;;) {
      const r = await templates.ready(cid, creds);
      if (r.ok) break;
      last = r.reason;
      if (Date.now() > deadline) {
        const where = dep.externalHost
          ? `${dep.externalHost}:${dep.externalPort ?? dep.internalPort}`
          : `compose servisi ${dep.name}`;
        throw new Error(`postgres ${waitMs / 1000} s içinde cevap vermedi (${where}): ${last}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 2) Şablon.
    const slug = profile.slug;
    // Adlar profilden gelir (`database.clone.template` / `.namePattern`); alanlar
    // boşsa slug'dan türer.
    const names = dbNamesFor(profile, jobId);
    // Var olan şablona DOKUNULMAZ — yaşı ne olursa olsun. Eskiden
    // `goldenMaxAgeDays`ı aşan şablon silinip yeniden kuruluyordu; şablon
    // yalnız klonların KAYNAĞI, orkestratörün onu silmesi için sebep yok.
    // YAŞANDI (2026-10-17): elle kurulup `IS_TEMPLATE true` işaretlenmiş
    // şablonu silmeye kalktı, Postgres reddetti ve canlı ortam kalkmadı
    // ("cannot drop a template database"). Tazeleme insanın işi: şablonu
    // elle düşürür, sonraki iş yeniden kurar.
    const exists = await templates.templateExists(cid, names.template, creds);

    if (!exists) {
      const lease = `golden-template:${slug}`;
      // Kilit: ikinci iş beklemez, HATA ALIR ve yeniden denenir. Beklemek
      // `start()`i 20+ dakika asılı bırakırdı; insan "takıldı" sanırdı.
      if (!acquireLease(this.deps.db, { jobId, kind: "db", value: lease })) {
        throw new Error("şablon DB başka bir işte kuruluyor; birazdan yeniden deneyin");
      }
      try {
        await templates.createEmptyTemplate(cid, names.template, creds);
        const conn = pgConnString(dep, names.template, creds);
        // Kurulum ŞABLONA yazmalı, işin klonuna değil: uygulama env'inde klon
        // dizesini taşıyan her değişken bu adım için şablonun dizesiyle ezilir.
        const templateEnv = dbCloneEnvKeys(profile.appEnv).flatMap((k) => [
          "-e", `${k}=${resolvePlaceholders(profile.appEnv[k]!, { jobId, dbCloneConnectionString: conn })}`,
        ]);
        if (templateEnv.length === 0) {
          throw new Error(`şablon kurulamıyor: appEnv'de $${DB_CLONE_PLACEHOLDER} taşıyan değişken yok`);
        }
        // Migration ve seed AYRI adımlar; ikisi de zorunlu (seed atlanamaz —
        // tohumsuz DB'de uçlar 403 döner, Northwind dersi).
        for (const [label, cmd] of [["migration", profile.database.migrate], ["tohum", profile.database.seed]] as const) {
          if (!cmd) continue;
          log(`▶ şablon/${label}: ${scrubSecrets(cmd.run)}`);
          // `--no-deps`: bağımlılıklar ZATEN ayakta (aşama 1'de kaldırıldı);
          // compose onları yeniden başlatmaya kalkmasın. Elasticsearch ve
          // Redis'e erişim ağ üzerinden sürüyor — bu adım uygulamanın
          // tamamını çalıştırdığı için ikisi de gerekli (çıkış 134 dersi).
          //
          // `--entrypoint sh` + `-lc`: taban imajın ENTRYPOINT'i köprüyü
          // başlatıyor, ezilmezse komut ona argüman olur.
          const r = await this.compose(
            [...args, "run", "--rm", "--no-deps", ...templateEnv,
             "--entrypoint", "sh", rendered.appService, "-lc", cmd.run],
            worktreePath,
          );
          for (const l of `${r.stdout}\n${r.stderr}`.split("\n").slice(-40)) if (l.trim()) log(`  ${l}`);
        }
        log(`■ şablon hazır: ${names.template}`);
      } catch (err) {
        // Yarım şablon bırakma: sonraki iş onu "hazır" sanır.
        await templates.dropTemplate(cid, names.template, creds).catch(() => {});
        throw err;
      } finally {
        releaseLease(this.deps.db, "db", lease);
      }
    }

    // 3) İşin kendi DB'si.
    const jobDb = await templates.cloneFromTemplate(cid, names.template, names.job, creds);
    this.jobDbNames.set(jobId, jobDb);
    log(`■ iş DB'si şablondan klonlandı: ${jobDb}`);
    } finally {
      // Kısa ömürlü konteyner: işi bitti.
      if (disposable) {
        await this.deps.docker!.getContainer(cid).remove({ force: true }).catch(() => {});
      }
    }
  }

  /**
   * İşin profilini KALICI KAYITTAN okur — çalışma belleğinden değil.
   *
   * `stop()` temizliği bunu istiyor: `startInputs` yalnız bu süreç yaşadığı
   * sürece dolu ve readiness düştüğünde hiç dolmuyor, ama dış Postgres'teki
   * klon o durumlarda da silinmeli. Profil bozuksa `null` döner ve temizlik
   * atlanır — yıkımı düşürmez.
   */
  private profileOf(jobId: string): ProjectProfile | null {
    const row = this.deps.db
      .select({ document: schema.projectProfiles.document })
      .from(schema.jobs)
      .innerJoin(schema.projectProfiles, eq(schema.jobs.profileId, schema.projectProfiles.id))
      .where(eq(schema.jobs.id, jobId))
      .all()[0];
    const parsed = ProjectProfileSchema.safeParse(row?.document);
    return parsed.success ? parsed.data : null;
  }

  /** Bkz. `startPsqlHelper` — test klonları da aynı yardımcıyı kullanıyor. */
  private async throwawayPsqlContainer(profile: ProjectProfile): Promise<string> {
    return startPsqlHelper(this.deps.docker!, profile);
  }

  /** Compose projesindeki bir servisin konteyner kimliği. */
  private async dbContainerId(project: string, service: string, fallbackService?: string): Promise<string | null> {
    const find = async (svc: string) => {
      const list = await this.deps.docker!.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${svc}`] },
      });
      return list[0]?.Id ?? null;
    };
    return (await find(service)) ?? (fallbackService ? await find(fallbackService) : null);
  }

  /**
   * Ortamı kaldırır ve hazır olana kadar bekler. Hazır olmazsa ortam
   * yıkılmaz — kullanıcı loglara bakabilsin; kaydı `unhealthy` kalır.
   */
  async start(input: StartInput): Promise<StartedLive> {
    const { jobId, profile } = input;
    const live = profile.live;
    if (!live || !live.enabled) throw new Error("profilde canlı ortam tanımlı değil");

    // AYNI İŞİN ESKİ ORTAMI ÖNCE YIKILIR.
    //
    // Önceki deneme ortamı ayakta bırakmış olabilir (`unhealthy` kasten
    // bırakılır; hazır olduktan sonra düşen bir adım da `ready` bırakıyordu).
    // Yıkılmadan yeni kayıt açılırsa iş iki "aktif" ortam taşır, eski satırın
    // portları ve kirası asılı kalır. Yeniden KULLANILMAZ: arada kod değişmiş
    // olabilir ve eski konteyner onu görmez.
    //
    // `active()` tek kayıt döndürüyor; bu düzeltmeden önce biriken işlerde
    // birden fazla aktif satır olabilir. Hepsi yıkılır — `stop()` her turda
    // birini `stopped` yapar, döngü biter.
    while (this.active(jobId)) {
      await this.stop(jobId, input.worktreePath, live, "yeniden kaldırmadan önce eskisi yıkılıyor");
    }

    // Servisler üst düzey katalogdan ADLA çözülür. Tanımsız ad ortamı
    // kaldırmaz: eksik bir Postgres ile kalkan uygulama "çalışıyor" görünüp
    // her uçta 500 döner, teşhis ise compose loguna gömülürdü.
    const { found: liveDeps, missing } = resolveServices(profile, live.services);
    if (missing.length > 0) {
      throw new Error(`canlı ortamın istediği servis(ler) \`services\` içinde tanımlı değil: ${missing.join(", ")}`);
    }

    // Birincil + her ek port için bir host portu.
    const ports = await this.deps.ports.acquire(jobId, 1 + (live.app.extraPorts?.length ?? 0));

    // DB ŞABLONU artık canlı ortamın İÇİNDE kurulur; `extraEnv` ile uygulamaya
    // kendi veritabanı verilir. Eski golden volume yolu kaldırıldı: migrate
    // komutu uygulamanın tamamını ayağa kaldırıyor ve Redis + Elasticsearch
    // istiyordu, golden ise yalnız Postgres kaldırıyordu (çıkış 134, ölçüldü
    // 2026-09-18).
    const volumes = { ...(input.volumes ?? {}) };
    const dbDep = dbDependency(profile);
    const pgCreds = pgCredsFrom(profile);
    // ŞABLON DB KAPISI: `live.cloneDb`.
    //
    // Bu anahtar şemada ve UI'da vardı ama SUNUCUDA HİÇ OKUNMUYORDU: kapı
    // yalnız "postgres bağımlılığı var mı" diye bakıyordu. Sonuç, kapalı bir
    // `cloneDb` ile dış Postgres'e `psql` ile bağlanmaya çalışan ve 120 s
    // sonra "compose up düştü" ile biten bir canlı ortamdı (yaşandı
    // 2026-09-20) — hem de logun bir üst satırı "dış servisler: konteyner
    // kurulmuyor" diyordu. Kapalıysa uygulama bağlantı dizesini profilden
    // kendi alır; orkestratör DB'ye hiç dokunmaz.
    // `docker` da KOŞULA DAHİL: `templates` dolu ama `docker: null` olan bir
    // bağımlılık kümesi kurulabiliyor ve bu yol aşağıda `this.deps.docker!`
    // ile volume yaratıyor. Non-null assertion çalışma zamanında koruma
    // sağlamaz — ortam `unhealthy` düşerdi, üstelik sebebi söylemeden.
    const usesTemplateDb = Boolean(
      live.cloneDb && this.deps.templates && this.deps.docker && dbDep && pgCreds
        && profile.database.kind === "postgres",
    );
    // Açık ama kurulamıyorsa SESSİZ KALMA: `enabled: true` yazan biri klonun
    // olduğunu sanır ve iki iş aynı veritabanına yazar.
    if (live.cloneDb && !usesTemplateDb) {
      const why = !this.deps.templates ? "şablon DB desteği kurulu değil"
        : !this.deps.docker ? "Docker bağlantısı yok"
        : !dbDep ? `\`database.clone.service\` (${profile.database.clone.service}) servislerde bulunamadı`
        : !pgCreds ? "postgres kimliği çıkarılamadı"
        : `database.kind postgres değil (${profile.database.kind})`;
      this.log(jobId, `⚠ DB klonlama açık ama kurulamıyor: ${why}`, "stderr");
    }

    // İş DB'sinin adı jobId'den TÜRÜYOR, yani daha klonlanmadan bilinebiliyor.
    // Bu sayede compose dosyası tek seferde yazılır: uygulama servisi doğru
    // bağlantı dizesiyle tanımlanır, DB o ayağa kalkmadan önce hazırlanır.
    const extraEnv = { ...(input.extraEnv ?? {}) };
    let dbCloneConnectionString: string | undefined;
    if (usesTemplateDb && dbDep && pgCreds) {
      dbCloneConnectionString = pgConnString(dbDep, dbNamesFor(profile, jobId).job, pgCreds);
      // Postgres'e PROJE ÖMÜRLÜ volume: şablon ortamlar arası yaşar.
      //
      // `stop()` `compose down -v` çağırıyor ve anonim volume'leri siliyor;
      // şablon onunla gitseydi her canlı ortam migrate + seed'i baştan
      // koşardı ve "bir kez kur, çok kez klonla" kazancı hiç gerçekleşmezdi.
      // Adlandırılmış ve `external: true` olan volume `down -v`den etkilenmez.
      // Dış Postgres'in verisi HOST'ta: bağlanacak bir volume yok ve compose
      // o servisi zaten kurmuyor.
      if (!dbDep.externalHost) {
        volumes[dbDep.name] = { volume: pgDataVolume(profile.slug), mountPath: dbDep.dataPath! };
      }
    }

    // Vite dev sunucusu tanımadığı Host başlığını reddeder ("Blocked request.
    // This host ... is not allowed", yaşandı 2026-09-23). Traefik açıkken dış
    // adı Vite'ın kendi ortam değişkeniyle bildiriyoruz: hedef projenin
    // `vite.config`'ine dokunmadan, Vite olmayan uygulamada etkisiz.
    const traefik = live.traefik;
    if (traefik?.enabled && this.deps.traefikDynamicDir) {
      extraEnv.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = livePublicHost(jobId, traefik.domain);
    }

    // Uygulama env'i — entegrasyon takımlarıyla AYNI tablo.
    // Klon dizesi yalnız profilin `$dbCloneConnectionString` yazdığı adlara
    // gider; klon yokken bu yer tutucu çözülemez ve ortam KALKMAZ. Eskiden
    // "uygulama profildeki bağlantıyı kullanacak" uyarısıyla devam ediliyordu;
    // yer tutucuyla bu, uygulamaya bağlantı dizesi diye `$…` metni vermek olurdu.
    const ctx = { jobId, ...(dbCloneConnectionString !== undefined ? { dbCloneConnectionString } : {}) };
    const jobEnv = input.jobEnv ?? {};
    const unresolved = unresolvedPlaceholders({ ...profile.appEnv, ...jobEnv }, ctx);
    if (unresolved.length > 0) {
      this.deps.ports.release(jobId);
      throw new Error(`uygulama env'i çözülemedi: ${unresolved.map((n) => `$${n}`).join(", ")}`
        + (unresolved.includes(DB_CLONE_PLACEHOLDER) ? " — canlı ortamda DB klonu yok (live.cloneDb kapalı ya da kurulamıyor)" : ""));
    }
    const appEnv = resolveEnvPlaceholders(profile.appEnv, ctx);

    // İşe özel değişkenler en sonda. Log'a yalnız ADLAR gider (değer sır
    // olabilir); neyi ezdiği yazılır ki "profilde X yazıyor ama uygulama Y
    // görüyor" sorusunun cevabı iş ekranında dursun.
    const jobEnvNames = Object.keys(jobEnv).sort();
    if (jobEnvNames.length > 0) {
      const overridden = jobEnvNames.filter((k) => Object.hasOwn(extraEnv, k) || Object.hasOwn(appEnv, k));
      this.log(jobId, `▷ işe özel ortam değişkenleri: ${jobEnvNames.join(", ")}${overridden.length ? ` (ezilen: ${overridden.join(", ")})` : ""}`);
      Object.assign(extraEnv, resolveEnvPlaceholders(jobEnv, ctx));
    }
    // `emptyEnv` birleştirmeden SONRA uygulanıyor (compose.ts); dolu bir
    // işe özel değer orada sessizce tek boşluğa dönerdi. Boş değer ise
    // profilin kuralına kalır.
    const renderLive: Live = jobEnvNames.some((k) => jobEnv[k] && live.emptyEnv.includes(k))
      ? { ...live, emptyEnv: live.emptyEnv.filter((k) => !jobEnv[k]) }
      : live;

    // BUILD ZİNCİRİ: build adımları canlı konteynerin `command`'ında, başlatma
    // komutunun ÖNÜNDE koşar. Tek konteyner, tek araç zinciri, garantili sıra.
    //
    // `app.build` yolunda kurulamaz: Dockerfile'dan imaj üretiliyor ve
    // jobVolume mount EDİLMİYOR (bkz. compose.ts) — kod imajda gömülü, zincirin
    // derleyecek bir worktree'si yok. Sessiz kalma: profil `buildBeforeStart`
    // yazmışsa build'in koştuğunu sanır.
    const startRun = live.app.command ?? live.startCommand?.run;
    let buildChain: string | undefined;
    if (live.buildBeforeStart && startRun) {
      if (live.app.build) {
        this.log(jobId, "⚠ `app.build` yolunda build zinciri kurulmaz (kod imajda gömülü) — `buildBeforeStart` yok sayıldı", "stderr");
      } else if (live.app.workdir) {
        try {
          // Yasak bayrak KOMUT ÜRETİLMEDEN önce: `-c Release` private NuGet'e
          // düşüp 401 döner — kısıt, tercih değil. Zincir kurulduktan sonra
          // bakmak konteyneri boşuna kaldırırdı.
          assertNoForbiddenFlags(profile.build);
        } catch (err) {
          this.deps.ports.release(jobId);
          throw err;
        }
        // Zincirin kökü compose'un `working_dir`i ile AYNI olmalı: adım
        // `cwd`leri ona göreli ve `liveWorkingDir` agent kökünü canlı köke
        // çeviriyor (bkz. compose.ts, YAŞANDI 2026-09-22).
        const chainWorkdir = liveWorkingDir(input.worktreePath, profile.exec.workdir, live.app.workdir);
        buildChain = renderBuildChain(
          profile.build,
          startRun,
          chainWorkdir,
          live.startCommand?.cwd ?? ".",
        );
      }
    }

    let rendered: ReturnType<typeof renderComposeOverride>;
    try {
      rendered = renderComposeOverride({
        jobId, live: renderLive, dependencies: liveDeps, hostPorts: ports,
        ...(buildChain ? { buildChain } : {}),
        ...(this.deps.probeNetwork ? { probeNetwork: this.deps.probeNetwork } : {}),
        ...(this.deps.publishHost ? { publishHost: this.deps.publishHost } : {}),
        ...(Object.keys(appEnv).length > 0 ? { appEnv } : {}),
        ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
        ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
        // Hazır imaj yolunda worktree mount edilir: iş dizini bağlanır, uygulama
        // repo alt dizininde koşar (agent konteyneriyle aynı düzen). Artık host
        // yolu değil NAMED VOLUME — compose onu adıyla bağlar.
        jobVolume: jobVolumeName(jobId),
        // Worktree'nin volume içindeki TAM yolu; `basename` yetmiyor çünkü ağaç
        // `<workdir>/worktrees/<jobId>/<repo>` altında yaşıyor.
        worktreePath: input.worktreePath,
        // Bu yol agent konteynerinin köküne göre; canlı konteynerin köküne
        // `renderComposeOverride` çevirir (bkz. `liveWorkingDir`).
        execWorkdir: profile.exec.workdir,
      });
    } catch (err) {
      // Profil hatası (ör. yayınlanmayan `healthcheck.port`): kiralanan portlar
      // aşağıdaki `catch`e hiç varmadan sızardı.
      this.deps.ports.release(jobId);
      throw err;
    }

    const dir = join(this.deps.artifactsDir, jobId, "live");
    mkdirSync(dir, { recursive: true });
    const overridePath = join(dir, "compose.override.yml");
    writeFileSync(overridePath, rendered.yaml);
    // Base dosyası volume'de: compose host'ta koştuğu için çıkarılmalı.
    const basePath = await this.materializeComposeBase(jobId, live, dir, input);

    const id = newId();
    const expiresAt = new Date(Date.now() + live.ttlMinutes * 60_000).toISOString();
    this.deps.db.insert(schema.liveEnvironments).values({
      id, jobId, composeProject: rendered.project, networkName: rendered.network,
      appUrl: rendered.appUrl, ports, status: "starting", expiresAt,
    }).run();
    // AYNI İŞİN ESKİ KİRASI DEVRALINIR.
    //
    // Compose projesi adı iş başına SABİT (`ahtapot-<jobId>`). Ortam
    // `unhealthy` kalıp hiç `stop()` edilmezse kira asılı kalıyor ve o iş bir
    // daha ASLA ortam kaldıramıyordu — kendi kendine çıkamayan bir kilit
    // (yaşandı 2026-09-17: 08:20'de alınan kira 12:03'teki koşuyu düşürdü).
    //
    // Başka bir işin kirasıysa DOKUNULMAZ: `acquireLease` reddeder ve çakışma
    // gerçek bir çakışmadır.
    const stale = this.deps.db
      .select({ jobId: schema.resourceLeases.jobId })
      .from(schema.resourceLeases)
      .where(and(
        eq(schema.resourceLeases.kind, "live_env"),
        eq(schema.resourceLeases.value, rendered.project),
        eq(schema.resourceLeases.state, "held"),
      ))
      .all();
    if (stale.length > 0 && stale.every((s) => s.jobId === jobId)) {
      releaseLease(this.deps.db, "live_env", rendered.project);
    }
    acquireLease(this.deps.db, { jobId, kind: "live_env", value: rendered.project, expiresAt });

    const args = this.composeArgs(jobId, live, overridePath, basePath);
    // Compose cwd'si artık artifact dizini: worktree host'ta yok (volume).
    const composeCwd = dir;
    const log = (line: string) => this.deps.hub?.publish(jobId, { type: "build.log", stream: "stdout", line: scrubSecrets(line) });

    try {
      if (usesTemplateDb) {
        // `external: true` volume'ü compose YARATMAZ; yoksa "volume not found"
        // ile düşer. Var olanı yeniden yaratmak zararsız (409 yutulur).
        await this.deps.docker!.createVolume({
          Name: pgDataVolume(profile.slug),
          Labels: { "ahtapot.role": "pgdata", "ahtapot.project": profile.slug },
        }).catch(() => {});

        // AŞAMA 1: yalnız bağımlılıklar. Uygulama henüz kalkmaz — bağlanacağı
        // veritabanı daha yok. Şablon kurulumu da bu servisleri kullanacak,
        // bu yüzden Redis ve Elasticsearch de burada ayağa kalkar.
        // DIŞARIDAKİ servisler compose'da TANIMLI DEĞİL: adlarını `up`a
        // vermek "no such service: postgres" ile düşürüyordu (yaşandı
        // 2026-09-17). Yalnız compose'un kurduğu servisler sayılır.
        const depNames = liveDeps.filter((d) => !d.externalHost).map((d) => d.name);
        const external = liveDeps.filter((d) => d.externalHost);
        if (external.length > 0) {
          log(`▷ dış servisler (konteyner kurulmuyor): ${external.map((d) => `${d.name}@${d.externalHost}:${d.externalPort ?? d.internalPort}`).join(", ")}`);
        }
        let upDeps = { stdout: "", stderr: "" };
        if (depNames.length > 0) {
          log(`▶ canlı ortam: bağımlılıklar kalkıyor (${depNames.join(", ")})`);
          upDeps = await this.compose([...args, "up", "-d", "--remove-orphans", ...depNames], composeCwd);
        }
        for (const l of `${upDeps.stdout}\n${upDeps.stderr}`.split("\n")) if (l.trim()) log(l);

        await this.prepareDatabase(jobId, profile, rendered, args, composeCwd, log);

        // AŞAMA 2: uygulama, kendi DB'siyle.
        
        log(`▶ canlı ortam: uygulama kalkıyor (${rendered.appService} - ${rendered.appUrl})`);

        const upApp = await this.compose([...args, "up", "-d", rendered.appService], composeCwd);
        
        for (const l of `${upApp.stdout}\n${upApp.stderr}`.split("\n")) if (l.trim()) log(l);

      } else {
        log(`▶ canlı ortam: docker compose ${args.join(" ")} up -d`);
        const up = await this.compose([...args, "up", "-d", "--remove-orphans"], composeCwd);
        for (const l of `${up.stdout}\n${up.stderr}`.split("\n")) if (l.trim()) log(l);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.markStatus(id, "unhealthy");
      log(`✖ compose up düştü: ${scrubSecrets(msg)}`);
      // CLI yoksa döküm de aynı hatayla düşer; boşuna iki satır daha basma.
      if (!(err instanceof DockerCliMissingError)) await this.dumpDiagnostics(args, composeCwd, log);
      // PORTLARI BIRAK: başlatma düştüğünde kiralar `held` kalıyordu ve her
      // deneme bir sonrakini tüketiyordu — tek port kullanan bir iş dört port
      // tutmuş hâlde bulundu (ölçüldü 2026-09-17). Havuz sonlu; sızıntı
      // eninde sonunda "boş port kalmadı" ile canlı ortamı tümden durdurur.
      this.deps.ports.release(jobId);
      return { id, appUrl: rendered.appUrl, ...(rendered.apiUrl ? { apiUrl: rendered.apiUrl } : {}), ports, expiresAt, ready: false, reason: msg };
    }

    const readLog = async () => {
      try {
        // Geniş pencere: yoklama arasında 300 satırdan fazla gürültü akabiliyor;
        // desen kalıcılığı readiness.ts'te, bu yalnız kaçırma olasılığını düşürür.
        const r = await this.compose([...args, "logs", "--no-color", "--tail", "2000", rendered.appService], composeCwd);
        return `${r.stdout}\n${r.stderr}`;
      } catch {
        return "";
      }
    };

    const writeLog = (line: string) => {
      log(`  ${line}`);
    }
    
    log(`■ canlı ortam ayağa kalktı, hazır olana kadar bekleniyor (sağlık: ${new URL(live.healthcheck.path, rendered.healthUrl).toString()}${live.readiness ? `, log deseni: ${live.readiness.logPattern}` : ""})`);

    // KIRMIZI BUILD'İ ERKEN YAKALA. Zincir düşen adımda `FAIL_SENTINEL` basıp
    // çıkıyor; bu desen aranmazsa ortam `healthcheck.timeoutMinutes` dolana
    // kadar beklerdi — build'i kapsaması için o değer büyük olmak zorunda
    // (Northwind ~27 dk), yani kırmızı build yarım saat gecikirdi.
    //
    // Profilin kendi `failPatterns`ı korunur; bu desen motorun eklediğidir.
    const readiness = buildChain
      ? {
          logPattern: live.readiness?.logPattern ?? "",
          minCaptureValue: live.readiness?.minCaptureValue ?? 0,
          failPatterns: [...(live.readiness?.failPatterns ?? []), FAIL_SENTINEL],
        }
      : live.readiness;

    const result = await waitForReady({
      url: rendered.healthUrl,
      healthcheck: live.healthcheck,
      readiness,
      readLog,
      ...(input.readinessOverride?.intervalMs !== undefined ? { intervalMs: input.readinessOverride.intervalMs } : {}),
      ...(input.readinessOverride?.timeoutMs !== undefined ? { timeoutMs: input.readinessOverride.timeoutMs } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.probeNetwork && this.deps.docker
        ? { diagnoseUnreachable: () => this.diagnoseProbe(this.deps.probeNetwork!, rendered.project, rendered.appService) }
        : {}),
      writeLog,
    });

    if (!result.ready) {
      this.markStatus(id, "unhealthy");
      // BUILD mi düştü, uygulama mı kalkmadı? İkisi de `ready:false` ama
      // sonuçları ayrı: kırmızı build Developer'ın düzeltebileceği bir şeydir,
      // kalkmayan uygulama insanı çağırır.
      const tail = buildChain ? await readLog() : "";
      const failedStep = tail ? parseFailedStep(tail) : null;
      if (failedStep) {
        log(`✖ build kırmızı: ${failedStep} — Developer'a dönülüyor`);
        await this.dumpDiagnostics(args, composeCwd, log);
        return {
          id, appUrl: rendered.appUrl, ...(rendered.apiUrl ? { apiUrl: rendered.apiUrl } : {}),
          ports, expiresAt, ready: false, reason: `build kırmızı: ${failedStep}`,
          buildFailed: true, failedStep, logTail: tail,
        };
      }
      log(`✖ canlı ortam hazır değil: ${result.reason}`);
      await this.dumpDiagnostics(args, composeCwd, log);
      return { id, appUrl: rendered.appUrl, ...(rendered.apiUrl ? { apiUrl: rendered.apiUrl } : {}), ports, expiresAt, ready: false, reason: result.reason };
    }

    this.markStatus(id, "ready");
    log(`■ canlı ortam hazır (${(result.elapsedMs / 1000).toFixed(0)} s${result.captured !== null ? `, yakalanan: ${result.captured}` : ""})`);
    this.deps.hub?.publish(jobId, { type: "live.ready", url: rendered.appUrl, ports, expiresAt });
    this.startInputs.set(jobId, input);
    this.armTtl(jobId, expiresAt);

    const publicUrl = this.writeTraefikRoute(jobId, profile, rendered.appUrl, log);

    return {
      id, appUrl: rendered.appUrl,
      ...(rendered.apiUrl ? { apiUrl: rendered.apiUrl } : {}),
      ...(publicUrl ? { publicUrl } : {}),
      ports, expiresAt, ready: true, reason: result.reason,
    };
  }

  /**
   * Sağlık adresinin adı (`<project>`, probe ağındaki takma ad) çözülmüyor:
   * NEDEN? Üç olasılık ayrı ayrı sınanır, çünkü hepsi aynı `EAI_AGAIN` /
   * `ENOTFOUND` olarak görünüyor:
   *
   *  1. Uygulama konteyneri koşmuyor (çıktı/yeniden başlıyor) → takma ad ağda yok.
   *  2. Sunucu konteyneri probe ağında değil → Docker'ın gömülü DNS'i ona o
   *     ağın adlarını vermez.
   *  3. Sunucu Docker DIŞINDA (host'ta) koşuyor → host ağ içi adları hiç
   *     çözemez; `AHTAPOT_LIVE_NETWORK` boş kalmalıydı.
   *
   * Yalnız "yeniden başlıyor" ve "her şey yerinde" ölümcül değil — ikincisi
   * gerçekten geçici bir DNS aksaklığı olabilir.
   */
  private async diagnoseProbe(network: string, project: string, appService: string): Promise<{ fatal: boolean; message: string } | null> {
    const docker = this.deps.docker!;
    const envName = "AHTAPOT_LIVE_NETWORK";

    let attached: Record<string, { Name?: string }>;
    try {
      const info = (await docker.getNetwork(network).inspect()) as { Containers?: Record<string, { Name?: string }> };
      attached = info.Containers ?? {};
    } catch (err) {
      // Yalnız 404 "ağ yok" demek; daemon/yetki hatası geçici olabilir ve
      // yoklamayı öldürmemeli.
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { fatal: true, message: `\`${network}\` Docker ağı yok — ${envName} sunucunun bağlı olduğu ağın adı olmalı` };
      }
      return { fatal: false, message: `Docker ağı incelenemedi (${err instanceof Error ? err.message : String(err)})` };
    }
    const onNet = (id: string, name?: string) =>
      Object.entries(attached).some(([cid, c]) => cid.startsWith(id) || (name !== undefined && c.Name === name));

    const app = (await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${appService}`] },
    }))[0];
    if (!app) return { fatal: true, message: `uygulama konteyneri (${appService}) bulunamadı — compose onu kurmadı` };
    if (app.State === "restarting") return { fatal: false, message: `uygulama konteyneri yeniden başlıyor (${app.Status})` };
    if (app.State !== "running") {
      // Çıkış sebebi konsolun son satırlarında; yalnız "konsola bakın" demek
      // insanı tam döküm aramaya gönderiyordu (yaşandı: Exited (134), sebep
      // mesajda yoktu). Kuyruk mesaja gömülür; okunamazsa eski metin kalır.
      // Maskeleme KESMEDEN önce: sınırda yarım kalan bir sır desene uymaz.
      // `tty: true` servisin logu çerçevesiz gelir; `demux` onu bozardı.
      const c = docker.getContainer(app.Id);
      const tail = await c.inspect()
        .then(async (info) => {
          const buf = (await c.logs({ stdout: true, stderr: true, tail: 12 })) as unknown as Buffer;
          return info.Config.Tty ? buf.toString("utf8") : demux(buf);
        })
        .then((text) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-8)
          .map((l) => scrubSecrets(l)).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)))
        .catch(() => [] as string[]);
      const base = `uygulama konteyneri koşmuyor: ${app.State} (${app.Status}) — takma ad ağda yok`;
      return {
        fatal: true,
        message: tail.length > 0
          ? `${base}; konsolun son satırları:\n${scrubSecrets(tail.join("\n"))}`
          : `${base}; konteyner konsolu boş ya da okunamadı`,
      };
    }
    if (!onNet(app.Id)) {
      return { fatal: true, message: `uygulama konteyneri \`${network}\` ağına takılı değil — profilin compose base dosyası \`networks\`i eziyor olabilir` };
    }

    // Sunucunun kendisi: Docker'da `hostname` varsayılan olarak konteyner
    // kimliğinin ilk 12 karakteri. `hostname:` ezilmişse o ne ad ne kimliktir;
    // gerçek kimlik çekirdeğin bağlama tablosundan okunur.
    const self = hostname();
    const inspect = (ref: string) => docker.getContainer(ref).inspect().catch(() => null);
    let me = await inspect(self);
    if (!me) {
      const cid = ownContainerId();
      if (cid) me = await inspect(cid);
    }
    if (me) {
      if (onNet(me.Id, me.Name.replace(/^\//, ""))) return null;
      const nets = Object.keys(me.NetworkSettings?.Networks ?? {});
      return {
        fatal: true,
        message: `sunucu konteyneri (${me.Name.replace(/^\//, "")}) \`${network}\` ağında değil; bağlı olduğu ağlar: ${nets.join(", ") || "yok"} — ${envName} bunlardan biri olmalı`,
      };
    }
    if (!existsSync("/.dockerenv")) {
      return {
        fatal: true,
        message: `sunucu Docker dışında (host'ta) koşuyor görünüyor ve host ağ içi adları çözemez — ${envName}'i boş bırakın, yoklama yayınlanan porttan yapılır`,
      };
    }
    // Konteynerdeyiz ama kendimizi bulamadık (ör. `hostname:` ezilmiş): kesin
    // konuşamayız, beklemeye devam.
    return { fatal: false, message: `sunucu konteyneri tanınamadı (hostname ${self}); \`${network}\` ağına bağlı olduğundan emin olun` };
  }

  /**
   * Düşen ortamın konteyner dökümü: hangi servis hangi durumda + son satırlar.
   *
   * Eskiden başarısızlık TEK satırdı ("compose up düştü" / "hazır değil") ve
   * sebebi görmek için sunucuya girip `docker logs` koşmak gerekiyordu; çıkıp
   * giden bir konteynerin konsolu UI'dan hiç görünmüyordu (yaşandı
   * 2026-09-22). Ortam zaten yıkılmıyor — döküm, o incelemeyi iş ekranına
   * taşır. Dökümün kendisi düşerse yutulur: asıl hata çoktan yazıldı.
   */
  private async dumpDiagnostics(args: string[], cwd: string, log: (line: string) => void): Promise<void> {
    const sections: Array<[string, string[]]> = [
      ["konteyner durumu", ["ps", "-a"]],
      ["konteyner konsolu (son 80 satır)", ["logs", "--no-color", "--timestamps", "--tail", "80"]],
    ];
    for (const [title, cmd] of sections) {
      try {
        const r = await this.compose([...args, ...cmd], cwd);
        const lines = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.trim());
        if (lines.length === 0) continue;
        log(`── ${title} ──`);
        for (const l of lines) log(l);
      } catch {
        // bilinçli boş
      }
    }
  }

  /**
   * Traefik dinamik dosyasını yazar; profil `live.traefik.enabled` DEĞİLSE
   * ya da `AHTAPOT_TRAEFIK_DYNAMIC_DIR` boşsa hiçbir şey yapmaz (opsiyonel
   * özellik — motora gömülmez).
   *
   * Uygulama HAZIR olduktan sonra çağrılır: henüz ayakta değilken route
   * açmak insana 502 gösterir, yalnız kafa karıştırır.
   */
  private writeTraefikRoute(jobId: string, profile: ProjectProfile, appUrl: string, log: (line: string) => void): string | undefined {
    const traefik = profile.live?.traefik;
    const dir = this.deps.traefikDynamicDir;
    if (!traefik?.enabled || !dir) return undefined;

    const targetPort = Number(new URL(appUrl).port);
    const route = renderTraefikRoute({
      jobId,
      domain: traefik.domain,
      certResolver: traefik.certResolver,
      backendHost: this.deps.traefikBackendHost ?? "127.0.0.1",
      targetPort,
    });
    // Yazılamazsa ortam DÜŞMEZ: uygulama zaten hazır ve port adresinden
    // erişilebilir. Hata yukarı kaçınca `start()` fırlatıyor, iş
    // `developing_failed`a düşüyor ve ayakta, `ready` bir ortam sahipsiz
    // kalıyordu (yaşandı 2026-09-23: NFS'teki dizinde `EACCES: mkdir`).
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${jobId}.yml`), route.yaml);
    } catch (err) {
      log(`⚠ Traefik yönlendirmesi yazılamadı (${dir}): ${err instanceof Error ? err.message : String(err)} — uygulama yalnız port adresinden açılır`);
      return undefined;
    }
    log(`■ Traefik yönlendirmesi yazıldı: ${route.publicUrl}`);
    return route.publicUrl;
  }

  /** Traefik dosyasını siler; yoksa (hiç yazılmamışsa) sessizce geçer. İdempotent. */
  private removeTraefikRoute(jobId: string): void {
    const dir = this.deps.traefikDynamicDir;
    if (!dir) return;
    const path = join(dir, `${jobId}.yml`);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  /** Ayakta olan ortama DAST (`live.dast`); raporlar `<artifactsDir>/<jobId>/dast-<tur>/`. */
  dast(input: { jobId: string; profile: ProjectProfile; round: number; scope?: DastTargets }): Promise<DastSummary> {
    return runDast({
      ...input,
      artifactsDir: this.deps.artifactsDir,
      log: (line) => this.deps.hub?.publish(input.jobId, { type: "build.log", stream: "stdout", line: scrubSecrets(line) }),
    });
  }

  /**
   * Tarayıcı testinin hedefi: canlı test adımında insana verilen
   * adresin AYNISI — insan neyi açtıysa agent da onu açar.
   *
   * İstisna: adres loopback'teyse (`publishHost` verilmemiş, 127.0.0.1) iş
   * konteynerinin içinden `127.0.0.1` kendisidir (sağlık yoklamasında
   * yaşandı, 2026-09-22). Yalnız o durumda konteyner uygulamanın "edge"
   * ağına bağlanır ve iç IP kullanılır. Eskiden HER durumda iç IP'ye
   * gidiliyordu; insan `192.168.1.50:20001` görürken agent `172.19.0.2:5173`
   * açıyordu ve hangi adresin test edildiği belirsizleşiyordu (2026-10-17).
   */
  async attachBrowser(jobId: string, profile: ProjectProfile): Promise<{ baseUrl: string; origins: string[]; detach(): Promise<void> }> {
    const live = profile.live;
    if (!live) throw new Error("profilde canlı ortam yok");
    const env = this.active(jobId);
    const custom = live.browserTest.baseUrl.trim();
    if (env?.appUrl && !custom) {
      const app = new URL(env.appUrl);
      const loopback = ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(app.hostname) || app.hostname.startsWith("127.");
      if (!loopback) {
        // Uygulamanın TÜM yayınlanan portları aynı host'ta: arayüz API'yi
        // ayrı porttan çağırır (Northwind: panel 20001, API 20000).
        const origins = [...new Set([app.origin, ...env.ports.map((p) => `${app.protocol}//${app.hostname}:${p}`)])];
        return { baseUrl: env.appUrl, origins, detach: async () => {} };
      }
    }
    return this.attachBrowserInternal(jobId, profile);
  }

  /** Loopback yedeği: iş konteynerini edge ağına bağlar, iç IP'den gider. */
  private async attachBrowserInternal(jobId: string, profile: ProjectProfile): Promise<{ baseUrl: string; origins: string[]; detach(): Promise<void> }> {
    const docker = this.deps.docker;
    const live = profile.live;
    if (!docker || !live) throw new Error("Docker bağlantısı ya da profilde canlı ortam yok");
    const appService = live.app.service ?? "app";
    const app = (await docker.listContainers({
      filters: { label: [`com.docker.compose.project=${composeProject(jobId)}`, `com.docker.compose.service=${appService}`] },
    }))[0];
    if (!app) throw new Error(`uygulama konteyneri (${appService}) koşmuyor`);
    const networks = app.NetworkSettings?.Networks ?? {};
    const nets = Object.keys(networks);
    // Compose ağ adına proje önekini ekliyor (`<proje>_<ağ>-edge`).
    const edge = nets.find((n) => n.endsWith("-edge"));
    if (!edge) throw new Error(`uygulamanın edge ağı bulunamadı (${nets.join(", ")})`);
    // Ad değil IP: servis adı `app` Chrome'un HSTS ön yükleme listesindeki
    // `.app` alanına düşüyor ve tarayıcı `http://app:5173`ü zorla HTTPS'e
    // çeviriyordu (`ERR_SSL_PROTOCOL_ERROR`, yaşandı 2026-10-16). IP ayrıca
    // Vite'ın host kontrolüne takılmaz — bilinmeyen ad 403 alırdı.
    const ip = networks[edge]?.IPAddress;
    if (!ip) throw new Error(`uygulamanın ${edge} ağındaki IP'si okunamadı`);

    const primary = live.app.extraPorts.find((e) => e.primary)?.containerPort ?? live.app.containerPort;
    const custom = live.browserTest.baseUrl.trim();
    const baseUrl = custom ? resolveJobPlaceholders(custom, jobId) : `http://${ip}:${primary}`;
    // Bağlanmadan ÖNCE çözülür: geçersiz `baseUrl` konteyneri ağda asılı bırakmasın.
    const baseOrigin = new URL(baseUrl).origin;

    const agent = containerName.agent(jobId);
    await docker.getNetwork(edge).connect({ Container: agent }).catch((err: { statusCode?: number; message?: string }) => {
      // Önceki tur yarıda kaldıysa bağlantı zaten var: 403 "already exists".
      if (err.statusCode !== 403) throw err;
    });
    // Uygulamanın TÜM portları: arayüz API'yi ayrı porttan çağırabilir
    // (Northwind: panel 5173, backend 5080). Dış kökenler (CDN, analitik) süzülür.
    const ports = [live.app.containerPort, ...live.app.extraPorts.map((e) => e.containerPort)];
    const origins = [...new Set([baseOrigin, ...ports.map((p) => `http://${ip}:${p}`)])];
    return { baseUrl, origins, detach: () => this.detachBrowser(jobId, edge) };
  }

  /** Bağlıysa koparır; yoksa sessiz. `stop()` da çağırır: bağlı konteyner ağın silinmesini engeller. */
  private async detachBrowser(jobId: string, network: string): Promise<void> {
    await this.deps.docker?.getNetwork(network).disconnect({ Container: containerName.agent(jobId), Force: true }).catch(() => {});
  }

  /** TTL uzatır; yeni bitiş zamanı döner. Ortam yoksa null. */
  extend(jobId: string, minutes: number): string | null {
    const env = this.active(jobId);
    if (!env) return null;
    const base = Math.max(Date.now(), new Date(env.expiresAt ?? Date.now()).getTime());
    const expiresAt = new Date(base + minutes * 60_000).toISOString();
    this.deps.db.update(schema.liveEnvironments).set({ expiresAt }).where(eq(schema.liveEnvironments.id, env.id)).run();
    this.deps.db.update(schema.resourceLeases).set({ expiresAt })
      .where(and(eq(schema.resourceLeases.kind, "live_env"), eq(schema.resourceLeases.value, env.composeProject), eq(schema.resourceLeases.state, "held"))).run();
    this.armTtl(jobId, expiresAt);
    return expiresAt;
  }

  /** Ortamı yıkar (`down -v`), kiraları bırakır. İdempotent. */
  async stop(jobId: string, worktreePath: string, live: Live | undefined, reason = "istendi"): Promise<boolean> {
    const env = this.active(jobId);
    if (!env) return false;
    const t = this.timers.get(jobId);
    if (t) clearTimeout(t);
    this.timers.delete(jobId);
    // Profil AŞAĞIDA gerekiyor (dış DB klonunu düşürmek için); haritadan
    // silmeden ÖNCE alınır.
    const profile = this.startInputs.get(jobId)?.profile;
    this.startInputs.delete(jobId);

    this.removeTraefikRoute(jobId);

    const liveDir = join(this.deps.artifactsDir, jobId, "live");
    const overridePath = join(liveDir, "compose.override.yml");
    // `start()` base dosyasını buraya çıkarmıştı (worktree volume'de, host'ta
    // yok). Varsa onu kullan; yoksa profildeki yol (eski davranış).
    const extractedBase = join(liveDir, "compose.base.yml");
    const basePath = existsSync(extractedBase) ? extractedBase : undefined;
    // Tarayıcı turu yarıda kaldıysa iş konteyneri edge ağına bağlı kalmıştır;
    // `down` o ağı "active endpoints" ile silemez ve ortam yarım yıkılır.
    await this.detachBrowser(jobId, `${composeProject(jobId)}_${env.networkName}-edge`);
    if (live) {
      try {
        await this.compose([...this.composeArgs(jobId, live, overridePath, basePath), "down", "-v", "--remove-orphans"], liveDir);
      } catch (err) {
        this.deps.hub?.publish(jobId, { type: "build.log", stream: "stderr", line: `compose down düştü: ${scrubSecrets(err instanceof Error ? err.message : String(err))}` });
      }
    }
    this.deps.db.update(schema.liveEnvironments).set({ status: "stopped", stoppedAt: isoNow() }).where(eq(schema.liveEnvironments.id, env.id)).run();
    releaseLease(this.deps.db, "live_env", env.composeProject);
    this.deps.ports.release(jobId);
    // İş DB'si klondur; ortam yıkılınca diski boşuna tutmasın.
    //
    // Postgres KONTEYNERDEYSE ayrıca bir şey yapmaya gerek yok: `compose
    // down -v` konteyneri ve volume'ünü siliyor, klon da onunla gidiyor.
    //
    // DIŞARIDAYSA HİÇBİR ŞEY GİTMEZ. Klon host'taki Postgres'te duruyor ve
    // `down -v` ona dokunmuyor; her iş bir veritabanı bırakıyordu. Yüzlerce
    // iş sonra disk dolar ve kimse nereden geldiğini bilemez.
    //
    // Temizlik girdileri ÇALIŞMA BELLEĞİNDEN TÜRETİLMEZ. `jobDbNames` ve
    // `startInputs` yalnız bu süreç yaşadığı sürece dolu: readiness düşerse
    // `startLiveTest()` işi `fail()` ile kapatıp `stop()` çağırmıyor, sunucu
    // yeniden başlarsa iki harita da boş doğuyor. İkisine bakan bir temizlik,
    // tam da klonun kaldığı durumlarda sessizce atlanırdı. Kalıcı kayıt
    // yeterli: `jobs.profileId` → `projectProfiles.document` profili verir,
    // `dbNamesFor(profile, jobId)` klon adını yeniden üretir.
    this.jobDbNames.delete(jobId);
    const cleanupProfile = profile ?? this.profileOf(jobId);
    if (cleanupProfile?.live?.cloneDb && cleanupProfile.database.clone.dropOnCleanup && this.deps.templates && this.deps.docker) {
      const dep = dbDependency(cleanupProfile);
      const creds = pgCredsFrom(cleanupProfile);
      // Yalnız DIŞ servis: konteynerdeki klon `down -v` ile zaten gitti.
      if (dep?.externalHost && creds && cleanupProfile.database.kind === "postgres") {
        const jobDb = dbNamesFor(cleanupProfile, jobId).job;
        let cid: string | null = null;
        try {
          cid = await this.throwawayPsqlContainer(cleanupProfile);
          const dropped = await this.deps.templates.dropJobDb(cid, jobDb, creds);
          this.log(jobId, dropped ? `■ iş DB'si düşürüldü: ${jobDb}` : `⚠ iş DB'si düşürülemedi: ${jobDb}`, dropped ? "stdout" : "stderr");
        } catch (err) {
          // Temizlik ortamı yıkmayı DÜŞÜRMEZ: artık bir DB kalması, kaynağın
          // hiç serbest kalmamasından iyidir.
          this.log(jobId, `⚠ iş DB'si düşürülemedi (${jobDb}): ${err instanceof Error ? err.message : String(err)}`, "stderr");
        } finally {
          if (cid) await this.deps.docker.getContainer(cid).remove({ force: true }).catch(() => {});
        }
      }
    }
    if (this.deps.golden) await this.deps.golden.removeJobVolume(jobId).catch(() => {});
    this.deps.hub?.publish(jobId, { type: "build.log", stream: "stdout", line: `■ canlı ortam yıkıldı (${reason})` });
    return true;
  }

  active(jobId: string) {
    return this.deps.db.select().from(schema.liveEnvironments)
      .where(eq(schema.liveEnvironments.jobId, jobId)).all()
      .find((e) => e.status === "starting" || e.status === "ready" || e.status === "unhealthy");
  }

  private markStatus(id: string, status: "ready" | "unhealthy" | "stopped"): void {
    this.deps.db.update(schema.liveEnvironments).set({ status, ...(status === "stopped" ? { stoppedAt: isoNow() } : {}) })
      .where(eq(schema.liveEnvironments.id, id)).run();
  }

  /** Süreç yeniden başlarsa zamanlayıcı kaybolur; süresi geçmiş ortamları `reconcile` kapatır. */
  private readonly startInputs = new Map<string, StartInput>();

  private armTtl(jobId: string, expiresAt: string): void {
    const prev = this.timers.get(jobId);
    if (prev) clearTimeout(prev);
    const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(jobId);
      const input = this.startInputs.get(jobId);
      if (!input || !this.active(jobId)) return;
      void this.stop(jobId, input.worktreePath, input.profile.live, "TTL doldu").catch(() => {});
    }, ms);
    timer.unref?.();
    this.timers.set(jobId, timer);
  }
}
