import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { eq, isNotNull, lt, ne } from "drizzle-orm";
import QRCode from "qrcode";

import { BRAND, type AuthStatus, type TotpSetup } from "@ahtapot/shared";

import { newId, schema, type Db } from "../db/index.js";
import { generateSecret, otpauthUri, verifyTotp } from "./totp.js";

/**
 * Kullanıcı doğrulama — tek kullanıcı, en fazla iki faktör.
 *
 * Faktörler yapılandırmadan türer: `AHTAPOT_ADMIN_TOKEN` tanımlıysa ilk adım
 * token, TOTP bağlıysa ikinci adım kod. Ne biri ne öteki varsa sunucu
 * açıktır (Faz 1'in loopback varsayımı) ve bu durum UI'da uyarı olarak görünür.
 *
 * ESKİ KURGUNUN KUSURLARI (bu modülün gerekçesi):
 *  1. `onRequest` kancası statik dosyaları da koruyordu: token tanımlıyken
 *     tarayıcı `/` isteğinde 401 JSON alıyor, token girilecek ekran hiç
 *     yüklenmiyordu.
 *  2. Tarayıcı WebSocket'i başlık gönderemediği için `/ws` her zaman 401
 *     alıyordu — canlı akış token tanımlıyken hiç çalışmıyordu.
 *  3. Token `localStorage`'daydı: sayfaya enjekte edilen her betik okuyabilir.
 * Oturum HttpOnly çerezde; betik göremez, REST ve WS'e aynı yoldan gider.
 */

export const SESSION_COOKIE = `${BRAND.slug}_session`;

/** Token doğrulandı, kod bekleniyor: bu kadar sürede tamamlanmazsa baştan. */
const PENDING_TTL_MS = 5 * 60_000;
/**
 * `lastSeenAt` her istekte yazılmaz — yalnız bu kadar eskidiyse. UI 5 sn'de
 * bir yokluyor; her istekte UPDATE, SQLite'ı gereksiz yere yazma kilidine sokar.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Kaba kuvvet freni: IP başına ardışık başarısız deneme. 6 haneli kodda ±1
 * pencere aynı anda 3 kodu kabul eder; 5 deneme/dk ile beklenen isabet
 * ~46 gün. Bellekte tutulur: yeniden başlatma sayacı sıfırlar, bu kabul
 * edilmiş bir takas (kalıcı sayaç her hatalı denemede DB yazması demek).
 */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

export type AuthResult =
  | { ok: true; via: "open" | "session" | "bearer"; sessionId: string | null }
  | { ok: false; reason: string };

export class AuthError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthOptions {
  adminToken?: string | undefined;
  sessionTtlHours: number;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  // Uzunluk farkı zamanlamadan sızmasın diye iki taraf da hash'lenir.
  return timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
}

