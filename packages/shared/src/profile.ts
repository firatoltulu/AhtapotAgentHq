import { z } from "zod";

import { AgentRoleNameSchema, ModelTierSchema } from "./job.js";

/**
 * Proje profili — motorun hedef projeyi nasıl ele alacağının TEK sözleşmesi.
 *
 * Temel ilke: MOTOR YETENEK SUNAR, PROFİL HANGİSİNİN GEÇERLİ OLDUĞUNU SÖYLER.
 * Bir projenin çalışma disiplini (safha onayı, commit politikası, review'ın dış
 * süreç olması) motora gömülmez — buraya girer.
 *
 * Profili Analyst agent üretir, insan onaylar. Elle de yazılabilir.
 */

// ── Ortak ────────────────────────────────────────────────────────────────────

/** Glob deseni. Boş dize kabul edilmez — sessizce "her şey" anlamına gelmesin. */
const Glob = z.string().min(1);

/**
 * Docker image referansı — `[registry/]repo[:tag|@digest]`.
 *
 * YAŞANDI (2026-09-19): Analyst `exec.image`e gerçek bir image tag'i yerine
 * insan-okunur bir açıklama yazdı ("mcr.microsoft.com/dotnet/sdk:10.0 + Node
 * 22 (LTS)") ve `z.string().min(1)` bunu geçirdi — hata iş koşarken Docker'ın
 * "invalid reference format" (400) demesiyle ortaya çıktı, profil onay
 * ekranında hiç yakalanmadı. Regex tam OCI referans grameri değil (o çok
 * karmaşık), ama boşluk/parantez/artı gibi düz metin işaretlerini eler —
 * asıl amaç "bu bir cümle değil" testi.
 */
const DockerImageRef = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/,
    "geçerli bir Docker image referansı değil (örn. mcr.microsoft.com/dotnet/sdk:10.0) — açıklama metni değil, tam tag gerekli",
  );

/** Kabuk komutu + nerede koşacağı. */
export const CommandSchema = z.object({
  /** İnsan okur ad; log ve UI'da görünür. */
  name: z.string().min(1),
  run: z.string().min(1),
  /** Workspace köküne göreli. Varsayılan: kök. */
  cwd: z.string().default("."),
  timeoutMinutes: z.number().int().positive().default(20),
  /** Başarısızlığı işi durdurmaz, yalnız uyarı düşer. */
  optional: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
});
export type Command = z.infer<typeof CommandSchema>;

// ── workspace ────────────────────────────────────────────────────────────────

export const RepoSchema = z.object({
  name: z.string().min(1),
  /** Workspace köküne göreli yol. Tek repolu projede ".". */
  path: z.string().min(1),
  remote: z.string().optional(),
  /**
   * SABİT VARSAYMA. Northwind=main, AdventureWorks=master — projeden projeye değişir,
   * hatta aynı workspace içinde repodan repoya değişir.
   */
  defaultBranch: z.string().min(1),
  /** PR bu repoda açılır. Tam olarak bir repo primary olmalı. */
  primary: z.boolean().default(false),
});

export const WorkspaceSchema = z.object({
  root: z.string().min(1),
  /** Workspace kökü git reposu mu? Contoso'da DEĞİL, Northwind'de evet. */
  rootIsRepo: z.boolean(),
  repos: z.array(RepoSchema).min(1),
  /** Dinamik repo keşfi (Contoso: "Modules/*", "Plugins/*"). */
  repoGlobs: z.array(Glob).default([]),

  /**
   * Gitignore'lu AMA GEREKLİ içerik — `git worktree add` bunları taşımaz.
   * Northwind'de plans/, docs/, handoff/: agent'ın plan bağlamı burada.
   * Worktree hazırlanırken kaynak workspace'ten KOPYALANIR.
   */
  ignoredButNeeded: z.array(Glob).default([]),

  /**
   * SALT OKUNUR referans depolar — worktree'ye girmez, PR açılmaz, yazılmaz.
   *
   * Northwind'e "Contoso'daki Collection gibi" bir iş verildiğinde Planner'ın
   * kaynağı okuması gerekir. Host yolu YOK: konteyner host'un rastgele bir
   * dizinini göremez (yalnız `sourceRoot`/`resourcesRoot` açıkça bağlanır).
   * Bu yüzden kaynak `gitUrl`dür ve konteyner AYAĞA KALKARKEN kendi diskine
   * klonlanır — `cloneWorkspace()` ile aynı akış, kimlik de aynı GH kimliği
   * (`resolveToken()`). Konteyner içi yol sabit türetilir: `/references/<name>`.
   */
  referenceRepos: z.array(z.object({
    name: z.string().min(1),
    gitUrl: z.string().min(1),
    /** Agent'a ne için bakacağını söyler: "AdventureWorks kaynak sistemi". */
    note: z.string().default(""),
    /**
     * Arama bu alt dizinlerle sınırlanır. Ölçüldü (2026-09-14): Contoso
     * kökünde `Glob` 20 sn'de zaman aşımına uğruyor, Planner kendi kendine
     * `Grep`'e geçmek zorunda kaldı. Dar kapsam turu hızlandırır.
     */
    searchPaths: z.array(z.string()).default([]),
  })).default([]),
});

/**
 * Özel paket kaynağı kimliği (npm registry'si ya da NuGet feed'i).
 *
 * TOKEN PROFİLE YAZILMAZ. Profil DB'de saklanır ve UI'da gösterilir (kural 4);
 * buraya yalnız token'ın okunacağı SUNUCU ortam değişkeninin ADI girer. Değer
 * her `exec`te ayrıca verilir, `process.env`e yazılmaz (kural 5).
 *
 * Tek şekil, iki tür: ayrı şemalar form editörünü (şemadan otomatik çizilir)
 * ve eski profilleri karmaşıklaştırırdı. Türe özel zorunluluklar `superRefine`da.
 */
export const PackageSourceSchema = z.object({
  /** `npm` varsayılan: alan eklenmeden önce yazılmış kayıtlar bozulmasın. */
  kind: z.enum(["npm", "nuget"]).default("npm"),
  /** npm: `@sirketim`. Boşsa bu registry varsayılan olur. NuGet'te kullanılmaz. */
  scope: z.string().regex(/^@[a-z0-9][a-z0-9._~-]*$/, "scope '@ad' biçiminde olmalı").optional(),
  /** npm: registry adresi (zorunlu). NuGet: yalnız bilgi — kaynak repodaki nuget.config'ten gelir. */
  url: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * NuGet: reponun `nuget.config`indeki `<add key="...">` ADI (zorunlu).
   * Kimlik `NuGetPackageSourceCredentials_<ad>` ortam değişkeniyle verilir;
   * kaynağın kendisi repoda tanımlı olmalı — motor nuget.config'e dokunmaz.
   */
  source: z.string().regex(/^[A-Za-z0-9_]+$/, "yalnız harf, rakam ve _ (ortam değişkeni adına girer)").optional(),
  /** NuGet: kullanıcı adı. Azure Artifacts gibi kaynaklarda herhangi bir dize olur. */
  username: z.string().min(1).regex(/^[^;]+$/, "';' içeremez (NuGet kimlik değerinde ayırıcı)").default("token"),
  /** Sunucuda token'ı taşıyan ortam değişkeni (örn. `NPM_TOKEN_SIRKET`). */
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "BÜYÜK_HARF ortam değişkeni adı olmalı"),
}).superRefine((v, ctx) => {
  if (v.kind === "npm" && !v.url) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "npm için registry adresi (url) gerekli" });
  }
  if (v.kind === "nuget" && !v.source) {
    ctx.addIssue({ code: "custom", path: ["source"], message: "NuGet için nuget.config kaynak adı (source) gerekli" });
  }
});

// ── exec (agent konteyneri) ──────────────────────────────────────────────────

export const ExecSchema = z.object({
  image: DockerImageRef,
  /**
   * İmajın tarifi — AhtapotAgent'ın KENDİ artifact deposundaki MUTLAK yol
   * (`<artifactsDir>/<projectId>/docker/Dockerfile`). Workspace'e göreli yol
   * DEĞİL ve asla hedef reponun içinde yaşamaz.
   *
   * Motor-üretimi bir yapı eseri hiçbir zaman bağlı olduğu YABANCI git
   * reposuna karışmaz — aynı kuralın ters yönü daha önce
   * `docker/northwind/Dockerfile`ın ENGINE reposundan silinmesine yol açmıştı
   * (o dosya tek bir projeye özeldi, motora ait olmamalıydı); burada motor
   * kendi ürettiği Dockerfile'ı yabancı workspace'e YAZMAKTAN kaçınıyor —
   * simetrik gerekçe.
   *
   * Dosyayı Analyst değil SUNUCU yazar: analiz sırasında agent `DOCKERFILE`
   * ham metin bloğu üretir, `analyst.ts` onu doğrulayıp
   * `dockerfileAbsPath(artifactsDir, projectId)`e yazar ve bu alanı o mutlak
   * yola set eder. Böylece Analyst salt-okunur kalır.
   *
   * Alan doluysa profil onaylandığında imaj OTOMATİK build edilir (imaj zaten
   * varsa build edilmez). Boşsa ve imaj da yoksa onay reddedilir — imajı
   * olmayan bir profille koşan iş saatler sonra "image not found" ile düşerdi.
   */
  dockerfile: z.string().optional(),
  workdir: z.string().default("/workspace"),
  resources: z.object({
    memory: z.string().default("8g"),
    cpus: z.string().default("4"),
    pidsLimit: z.number().int().positive().default(2048),
  }).prefault({}),
  /** Paylaşımlı paket cache'leri — MOUNT edilir, kopyalanmaz. */
  caches: z.array(z.object({
    volume: z.string().min(1),
    mountPath: z.string().min(1),
  })).default([]),
  /**
   * BIND-MOUNT'TA YAŞAMAMASI gereken dizinler — konteyner diskinde kurulup
   * worktree'ye symlink'lenir.
   *
   * ÖLÇÜLDÜ (2026-09-15, Windows): bind-mount üzerinde `npm ci` paketleri
   * eksik açıyor ve bunu HATA SAYMIYOR — `TAR_ENTRY_ERROR` uyarısı basıp
   * "added 159 packages" diyor, çıkış 0 dönüyor. Sonra build `tsc: not found`
   * ya da TS6053 ile düşüyor. Aynı iş konteyner diskinde 10 sn'de ve DOĞRU
   * bitiyor (21 girdi → 70 girdi, `.bin/tsc` beliriyor).
   *
   * GitHub Actions deseni: bağımlılık runner'ın kendi diskinde kurulur,
   * checkout ayrı yerde durur. `keyFile` lock dosyasıdır; içeriği değişmediği
   * sürece kurulum işler arasında PAYLAŞILIR, değişince yeni anahtar doğar.
   *
   * Hangi dizinlerin böyle olduğunu PROFİL söyler — motor `node_modules`
   * bilmez. Bu alanı boş bırakan projede hiçbir şey olmaz.
   */
  scratchDirs: z.array(z.object({
    /** Worktree köküne göreli; glob olabilir ("Partials/*\/wwwroot/node_modules"). */
    path: Glob,
    /**
     * Paylaşım anahtarını üreten dosya — `path`in ÜST dizinine göreli
     * ("package-lock.json"). Yoksa ya da bulunamazsa dizin işe özel olur.
     */
    keyFile: z.string().default(""),
  })).default([]),
  /**
   * Scratch dizinlerinin konteyner diskine taşınmasına tanınan süre (dakika).
   *
   * Kurulum bittikten sonra sonuç bind-mount'tan konteyner diskine kopyalanır;
   * bir sonraki koşu onu hazır bulsun diye. Bu kopyalama BÜYÜK: Northwind'de on
   * dizin ~600 MB ve Windows bind-mount'unda 15 dakikaya sığmadı — zaman aşımı
   * kesince yalnız iki dizin taşınabildi, kalan sekizi her koşuda baştan kuruldu
   * ve ilk sıradaki iki modül eksik kalıp build'i kırdı (Sevkiyat işi,
   * 2026-09-16).
   *
   * Süre PROJEYE bağlıdır — dizin sayısı, boyut ve dosya sisteminin hızı. Bu
   * yüzden motorda sabit değil, profilde. Aşılırsa iş DURMAZ: kurulum zaten
   * doğru bitmiştir, yalnız sonraki koşu yine kurar.
   */
  scratchStashMinutes: z.number().int().positive().default(15),
  /**
   * ORTAM HAZIRLIĞI — bağımlılık kurulumu. GitHub Actions'taki `npm ci`
   * adımının karşılığı: derlemeden ÖNCE, bir kez.
   *
   * `build.preSteps`ten farkı ne zaman koştuğu: preSteps HER build'de koşar
   * (safha başına), setup ise iş boyunca BİR KEZ — bağımlılıklar değişmediği
   * sürece. Ayrımın bedeli ölçüldü:
   *
   *  - Kurulum her safhada tekrarlanıyordu; bind-mount'ta modül başına 103-280 s.
   *  - Kurulum eksik kalınca Developer bunu "benim düzeltmem gereken bir build
   *    hatası" sanıp altı modülün `npm ci`'sini elle koşturdu; tur 5 dakikalık
   *    sessizlik gözcüsüne takılıp düştü (Sevkiyat işi, 2026-09-16).
   *
   * Kurulum agent'ın işi DEĞİLDİR: orkestratör hazırlar, agent kod yazar.
   * Buradaki adım kırmızı dönerse iş `NeedsAttention`'a gider — Developer'a
   * "düzelt" diye geri verilmez, çünkü düzeltecek şey kodda değildir.
   */
  setup: z.array(CommandSchema).default([]),
  /**
   * Özel paket kaynakları (npm registry'si, NuGet feed'i). Kurulum (`setup`),
   * build ve test komutlarının HEPSİ kimliği görür — `npm ci` tek başına değil,
   * `preSteps`teki `dotnet restore` da aynı feed'e gider. Bkz. kararlar §23.
   */
  registries: z.array(PackageSourceSchema).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Konteynerin çıkabildiği TEK adresler. Boşsa egress kapalı. */
  egressAllowlist: z.array(z.string()).default([]),
});

