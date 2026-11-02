import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  DB_CLONE_PLACEHOLDER, dbCloneEnvKeys, parseGitRemote, resolveServices, scrubSecrets, suiteUsesAppEnv, type ProjectProfile,
} from "@ahtapot/shared";

import { assertNoForbiddenFlags, ForbiddenFlagError } from "../build/gate.js";
import { probePort } from "../resources/ports.js";
import { dbDependency } from "../live/golden.js";

const execFileAsync = promisify(execFile);

/**
 * Profil doğrulayıcı — `project validate`.
 *
 * Kötü profil en pahalı hata sınıfıdır: yanlış build komutu her işi bozar,
 * yanlış dal her worktree'yi. Onaydan önce mekanik olarak ölçülebilen her
 * şey ölçülür; yorum yok. Her check bir sonuç satırıdır, UI liste hâlinde
 * gösterir; `error` onayı engellemez ama insan görmeden onaylayamaz.
 */

export interface ValidationCheck {
  id: string;
  level: "ok" | "warn" | "error" | "skip";
  message: string;
}

export interface ValidateDeps {
  /** Docker imajı var mı? Docker yoksa `null` → check atlanır. */
  imageExists?: ((image: string) => Promise<boolean>) | null;
  /**
   * İmajın İÇİNDE bu komut var mı? (`command -v <ad>`)
   *
   * İmajın varlığını denetlemek yetmiyordu: profil `ahtapot/agent-base`i
   * gösteriyordu, imaj vardı, ama `dotnet` yoktu ve `dotnet restore` **çıkış
   * 127** ile düştü — üstelik bu, kurulum dakikalarca koştuktan SONRA ortaya
   * çıktı (ölçüldü, Collection işi 2026-09-16). Onaydan önce ölçülebilecek bir
   * şeyi koşu zamanına bırakmak pahalı.
   */
  imageHasCommand?: ((image: string, command: string) => Promise<boolean>) | null;
  portRange?: { from: number; to: number };
  /**
   * Remote erişilebilir mi? (`checkRemoteReachable`) Verilmezse check
   * atlanır — `imageExists` ile aynı desen: testler ağa çıkmasın.
   */
  remoteReachable?: ((remote: string) => Promise<{ ok: boolean; detail: string }>) | null;
}

/**
 * Komut satırından çalıştırılan aracın adını çıkarır.
 *
 * Kabuk gerçeğine göre: ortam ataması (`FOO=bar cmd`) atlanır, `for`/`if` gibi
 * sözcüklerle başlayan betiklerde gövdedeki ilk gerçek komut aranır. Amaç
 * eksiksizlik değil, PAHALI ve BARİZ olanı (dotnet/npm/node/python) onaydan
 * önce yakalamak.
 */
export function toolsUsed(commands: readonly { run: string }[]): string[] {
  const out = new Set<string>();
  for (const { run } of commands) {
    // `&&`, `||`, `;`, `|` ve satır sonlarıyla ayrılmış her parçaya bak.
    for (const part of run.split(/&&|\|\||[;|\n]/)) {
      const words = part.trim().split(/\s+/);
      // `for X in ...` ve `while X ...`: X döngü DEĞİŞKENİ, komut değil.
      // Ölçüldü: Northwind'in npm adımından `dir` çıkıp imajda arandı.
      if (/^(for|while|until)$/.test(words[0] ?? "")) continue;
      for (const word of words) {
        if (!word) continue;
        // Ortam ataması ve kabuk anahtar sözcükleri komut değildir.
        if (word.includes("=")) continue;
        if (/^(for|do|done|if|then|else|fi|while|case|esac|\[|\]|!)$/.test(word)) continue;
        // Yol içeren çağrı (./x, /usr/bin/x) imajda `command -v` ile aranmaz.
        if (word.includes("/")) break;
        if (/^[a-z][a-z0-9_.+-]*$/i.test(word)) out.add(word);
        break; // parçanın ilk gerçek sözcüğü yeter
      }
    }
  }
  return [...out];
}

