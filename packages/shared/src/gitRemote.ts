/**
 * Git remote adresinin BİÇİM denetimi — yazıldığı anda.
 *
 * Şemaya (`RepoSchema.remote`) refine olarak GİRMEDİ: onaylı profiller
 * `load()`da şemadan geçiyor ve kuralı sıkılaştırmak eskiden geçerli bir
 * profili sessizce "bad_profile" yapardı (yaşandı: `referenceRepos[].path` →
 * `gitUrl`). Denetim yazma noktalarında koşar: profil kaydı, proje açılışı,
 * "Doğrula" ve UI.
 *
 * Kabul edilen biçimler git'in kendi kabul ettikleri:
 *   https://host/owner/repo(.git) · ssh://[user@]host/path · git://host/path
 *   [user@]host:owner/repo (scp biçimi) · file:// ya da disk yolu
 * Disk yolu kabul ediliyor çünkü gerçek: Northwind.Forms'un remote'u yerel
 * bir dizin. PR açılamaz ama push/fetch çalışır.
 */

export type GitRemote =
  | {
      ok: true;
      kind: "url" | "scp" | "path";
      host: string | null;
      /** github.com remote'uysa `owner/repo`; değilse null (PR açılamaz). */
      githubSlug: string | null;
    }
  | { ok: false; reason: string };

const BAD = (reason: string): GitRemote => ({ ok: false, reason });

function githubSlugOf(host: string | null, path: string): string | null {
  if (!host || !/^(www\.)?github\.com$/i.test(host)) return null;
  const m = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(path);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function parseGitRemote(raw: string): GitRemote {
  const value = raw.trim();
  if (!value) return BAD("remote boş");
  if (/\s/.test(value)) return BAD("remote boşluk içeremez");
  // `-` ile başlayan değer git'e SEÇENEK olarak geçer (`-u` = --upload-pack,
  // komut çalıştırır). Remote hiçbir geçerli biçimde `-` ile başlamaz.
  if (value.startsWith("-")) return BAD("remote '-' ile başlayamaz");

  // Disk yolu: mutlak, göreli, ev dizini ya da Windows sürücüsü. Scp biçimiyle
  // karışmasın diye ÖNCE bakılır: `E:\x` de `host:path` gibi görünür.
  if (/^(\/|\.{1,2}[\\/]|~|[A-Za-z]:[\\/])/.test(value)) {
    return { ok: true, kind: "path", host: null, githubSlug: null };
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (scheme) {
    if (!["https", "http", "ssh", "git", "file"].includes(scheme)) return BAD(`desteklenmeyen şema: ${scheme}://`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return BAD("URL ayrıştırılamadı");
    }
    if (scheme === "file") return { ok: true, kind: "path", host: null, githubSlug: null };
    // Kural 4: kimlik remote'a yazılmaz. Profil DB'de saklanıyor ve UI'da
    // gösteriliyor; `https://ghp_…@github.com/…` biçimi token'ı ikisine de
    // taşırdı. ssh'ta kullanıcı adı (`git@`) sır değil, parola ise öyle.
    if ((scheme === "https" || scheme === "http") && (url.username || url.password)) {
      return BAD("URL kimlik bilgisi taşıyor; token remote'a yazılmaz (kimlik gh oturumundan gelir)");
    }
    if (url.password) return BAD("URL parola taşıyor");
    if (!url.hostname) return BAD("host yok");
    const path = url.pathname.replace(/^\/+/, "");
    if (!path) return BAD("repo yolu yok");
    return { ok: true, kind: "url", host: url.hostname, githubSlug: githubSlugOf(url.hostname, path) };
  }

  // scp biçimi: [user@]host:path — `//` ile devam etmez (o bir şema olurdu).
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(value);
  if (scp) {
    const host = scp[1]!;
    return { ok: true, kind: "scp", host, githubSlug: githubSlugOf(host, scp[2]!) };
  }

  return BAD("tanınmayan biçim — https://host/owner/repo, git@host:owner/repo, ssh:// ya da disk yolu");
}
