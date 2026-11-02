import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { ProjectProfileSchema, type PackageSource } from "@ahtapot/shared";

import type { CommandExecutor, ExecRequest, ExecResult } from "./executor.js";
import { buildRegistryAuth, withRegistryAuth } from "./registryAuth.js";

const NPM: PackageSource = { kind: "npm", scope: "@sirket", url: "https://npm.pkg.github.com", username: "token", tokenEnv: "NPM_TOKEN_SIRKET" };
const NUGET: PackageSource = { kind: "nuget", source: "SirketFeed", username: "ci", tokenEnv: "NUGET_TOKEN" };
const ENV = { NPM_TOKEN_SIRKET: "tok-npm-123", NUGET_TOKEN: "tok-nuget-456" };

/** Gelen isteği saklar; istenen satırları çıktı olarak basar. */
class Spy implements CommandExecutor {
  last: ExecRequest | undefined;
  constructor(private readonly emit: string[] = []) {}
  async run(req: ExecRequest): Promise<ExecResult> {
    this.last = req;
    for (const l of this.emit) req.onLine("stdout", l);
    return { exitCode: 0, durationMs: 1, timedOut: false };
  }
}

const baseReq = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  command: "npm ci", cwd: "/w", env: {}, timeoutMs: 1000, onLine: () => {}, ...over,
});

test("npm: .npmrc sır taşımaz, token yalnız env'de; adres sonuna / eklenir", () => {
  const a = buildRegistryAuth([NPM], ENV);
  // Nerf-dart anahtarı sondaki / olmadan ("//host:_authToken") npm'de eşleşmez.
  assert.match(a.npmrc, /^@sirket:registry=https:\/\/npm\.pkg\.github\.com$/m);
  assert.match(a.npmrc, /^\/\/npm\.pkg\.github\.com\/:_authToken=\$\{NPM_TOKEN_SIRKET\}$/m);
  assert.ok(!a.npmrc.includes("tok-npm-123"), "token dosyaya sızmamalı");
  assert.equal(a.env["NPM_TOKEN_SIRKET"], "tok-npm-123");
  assert.equal(a.env["NPM_CONFIG_USERCONFIG"], "/tmp/ahtapot-npmrc");
});

test("npm: scope'suz kayıt varsayılan registry olur; yol içeren adres korunur", () => {
  const a = buildRegistryAuth([{ ...NPM, scope: undefined as never, url: "https://pkgs.dev.azure.com/o/p/_packaging/f/npm/registry" }], ENV);
  assert.match(a.npmrc, /^registry=https:\/\/pkgs\.dev\.azure\.com\/o\/p\/_packaging\/f\/npm\/registry$/m);
  assert.match(a.npmrc, /^\/\/pkgs\.dev\.azure\.com\/o\/p\/_packaging\/f\/npm\/registry\/:_authToken=/m);
});

test("NuGet: kimlik env'le verilir, .npmrc yazılmaz", async () => {
  const a = buildRegistryAuth([NUGET], ENV);
  assert.equal(a.env["NuGetPackageSourceCredentials_SirketFeed"], "Username=ci;Password=tok-nuget-456;ValidAuthenticationTypes=basic");
  assert.equal(a.npmrc, "");
  assert.ok(!("NPM_CONFIG_USERCONFIG" in a.env), "yalnız NuGet varken npm userconfig'i ezilmemeli");

  const spy = new Spy();
  await withRegistryAuth(spy, [NUGET], ENV).run(baseReq({ command: "dotnet restore" }));
  assert.equal(spy.last?.command, "dotnet restore", "komut öne dosya yazımı eklenmeden gitmeli");
});

test("npm + NuGet birlikte: iki kimlik de aynı komutta", async () => {
  const spy = new Spy();
  await withRegistryAuth(spy, [NPM, NUGET], ENV).run(baseReq());
  assert.ok(spy.last?.env["NPM_CONFIG_USERCONFIG"]);
  assert.ok(spy.last?.env["NuGetPackageSourceCredentials_SirketFeed"]);
  assert.match(spy.last?.command ?? "", /^printf .* && npm ci$/s);
});