// ── build ────────────────────────────────────────────────────────────────────

/**
 * Koşullu derleme — "DERLEME YALNIZCA DOKUNULAN KATMANDA".
 *
 * Northwind'de ölçülmüş: yalnız .tsx değişmişken `dotnet build` koşmak sıfır bilgi
 * verir AMA host çalışırken DLL kilidine takılıp (MSB3027) VAR OLMAYAN BİR HATA
 * üretir.
 *
 * exceptPaths: kaynak metnini OKUYAN sözleşme testleri. Bir .tsx değişikliği
 * böyle bir testin okuduğu dosyaya dokunuyorsa o adım YİNE koşmalı.
 * Ölçüt "hangi dilde yazdım" değil, "bu dosyayı okuyan bir test var mı".
 */
export const BuildStepSchema = CommandSchema.extend({
  /** Bu desenlerden biri değiştiyse adım koşar. Boşsa her zaman koşar. */
  whenChanged: z.array(Glob).default([]),
  /** whenChanged tutmasa da bu desenler değiştiyse adım yine koşar. */
  exceptPaths: z.array(Glob).default([]),
});

export const BuildSchema = z.object({
  /**
   * Build'den ÖNCE koşan hazırlık adımları. Northwind'de ikisi de zorunlu:
   *  1. appsettings.json şablondan kopyalanır (yoksa MSB3030 ile düşer)
   *  2. çalışan host durdurulur (DLL kilidi)
   */
  preSteps: z.array(CommandSchema).default([]),
  /**
   * SIRA BAĞLAYICIDIR. Northwind: npm-modüller → npm-kabuk → dotnet.
   * Ters sırada `dotnet publish` BAŞARILI olur ama panel sessizce ekransız açılır —
   * en pahalı hata sınıfı, çünkü yeşil görünür.
   */
  steps: z.array(BuildStepSchema).min(1),
  /**
   * Asla kullanılmayacak bayraklar; komutta geçerse iş reddedilir.
   * Northwind: "-c Release" (private NuGet → secret'sız 401),
   *         "-warnaserror" (1047 devralınmış uyarı).
   */
  forbiddenFlags: z.array(z.string()).default([]),
  /** Kırmızı build'de ilerleme YOK. */
  failureIsBlocking: z.boolean().default(true),
  /**
   * Build NE ZAMAN koşar?
   *
   *  • `each-phase` (varsayılan): her safha sonunda. Kırmızı build o safhanın
   *    Developer'ına `<feedback>` ile döner — hata doğduğu yerde yakalanır.
   *  • `final-phase`: safhalar build'siz ilerler; build YALNIZ son safhadan
   *    sonra koşar.
   *
   * `final-phase` bir TAKAS. Northwind'de `npm build: modüller` tek başına ~27 dk
   * (ölçüldü 2026-09-17: üç ayrı işte 1634 / 1566 / 1550 s) ve safhaların çoğu
   * ön yüze hiç dokunmuyor — 19 safhalı bir iş yalnızca build'e ~7,5 saat
   * harcıyordu. Bedeli: derleme hatası doğduğu safhada değil EN SONDA çıkar,
   * hangi safhanın bozduğu belirsizleşir ve geri bildirim son safhaya yazılır.
   */
  when: z.enum(["each-phase", "final-phase"]).default("each-phase"),
});

// ── services (canlı ortam ve testlerin ortak servisleri) ─────────────────────

/**
 * Projenin dış bağımlılığı — Postgres, Redis, Elasticsearch…
 *
 * TEK YERDE tanımlanır; canlı ortam (`live.services`) ve test takımları
 * (`test.suites[].services`) ADIYLA başvurur. Eskiden aynı Postgres iki kez
 * yazılıyordu (`live.dependencies` ve takımın kendi `services` listesi) ve
 * ikisi ayrışmıştı: canlı ortam `192.168.1.30`a bağlanırken entegrasyon
 * takımı compose adına (`Host=postgres`) bağlanmaya çalışıyor, hiç koşmuyordu
 * (Northwind, 2026-10-13). Bkz. kararlar §37.
 */
export const ServiceSchema = z.object({
  name: z.string().min(1),
  image: DockerImageRef,
  internalPort: z.number().int().positive(),
  /** Yer tutucular geçerli (bkz. `appEnv`). */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * Port açıldı değil hazır DEĞİL. Postgres soketi başlatma betikleri bitmeden
   * açar; o aralıkta her bağlantı reddedilir → pg_isready gibi gerçek bir ölçüm şart.
   */
  healthCmd: z.string().optional(),
  /** Yoksa canlı uygulama yine kalkar (yalnız uyarı). */
  optional: z.boolean().default(false),
  /**
   * Veri dizini (ör. Postgres `/var/lib/postgresql/data`). Konteynerdeki
   * Postgres'te şablon DB proje ömürlü volume'de bu yolda yaşar.
   */
  dataPath: z.string().optional(),
  /**
   * Servis DIŞARIDA zaten koşuyorsa adresi. Verildiğinde KONTEYNER KURULMAZ;
   * `image`/`dataPath` yalnız belge olarak kalır.
   *
   * Dev ortamında pg/redis zaten ayakta (ölçüldü 2026-09-17): iş başına
   * ikinci bir Postgres kaldırmak boşuna bellek ve disk. İzolasyon konteyner
   * düzeyinde değil AD düzeyinde sağlanıyor — ayrı DB adı, ayrı Redis
   * `KeyPrefix`, ayrı Elastic index öneki.
   *
   * `host.docker.internal` konteynerden host'a çıkar (`extra_hosts`
   * host-gateway ile).
   */
  externalHost: z.string().min(1).optional(),
  /** Dış servisin host tarafındaki portu. `externalHost` ile verilir. */
  externalPort: z.number().int().positive().optional(),
});

// ── test ─────────────────────────────────────────────────────────────────────

/**
 * Test takımı. DevAgent'ın tek "denylist" modelinden farkı: Northwind'de konteynerde
 * KOŞAMAYAN test yok — AYRI ALTYAPI isteyen test var. İkisi farklı şey.
 */
export const TestSuiteSchema = z.object({
  id: z.string().min(1),
  command: CommandSchema,
  /**
   * Gereken servisler — üst düzey `services[].name`. Boşsa bağımlılıksız
   * (Northwind birim testleri: in-memory SQLite).
   *
   * Motor her servisin adresini komuta `AHTAPOT_SVC_<AD>_HOST` /
   * `AHTAPOT_SVC_<AD>_PORT` olarak verir (ad büyük harf, harf/rakam dışı `_`).
   *
   * Dış servise (`externalHost`) doğrudan bağlanılır. Konteyner servisi koşu
   * başına ayrı bir ağda, canlıdakiyle AYNI adla ve BOŞ kalkar; agent
   * konteyneri o ağa bağlanır, koşu bitince hepsi yıkılır. Kurulamayan
   * servis ya da tanımsız bir ad takımı KIRMIZI yapar: eskiden
   * böyle takım "atlandı" diye `failed: 0` dönüyor ve kapıdan YEŞİL geçiyordu
   * (2026-09-17, "3456/3472 geçti" yazarken entegrasyon hiç koşmamıştı).
   */
  services: z.array(z.string().min(1)).default([]),
  /**
   * Takım her koşuda şablondan TAZE bir DB klonu alsın mı (`database.clone`).
   *
   * Bağlantı dizesi `appEnv`deki `$dbCloneConnectionString` yer tutucusuyla
   * komuta verilir; komut DB adresini kendisi yazmamalı. Baseline
   * ve gerçek koşu AYRI klon alır — biri ötekinin verisini görmesin. Klon
   * koşu bitince düşürülür.
   *
   * Şablon tohumlu geldiği için `--install=true` gibi bir kurulum ön adımı
   * genelde gereksizdir.
   */
  cloneDb: z.boolean().default(false),
  /**
   * Testlerden önce koşan zorunlu adımlar. Northwind entegrasyonunda şema+tohum kurulumu:
   * ATLANIRSA izin tablosu boş kalır, her uç 403 döner ve izolasyon testleri
   * "çalışıyor" diye YANLIŞ YÖNDE geçer.
   */
  preSteps: z.array(CommandSchema).default([]),
  /** Hangi aşamada koşar. Safha sonunda genelde hiçbiri (yalnız derleme). */
  runAt: z.enum(["phase", "qa", "manual"]).default("qa"),
  /**
   * Sonuç nasıl okunur? `exitcode`: yalnız çıkış kodu (sayı yok). `trx`:
   * `dotnet test --logger trx` dosyası (path: worktree'ye göreli glob).
   * `junit`: JUnit XML (vitest/jest/pytest raporları).
   */
  report: z.object({
    format: z.enum(["exitcode", "trx", "junit"]).default("exitcode"),
    path: z.string().optional(),
  }).prefault({}),
  denylisted: z.boolean().default(false),
  reason: z.string().default(""),
});

export const TestSchema = z.object({
  suites: z.array(TestSuiteSchema).default([]),
  /**
   * Testlerden önce `git stash` ile önceden-kırık testleri ölç.
   * Orkestratör yapar, agent DEĞİL — üretici taraf güvenilmez.
   */
  baseline: z.boolean().default(true),
  /** QA case listesini insana onaylat (Northwind: test case'leri kullanıcıdan sorulur). */
  caseApproval: z.boolean().default(true),
});

// ── live (canlı test ortamı) ─────────────────────────────────────────────────

/**
 * DAST adımı — canlı ortamın İÇ ağında, ayrı bir konteynerde koşan tarayıcı.
 *
 * İç ağda, çünkü canlı ağ `internal` (`allowEgress:false`): tarayıcı yalnız
 * uygulamayı görür, dışarı saldıramaz. İmaj önceden sunucu tarafından çekilir.
 * Ortam: `TARGET_URL` (uygulamanın iç adresi), `OUT` (adımlar arası ortak
 * dizin — ör. ilk adım token'ı `$OUT/token`a yazar, sonrakiler okur).
 */
