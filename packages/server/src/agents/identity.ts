import { existsSync, readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { newId, type Db, schema } from "../db/index.js";

/**
 * Claude kimlik havuzu.
 *
 * Bir anahtar kotaya girdiğinde iş durmaz: sıradaki kimlikle AYNI oturumdan
 * devam edilir. DevAgent'ta bu konteyner yeniden başlatmayı gerektiriyordu;
 * burada kimlik her `query()` çağrısına ayrı verildiği için oturum hiç kopmuyor.
 *
 * İKİ KURAL PAZARLIK KONUSU DEĞİL:
 *
 *  1. Anahtarın kendisi ASLA veritabanına yazılmaz. DB yalnız sıra numarasını,
 *     etiketi ve cooldown'u tutar.
 *  2. Anahtar `process.env`'e ASLA yazılmaz — paralel işler birbirinin kimliğini
 *     ezerdi. Her çağrıya `options.env` ile ayrı geçilir; konteyner de daima
 *     TEK anahtar görür (havuz dosyası mount edilmez).
 */

export interface Identity {
  /** Havuz dosyasındaki sıra. DB kayıtlarıyla eşleşir. */
  index: number;
  /** Abonelik OAuth token'ı mı, Console API anahtarı mı? */
  envName: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
  value: string;
  label: string;
}

/**
 * Limit hatası alan anahtarın en az ne kadar dinleneceği. Mesajdaki açılış
 * saati geçmişte kalsa bile anahtar hemen geri alınmaz (bkz. `markCooldown`).
 */
const MIN_COOLDOWN_MS = 5 * 60_000;

export class AllIdentitiesExhausted extends Error {
  constructor(readonly nextResetAt: string | null) {
    super(
      nextResetAt
        ? `tüm Claude kimlikleri kotada — en erken açılış: ${nextResetAt}`
        : "tanımlı Claude kimliği yok",
    );
    this.name = "AllIdentitiesExhausted";
  }
}

/**
 * Anahtarı türünden tanır.
 *
 * `sk-ant-oat…` abonelik token'ıdır (Claude Pro/Max, `claude setup-token`
 * çıktısı) ve `CLAUDE_CODE_OAUTH_TOKEN` ile geçer. Diğerleri Console API
 * anahtarıdır. İkisi aynı anda tanımlıysa CLI hangisini kullanacağını
 * söylemediği için yalnız biri verilir.
 */
function envNameFor(value: string): Identity["envName"] {
  return value.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
}

/** Anahtarın tanınabilir ama sır taşımayan etiketi. */
function labelFor(value: string, index: number): string {
  const kind = value.startsWith("sk-ant-oat") ? "abonelik" : "api";
  return `#${index} ${kind} …${value.slice(-4)}`;
}

export class IdentityPool {
  private keys: Identity[] = [];

  constructor(
    private readonly db: Db,
    private readonly keysFile: string,
    private readonly cooldownMinutes: number,
  ) {}

  /**
   * Havuz dosyasını okur ve DB kayıtlarını eşitler.
   *
   * Dosya yoksa ortam değişkenine düşülür: tek anahtarla çalışan kurulum
   * (geliştiricinin kendi makinesi) havuz dosyası oluşturmak zorunda kalmasın.
   */
  load(): number {
    const raw = existsSync(this.keysFile)
      ? readFileSync(this.keysFile, "utf8")
          .split("\n")
          .map((l) => l.replace(/\r$/, "").trim())
          .filter((l) => l.length > 0 && !l.startsWith("#"))
      : [
          process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
          process.env.ANTHROPIC_API_KEY ?? "",
        ].filter((v) => v.length > 0);

    this.keys = raw.map((value, index) => ({
      index,
      envName: envNameFor(value),
      value,
      label: labelFor(value, index),
    }));

    for (const k of this.keys) {
      const existing = this.db
        .select({ id: schema.identities.id })
        .from(schema.identities)
        .where(eq(schema.identities.indexNo, k.index))
        .all();

      if (existing.length === 0) {
        this.db
          .insert(schema.identities)
          .values({
            id: newId(),
            indexNo: k.index,
            label: k.label,
            kind: k.envName === "CLAUDE_CODE_OAUTH_TOKEN" ? "oauth" : "api_key",
          })
          .run();
      } else {
        this.db
          .update(schema.identities)
          .set({ label: k.label })
          .where(eq(schema.identities.indexNo, k.index))
          .run();
      }
    }

    return this.keys.length;
  }

  /** Kullanılabilir ilk kimlik; hepsi kotadaysa hata. */
  acquire(): Identity {
    if (this.keys.length === 0) throw new AllIdentitiesExhausted(null);

    const now = new Date().toISOString();
    const states = this.db.select().from(schema.identities).all();
    const cooldowns = new Map(states.map((s) => [s.indexNo, s.cooldownUntil]));

    for (const k of this.keys) {
      const until = cooldowns.get(k.index);
      if (!until || until <= now) {
        this.db
          .update(schema.identities)
          .set({ lastUsedAt: now })
          .where(eq(schema.identities.indexNo, k.index))
          .run();
        return k;
      }
    }

    throw new AllIdentitiesExhausted(this.nextResetAt());
  }

  /**
   * Kimliği dinlenmeye alır.
   *
   * `resetEpoch` limit mesajından geliyorsa kullanılır; yoksa yapılandırmadaki
   * süre eklenir. Gerçek açılış saatini bilmek, gereksiz beklemeyi önler.
   */
  markCooldown(index: number, resetEpoch?: number | null): void {
    const now = Date.now();
    const parsed = resetEpoch ? resetEpoch * 1000 : now + this.cooldownMinutes * 60_000;
    // Açılış saati ŞİMDİDEN ÖNCEYSE anahtar yine de kısa süre dinlenir.
    //
    // Limit hatası az önce geldi; mesajdaki saat geçmişte olsa da (gecikmiş
    // mesaj, yanlış ayrıştırma) anahtar şu an kullanılamıyor. Geçmiş bir
    // zaman yazmak anahtarı hemen "uygun" gösteriyordu: `run()` aynı anahtarı
    // ikinci kez alıyor, zaten denenmiş diye "tüm kimlikler kotada" ile
    // düşüyordu — UI ise tüm kimlikleri kullanılabilir sayıyordu (yaşandı
    // 2026-10-06). Kısa taban, "az önce açılmış" kota varsayımını da korur.
    const until = new Date(Math.max(parsed, now + MIN_COOLDOWN_MS)).toISOString();

    this.db
      .update(schema.identities)
      .set({ cooldownUntil: until })
      .where(eq(schema.identities.indexNo, index))
      .run();
  }

  /** Başarılı turdan sonra arka arkaya hata sayacını sıfırlar. */
  markSuccess(index: number, costMicroUsd: number): void {
    const rows = this.db
      .select({ total: schema.identities.totalMicroUsd })
      .from(schema.identities)
      .where(eq(schema.identities.indexNo, index))
      .all();

    this.db
      .update(schema.identities)
      .set({
        consecutiveFailures: 0,
        totalMicroUsd: (rows[0]?.total ?? 0) + costMicroUsd,
      })
      .where(eq(schema.identities.indexNo, index))
      .run();
  }

  /**
   * En erken açılacak kimliğin zamanı; dinlenen kimlik yoksa null.
   *
   * Yalnız havuzdaki anahtarların HENÜZ GEÇMEMİŞ cooldown'ları sayılır.
   * Tablo, dosyadan çıkarılmış anahtarların satırlarını ve süresi dolmuş
   * cooldown'ları da taşıyor; sıralamada en küçüğü seçmek, 11 gün önceki
   * bir tarihi "en erken açılış" diye gösteriyordu (yaşandı 2026-10-06).
   */
  nextResetAt(): string | null {
    const now = new Date().toISOString();
    const live = new Set(this.keys.map((k) => k.index));
    const times = this.db
      .select()
      .from(schema.identities)
      .all()
      .filter((s) => live.has(s.indexNo))
      .map((s) => s.cooldownUntil)
      .filter((t): t is string => typeof t === "string" && t > now);
    if (times.length === 0) return null;
    return times.sort()[0] ?? null;
  }

  /** UI'da gösterilecek durum — anahtar değeri ASLA dönmez. */
  status(): { total: number; available: number; nextResetAt: string | null } {
    const now = new Date().toISOString();
    const states = this.db.select().from(schema.identities).all();
    const cooldowns = new Map(states.map((s) => [s.indexNo, s.cooldownUntil]));
    const available = this.keys.filter((k) => {
      const until = cooldowns.get(k.index);
      return !until || until <= now;
    }).length;

    return { total: this.keys.length, available, nextResetAt: this.nextResetAt() };
  }
}

/**
 * Kota imzası tespiti.
 *
 * YALNIZCA hata nesnesinde ve `result` mesajında aranır — asistanın ürettiği
 * metinde ASLA. DevAgent'ta bu ayrım yapılmadığında "rate limit" konulu bir iş
 * kendi metniyle yanlış pozitif üretmiş ve anahtar boşuna dinlenmeye alınmıştı.
 */
const QUOTA_PATTERN =
  /usage limit reached|rate[_ ]?limit_?error|credit balance is too low|insufficient_quota|quota exceeded|hit your session limit|session limit reached/i;

export function detectQuota(input: string): { quota: boolean; resetEpoch: number | null } {
  if (!QUOTA_PATTERN.test(input)) return { quota: false, resetEpoch: null };
  // "usage limit reached|1735689600" biçiminde açılış saati verilebiliyor.
  const m = /usage limit reached\|(\d{9,})/i.exec(input);
  if (m?.[1]) return { quota: true, resetEpoch: Number(m[1]) };
  // Abonelik limiti saati İNSAN BİÇİMİNDE veriyor:
  //   "You've hit your session limit · resets 11:40am (UTC)"
  // Epoch yoksa anahtar varsayılan süre kadar (60 dk) dinlenirdi; oysa açılış
  // saati burada yazılı. Ölçüldü 2026-09-17.
  const t = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(UTC\)/i.exec(input);
  if (t?.[1]) {
    const hour12 = Number(t[1]);
    const min = t[2] ? Number(t[2]) : 0;
    const mer = t[3]?.toLowerCase();
    let hour = hour12;
    if (mer === "pm" && hour12 < 12) hour += 12;
    if (mer === "am" && hour12 === 12) hour = 0;
    const now = new Date();
    const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, min, 0, 0);
    // Saat GEÇMİŞSE ertesi güne aittir — ama yalnız belirgin biçimde geçmişse.
    //
    // Mesaj saniye vermiyor ve hata bize birkaç dakika gecikmeyle ulaşabiliyor:
    // "resets 11:40" mesajı 11:51'de işlenirse bu, 24 saat sonrası değil, az
    // önce açılmış bir kota demektir. Toleranssız karşılaştırma anahtarı bir
    // gün boyunca boşuna dinlendiriyordu (ölçüldü 2026-09-17).
    const GRACE_MS = 30 * 60_000;
    const epoch = Math.floor((reset <= now.getTime() - GRACE_MS ? reset + 86_400_000 : reset) / 1000);
    return { quota: true, resetEpoch: epoch };
  }
  return { quota: true, resetEpoch: null };
}
