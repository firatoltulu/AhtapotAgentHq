import type { Command, ProjectProfile } from "@ahtapot/shared";

import { shellQuote } from "../build/executor.js";

/**
 * Build adımlarını canlı konteynerin `command`'ına giren TEK kabuk zincirine
 * çevirir.
 *
 * Eskiden build agent konteynerinde koşuyor, uygulama AYRI bir konteynerde
 * kalkıyordu; ikisini yalnız named volume bağlıyordu. Derleyen ortam ile koşan
 * ortamın aynı olduğu hiçbir yerde garanti değildi. Zincir bu ikiliği kaldırır:
 * `<build adımları> && <başlatma komutu>` aynı konteynerde, aynı araç
 * zinciriyle, garantili sırada koşar.
 *
 * Zincir `sh -lc` ile koşar (bkz. `compose.ts` entrypoint'i); her parça
 * `shellQuote`tan geçer — komutlar profil ve agent verisi taşıyor.
 */

/** Adım sınırı: konteyner logunda hangi adımda olunduğunu okutur. */
export const STEP_SENTINEL = "::ahtapot:step:";

/**
 * Düşen adım işaretçisi.
 *
 * `readiness.failPatterns`a ek olarak motor bunu HER ZAMAN arar: kırmızı build
 * `healthcheck.timeoutMinutes` dolana kadar beklemek yerine anında yakalanır.
 * Northwind'de o süre build'i kapsayacak kadar büyük (~27 dk) olmak zorunda;
 * beklemek kırmızı build'i yarım saat geciktirirdi.
 */
export const FAIL_SENTINEL = "::ahtapot:build-failed:";

/** Düşen adımın adını zincir logundan çıkarır; yoksa null. */
export function parseFailedStep(log: string): string | null {
  const re = new RegExp(`${FAIL_SENTINEL}(.*)$`, "m");
  const m = re.exec(log);
  return m?.[1]?.trim() || null;
}

/**
 * Adımın çalışacağı dizin — `gate.ts`teki birleştirmeyle AYNI kural olmalı.
 * İki yer ayrışırsa aynı profil iki ortamda farklı dizinde derlenir.
 */
function stepCwd(workdir: string, cwd: string): string {
  return cwd === "." ? workdir : `${workdir}/${cwd}`.replace(/\/+/g, "/");
}

/**
 * `export KEY='değer' && ` — `CommandSchema.env` adım başınadır, global değil.
 *
 * `KEY='v' cmd` öneki yalnız İLK basit komuta etki ediyordu: `npm ci && npm run
 * build`de ikincisi değişkeni görmüyordu, agent tarafındaki yürütücü ise tüm
 * komuta veriyor. Adım alt kabukta koştuğu için export sonraki adıma sızmaz.
 */
function envPrefix(env: Record<string, string>): string {
  const parts = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return parts.length > 0 ? `export ${parts.join(" ")} && ` : "";
}

/**
 * Tek adım → kabuk parçası.
 *
 * `optional` adım düşerse zincir SÜRER (`|| true`); zorunlu adım düşerse
 * işaretçi basılır ve zincir `exit 1` ile biter — uygulama hiç başlamaz.
 * Alt kabuk (`( ... )`) şart: `cd` bir sonraki adıma sızmamalı, her adım kendi
 * `cwd`sinden başlar.
 */
function renderStep(step: Command, workdir: string): string {
  const body = `cd ${shellQuote(stepCwd(workdir, step.cwd))} && ${envPrefix(step.env)}${step.run}`;
  const marker = `echo ${shellQuote(`${STEP_SENTINEL}${step.name}`)}`;
  if (step.optional) return `${marker}; ( ${body} ) || true`;
  return `${marker}; ( ${body} ) || { echo ${shellQuote(`${FAIL_SENTINEL}${step.name}`)}; exit 1; }`;
}

/**
 * Build zinciri + başlatma komutu.
 *
 * `whenChanged` YOK SAYILIR: koşullu derleme safha kapısı için doğru ama canlı
 * ortam tam build ister — atlanmış bir adımın çıktısı volume'de hiç olmayabilir
 * ve uygulama yeşil build'e rağmen kalkmaz (bkz. `live.buildBeforeStart`).
 *
 * `startRun` zincirin SONUNA gelir; `startCwd` verilirse başlatma komutu o
 * dizinden koşar (compose `working_dir`ine göreli değil, mutlak kurulur —
 * son adımın `cd`si sızmasın diye).
 */
export function renderBuildChain(
  build: ProjectProfile["build"],
  startRun: string,
  workdir: string,
  startCwd = ".",
): string {
  const steps = [...build.preSteps, ...build.steps];
  const parts = steps.map((s) => renderStep(s, workdir));
  parts.push(`cd ${shellQuote(stepCwd(workdir, startCwd))} && ${startRun}`);
  return parts.join("\n");
}
