import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";
import { BRAND } from "@ahtapot/shared";

/**
 * Sunucu yapılandırması.
 *
 * Sırlar ortam değişkeninden ya da repo DIŞINDAKİ dosyalardan gelir; hiçbiri
 * koda gömülmez ve hiçbiri git'e girmez.
 */
export const ConfigSchema = z.object({
  /** Faz 1'de yalnız loopback dinlenir — auth gelmeden dışarı açılmaz. */
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(7717),
  dbPath: z.string().default(`./data/${BRAND.dbFileName}`),
  /** İş dizinleri, worktree'ler ve artifact'ler. */
  dataRoot: z.string().default("./data"),
  /**
   * Claude kimlik havuzu dosyası — satır başına bir anahtar.
   *
   * ENV'DEN AYRI TUTULUR ve konteynere ASLA mount edilmez: konteyner daima TEK
   * anahtar görür. Havuzun tamamı agent'ın eline geçerse kota yönetimi anlamını
   * yitirir ve sızıntı yüzeyi N katına çıkar.
   */
  keysFile: z.string().default("./data/keys.txt"),
  /**
   * Yerel ön inceleme (OCR) anahtarları — satır başına `ad=anahtar`; profil
   * `workflow.review.local.keyRef` ile adı seçer.
   *
   * Claude havuzundan AYRI: burada OpenAI ya da router anahtarı durur ve
   * havuz anahtarları `sk-ant-oat` önekine göre sınıflıyor, yanlış tipe
   * düşerdi. Tanımsızsa yerel inceleme "anahtar yok" deyip atlanır.
   */
  reviewKeysFile: z.string().optional(),
  /** Kota mesajı açılış saati vermezse bu kadar dinlendirilir. */
  keyCooldownMinutes: z.number().int().positive().default(60),
  /**
   * Yönetici token'ı — girişin birinci adımı. Tanımlıysa UI ilk açılışta
   * bunu sorar; TOTP bağlıysa ardından kod ister. Hiç faktör yoksa sunucu
   * açıktır ve bu yalnız loopback'te kabul edilebilir.
   */
  adminToken: z.string().min(1).optional(),
  /** Tam oturumun ömrü (saat). Telefon + masaüstü: haftada bir giriş. */
  sessionTtlHours: z.number().positive().default(168),
  /**
   * Açılışta bağlı TOTP'yi siler (telefon kaybı). Kalıcı bırakılmamalı:
   * her yeniden başlatmada ikinci faktör sessizce düşer.
   */
  resetTotp: z.boolean().default(false),
  /** Bildirim tıklamasının açacağı dış adres (ntfy); ör. `https://ahtapot.example.com`. */
  publicUrl: z.string().url().optional(),
  /** VAPID iletişim adresi — push servisleri kötüye kullanımda buraya yazar. */
  vapidSubject: z.string().default("mailto:admin@localhost"),
  /** ntfy konu adresi (`https://ntfy.sh/<konu>`); tanımlıysa her bildirim buraya da gider. */
  ntfyUrl: z.string().url().optional(),
  ntfyToken: z.string().min(1).optional(),
  /**
   * Canlı ortam host portları. Windows'ta WinNAT bazı aralıkları kapatır;
   * havuz tahsis öncesi gerçekten bağlanmayı dener, aralık yalnız adayları verir.
   */
  portRangeFrom: z.number().int().min(1024).max(65535).default(20000),
  portRangeTo: z.number().int().min(1024).max(65535).default(20999),
  /**
   * Konteynerin sunucuya ulaştığı ad. Docker Desktop'ta `host.docker.internal`
   * 127.0.0.1'e bağlı porta da ulaşıyor (ölçüldü); Linux sunucuda
   * `host-gateway` ile aynı ad çözülür ama sunucunun o arayüzü dinlemesi gerekir.
   */
  bridgeHost: z.string().default("host.docker.internal"),
  /** Agent taban imajı; profil `exec.image` bunun üstüne kurulur. */
  agentImage: z.string().default(`${BRAND.slug}/agent-base:latest`),
  /** Derlenmiş web UI dizini; verilmezse `packages/web/dist` denenir. */
  webDist: z.string().optional(),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /**
   * Natlanmış Traefik'in file-provider izlediği HOST dizini. Boşsa canlı
   * ortamlar yalnız `127.0.0.1` üzerinden erişilir, Traefik dosyası hiç
   * üretilmez — profildeki `live.traefik.enabled` açık olsa da fark etmez.
   */
  traefikDynamicDir: z.string().optional(),
  /**
   * Traefik'in AhtapotAgent sunucusuna ulaşacağı adres. Traefik ayrı
   * konteyner/host'ta koşuyorsa `127.0.0.1` ERİŞİLEMEZ olur.
   */
  traefikBackendHost: z.string().default("127.0.0.1"),
  /**
   * Sunucunun kendi Docker ağı; canlı ortamın uygulaması buna da takılır ve
   * sağlık yoklaması iç adresten yapılır. Sunucu konteynerde koşuyorsa
   * gerekli — host loopback'ine yayınlanan porta konteynerden ulaşılamıyor.
   */
  // `trim`: dosyadan gelen "   " `min(1)`i geçip compose'a ağ adı diye gidiyordu.
  liveNetwork: z.string().trim().min(1).optional(),
  /**
   * Canlı ortam portlarının yayınlandığı host adresi. Boşsa `127.0.0.1`:
   * yalnız bu makineden erişilir. Uzak sunucuda host'un LAN adresi verilir.
   */
  liveHost: z.string().trim().min(1).optional(),
  /**
   * Klonla/GitHub'dan seç modlarında hedef workspace yolunun otomatik
   * türetileceği kök dizin (`<kök>/<repo-adı>`). Tanımsızsa kullanıcı yolu
   * elle girer (eski davranış) — Projects.tsx bu alanı gizlemek için
   * `/api/system`'den yalnız "tanımlı mı" bilgisini alır, ham yolu değil.
   */
  workspacesRoot: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Yapılandırmayı yükler: varsayılanlar → config dosyası → ortam değişkenleri.
 * Sonraki kaynak öncekini ezer.
 */
export function loadConfig(configPath?: string): Config {
  let fromFile: Record<string, unknown> = {};
  const file = configPath ?? process.env.AHTAPOT_CONFIG;
  if (file && existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  }

  const fromEnv: Record<string, unknown> = {
    host: process.env.AHTAPOT_HOST,
    port: envNumber("AHTAPOT_PORT"),
    dbPath: process.env.AHTAPOT_DB,
    dataRoot: process.env.AHTAPOT_DATA,
    keysFile: process.env.AHTAPOT_KEYS,
    reviewKeysFile: process.env.AHTAPOT_REVIEW_KEYS || undefined,
    keyCooldownMinutes: envNumber("AHTAPOT_KEY_COOLDOWN_MINUTES"),
    adminToken: process.env.AHTAPOT_ADMIN_TOKEN || undefined,
    sessionTtlHours: envNumber("AHTAPOT_SESSION_HOURS"),
    resetTotp: process.env.AHTAPOT_RESET_2FA === "1" ? true : undefined,
    publicUrl: process.env.AHTAPOT_PUBLIC_URL || undefined,
    vapidSubject: process.env.AHTAPOT_VAPID_SUBJECT || undefined,
    ntfyUrl: process.env.AHTAPOT_NTFY_URL || undefined,
    ntfyToken: process.env.AHTAPOT_NTFY_TOKEN || undefined,
    portRangeFrom: envNumber("AHTAPOT_PORT_FROM"),
    portRangeTo: envNumber("AHTAPOT_PORT_TO"),
    bridgeHost: process.env.AHTAPOT_BRIDGE_HOST,
    agentImage: process.env.AHTAPOT_AGENT_IMAGE,
    webDist: process.env.AHTAPOT_WEB_DIST,
    logLevel: process.env.AHTAPOT_LOG_LEVEL,
    traefikDynamicDir: process.env.AHTAPOT_TRAEFIK_DYNAMIC_DIR,
    traefikBackendHost: process.env.AHTAPOT_TRAEFIK_BACKEND_HOST,
    liveNetwork: process.env.AHTAPOT_LIVE_NETWORK?.trim() || undefined,
    liveHost: process.env.AHTAPOT_LIVE_HOST?.trim() || undefined,
    workspacesRoot: process.env.AHTAPOT_WORKSPACES_ROOT,
  };
  for (const [k, v] of Object.entries(fromEnv)) {
    if (v === undefined) delete fromEnv[k];
  }

  const cfg = ConfigSchema.parse({ ...fromFile, ...fromEnv });
  return {
    ...cfg,
    dbPath: resolve(cfg.dbPath),
    dataRoot: resolve(cfg.dataRoot),
    keysFile: resolve(cfg.keysFile),
    ...(cfg.reviewKeysFile ? { reviewKeysFile: resolve(cfg.reviewKeysFile) } : {}),
    ...(cfg.traefikDynamicDir ? { traefikDynamicDir: resolve(cfg.traefikDynamicDir) } : {}),
    ...(cfg.workspacesRoot ? { workspacesRoot: resolve(cfg.workspacesRoot) } : {}),
  };
}
