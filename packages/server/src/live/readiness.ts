import type { Live } from "@ahtapot/shared";

/**
 * Hazırlık ölçütü — "port açık" ≠ "uygulama hazır".
 *
 * Northwind'de FastEndpoints uçları kaydederken ayarları veritabanından çeker;
 * bağlantı yoksa hatayı YUTAR ve süreç sıfır route ile dinlemeye devam eder.
 * HTTP 200 dönen ama hiçbir uç kaydetmemiş bir host "hazır" sayılırsa canlı
 * test yanıltıcı olur. Bu yüzden iki koşul BİRDEN aranır: healthcheck yanıtı
 * ve log'da `readiness.logPattern` (yakalanan sayı `minCaptureValue`den
 * büyük). `failPatterns` görülürse beklemeden başarısız sayılır.
 */

export interface ReadinessInput {
  url: string;
  healthcheck: Live["healthcheck"];
  readiness: Live["readiness"] | undefined;
  /** Uygulama logunun o anki kuyruğu (hedefli okuma; tamamı değil). */
  readLog: () => Promise<string>;
  writeLog?: (line: string) => void;
  /** Yoklama arası ve toplam süre; testler kısaltır. */
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Ad çözülemediğinde (`ENOTFOUND`/`EAI_AGAIN`) çağrılır; ağ düzenini Docker'a
   * sorup NEDENİ söyler. `fatal` ise beklemeye devam etmenin anlamı yoktur.
   *
   * Yaşandı (2026-10-03): yoklama `healthcheck.timeoutMinutes` boyunca
   * "http yok (EAI_AGAIN …)" deyip bekledi ve öyle düştü; ağ mı yanlış,
   * konteyner mi ölü, sunucu mu host'ta — hiçbiri söylenmiyordu.
   */
  diagnoseUnreachable?: () => Promise<{ fatal: boolean; message: string } | null>;
}

/** Ad çözümü hataları: ağ yapılandırması — uygulamanın kendisi değil. */
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
/** Tanı Docker API'sine gider; her yoklamada değil. */
const DIAGNOSE_EVERY_MS = 30_000;

export interface ReadinessResult {
  ready: boolean;
  reason: string;
  /** Log deseninden yakalanan sayı (ör. kayıtlı uç sayısı). */
  captured: number | null;
  elapsedMs: number;
}

