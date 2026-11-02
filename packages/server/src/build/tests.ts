import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  DB_CLONE_PLACEHOLDER, dbCloneEnvKeys, jobIdValues, resolveEnvPlaceholders, resolveServices, scrubSecrets, serviceAddress,
  serviceEnvPrefix, suiteUsesAppEnv, type PlaceholderContext, type ProjectProfile, type Service, type TestResult, type TestSuite,
} from "@ahtapot/shared";

import { newId, type Db, schema } from "../db/index.js";
import type { EventHub } from "../ws/hub.js";
import { elapsed } from "./elapsed.js";
import { execGit, shellQuote, type CommandExecutor } from "./executor.js";

/**
 * Test kapısı — takımlar TEK KOŞU, baseline orkestratörde.
 *
 * "Önceden kırık" testler agent'ın sorumluluğu değildir ama UI'da panik
 * yaratır. Bu yüzden QA'nın işi koşturulmadan önce worktree'deki değişiklik
 * `git stash` ile kaldırılıp takımlar bir kez koşturulur (baseline), sonra geri
 * konup bir kez daha. Baseline'da da kırık olanlar `preexistingFailures`a
 * gider ve kırmızı sayılmaz. Ölçümü agent değil orkestratör yapar — üretici
 * taraf güvenilmez.
 *
 * Servis isteyen takımlar üst düzey `services` kataloğundan adla çözülür;
 * `cloneDb` açıksa her koşu şablondan taze bir klon alır.
 * Böyle takımlar canlı ortamla aynı `appEnv`i alır.
 */

export interface SuiteOutcome extends TestResult {
  exitCode: number | null;
  skippedReason: string;
  /** Adları çıkarılabildiyse başarısız testler. */
  failedNames: string[];
  /**
   * Takım koşamadı: servis tanımsız, klon açılamadı… Kod kusuru DEĞİL —
   * agent'a geri bildirim olarak gitmez, baseline ile de silinmez.
   */
  setupError: string;
}

/** TRX (.NET) sayaçları: `<Counters total="…" passed="…" failed="…" …/>` + kırık test adları. */
export function parseTrx(xml: string): { total: number; passed: number; failed: number; skipped: number; failedNames: string[] } {
  const c = /<Counters\s+([^>]*)\/>/.exec(xml)?.[1] ?? "";
  const num = (k: string) => Number(new RegExp(`${k}="(\\d+)"`).exec(c)?.[1] ?? 0);
  const failedNames: string[] = [];
  for (const m of xml.matchAll(/<UnitTestResult\s+[^>]*testName="([^"]+)"[^>]*outcome="Failed"/g)) failedNames.push(m[1]!);
  for (const m of xml.matchAll(/<UnitTestResult\s+[^>]*outcome="Failed"[^>]*testName="([^"]+)"/g)) if (!failedNames.includes(m[1]!)) failedNames.push(m[1]!);
  const total = num("total");
  const passed = num("passed");
  const failed = num("failed");
  return { total, passed, failed, skipped: Math.max(0, total - passed - failed), failedNames };
}

/** JUnit XML: `<testsuite tests failures errors skipped>` toplamları + kırık `<testcase>` adları. */
export function parseJunit(xml: string): { total: number; passed: number; failed: number; skipped: number; failedNames: string[] } {
  let total = 0, failures = 0, errors = 0, skipped = 0;
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const a = m[1]!;
    const num = (k: string) => Number(new RegExp(`\\b${k}="(\\d+)"`).exec(a)?.[1] ?? 0);
    total += num("tests"); failures += num("failures"); errors += num("errors"); skipped += num("skipped");
  }
  const failedNames: string[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] ?? "";
    if (/<(failure|error)\b/.test(body)) {
      const name = /\bname="([^"]+)"/.exec(m[1]!)?.[1];
      if (name) failedNames.push(name);
    }
  }
  const failed = failures + errors;
  return { total, passed: Math.max(0, total - failed - skipped), failed, skipped, failedNames };
}

/**
 * Test koşusunun `$runId`i. Baseline ile gerçek koşu ve takımlar birbirinden
 * AYRI: aynı Redis önekini paylaşsalardı baseline'ın bıraktığı anahtarlar
 * gerçek koşuyu kirletirdi. Yalnız küçük harf, rakam ve `_` — Elasticsearch
 * index adı büyük harf kabul etmiyor.
 */
