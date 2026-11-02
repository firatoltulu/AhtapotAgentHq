import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) — HMAC-SHA1, 30 sn, 6 hane.
 *
 * Bağımlılık yerine elle: algoritma otuz satır ve Google Authenticator,
 * Microsoft Authenticator, 1Password gibi uygulamaların hepsi yalnız bu
 * varsayılanları güvenilir biçimde destekliyor (SHA256/8 hane URI'de
 * yazılsa bile bazıları sessizce yok sayıyor, kod hiç uymuyor).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/**
 * Kabul penceresi: ±1 adım. Telefon saati birkaç saniye kayabiliyor ve
 * kullanıcı kodu adım sınırında yazıyor; daha geniş pencere kaba kuvvet
 * yüzeyini büyütür.
 */
const WINDOW = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("geçersiz base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bit — RFC 4226'nın önerdiği HMAC-SHA1 anahtar uzunluğu. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return bin.toString().padStart(DIGITS, "0");
}

/** Kullanıcının yazdığı kodu temizler — "123 456" ve "123-456" kabul. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

/**
 * Kodu doğrular ve eşleşen ADIMI döndürür; uymazsa `null`.
 *
 * `afterStep`: son kabul edilen adım. Ondan küçük ya da eşit adımlar
 * reddedilir — aynı kod ikinci kez kullanılamaz.
 */
export function verifyTotp(secret: string, code: string, afterStep: number, nowMs = Date.now()): number | null {
  const given = normalizeCode(code);
  if (!/^\d{6}$/.test(given)) return null;
  const now = currentStep(nowMs);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (step <= afterStep) continue;
    const expected = totpAt(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

/** Kimlik doğrulayıcı uygulamanın okuyacağı URI. */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
