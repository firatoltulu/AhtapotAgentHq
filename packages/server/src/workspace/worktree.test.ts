import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectProfileSchema, containsSecret, type ProjectProfile } from "@ahtapot/shared";

import { HostExecutor } from "../build/executor.js";
import { openDb, newId, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { acquireLease, heldLeases, LeaseConflict, releaseLease } from "../resources/leases.js";
import { WorktreeManager, renderBranch, slugify } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTIZINTI0In0.imzaimzaimza";

/**
 * Northwind'in yapısını taklit eden kaynak workspace:
 * takip edilen sır dosyası, gitignore'lu plan dizini, gitignore'lu token dizini,
 * iç içe repo.
 */
function makeSource() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-src-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, ".gitignore"), ["plans/", ".run/", "Nested.Lib/", ""].join("\n"));
  writeFileSync(join(dir, "App.slnx"), "<Solution />");
  mkdirSync(join(dir, "Host"), { recursive: true });
  writeFileSync(join(dir, "Host", "appsettings.json"), '{"Password=gizli"}');
  writeFileSync(join(dir, "Host", "appsettings.json.example"), "{}");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "ilk", "--no-gpg-sign"]);

  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(join(dir, "plans", "faz1.md"), "# plan");
  // Plan dizininin İÇİNDE bir token — neverCopy alt yollarda da geçerli olmalı.
  writeFileSync(join(dir, "plans", "token.txt"), FAKE_JWT);
  mkdirSync(join(dir, ".run"), { recursive: true });
  writeFileSync(join(dir, ".run", "at.txt"), FAKE_JWT);

  const nested = join(dir, "Nested.Lib");
  mkdirSync(nested, { recursive: true });
  git(nested, ["init", "-b", "main"]);
  git(nested, ["config", "user.email", "t@t"]);
  git(nested, ["config", "user.name", "T"]);
  writeFileSync(join(nested, "lib.ts"), "export {};");
  git(nested, ["add", "-A"]);
  git(nested, ["commit", "-m", "lib", "--no-gpg-sign"]);

  return dir;
}

function profileFor(root: string, extra: Partial<ProjectProfile> = {}): ProjectProfile {
  return ProjectProfileSchema.parse({
    version: 1, slug: "test", name: "Test",
    workspace: {
      root, rootIsRepo: true,
      repos: [{ name: "app", path: ".", defaultBranch: "main", primary: true }],
      ignoredButNeeded: ["plans/"],
    },
    exec: { image: "x" },
    build: { steps: [{ name: "b", run: "true" }] },
    security: { sensitiveFiles: ["**/appsettings.json"], neverCopy: [".run/**", "**/token.txt"] },
    ...extra,
  });
}

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "ahtapot-wt-"));
  const file = join(dataRoot, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  const source = makeSource();
  const projectId = newId();
  h.db.insert(schema.projects).values({ id: projectId, slug: "test", name: "T", workspaceRoot: source }).run();
  const mgr = new WorktreeManager(h.db);
  // Worktree yönetimi POSIX yol ve sözdizimi üretir (üretimde konteynerde
  // koşuyor); Windows'ta testler `sh` üzerinden koşar ve kök ileri eğik
  // çizgiye çevrilir.
  const executor = new HostExecutor(true);
  const root = dataRoot.replace(/\\/g, "/");
  const sourceRoot = source.replace(/\\/g, "/");
  const prep = (input: { jobId: string; profile: ReturnType<typeof profileFor>; jobSlug: string; targetRepos?: string[]; fetchLockTimeoutMs?: number }) =>
    mgr.prepare({ ...input, executor, root, sourceRoot });
  const newJob = () => {
    const id = newId();
    h.db.insert(schema.jobs).values({ id, projectId, title: "iş" }).run();
    return id;
  };
  return {
    db: h.db, dataRoot, source, mgr, newJob, executor, root, sourceRoot, prep,
    cleanup() {
      h.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    },
  };
}

test("kira: aynı kaynak iki işe verilmez, bırakılınca yeniden verilir", () => {
  const t = setup();
  try {
    const a = t.newJob();
    const b = t.newJob();
    acquireLease(t.db, { jobId: a, kind: "port", value: "5080" });
    assert.throws(() => acquireLease(t.db, { jobId: b, kind: "port", value: "5080" }), LeaseConflict);
    assert.equal(heldLeases(t.db, a).length, 1);
    assert.equal(releaseLease(t.db, "port", "5080"), true);
    assert.equal(releaseLease(t.db, "port", "5080"), false, "ikinci bırakma sessiz geçmeli");
    acquireLease(t.db, { jobId: b, kind: "port", value: "5080" });
  } finally {
    t.cleanup();
  }
});

test("dal adı: şablon doldurulur, başlık slug'a iner", () => {
  assert.equal(slugify("Login ekranı: şifre sıfırlama!"), "login-ekrani-sifre-sifirlama");
  const b = renderBranch("{brand}/{jobId}-{slug}", { jobId: "01a099f3-977d-74bb-8bfa-a29db76f1836", slug: "x" });
  assert.equal(b, "ahtapot/a29db76f1836-x");
});

