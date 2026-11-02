/*
 * Service worker — yalnız push bildirimi.
 *
 * Önbellek YOK: UI her zaman sunucudan gelir. Çevrimdışı kabuk burada eski
 * bundle'ı canlı API'ye karşı koşturup tuhaf hatalar üretirdi; bu uygulama
 * sunucusuz bir anlam taşımıyor.
 *
 * Yük sunucuda maskelenmiş ve kısaltılmıştır (`notify/notifier.ts`).
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Bildirim", body: "", url: "/", tag: "default" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  // `userVisibleOnly: true` ile abone olundu: her push bir bildirim GÖSTERMELİ,
  // yoksa tarayıcı (özellikle iOS) aboneliği iptal ediyor.
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      // Aynı etiketli yeni bildirim sessizce değil, yeniden çalarak gelsin:
      // aynı işte ikinci kapı açıldığında insanın haberi olmalı.
      renotify: true,
      requireInteraction: true,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
