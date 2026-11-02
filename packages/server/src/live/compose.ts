import { stringify } from "yaml";

import {
  composeProject,
  networkName,
  resolveEnvPlaceholders,
  resolveJobPlaceholders,
  type Live,
  type Service,
} from "@ahtapot/shared";

/**
 * Compose override üretici — profilin `live` bölümünden iş başına dosya.
 *
 * Portlar havuzdan gelir, ağ ve volume'ler iş adını taşır; profil dosyası
 * DOKUNULMAZ. Üretilen override `-f <base> -f <override>` ile bindirilir;
 * `compose.base` yoksa (yalnız `startCommand`) tam dosya üretilir.
 *
 * `emptyEnv`: .NET'te boş dizeye ayarlanan değişken SİLİNİR ve appsettings
 * değeri geri gelir; Elasticsearch "tanımlı ama erişilemez" hâlinde host
 * açılışta ölür. Bu yüzden tek boşluk geçilir — ölçülmüş bir gerçek.
 */

export interface ComposeInput {
  jobId: string;
  live: Live;
  /** `live.services` adlarının katalogdan çözülmüş tanımları (bkz. `resolveServices`). */
  dependencies?: Service[];
  /** Havuzdan kiralanan host portları; ilki uygulama, kalanı bağımlılıklar (isteğe bağlı). */
  hostPorts: number[];
  /**
   * Profilin `appEnv`i, yer tutucuları ÇÖZÜLMÜŞ olarak. Çözüm çağıranda:
   * klon dizesi ve eksik yer tutucu denetimi compose'un bilmediği bağlam ister.
   */
  appEnv?: Record<string, string>;
  /** Orkestratörün ve insanın ekledikleri — `appEnv`in üstüne yazılır. */
  extraEnv?: Record<string, string>;
  /** Golden DB klonu gibi iş başına volume'ler: servis → volume adı. */
  volumes?: Record<string, { volume: string; mountPath: string }>;
  /**
   * İş dizinini taşıyan named volume — `app.image` + `app.workdir` yolunda
   * mount edilir.
   *
   * Eskiden host yoluydu (bind). Worktree Windows NTFS'te durduğu sürece her
   * dosya erişimi 9p katmanından geçiyordu; volume'e taşındı (2026-09-17).
   */
  jobVolume?: string;
  /**
   * Worktree'nin VOLUME İÇİNDEKİ yolu — uygulama burada koşar.
   *
   * Eskiden yalnız repo adıydı ve yol `<workdir>/<repoName>` diye kuruluyordu.
   * Worktree named volume'e taşınınca ağaç `<workdir>/worktrees/<jobId>/<repo>`
   * altına indi; eski varsayım `/workspace/Northwind`yı gösteriyor ve uygulama
   * "The provided file path does not exist: Northwind.Host/Northwind.Host.csproj"
   * ile ölüyordu (yaşandı 2026-09-17). Aynı kusur `runtime.ts`te de vardı.
   */
  worktreePath?: string;
  /**
   * `worktreePath`in köklendiği yer: agent konteynerinde volume'ün bağlandığı
   * yol (`exec.workdir`). Canlı konteynerde AYNI volume `app.workdir`e
   * bağlanıyor; ikisi farklıysa `working_dir` bu kökten ötekine çevrilir.
   */
  execWorkdir?: string;
  /**
   * Sunucunun KENDİ bağlı olduğu Docker ağı (`AHTAPOT_LIVE_NETWORK`).
   *
   * Sunucu konteynerde koşuyorsa yayınlanan portlar host'un `127.0.0.1`ine
   * bağlı ve konteynerin içinden ERİŞİLEMEZ; `host.docker.internal` de
   * loopback'e bağlı porta düşmez. Verilirse uygulama bu ağa da takılır ve
   * sağlık yoklaması iç adresten (`<proje>:<konteyner portu>`) yapılır.
   */
  probeNetwork?: string;
  /**
   * Portların yayınlandığı host adresi (`AHTAPOT_LIVE_HOST`); insana verilen
   * bağlantı da bu adresi taşır. Varsayılan `127.0.0.1`: canlı ortam
   * güvenilmeyen kod koşturur ve yalnız bu makineden açılır.
   *
   * Sunucu uzak bir host'taysa loopback'e yayınlanan porta başka makineden
   * ulaşılamaz — Portainer eşlemeyi gösterir ama `curl 10.x:<port>` anında
   * "Couldn't connect" döner (yaşandı 2026-09-23). O durumda host'un LAN
   * adresi verilir; `0.0.0.0` tüm arayüzlere açar, bağlantıda `127.0.0.1` kalır.
   */
  publishHost?: string;
  /**
   * Build adımlarını başlatma komutunun ÖNÜNE zincirleyen kabuk metni
   * (`buildChain.ts`). Verilirse `command` bunu taşır ve başlatma komutu
   * zincirin sonundadır — ayrı bir `command` üretilmez.
   *
   * Eskiden build agent konteynerinde koşup uygulama AYRI konteynerde
   * kalkıyordu; derleyen ve koşan ortamın aynı olduğu garanti değildi.
   */
  buildChain?: string;
}

