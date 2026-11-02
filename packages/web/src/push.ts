import { api } from "./api";

/**
 * Tarayıcı tarafı Web Push: service worker kaydı + abonelik.
 *
 * Kısıtlar (tarayıcı gerçekleri, bizim tercihimiz değil):
 *  - Güvenli bağlam şart: HTTPS ya da `localhost`. Düz HTTP'de LAN IP'si ile
 *    açılan sayfada `PushManager` hiç yok.
 *  - iOS/iPadOS 16.4+: yalnız "Ana Ekrana Ekle" ile kurulmuş PWA'da; Safari
 *    sekmesinde `PushManager` tanımsız.
 *  - İzin isteği bir kullanıcı hareketinden (tık) gelmeli; sayfa açılışında
 *    sormak tarayıcıların çoğunda sessizce reddediliyor.
 */

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: string };

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) {
    return { ok: false, reason: "Bildirim için HTTPS gerekli (ya da localhost). Sunucuyu Traefik/HTTPS üzerinden açın." };
  }
  if (!("serviceWorker" in navigator)) return { ok: false, reason: "Bu tarayıcı service worker desteklemiyor." };
  if (!("PushManager" in window)) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return {
      ok: false,
      reason: ios
        ? "iPhone/iPad'de önce Paylaş → Ana Ekrana Ekle ile uygulamayı kurun, sonra oradan açıp bildirimi etkinleştirin."
        : "Bu tarayıcı Web Push desteklemiyor.",
    };
  }
  return { ok: true };
}

/** VAPID açık anahtarı base64url → `applicationServerKey`. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** Bu cihazın mevcut aboneliği (yoksa `null`). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupport().ok) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<void> {
  const support = pushSupport();
  if (!support.ok) throw new Error(support.reason);

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Bildirim izni verilmedi. Tarayıcı ayarlarından bu site için bildirimlere izin verin.");
  }

  const { publicKey } = await api.pushStatus();
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // Sunucu VAPID anahtarı değiştiyse (yeni DB) eski abonelik geçersiz: yenile.
  const key = urlBase64ToUint8Array(publicKey);
  const current = sub?.options.applicationServerKey;
  if (sub && current && !sameKey(new Uint8Array(current), key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("tarayıcı eksik abonelik döndürdü");
  await api.pushSubscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint);
  await sub.unsubscribe();
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
