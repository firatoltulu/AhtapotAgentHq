/**
 * Profil metinlerinde iş kimliği yer tutucuları.
 *
 * Canlı ortamda izolasyon KONTEYNER düzeyinde değil AD düzeyinde sağlanıyor
 * (`profile.ts:ServiceSchema.externalHost` yorumuna bakın): dış Postgres,
 * Redis ve Elasticsearch işler arasında paylaşılıyor, her iş kendi veritabanı
 * adını, kendi `KeyPrefix`ini ve kendi index önekini kullanıyor. Bu adların
 * profilde SABİT yazılması mümkün değil — iş kimliği koşu anında doğuyor.
 *
 * Eskiden yalnız bağlantı dizesi (`DataSettings__DataConnectionString`)
 * orkestratör tarafından üretiliyordu; geri kalan her şey elle ve sabit
 * yazılıyordu, dolayısıyla iki iş aynı Redis anahtarlarını ve aynı Elastic
 * index'ini paylaşıyordu. Yer tutucu bunu profilin kendi diliyle çözer:
 *
 *     REDIS__KEYPREFIX: "northwind:$jobIdShort:"
 *     ELASTIC__INDEXPREFIX: "northwind-$jobIdShort-"
 *
 * Desteklenen adlar:
 *
 * | Yer tutucu      | Örnek çıktı                            |
 * |-----------------|----------------------------------------|
 * | `$jobId`        | `01a0c00e-2732-778a-b9d9-ec340e1b8dff` |
 * | `$jobIdShort`   | `01a0c00eec340e1b8dff`                 |
 * | `$jobIdSql`     | `x01a0c00e_2732_778a_b9d9_ec340e1b8dff`|
 * | `$runId`        | canlıda `$jobIdShort`; testte koşuya özel (`…_b_<takım>` / `…_r_<takım>`) |
 * | `$dbCloneConnectionString` | o bağlamın DB klonunun bağlantı dizesi |
 *
 * `$runId` ve `$dbCloneConnectionString` uygulama env'i (`appEnv`) içindir:
 * aynı değişkenler hem canlı ortamı hem entegrasyon takımlarını besler
 * (kararlar §38), değerleri bağlama göre değişir. Redis öneki `$jobIdShort`
 * ile yazılırsa canlı ortam ile aynı işin testi aynı anahtarları paylaşır;
 * `$runId` ile yazılırsa ayrışır.
 *
 * `$jobIdShort` ZAMAN ÖNEKİ + RASTGELE KUYRUK'tur, yalnız ilk segment DEĞİL.
 *
 * ÖLÇÜLDÜ (2026-09-21): art arda üretilen altı UUIDv7'nin ilk segmenti AYNI
 * çıktı (`01a0c0db`) ve ancak ~20 saniye sonra değişti. O segment milisaniye
 * zaman alanının yalnız üst bitlerini taşır ve yaklaşık 65 saniye sabit kalır;
 * izolasyon anahtarı yapmak, aynı dakika içinde açılan iki işin aynı Redis
 * `KeyPrefix`ini ve aynı Elastic index'ini paylaşması demekti — yer tutucunun
 * ÖNLEMEK İÇİN var olduğu durumun ta kendisi. UUIDv7'nin son segmenti
 * rastgeledir; ikisi birleşince ad hem sıralı (zaman öneki başta) hem
 * benzersiz olur.
 */

const NAMES = "jobId|jobIdShort|jobIdSql|runId|dbCloneConnectionString";
/** `${ad}` ve `$ad` — ikisi de kabul edilir; süslü biçim sınır belirsizliğini çözer. */
const PLACEHOLDER = new RegExp(`\\$\\{(${NAMES})\\}|\\$(${NAMES})\\b`, "g");

/** Klonun bağlantı dizesi; uygulama env'inde hangi değişkene gideceğini profil söyler. */
export const DB_CLONE_PLACEHOLDER = "dbCloneConnectionString";

/**
 * Yer tutucuların çözüldüğü bağlam. `runId` yoksa `$jobIdShort`a eşittir
 * (canlı ortam). `dbCloneConnectionString` yalnız klon açılmışsa vardır;
 * yoksa yer tutucu ÇÖZÜLMEZ ve `unresolvedPlaceholders` onu bildirir.
 */