export const DastStepSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "küçük harf, rakam ve tire"),
  /** Kapalı adım profilde durur, koşmaz. */
  enabled: z.boolean().default(true),
  image: z.string().min(1),
  /** `sh -c` ile koşar; imajın entrypoint'i ezilir. */
  run: z.string().min(1),
  /** Raporsuz adım hazırlıktır (ör. token alma); düşerse sonrakiler yine koşar. */
  report: z.object({
    /**
     * `zap-json`: ZAP `-J` raporu (`riskcode` 3/2/1/0).
     * `junit`: Schemathesis `--report junit`; her kırık testcase bir bulgu.
     * `sarif`: SARIF 2.1 (error/warning/note → high/medium/low).
     */
    format: z.enum(["zap-json", "junit", "sarif"]),
    /** `$OUT`a göreli dosya adı (ör. `zap.json`). */
    file: z.string().min(1).regex(/^[^/]/, "OUT'a göreli olmalı"),
  }).optional(),
  /** JUnit kırıklarının riski — biçim risk taşımıyor. */
  failureRisk: z.enum(["high", "medium", "low"]).default("medium"),
  timeoutMinutes: z.number().int().positive().default(15),
});

export type DastStep = z.infer<typeof DastStepSchema>;

/**
 * DAST kapsamı — tarayıcı TÜM uygulamaya değil, dalın değiştirdiği uçlara
 * saldırsın. Tarif değişmeden her işte aynı uçları taramak, işin eklediği
 * ucu gece taramasından farksız bırakıyordu (yaşandı).
 *
 * Uçları motor çıkarır, agent DEĞİL (kural 3): tabana göre değişen
 * dosyalarda `routePattern` aranır. Rota tanımının biçimi projenin tercihi
 * (FastEndpoints `Get("/x")`, Express `router.get("/x")` …) — motor yalnız
 * regex'i uygular.
 *
 * Adıma giden ortam: `DAST_SCOPE` (`branch`|`full`), `TARGET_PATHS` (satır
 * başına bir yol), `TARGET_PATH_REGEX` (yolların çapalı birleşimi; `{id}`
 * → `[^/]+`, Schemathesis `--include-path-regex` için), `$OUT/targets.txt`
 * ve `$OUT/changed-files.txt`. Tam taramada yol değişkenleri boştur.
 */
export const DastScopeSchema = z.object({
  mode: z.enum(["branch", "full"]).default("branch"),
  /** Rota aranacak değişen dosyalar (glob). Boş = değişen her dosya. */
  files: z.array(z.string().min(1)).default([]),
  /** Rota yolunu yakalayan regex; 1. grup yol, grup yoksa eşleşmenin tamamı. */
  routePattern: z.string().optional(),
  /** Yolların önüne eklenir (ör. FastEndpoints `RoutePrefix = "api"`). */
  routePrefix: z.string().default(""),
  /**
   * Dalda uç bulunamazsa: `full` tüm uygulamayı tarar (eski davranış),
   * `skip` DAST'ı koşturmaz — ör. yalnız arayüz değiştiyse.
   */
  whenEmpty: z.enum(["full", "skip"]).default("full"),
}).superRefine((v, ctx) => {
  if (v.routePattern === undefined) return;
  try {
    new RegExp(v.routePattern, "g");
  } catch (err) {
    ctx.addIssue({ code: "custom", path: ["routePattern"], message: `geçersiz regex: ${err instanceof Error ? err.message : String(err)}` });
  }
}).prefault({});

export type DastScope = z.infer<typeof DastScopeSchema>;

/**
 * Canlı ortam hazır olunca, `live_test` kapısı açılmadan ÖNCE koşan DAST.
 *
 * Canlı ortam yalnız LiveTest'te ayakta; DAST başka bir yerde ortamı ikinci
 * kez kaldırmak demekti. Northwind gece taramasındaki tarifi (ZAP baseline +
 * Schemathesis) PR'dan önce uygular. Ön filtre: tarayıcı düşerse kapı yine açılır.
 */
export const DastSchema = z.object({
  enabled: z.boolean().default(false),
  steps: z.array(DastStepSchema).default([]),
  scope: DastScopeSchema,
  /** Bu riskten itibaren bulgu "engelleyici" sayılır: kapıda vurgulanır, `autoFix`te Developer'a gider. */
  minRisk: z.enum(["high", "medium", "low"]).default("high"),
  /**
   * Açık: eşik üstü bulgu varsa kapı AÇILMADAN düzeltme safhası açılır
   * (`limits.maxLoops.live` tavanına sayılır; tavanda kapı açılır, insan karar
   * verir). Kapalı: bulgular kapıda; insan reddederse geri bildirime eklenir.
   *
   * Varsayılan kapalı: Northwind'de DAST bugün yalnız rapor — gürültü ölçülmeden
   * Developer'ı turlara sokmak bütçe yakar.
   */
  autoFix: z.boolean().default(false),
}).superRefine((v, ctx) => {
  const ids = new Set<string>();
  v.steps.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `"${s.id}" tekrarlanıyor` });
    ids.add(s.id);
  });
  if (v.enabled && !v.steps.some((s) => s.enabled && s.report)) {
    ctx.addIssue({ code: "custom", path: ["steps"], message: "DAST açıkken raporlu en az bir adım açık olmalı" });
  }
}).prefault({});

export type Dast = z.infer<typeof DastSchema>;

/**
 * Rol bazlı test hesabı. Aynı uygulamada yetkisi farklı kullanıcılar olur;
 * senaryonun hangi hesapla koşacağını bilmeden yetki farkı doğrulanamaz.
 * `tester` yalnız `role` ve `description`ı görür ve senaryonun `account`ına
 * rolü yazar; tarayıcı turunda ayrıca sırların ADLARI verilir.
 */
export const TestAccountSchema = z.object({
  /** Senaryodaki `account` buna birebir eşlenir: "yönetici", "bayi" … */
  role: z.string().trim().min(1),
  /** Hesabın ne yapabildiği — tester rol seçimini buna göre yapar. */
  description: z.string().default(""),
  /** Sır adı → değer (ör. `ADMIN_USER`, `ADMIN_PASSWORD`). */
  credentials: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "BÜYÜK_HARF ad"), z.string()).default({}),
});

export type TestAccount = z.infer<typeof TestAccountSchema>;

/**
 * Canlı testte tarayıcı turu (karar §41): `tester` senaryoları çıkarır,
 * aynı oturumda Playwright MCP ile yürütür ve checklist'i ön işaretler.
 * Kapı değil, ön filtre: düşerse kapı yine açılır, karar insanındır.
 */
export const BrowserTestSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Hangi senaryolar koşar. `pending`: işaretsiz, `retest` ve agent'ın eski
   * turdan kalan işaretleri — insanın koyduğu işaret yeniden koşmaz.
   * `high`: `pending`in yalnız yüksek öncelikli olanları.
   */
  scope: z.enum(["pending", "all", "high"]).default("pending"),
  /**
   * Tarayıcının açacağı adres — normalde BOŞ bırakılır: motor canlı test
   * adımında insana verilen adresi kullanır (yalnız o adres loopback'teyse
   * uygulamanın iç ağ adresine düşer). Yalnız olağandışı bir giriş noktası
   * gerekiyorsa verilir. `$jobId` yer tutucuları geçerli.
   */
  baseUrl: z.string().default(""),
  maxTurns: z.number().int().positive().default(150),
  timeoutMinutes: z.number().int().positive().default(30),
  /**
   * Agent turu sonuç bloğu yazmadan bitirirse insanı bu kadar bekler, sonra
   * "varsayımınla devam et" diye dürtülür; dürtmeden sonra yine bloksuzsa
   * aynı süre sonunda kanal kapanır ve blok ayrıca istenir.
   *
   * `limits.askTimeoutMinutes` (30) burada kullanılmıyor: o süre testin
   * kendi tavanına (`timeoutMinutes`, 30) eşitti ve dürtme hiç gidemeden
   * test kesiliyordu — tek snapshot'tan sonra 30 dk sessizlik (yaşandı,
   * 2026-10-17). Tarayıcı turu gözetimsiz bir koşu; insan sohbeti istisna.
   */
  idleMinutes: z.number().int().positive().default(3),
  viewport: z.string().regex(/^\d{3,4}x\d{3,4}$/, "GENİŞLİKxYÜKSEKLİK olmalı").default("1440x900"),
  /** `screenshot`: agent senaryo başına kanıt görüntüsü bırakır. */
  evidence: z.enum(["screenshot", "none"]).default("screenshot"),
  /**
   * Developer'a verilen kararlı kimlik özniteliği (`id`, `data-testid` …).
   * Boşsa Developer'a seçici kuralı eklenmez.
   */
  selectorAttribute: z.string().regex(/^[a-zA-Z][\w-]*$/).or(z.literal("")).default("id"),
  /**
   * Test hesapları. Agent yalnız sır ADLARINI görür ve alana adı yazar; değeri
   * Playwright MCP koyar ve yanıtlarda maskeler (`--secrets`). Değerler ayrıca
   * `scrubSecrets`e kayıtlı değer olarak eklenir (kural 4). Tüm hesapların
   * sırları tek dotenv'e gider: ad hesaplar arasında tekil olmalı.
   */
  accounts: z.array(TestAccountSchema).default([]),
}).superRefine((v, ctx) => {
  const roles = new Set<string>();
  const names = new Set<string>();
  v.accounts.forEach((a, i) => {
    if (roles.has(a.role)) ctx.addIssue({ code: "custom", path: ["accounts", i, "role"], message: `"${a.role}" rolü tekrarlanıyor` });
    roles.add(a.role);
    for (const n of Object.keys(a.credentials)) {
      if (names.has(n)) ctx.addIssue({ code: "custom", path: ["accounts", i, "credentials", n], message: `"${n}" başka bir hesapta da var` });
      names.add(n);
    }
  });
}).prefault({});

export type BrowserTest = z.infer<typeof BrowserTestSchema>;

