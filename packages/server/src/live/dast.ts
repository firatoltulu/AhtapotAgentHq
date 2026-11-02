import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BRAND,
  composeProject,
  networkName,
  parseDastSarif,
  parseJunitFailures,
  parseZapJson,
  riskAtLeast,
  scrubSecrets,
  sortByRisk,
  targetPathRegex,
  type DastFinding,
  type DastRisk,
  type DastStep,
  type DastSummary,
  type ProjectProfile,
} from "@ahtapot/shared";

import { defaultDockerRun, ensureImage, type DockerRun } from "../exec/dockerCli.js";

/**
 * DAST —canlı ortamın iç ağında, adım başına ayrı konteyner.
 *
 * Sunucuda `docker` CLI ile: tarayıcı imajları (ZAP, Schemathesis) iş
 * konteynerinde yok ve olmamalı. Adımlar arası dosya paylaşımı adlı bir
 * volume'de (`/out`): bind mount sunucu konteynerde koşarken HOST yolu
 * isterdi, sunucu o yolu bilmiyor (canlı ortamın volume'e geçme sebebi aynı).
 *
 * Tarama hatası FIRLATILMAZ, `failures`a yazılır: DAST bir ön filtre, düşerse
 * kapı yine açılır.
 */

/** Adıma giden kapsam: dalın uçları ve değişen dosyalar. */
export interface DastTargets {
  mode: "branch" | "full";
  paths: string[];
  changedFiles: string[];
  reason?: string;
}

/**
 * Tek env değişkeninin bayt tavanı. Linux tek argüman/env dizesini 128 KB ile
 * sınırlar (`MAX_ARG_STRLEN`); büyük dalın dosya listesi parçalanıp
 * `/out/changed-files.txt`e birleştirilir.
 */
const ENV_CHUNK_BYTES = 100_000;

function chunkLines(lines: readonly string[], maxBytes: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const l of lines) {
    const n = Buffer.byteLength(l) + 1;
    if (cur.length > 0 && size + n > maxBytes) {
      out.push(cur.join("\n"));
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += n;
  }
  if (cur.length > 0) out.push(cur.join("\n"));
  return out;
}

/** UI'a ve prompt'a giden bulgu tavanı; tam liste rapor dosyasında. */
const MAX_FINDINGS = 40;