test("çıktıdaki token değeri maskelenir (her iki tür)", async () => {
  const seen: string[] = [];
  const spy = new Spy(["401 for tok-npm-123", "Password=tok-nuget-456;x", "temiz satır"]);
  await withRegistryAuth(spy, [NPM, NUGET], ENV).run(baseReq({ onLine: (_s, l) => seen.push(l) }));
  assert.deepEqual(seen, ["401 for ***", "Password=***;x", "temiz satır"]);
});

test("tanımsız token: kimlik verilmez, komut olduğu gibi geçer ve ad raporlanır", async () => {
  const a = buildRegistryAuth([NPM, NUGET], {});
  assert.deepEqual(a.missing, ["NPM_TOKEN_SIRKET", "NUGET_TOKEN"]);
  // Boş token'la `${VAR}` bırakılırsa npm "Failed to replace env" der ve asıl nedeni gizler.
  assert.equal(a.npmrc, "");
  assert.deepEqual(a.env, {});

  const spy = new Spy();
  await withRegistryAuth(spy, [NPM], {}).run(baseReq());
  assert.equal(spy.last?.command, "npm ci");
});

test("komutun kendi env'i kazanır; kayıt yoksa yürütücü sarılmaz", async () => {
  const spy = new Spy();
  await withRegistryAuth(spy, [NPM], ENV).run(baseReq({ env: { NPM_CONFIG_USERCONFIG: "/özel/npmrc" } }));
  assert.equal(spy.last?.env["NPM_CONFIG_USERCONFIG"], "/özel/npmrc");
  assert.equal(withRegistryAuth(spy, [], ENV), spy);
});

test("NuGet: ';' içeren token ya da kullanıcı adı fırlatır, mesaj değeri taşımaz", () => {
  // `;` alan ayırıcı: sessizce kesilen kimlik anlaşılmaz bir 401 üretirdi.
  assert.throws(() => buildRegistryAuth([NUGET], { NUGET_TOKEN: "abc;def" }), (e: Error) => /SirketFeed/.test(e.message) && !e.message.includes("abc"));
  assert.throws(() => buildRegistryAuth([{ ...NUGET, username: "a;b" }], ENV), /kullanıcı adı/);
});

test("komutun kendi verdiği token da maskelenir; boş token çıktıyı bozmaz", async () => {
  const seen: string[] = [];
  const spy = new Spy(["leak komut-token-789", "düz"]);
  await withRegistryAuth(spy, [NPM], ENV).run(baseReq({ env: { NPM_TOKEN_SIRKET: "komut-token-789" }, onLine: (_s, l) => seen.push(l) }));
  assert.deepEqual(seen, ["leak ***", "düz"]);
  // Komut token'ı boşaltırsa `replaceAll("", "***")` her karakteri bozardı.
  const seen2: string[] = [];
  await withRegistryAuth(new Spy(["abc"]), [NPM], ENV).run(baseReq({ env: { NPM_TOKEN_SIRKET: "" }, onLine: (_s, l) => seen2.push(l) }));
  assert.deepEqual(seen2, ["abc"]);
});

test("komutun ezdiği NuGet kimlik değerinin parolası da maskelenir", async () => {
  const seen: string[] = [];
  const spy = new Spy(["Password=pw-ezilen", "yalnız pw-ezilen basıldı", "temiz"]);
  const env = { NuGetPackageSourceCredentials_SirketFeed: "Username=x;Password=pw-ezilen;ValidAuthenticationTypes=basic" };
  await withRegistryAuth(spy, [NUGET], ENV).run(baseReq({ env, onLine: (_s, l) => seen.push(l) }));
  // Tek başına basılan parola, tüm değer maskesinin yakalayamadığı durum.
  assert.deepEqual(seen, ["Password=***", "yalnız *** basıldı", "temiz"]);
});

test("çakışan sırlarda uzun olan önce maskelenir (sunucu `pw-`, komut `pw-ezilen`)", async () => {
  const seen: string[] = [];
  const env = { NuGetPackageSourceCredentials_SirketFeed: "Username=x;Password=pw-ezilen;ValidAuthenticationTypes=basic" };
  // Kısa olan önce uygulansaydı çıktı "***ezilen" kalırdı.
  await withRegistryAuth(new Spy(["Password=pw-ezilen"]), [NUGET], { NUGET_TOKEN: "pw-" }).run(baseReq({ env, onLine: (_s, l) => seen.push(l) }));
  assert.deepEqual(seen, ["Password=***"]);
});