export async function waitForReady(input: ReadinessInput): Promise<ReadinessResult> {
  const started = Date.now();
  const intervalMs = input.intervalMs ?? input.healthcheck.intervalSeconds * 1000;
  const timeoutMs = input.timeoutMs ?? input.healthcheck.timeoutMinutes * 60_000;
  const f = input.fetchImpl ?? fetch;
  const url = new URL(input.healthcheck.path, input.url).toString();
  // `g`: log'daki SON eşleşme geçerli — yeniden başlayan bir uygulama önce
  // "Registered 0 endpoints" sonra gerçek sayıyı yazar; ilki alınırsa hazır olmaz.
  // Boş `logPattern`: motor yalnız `failPatterns` eklemek için bir readiness
  // nesnesi kurmuş olabilir (kırmızı build işaretçisi). Boş desen her metne
  // uyar ve ölçütü anlamsız kılardı — hiç kurulmaz.
  const pattern = input.readiness?.logPattern ? new RegExp(input.readiness.logPattern, "gm") : null;
  const fails = (input.readiness?.failPatterns ?? []).map((p) => new RegExp(p, "m"));

  let httpOk = false;
  let captured: number | null = null;
  // Görülen son eşleşme turlar arası SAKLANIR. Log kuyruğu sabit pencere;
  // desen satırının ardından gelen gürültü (Northwind: istek başına stack trace)
  // onu pencereden itiyordu ve hazır uygulama zaman aşımına düştü (yaşandı).
  // Pencerede yeni eşleşme varsa o geçerli: yeniden başlayan uygulamanın
  // "0 endpoints"u eskisini ezer.
  let matched = false;
  let httpNote = "";
  let lastNote = "";
  let lastLogged = "";
  let diagnosis = "";
  let diagnosedAt = -Infinity;

  input.writeLog?.(`healthcheck: GET ${url} (aralık ${intervalMs} ms, zaman aşımı ${timeoutMs} ms)`);

  for (;;) {
    const log = await input.readLog().catch(() => "");
    const dead = fails.find((re) => re.test(log));
    if (dead) {
      return { ready: false, reason: `log'da başarısızlık deseni: ${dead.source}`, captured, elapsedMs: Date.now() - started };
    }

    if (!httpOk) {
      // Asılı kalan bağlantı yoklama döngüsünü kilitlemesin: istek başına
      // en çok bir aralık (ve 5 s) beklenir.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(intervalMs, 5000));
      try {
        const res = await f(url, { signal: controller.signal });
        httpOk = input.healthcheck.expectStatus.includes(res.status);
        httpNote = httpOk ? "http ok" : `http ${res.status}`;
        diagnosis = "";
      } catch (e) {
        httpNote = `http yok (${describeFetchError(e)})`;
        if (input.diagnoseUnreachable && DNS_CODES.has(fetchErrorCode(e) ?? "")) {
          if (Date.now() - diagnosedAt >= DIAGNOSE_EVERY_MS) {
            diagnosedAt = Date.now();
            const d = await input.diagnoseUnreachable().catch(() => null);
            diagnosis = d?.message ?? "";
            if (d?.fatal) {
              input.writeLog?.(`healthcheck: ${httpNote} — ${d.message}`);
              return { ready: false, reason: `${httpNote} — ${d.message}`, captured, elapsedMs: Date.now() - started };
            }
          }
        } else {
          diagnosis = "";
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // Not her turda BAŞTAN kurulur; eskiden http tamamlandıktan sonra
    // "; log deseni yok" her turda aynı dizeye ekleniyordu.
    lastNote = diagnosis ? `${httpNote} — ${diagnosis}` : httpNote;
    let logOk = true;
    if (pattern) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null = null;
      for (let next = pattern.exec(log); next; next = pattern.exec(log)) m = next;
      if (m) {
        matched = true;
        captured = m[1] !== undefined ? Number(m[1]) : null;
      }
      if (!matched) {
        logOk = false;
        lastNote += "; log deseni yok";
      } else {
        const min = input.readiness!.minCaptureValue;
        logOk = captured === null ? true : captured > min;
        if (!logOk) lastNote += `; yakalanan ${captured} ≤ ${min}`;
      }
    }

    // Her yoklamada değil, durum DEĞİŞİNCE yaz: 8 dk × 5 s aralık yüzlerce
    // aynı satır demekti ve asıl hatayı gömüyordu.
    if (lastNote !== lastLogged) {
      input.writeLog?.(`healthcheck: ${lastNote}`);
      lastLogged = lastNote;
    }

    if (httpOk && logOk) {
      return { ready: true, reason: "healthcheck ve log ölçütü sağlandı", captured, elapsedMs: Date.now() - started };
    }
    if (Date.now() - started >= timeoutMs) {
      return { ready: false, reason: `zaman aşımı: ${lastNote}`, captured, elapsedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function fetchErrorCode(e: unknown): string | null {
  const cause = e instanceof Error ? (e as { cause?: unknown }).cause : null;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

/**
 * `fetch` hatasının asıl nedeni. Node yalnız "TypeError: fetch failed" yazar;
 * ayırt edici bilgi (`ENOTFOUND` = ad çözülmüyor, yani aynı ağda değil;
 * `ECONNREFUSED` = ağ tamam, uygulama dinlemiyor) `cause` içindedir.
 */
function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === "AbortError") return "istek zaman aşımı";
  const cause = (e as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = cause as { code?: unknown; message?: unknown };
    const code = typeof c.code === "string" ? c.code : "";
    const msg = typeof c.message === "string" ? c.message : "";
    if (code || msg) return [code, msg].filter(Boolean).join(": ");
  }
  return `${e.name}: ${e.message}`;
}