export async function runDast(opts: {
  jobId: string;
  profile: ProjectProfile;
  round: number;
  artifactsDir: string;
  /** Motorun çıkardığı kapsam; yoksa tam tarama. */
  scope?: DastTargets;
  docker?: DockerRun;
  log: (line: string) => void;
}): Promise<DastSummary> {
  const docker = opts.docker ?? defaultDockerRun;
  const live = opts.profile.live;
  // Çağıran `live.dast.enabled`a bakıyor; `live` yoksa buraya gelinmez.
  if (!live) throw new Error("profilde `live` bölümü yok");
  const cfg = live.dast;
  const reportRel = join(opts.jobId, `dast-${opts.round}`);
  const reportDir = join(opts.artifactsDir, reportRel);
  mkdirSync(reportDir, { recursive: true });
  const failures: DastSummary["failures"] = [];
  const findings: DastFinding[] = [];
  const scope: DastTargets = opts.scope ?? { mode: "full", paths: [], changedFiles: [] };
  const scopeEnv: Record<string, string> = {
    DAST_SCOPE: scope.mode,
    TARGET_PATHS: scope.paths.join("\n"),
    TARGET_PATH_REGEX: targetPathRegex(scope.paths),
  };
  const changedChunks = chunkLines(scope.changedFiles, ENV_CHUNK_BYTES);
  writeFileSync(join(reportDir, "targets.txt"), scope.paths.join("\n"));
  writeFileSync(join(reportDir, "changed-files.txt"), scope.changedFiles.join("\n"));
  let ran = false;
  const tail = (s: string): string => scrubSecrets(s.split("\n").filter(Boolean).slice(-8).join(" | ")).slice(0, 600);

  const summary = (): DastSummary => {
    const counts: Record<DastRisk, number> = { high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) counts[f.risk]++;
    return {
      ran, minRisk: cfg.minRisk, counts,
      blocking: findings.filter((f) => riskAtLeast(f.risk, cfg.minRisk)).length,
      findings: sortByRisk(findings).slice(0, MAX_FINDINGS),
      failures, reportDir: reportRel,
      scope: { mode: scope.mode, paths: scope.paths, ...(scope.reason ? { reason: scope.reason } : {}) },
    };
  };

  // Compose ağ adına proje öneki ekliyor; ad tahmin edilmez, etiketten bulunur.
  const net = await docker([
    "network", "ls", "--format", "{{.Name}}",
    "--filter", `label=com.docker.compose.project=${composeProject(opts.jobId)}`,
    "--filter", `label=com.docker.compose.network=${networkName(opts.jobId)}`,
  ], 60_000);
  const network = net.stdout.split("\n").map((l) => l.trim()).find(Boolean);
  if (!network) {
    failures.push({ step: "*", reason: `canlı ortamın ağı bulunamadı${net.stderr ? `: ${tail(net.stderr)}` : ""}` });
    return summary();
  }
  const target = `http://${live.app.service ?? "app"}:${live.app.containerPort}`;
  const volume = `${BRAND.slug}-dast-${opts.jobId}`;
  const steps = cfg.steps.filter((s) => s.enabled);

  await docker(["volume", "rm", "-f", volume], 60_000);
  await docker(["volume", "create", volume], 60_000);
  try {
    let prepared = false;
    for (const step of steps) {
      if (!(await ensureImage(docker, step.image, opts.log))) {
        failures.push({ step: step.id, reason: `imaj çekilemedi: ${step.image}` });
        continue;
      }
      // Volume kökü root'un; ZAP gibi root olmayan imajlar yazamıyordu.
      // Kapsam dosyaları da burada yazılır: adımlar `$OUT`tan okuyabilsin.
      if (!prepared) {
        prepared = true;
        // Parça başına ayrı çağrı: tek çağrıda toplam argv+env `ARG_MAX`ı
        // aşabilir. Düşerse adımlar yine koşar — kapsam env'de de var
        // (`TARGET_PATHS`, `TARGET_PATH_REGEX`); yalnız dosyalar eksik kalır.
        const prep = (env: string[], cmd: string) => docker([
          "run", "--rm", "--user", "0", "-v", `${volume}:/out`, ...env,
          "--entrypoint", "sh", step.image, "-c", cmd,
        ], 120_000);
        const calls: [string[], string][] = [
          [["-e", `TARGET_PATHS=${scopeEnv["TARGET_PATHS"]}`],
            `chmod 0777 /out && printf '%s\\n' "$TARGET_PATHS" | sed '/^$/d' > /out/targets.txt && : > /out/changed-files.txt && chmod 0666 /out/targets.txt /out/changed-files.txt`],
          ...changedChunks.map((c): [string[], string] => [["-e", `CHANGED_FILES=${c}`],
            `printf '%s\\n' "$CHANGED_FILES" | sed '/^$/d' >> /out/changed-files.txt`]),
        ];
        for (const [env, cmd] of calls) {
          const r = await prep(env, cmd);
          if (r.code !== 0 || r.timedOut) {
            failures.push({ step: "*", reason: `kapsam dosyaları hazırlanamadı (çıkış ${r.code ?? "?"}): ${tail(r.stderr || r.stdout)}` });
            break;
          }
        }
      }
      opts.log(`▶ DAST · ${step.id} (${step.image}) → ${target}${scope.mode === "branch" ? ` · ${scope.paths.length} uç` : " · tam"}`);
      const res = await runStep(docker, step, { network, volume, target, env: scopeEnv, name: `${BRAND.slug}-dast-${opts.jobId}-${step.id}` });
      for (const l of res.stdout.split("\n").slice(-30)) if (l.trim()) opts.log(scrubSecrets(l));
      if (res.timedOut) {
        failures.push({ step: step.id, reason: `${step.timeoutMinutes} dk içinde bitmedi` });
        continue;
      }
      if (!step.report) {
        // Hazırlık adımı (ör. token): düşmesi sonrakileri de bozar ama onlar
        // kendi raporlarıyla görünür olsun — sessizce durdurulmaz.
        if (res.code !== 0) failures.push({ step: step.id, reason: `çıkış ${res.code ?? "?"}: ${tail(res.stderr || res.stdout)}` });
        continue;
      }
      // Tarayıcılar bulgu varken ≠ 0 döner (ZAP 1/2); belirleyici olan rapor.
      const cat = await docker(["run", "--rm", "-v", `${volume}:/out`, "--entrypoint", "cat", step.image, `/out/${step.report.file}`], 120_000);
      if (cat.code !== 0) {
        failures.push({ step: step.id, reason: `rapor yazılmadı (çıkış ${res.code ?? "?"}): ${tail(res.stderr || res.stdout)}` });
        continue;
      }
      writeFileSync(join(reportDir, `${step.id}-${step.report.file.replace(/[^\w.-]/g, "_")}`), scrubSecrets(cat.stdout));
      try {
        findings.push(...parseReport(step, cat.stdout));
        ran = true;
      } catch (err) {
        failures.push({ step: step.id, reason: `rapor okunamadı: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` });
      }
    }
  } finally {
    await docker(["volume", "rm", "-f", volume], 60_000);
  }
  // Bulgu metinleri tarayıcının gördüğü yanıtları taşır (token, çerez);
  // adres de sorgu dizesinde token taşıyabilir. Kapı yükü DB'ye ve UI'a gider.
  for (const f of findings) {
    f.title = scrubSecrets(f.title).slice(0, 300);
    f.detail = scrubSecrets(f.detail).slice(0, 2000);
    if (f.url) f.url = scrubSecrets(f.url).slice(0, 500);
  }
  return summary();
}