export function suiteRunId(jobId: string, kind: "baseline" | "run", suiteId: string): string {
  const suite = suiteId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${jobIdValues(jobId).jobIdShort}_${kind === "baseline" ? "b" : "r"}_${suite}`;
}

export interface SuiteRunInput {
  jobId: string;
  profile: ProjectProfile;
  /** Yürütücünün gördüğü worktree kökü. */
  workdir: string;
  /** Host'taki worktree (rapor dosyaları ve git stash burada). */
  worktreePath: string;
  executor: CommandExecutor;
  artifactsDir: string;
  /** Baseline ölçümü mü (kind=baseline) yoksa gerçek koşu mu. */
  kind: "baseline" | "run";
  onLine?: (line: string) => void;
}

/**
 * Takıma şablondan TAZE bir DB klonu verir (`test.suites[].cloneDb`).
 *
 * Docker ve `psql` bilgisi `live/suiteDb.ts`te kalır; test kapısı yalnız bu
 * arayüzü görür. `open` hata fırlatırsa mesajı kullanıcıya gider.
 */
export interface SuiteDatabases {
  open(input: {
    jobId: string;
    profile: ProjectProfile;
    suiteId: string;
    kind: "baseline" | "run";
    log: (line: string) => void;
  }): Promise<{ connectionString: string; close: () => Promise<void> }>;
}

/**
 * Takıma konteyner servisleri kaldırır (externalHost'suz katalog girdileri).
 *
 * Docker bilgisi `live/suiteServices.ts`te kalır. `up` hazır olmayan bir
 * servisle dönmez; hata fırlatırsa kendi yarım kurulumunu temizlemiştir.
 */
export interface SuiteServices {
  up(input: {
    jobId: string;
    /** Ağ ve konteyner adlarının eki — baseline ile gerçek koşu ayrışır. */
    runId: string;
    services: Service[];
    log: (line: string) => void;
  }): Promise<{ down: () => Promise<void> }>;
}

export class TestGate {
  constructor(
    private readonly db: Db,
    private readonly hub: EventHub | null,
    private readonly databases: SuiteDatabases | null = null,
    private readonly services: SuiteServices | null = null,
  ) {}

  /** QA aşamasında koşacak takımları sırayla koşturur; hepsi bağımsız, biri düşse diğeri koşar. */
  async runSuites(input: SuiteRunInput): Promise<SuiteOutcome[]> {
    const out: SuiteOutcome[] = [];
    for (const suite of input.profile.test.suites) {
      if (suite.runAt !== "qa" || suite.denylisted) continue;
      out.push(await this.runSuite(input, suite));
    }
    return out;
  }

  /**
   * `startedAt` verilirse satır geçen süreyle damgalanır. Süite başlamadan
   * yazılan satırlarda (atlandı, ön adım) ölçülecek bir süre yok; damga
   * zorunlu olsaydı oralarda anlamsız bir `0:00.0` görünürdü.
   */
  private log(jobId: string, line: string, stream: "stdout" | "stderr" = "stdout", startedAt?: number): void {
    this.hub?.publish(jobId, {
      type: "build.log",
      stream,
      line: scrubSecrets(line),
      ...(startedAt !== undefined ? { elapsed: elapsed(startedAt) } : {}),
    });
  }

  private async runSuite(input: SuiteRunInput, suite: TestSuite): Promise<SuiteOutcome> {
    const base: SuiteOutcome = {
      suiteId: suite.id, kind: input.kind, total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0,
      preexistingFailures: [], reportRef: "", exitCode: null, skippedReason: "", failedNames: [], setupError: "",
    };
    // Ortam hazırlanamıyorsa takım KIRMIZI döner, atlanmaz.
    //
    // YAŞANDI (2026-09-17): servis isteyen takım "atlandı" diye `failed: 0`
    // dönüyor ve kırmızı kapı denetiminden (`job.ts`) YEŞİL geçiyordu. İnsan
    // "3456/3472 geçti" görüp entegrasyonun koştuğunu sanıyordu. Aynı kusur
    // 2026-10-13'te düzeltme doğrulamasında da görüldü.
    const setupFailed = (message: string): SuiteOutcome => {
      this.log(input.jobId, `✖ ${suite.id}: test ortamı hazırlanamadı — ${message}`, "stderr");
      return { ...base, failed: 1, setupError: scrubSecrets(message) };
    };

    const { found, missing } = resolveServices(input.profile, suite.services);
    if (missing.length > 0) return setupFailed(`services içinde tanımsız servis: ${missing.join(", ")}`);
    // Konteyner servisi (externalHost'suz) koşu başına ağda, canlıdakiyle
    // aynı adla kalkar (bkz. `SuiteServices`).
    const managed = found.filter((s) => !s.externalHost);
    if (managed.length > 0 && !this.services) {
      return setupFailed(`konteyner servisi bu sunucuda kurulamıyor (Docker bağlantısı yok): ${managed.map((s) => s.name).join(", ")}`);
    }
    const svcEnv: Record<string, string> = {};
    for (const svc of found) {
      const { host, port } = serviceAddress(svc);
      const prefix = serviceEnvPrefix(svc.name);
      svcEnv[`${prefix}_HOST`] = host;
      svcEnv[`${prefix}_PORT`] = String(port);
    }
    if (found.length > 0) {
      this.log(input.jobId, `▷ ${suite.id}: servisler — ${found.map((s) => { const a = serviceAddress(s); return `${s.name}@${a.host}:${a.port}`; }).join(", ")}`);
    }

    // Uygulama env'i canlı ortamla AYNI tablodan; takımın
    // komut env'i yalnız teste özgü farklar için. Klon yer tutucusu klon
    // AÇILMADAN denetlenir: açılıp hemen düşürülecek bir klon boşa 9 sn.
    const appEnv = suiteUsesAppEnv(suite) ? input.profile.appEnv : {};
    const commands = [...suite.preSteps, suite.command];
    if (!suite.cloneDb) {
      const carriers = [appEnv, ...commands.map((c) => c.env)].some((env) => dbCloneEnvKeys(env).length > 0);
      if (carriers) return setupFailed(`$${DB_CLONE_PLACEHOLDER} kullanılıyor ama takımda cloneDb kapalı`);
    }

    const runId = suiteRunId(input.jobId, input.kind, suite.id);
    let stack: { down: () => Promise<void> } | null = null;
    if (managed.length > 0) {
      try {
        stack = await this.services!.up({
          jobId: input.jobId, runId, services: managed, log: (line) => this.log(input.jobId, line),
        });
      } catch (err) {
        return setupFailed(err instanceof Error ? err.message : String(err));
      }
    }
    try {
      return await this.runWithEnv(input, suite, base, setupFailed, svcEnv, appEnv, runId);
    } finally {
      if (stack) {
        // Yıkılamayan servis sonucu bozmaz: test koştu, sızan konteyneri
        // yetim tarama (`ahtapot.job` etiketi) toplar.
        await stack.down().catch((err: unknown) => {
          this.log(input.jobId, `⚠ ${suite.id}: test servisleri yıkılamadı — ${err instanceof Error ? err.message : String(err)}`, "stderr");
        });
      }
    }
  }

  private async runWithEnv(
    input: SuiteRunInput,
    suite: TestSuite,
    base: SuiteOutcome,
    setupFailed: (message: string) => SuiteOutcome,
    svcEnv: Record<string, string>,
    appEnv: Record<string, string>,
    runId: string,
  ): Promise<SuiteOutcome> {
    let connectionString: string | undefined;
    let closeDb: (() => Promise<void>) | null = null;
    if (suite.cloneDb) {
      if (!this.databases) return setupFailed("DB klonlama bu sunucuda kurulu değil (Docker bağlantısı yok)");
      try {
        const opened = await this.databases.open({
          jobId: input.jobId, profile: input.profile, suiteId: suite.id, kind: input.kind,
          log: (line) => this.log(input.jobId, line),
        });
        connectionString = opened.connectionString;
        closeDb = opened.close;
      } catch (err) {
        return setupFailed(err instanceof Error ? err.message : String(err));
      }
    }
    const ctx: PlaceholderContext = {
      jobId: input.jobId,
      runId,
      ...(connectionString !== undefined ? { dbCloneConnectionString: connectionString } : {}),
    };
    const resolvedAppEnv = resolveEnvPlaceholders(appEnv, ctx);
    // `emptyEnv` de uygulama yapılandırmasının parçası: canlıda tek boşluk
    // alan değişken testte de almalı. YAŞANDI (2026-10-14): Northwind'in
    // kurulum ön adımı Serilog'un Elasticsearch sink'iyle `localhost:9209`a
    // bağlanıp 134 ile çıktı; canlıda `Northwind__ElasticSearch__ElasticNodes`
    // boşaltıldığı için aynı uygulama orada açılıyordu.
    if (suiteUsesAppEnv(suite)) {
      for (const name of input.profile.live?.emptyEnv ?? []) resolvedAppEnv[name] = " ";
    }
    const appEnvNames = Object.keys(resolvedAppEnv).sort();
    if (appEnvNames.length > 0) {
      // Yalnız ADLAR: değerler bağlantı dizesi ve parola taşıyor.
      this.log(input.jobId, `▷ ${suite.id}: uygulama env'i — ${appEnvNames.join(", ")}`);
    }
    let outcome: SuiteOutcome | null = null;
    try {
      // Öncelik: servis adresleri < uygulama env'i < komutun kendi env'i.
      // Klon dizesi artık profilin seçtiği ada yer tutucuyla gidiyor; komut
      // env'inin onu ezmesini doğrulayıcı uyarır.
      outcome = await this.execSuite(input, suite, base, (cmdEnv) => ({
        ...svcEnv, ...resolvedAppEnv, ...resolveEnvPlaceholders(cmdEnv, ctx),
      }));
      return outcome;
    } finally {
      if (closeDb) {
        try {
          await closeDb();
        } catch (err) {
          const message = `test DB'si düşürülemedi — ${err instanceof Error ? err.message : String(err)}`;
          this.log(input.jobId, `⚠ ${suite.id}: ${message}`, "stderr");
          if (outcome) {
            outcome.failed = Math.max(1, outcome.failed);
            outcome.setupError ||= scrubSecrets(message);
          }
        }
      }
    }
  }

  private async execSuite(
    input: SuiteRunInput,
    suite: TestSuite,
    base: SuiteOutcome,
    envFor: (cmdEnv: Record<string, string>) => Record<string, string>,
  ): Promise<SuiteOutcome> {
    const dir = join(input.artifactsDir, input.jobId);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `test-${input.kind}-${suite.id}-${newId()}.log`);
    const file = createWriteStream(logPath, { encoding: "utf8" });
    const flushed = new Promise<void>((resolve, reject) => { file.on("finish", resolve); file.on("error", reject); });

    const run = async (cmd: TestSuite["command"] | TestSuite["preSteps"][number]) => {
      this.log(input.jobId, `▶ ${suite.id}/${cmd.name}: ${scrubSecrets(cmd.run)}`);
      // Damga süitin değil KOMUTUN başına göre: bir süitte ön adımlar ve asıl
      // komut art arda koşuyor, hangisinin uzadığı ancak böyle okunuyor.
      const cmdStartedAt = Date.now();
      const cwd = cmd.cwd === "." ? input.workdir : `${input.workdir}/${cmd.cwd}`.replace(/\/+/g, "/");
      return input.executor.run({
        command: cmd.run, cwd, env: envFor(cmd.env), timeoutMs: cmd.timeoutMinutes * 60_000,
        onLine: (stream, raw) => {
          const line = scrubSecrets(raw);
          file.write(`[${elapsed(cmdStartedAt)}] ${line}\n`);
          this.log(input.jobId, line, stream, cmdStartedAt);
          input.onLine?.(line);
        },
      });
    };

    const started = Date.now();
    let exitCode: number | null = null;
    // Ön adımlar atlanırsa testler YANLIŞ YÖNDE geçebilir (Northwind: tohumsuz DB'de her uç 403).
    for (const pre of suite.preSteps) {
      const r = await run(pre);
      if (r.exitCode !== 0 && !pre.optional) {
        exitCode = r.exitCode;
        this.log(input.jobId, `✖ ${suite.id}: ön adım düştü (${pre.name})`, "stderr");
        break;
      }
    }
    if (exitCode === null) exitCode = (await run(suite.command)).exitCode;
    file.end(`--- ${suite.id}: çıkış ${exitCode}\n`);
    await flushed;

    const parsed = await this.parseReport(input.executor, suite, input.worktreePath, input.jobId);
    const outcome: SuiteOutcome = {
      ...base,
      ...(parsed ?? { total: 0, passed: 0, failed: exitCode === 0 ? 0 : 1, skipped: 0, failedNames: [] }),
      exitCode,
      durationMs: Date.now() - started,
      reportRef: logPath,
    };
    // Rapor yoksa çıkış kodu konuşur; rapor varsa çıkış kodu sıfır olsa da kırık sayılır.
    if (parsed && exitCode !== 0 && outcome.failed === 0) outcome.failed = 1;

    this.db.insert(schema.testRuns).values({
      id: newId(), jobId: input.jobId, suiteId: suite.id, kind: input.kind,
      total: outcome.total, passed: outcome.passed, failed: outcome.failed, skipped: outcome.skipped,
      durationMs: outcome.durationMs, reportRef: logPath,
    }).run();
    this.log(input.jobId, `■ ${suite.id} (${input.kind}): ${outcome.passed}/${outcome.total} geçti, ${outcome.failed} kırık, çıkış ${exitCode}`, outcome.failed > 0 ? "stderr" : "stdout");
    return outcome;
  }

  /**
   * Test raporunu YÜRÜTÜCÜDEN okur.
   *
   * Rapor dosyasını konteyner yazıyor ve worktree named volume'de: host'ta
   * böyle bir dosya yok. Eskiden burada `globSync` + `readFileSync` vardı;
   * bind mount kalkınca dosya bulunamaz ve `null` dönerdi — yani test sonucu
   * SESSİZCE kaybolur, kırmızı koşu yeşil görünürdü. Artık okuma yürütücüde
   * ve "rapor bekleniyordu ama yok" ayrı bir uyarı üretir.
   */
  private async parseReport(exec: CommandExecutor, suite: TestSuite, worktreePath: string, jobId: string) {
    const { format, path } = suite.report;
    if (format === "exitcode" || !path) return null;
    const lines: string[] = [];
    await exec.run({
      // `find`, glob'u kabuk genişletmesine bırakmadan uygular; sıralı çıktı
      // "en yeni" seçimini korur (trx her koşuda zaman damgalı dosya üretir).
      command: `find . -path ${shellQuote(`./${path}`)} -type f 2>/dev/null | sort`,
      cwd: worktreePath,
      env: {},
      timeoutMs: 120_000,
      onLine: (_s, l) => {
        if (l.trim()) lines.push(l.trim());
      },
    });
    const newest = lines.at(-1);
    if (!newest) {
      this.log(jobId, `⚠ ${suite.id}: rapor bekleniyordu ama bulunamadı (${path}) — sonuç çıkış koduna düşüyor`, "stderr");
      return null;
    }
    const out: string[] = [];
    const res = await exec.run({
      command: `cat ${shellQuote(newest)}`,
      cwd: worktreePath,
      env: {},
      timeoutMs: 120_000,
      onLine: (_s, l) => {
        out.push(l);
      },
    });
    if (res.exitCode !== 0) {
      this.log(jobId, `⚠ ${suite.id}: rapor okunamadı (${newest})`, "stderr");
      return null;
    }
    const xml = out.join("\n");
    return format === "trx" ? parseTrx(xml) : parseJunit(xml);
  }
}

