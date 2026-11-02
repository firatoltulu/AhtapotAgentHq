import { z } from "zod";

/**
 * Kullanıcı doğrulama ve bildirim sözleşmeleri.
 *
 * Giriş adımları yapılandırmadan TÜRER, sabit değildir: yönetici token'ı
 * tanımlıysa önce o sorulur, TOTP bağlıysa ardından kod. İkisi de yoksa
 * sunucu korumasızdır (yalnız loopback'te kabul edilebilir) ve adım listesi
 * boştur. Böylece UI "hangi ekranı göstereyim" sorusunu tek bir alandan
 * (`next`) cevaplar, kuralı kendisi yeniden yazmaz.
 */

export const AuthStepSchema = z.enum(["token", "totp"]);
export type AuthStep = z.infer<typeof AuthStepSchema>;

export const AuthStatusSchema = z.object({
  /** Bu istemci API'yi kullanabilir mi. */
  authenticated: z.boolean(),
  /** Sıradaki giriş adımı; oturum açıksa ya da doğrulama yoksa `null`. */
  next: AuthStepSchema.nullable(),
  /** Sunucuda yönetici token'ı tanımlı mı. */
  tokenConfigured: z.boolean(),
  /** TOTP bağlı (kurulumu onaylanmış) mı. */
  totpEnabled: z.boolean(),
  /**
   * Hiçbir faktör yok: sunucu herkese açık. UI bunu uyarı olarak gösterir —
   * sessiz kalmak "korunuyorum" yanılgısı üretir.
   */
  open: z.boolean(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const LoginBodySchema = z.object({
  token: z.string().min(1).max(4096),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

/** 6 haneli TOTP kodu; kullanıcı boşlukla yazabilir, sunucu temizler. */
export const TotpCodeBodySchema = z.object({
  code: z.string().min(6).max(12),
});
export type TotpCodeBody = z.infer<typeof TotpCodeBodySchema>;

export const TotpSetupSchema = z.object({
  /** Base32 sır — kamera okuyamazsa elle girilir. */
  secret: z.string(),
  /** `otpauth://totp/...` */
  uri: z.string(),
  /** QR kodu, `data:image/svg+xml;base64,...` — `<img>` ile gösterilir, HTML enjekte edilmez. */
  qrDataUrl: z.string(),
});
export type TotpSetup = z.infer<typeof TotpSetupSchema>;

// ── Bildirim ─────────────────────────────────────────────────────────────────

/** Tarayıcının `PushSubscription.toJSON()` çıktısı. */
export const PushSubscriptionBodySchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBodySchema>;

export const PushStatusSchema = z.object({
  /** VAPID açık anahtarı — `pushManager.subscribe` için. */
  publicKey: z.string(),
  /** Kayıtlı cihaz sayısı. */
  subscriptions: z.number().int().nonnegative(),
  /** ntfy kanalı yapılandırılmış mı (sunucu tarafı, abonelik gerektirmez). */
  ntfy: z.boolean(),
});
export type PushStatus = z.infer<typeof PushStatusSchema>;

/**
 * Push yükü — service worker bunu gösterir. Sır taşımaz: metin maskelenmiş
 * ve kısaltılmıştır, ayrıntı uygulamada okunur.
 */
export const PushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  /** Tıklanınca açılacak uygulama içi yol (`/jobs/<id>`). */
  url: z.string(),
  /** Aynı etiketli bildirim bir öncekinin yerini alır — aynı kapı için yığılma olmaz. */
  tag: z.string(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
