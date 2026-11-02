import type Dockerode from "dockerode";

import { jobIdValues, resolveJobPlaceholders, scrubSecrets, serviceAddress, type ProjectProfile, type Service } from "@ahtapot/shared";

import { dbDependency } from "./golden.js";

/**
 * Şablon veritabanı — `CREATE DATABASE ... TEMPLATE` ile iş başına klon.
 *
 * ÖNCEKİ TASARIM (golden volume) İKİ YERDEN KIRILDI, ölçüldü 2026-09-18:
 *
 *  1. Golden yalnız Postgres kaldırıp `dotnet run -- --migrate=true` koşuyordu.
 *     O komut sadece migration koşmuyor: `Program.cs` önce Serilog'u kuruyor
 *     (Elasticsearch ister), Redis'i bağlıyor, migration'a ondan sonra geliyor.
 *     Uygulama `Program.cs:42`'de ES'e bağlanamayıp ÇIKIŞ 134 ile düştü.
 *  2. Her iş 1,4 GB'lık volume'ü kopyalıyordu — §11d'de ölçülen desenin aynısı:
 *     kopyalamak kurmaktan pahalı.
 *
 * Şimdi: şablon CANLI ORTAMIN İÇİNDE kurulur (Redis ve ES zaten ayakta, aynı
 * compose ağındalar) ve klon Postgres'in sunucu içi sayfa kopyasıdır.
 *
 * Bu modül `psql`i DB konteynerinde `docker exec` ile çağırır: host'ta bir
 * Postgres istemcisi bulunmasını beklemez.
 */

export interface TemplateDbDeps {
  docker: Dockerode;
  log?: (line: string) => void;
}

/** Şablonun adı — proje başına tek. */
export function templateDbName(slug: string): string {
  return `${sqlIdent(slug)}_golden`;
}

/** İşin kendi veritabanı. */
export function jobDbName(slug: string, jobId: string): string {
  // UUID'deki tireler SQL tanımlayıcısında geçersiz; alt çizgiye çevrilir.
  return `${sqlIdent(slug)}_job_${sqlIdent(jobId)}`;
}

/**
 * Profilin bildirdiği şablon ve klon adları.
 *
 * `database.clone.template` ve `.namePattern` (eski `live.cloneDb`) şemada vardı ama HİÇ
 * OKUNMUYORDU: adlar her durumda slug'dan türetiliyordu. Var olan bir
 * `northwind_golden`i göstermek isteyen profil yok sayılıyor, orkestratör kendi
 * şablonunu kurmaya kalkıyordu.
 *
 * Alanlar boşsa eski türetme sürer — geriye dönük uyumluluk.
 */
export function dbNamesFor(profile: ProjectProfile, jobId: string): { template: string; job: string } {
  const clone = profile.database.clone;
  const template = clone.template ? sqlIdent(clone.template) : templateDbName(profile.slug);
  const pattern = clone.namePattern;
  if (!pattern) return { template, job: jobDbName(profile.slug, jobId) };
  // `{template}` ve `{jobId}` kalıbın kendi sözdizimi (şemada belgeli).
  // `$jobIdShort` gibi yer tutucular da geçsin diye ÖNCE onlar çözülür:
  // böylece kalıpta kısa kimlik kullanılabilir (`{template}_$jobIdShort`).
  const resolved = resolveJobPlaceholders(pattern, jobId)
    .replace(/\{template\}/g, template)
    .replace(/\{jobId\}/g, sqlIdent(jobId));
  return { template, job: sqlIdent(resolved) };
}

/**
 * Test takımı koşusunun klonu — canlı ortamınkinden AYRI.
 *
 * Canlı klonun adı (`<şablon>_job_<tam kimlik>`, 54 karakter) son ek
 * almaya yetmiyor: Postgres tanımlayıcıyı 63 baytta SESSİZCE kırpar ve
 * baseline ile gerçek koşunun adları çakışırdı. Kısa kimlik + koşu türü
 * (b/r) öne alınır; takım adı en sonda, kırpılırsa o kırpılır — takımlar
 * art arda koşup klonlarını düşürdüğü için çakışma zararsız.
 */
export function suiteDbName(profile: ProjectProfile, jobId: string, suiteId: string, kind: "baseline" | "run"): string {
  const { template } = dbNamesFor(profile, jobId);
  return sqlIdent(`${template}_t_${jobIdValues(jobId).jobIdShort}_${kind === "baseline" ? "b" : "r"}_${suiteId}`).slice(0, 63);
}

/**
 * SQL tanımlayıcısı için güvenli ad.
 *
 * Değer profilden ve iş kimliğinden geliyor; doğrudan SQL'e gömülüyor (Postgres
 * `CREATE DATABASE` parametreli sorgu kabul etmez). Harf/rakam/alt çizgi dışı
 * her şey elenir ve ad bir harfle başlatılır — enjeksiyon yüzeyi kapanır.
 */