/**
 * Baseline: worktree'deki değişiklik stash'lenir, takımlar koşar, geri konur.
 * Stash'lenecek bir şey yoksa (her şey commit'li) baseline = HEAD ile aynı.
 *
 * QA'nın yazdığı testler de değişiklik olduğu için stash'e girer; yani
 * baseline "işten önceki kod + işten önceki testler"dir — istenen de bu.
 */
export async function measureBaseline(
  gate: TestGate,
  input: Omit<SuiteRunInput, "kind">,
): Promise<SuiteOutcome[]> {
  // Stash da yürütücüde: worktree volume'de, host'ta git ağacı yok. Eskiden
  // ağaç host'ta stash'lenirken testler konteynerde koşuyordu — o tutarsızlık
  // bu taşımayla ortadan kalktı.
  const exec = input.executor;
  const wt = input.worktreePath;
  const dirty = (await execGit(exec, wt, ["status", "--porcelain", "--untracked-files=all"])).trim().length > 0;
  if (dirty) await execGit(exec, wt, ["stash", "push", "--include-untracked", "--quiet", "-m", "ahtapot-baseline"]);
  try {
    return await gate.runSuites({ ...input, kind: "baseline" });
  } finally {
    // Stash geri konmazsa insanın işi worktree'de kilitli kalır: hata yutulmaz
    // ama baseline sonucunu da düşürmemeli.
    if (dirty) await execGit(exec, wt, ["stash", "pop", "--quiet"], { allowFailure: true });
  }
}

/** Gerçek koşu sonuçlarını baseline ile karşılaştırır; önceden kırıklar ayrılır. */
export function diffAgainstBaseline(baseline: SuiteOutcome[], run: SuiteOutcome[]): SuiteOutcome[] {
  return run.map((r) => {
    const b = baseline.find((x) => x.suiteId === r.suiteId);
    if (!b) return r;
    // Ortam kurulamadıysa baseline'ın da kurulamamış olması "önceden kırık"
    // DEMEK DEĞİL: ikisi de hiç koşmadı. Silinirse takım yine yeşil görünür.
    if (r.setupError) return r;
    const pre = r.failedNames.filter((n) => b.failedNames.includes(n));
    // Adsız (yalnız çıkış kodu) takımlarda: baseline da kırıksa "önceden kırık" sayılır.
    if (r.failedNames.length === 0 && r.failed > 0 && b.failed > 0) {
      return { ...r, preexistingFailures: [`${r.suiteId} (baseline da kırık)`], failed: 0 };
    }
    return { ...r, preexistingFailures: pre, failed: Math.max(0, r.failed - pre.length) };
  });
}
