import { createHash } from "node:crypto";

/**
 * Ürün kimliği — TEK KAYNAK.
 *
 * Ad henüz kesinleşmedi; değiştirmek gerektiğinde YALNIZCA bu dosya düzenlenir.
 * Konteyner adları, DB dosyası, CLI komutu ve UI başlığı buradan türer.
 *
 * Kısıt: `slug` Docker nesne adlarına ve dosya adlarına giriyor — küçük harf,
 * rakam ve tire dışında karakter alamaz.
 */
export const BRAND = {
  /** Docker nesneleri, dosya adları ve CLI komutu için. */
  slug: "ahtapot",
  /** UI başlığı ve insan okur metinler. */
  displayName: "AhtapotAgent",
  /** SQLite dosya adı (data/ altında). */
  dbFileName: "ahtapot.sqlite",
} as const;

/** `ahtapot-agent-<jobId>` gibi konteyner adları — tek yerden üretilir. */
export const containerName = {
  agent: (jobId: string) => `${BRAND.slug}-agent-${jobId}`,
  live: (jobId: string) => `${BRAND.slug}-live-${jobId}`,
  db: (jobId: string) => `${BRAND.slug}-db-${jobId}`,
} as const;

/** Docker etiketi — yetim tarama (`reconcile`) bununla filtreler. */
export const DOCKER_LABEL = {
  job: `${BRAND.slug}.job`,
  role: `${BRAND.slug}.role`,
  /**
   * Agent tabanının parmak izi. Taban imaja build'de yazılır; `FROM` ile
   * türeyen proje imajları etiketi MİRAS alır — proje imajının hangi taban
   * üstünde kurulduğu ayrıca kaydedilmeden okunabilir.
   */
  base: `${BRAND.slug}.base`,
} as const;

/** İş başına izole ağ. */
export const networkName = (jobId: string) => `${BRAND.slug}-net-${jobId}`;

/** Compose proje adı — `docker compose -p` ile kullanılır. */
export const composeProject = (jobId: string) => `${BRAND.slug}-${jobId}`;

/**
 * Traefik alt domaini — jobId'den deterministik türer.
 *
 * `jobId` (UUID) doğrudan subdomain yapılmıyor: DNS/URL'de gereksiz uzun ve
 * okunaksız. Hash kısa ve sabit (aynı jobId → aynı subdomain), TTL uzatma ve
 * yeniden başlatmalarda aynı Traefik dosyasını hedefler.
 */
export const liveSubdomain = (jobId: string) =>
  `job-${createHash("sha1").update(jobId).digest("hex").slice(0, 8)}`;