/**
 * Worktree'nin CANLI konteynerdeki yolu.
 *
 * YAŞANDI (2026-09-22): `working_dir` olduğu gibi `job.worktreePath` idi, yani
 * agent konteynerinin kökünü (`exec.workdir`) taşıyordu; volume ise canlı
 * konteynerde `app.workdir`e bağlı. Kökler farklı olunca Docker var olmayan
 * `working_dir`i BOŞ yaratıyor, konteyner "Started" görünüyor ama uygulama boş
 * dizinde hiç kalkmıyor ve hazırlık yoklaması zaman aşımına kadar bekliyordu.
 * `working_dir` elle `<app.workdir>/worktrees/<jobId>/<repo>` yapılınca ortam
 * sorunsuz kalktı.
 */
export function liveWorkingDir(worktreePath: string, execWorkdir: string | undefined, liveWorkdir: string): string {
  const norm = (p: string) => p.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  const wt = norm(worktreePath);
  if (!execWorkdir) return wt;
  const from = norm(execWorkdir);
  const to = norm(liveWorkdir);
  if (from === to) return wt;
  if (wt === from) return to;
  const prefix = from === "/" ? "/" : `${from}/`;
  // Kök tutmuyorsa yol bu volume'e göre kurulmamıştır; dokunmadan bırak.
  if (!wt.startsWith(prefix)) return wt;
  return norm(`${to}/${wt.slice(prefix.length)}`);
}

export interface ComposeOutput {
  project: string;
  network: string;
  appService: string;
  /** İnsanın açacağı BİRİNCİL adres — UI varsa o, yoksa uygulama portu. */
  appUrl: string;
  /** Arayüz ayrı bir portta koşuyorsa API adresi (canlı test kartında ikinci bağlantı). */
  apiUrl?: string;
  /**
   * SUNUCUNUN yokladığı taban adres — insanın açtığı `appUrl`den ayrı.
   * `probeNetwork` varsa iç ağ adresi, yoksa yayınlanan host portu.
   */
  healthUrl: string;
  yaml: string;
  publishedPorts?: string[];
}

const DEFAULT_APP_SERVICE = "app";

/**
 * `docker compose` dosyadaki `$VAR`/`${VAR}`ı SUNUCUNUN ortamından çözer —
 * konteynere ulaşmadan. Build zinciri kabuk değişkeni taşıyor (`for d in *; do
 * cd $d …`); `$d` boşa, `$HOME` sunucununkine dönüyordu. `$$` literal `$`tır.
 * Yer tutucular (`$jobId`) bundan ÖNCE çözülmüş olmalı.
 */
function escapeCompose(value: string): string {
  return value.replace(/\$/g, "$$$$");
}

function escapeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, escapeCompose(v)]));
}