export class AuthService {
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly db: Db, private readonly opts: AuthOptions) {}

  get tokenConfigured(): boolean {
    return Boolean(this.opts.adminToken);
  }

  totpEnabled(): boolean {
    const row = this.db
      .select({ id: schema.authTotp.id })
      .from(schema.authTotp)
      .where(isNotNull(schema.authTotp.confirmedAt))
      .get();
    return row !== undefined;
  }

  /** Hiçbir faktör yoksa sunucu açıktır. */
  isOpen(): boolean {
    return !this.tokenConfigured && !this.totpEnabled();
  }

  // ── Oturum ──────────────────────────────────────────────────────────────

  private findSession(raw: string | undefined) {
    if (!raw) return undefined;
    const row = this.db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.tokenHash, hash(raw)))
      .get();
    if (!row) return undefined;
    if (row.expiresAt <= new Date().toISOString()) {
      this.db.delete(schema.authSessions).where(eq(schema.authSessions.id, row.id)).run();
      return undefined;
    }
    return row;
  }

  private createSession(stage: "pending_totp" | "full", meta: { userAgent: string; ip: string }): string {
    const raw = randomBytes(32).toString("base64url");
    const ttl = stage === "full" ? this.opts.sessionTtlHours * 3_600_000 : PENDING_TTL_MS;
    this.db
      .insert(schema.authSessions)
      .values({
        id: newId(),
        tokenHash: hash(raw),
        stage,
        userAgent: meta.userAgent.slice(0, 300),
        ip: meta.ip,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      })
      .run();
    // Süresi dolmuşlar fırsat buldukça temizlenir; ayrı bir zamanlayıcıya gerek yok.
    this.db.delete(schema.authSessions).where(lt(schema.authSessions.expiresAt, new Date().toISOString())).run();
    return raw;
  }

  /**
   * İsteği doğrular. Sıra: açık sunucu → çerez oturumu → Bearer.
   *
   * Bearer yalnız TOTP BAĞLI DEĞİLKEN geçerli (betikler, testler, CLI). TOTP
   * bağlıyken token tek başına kapıyı açsaydı ikinci faktörün anlamı kalmazdı.
   */
  authenticate(sessionToken: string | undefined, bearer: string | undefined): AuthResult {
    if (this.isOpen()) return { ok: true, via: "open", sessionId: null };

    const session = this.findSession(sessionToken);
    if (session?.stage === "full") {
      if (Date.now() - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
        this.db
          .update(schema.authSessions)
          .set({ lastSeenAt: new Date().toISOString() })
          .where(eq(schema.authSessions.id, session.id))
          .run();
      }
      return { ok: true, via: "session", sessionId: session.id };
    }

    if (bearer && this.opts.adminToken) {
      if (this.totpEnabled()) return { ok: false, reason: "iki adımlı doğrulama açık — tarayıcıdan oturum açın" };
      if (safeEqual(bearer, this.opts.adminToken)) return { ok: true, via: "bearer", sessionId: null };
    }
    return { ok: false, reason: "yetkisiz" };
  }

  status(sessionToken: string | undefined): AuthStatus {
    const tokenConfigured = this.tokenConfigured;
    const totpEnabled = this.totpEnabled();
    const open = !tokenConfigured && !totpEnabled;
    const base = { tokenConfigured, totpEnabled, open };
    if (open) return { ...base, authenticated: true, next: null };

    const session = this.findSession(sessionToken);
    if (session?.stage === "full") return { ...base, authenticated: true, next: null };
    if (session?.stage === "pending_totp") return { ...base, authenticated: false, next: "totp" };
    return { ...base, authenticated: false, next: tokenConfigured ? "token" : "totp" };
  }

  // ── Kaba kuvvet freni ───────────────────────────────────────────────────

  private checkLock(ip: string): void {
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) {
      const sec = Math.ceil((f.until - Date.now()) / 1000);
      throw new AuthError(429, `çok fazla hatalı deneme — ${sec} sn sonra tekrar deneyin`);
    }
  }

  private fail(ip: string, message: string): never {
    const f = this.failures.get(ip) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILURES) {
      f.until = Date.now() + LOCKOUT_MS;
      f.count = 0;
    }
    this.failures.set(ip, f);
    throw new AuthError(401, message);
  }

  private succeed(ip: string): void {
    this.failures.delete(ip);
  }

  // ── Giriş adımları ──────────────────────────────────────────────────────

  /**
   * Birinci adım: yönetici token'ı. TOTP bağlıysa `pending_totp` oturumu
   * döner (hiçbir API'yi açmaz), değilse tam oturum.
   */
  login(token: string, meta: { userAgent: string; ip: string }): { session: string; next: "totp" | null } {
    if (!this.opts.adminToken) throw new AuthError(400, "sunucuda yönetici token'ı tanımlı değil");
    this.checkLock(meta.ip);
    if (!safeEqual(token, this.opts.adminToken)) this.fail(meta.ip, "token hatalı");
    this.succeed(meta.ip);
    if (this.totpEnabled()) return { session: this.createSession("pending_totp", meta), next: "totp" };
    return { session: this.createSession("full", meta), next: null };
  }

  /**
   * İkinci adım: TOTP kodu. Token tanımlıysa önce `pending_totp` oturumu
   * şarttır — kod tek başına token adımını atlatamaz.
   */
  verifyLoginTotp(sessionToken: string | undefined, code: string, meta: { userAgent: string; ip: string }): string {
    this.checkLock(meta.ip);
    const row = this.confirmedTotp();
    if (!row) throw new AuthError(400, "iki adımlı doğrulama bağlı değil");

    let pendingId: string | null = null;
    if (this.tokenConfigured) {
      const session = this.findSession(sessionToken);
      if (session?.stage !== "pending_totp") throw new AuthError(401, "önce yönetici token'ı girilmeli");
      pendingId = session.id;
    }

    const step = verifyTotp(row.secret, code, row.lastStep);
    if (step === null) this.fail(meta.ip, "kod hatalı");
    this.succeed(meta.ip);
    this.db.update(schema.authTotp).set({ lastStep: step }).where(eq(schema.authTotp.id, row.id)).run();
    if (pendingId) this.db.delete(schema.authSessions).where(eq(schema.authSessions.id, pendingId)).run();
    return this.createSession("full", meta);
  }

  logout(sessionToken: string | undefined): void {
    if (!sessionToken) return;
    this.db.delete(schema.authSessions).where(eq(schema.authSessions.tokenHash, hash(sessionToken))).run();
  }

  // ── TOTP kurulumu ───────────────────────────────────────────────────────

  private confirmedTotp() {
    return this.db.select().from(schema.authTotp).where(isNotNull(schema.authTotp.confirmedAt)).get();
  }

  /**
   * Kurulumu başlatır: yeni sır üretir, onaylanmamış satırı değiştirir.
   * Bağlı bir TOTP varken yeniden kurulum yok — önce kaldırılmalı (kodla);
   * aksi hâlde oturumu ele geçiren biri ikinci faktörü kendi telefonuna taşırdı.
   */
  async beginTotpSetup(): Promise<TotpSetup> {
    if (this.totpEnabled()) throw new AuthError(409, "iki adımlı doğrulama zaten bağlı — önce kaldırın");
    const secret = generateSecret();
    this.db.delete(schema.authTotp).run();
    this.db.insert(schema.authTotp).values({ id: newId(), secret }).run();
    const uri = otpauthUri(secret, BRAND.displayName, "yönetici");
    const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, uri, qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
  }

  /**
   * Kurulumu kodla onaylar. Kodu doğru okuyamayan bir uygulama ile bağlanmış
   * TOTP, kullanıcıyı dışarıda bırakırdı — bu yüzden onaysız sır hiç sorulmaz.
   *
   * Onayda bu oturum DIŞINDAKİ bütün oturumlar kapanır: onlar yalnız token'la
   * açılmıştı, artık yeni kuralı sağlamıyorlar.
   */
  confirmTotpSetup(
    code: string,
    currentSessionId: string | null,
    meta: { userAgent: string; ip: string },
  ): string | null {
    this.checkLock(meta.ip);
    const row = this.db.select().from(schema.authTotp).get();
    if (!row) throw new AuthError(400, "önce kurulumu başlatın");
    if (row.confirmedAt) throw new AuthError(409, "iki adımlı doğrulama zaten bağlı");
    const step = verifyTotp(row.secret, code, row.lastStep);
    if (step === null) this.fail(meta.ip, "kod hatalı — uygulamadaki güncel kodu girin");
    this.succeed(meta.ip);
    this.db
      .update(schema.authTotp)
      .set({ confirmedAt: new Date().toISOString(), lastStep: step })
      .where(eq(schema.authTotp.id, row.id))
      .run();
    if (currentSessionId) {
      this.db.delete(schema.authSessions).where(ne(schema.authSessions.id, currentSessionId)).run();
      return null;
    }
    // Açık sunucuda (ya da Bearer ile) kuruldu: çağıranın elinde oturum yok.
    // Kodu az önce doğruladığı için ona tam oturum verilir — yoksa kendi
    // kurduğu kapının dışında kalırdı.
    this.db.delete(schema.authSessions).run();
    return this.createSession("full", meta);
  }

  /** Kaldırma da kod ister — açık bırakılmış bir oturum ikinci faktörü tek tıkla silemesin. */
  disableTotp(code: string, ip: string): void {
    this.checkLock(ip);
    const row = this.confirmedTotp();
    if (!row) throw new AuthError(400, "iki adımlı doğrulama bağlı değil");
    if (verifyTotp(row.secret, code, row.lastStep) === null) this.fail(ip, "kod hatalı");
    this.succeed(ip);
    this.db.delete(schema.authTotp).run();
  }

  /**
   * Telefon kaybolursa kurtarma: `AHTAPOT_RESET_2FA=1` ile açılış. Sunucuya
   * erişimi olan zaten her şeye erişebilir; bu yol yeni bir yetki açmaz.
   */
  resetTotp(): boolean {
    const had = this.db.select({ id: schema.authTotp.id }).from(schema.authTotp).get() !== undefined;
    this.db.delete(schema.authTotp).run();
    this.db.delete(schema.authSessions).run();
    return had;
  }
}

/** `Cookie` başlığından tek bir değeri okur (bağımlılık yerine: tek çerez). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * Oturum çerezi. `SameSite=Strict` başka siteden gelen isteğe (CSRF, WS
 * ele geçirme) çerezi taşıtmaz; `Secure` yalnız HTTPS'te — loopback HTTP'de
 * konursa tarayıcı çerezi hiç saklamaz.
 */
export function sessionCookie(value: string, opts: { secure: boolean; maxAgeSec: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