async function runStep(
  docker: DockerRun,
  step: DastStep,
  ctx: { network: string; volume: string; target: string; env: Record<string, string>; name: string },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  await docker(["rm", "-f", ctx.name], 60_000);
  const res = await docker([
    "run", "--rm", "--name", ctx.name,
    "--network", ctx.network,
    "-v", `${ctx.volume}:/out`,
    "-e", `TARGET_URL=${ctx.target}`, "-e", "OUT=/out",
    ...Object.entries(ctx.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "--entrypoint", "sh", step.image, "-c", step.run,
  ], step.timeoutMinutes * 60_000);
  // Zaman aşımında yalnız CLI süreci ölür; konteyner koşmaya devam ederdi.
  if (res.timedOut) await docker(["rm", "-f", ctx.name], 60_000);
  return res;
}

function parseReport(step: DastStep, content: string): DastFinding[] {
  switch (step.report!.format) {
    case "zap-json": return parseZapJson(step.id, JSON.parse(content));
    case "sarif": return parseDastSarif(step.id, JSON.parse(content));
    case "junit": return parseJunitFailures(step.id, content, step.failureRisk);
  }
}

/** Developer'a giden metin — kapı reddinde ya da `autoFix`te. */
export function renderDastFeedback(s: DastSummary, onlyBlocking: boolean): string {
  const list = onlyBlocking ? s.findings.filter((f) => riskAtLeast(f.risk, s.minRisk)) : s.findings;
  if (list.length === 0) return "";
  return scrubSecrets([
    `DAST (canlı ortama karşı otomatik tarama) bulguları — ${list.length} adet${onlyBlocking ? `, risk ≥ ${s.minRisk}` : ""}:`,
    "",
    ...list.map((f) => [
      `### [${f.risk}] ${f.title} (${f.tool} · ${f.rule}${f.count ? ` · ${f.count} örnek` : ""})`,
      ...(f.url ? [`Adres: ${f.url}`] : []),
      f.detail,
    ].join("\n")),
    "",
    "Adresler tarayıcının iç ağ adresidir; uygulamadaki karşılık gelen uç/sayfayı bul. Bulgu yanlış pozitifse koda dokunma, gerekçesini yaz.",
  ].join("\n\n"));
}