export function renderComposeOverride(input: ComposeInput): ComposeOutput {
  const { live, jobId } = input;
  const dependencies = input.dependencies ?? [];
  const appPort = input.hostPorts[0];
  if (appPort === undefined) throw new Error("uygulama için host portu verilmedi");

  const project = composeProject(jobId);
  // İş başına ağ KALMALI: bağımlılıklar `internal` ağda izole. Sabit bir ad
  // (`ahtapot_default`) denendi ve işe yaramadı — `external` olmayan ağa
  // compose proje önekini ekliyor (`ahtapot-<jobId>_ahtapot_default`), yani
  // sunucu yine aynı ağda değildi; üstelik işler arası izolasyonu kaldırıyordu.
  // Sunucuya erişim ayrı `probeNetwork` üzerinden (2026-09-22).
  const network = networkName(jobId);
  // Ölçüldü: `internal: true` ağda yayınlanan port host'tan ERİŞİLEMEZ (Docker
  // 29, Desktop). Uygulama ayrıca dış bir "edge" ağına bağlanır; bağımlılıklar
  // iç ağda kalır. Bedeli: uygulamanın egress'i açık kalır (R3, iptables Linux'ta).
  const edge = `${network}-edge`;
  const appService = live.app.service ?? DEFAULT_APP_SERVICE;
  const bindHost = input.publishHost ?? "127.0.0.1";
  // Joker adres bağlanılabilir bir adres değil; bağlantı ve yoklama loopback'e gider.
  // IPv6 adresi URL'de köşeli parantez ister (`http://[::1]:20046`).
  const connectHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  const urlHost = connectHost.includes(":") ? `[${connectHost}]` : connectHost;

  // YER TUTUCULAR: `$jobId`, `$jobIdShort`, `$jobIdSql` (bkz. shared/placeholders.ts).
  //
  // Dış servisler işler arasında PAYLAŞILIYOR ve izolasyon ad düzeyinde
  // sağlanıyor; Redis `KeyPrefix`i ya da Elastic index öneki profilde sabit
  // yazıldığında iki iş aynı anahtarlara yazıyordu. Bağlantı dizesi zaten
  // orkestratör tarafından üretiliyordu, geri kalan her şey elle yazılıyordu.
  // `extraEnv` de geçer: orkestratörün ürettiği değerler zaten çözülmüştür,
  // ikinci geçiş onlara dokunmaz (çözülmüş metinde yer tutucu kalmaz).
  const env = resolveEnvPlaceholders({ ...(input.appEnv ?? {}), ...(input.extraEnv ?? {}) }, jobId);
  // TEK BOŞLUK: boş dize değişkeni siler (bkz. üst yorum).
  for (const name of live.emptyEnv) env[name] = " ";

  const services: Record<string, unknown> = {};

  // Uygulama ya BUILD edilir ya HAZIR İMAJLA koşar. İkincisinde worktree
  // mount edilir ve `command` repo kökünde çalışır — araç zinciri (SDK, npm)
  // zaten imajın içinde olduğu için ayrı bir image build'i gerekmez.
  const appMounts: string[] = [];
  if (input.volumes?.[appService]) {
    appMounts.push(`${input.volumes[appService]!.volume}:${input.volumes[appService]!.mountPath}`);
  }
  if (live.app.image && live.app.workdir && input.jobVolume) {
    appMounts.push(`${input.jobVolume}:${live.app.workdir}`);
  }

  // Başlatma komutu iki alandan gelebilir. `app.command` hazır imaj yolunun
  // düz metni; `startCommand` ayrıntılı biçim (`cwd`, `env`). İkincisi şemada
  // ve doğrulamada geçerli bir başlatma yolu sayılıyordu ama BURADA HİÇ
  // OKUNMUYORDU: doğrulayıcı hiç kalkmayacak bir profili onaylıyordu.
  const startRun = live.app.command ?? live.startCommand?.run;
  // Zincir verilmişse başlatma komutu onun İÇİNDE (sonunda); ayrıca yazılmaz.
  const runCommand = input.buildChain ?? startRun;

  services[appService] = {
    ...(live.app.build ? { build: { context: live.app.build.context, dockerfile: live.app.build.dockerfile } } : {}),
    ...(live.app.image ? { image: live.app.image } : {}),
    // `sh -lc`: taban imajın ENTRYPOINT'i köprüyü başlatıyor ve komut ona
    // argüman olarak geçerdi (aynı tuzak `golden.ts` ve `docker.ts`te de vardı).
    //
    // Yer tutucular zincirin TAMAMINA uygulanır: build komutları da `$jobId`
    // taşıyabilir (ör. iş başına index öneki).
    ...(runCommand
      ? { entrypoint: ["sh", "-lc"], command: [escapeCompose(resolveJobPlaceholders(runCommand, jobId))] }
      : {}),
    ...(live.app.image && live.app.workdir && input.worktreePath
      ? { working_dir: liveWorkingDir(input.worktreePath, input.execWorkdir, live.app.workdir) }
      : {}),
    environment: escapeEnv(env),
    // Birincil port + profildeki ek portlar (UI gibi). Tek port yayınlanınca
    // insan arayüze ulaşamıyordu (yaşandı: backend 5080, Vite 5173).
    ports: [
      `${bindHost}:${appPort}:${live.app.containerPort}`,
      ...live.app.extraPorts.map((e, i) => `${bindHost}:${input.hostPorts[i + 1]}:${e.containerPort}`),
    ],
    // Takma ad `project`: iş başına tekil ve DNS etiketine sığar (≤63). Servis
    // adı (`app`) paylaşılan ağda her işte aynı olurdu ve çakışırdı.
    networks: input.probeNetwork
      ? { [network]: {}, [edge]: {}, [input.probeNetwork]: { aliases: [project] } }
      : [network, edge],
    ...(appMounts.length > 0 ? { volumes: appMounts } : {}),
    labels: { "ahtapot.job": jobId, "ahtapot.role": "live" },
  };

  for (const dep of dependencies) {
    // DIŞARIDA koşan servise konteyner kurulmaz: yalnız adresi kullanılır.
    // Dev ortamında pg/redis zaten ayakta; iş başına ikincisini kaldırmak
    // boşuna kaynak. İzolasyon ad düzeyinde (ayrı DB / KeyPrefix / index).
    if (dep.externalHost) continue;
    const vol = input.volumes?.[dep.name];
    services[dep.name] = {
      image: dep.image,
      environment: escapeEnv(resolveEnvPlaceholders(dep.env, jobId)),
      networks: [network],
      ...(vol ? { volumes: [`${vol.volume}:${vol.mountPath}`] } : {}),
      ...(dep.healthCmd
        ? { healthcheck: { test: ["CMD-SHELL", dep.healthCmd], interval: "5s", timeout: "5s", retries: 24 } }
        : {}),
      labels: { "ahtapot.job": jobId, "ahtapot.role": "live-dep", "ahtapot.optional": String(dep.optional) },
    };
  }

  // Uygulama, sağlıklı bağımlılıkları bekler; isteğe bağlı olanlar yalnız "başladı" ister.
  // `depends_on` YALNIZ compose'un kurduğu servisler için geçerli: dışarıdaki
  // bir servisi burada saymak "undefined service" ile compose'u düşürür.
  const managed = dependencies.filter((d) => !d.externalHost);
  const required = managed.filter((d) => !d.optional);
  if (managed.length > 0) {
    (services[appService] as Record<string, unknown>)["depends_on"] = Object.fromEntries(
      managed.map((d) => [
        d.name,
        { condition: d.healthCmd && required.includes(d) ? "service_healthy" : "service_started" },
      ]),
    );
  }
  // Dış servis varsa uygulama host'a çıkabilmeli.
  if (managed.length !== dependencies.length) {
    (services[appService] as Record<string, unknown>)["extra_hosts"] = ["host.docker.internal:host-gateway"];
  }

  const doc = {
    name: project,
    services,
    networks: {
      // `internal`: bağımlılıkların dış ağa çıkışı yok. Uygulamanın port yayını edge üzerinden.
      [network]: { internal: !live.allowEgress },
      [edge]: {},
      // `external`: sunucunun ağı compose'un DEĞİL; `down` onu silmemeli ve
      // ada proje öneki eklenmemeli.
      ...(input.probeNetwork ? { [input.probeNetwork]: { external: true, name: input.probeNetwork } } : {}),
    },
    // İş volume'ü ve golden/şablon klonları compose DIŞINDA yaratılır; hepsi
    // `external`. Bildirilmezse compose proje önekiyle YENİ bir volume yaratır
    // ve uygulama boş bir dizin görür.
    ...(() => {
      const vols: Record<string, { external: true }> = {};
      if (input.jobVolume && live.app.image && live.app.workdir) vols[input.jobVolume] = { external: true };
      for (const v of Object.values(input.volumes ?? {})) vols[v.volume] = { external: true };
      return Object.keys(vols).length > 0 ? { volumes: vols } : {};
    })(),
  };

  // `primary` işaretli ek port varsa insan ONA yönlendirilir: Northwind'de
  // arayüz Vite'ta (5173), backend ayrı portta (5080) ve operatörün açmak
  // istediği ekrandır. API adresi ikinci bağlantı olarak taşınır.
  //
  // `appUrl`/`apiUrl` İNSAN içindir ve host portunu gösterir; Traefik de
  // portu buradan okur. İç ağ adresi buraya yazılınca UI bağlantısı ve
  // Traefik yönlendirmesi konteyner portuna gidiyordu (yaşandı 2026-09-22).
  const primaryIdx = live.app.extraPorts.findIndex((e) => e.primary);
  const uiPort = primaryIdx >= 0 ? input.hostPorts[primaryIdx + 1] : undefined;

  // Konteyner portu → host portu. Yalnız yayınlanan portlar yoklanabilir.
  const published = new Map<number, number>([[live.app.containerPort, appPort]]);
  live.app.extraPorts.forEach((e, i) => {
    const hp = input.hostPorts[i + 1];
    if (hp !== undefined && !published.has(e.containerPort)) published.set(e.containerPort, hp);
  });
  const probePort = live.healthcheck.port
    ?? (primaryIdx >= 0 ? live.app.extraPorts[primaryIdx]!.containerPort : live.app.containerPort);
  const probeHostPort = published.get(probePort);
  if (probeHostPort === undefined) {
    throw new Error(
      `healthcheck.port ${probePort} yayınlanan portlardan biri değil (${[...published.keys()].join(", ")}) — app.containerPort ya da app.extraPorts içinden seçilmeli`,
    );
  }
  const healthUrl = input.probeNetwork
    ? `http://${project}:${probePort}`
    : `http://${urlHost}:${probeHostPort}`;

  return {
    project,
    network,
    appService,
    appUrl: `http://${urlHost}:${uiPort ?? appPort}`,
    ...(uiPort ? { apiUrl: `http://${urlHost}:${appPort}` } : {}),
    healthUrl,
    publishedPorts: [`${appPort}`, ...input.hostPorts.slice(1).map((p) => `${p}`)],
    yaml: stringify(doc, { lineWidth: 0 }),
  };
}
