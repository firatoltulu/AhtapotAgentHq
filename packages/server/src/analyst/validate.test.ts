import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectProfileSchema } from "@ahtapot/shared";

import { summarize, toolsUsed, validateProfile } from "./validate.js";
import { validateDockerfileContent } from "./imageBuild.js";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-val-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/app.git"]);
  writeFileSync(join(dir, "App.slnx"), "<Solution />");
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "docker-compose.yml"), "services:\n  host:\n    image: x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "ilk", "--no-gpg-sign"]);
  return dir;
}

test("doğrulama: sağlıklı Northwind benzeri profil hatasız geçer, uyarılar listelenir", async () => {
  const root = makeRepo();
  try {
    const profile = ProjectProfileSchema.parse({
      version: 1, slug: "b", name: "B",
      workspace: { root, rootIsRepo: true, repos: [{ name: "app", path: ".", defaultBranch: "main", primary: true, remote: "https://github.com/acme/app.git" }] },
      exec: { image: "ahtapot/northwind:latest" },
      build: { steps: [{ name: "npm", run: "npm run build", whenChanged: ["**/*.tsx"] }, { name: "dotnet", run: "dotnet build App.slnx -c Debug" }], forbiddenFlags: ["-c Release"] },
      test: { suites: [{ id: "unit", command: { name: "t", run: "dotnet test" }, report: { format: "trx", path: "**/*.trx" } }] },
      live: { compose: { base: "deploy/docker-compose.yml" }, app: { service: "host", containerPort: 5080 }, healthcheck: { path: "/api/ping" }, readiness: { logPattern: "Registered (\\d+) endpoints" } },
      security: { sensitiveFiles: ["**/appsettings.json"], neverCopy: [".run/**"] },
    });
    const checks = await validateProfile(profile, { imageExists: async () => true, portRange: { from: 47500, to: 47509 } });
    const s = summarize(checks);
    assert.equal(s.errors, 0, JSON.stringify(checks.filter((c) => c.level === "error")));
    assert.ok(checks.some((c) => c.id === "live.compose" && c.level === "ok"));
    assert.ok(checks.some((c) => c.id === "exec.image" && c.level === "ok"));
    assert.ok(checks.some((c) => c.id === "ports" && c.level === "ok"));
    assert.ok(checks.some((c) => c.id === "build.forbiddenFlags" && c.level === "ok"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doğrulama: yasak bayrak, yanlış dal, eksik compose servisi, rapor yolu, imaj yokluğu hata verir", async () => {
  const root = makeRepo();
  try {
    const profile = ProjectProfileSchema.parse({
      version: 1, slug: "b", name: "B",
      workspace: {
        root, rootIsRepo: true,
        repos: [{ name: "app", path: ".", defaultBranch: "master", primary: true }],
        ignoredButNeeded: ["plans/"],
      },
      exec: { image: "yok:latest" },
      build: { steps: [{ name: "dotnet", run: "dotnet build -c Release" }], forbiddenFlags: ["-c Release"] },
      test: { suites: [{ id: "int", command: { name: "t", run: "x" }, services: [{ name: "pg", image: "postgres", internalPort: 5432 }], report: { format: "trx" } }] },
      live: { compose: { base: "deploy/docker-compose.yml" }, app: { service: "api", containerPort: 80 }, healthcheck: { path: "/" }, dependencies: [{ service: "es", image: "e", internalPort: 9200, optional: true }] },
    });
    const checks = await validateProfile(profile, { imageExists: async () => false });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.level]));
    assert.equal(byId["build.forbiddenFlags"], "error");
    assert.equal(byId["repo.app.branch"], "error");
    assert.equal(byId["live.compose.app"], "error");
    assert.equal(byId["test.int.report"], "error");
    assert.equal(byId["exec.image"], "error");
    assert.equal(byId["test.int.preSteps"], "warn");
    assert.equal(byId["ignoredButNeeded.plans"], "warn");
    assert.equal(byId["live.readiness"], "warn");
    assert.equal(byId["live.emptyEnv"], "warn");
    assert.equal(byId["repo.app.remote"], "warn");
    assert.equal(summarize(checks).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doğrulama: workspace yoksa tek hata döner; Docker yoksa imaj atlanır", async () => {
  const profile = ProjectProfileSchema.parse({
    version: 1, slug: "b", name: "B",
    workspace: { root: join(tmpdir(), "boyle-bir-yer-yok-" + Date.now()), rootIsRepo: true, repos: [{ name: "a", path: ".", defaultBranch: "main", primary: true }] },
    exec: { image: "x" }, build: { steps: [{ name: "b", run: "true" }] },
  });
  const checks = await validateProfile(profile);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.level, "error");
  const root = makeRepo();
  try {
    const ok = await validateProfile({ ...profile, workspace: { ...profile.workspace, root } });
    assert.equal(ok.find((c) => c.id === "exec.image")?.level, "skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("araç çıkarımı: komut satırından imajda aranacak adlar", () => {
  // YAŞANDI: profil `ahtapot/agent-base`i gösteriyordu, `dotnet` imajda yoktu,
  // iş kurulum dakikalarca koştuktan SONRA çıkış 127 ile düştü.
  assert.deepEqual(toolsUsed([{ run: "dotnet restore Northwind.slnx" }]), ["dotnet"]);

  // Döngü gövdesindeki gerçek komut bulunmalı: Northwind'in npm adımı böyle.
  const loop = toolsUsed([{
    run: 'for dir in Partials/*/wwwroot; do [ -f "$dir/package.json" ] || continue; npm ci --prefix "$dir" || exit 1; done',
  }]);
  assert.ok(loop.includes("npm"), `npm bulunamadı: ${loop.join(",")}`);
  // Döngü DEĞİŞKENİ komut sanılmamalı — ölçüldü: `dir` imajda arandı.
  assert.ok(!loop.includes("dir"), `döngü değişkeni komut sayıldı: ${loop.join(",")}`);

  // Ortam ataması komut değildir; ardındaki komut bulunmalı.
  assert.ok(toolsUsed([{ run: "NODE_ENV=production npm run build" }]).includes("npm"));

  // `&&` ve `|` ile zincirlenmiş her komut ayrı ayrı görülmeli.
  const chained = toolsUsed([{ run: "npm ci && dotnet build | tee log.txt" }]);
  for (const t of ["npm", "dotnet", "tee"]) {
    assert.ok(chained.includes(t), `${t} bulunamadı: ${chained.join(",")}`);
  }

  // Yol içeren çağrı `command -v` ile aranmaz: imajda değil worktree'de yaşar.
  assert.deepEqual(toolsUsed([{ run: "./scripts/build.sh" }]), []);
});

/**
 * `cloneDb` doğrulama dalları.
 *
 * Bu check'ler profil KABULÜNÜ değiştiriyor (hatalı `service` adı `error`
 * üretiyor) ve koşu zamanında 20 saniyelik bir bekleyişin ardından anlaşılan
 * bir kusuru onaydan önce yakalıyor — sessizce bozulurlarsa kimse fark etmez.
 */
function cloneDbProfile(root: string, over: Record<string, unknown> = {}) {
  return ProjectProfileSchema.parse({
    version: 1, slug: "b", name: "B",
    workspace: { root, rootIsRepo: true, repos: [{ name: "app", path: ".", defaultBranch: "main", primary: true, remote: "https://github.com/acme/app.git" }] },
    exec: { image: "ahtapot/northwind:latest" },
    build: { steps: [{ name: "dotnet", run: "dotnet build App.slnx -c Debug" }] },
    live: {
      compose: { base: "deploy/docker-compose.yml" },
      app: { service: "host", containerPort: 5080 },
      healthcheck: { path: "/api/ping" },
      dependencies: [
        { service: "postgres", image: "postgres:17", internalPort: 5432, externalHost: "10.0.0.5", externalPort: 5432 },
      ],
      cloneDb: { enabled: true, service: "postgres", password: "s3cret" },
      ...(over["live"] as Record<string, unknown> ?? {}),
    },
    ...over,
  });
}

test("doğrulama: cloneDb açık ve tutarlıysa ok", async () => {
  const root = makeRepo();
  try {
    const checks = await validateProfile(cloneDbProfile(root), { imageExists: async () => true });
    const c = checks.find((x) => x.id === "database.clone");
    assert.equal(c?.level, "ok", JSON.stringify(c));
    assert.match(c!.message, /10\.0\.0\.5:5432 \(dış\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doğrulama: cloneDb.service bağımlılıklarda yoksa hata", async () => {
  // EN ÖNEMLİ DAL: yanlış servis adı koşu zamanında "postgres cevap vermedi"
  // diye görünüyordu — suçlanan servis değil postgres'ti.
  const root = makeRepo();
  try {
    const profile = cloneDbProfile(root, {
      live: { cloneDb: { enabled: true, service: "pg-yok", password: "x" } },
    });
    const checks = await validateProfile(profile, { imageExists: async () => true });
    const c = checks.find((x) => x.id === "database.clone");
    assert.equal(c?.level, "error", JSON.stringify(c));
    assert.match(c!.message, /pg-yok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doğrulama: cloneDb yalnız postgres için", async () => {
  const root = makeRepo();
  try {
    const profile = cloneDbProfile(root, { database: { kind: "none" } });
    const checks = await validateProfile(profile, { imageExists: async () => true });
    const c = checks.find((x) => x.id === "database.clone");
    assert.equal(c?.level, "error", JSON.stringify(c));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doğrulama: dış postgres parolasızsa uyarı", async () => {
  // Dış servisin kimliği compose env'inde YAZMAZ (konteyner kurulmuyor):
  // parola yoksa `psql` kimlik doğrulamada düşer ve sebep 20 sn sonra görünür.
  const root = makeRepo();
  try {
    const profile = cloneDbProfile(root, {
      live: { cloneDb: { enabled: true, service: "postgres" } },
    });
    const checks = await validateProfile(profile, { imageExists: async () => true });
    assert.ok(checks.some((c) => c.id === "database.clone.creds" && c.level === "warn"), JSON.stringify(checks.filter((c) => c.id.startsWith("database.clone"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doğrulama: konteyner postgres'inde dataPath yoksa uyarı", async () => {
  const root = makeRepo();
  try {
    const profile = cloneDbProfile(root, {
      live: {
        dependencies: [{ service: "postgres", image: "postgres:17", internalPort: 5432, env: { POSTGRES_PASSWORD: "x" } }],
        cloneDb: { enabled: true, service: "postgres" },
      },
    });
    const checks = await validateProfile(profile, { imageExists: async () => true });
    assert.ok(checks.some((c) => c.id === "database.clone.data" && c.level === "warn"), JSON.stringify(checks.filter((c) => c.id.startsWith("database.clone"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doğrulama: cloneDb kapalıysa hiç check üretilmez", async () => {
  // Kapı kapalıyken uyarı üretmek gürültüdür: orkestratör DB'ye dokunmuyor.
  const root = makeRepo();
  try {
    const profile = cloneDbProfile(root, {
      live: { cloneDb: { enabled: false, service: "pg-yok" } },
    });
    const checks = await validateProfile(profile, { imageExists: async () => true });
    assert.ok(!checks.some((c) => c.id.startsWith("database.clone")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Dockerfile denetimi.
 *
 * Bu kapı, agent'ın ürettiği tarifi build'den ÖNCE eliyor ve düşerse profil
 * onayı 409 ile engelleniyor. Yani yanlış pozitifin bedeli, çalışan bir
 * tarifin hiç onaylanamaması — kuralların testi bu yüzden değerli.
 */
const OK_HEAD = "FROM ahtapot/agent-base:latest\n";

test("Dockerfile: çok satırlı COPY --from REDDEDİLMEZ", () => {
  // Docker ters bölü ile satır devamını destekliyor ve bayrak sonraki satıra
  // taşınabiliyor. Fiziksel satıra bakan denetim bunu "yerel COPY" sanıyordu.
  const df = OK_HEAD + "COPY \\\n  --from=builder \\\n  /src /dest\n";
  const r = validateDockerfileContent(df);
  assert.equal(r.ok, true, r.reason);
});

test("Dockerfile: yerel COPY hâlâ reddedilir (çok satırlıysa da)", () => {
  // Düzeltme kuralı gevşetmemeli: bağlamda workspace dosyası yok.
  assert.equal(validateDockerfileContent(OK_HEAD + "COPY agents agents\n").ok, false);
  const multiline = validateDockerfileContent(OK_HEAD + "COPY \\\n  agents \\\n  agents\n");
  assert.equal(multiline.ok, false);
});

test("Dockerfile: hata satır numarası komutun BAŞLADIĞI yeri gösterir", () => {
  // Birleştirilmiş metnin sonunu göstermek, insanı editörde yanlış satıra
  // yollar. `FROM` 1, boş satır 2, `COPY` 3'te başlıyor.
  const r = validateDockerfileContent(OK_HEAD + "\nCOPY \\\n  agents \\\n  agents\n");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /satır 3/);
});

test("Dockerfile: devam satırındaki yorum komutu bölmez", () => {
  const df = OK_HEAD + "COPY \\\n  # araya sıkışan yorum\n  --from=builder \\\n  /src /dest\n";
  assert.equal(validateDockerfileContent(df).ok, true);
});

test("Dockerfile: taban imaj ve USER kuralları korunur", () => {
  assert.equal(validateDockerfileContent("FROM node:22\n").ok, false);
  assert.equal(validateDockerfileContent(OK_HEAD + "USER agent\n").ok, false);
  assert.equal(validateDockerfileContent(OK_HEAD + "USER node:node\n").ok, true);
  assert.equal(validateDockerfileContent(OK_HEAD + "ADD https://x/y /y\n").ok, false);
  assert.equal(validateDockerfileContent("").ok, false);
});

test("Dockerfile: çok satırlı FROM da kabul edilir", () => {
  // `FROM` satır devamıyla yazıldığında ilk fiziksel satır eksik kalıyordu.
  assert.equal(validateDockerfileContent("FROM \\\n  ahtapot/agent-base:latest\n").ok, true);
});