export function sqlIdent(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `x${cleaned}`;
}

export class TemplateDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateDbError";
  }
}

export class TemplateDb {
  private readonly log: (line: string) => void;

  constructor(private readonly deps: TemplateDbDeps) {
    this.log = deps.log ?? (() => {});
  }

  /**
   * DB konteynerinde `psql` koşturur ve stdout döndürür.
   *
   * `-tAX`: başlıksız, hizalamasız, `.psqlrc` okunmadan — çıktı ayrıştırılabilir
   * olsun. Parola `PGPASSWORD` ile geçer; komut satırında görünmez.
   */
  private async psql(containerId: string, sql: string, opts: { db?: string; user: string; password: string; host?: string | undefined; port?: number | undefined }): Promise<{ out: string; code: number }> {
    const container = this.deps.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: [
        "psql", "-tAX", "-U", opts.user, "-d", opts.db ?? "postgres",
        ...(opts.host ? ["-h", opts.host, "-p", String(opts.port ?? 5432)] : []),
        "-c", sql,
      ],
      Env: [`PGPASSWORD=${opts.password}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", resolve);
    });
    const info = await exec.inspect().catch(() => null);
    return { out: demuxText(Buffer.concat(chunks)).trim(), code: info?.ExitCode ?? 1 };
  }

  /** Şablon DB var mı? */
  async templateExists(containerId: string, name: string, creds: PgCreds): Promise<boolean> {
    const r = await this.psql(containerId, `SELECT 1 FROM pg_database WHERE datname = '${name}'`, creds);
    return r.code === 0 && r.out === "1";
  }

  /**
   * Şablonu düşürür. Yalnız bu işin AZ ÖNCE kurmaya başladığı ve yarım kalan
   * şablon için çağrılır; var olan bir şablon silinmez (bkz. `prepareDatabase`).
   */
  async dropTemplate(containerId: string, name: string, creds: PgCreds): Promise<void> {
    // `WITH (FORCE)`: artık bağlantı varsa da düşsün (PG 13+).
    const r = await this.psql(containerId, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, creds);
    if (r.code !== 0) throw new TemplateDbError(`şablon düşürülemedi: ${scrubSecrets(r.out)}`);
    this.log(`şablon düşürüldü: ${name}`);
  }

  /**
   * Şablonu BOŞ olarak yaratır; migration ve seed'i çağıran koşturur.
   *
   * Ayrım bilinçli: migrate/seed komutları profilden gelir ve uygulamanın
   * kendisini çalıştırır (bkz. modül başı). Bu modül SQL tarafını bilir,
   * uygulamayı değil.
   */
  async createEmptyTemplate(containerId: string, name: string, creds: PgCreds): Promise<string> {
    const r = await this.psql(containerId, `CREATE DATABASE "${name}"`, creds);
    if (r.code !== 0) throw new TemplateDbError(`şablon yaratılamadı: ${scrubSecrets(r.out)}`);
    this.log(`şablon yaratıldı (boş): ${name}`);
    return name;
  }

  /**
   * İşin DB'sini şablondan klonlar — sunucu içi sayfa kopyası.
   *
   * `TEMPLATE` kaynak DB'ye AKTİF BAĞLANTI İSTEMEZ. Uygulama hep iş DB'sine
   * bağlandığı için şablon boşta durur; yine de kurulum anıyla çakışmasın diye
   * çağıran kilit tutar.
   */
  async cloneFromTemplate(containerId: string, template: string, target: string, creds: PgCreds): Promise<string> {
    await this.psql(containerId, `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`, creds);
    const r = await this.psql(containerId, `CREATE DATABASE "${target}" TEMPLATE "${template}"`, creds);
    if (r.code !== 0) throw new TemplateDbError(`iş DB'si klonlanamadı: ${scrubSecrets(r.out)}`);
    this.log(`iş DB'si şablondan klonlandı: ${target}`);
    return target;
  }

  /** İş bitince DB'yi düşürür. */
  async dropJobDb(containerId: string, target: string, creds: PgCreds): Promise<boolean> {
    const r = await this.psql(containerId, `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`, creds);
    return r.code === 0;
  }

  /**
   * Postgres cevap veriyor mu? Compose healthcheck'ine ek, exec üzerinden.
   *
   * Hazır DEĞİLSE `psql`in söylediği sebep DÖNER. Eskiden yalnız `false`
   * dönüyordu: çağıran 120 saniye boyunca 60 kez deniyor, 60 kez sebebi
   * atıyor ve sonunda içeriksiz bir "cevap vermedi" yazıyordu. Oysa sebep
   * her denemede oradaydı — "could not translate host name", "Connection
   * refused", "password authentication failed", "psql: not found" bambaşka
   * düzeltmeler gerektiriyor ve teşhis elle `docker run` ile yapılıyordu.
   */
  async ready(containerId: string, creds: PgCreds): Promise<{ ok: true } | { ok: false; reason: string }> {
    const r = await this.psql(containerId, "SELECT 1", creds);
    if (r.code === 0 && r.out === "1") return { ok: true };
    // Çıkış 126/127: `psql` imajda yok. Bu, beklemekle GEÇMEZ — mesajda
    // ayrıca söylenir, yoksa "cevap vermedi" imaja bakmayı akla getirmiyor.
    const notFound = r.code === 126 || r.code === 127;
    const detail = r.out.split("\n").filter((l) => l.trim()).slice(-3).join(" · ");
    return {
      ok: false,
      reason: scrubSecrets(
        notFound
          ? `proje imajında \`psql\` yok (çıkış ${r.code})${detail ? `: ${detail}` : ""}`
          : detail || `psql çıkış ${r.code}, çıktı yok`,
      ),
    };
  }
}

export interface PgCreds {
  user: string;
  password: string;
  db?: string;
  /**
   * Postgres DIŞARIDA koşuyorsa adresi. Verilirse `psql` konteynerin kendi
   * soketine değil bu adrese bağlanır (`-h`/`-p`).
   *
   * Dev ortamında iş başına ikinci bir Postgres kaldırmak boşuna: izolasyon
   * ad düzeyinde sağlanıyor, klon `CREATE DATABASE ... TEMPLATE` ile
   * saniyeler içinde türüyor (ölçüldü: 150 tablo ~9 sn).
   */
  host?: string | undefined;
  port?: number | undefined;
}

function pgConnValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Uygulamanın göreceği bağlantı dizesi. Servis DIŞARIDAYSA host
 * `externalHost`, port host tarafındaki port (Northwind'de 5433); compose
 * ağındaysa servis adı ve konteynerin kendi portu (bkz. `serviceAddress`).
 */
export function pgConnString(dep: Service, database: string, creds: PgCreds): string {
  const { host, port } = serviceAddress(dep);
  return `Host=${host};Database=${database};Username=${pgConnValue(creds.user)};Password=${pgConnValue(creds.password)};Port=${port}`;
}

/**
 * Profildeki DB servisinden Postgres kimliğini çıkarır.
 *
 * `POSTGRES_USER` verilmemişse imajın varsayılanı `postgres`tur.
 */
export function pgCredsFrom(profile: ProjectProfile): PgCreds | null {
  // Servis seçimi `dbDependency` ile TEK YERDEN yapılır. Eskiden burada
  // bağımsız bir `find` vardı ve iki seçici ayrışabiliyordu: `dbDependency`
  // bir servisi, bu fonksiyon başkasını seçtiğinde `host` boş kalıyor ve
  // `psql` dış adrese hiç bağlanmıyordu.
  const dep = dbDependency(profile);
  if (!dep) return null;
  const clone = profile.database.clone;
  // Kimlik önceliği: `cloneDb` > servisin `env`i > imaj varsayılanı.
  // `cloneDb.user`/`password` DIŞ servis için tek kaynaktır — dışarıda koşan
  // bir Postgres'in kimliği compose `env`inde yazmaz (konteyner kurulmuyor).
  const user = clone.user || dep.env["POSTGRES_USER"] || "postgres";
  const password = clone.password || dep.env["POSTGRES_PASSWORD"] || "";
  return {
    user,
    password,
    ...(dep.externalHost ? { host: dep.externalHost, port: dep.externalPort ?? dep.internalPort } : {}),
  };
}

/**
 * Dış Postgres'e `psql` çalıştırmak için kısa ömürlü konteyner.
 *
 * Dışarıdaki servisin konteyneri yok; canlı ortamda uygulama konteyneri de bu
 * aşamada henüz kalkmamış (aşama 1: yalnız bağımlılıklar). Proje imajında
 * `psql` kurulu; `host-gateway` ile host'a çıkılıyor. Uyanık kalması için
 * `sleep` ile başlatılır; çağıran iş bitince kaldırır.
 */
export async function startPsqlHelper(docker: Dockerode, profile: ProjectProfile): Promise<string> {
  const c = await docker.createContainer({
    Image: profile.exec.image,
    Entrypoint: ["sh"],
    Cmd: ["-c", "sleep 900"],
    HostConfig: {
      AutoRemove: false,
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
    Labels: { "ahtapot.role": "psql-helper", "ahtapot.project": profile.slug },
  });
  await c.start();
  return c.id;
}

/** Docker exec akışı 8 baytlık çerçeve başlığı taşır; düz metne indir. */
function demuxText(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len).toString("utf8"));
    i += 8 + len;
  }
  // Çerçevesiz akış (TTY açıksa) olduğu gibi döner.
  return parts.length > 0 ? parts.join("") : buf.toString("utf8");
}