export const LiveSchema = z.object({
  enabled: z.boolean().default(true),
  /** Uygulamayı ayağa kaldıran komut ya da compose dosyası. */
  compose: z.object({ base: z.string().min(1) }).optional(),
  startCommand: CommandSchema.optional(),
  app: z.object({
    service: z.string().optional(),
    containerPort: z.number().int().positive(),
    build: z.object({
      context: z.string().min(1),
      dockerfile: z.string().min(1),
    }).optional(),
    /**
     * Hazır imaj — `build` yerine. Araç zinciri (SDK, npm) zaten proje
     * imajındaysa uygulama ayrı bir image build'i İSTEMEZ: aynı imaj
     * worktree'yi mount edip çalıştırır.
     *
     * Northwind'de bu yol seçildi: `deploy/docker-compose.yml` ÜRETİM içindir,
     * önceden publish edilmiş `NORTHWIND_IMAGE` ister ve "yerel geliştirme için
     * değildir" diye başlar. Her canlı ortam için publish + image build
     * koşturmak, zaten 27 dk süren build'e bir adım daha eklerdi.
     */
    image: DockerImageRef.optional(),
    /**
     * Uygulamayı başlatan komut. `image` ile birlikte kullanılır; `run.ps1`'in
     * host'u başlatma satırının konteynerdeki karşılığıdır.
     */
    command: z.string().optional(),
    /**
     * Worktree'nin konteynerde bağlanacağı yol. Verilirse iş dizini buraya
     * bind edilir ve `command` repo kökünde koşar — `exec.workdir` ile aynı
     * düzen (iş dizini mount edilir, repo bir alt dizindir).
     */
    workdir: z.string().optional(),
    /**
     * Dışarı açılacak EK portlar — `containerPort` birincil (canlı test
     * bağlantısı ona gider).
     *
     * YAŞANDI (2026-09-17): Northwind'de backend 5080'de, arayüz Vite'ta 5173'te
     * koşuyor. Tek port yayınlandığı için insan yalnız API'ye ulaşabiliyor,
     * ekranı açamıyordu. Elle ikinci port eklenmişti; bu alan onu profile
     * taşır.
     *
     * `label` UI'da bağlantının adı olur ("UI", "API"…).
     */
    extraPorts: z.array(z.object({
      containerPort: z.number().int().positive(),
      label: z.string().default(""),
      /** Canlı test kartında birincil bağlantı bu olsun mu? */
      primary: z.boolean().default(false),
    })).default([]),
  }),
  /**
   * Canlı ortamın servisleri — üst düzey `services[].name`. Dış servise
   * konteyner kurulmaz, kalanlar compose ile kalkar.
   */
  services: z.array(z.string().min(1)).default([]),
  /**
   * Canlı ortam işe özel bir DB klonu alsın mı (`database.clone`).
   *
   * KAPI. Kapalıysa orkestratör veritabanına HİÇ dokunmaz: uygulama bağlantı
   * dizesini profilden kendi alır. (Eski `live.cloneDb.enabled`; bir süre
   * şemada durup sunucuda okunmuyordu — kapalı klonla dış Postgres'e
   * bağlanmaya çalışan ortam 120 s sonra düşüyordu, 2026-09-20.)
   */
  cloneDb: z.boolean().default(false),
  /**
   * Build adımları canlı konteynerin başlatma komutunun ÖNÜNE zincirlensin mi?
   *
   * Canlı ortam uygulamayı worktree'den, TAZE bir konteynerde başlatıyor
   * (`app.image` + `app.command`); ayakta duran bir geliştirme host'u yok,
   * yani build çıktısının eksiksiz olması canlı testin ön koşulu. Koşullu
   * derleme (`build.steps[].whenChanged`) safha kapısı için doğru ama burada
   * yetmiyor: yalnız dokunulan katman derlenmişse öteki katmanın çıktısı
   * volume'de hiç olmayabilir ve uygulama yeşil build'e rağmen kalkmaz ya da
   * ekransız açılır.
   *
   * Açıkken `whenChanged` yok sayılır, bütün adımlar profil sırasıyla koşar.
   *
   * NEREDE koştuğu önemli: build AYNI konteynerde, başlatma komutundan hemen
   * önce çalışır (`<build adımları> && <başlatma>`). Eskiden build agent
   * konteynerinde koşuyor, uygulama AYRI bir konteynerde kalkıyordu; ikisini
   * yalnız named volume bağlıyordu ve derleyen ortamın koşan ortamla aynı
   * olduğu hiçbir yerde garanti değildi.
   *
   * Kırmızı build canlı ortamı KALDIRMAZ; konteyner build adımında çıkar,
   * orkestratör bunu işaretçiden ayırt eder ve Developer'a `<feedback>` ile
   * döner. Bedeli süre (Northwind'de tam build ~27 dk) — `healthcheck.timeoutMinutes`
   * build + açılış toplamını kapsamalı, yoksa sağlıklı build bile zaman
   * aşımına düşer.
   *
   * `app.build` (Dockerfile'dan imaj) yolunda YOK SAYILIR: kod imajda gömülü,
   * zincirin derleyeceği bir worktree yok.
   */
  buildBeforeStart: z.boolean().default(true),
  /**
   * TEK BOŞLUK olarak geçilecek env değişkenleri.
   *
   * .NET'te bir ortam değişkenini BOŞ DİZEYE ayarlamak onu SİLER ve appsettings
   * değeri geri gelir. Northwind'de Elasticsearch'ün "dolu ama erişilemez" hâli en
   * kötü durumdur: Serilog sink'i BootstrapMethod.Failure ile kurulu, host
   * AÇILIŞTA ÖLÜR. CI bile bu yüzden tek boşluk geçiyor.
   */
  emptyEnv: z.array(z.string()).default([]),
  healthcheck: z.object({
    type: z.literal("http").default("http"),
    path: z.string().default("/"),
    /**
     * Yoklanan KONTEYNER portu — `app.containerPort` ya da `app.extraPorts`
     * içinden biri olmalı (yalnız onlar yayınlanıyor).
     *
     * Boşsa insanın açtığı birincil adresin portu yoklanır (`primary` ek port
     * varsa o, yoksa `containerPort`). Northwind'de birincil bağlantı Vite (5173),
     * sağlık ucu ise backend'de (5080); ikisi ayrışınca bu alan gerekti.
     */
    port: z.number().int().positive().optional(),
    expectStatus: z.array(z.number().int()).default([200]),
    timeoutMinutes: z.number().int().positive().default(8),
    intervalSeconds: z.number().int().positive().default(5),
  }),
  /**
   * "Port açık" değil "API çalışıyor" DEĞİL.
   *
   * Northwind'de FastEndpoints uçları kaydederken ayarları veritabanından çeker;
   * bağlantı yoksa RoutePublisher hatayı YUTAR ve süreç SIFIR route ile dinlemeye
   * devam eder. Gerçek hazırlık ölçütü log'daki "Registered N endpoints", N>0.
   */
  readiness: z.object({
    logPattern: z.string().min(1),
    /** Yakalanan ilk grup sayıya çevrilir ve bu değerden büyük olmalı. */
    minCaptureValue: z.number().int().default(0),
    /** Bu desen log'da görünürse ortam SAĞLIKSIZ sayılır. */
    failPatterns: z.array(z.string()).default([]),
  }).optional(),
  access: z.enum(["direct", "proxy", "tunnel"]).default("proxy"),
  ttlMinutes: z.number().int().positive().default(120),
  allowEgress: z.boolean().default(false),
  /**
   * Sunucu dışına Traefik üzerinden domain ile erişim.
   *
   * Motora GÖMÜLMEZ (temel ilke): domain kökü ve etkinliği projeye göre
   * değişir. `enabled` kapalıysa hiçbir Traefik dosyası üretilmez — mevcut
   * `127.0.0.1` davranışı bozulmaz.
   */
  traefik: z.object({
    enabled: z.boolean().default(false),
    /** Wildcard domain kökü, örn. "erksoft.net" → job-xxxxxxxx.erksoft.net. */
    domain: z.string().min(1),
    certResolver: z.string().default("le"),
  }).optional(),
  dast: DastSchema,
  browserTest: BrowserTestSchema,
});

// ── database (golden snapshot) ───────────────────────────────────────────────

export const DatabaseSchema = z.object({
  kind: z.enum(["postgres", "mysql", "sqlite", "none"]).default("none"),
  goldenVolume: z.string().optional(),
  /**
   * Migration ile seed AYRI adımlardır ve seed ATLANAMAZ.
   * Northwind: migration yalnız şemayı kurar; tohum (kiracı, roller, diller, izinler,
   * yönetici) ayrı bir koddur. Tohumsuz DB'de her uç 403 döner — açılışta hata
   * çıkmaz, yalnızca panel boş gelir.
   */
  migrate: CommandSchema.optional(),
  seed: CommandSchema.optional(),
  goldenMaxAgeDays: z.number().int().positive().default(14),
  /**
   * Şablondan klon — Postgres üzerinde. Kim kullanacağını tüketici söyler
   * (`live.cloneDb`, `test.suites[].cloneDb`); nasıl klonlanacağı burada,
   * TEK YERDE durur.
   *
   * `CREATE DATABASE <hedef> TEMPLATE <şablon>` ile saniyeler içinde izole
   * bir kopya türetilir (ölçüldü: 150 tablolu Northwind için ~9 sn). Konteyner
   * kaldırmaya göre hem hızlı hem de veriyle birlikte gelir: tohum koşmaz.
   *
   * ŞABLON ÜZERİNDE AÇIK BAĞLANTI OLMAMALI — Postgres `TEMPLATE`i reddeder
   * ("is being accessed by other users"). Bu yüzden şablon canlı geliştirme
   * veritabanı DEĞİL, ondan bir kez alınmış kopyadır (`northwind_golden`).
   */
  clone: z.object({
    /**
     * Hangi servisin üzerinde koşulacağı (`services[].name`).
     *
     * BAĞLAYICIDIR: bulunamazsa klonlama kurulmaz ve log'a yazılır. Eskiden
     * alan yok sayılıp `dataPath`/`internalPort` üzerinden tahmin
     * yürütülüyordu ve yanlış servis seçiliyordu.
     */
    service: z.string().default("postgres"),
    /** Kaynak şablon DB adı. Üzerinde açık oturum bulunmamalı. Boşsa `<slug>_golden`. */
    template: z.string().default(""),
    /**
     * Canlı ortam klonunun ad kalıbı. `{template}` ve `{jobId}` (alt çizgili
     * tam kimlik) genişler; `$jobIdShort` gibi yer tutucular da geçerlidir
     * (bkz. placeholders.ts) — kısa ad için `{template}_$jobIdShort`.
     * Test klonları bu adın sonuna koşu son eki alır.
     */
    namePattern: z.string().default("{template}_job_{jobId}"),
    /** Bağlantı kimliği. Parola profilde durur; log'a `scrubSecrets` uygular. */
    user: z.string().default("postgres"),
    password: z.string().default(""),
    /** Canlı ortam kapanınca klonu düşürülsün mü? (Test klonları her durumda düşer.) */
    dropOnCleanup: z.boolean().default(true),
  }).prefault({}),
});

// ── git ──────────────────────────────────────────────────────────────────────

export const GitSchema = z.object({
  /** Northwind'de branch açma zorunluluğu YOK (2026-08-22'de kaldırıldı). */
  branchRequired: z.boolean().default(true),
  branchPattern: z.string().default("{brand}/{jobId}-{slug}"),
  commitTemplate: z.string().default("{type}: {summary}"),
  pr: z.object({
    provider: z.enum(["github", "none"]).default("github"),
    /**
     * Varsayılan HAZIR PR: CodeRabbit taslak PR'ı incelemiyor, taslak açılan
     * iş review almadan bekliyordu. Taslak isteyen proje profilde açar.
     */
    draft: z.boolean().default(false),
    base: z.string().default("{defaultBranch}"),
    titleTemplate: z.string().default("{title}"),
    labels: z.array(z.string()).default([]),
    /**
     * PR başlığını ve gövdesini AGENT yazsın mı?
     *
     * Kapalıyken başlık `titleTemplate` ile İŞİN ADINDAN kopyalanır ve gövde
     * sabit şablondur: "Sipariş notları" gibi bir başlık, kodun ne yaptığını
     * değil isteğin adını söyler — inceleyen için değeri düşük.
     *
     * Açıkken diff stat'ı ve plan özeti verilip KONVANSİYONEL bir başlık
     * üretilir. Tip rastgele değil, SÜRÜMÜ BELİRLER: `feat` minor, `fix`
     * patch, `!` major, `chore` artırmaz.
     *
     * GÖVDE ÜRETİLMEZ — şablon gövde (plan + test sonuçları) kalır. Review
     * botu PR'a kendi özetini basıyor ("Summary by CodeRabbit"); üstüne
     * ikinci bir anlatı gürültüden başka bir şey değil.
     *
     * Ucuz bir iş: araçsız, tek blok çıktı — varsayılan model `haiku`.
     *
     * Üretici taraf güvenilmez (kural 3): blok gelmezse ya da şemaya uymazsa
     * şablona düşülür, iş DURMAZ.
     */
    aiDescription: z.boolean().default(false),
    /** Başlığı yazacak model. Yalnız metin üretiyor, araç kullanmıyor; ucuz. */
    aiModel: z.string().default("claude-haiku-5-5"),
    /**
     * QA yeşil olunca PR açmadan önce insan onayı (`pr_open` kapısı) istensin mi?
     *
     * Varsayılan AÇIK: bazı projeler onaysız commit/PR'ı yasaklıyor (Northwind
     * CLAUDE.md). Kapalıyken QA yeşil olunca PR doğrudan açılır; insan yalnız
     * inceleme tavanında ve (açıksa) merge kapısında devreye girer.
     */
    openApproval: z.boolean().default(true),
    /**
     * CI yeşile döndükten sonra kapanış kapısı açılsın mı?
     *
     * Kapalıysa (varsayılan) iş CI yeşil olunca doğrudan `Done` olur ve PR
     * insana kalır — merge her zaman insanın işiydi. Açıkken insan onayı
     * beklenir; onay verilince `mergeMethod` ile birleştirilir ve `cleanup`
     * ne kadarının toplanacağını söyler.
     */
    mergeApproval: z.boolean().default(false),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
    /**
     * Merge sonrası toplanacaklar. Dal silme geri alınamaz; bu yüzden
     * varsayılan hiçbiri değil, açıkça sayılır.
     */
    cleanup: z.object({
      /** Uzaktaki dal (`origin/<branch>`). */
      remoteBranch: z.boolean().default(false),
      /** Worktree ve yerel dal. */
      localBranch: z.boolean().default(false),
      /**
       * İşin volume'ü (worktree) ve canlı ortamı. Konteyner bu seçimden
       * bağımsız olarak her `Done`da kaldırılır.
       */
      container: z.boolean().default(false),
    }).prefault({}),
  }).prefault({}),
});

