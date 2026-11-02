/**
 * Issue gövdesindeki GitHub ek görselleri.
 *
 * GitHub sürüklenip bırakılan görseli `<img width=… src=…>` olarak, elle
 * yazılanı `![alt](url)` olarak saklar. UI ikisini de gösterir; Planner ise
 * yalnız metni görür — görsel indirilip `resources/`e konmazsa ekran
 * görüntüsünün içeriği plana hiç girmez (yaşandı).
 */

/**
 * GitHub'ın ek görsel sunucuları — tam ad eşleşmesi. `*.githubusercontent.com`
 * soneki kullanıcı içeriği de barındırır (`raw.`, gist); güvenilmez gövde
 * oradan keyfi bir dosyayı sunucuya indirtebilir ya da UI'da izleme pikseli
 * olarak yükletebilirdi.
 */
const ATTACHMENT_HOSTS = new Set(["user-images.githubusercontent.com", "private-user-images.githubusercontent.com"]);

/**
 * GitHub'ın kendi ek sunucusu mu. Başka adresler otomatik yüklenmez/indirilmez:
 * güvenilmez gövdedeki görsel izleme pikseli ya da iç ağ adresi olabilir.
 */
export function isGithubAttachment(src: string): boolean {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname === "github.com") return u.pathname.startsWith("/user-attachments/");
  return ATTACHMENT_HOSTS.has(u.hostname);
}

/** `<img … attr="değer">` içinden tek bir özniteliği okur (tırnaklı ya da çıplak). */
export function htmlAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * Markdown'ın kod OLMAYAN parçalarını `fn`den geçirir; çitli bloklar ve satır
 * içi kod olduğu gibi kalır — oradaki `<img>` örnektir, ek değil.
 *
 * Çit CommonMark'taki gibi: ``` ya da ~~~, en az üç; blok yalnız AYNI karakterden
 * en az aynı uzunlukta bir satırla kapanır (```` içindeki ``` bloğu kapatmaz).
 * Kapanmamış çit belgenin sonuna kadar koddur.
 */
export function mapOutsideCode(md: string, fn: (text: string) => string): string {
  const out: string[] = [];
  let buf: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  const flush = () => {
    if (buf.length > 0) out.push(mapOutsideInlineCode(buf.join(""), fn));
    buf = [];
  };
  for (const line of md.split(/(?<=\n)/)) {
    if (fence) {
      out.push(line);
      const close = /^ {0,3}(`+|~+)[ \t]*\r?\n?$/.exec(line)?.[1];
      if (close && close[0] === fence.ch && close.length >= fence.len) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) {
      flush();
      fence = { ch: open[0]!, len: open.length };
      out.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.join("");
}

/** Satır içi kod: n ters tırnakla açılan aralık yine tam n ters tırnakla kapanır. */
function mapOutsideInlineCode(text: string, fn: (text: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/(`+)[\s\S]*?(?<!`)\1(?!`)/g)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Gövdedeki GitHub ek görsellerinin adresleri, ilk görünüş sırasıyla, tekrarsız. */
export function githubImageUrls(md: string): string[] {
  const urls: string[] = [];
  mapOutsideCode(md, (part) => {
    // Tek geçiş: iki biçim gövdedeki sırayla toplanır ki indirilen dosyaların
    // numarası metindeki sırayla örtüşsün.
    for (const m of part.matchAll(/<img\b[^>]*>|!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/gi)) {
      const src = m[1] ?? htmlAttr(m[0], "src");
      if (src && isGithubAttachment(src) && !urls.includes(src)) urls.push(src);
    }
    return part;
  });
  return urls;
}