test("sunucuda token tanımsızken komutun kendi kimliği yine maskelenir", async () => {
  const seen: string[] = [];
  const env = { NuGetPackageSourceCredentials_SirketFeed: "Username=x;Password=pw-komut;ValidAuthenticationTypes=basic" };
  const spy = new Spy(["Password=pw-komut"]);
  await withRegistryAuth(spy, [NUGET], {}).run(baseReq({ env, onLine: (_s, l) => seen.push(l) }));
  assert.deepEqual(seen, ["Password=***"]);
  // Hiç sır yoksa komut olduğu gibi geçer: env'e dokunulmaz.
  const plain = new Spy();
  await withRegistryAuth(plain, [NUGET], {}).run(baseReq({ command: "dotnet restore" }));
  assert.equal(plain.last?.command, "dotnet restore");
});

// ── Gerçek kabuk ─────────────────────────────────────────────────────────────
// Dosya yazımı kabuk metni: tek tırnak içinde `${VAR}` GENİŞLEMEMELİ ve token
// dosyaya düşmemeli. Dize karşılaştıran test ikisini de kaçırırdı.

test("gerçek kabuk: yazılan .npmrc'de ${VAR} olduğu gibi kalır, token yoktur", { skip: process.platform === "win32" }, async () => {
  const inner: CommandExecutor = {
    async run(req) {
      try {
        execFileSync("sh", ["-c", req.command], { cwd: "/", env: { ...process.env, ...req.env }, stdio: "pipe" });
        return { exitCode: 0, durationMs: 1, timedOut: false };
      } catch {
        return { exitCode: 1, durationMs: 1, timedOut: false };
      }
    },
  };
  const res = await withRegistryAuth(inner, [NPM], ENV).run(baseReq({ command: "true" }));
  assert.equal(res.exitCode, 0);
  const file = readFileSync("/tmp/ahtapot-npmrc", "utf8");
  assert.ok(file.includes("${NPM_TOKEN_SIRKET}"), `${"${VAR}"} kabukta genişlemiş:\n${file}`);
  assert.ok(!file.includes("tok-npm-123"));
});

// ── Şema ─────────────────────────────────────────────────────────────────────

function parseWith(registries: unknown) {
  return ProjectProfileSchema.safeParse({ ...minimal(), exec: { image: "mcr.microsoft.com/dotnet/sdk:10.0", registries } });
}

/** Şemanın zorunlu alanlarını dolduran en küçük profil — yalnız `exec` değişir. */
function minimal(): Record<string, unknown> {
  return {
    version: 1, slug: "t", name: "T",
    workspace: { root: "/w", rootIsRepo: true, repos: [{ name: "a", path: ".", defaultBranch: "main", primary: true }] },
    build: { steps: [{ name: "b", run: "true" }] },
  };
}

test("şema: kind'sız eski kayıt npm sayılır; npm url'siz, NuGet source'suz reddedilir", () => {
  const ok = parseWith([{ url: "https://r.example/", tokenEnv: "T" }]);
  assert.ok(ok.success, ok.success ? "" : JSON.stringify(ok.error.issues));
  assert.equal(ok.data.exec.registries[0]?.kind, "npm");

  assert.ok(!parseWith([{ kind: "npm", tokenEnv: "T" }]).success, "npm için url zorunlu");
  assert.ok(!parseWith([{ kind: "nuget", tokenEnv: "T" }]).success, "nuget için source zorunlu");
  assert.ok(parseWith([{ kind: "nuget", source: "Feed", tokenEnv: "T" }]).success);
});

test("şema: token değeri gibi görünen tokenEnv ve bozuk scope/source reddedilir", () => {
  // Sır yanlışlıkla `tokenEnv`e yapıştırılırsa profile (DB + UI) sızardı.
  assert.ok(!parseWith([{ url: "https://r.example/", tokenEnv: "ghp_abcdef1234" }]).success);
  assert.ok(!parseWith([{ url: "https://r.example/", tokenEnv: "T", scope: "sirket" }]).success);
  assert.ok(!parseWith([{ kind: "nuget", source: "Şirket Feed", tokenEnv: "T" }]).success);
});
