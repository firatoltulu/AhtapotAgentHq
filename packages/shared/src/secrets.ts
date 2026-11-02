/**
 * Sır maskeleme.
 *
 * DB'ye ya da WebSocket'e giden HER metin buradan geçer. Log'lar kalıcı olarak
 * saklandığı ve UI'da gösterildiği için bu bir sigorta değil, zorunluluktur.
 *
 * Desenler önek tabanlıdır: tam biçimi bilinmeyen bir token bile öneki
 * tanındığında maskelenir. Önek + ilk 4 karakter bırakılır ki hangi anahtarın
 * kullanıldığı ayırt edilebilsin (teşhis için gerekli).
 */

interface SecretPattern {
  readonly re: RegExp;
  readonly replace: string;
}

const PATTERNS: readonly SecretPattern[] = [
  // Anthropic: sk-ant-api03-..., sk-ant-oat01-...
  { re: /(sk-ant-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, replace: "$1***" },
  // GitHub: ghp_, gho_, ghu_, ghs_, ghr_
  { re: /(gh[pousr]_)[A-Za-z0-9]{4}[A-Za-z0-9]*/g, replace: "$1***" },
  // AWS erişim anahtarı
  { re: /(AKIA)[A-Z0-9]{8,}/g, replace: "$1***" },
  // Genel bearer token
  { re: /(Bearer\s+[A-Za-z0-9_-]{4})[A-Za-z0-9._-]+/gi, replace: "$1***" },
  // JWT — üç bölümlü; Northwind'in .run/at.txt dosyasındaki gibi
  { re: /(eyJ[A-Za-z0-9_-]{4})[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: "$1***" },
  // Ortam değişkeni biçimi: NPM_TOKEN_SIRKET=..., GITHUB_TOKEN: ...
  // Ad BÜYÜK harf ve tam kelime: `MAX_TOKENS=4096` gibi ayarlar eşleşmez.
  // `.env` içeriği araç sonucunda ve mentor soru dosyasında görülebiliyor.
  //
  // Önce tırnaklı değer, kapanış tırnağına kadar: `PASSWORD="abcd gizli
  // ifade"` boşlukta durulsaydı "gizli ifade" açıkta kalırdı. Sonra tırnaksız
  // değer, boşluğa kadar. İkinci desen birincinin çıktısını (`abcd***`)
  // aynen bırakır.
  {
    re: /\b((?:[A-Z][A-Z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)(?:_[A-Z0-9]+)*\s*[=:]\s*)(["'])([^"'\n]{4})[^"'\n]*\2/g,
    replace: "$1$2$3***$2",
  },
  {
    re: /\b((?:[A-Z][A-Z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)(?:_[A-Z0-9]+)*\s*[=:]\s*["']?)([^\s"';]{4})[^\s"';]*/g,
    replace: "$1$2***",
  },
  // Bağlantı dizesindeki parola
  { re: /((?:Password|Pwd)\s*=\s*)(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|[^;"\s]+)/gi, replace: "$1***" },
  // URL içindeki kimlik: scheme://user:pass@host
  { re: /(:\/\/[^:@/\s]+:)[^@/\s]+@/g, replace: "$1***@" },
  // Parolasız http(s) kimliği: https://TOKEN@host — GitLab/oauth2 token'ları
  // bilinen bir önek taşımıyor. ssh'taki `git@` kullanıcı adı sır değil,
  // o yüzden yalnız http(s).
  { re: /(https?:\/\/)[^:@/\s]+@/gi, replace: "$1***@" },
];

/**
 * Biçimi olmayan, değeri bilinen sırlar — profildeki test kullanıcısının
 * parolası gibi. Desenlerin hiçbiri düz bir parolayı tanımaz; değer burada
 * kayıtlıysa geçtiği her yerde maskelenir. Süreç ömrü boyunca kalır.
 */
const KNOWN_VALUES = new Set<string>();

/**
 * Kısa değer kaydedilmez: 3 harflik bir "parola" her metindeki aynı harf
 * dizisini maskeler ve log'u okunmaz kılar.
 */
const MIN_KNOWN_LENGTH = 6;

export function registerSecretValues(values: Iterable<string>): void {
  for (const v of values) if (v.length >= MIN_KNOWN_LENGTH) KNOWN_VALUES.add(v);
}

/** Metindeki bilinen sır biçimlerini maskeler. */
export function scrubSecrets(input: string): string {
  let out = input;
  // Desenlerden ÖNCE: bir desen değerin bir kısmını `***`e çevirirse kalan
  // parça artık kayıtlı değerle eşleşmez ve açıkta kalır.
  for (const v of KNOWN_VALUES) if (out.includes(v)) out = out.replaceAll(v, "***");
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Log kuyruğu — hem boyutu sınırlar hem maskeler.
 *
 * Northwind'de `.run/host.log` 1.5 MB, `dummy-host.log` 3.4 MB: naif bir "logları
 * oku" adımı hem bağlamı patlatır hem sır sızdırır. Okuma daima hedeflidir.
 */
export function logTail(input: string, maxBytes = 200_000): string {
  const tail = input.length > maxBytes ? input.slice(-maxBytes) : input;
  return scrubSecrets(tail);
}

/**
 * Bir metnin sır taşıyıp taşımadığını söyler (maskelemeden).
 * Testlerde ve "sızdı mı" denetiminde kullanılır.
 */
export function containsSecret(input: string): boolean {
  return PATTERNS.some(({ re }) => {
    // Global regex'lerin lastIndex durumu paylaşılmasın.
    const probe = new RegExp(re.source, re.flags.replace("g", ""));
    return probe.test(input);
  });
}