/**
 * İmajda aranmaya DEĞER komutlar. Kabuk yerleşikleri (`cd`, `echo`) ve taban
 * imajda kesin bulunanlar (`sh`, `cp`) denetlenmez: gürültü üretirler.
 */
const SKIP_TOOLS = new Set([
  "cd", "echo", "exit", "true", "false", "set", "export", "read", "shift", "test",
  "sh", "bash", "cp", "mv", "rm", "mkdir", "ls", "cat", "sed", "awk", "grep", "printf",
  "continue", "break", "return", "source", "eval", "trap", "wait", "sleep", "env",
]);

/**
 * `git ls-remote` ile remote'un GERÇEKTEN erişilebilir olduğunu ölçer.
 *
 * Biçim doğru olsa da adres yanlış (yazım hatası, yetkisiz repo) olabilir ve
 * bu ancak push anında — iş bittikten sonra — ortaya çıkıyordu. Token argv'ye
 * DEĞİL ortama (`GIT_CONFIG_*`) konur: süreç listesinde görünmesin (kural 5
 * ile aynı gerekçe). `GIT_TERMINAL_PROMPT=0`: kimlik sorulursa asılı kalmasın.
 */
export async function checkRemoteReachable(remote: string, token: string | null): Promise<{ ok: boolean; detail: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (token && /^https:\/\/(www\.)?github\.com\//i.test(remote)) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  try {
    await execFileAsync("git", ["ls-remote", "--heads", "--", remote], { env, timeout: 20_000, maxBuffer: 16_000_000 });
    return { ok: true, detail: "" };
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message?: string };
    if (e.killed) return { ok: false, detail: "20 sn'de cevap gelmedi" };
    const tail = (e.stderr ?? e.message ?? "").trim().split("\n").slice(-2).join(" ");
    return { ok: false, detail: scrubSecrets(tail).slice(0, 300) };
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export async function validateProfile(profile: ProjectProfile, deps: ValidateDeps = {}): Promise<ValidationCheck[]> {
  const out: ValidationCheck[] = [];
  const push = (id: string, level: ValidationCheck["level"], message: string) => out.push({ id, level, message });
  const root = resolve(profile.workspace.root);

  // ── workspace / repolar ──────────────────────────────────────────────────
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    push("workspace.root", "error", `workspace dizini yok: ${root}`);
    return out; // gerisi anlamsız
  }
  push("workspace.root", "ok", root);

  const primaries = profile.workspace.repos.filter((r) => r.primary);
  if (primaries.length !== 1) push("workspace.primary", "error", `tam olarak bir primary repo olmalı (${primaries.length} var)`);

  for (const repo of profile.workspace.repos) {
    const dir = resolve(root, repo.path);
    if (!existsSync(join(dir, ".git"))) {
      push(`repo.${repo.name}`, "error", `git reposu değil: ${dir}`);
      continue;
    }
    const branch = git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${repo.defaultBranch}`]);
    if (!branch) push(`repo.${repo.name}.branch`, "error", `varsayılan dal yok: ${repo.defaultBranch} (${repo.name})`);
    else push(`repo.${repo.name}`, "ok", `${repo.path} · ${repo.defaultBranch}`);
    const id = `repo.${repo.name}.remote`;
    if (repo.remote !== undefined) {
      const parsed = parseGitRemote(repo.remote);
      if (!parsed.ok) {
        push(id, "error", `remote geçersiz: ${parsed.reason}`);
        continue;
      }
      const url = git(dir, ["remote", "get-url", "origin"]);
      const mismatch = Boolean(url && url !== repo.remote);
      if (mismatch) push(id, "warn", `profil remote'u (${repo.remote}) origin ile uyuşmuyor (${scrubSecrets(url ?? "")})`);
      // PR yalnız ana repoda ve yalnız GitHub'a açılır: burada yakalanmazsa iş
      // saatler sonra PR kapısında "PR açılmadı" diyerek Done olur (yaşandı).
      if (repo.primary && profile.git.pr.provider === "github" && !parsed.githubSlug) {
        push(id, "error", `PR sağlayıcısı github ama remote GitHub değil: ${repo.remote}`);
        continue;
      }
      if (!mismatch) push(id, "ok", repo.remote);
      // Ayrı kimlik: biçim sonucu (`.remote`) erişim sonucuyla ezilmesin.
      if (repo.primary && parsed.kind !== "path") {
        if (!deps.remoteReachable) {
          push(`${id}.reach`, "skip", "remote erişimi denetlenmedi");
        } else {
          const reach = await deps.remoteReachable(repo.remote);
          if (reach.ok) push(`${id}.reach`, "ok", `${repo.remote} erişilebilir`);
          else push(`${id}.reach`, "error", `remote'a erişilemiyor: ${repo.remote}${reach.detail ? ` — ${reach.detail}` : ""}`);
        }
      }
    } else if (repo.primary && profile.git.pr.provider !== "none") {
      // Klonla kurulan projede motor `sourceGitUrl`e düşer (`primaryRemote`);
      // doğrulayıcı projeyi bilmiyor, o yüzden uyarı, hata değil.
      push(id, "warn", `remote tanımsız; proje repo URL'siyle klonlanmadıysa PR açılamaz (${repo.name})`);
    }
  }

  // Host'ta ÖN-DOĞRULANAMAZ: referans depo konteyner ayağa kalkarken kendi
  // diskine klonlanır (host'un hiçbir yolu konteynere görünmez). Burada yalnız
  // biçim kontrol edilir; erişilemez/var olmayan `gitUrl` klon anında patlar.
  for (const ref of profile.workspace.referenceRepos) {
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(ref.gitUrl)) {
      push(`referenceRepo.${ref.name}`, "error", `gitUrl tanınmıyor: ${ref.gitUrl}`);
      continue;
    }
    if (ref.searchPaths.length === 0) push(`referenceRepo.${ref.name}`, "warn", `${ref.gitUrl} · arama yolu yok — kökte tarama yavaş`);
    else push(`referenceRepo.${ref.name}`, "ok", `${ref.gitUrl} · ${ref.searchPaths.join(", ")}`);
  }

  for (const p of profile.workspace.ignoredButNeeded) {
    const bare = p.replace(/\/$/, "");
    if (!/[*?[\]{}]/.test(bare) && !existsSync(join(root, bare))) push(`ignoredButNeeded.${bare}`, "warn", `kaynakta yok: ${bare}`);
  }

  // ── build ────────────────────────────────────────────────────────────────
  try {
    assertNoForbiddenFlags(profile.build);
    push("build.forbiddenFlags", "ok", profile.build.forbiddenFlags.length ? `yasak bayrak yok: ${profile.build.forbiddenFlags.join(", ")}` : "yasak bayrak tanımsız");
  } catch (e) {
    if (e instanceof ForbiddenFlagError) push("build.forbiddenFlags", "error", e.message);
    else throw e;
  }
  for (const step of [...profile.build.preSteps, ...profile.build.steps]) {
    const cwd = resolve(root, step.cwd);
    if (!existsSync(cwd)) push(`build.${step.name}.cwd`, "error", `adım dizini yok: ${step.cwd} (${step.name})`);
  }
  if (profile.build.steps.every((s) => s.whenChanged.length === 0)) {
    // KOŞULLULUK `whenChanged`'in TEKELİNDE DEĞİL: adım kendi damgasını tutan
    // bir betiği çağırıyor olabilir (Northwind'de `./build.sh`). Dahası orada
    // `whenChanged` vermek ZARARLI olurdu — motor adımı hiç çağırmaz ve
    // betiğin "çıktı yoksa yine derle" kontrolü devreye giremezdi; temiz bir
    // worktree'de modül bundle'ları üretilmeden kalırdı (ölçüldü 2026-09-17).
    const scripted = profile.build.steps.every((s) => /(^|\s|\/)[\w.-]+\.(sh|ps1|bash)(\s|$)/.test(s.run));
    if (scripted) {
      push("build.conditional", "ok", "atlama kararı derleme betiğinde (kaynak + çıktı damgası)");
    } else {
      push("build.conditional", "warn", "hiçbir adım koşullu değil; her safhada her şey derlenir");
    }
  }

  // Paket kuran adım var ama hedefi bind-mount'ta kalıyorsa kurulum SESSİZCE
  // eksik olur. Ölçüldü (Windows): `npm ci` "added 159 packages" deyip çıkış 0
  // dönüyor, sonra build `tsc: not found` ya da TS2307 ile düşüyor.
  const installsPackages = [...profile.build.preSteps, ...profile.build.steps]
    .some((s) => /\bnpm (ci|install|i)\b|\byarn\b|\bpnpm (i|install)\b/.test(s.run));
  if (installsPackages && profile.exec.scratchDirs.length === 0) {
    push(
      "exec.scratchDirs", "warn",
      "paket kuran adım var ama scratchDirs boş; bind-mount'ta kurulum sessizce eksik kalabilir",
    );
  }

  // ── test ─────────────────────────────────────────────────────────────────
  // ── services: tek katalog, tüketiciler adla ────────────────────────────
  const names = profile.services.map((s) => s.name);
  for (const dup of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
    push(`services.${dup}`, "error", `servis adı iki kez tanımlı: ${dup}`);
  }
  // Klon tek yerde tanımlı; hedefi ONAYDAN ÖNCE ölçülür. Yanlış servis adı
  // koşu zamanında 20 saniyelik bir bekleyişin ardından anlaşılıyordu ve
  // mesaj servisi değil postgres'i suçluyordu.
  const cloneUsers = [
    ...(profile.live?.cloneDb ? ["live"] : []),
    ...profile.test.suites.filter((s) => s.cloneDb).map((s) => `test.${s.id}`),
  ];
  if (cloneUsers.length > 0) {
    const clone = profile.database.clone;
    const dep = dbDependency(profile);
    if (!dep) {
      push("database.clone", "error",
        `database.clone.service "${clone.service}" services içinde yok (${names.join(", ") || "hiç servis yok"}); klonu isteyen: ${cloneUsers.join(", ")}`);
    } else if (profile.database.kind !== "postgres") {
      push("database.clone", "error", `DB klonlaması yalnız postgres için; database.kind = ${profile.database.kind}`);
    } else {
      const where = dep.externalHost ? `${dep.externalHost}:${dep.externalPort ?? dep.internalPort} (dış)` : `${dep.name} (konteyner)`;
      push("database.clone", "ok", `${where} · şablon ${clone.template || "<slug>_golden"} · kullanan: ${cloneUsers.join(", ")}`);
      // Dış Postgres'in kimliği compose `env`inde YAZMAZ (konteyner
      // kurulmuyor): `database.clone.user`/`password` tek kaynaktır.
      if (dep.externalHost && !clone.password && !dep.env["POSTGRES_PASSWORD"]) {
        push("database.clone.creds", "warn", "dış postgres için parola yok: database.clone.password boş ve servis env'inde POSTGRES_PASSWORD yok");
      }
      if (!dep.externalHost && !dep.dataPath) {
        push("database.clone.data", "warn", `${dep.name} konteynerde ama dataPath yok: şablon her ortamda yeniden kurulur`);
      }
    }
  }

  // Uygulama env'i: klon dizesi yalnız `$dbCloneConnectionString` yazılan
  // adlara gider. Klon açılıp hiçbir değişkene bağlanmazsa uygulama klonu
  // hiç görmez; canlıda şablon kurulumu da bu yüzden düşer.
  const cloneKeys = dbCloneEnvKeys(profile.appEnv);
  if (cloneUsers.length > 0 && cloneKeys.length === 0) {
    push("appEnv", "error", `DB klonu açılıyor (${cloneUsers.join(", ")}) ama appEnv'de $${DB_CLONE_PLACEHOLDER} taşıyan değişken yok; uygulama klona bağlanmaz`);
  }
  if (cloneKeys.length > 0 && profile.live?.enabled && !profile.live.cloneDb) {
    push("appEnv", "error", `${cloneKeys.join(", ")} $${DB_CLONE_PLACEHOLDER} istiyor ama live.cloneDb kapalı — canlı ortam kalkmaz`);
  }

  for (const suite of profile.test.suites) {
    const { found, missing } = resolveServices(profile, suite.services);
    if (missing.length > 0) {
      push(`test.${suite.id}.services`, "error", `${suite.id}: services içinde tanımsız servis: ${missing.join(", ")} — takım kırmızı olur`);
    }
    // Konteyner servisi koşu başına BOŞ kalkar; klon şablonu ise yalnız dış
    // Postgres'te yaşıyor (bkz. `TemplateSuiteDatabases`).
    const cloneDep = dbDependency(profile);
    if (suite.cloneDb && cloneDep && !cloneDep.externalHost) {
      push(`test.${suite.id}.cloneDb`, "error",
        `${suite.id}: test klonu yalnız dış Postgres'te (${cloneDep.name} konteynerde); cloneDb'yi kapatıp tohumu ön adımla kurun ya da externalHost verin — takım kırmızı olur`);
    }
    const managed = found.filter((s) => !s.externalHost);
    for (const svc of managed.filter((s) => !s.healthCmd && !s.optional)) {
      push(`test.${suite.id}.services`, "warn", `${suite.id}: ${svc.name} konteynerde kalkacak ama healthCmd yok; test servis hazır olmadan başlayabilir`);
    }
    if (suite.cloneDb && !profile.live?.cloneDb && !suite.services.includes(profile.database.clone.service)) {
      // Klon zaten servis üzerinden geliyor; listede olmaması yalnız
      // `AHTAPOT_SVC_*` adresinin eksik kalması demek, uyarı yeter.
      push(`test.${suite.id}.cloneDb`, "warn", `${suite.id}: cloneDb açık ama ${profile.database.clone.service} takımın services listesinde yok`);
    }
    const commands = [...suite.preSteps, suite.command];
    const usesAppEnv = suiteUsesAppEnv(suite);
    if (!suite.cloneDb) {
      const carriers = [
        ...(usesAppEnv && cloneKeys.length > 0 ? ["appEnv"] : []),
        ...commands.filter((c) => dbCloneEnvKeys(c.env).length > 0).map((c) => c.name),
      ];
      if (carriers.length > 0) {
        push(`test.${suite.id}.cloneDb`, "error",
          `${suite.id}: $${DB_CLONE_PLACEHOLDER} kullanılıyor (${carriers.join(", ")}) ama cloneDb kapalı — takım kırmızı olur`);
      }
    } else {
      // Komutun kendi `env X=…` önekini motor EZEMEZ (kabuk sonra uygular):
      // eski bağlantı dizesi kalırsa test klona değil paylaşımlı DB'ye gider.
      for (const conn of usesAppEnv ? cloneKeys : []) {
        const carrier = commands.find((c) => c.run.includes(conn));
        if (carrier) {
          push(`test.${suite.id}.cloneDb`, "warn", `${suite.id}: "${carrier.name}" komutu ${conn} yazıyor; klonun bağlantısını ezer — komuttan çıkarın`);
        }
      }
    }
    if (usesAppEnv) {
      // Takım env'i yalnız teste ÖZGÜ farklar için; ortak bir değişkeni
      // ezmek canlı ortam ile testi yeniden ayrıştırır (kararlar §38).
      const shadowed = [...new Set(commands.flatMap((c) => Object.keys(c.env)).filter((k) => Object.hasOwn(profile.appEnv, k)))];
      if (shadowed.length > 0) {
        push(`test.${suite.id}.env`, "warn", `${suite.id}: komut env'i appEnv'deki değişkeni eziyor: ${shadowed.join(", ")} — test canlı ortamdan farklı yapılandırmayla koşar`);
      }
    }
    if (suite.services.length > 0 && !suite.cloneDb && suite.preSteps.length === 0) {
      push(`test.${suite.id}.preSteps`, "warn", `${suite.id} servis istiyor ama ne klon ne ön adım var; tohumsuz DB'de testler yanlış yönde geçebilir`);
    }
    if (suite.report.format !== "exitcode" && !suite.report.path) {
      push(`test.${suite.id}.report`, "error", `${suite.id}: rapor biçimi ${suite.report.format} ama dosya yolu yok`);
    }
  }

  // ── live ─────────────────────────────────────────────────────────────────
  if (profile.live?.enabled) {
    const live = profile.live;
    if (live.compose) {
      const file = resolve(root, live.compose.base);
      if (!existsSync(file)) push("live.compose", "error", `compose dosyası yok: ${live.compose.base}`);
      else {
        try {
          const doc = parseYaml(readFileSync(file, "utf8")) as { services?: Record<string, unknown> } | null;
          const svc = live.app.service ?? "app";
          if (!doc?.services?.[svc]) push("live.compose.app", "error", `compose'da uygulama servisi yok: ${svc}`);
          else push("live.compose", "ok", `${live.compose.base} · ${svc}`);
        } catch (e) {
          push("live.compose", "error", `compose ayrıştırılamadı: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (live.app.image && (live.app.command || live.startCommand)) {
      // HAZIR İMAJ + KOMUT dördüncü yol: `compose.ts` bunu destekliyor
      // (imaj + `entrypoint: sh -lc` + iş volume'ü `app.workdir`e mount).
      // Doğrulayıcı bu yolu bilmiyordu ve çalışan bir profili "error" ile
      // reddediyordu — canlı ortam tam bu yolla ayakta (ölçüldü 2026-09-17).
      //
      // `startCommand` de geçerli: uzun süre şemada ve burada geçerli sayılıp
      // `compose.ts`te HİÇ okunmuyordu — doğrulayıcı hiç kalkmayacak bir
      // profili onaylıyordu.
      if (!live.app.workdir) {
        push("live.start", "error", "hazır imaj yolunda app.workdir gerekli: iş volume'ü oraya bağlanır");
      } else {
        push("live.start", "ok", `${live.app.image} · ${live.app.workdir}`);
      }
    } else if (!live.app.build) {
      push("live.start", "error", "canlı ortam için compose, app.build ya da app.image + (app.command veya startCommand) gerekli");
    }

    // BUILD ZİNCİRİ: `buildBeforeStart` build'i canlı konteynerin komutuna
    // zincirliyor. İki kurulamaz hâli var; ikisinde de sessiz kalmak profilin
    // "build koştu" sanmasına yol açar.
    if (live.buildBeforeStart) {
      if (live.app.build) {
        push("live.buildBeforeStart", "warn", "app.build yolunda build zinciri kurulmaz (kod imajda gömülü); ayar yok sayılacak");
      } else if (!live.app.command && !live.startCommand) {
        push("live.buildBeforeStart", "warn", "başlatma komutu yok (app.command / startCommand): zincirin sonuna eklenecek bir komut bulunamadı");
      } else {
        // Zincir build + açılışı TEK konteynerde koşuyor ve tek sınır
        // healthcheck zaman aşımı: adım başı `timeoutMinutes` compose
        // `command`i içinde uygulanamıyor. Toplam küçükse sağlıklı bir build
        // bile zaman aşımına düşer (Northwind'de tam build ~27 dk).
        const buildMinutes = [...profile.build.preSteps, ...profile.build.steps]
          .reduce((sum, s) => sum + s.timeoutMinutes, 0);
        if (live.healthcheck.timeoutMinutes < buildMinutes) {
          push("live.healthcheck.timeout", "warn",
            `healthcheck.timeoutMinutes (${live.healthcheck.timeoutMinutes}) build adımlarının toplamından (${buildMinutes}) küçük: build konteynerde koşuyor ve açılış bu süreye dahil`);
        }
      }
    }
    if (!live.readiness) push("live.readiness", "warn", "readiness.logPattern yok: 'port açık' hazır sayılacak (Northwind'de yanıltıcıydı)");
    const { found: liveDeps, missing: liveMissing } = resolveServices(profile, live.services);
    if (liveMissing.length > 0) {
      push("live.services", "error", `canlı ortamın istediği servis services içinde tanımsız: ${liveMissing.join(", ")}`);
    }
    if (live.emptyEnv.length === 0 && liveDeps.some((d) => d.optional)) {
      push("live.emptyEnv", "warn", "isteğe bağlı bağımlılık var ama emptyEnv boş; 'tanımlı ama erişilemez' hâli uygulamayı öldürebilir");
    }
  }

  // ── exec / docker ────────────────────────────────────────────────────────
  for (const [i, r] of profile.exec.registries.entries()) {
    // Sıra numarası: scope'suz iki npm kaydı aynı kimliği alıp UI'da React
    // anahtarı çakışıyor, hangisinin denetlendiği de okunmuyordu.
    const id = `exec.registries.${i}.${r.kind === "nuget" ? r.source : (r.scope ?? "varsayılan")}`;
    const token = process.env[r.tokenEnv];
    // Değer asla gösterilmez; yalnız var/yok.
    if (!token) push(id, "error", `${r.tokenEnv} sunucu ortamında tanımsız — restore/npm ci 401 ile düşer (token profile değil sunucu ortamına verilir)`);
    else if (r.kind === "nuget" && token.includes(";")) push(id, "error", `${r.tokenEnv} ';' içeriyor — NuGet kimlik değerinde ayırıcıdır, kaçışı yok`);
    else push(id, "ok", `${r.kind === "nuget" ? `NuGet ${r.source}` : r.url} · token ${r.tokenEnv} sunucuda tanımlı`);
  }
  if (deps.imageExists) {
    const ok = await deps.imageExists(profile.exec.image);
    push("exec.image", ok ? "ok" : "error", ok ? profile.exec.image : `imaj yerelde yok: ${profile.exec.image} (build/pull gerekli)`);

    // İmaj VAR ama içinde araç yoksa iş dakikalarca koşup 127 ile düşer.
    if (ok && deps.imageHasCommand) {
      const tools = toolsUsed([
        ...profile.exec.setup,
        ...profile.build.preSteps,
        ...profile.build.steps,
        ...profile.test.suites.flatMap((s) => [...s.preSteps, s.command]),
      ]).filter((t) => !SKIP_TOOLS.has(t));

      const missing: string[] = [];
      for (const tool of tools) {
        if (!(await deps.imageHasCommand(profile.exec.image, tool))) missing.push(tool);
      }
      if (missing.length) {
        push(
          "exec.image.tools", "error",
          `imajda yok: ${missing.join(", ")} — ${profile.exec.image} bu komutları taşımıyor (çıkış 127 ile düşer)`,
        );
      } else if (tools.length) {
        push("exec.image.tools", "ok", `imajda var: ${tools.join(", ")}`);
      }
    }
  } else push("exec.image", "skip", "Docker erişilemiyor; imaj denetlenmedi");

  // ── portlar ──────────────────────────────────────────────────────────────
  if (deps.portRange) {
    let free = 0;
    for (let p = deps.portRange.from; p <= Math.min(deps.portRange.to, deps.portRange.from + 9); p++) if (await probePort(p)) free++;
    push("ports", free > 0 ? "ok" : "error", `${deps.portRange.from}-${deps.portRange.to} aralığının ilk 10 portundan ${free} tanesi bağlanabilir`);
  }

  // ── security ─────────────────────────────────────────────────────────────
  if (profile.security.neverCopy.length === 0) push("security.neverCopy", "warn", "neverCopy boş; çalışma zamanı token'ları worktree'ye kopyalanabilir");
  if (profile.security.sensitiveFiles.length === 0) push("security.sensitiveFiles", "warn", "sensitiveFiles boş");

  return out;
}

export function summarize(checks: ValidationCheck[]): { errors: number; warnings: number; ok: boolean } {
  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  return { errors, warnings, ok: errors === 0 };
}