// ── tracker (iş kaynağı: GitHub issue, yarın Jira/ClickUp) ───────────────────

/**
 * İş bir takip sisteminden (issue) açıldıysa o kayıt işle senkron tutulur.
 *
 * Hangi takipçinin konuşulacağını `job.source` seçer (adaptör); burası yalnız
 * NE yapılacağını söyler. Kaynağı `ui` olan işlerde hiçbiri koşmaz.
 */
export const TrackerSchema = z.object({
  enabled: z.boolean().default(true),
  /** İş başlayınca kaydı token sahibine (Ahtapot'un kimliği) ata. */
  assignOnStart: z.boolean().default(true),
  /** Her aşama geçişinde kayda not düş. */
  comments: z.boolean().default(true),
  /**
   * Aşamayı etiketle göster. Varsayılan kapalı: her geçişte etiket değişimi
   * issue geçmişini kalabalıklaştırıyor, aşama zaten yorumlarda ve rozette.
   */
  statusLabels: z.boolean().default(false),
  labelPrefix: z.string().min(1).max(20).default("ahtapot"),
  /** Canlı test hazır olunca kaydı açan kişiye geri ata. */
  reassignOnLiveTest: z.boolean().default(true),
  /**
   * Canlı test kararı issue etiketiyle de verilebilir — UI'a girmeden.
   *
   * Etiket eklemek repoda triage yetkisi ister; "kim onaylayabilir" sorusunu
   * GitHub cevaplıyor, yorum komutunda bunu biz yazmak zorunda kalırdık.
   * Düzeltme etiketi not ister: notu, kapı açıldıktan sonra yazılan yorumlar
   * taşır. Önek aşama etiketlerinden (`labelPrefix`) ayrı olmalı — aşama
   * geçişi o önekle başlayan etiketleri siliyor.
   */
  verdictLabels: z.boolean().default(true),
  approveLabel: z.string().min(1).max(50).default("ahtapot-test: onay"),
  fixLabel: z.string().min(1).max(50).default("ahtapot-test: düzelt"),
  /** Motor PR'ı merge ettiğinde kaydı kapat. */
  closeOnMerge: z.boolean().default(true),
});

// ── release (hedef repodaki yayın Action'ını tetikleme) ──────────────────────

/** Sürüm artışı. `auto` yalnız zamanlı turda: commit başlıklarından çıkarılır. */
export const ReleaseBumpSchema = z.enum(["patch", "minor", "major"]);
export type ReleaseBump = z.infer<typeof ReleaseBumpSchema>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Release'in KENDİSİ hedef repodaki GitHub Action'ında yaşar (tag, dosya
 * bump'ı, Release sayfası, imaj); Ahtapot yalnız `workflow_dispatch` ile
 * tetikler ve NE ZAMAN tetikleneceğini yönetir. Projeler release'i farklı
 * kurar (semantic-release, release-please, elle tag) — motor bunlardan
 * birini dayatmaz, girdileri profil adlandırır.
 *
 * Sürümün kaynağı git tag'idir: dosya (package.json, csproj) çok paketli
 * repolarda tek değil, tag her projede var.
 */
export const ReleaseSchema = z.object({
  enabled: z.boolean().default(false),
  /** `{version}` yer tutucusu zorunlu; uymayan tag'ler sürüm sayılmaz. */
  tagPattern: z.string().min(1).refine((s) => s.includes("{version}"), "{version} içermeli").default("v{version}"),
  /**
   * Yayınlanacak repo (`workspace.repos[].name`). Boşsa birincil repo.
   * Çok repolu workspace'te (Northwind + iç içe Northwind.Forms) hangisi olduğu
   * tahmin edilmez, yazılır.
   */
  repo: z.string().min(1).optional(),
  workflow: z.object({
    /** `.github/workflows/` altındaki dosya adı (koşu sorgusu REST'te dosya adı ister). */
    file: z.string().min(1).default("release.yml"),
    /** Workflow'un koşacağı dal; `{defaultBranch}` repo varsayılanına çözülür. */
    ref: z.string().min(1).default("{defaultBranch}"),
    /** Bump türünün geçtiği input adı. Boş dize: geçilmez (workflow kendisi karar verir). */
    bumpInput: z.string().default("bump"),
    /**
     * Ahtapot'un hesapladığı sürümün geçtiği input. Verilmezse sürümü
     * workflow belirler ve UI'daki sürüm yalnız TAHMİNDİR; doğrulanan sürüm
     * her zaman oluşan tag'den okunur.
     */
    versionInput: z.string().min(1).optional(),
    /** Her tetiklemede sabit geçen ek girdiler. */
    extraInputs: z.record(z.string(), z.string()).default({}),
    /**
     * Yayın kimliğinin geçtiği input. Workflow onu `run-name`e yazarsa
     * (`run-name: release ${{ inputs.ahtapot_id }}`) koşu KESİN eşlenir.
     * `gh workflow run` koşu kimliği dönmüyor; bu yoksa eşleme zaman
     * penceresi + dal ile yapılır ve aynı anda başkası tetiklediyse `unknown`.
     */
    correlationInput: z.string().min(1).optional(),
  }).prefault({}),
  schedule: z.object({
    /**
     * Serbest cron YOK: bağımlılıksız cron + yaz saati geçişini elle yazmak
     * hata kaynağı, haftalık/aylık ihtiyacın tamamını karşılıyor.
     */
    mode: z.enum(["off", "weekly", "monthly"]).default("off"),
    /** 0=Pazar … 6=Cumartesi (JS `getDay` ile aynı). */
    weekday: z.number().int().min(0).max(6).default(1),
    /** Ayın günü; kısa ayda son güne sıkıştırılır (31 → Şubat 28/29). */
    dayOfMonth: z.number().int().min(1).max(31).default(1),
    time: z.string().regex(HHMM, "SS:DD").default("10:00"),
    /** IANA saat dilimi (`Europe/Istanbul`). */
    timezone: z.string().min(1).refine(isValidTimeZone, "geçersiz saat dilimi").default("UTC"),
    /** Son tag'den beri commit yoksa tur atlanır — boş sürüm yayınlanmaz. */
    skipIfNoChanges: z.boolean().default(true),
    /** `auto`: `feat` → minor, `!`/`BREAKING CHANGE` → major, diğerleri patch. */
    bump: z.union([ReleaseBumpSchema, z.literal("auto")]).default("auto"),
    /**
     * Dal ucundaki commit'in check'leri kırmızı ya da sürüyorsa tur atlanır.
     * Hiç check yoksa GEÇER: CI'sız repoda zamanlı yayın hiç çalışmazdı.
     */
    requireGreenCi: z.boolean().default(true),
  }).prefault({}),
});
export type Release = z.infer<typeof ReleaseSchema>;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── workflow (çalışma disiplini) ─────────────────────────────────────────────

/**
 * Yerel ön inceleme: PR AÇILMADAN önce OpenCodeReview (`ocr`) iş
 * konteynerinde worktree'yi inceler, bulguları Developer çözer. Sonra PR
 * açılır ve bot incelemesi (`provider`) her zamanki gibi sürer.
 *
 * Amaç bot incelemesinin YERİNİ almak değil: bariz kusur PR'dan önce
 * düşerse bot turu azalır. CodeRabbit'te her push yeni inceleme demek ve
 * kota saatte 3 (ölçüldü) — turlar kotayı yakıyordu.
 *
 * Sağlayıcı ve model PARAMETRİK: `protocol` + `baseUrl` + `model` ile OpenAI,
 * Anthropic ya da uyumlu bir router seçilir. Anahtarın kendisi profilde
 * DEĞİL — profil DB'de ve UI'da. `keyRef` sunucunun `AHTAPOT_REVIEW_KEYS`
 * dosyasındaki `ad=anahtar` satırının adıdır.
 */
export const LocalReviewSchema = z.object({
  enabled: z.boolean().default(false),
  tool: z.enum(["ocr"]).default("ocr"),
  /**
   * `openai-responses`: OpenAI Responses API — resmî OpenAI için doğru olan.
   * `openai`: Chat Completions (`/v1/chat/completions`) — router'ların çoğu
   * bunu konuşur. `anthropic`: Messages API.
   *
   * Varsayılan Responses: GPT-6 Chat Completions'ta OCR'ın gönderdiği
   * `max_tokens`ı ve `temperature: 0`ı 400 ile reddediyor, her dosya düşüyor
   * (ölçüldü, 2026-09-26, gpt-6-sol).
   */
  protocol: z.enum(["openai", "openai-responses", "anthropic"]).default("openai-responses"),
  /** Boşsa protokolün resmî adresi (`api.openai.com/v1`, `api.anthropic.com`). */
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  keyRef: z.string().min(1).optional(),
  /** `low` tek inceleme turu; `medium` 2, `high` 3 — maliyet orantılı artar. */
  effort: z.enum(["low", "medium", "high"]).default("low"),
  /**
   * En çok kaç inceleme + düzeltme turu. Son düzeltmeden sonra yeniden
   * incelenmez: doğrulamayı bot yapar, fazladan bir koşu yalnız para yakar.
   * Tavanda yorum kalsa da PR açılır — kapı YOK, bu bir ön filtre.
   */
  maxRounds: z.number().int().positive().default(2),
  /** Tek koşunun toplam token tavanı (girdi + çıktı); `0` sınırsız. */
  maxTokensBudget: z.number().int().nonnegative().default(2_000_000),
  /** Tek koşunun duvar saati tavanı. Aşılırsa inceleme atlanır, akış sürer. */
  timeoutMinutes: z.number().int().positive().default(30),
  /** İncelemeden çıkarılacak ek desenler (gitignore biçimi). */
  exclude: z.array(z.string().min(1)).default([]),
  /**
   * `exclude` sonrası dosya sayısı bunu aşarsa inceleme koşmaz; `0` sınırsız.
   * Bu boyutta bir diff ya bayat tabandan gelir ya da ön filtreye uygun
   * değildir. YAŞANDI (2026-10-08): bayat taban 772 dosyayı incelemeye soktu.
   */
  maxFiles: z.number().int().nonnegative().default(50),
}).superRefine((v, ctx) => {
  if (!v.enabled) return;
  // Eksik ayar koşuda "inceleme atlandı" diye sessizce geçerdi; profil
  // kaydedilirken reddedilmeli.
  if (!v.model) ctx.addIssue({ code: "custom", path: ["model"], message: "yerel inceleme açıkken model zorunlu" });
  if (!v.keyRef) ctx.addIssue({ code: "custom", path: ["keyRef"], message: "yerel inceleme açıkken keyRef zorunlu" });
}).prefault({});

export type LocalReview = z.infer<typeof LocalReviewSchema>;

/**
 * İkinci göz (karar §42): plan ve test senaryolarını ikinci bir model
 * eleştirir, bulgu insana danışman notu olarak gider.
 *
 * Sağlayıcı (`protocol`, `baseUrl`, `keyRef`) `review.local`dan okunur —
 * anahtar ve uç nokta orada tanımlı ve ölçülü. `review.local.enabled`
 * GEREKMEZ: OCR kapalıyken de eleştirmen açık olabilir. Zorunluluk denetimi
 * `review` düzeyinde, çünkü iki alt nesneye birden bakıyor.
 */
export const CriticSchema = z.object({
  /** Plan onayında planı eleştir. */
  plan: z.boolean().default(false),
  /** Test senaryoları hazır olunca eleştir. */
  scenarios: z.boolean().default(false),
  /** Boşsa `review.local.model` — aynı uç noktada başka model seçmek için. */
  model: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().default(8_000),
  timeoutSeconds: z.number().int().positive().default(180),
  /**
   * Dış sağlayıcı düşerse (kota, HTTP hatası, zaman aşımı, anahtar yok)
   * eleştiri Claude havuzuyla, araçsız yan koşu olarak tekrarlanır. Yaşandı
   * (2026-10-17): OpenAI kredisi bitti, 429 `insufficient_quota` → senaryo
   * eleştirisi hiç koşmadı. Farklı modelin kör nokta avantajı kaybolur ama
   * ikinci okuma kalır; istemeyen proje kapatır.
   */
  fallback: z.object({
    enabled: z.boolean().default(true),
    model: z.string().min(1).default("claude-opus-5-5"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
    maxBudgetUsd: z.number().positive().default(2),
  }).prefault({}),
}).prefault({});

export type Critic = z.infer<typeof CriticSchema>;

/**
 * Statik analiz adımı — SAST, analizör, biçim denetimi. Araç ve komut
 * PROFİLİN; motor yalnız raporu okumayı bilir.
 *
 * Rapor worktree DIŞINDA durmalı: içeride kalırsa commit'e girer, ayrıca
 * sır kuralları raporun kendisini tarayıp yeni bulgu üretir (Northwind
 * nightly'sinde yaşandı). `path` boşsa motor `AHTAPOT_REPORT` ortamıyla
 * geçici bir yol verir.
 */
export const StaticStepSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "küçük harf, rakam ve tire"),
  /** Kapalı adım profilde durur, koşmaz — aracı silmeden devre dışı bırakmak için. */
  enabled: z.boolean().default(true),
  /**
   * `security` (SAST) adımları ÖNCE ve kendi turlarında koşar; `quality`
   * (okunabilirlik, biçim, MegaLinter) güvenlik düzeltmelerinden SONRA —
   * böylece güvenlik düzeltmesinin dokunduğu dosyalar da denetlenir.
   * Güvenlik kapısı (`securityGate`) yalnız `security` bulgularına bakar.
   */
  category: z.enum(["security", "quality"]).default("quality"),
  /**
   * Boşsa komut iş konteynerinde koşar. Doluysa sunucu bu imajla AYRI bir
   * konteyner kaldırır ve iş volume'ünü aynı yola bağlar: MegaLinter gibi
   * araçlar GB'larca imaj, iş imajına kurulamaz. Rapor bu durumda volume'de
   * worktree dışına (`<exec.workdir>/.ahtapot-static/`) yazılır.
   */
  image: z.string().min(1).optional(),
  /** Worktree kökünde `sh -lc` (imajlıysa `sh -c`) ile koşar. */
  run: z.string().min(1),
  /**
   * `run`dan ÖNCE koşan otomatik düzeltici (ör. `dotnet format`). Ürettiği
   * değişikliği motor commit'ler: biçim kusurunu LLM'e düzelttirmek hem
   * pahalı hem güvenilmez.
   */
  fix: z.string().min(1).optional(),
  report: z.object({
    /**
     * `sarif`: SARIF 2.1 (OpenGrep/Semgrep `--sarif`).
     * `dotnet-format`: `dotnet format --report` JSON'u.
     * `msbuild-log`: derleme çıktısındaki `yol(satır,kolon): warning KOD: …`
     *   satırları. Roslyn `ErrorLog` çözüm derlemesinde her projenin raporunu
     *   aynı dosyaya ezer; analizör bulguları bu yüzden çıktıdan okunur.
     */
    format: z.enum(["sarif", "dotnet-format", "msbuild-log"]),
    /** Raporun yolu; boşsa `$AHTAPOT_REPORT`. `msbuild-log`da kullanılmaz. */
    path: z.string().min(1).optional(),
  }),
  /** Bu seviyenin altındaki bulgular atılır. `dotnet-format` bulguları `error` sayılır. */
  minLevel: z.enum(["error", "warning", "note"]).default("error"),
  /**
   * `lines`: yalnız diff'in EKLEDİĞİ satırlardaki bulgular. `files`: PR'ın
   * dosyalarındaki tüm bulgular.
   *
   * Varsayılan `lines`: Northwind'de yüzlerce eski uyarı var (RCS1189 63,
   * CA1305 35 — ölçüldü); dosya düzeyi eski borcu Developer'a yükler ve
   * PR'ı şişirir (Northwind#184'teki kapsam sorunu).
   */
  scope: z.enum(["lines", "files"]).default("lines"),
  timeoutMinutes: z.number().int().positive().default(20),
});