export interface PlaceholderContext {
  jobId: string;
  runId?: string;
  dbCloneConnectionString?: string;
}

/**
 * İş kimliğinden türeyen değerler.
 *
 * `$jobIdSql` SQL tanımlayıcısı için güvenli biçimdir (tire yok, harfle
 * başlar) — sunucudaki `sqlIdent` ile AYNI kuralı uygular; ikisi ayrışırsa
 * klon adı ile bağlantı dizesindeki ad tutmaz.
 */
export function jobIdValues(jobId: string): { jobId: string; jobIdShort: string; jobIdSql: string } {
  const cleaned = jobId.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  // Zaman öneki + rastgele kuyruk (bkz. modül başı: ilk segment tek başına
  // ~65 saniye sabit). Tiresiz bir kimlik geldiğinde (test sabitleri, elle
  // açılmış iş) kimliğin kendisi kullanılır — boş dize üretmek sessizce
  // çakışan adlara yol açardı.
  const parts = jobId.split("-");
  const head = parts[0] ?? "";
  const tail = parts.length > 1 ? parts[parts.length - 1] ?? "" : "";
  return {
    jobId,
    jobIdShort: head + tail || jobId,
    jobIdSql: /^[a-z]/.test(cleaned) ? cleaned : `x${cleaned}`,
  };
}

/**
 * Metindeki yer tutucuları çözer. Bilinmeyen `$ad` DOKUNULMADAN kalır —
 * kabuk değişkenleri ve parolalar profilde `$` içerebiliyor, tanımadığımız
 * her şeyi boşa çevirmek onları sessizce siler.
 */
export function resolveJobPlaceholders(text: string, jobId: string): string {
  return resolvePlaceholders(text, { jobId });
}

function placeholderValues(ctx: PlaceholderContext): Record<string, string> {
  const ids = jobIdValues(ctx.jobId);
  return {
    ...ids,
    runId: ctx.runId ?? ids.jobIdShort,
    ...(ctx.dbCloneConnectionString !== undefined ? { [DB_CLONE_PLACEHOLDER]: ctx.dbCloneConnectionString } : {}),
  };
}

/** `resolveJobPlaceholders`in tam bağlamlı hâli; değeri olmayan yer tutucu olduğu gibi kalır. */
export function resolvePlaceholders(text: string, ctx: PlaceholderContext): string {
  const values = placeholderValues(ctx);
  return text.replace(PLACEHOLDER, (whole, braced?: string, bare?: string) => values[braced ?? bare ?? ""] ?? whole);
}

/** Bir env haritasının tüm DEĞERlerinde yer tutucuları çözer (anahtarlar dokunulmaz). */
export function resolveEnvPlaceholders(
  env: Record<string, string>,
  ctx: string | PlaceholderContext,
): Record<string, string> {
  const c = typeof ctx === "string" ? { jobId: ctx } : ctx;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = resolvePlaceholders(v, c);
  return out;
}

/** Değerlerde geçen yer tutucu adları (tekrarsız). */
export function placeholdersIn(env: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const v of Object.values(env)) {
    for (const m of v.matchAll(PLACEHOLDER)) found.add(m[1] ?? m[2] ?? "");
  }
  found.delete("");
  return [...found];
}

/**
 * Bağlamda değeri OLMAYAN yer tutucular. Bugün yalnız
 * `$dbCloneConnectionString` eksik kalabilir (klon açılmamış). Çağıran bunu
 * kurulum hatası sayar: çözülmemiş metin uygulamaya bağlantı dizesi diye
 * gitseydi hata DB sürücüsünün ayrıştırma mesajına gömülürdü.
 */
export function unresolvedPlaceholders(env: Record<string, string>, ctx: PlaceholderContext): string[] {
  const values = placeholderValues(ctx);
  return placeholdersIn(env).filter((n) => values[n] === undefined);
}

/** Değeri klon bağlantısını taşıyan env anahtarları. */
export function dbCloneEnvKeys(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, v]) => placeholdersIn({ v }).includes(DB_CLONE_PLACEHOLDER))
    .map(([k]) => k);
}
