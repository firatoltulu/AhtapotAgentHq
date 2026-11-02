import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { githubImageUrls, isGithubAttachment } from "@ahtapot/shared";

/**
 * Issue gövdesindeki GitHub ek görsellerini işin `resources/` dizinine indirir.
 *
 * Planner'da WebFetch açık ama bu görselleri göremez: özel repoda
 * `user-attachments` adresi oturum ister (kimliksiz istek 404), açık repoda
 * da WebFetch görseli modele görsel olarak vermez, metne çevirir. İndirme
 * host'ta, `gh` kimliğiyle yapılır; dosya konteynere salt okunur bağlanır ve
 * agent `Read` ile açar — UI'dan yüklenen eklerle aynı yol.
 */

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Ekran görüntüsü birkaç MB'ı geçmez; sınır, gövdedeki yanlış bir bağlantının diski doldurmaması için. */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 20;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

export interface IssueImageResult {
  /** `resources/` köküne göre dosya adları, gövdedeki sırayla. */
  saved: string[];
  failed: { url: string; reason: string }[];
}

export async function downloadIssueImages(
  body: string,
  dir: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IssueImageResult> {
  const urls = githubImageUrls(body);
  const result: IssueImageResult = { saved: [], failed: [] };
  if (urls.length === 0) return result;
  await mkdir(dir, { recursive: true });

  for (const [i, url] of urls.entries()) {
    if (i >= MAX_IMAGES) {
      result.failed.push({ url, reason: `en fazla ${MAX_IMAGES} görsel indirilir` });
      continue;
    }
    try {
      const { bytes, mime } = await fetchImage(url, token, fetchImpl);
      // Ad gövdedeki sırayı taşır: Planner "ikinci ekran görüntüsü"nü
      // metindeki ikinci bağlantıyla eşleyebilsin.
      const name = `issue-${String(i + 1).padStart(2, "0")}.${EXT_BY_MIME[mime]}`;
      await writeFile(join(dir, name), bytes);
      result.saved.push(name);
    } catch (err) {
      result.failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Yönlendirme hedefi GitHub'ın ek deposu mu. `user-attachments` imzalı bir
 * CDN/S3 adresine yönlendirir; başka bir yere giden yönlendirme izlenmez —
 * sunucu host'ta koşuyor, iç ağ adresine istek atmamalı.
 */
function trustedHop(url: string): boolean {
  if (isGithubAttachment(url)) return true;
  const u = new URL(url);
  if (u.protocol !== "https:") return false;
  return u.hostname === "objects.githubusercontent.com"
    || /^github-production-user-asset-[a-z0-9]+\.s3\.amazonaws\.com$/.test(u.hostname);
}

async function fetchImage(url: string, token: string, fetchImpl: typeof fetch): Promise<{ bytes: Buffer; mime: string }> {
  // Yönlendirme elle izlenir: token YALNIZ github.com'a gider. `user-attachments`
  // imzalı bir S3/CDN adresine yönlendirir; oraya Authorization giderse hem
  // token sızar hem imzalı istek "tek kimlik yöntemi" diye reddedilebilir.
  // Süre tüm zincire tek: adım başına süre, 20 görselde isteği dakikalarca tutardı.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!trustedHop(current)) throw new Error(`güvenilmeyen adres: ${new URL(current).host}`);
    const headers: Record<string, string> = { Accept: "image/*" };
    if (token && new URL(current).hostname === "github.com") headers["Authorization"] = `token ${token}`;
    const res = await fetchImpl(current, { headers, redirect: "manual", signal });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`HTTP ${res.status}, Location yok`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 && !token ? " (gh oturumu yok — özel repo görseli kimlik ister)" : ""}`);

    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!EXT_BY_MIME[mime]) throw new Error(`görsel değil: ${mime || "içerik türü yok"}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) throw new Error(`çok büyük: ${declared} bayt`);
    return { bytes: await readCapped(res), mime };
  }
  throw new Error(`${MAX_REDIRECTS}'ten fazla yönlendirme`);
}

/** Gövdeyi parça parça okur; `content-length` yalan söylese de sınırda keser. */
async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`çok büyük: ${MAX_BYTES} baytı aştı`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