export type StaticStep = z.infer<typeof StaticStepSchema>;

/**
 * Yerel statik analiz — PR açılmadan, OCR'dan ÖNCE koşar.
 *
 * Önce, çünkü deterministik ve anahtarsız: ucuz bulguyu LLM'e para ödeyerek
 * buldurmanın anlamı yok, OCR da temizlenmiş kodu görür. Bu da bir ön
 * filtre: araç düşerse ya da tavan dolarsa PR yine açılır, kapı YOK.
 * Bulgu gece taramasına (Northwind `nightly.yml`) düşene kadar kod çoktan
 * merge'lenmiş oluyordu.
 */
export const StaticReviewSchema = z.object({
  enabled: z.boolean().default(false),
  steps: z.array(StaticStepSchema).default([]),
  /**
   * En çok kaç düzeltme turu. OCR'dan farkı: son düzeltmeden sonra bir kez
   * daha koşar (ucuz) ve kalanları bildirir.
   */
  maxRounds: z.number().int().positive().default(2),
  /**
   * Güvenlik turları bittiğinde bulgu kaldıysa ya da bir güvenlik aracı
   * koşamadıysa PR'a geçmeden `security` kapısı açılır: insan "bir tur daha"
   * ya da "kalanlarla devam" der. Kapalıyken yalnız bildirim (ön filtre).
   */
  securityGate: z.boolean().default(false),
}).superRefine((v, ctx) => {
  const ids = new Set<string>();
  v.steps.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `"${s.id}" tekrarlanıyor` });
    ids.add(s.id);
  });
  if (v.securityGate && !v.steps.some((s) => s.enabled && s.category === "security")) {
    ctx.addIssue({ code: "custom", path: ["securityGate"], message: "güvenlik kapısı açıkken en az bir `security` adımı açık olmalı" });
  }
  // Açık ama koşacak adımı olmayan analiz her turda "bulgu yok" derdi.
  if (v.enabled && !v.steps.some((s) => s.enabled)) {
    ctx.addIssue({ code: "custom", path: ["steps"], message: "statik analiz açıkken en az bir adım açık olmalı" });
  }
}).prefault({});

export type StaticReview = z.infer<typeof StaticReviewSchema>;

export const WorkflowSchema = z.object({
  /**
   * phased: her safhadan sonra DUR ve onay iste (Northwind'in ölçülmüş disiplini —
   *   dokuz safhalık bir fazın sonunda sunulan diff incelenemeyecek kadar büyük
   *   olur ve yanlış kararın üzerine sekiz safha daha inşa edilir).
   * single: Developer planın tamamını yazıp bir kez durur.
   */
  developing: z.enum(["phased", "single"]).default("single"),
  /** Safha tavanı — "birlikte incelenebilir mi" ölçütü. Bölünemeyen iş aşabilir. */
  phaseMaxFiles: z.number().int().positive().default(4),
  /** Safha sonunda testler koşmaz, yalnız derleme. */
  phaseRunsTests: z.boolean().default(false),
  /** Kendiliğinden commit YASAK; onay o yasağı kaldırır. */
  commitPolicy: z.enum(["onApproval", "auto"]).default("onApproval"),
  /**
   * Agent yetkisi dışında bir engel bildirdiğinde DUR ve insana sor.
   *
   * Açık: `blocked` kapısı açılır, insan "engeli çözecek role gönder" ya da
   * "yok say" der. Kapalı: engel yalnız geri bildirime metin olarak girer ve
   * akış normal döngüsünü sürdürür — gözetimsiz koşan kurulumlar için.
   *
   * Varsayılan AÇIK: engeli yok saymak eksik planlı işin PR'a gitmesi demek
   * ve bu sessiz bir hatadır (bkz. `BlockerSchema` yorumu).
   */
  blockedApproval: z.boolean().default(true),
  /**
   * Tek bir işte inceleme/CI düzeltmesi olarak atılabilecek TOPLAM commit.
   *
   * `local.maxRounds`, `review.maxRounds` ve DevOps `maxIterations` ayrı ayrı
   * küçük görünür ama toplamları sınırsız: yerel inceleme, bot yorumları ve
   * CI birbirini besleyerek PR'ı şişiriyordu (Northwind#184: ikon işi için
   * 4 düzeltme turu, 30 dosya). Tavan dolunca iş düşmez: yeni düzeltme
   * denenmez, kalan yorum/kırmızılık merge kapısında insana taşınır.
   */
  maxFixPushes: z.number().int().positive().default(6),
  /**
   * İnceleme/CI düzeltmesi commit'lenmeden ÖNCE yerelde ne koşsun.
   *
   * `build-test`: derleme kapısı + `runAt: "qa"` test takımları (baseline
   * açıksa önceden kırıklar ayrılır). `build`: yalnız derleme. `none`:
   * doğrulama uzak CI'a bırakılır.
   *
   * Uzak CI'ın derlemediği kurulumda (Northwind, 2026-10-05) düzeltmeyi
   * doğrulayan hiçbir şey yoktu: agent derleme komutu koşamıyor, motor da
   * koşturmuyordu — kırık kod doğrudan push'lanıyordu. Kırmızıysa aynı
   * oturuma geri bildirim gider (`limits.maxLoops.build` deneme); hâlâ
   * kırmızıysa düzeltme stash'e alınır, commit'lenmez.
   */
  verifyFixes: z.enum(["build-test", "build", "none"]).default("build-test"),
  /**
   * PR açılmadan önce uzak varsayılan dal işin dalına merge edilsin mi.
   *
   * LiveTest ve QA insanı beklerken `main` ilerliyor; çakışma ancak PR
   * açıldıktan sonra görünüyor, bot kotası çakışma push'una gidiyordu.
   * Açıkken merge statik analiz ve yerel incelemeden önce yapılır, taban
   * çekilen uca ilerler; agent çakışma çözdüyse birleşim derlenir.
   * Kapalıyken PR açıkken çakışma yine `syncBase` ile çözülür.
   */
  syncBaseBeforePr: z.boolean().default(true),
  /** Code review DIŞ süreçse agent kendiliğinden tetiklemez. */
  review: z.object({
    autoTrigger: z.boolean().default(false),
    /**
     * `coderabbit`: PRReview'da PR açıldıktan sonra botun incelemesi beklenir
     * ve eşiği aşan yorumları Developer turlarla çözer; sonra CIWatch.
     * `none`: PR açılır açılmaz CIWatch'a geçilir.
     *
     * `autoTrigger` açıksa bot `waitMinutes`in yarısında incelemeye
     * başlamamışsa PR'a `@coderabbitai review` yazılır. Bot "rate limited"
     * derse ne tetiklenir ne beklenir: kota saatte 3 inceleme ve dolu kotada
     * tetikleme de reddediliyor (ölçüldü) — beklemek işi boşa kilitler.
     */
    provider: z.enum(["coderabbit", "none"]).default("none"),
    /**
     * PRReview'da en çok kaç düzeltme turu. Tavanda yorum hâlâ açıksa
     * `review_round` kapısı açılır: insan "bir tur daha" ya da "CI'a geç" der.
     */
    maxRounds: z.number().int().positive().default(3),
    /**
     * Botun incelemesini (ilk ve her push sonrası) en çok kaç dakika bekle.
     * Gelmezse akış durmaz: açık yorum olmadan CIWatch'a geçilir.
     */
    waitMinutes: z.number().int().positive().default(20),
    /**
     * Çözülmemiş inceleme yorumları merge'ü engellesin mi?
     *
     * Kapalıyken yorumlar yalnız bilgi. Açıkken CI yeşil olsa bile DevOps
     * turu koşar — CodeRabbit'in check'i yorumlarından BAĞIMSIZ yeşile
     * dönüyor (ölçüldü: PR #135, check SUCCESS + 11 açık yorum).
     */
    blocksMerge: z.boolean().default(false),
    /**
     * Hangi şiddetten itibaren ele alınsın. `minor` her şeyi kapsar;
     * dokümantasyon tercihleri için tur harcamak istemeyen `major` seçer.
     * Şiddeti okunamayan yorum `minor` sayılır.
     */
    minSeverity: z.enum(["critical", "major", "minor"]).default("major"),
    /**
     * Merge onayından sonra botun HÂLÂ GEÇERLİ `CHANGES_REQUESTED`ı kaldırılsın mı?
     *
     * GitHub kişi başına son KARARI sayar; `COMMENTED` onu değiştirmez. Bot
     * yorumları çözülüp sonraki turlarda yalnız `COMMENTED` bırakınca ilk
     * turun change request'i kalıyor ve branch protection merge'ü kilitliyor
     * (ölçüldü, Northwind#151: 5/5 thread çözülmüş, `reviewDecision`
     * CHANGES_REQUESTED). Yalnız botun incelemesi dismiss edilir, insanınki
     * asla; kapı bunu onaydan önce gösterir.
     */
    dismissBotChangesRequest: z.boolean().default(true),
    local: LocalReviewSchema,
    critic: CriticSchema,
    static: StaticReviewSchema,
  }).superRefine((v, ctx) => {
    if (!v.critic.plan && !v.critic.scenarios) return;
    // Eksik ayar koşuda "atlandı" diye sessizce geçerdi; yerel incelemedeki
    // gerekçenin aynısı — profil kaydedilirken reddedilmeli.
    if (!v.local.keyRef) ctx.addIssue({ code: "custom", path: ["local", "keyRef"], message: "ikinci göz açıkken yerel incelemenin keyRef'i zorunlu" });
    if (!v.critic.model && !v.local.model) ctx.addIssue({ code: "custom", path: ["critic", "model"], message: "ikinci göz açıkken model zorunlu (burada ya da yerel incelemede)" });
  }).prefault({}),
});