test("worktree: takip edilenler gelir, plan kopyalanır, token ASLA gelmez, sır silinir", async () => {
  const t = setup();
  try {
    const jobId = t.newJob();
    const [wt] = await t.prep({ jobId, profile: profileFor(t.source), jobSlug: "login" });
    assert.ok(wt);

    assert.ok(existsSync(join(wt.path, "App.slnx")), "takip edilen dosya yok");
    assert.equal(git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"]), wt.branch);
    assert.match(wt.branch, /^ahtapot\/[0-9a-f]{12}-login$/);

    // ignoredButNeeded: plan geldi.
    assert.ok(existsSync(join(wt.path, "plans", "faz1.md")), "plans/ kopyalanmadı");
    assert.deepEqual(wt.copied, ["plans"]);

    // neverCopy: .run/ hiç yok, plans/ İÇİNDEKİ token da yok.
    assert.ok(!existsSync(join(wt.path, ".run")), ".run/ worktree'ye sızdı");
    assert.ok(!existsSync(join(wt.path, "plans", "token.txt")), "alt yoldaki token sızdı");

    // sensitiveFiles: takip edilen sır silindi, şablonu kaldı.
    assert.ok(!existsSync(join(wt.path, "Host", "appsettings.json")), "sır dosyası duruyor");
    assert.ok(existsSync(join(wt.path, "Host", "appsettings.json.example")));
    assert.deepEqual(wt.removed, ["Host/appsettings.json"]);

    // Gitignore'lu iç içe repo worktree'ye gelmez.
    assert.ok(!existsSync(join(wt.path, "Nested.Lib")));

    // "6 hata" #6: ağaçta hiçbir dosyada sahte JWT olmamalı.
    for (const f of ["plans/faz1.md", "App.slnx"]) {
      assert.ok(!containsSecret(readFileSync(join(wt.path, f), "utf8")), `${f} sır taşıyor`);
    }

    // Kira tutuluyor; kaynak workspace'e dokunulmadı.
    assert.equal(heldLeases(t.db, jobId, "worktree")[0]?.value, wt.path);
    assert.equal(git(t.source, ["worktree", "list"]).split("\n").length, 1, "kaynak repoya worktree eklendi");

    // Windows MAX_PATH: Northwind'de checkout "Filename too long" ile düşmüştü.
    assert.equal(git(wt.mirror, ["config", "core.longpaths"]), "true");

    // Eski (ayarsız) mirror da ikinci hazırlıkta ayarı alır.
    git(wt.mirror, ["config", "--unset", "core.longpaths"]);
    await t.prep({ jobId: t.newJob(), profile: profileFor(t.source), jobSlug: "eski" });
    assert.equal(git(wt.mirror, ["config", "core.longpaths"]), "true", "mevcut mirror ayarsız kaldı");
  } finally {
    t.cleanup();
  }
});

test("worktree: neverCopy, ignoredButNeeded ile çakışınca KAZANIR", async () => {
  const t = setup();
  try {
    const jobId = t.newJob();
    // İnsan yanlışlıkla .run/'ı da "gerekli" işaretledi; neverCopy yine tutmalı.
    const profile = profileFor(t.source);
    profile.workspace.ignoredButNeeded = ["plans/", ".run/"];
    const [wt] = await t.prep({ jobId, profile, jobSlug: "x" });
    assert.ok(!existsSync(join(wt!.path, ".run")), ".run/ kopyalandı");
    assert.deepEqual(wt!.refused, [".run"]);
  } finally {
    t.cleanup();
  }
});

test("worktree: iki iş aynı repodan ayrı dal ve ayrı ağaç alır; mirror paylaşılır", async () => {
  const t = setup();
  try {
    const a = t.newJob();
    const b = t.newJob();
    const profile = profileFor(t.source);
    const [[wa], [wb]] = await Promise.all([
      t.prep({ jobId: a, profile, jobSlug: "a" }),
      t.prep({ jobId: b, profile, jobSlug: "b" }),
    ]);
    assert.notEqual(wa!.path, wb!.path);
    assert.notEqual(wa!.branch, wb!.branch);
    assert.equal(wa!.mirror, wb!.mirror);
    assert.equal(git(wa!.mirror, ["worktree", "list"]).split("\n").length, 3, "mirror 2 worktree + kendisi");
  } finally {
    t.cleanup();
  }
});

test("worktree: kaynaktaki yeni commit ikinci işte görülür (mirror fetch)", async () => {
  const t = setup();
  try {
    const profile = profileFor(t.source);
    await t.prep({ jobId: t.newJob(), profile, jobSlug: "a" });

    writeFileSync(join(t.source, "yeni.txt"), "yeni");
    git(t.source, ["add", "-A"]);
    git(t.source, ["commit", "-m", "yeni", "--no-gpg-sign"]);

    const [wt] = await t.prep({ jobId: t.newJob(), profile, jobSlug: "b" });
    assert.ok(existsSync(join(wt!.path, "yeni.txt")), "mirror tazelenmedi");
    assert.equal(wt!.fetchSkipped, false);
  } finally {
    t.cleanup();
  }
});

test("worktree: kaldırınca ağaç gider, kira bırakılır, dal mirror'da kalır", async () => {
  const t = setup();
  try {
    const jobId = t.newJob();
    const [wt] = await t.prep({ jobId, profile: profileFor(t.source), jobSlug: "x" });
    const removed = await t.mgr.remove({ jobId, profileSlug: "test", executor: t.executor, root: t.root });
    assert.deepEqual(removed, [wt!.path]);
    assert.ok(!existsSync(wt!.path));
    assert.equal(heldLeases(t.db, jobId, "worktree").length, 0);
    assert.equal(git(wt!.mirror, ["show-ref", "--verify", `refs/heads/${wt!.branch}`]).length > 0, true);
    // Aynı iş yeniden hazırlanabilir (dal zaten var → yeniden yaratılmaz).
    const [again] = await t.prep({ jobId, profile: profileFor(t.source), jobSlug: "x" });
    assert.equal(again!.branch, wt!.branch);
  } finally {
    t.cleanup();
  }
});