// ── agents ───────────────────────────────────────────────────────────────────

export const AgentRoleSchema = z.object({
  model: z.string().default("claude-opus-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  maxTurns: z.number().int().positive().default(100),
  maxBudgetUsd: z.number().positive().default(10),
  maxIterations: z.number().int().positive().optional(),
});

/**
 * Bir merdiven basamağının karşılığı.
 *
 * Model ve effort TEK ayardır, birlikte seçilir: ucuz model + yüksek effort
 * bazen pahalı model + düşük effort'tan iyidir. Ayrıca her model her effort
 * seviyesini desteklemiyor (`xhigh` Fable 5 / Opus 4.7+ / Sonnet 5'te var,
 * başka yerde sessizce `high`'a düşer) — uyumsuz çiftin profilde kurulmaması
 * için ikisi yan yana durur.
 */
export const TierRungSchema = z.object({
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
});
export type TierRung = z.infer<typeof TierRungSchema>;

/**
 * Triage — işin zorluğunu ölçüp modeli ona göre seçen ucuz tur.
 *
 * Sabit Opus sürdürülebilir değil (master-plan R6): bir yazım düzeltmesi
 * Opus'a gitmemeli, dört katmana yayılan bir iş de Haiku'ya. Triage girdiyi
 * (ve plan üretildikten sonra planı) ölçer, motor `deriveTier` ile seviyeye
 * çevirir, seviye burada modele düşer.
 *
 * Karar triage'ın YARGISIna bırakılmaz: belge ölçüm taşır (kaç katman, kaç
 * dosya, git'te kaç commit), tier'a çevirme deterministik koddadır.
 */
export const TriageSchema = z.object({
  /**
   * Kapalıyken hiçbir triage turu koşmaz, roller bugünkü sabit modelleriyle
   * çalışır. Varsayılan KAPALI: davranış değişikliği opt-in olmalı; mevcut
   * profiller sürüm yükseltince sessizce model değiştirmemeli.
   */
  enabled: z.boolean().default(false),
  /** Triage turunun KENDİ modeli — ucuz olmalı, yoksa amaç boşa çıkar. */
  model: z.string().default("claude-haiku-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  maxTurns: z.number().int().positive().default(12),
  maxBudgetUsd: z.number().positive().default(0.5),

  /**
   * Seviye merdiveni. Varsayılanlar bugünkü davranışı KORUR:
   * `deep` = opus-5-5/high = Planner ve Developer'ın bugünkü ayarı.
   *
   * KISMİ olması bilinçli: bir proje yalnız `standard` ve `deep` tanımlayıp
   * uçları boş bırakabilmeli. Eksik basamak `fallbackTier`a, o da yoksa ilk
   * tanımlı basamağa düşer (`rungFor`) — eksik yapılandırma yüzünden iş
   * düşmemeli.
   */
  ladder: z.partialRecord(ModelTierSchema, TierRungSchema).prefault({
    cheap: { model: "claude-haiku-5-5", effort: "medium" },
    standard: { model: "claude-sonnet-5-5", effort: "high" },
    deep: { model: "claude-opus-5-5", effort: "high" },
    frontier: { model: "claude-fable-5-1", effort: "max" },
  }),

  /**
   * Triage okunamazsa düşülecek seviye.
   *
   * `deep` = bugünkü davranış. Güvenli varsayılan PAHALI olandır: triage
   * çöktüğünde kalite düşmez, yalnız tasarruf olmaz.
   */
  fallbackTier: ModelTierSchema.default("deep"),

  /**
   * Bu seviyeden İTİBAREN insan onayı gerekir.
   *
   * Makinenin kendi kendine en pahalı modeli seçmesi bütçe kontrolünü
   * anlamsız kılar. `null` ise onay hiç istenmez.
   */
  approvalRequiredFrom: ModelTierSchema.nullable().default("frontier"),

  stages: z.object({
    /** İş girildiğinde — planlama modelini seçer. */
    intake: z.boolean().default(true),
    /** Plan üretildiğinde — geliştirme modelini seçer. */
    postplan: z.boolean().default(true),
    /**
     * Safha başına ayrı seviye — Planner'ın safha ölçümünden türetilir.
     *
     * Entity/CRUD safhası ile concurrency düzeltmesi aynı modele gitmek zorunda
     * değil. Ek TUR MALİYETİ YOK: ölçüm zaten planla birlikte geliyor, motor
     * yalnız `deriveTier`i safha başına bir kez daha koşuyor.
     *
     * Varsayılan KAPALI: `enabled` ile aynı gerekçe — açıkken safhalar farklı
     * modellere dağılır ve bu, mevcut profillerin sürüm yükseltmede sessizce
     * davranış değiştirmesi demek olurdu.
     */
    perPhase: z.boolean().default(false),
  }).prefault({}),

  /** Kör maliyet freni: triage `frontier` dese de burası `deep` ise `deep`. */
  maxTier: ModelTierSchema.default("frontier"),
});
export type Triage = z.infer<typeof TriageSchema>;

/**
 * Mentor — takılan agent'ı motor tespit eder, bir üst basamağa danışılır
 * (karar §33).
 *
 * Tespit agent'ın METNİNDEN değil DAVRANIŞINDAN çıkarılır: LLM döngüde
 * olduğunu kabul etmiyor. Gözlenen (2026-10-09): canlı test ve CI
 * oturumlarında aynı dosya arada hiç yazılmadan defalarca okunuyor.
 */
export const MentorSchema = z.object({
  /**
   * Varsayılan KAPALI: triage ile aynı gerekçe — sürüm yükseltmede mevcut
   * profillerin akışı sessizce değişmemeli.
   */
  enabled: z.boolean().default(false),
  /**
   * `observe`: sinyal yalnız akışa düşer (`agent.stuck`), mentor koşmaz.
   * `consult`: sinyalde bir üst basamağa danışılır ve öneri koşan oturuma
   * teslim edilir. Eşikler gerçek işlerde yanlış pozitife karşı ölçülmeden
   * açılmamalı — varsayılan bu yüzden `observe`.
   */
  mode: z.enum(["observe", "consult"]).default("observe"),
  /**
   * Mentorun çıkabileceği en üst basamak. `null` → `triage.maxTier`.
   * Frontier danışması insan onayı istemez (insan kararı, 2026-10-09):
   * `approvalRequiredFrom` işin seviyesini korur, danışma tek bir öneridir.
   */
  maxTier: ModelTierSchema.nullable().default(null),
  /** Bir koşuda en çok kaç danışma; sonrası yalnız bildirilir. */
  maxConsultsPerRun: z.number().int().nonnegative().default(2),
  /** İş boyunca en çok kaç danışma (kayıtlı `agent.mentor` olaylarından sayılır). */
  maxConsultsPerJob: z.number().int().nonnegative().default(8),
  /** Danışma başına. Mentor araçsız; bir iki tur yeter. */
  maxBudgetUsd: z.number().positive().default(1),
  maxTurns: z.number().int().positive().default(2),
  /** Agent'ın araç çağrısı mentor cevabını en çok bu kadar bekler. */
  holdTimeoutMinutes: z.number().positive().default(5),
  /** Analyst iş dışında ve tek seferlik; listede olsa da izlenmez. */
  roles: z.array(AgentRoleNameSchema).default(["planner", "developer", "qa", "tester", "devops", "triage"]),
  thresholds: z.object({
    /** Aynı okuma (yol+aralık ya da arama deseni), arada yazma olmadan. */
    repeatRead: z.number().int().min(2).default(3),
    /** Aynı araç+hedef aynı hata imzasıyla kırmızı. */
    repeatFailure: z.number().int().min(2).default(3),
    /** Yazma beklenen rollerde (Developer, QA, DevOps) yazmasız araç çağrısı. */
    noProgressTools: z.number().int().min(5).default(40),
  }).prefault({}),
});
export type Mentor = z.infer<typeof MentorSchema>;

export const DocLayerSchema = z.object({
  dir: z.string().min(1),
  purpose: z.enum(["active-rule", "tacit-knowledge", "archive"]),
  indexFile: z.string().default("README.md"),
  filePattern: z.string().optional(),
  note: z.string().default(""),
});
export type DocLayer = z.infer<typeof DocLayerSchema>;

export const AgentsSchema = z.object({
  /**
   * Ham verilmeyecek kadar büyük dosyalar. Northwind'de CLAUDE.md 487 KB / 5053 satır:
   * her işin bağlamına girmesi israf. Bu dosyalar yalnız hedefli okunur.
   */
  oversizedFiles: z.array(z.object({
    path: z.string().min(1),
    reason: z.string().default(""),
  })).default([]),
  /**
   * Katmanlı doküman keşfi: bazı projeler kuralları tek CLAUDE.md yerine öncelik
   * sıralı dizinlere böler (Northwind: rules/ aktif kural, memories/ tuzak+gerekçe,
   * histories/ arşiv). Desen HER projede yok — Analyst keşfeder, bulamazsa boş
   * bırakır. Ad sabit değil: `purpose` motorun anladığı üç kategori, dizin adı
   * projeye özgü olabilir.
   */
  docLayers: z.array(DocLayerSchema).default([]),
  roles: z.record(z.string(), AgentRoleSchema).default({}),
  /** Model yönlendirmesi; `enabled:false` iken roller sabit modelleriyle koşar. */
  triage: TriageSchema.prefault({}),
  /** Takılan agent'ın tespiti ve üst basamağa danışma (karar §33). */
  mentor: MentorSchema.prefault({}),
  /**
   * Kod haritası (karar §35): modül künyeleri dosya olarak durur, agent
   * ihtiyacı kadar açar. Prompt'a yalnız yeri girer. Varsayılan kapalı —
   * üretimi bir agent koşusu, her proje istemeyebilir.
   */
  codeMap: z.object({
    enabled: z.boolean().default(false),
    /** İlk (tam) üretim: tüm repoyu gezer, daha güçlü model ister. */
    model: z.string().default("claude-sonnet-5-5"),
    /** Bayat künyelerin yeniden üretimi: dar kapsam, ucuz model yeter. */
    refreshModel: z.string().default("claude-haiku-5-5"),
    maxBudgetUsd: z.number().positive().default(5),
    /**
     * Merge edilen işin tuzaklarını (handoff, kırmızı build, insan reddi)
     * merge sonrası tazelemede haritacıya verir; genellenebilir olanı
     * künyenin `pitfalls`ına işler (karar §39). Harita kapalıysa etkisiz.
     */
    learn: z.boolean().default(false),
  }).prefault({}),
  /**
   * Trail kod grafiği (karar §44): tree-sitter ile sembol + çağrı grafiği,
   * ajana MCP araçları olarak sunulur. Kod haritasının yerine DEĞİL, yanına:
   * harita "bu modül ne iş yapar", grafik "bunu kim çağırıyor" sorusunu
   * cevaplar. Varsayılan kapalı — deney; kazanç `agent-reads` ile ölçülür.
   */
  codeGraph: z.object({
    enabled: z.boolean().default(false),
    /** Grafiği alacak roller. Triage ve mentor dışarıda: kısa, araçsız turlar. */
    roles: z.array(z.enum(["planner", "developer", "qa"])).default(["planner", "developer", "qa"]),
    /** İlk kurulum büyük repoda dakikalar sürebilir; aşarsa koşu grafiksiz başlar. */
    buildTimeoutMinutes: z.number().int().positive().default(10),
  }).prefault({}),
});

// ── security ─────────────────────────────────────────────────────────────────

export const SecuritySchema = z.object({
  /** Worktree hazırlanırken SİLİNİR + araç erişimi reddedilir. */
  sensitiveFiles: z.array(Glob).default([]),
  /**
   * Worktree'ye asla kopyalanmaz. Northwind'de .run/: CANLI JWT token
   * (at.txt, token.json) ve 5 MB log taşıyor.
   */
  neverCopy: z.array(Glob).default([]),
  /**
   * targeted: log'lar yalnız hedefli okunur (tail N / regex).
   * "Logları oku" gibi bir adım hem context'i patlatır hem sır sızdırır.
   */
  logReadPolicy: z.enum(["targeted", "full"]).default("targeted"),
  deniedTools: z.record(z.string(), z.array(z.string())).default({}),
  /** Bu desenlere uyan kabuk komutları reddedilir (regex). */
  deniedBashPatterns: z.array(z.string()).default([]),
});

// ── limits ───────────────────────────────────────────────────────────────────

export const LimitsSchema = z.object({
  /** Sonsuz otonom döngü bütçe yakar — aşılırsa insan çağrılır. */
  maxLoops: z.object({
    build: z.number().int().positive().default(3),
    qa: z.number().int().positive().default(3),
    live: z.number().int().positive().default(5),
  }).prefault({}),
  askTimeoutMinutes: z.number().int().positive().default(30),
  jobTtlHours: z.number().int().positive().default(24),
});

// ── Profil ───────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Servisler üst düzeye taşınmadan ÖNCE kaydedilmiş profili yeni biçime çevirir.
 *
 * Eski biçim: servis `live.dependencies[]` içinde (`service` adıyla), klon
 * ayarı `live.cloneDb` nesnesinde (`enabled` kapısıyla), test takımının
 * servisleri takımın içinde nesne olarak. Onaylı sürümler DB'de bu biçimde
 * duruyor; okurken çevrilir, editör yeni biçimle açar, kaydedince öyle kalır.
 *
 * Aynı ad iki yerde tanımlıysa adresleri ve servis türü aynı olmalı;
 * çakışma yoksa canlı ortamın tanımı değiştirilmeden kalır.
 */
export function upgradeLegacyProfile(doc: unknown, ctx?: z.core.$RefinementCtx): unknown {
  if (!isObj(doc)) return doc;
  const live = isObj(doc["live"]) ? doc["live"] : undefined;
  const test = isObj(doc["test"]) ? doc["test"] : undefined;
  const legacyDeps = live && Array.isArray(live["dependencies"]) ? (live["dependencies"] as unknown[]) : undefined;
  const legacyClone = live && isObj(live["cloneDb"]) ? live["cloneDb"] : undefined;
  const suites = test && Array.isArray(test["suites"]) ? (test["suites"] as unknown[]) : undefined;
  const legacySuites = suites?.some((s) => isObj(s) && Array.isArray(s["services"]) && (s["services"] as unknown[]).some(isObj)) ?? false;
  if (!legacyDeps && !legacyClone && !legacySuites) return doc;

  const out: Obj = { ...doc };
  const services: unknown[] = Array.isArray(doc["services"]) ? [...(doc["services"] as unknown[])] : [];
  const add = (svc: Obj): void => {
    const name = svc["name"];
    // Adsız giriş ELENMEZ: şema onu `services.N.name` hatası olarak göstersin,
    // sessizce kaybolmasın.
    const existing = typeof name === "string" ? services.find((s): s is Obj => isObj(s) && s["name"] === name) : undefined;
    if (existing) {
      const conflicts = ["externalHost", "externalPort"].filter((key) => existing[key] !== svc[key]);
      if (conflicts.length > 0) {
        const message = `"${name}" servisinin eski tanımları çakışıyor (${conflicts.join(", ")}); canlı ortam ve test takımlarında aynı adresi ve servis türünü kullanın`;
        if (!ctx) throw new Error(message);
        ctx.addIssue({ code: "custom", path: ["services", services.indexOf(existing)], message });
      }
      return;
    }
    services.push(svc);
  };

  if (live) {
    const next: Obj = { ...live };
    if (legacyDeps) {
      const names: unknown[] = [];
      for (const d of legacyDeps) {
        if (!isObj(d)) continue;
        const { service, ...rest } = d;
        add({ name: service, ...rest });
        names.push(service);
      }
      delete next["dependencies"];
      if (next["services"] === undefined) next["services"] = names;
    }
    if (legacyClone) {
      const { enabled, ...clone } = legacyClone;
      next["cloneDb"] = enabled === true;
      const database: Obj = isObj(doc["database"]) ? { ...doc["database"] } : {};
      if (database["clone"] === undefined) database["clone"] = clone;
      out["database"] = database;
    }
    out["live"] = next;
  }
  if (test && suites && legacySuites) {
    out["test"] = {
      ...test,
      suites: suites.map((s) => {
        if (!isObj(s) || !Array.isArray(s["services"])) return s;
        const names = (s["services"] as unknown[]).map((x) => {
          if (!isObj(x)) return x;
          add(x);
          return x["name"];
        });
        return { ...s, services: names };
      }),
    };
  }
  out["services"] = services;
  return out;
}

/**
 * Eski profillerin bağlantı dizesi adı. Yalnız `connectionStringEnv` boş
 * kaydedilmiş sürümleri çevirirken kullanılır; motorda artık sabit ad yok.
 */
const LEGACY_DB_CONN_ENV = "DataSettings__DataConnectionString";

/**
 * Uygulama env'i tekilleşmeden ÖNCE kaydedilmiş profili çevirir (kararlar §38).
 *
 * Eski biçim: değişkenler `live.app.env`te, klon dizesini motor
 * `database.clone.connectionStringEnv` adına (boşsa Northwind'in adına)
 * kendiliğinden yazıyordu. Yeni biçimde ikisi de `appEnv`te: klonu kullanan
 * bir tüketici varsa o ad `$dbCloneConnectionString` değerini alır — eski
 * davranışta da motorun değeri profildekini eziyordu.
 */
export function upgradeAppEnv(doc: unknown): unknown {
  if (!isObj(doc)) return doc;
  const live = isObj(doc["live"]) ? doc["live"] : undefined;
  const app = live && isObj(live["app"]) ? live["app"] : undefined;
  const database = isObj(doc["database"]) ? doc["database"] : undefined;
  const clone = database && isObj(database["clone"]) ? database["clone"] : undefined;
  const legacyEnv = app && isObj(app["env"]) ? app["env"] : undefined;
  const legacyConn = clone && typeof clone["connectionStringEnv"] === "string" ? clone["connectionStringEnv"] : undefined;
  if (!legacyEnv && legacyConn === undefined) return doc;

  const out: Obj = { ...doc };
  const appEnv: Obj = { ...(legacyEnv ?? {}), ...(isObj(doc["appEnv"]) ? doc["appEnv"] : {}) };
  const test = isObj(doc["test"]) ? doc["test"] : undefined;
  const suites = test && Array.isArray(test["suites"]) ? (test["suites"] as unknown[]) : [];
  const usesClone = live?.["cloneDb"] === true || suites.some((s) => isObj(s) && s["cloneDb"] === true);
  if (usesClone) appEnv[legacyConn || LEGACY_DB_CONN_ENV] = "$dbCloneConnectionString";
  out["appEnv"] = appEnv;

  if (live && app) {
    const { env: _env, ...rest } = app;
    out["live"] = { ...live, app: rest };
  }
  if (database && clone) {
    const { connectionStringEnv: _conn, ...rest } = clone;
    out["database"] = { ...database, clone: rest };
  }
  return out;
}

/**
 * Eski biçim: `live.browserTest.credentials` düz ad → değer tablosuydu, rol
 * yoktu. Tek hesaba çevrilir; insan rolü ve açıklamayı editörde yazar.
 */
export function upgradeBrowserCredentials(doc: unknown): unknown {
  if (!isObj(doc)) return doc;
  const live = isObj(doc["live"]) ? doc["live"] : undefined;
  const bt = live && isObj(live["browserTest"]) ? live["browserTest"] : undefined;
  if (!bt || !("credentials" in bt)) return doc;
  const { credentials, ...rest } = bt;
  const accounts = Array.isArray(rest["accounts"]) ? [...(rest["accounts"] as unknown[])] : [];
  if (isObj(credentials) && Object.keys(credentials).length > 0) accounts.push({ role: "varsayılan", description: "", credentials });
  return { ...doc, live: { ...live, browserTest: { ...rest, accounts } } };
}

/**
 * Takım uygulama env'ini (`appEnv`) alır mı? Servis ya da klon isteyen takım
 * uygulamanın kendisini koşturur; canlı ortamla AYNI değişkenleri görmeli.
 * Bağımlılıksız birim takımı uygulama yapılandırmasına bağlanmaz.
 */
export function suiteUsesAppEnv(suite: { services: string[]; cloneDb: boolean }): boolean {
  return suite.services.length > 0 || suite.cloneDb;
}

export const ProjectProfileObjectSchema = z.object({
  version: z.literal(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "küçük harf, rakam ve tire"),
  name: z.string().min(1),
  workspace: WorkspaceSchema,
  exec: ExecSchema,
  build: BuildSchema,
  /** Canlı ortam ve test takımlarının ortak servisleri; tüketiciler adla başvurur. */
  services: z.array(ServiceSchema).default([]),
  /**
   * Uygulamanın ortam değişkenleri — canlı ortam ve servis/klon isteyen test
   * takımları AYNI tablodan beslenir (kararlar §38). Eskiden canlı ortam
   * `live.app.env`i, test takımı kendi `command.env`ini okuyordu; aynı
   * uygulama iki ayrı yapılandırmayla koşuyordu.
   *
   * Değerlerde yer tutucular geçerli (bkz. placeholders.ts):
   *
   *     DataSettings__DataConnectionString: "$dbCloneConnectionString"
   *     REDIS__KEYPREFIX: "northwind:$runId:"
   *
   * Motor hiçbir sabit ada kendiliğinden yazmaz; klon dizesi yalnız
   * `$dbCloneConnectionString` yazılan değişkenlere gider. Klon açılmamış bir
   * bağlamda bu yer tutucu çözülemez ve ortam KURULMAZ (takım kırmızı, canlı
   * ortam hata). Tanınmayan `$ad` dokunulmadan kalır — parolalar `$` taşıyabiliyor.
   */
  appEnv: z.record(z.string(), z.string()).default({}),
  test: TestSchema.prefault({}),
  live: LiveSchema.optional(),
  database: DatabaseSchema.prefault({}),
  git: GitSchema.prefault({}),
  tracker: TrackerSchema.prefault({}),
  release: ReleaseSchema.prefault({}),
  workflow: WorkflowSchema.prefault({}),
  agents: AgentsSchema.prefault({}),
  security: SecuritySchema.prefault({}),
  limits: LimitsSchema.prefault({}),
});

/** Eski biçimi okurken çevirir (bkz. `upgradeLegacyProfile`, `upgradeAppEnv`, `upgradeBrowserCredentials`). */
export const ProjectProfileSchema = z.preprocess(
  // Sıra önemli: servis geçişi eski `live.cloneDb` nesnesini
  // `database.clone`a taşır, env geçişi `connectionStringEnv`i oradan okur.
  (doc, ctx) => upgradeBrowserCredentials(upgradeAppEnv(upgradeLegacyProfile(doc, ctx))),
  ProjectProfileObjectSchema,
);

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type BuildStep = z.infer<typeof BuildStepSchema>;
export type PackageSource = z.infer<typeof PackageSourceSchema>;
export type TestSuite = z.infer<typeof TestSuiteSchema>;
export type Live = z.infer<typeof LiveSchema>;
