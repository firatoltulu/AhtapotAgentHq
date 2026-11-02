import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { openDb, newId, schema, type Db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import type { AgentRunner, RunOptions, RunResult } from "../agents/runner.js";
import { Analyst, approveProfile, activeProfile, extractBlock, renderScanBrief } from "./analyst.js";
import { scanWorkspace } from "./scan.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-analyst-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, ".gitignore"), ".run/\n");
  writeFileSync(join(dir, "App.slnx"), "<Solution />");
  mkdirSync(join(dir, ".run"), { recursive: true });
  writeFileSync(join(dir, ".run", "at.txt"), "token");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "ilk", "--no-gpg-sign"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-adb-"));
  const file = join(dir, "t.sqlite");
  runMigrations(file);
  const h = openDb(file);
  return {
    ...h,
    cleanup: () => {
      h.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Analyst'in Dockerfile yazdığı artifactsDir — `makeWorkspace()`dan AYRI bir
 * temp dir. Bu ayrım bilinçli: tam olarak test edilmek istenen şey, üretilen
 * Dockerfile'ın workspace'e (yabancı repo) hiç sızmaması.
 */
function makeArtifactsDir() {
  const dir = mkdtempSync(join(tmpdir(), "ahtapot-artifacts-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let slugCounter = 0;
function seedProject(db: Db, root: string): string {
  const id = newId();
  db.insert(schema.projects)
    .values({ id, slug: `p-${slugCounter++}`, name: "Test", workspaceRoot: root })
    .run();
  return id;
}

/** SDK'yı çağırmadan sabit metin döndüren sahte runner. */
function fakeRunner(text: string): AgentRunner {
  return {
    async run(_opts: RunOptions): Promise<RunResult> {
      return {
        runId: newId(),
        sessionId: "s1",
        subtype: "success",
        text,
        costMicroUsd: 1_000,
        numTurns: 3,
        quota: false,
      };
    },
  } as unknown as AgentRunner;
}

function validProfileBlock(root: string): string {
  const profile = {
    version: 1,
    slug: "test",
    name: "Test",
    workspace: {
      root,
      rootIsRepo: true,
      repos: [{ name: "Test", path: ".", defaultBranch: "main", primary: true }],
    },
    exec: { image: "ahtapot/exec:latest" },
    build: { steps: [{ name: "derle", run: "dotnet build App.slnx -c Debug" }] },
  };
  const rationale = {
    "build.steps": { why: "CI aynı komutu koşuyor", source: ".github/workflows/ci.yml:12" },
  };
  return [
    "Analiz tamamlandı.",
    "```PROFILE_JSON",
    JSON.stringify(profile),
    "```",
    "```RATIONALE_JSON",
    JSON.stringify(rationale),
    "```",
  ].join("\n");
}

test("blok ayrıştırma: etiketli JSON çıkarılır", () => {
  const out = extractBlock("önsöz\n```PROFILE_JSON\n{\"a\":1}\n```\nson", "PROFILE_JSON");
  assert.deepEqual(out, { a: 1 });
});

test("blok ayrıştırma: eksik ya da bozuk blok null döner", () => {
  assert.equal(extractBlock("blok yok", "PROFILE_JSON"), null);
  assert.equal(extractBlock("```PROFILE_JSON\n{bozuk\n```", "PROFILE_JSON"), null);
});

test("özet: iç içe repo ve worktree uyarısı agent'a iletilir", () => {
  const w = makeWorkspace();
  try {
    const brief = renderScanBrief(scanWorkspace(w.dir));
    assert.match(brief, /Gitignore'lu ama diskte var/);
    assert.match(brief, /\.run/);
    assert.match(brief, /YENİ ÇALIŞMA AĞACINA GELMEZ/);
  } finally {
    w.cleanup();
  }
});

test("analiz: geçerli çıktı taslak profil olarak kaydedilir", async () => {
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    const analyst = new Analyst(t.db, fakeRunner(validProfileBlock(w.dir)), a.dir);

    const res = await analyst.analyze({
      projectId, slug: "test", name: "Test", workspaceRoot: w.dir,
    });

    assert.equal(res.error, null);
    assert.ok(res.profileId, "profil kaydedilmedi");
    assert.equal(res.profile?.slug, "test");

    const rows = t.db
      .select()
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, res.profileId!))
      .all();
    // ONAY KAPISI: taslak otomatik yürürlüğe girmez.
    assert.equal(rows[0]?.status, "draft");
    assert.equal(rows[0]?.version, 1);
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});

test("analiz: DOCKERFILE bloğu artifactsDir'e yazılır, workspace'e DEĞİL", async () => {
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    const text = `${validProfileBlock(w.dir)}\n\`\`\`DOCKERFILE\nFROM ahtapot/agent-base\n\`\`\``;
    const analyst = new Analyst(t.db, fakeRunner(text), a.dir);

    const res = await analyst.analyze({
      projectId, slug: "test", name: "Test", workspaceRoot: w.dir,
    });

    assert.equal(res.error, null);
    const dockerfilePath = res.profile?.exec.dockerfile;
    assert.ok(dockerfilePath, "exec.dockerfile set edilmedi");
    // MUTLAK yol artifactsDir altında — workspace'e (yabancı repo) HİÇ sızmamalı.
    assert.ok(dockerfilePath!.startsWith(a.dir), "Dockerfile artifactsDir dışına yazıldı");
    assert.ok(!dockerfilePath!.startsWith(w.dir), "Dockerfile workspace'e sızdı — regresyon");
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});

test("analiz: şemaya uymayan çıktı REDDEDİLİR", async () => {
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    // build.steps eksik — üretici taraf güvenilmez, doğrulama tutmalı.
    const bad = "```PROFILE_JSON\n" + JSON.stringify({ version: 1, slug: "x", name: "X" }) + "\n```";
    const analyst = new Analyst(t.db, fakeRunner(bad), a.dir);

    const res = await analyst.analyze({
      projectId, slug: "x", name: "X", workspaceRoot: w.dir,
    });

    assert.ok(res.error, "geçersiz profil kabul edildi");
    assert.equal(res.profileId, null);

    const analyses = t.db.select().from(schema.workspaceAnalyses).all();
    assert.equal(analyses[0]?.status, "failed");
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});

test("analiz: database.migrate/seed null gelirse temizlenip kabul edilir", async () => {
  // YAŞANDI: schemaHint agent'a `migrate: null, seed: null` örneği
  // gösteriyordu; agent bunu birebir kopyaladığında "database.migrate.name:
  // expected string, received undefined" ile REDDEDİLİYORDU — `.optional()`
  // yalnız alanın YOKLUĞUNU kabul eder, `null`ı CommandSchema'nın kendisiyle
  // eşleştirmeye çalışır. Sentez katmanı (dropEmptyOptionalCommands) bu
  // kalıbı artık temizliyor: bu profil kabul EDİLMELİ, "kind" korunmalı.
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    const profile = {
      version: 1,
      slug: "test",
      name: "Test",
      workspace: {
        root: w.dir,
        rootIsRepo: true,
        repos: [{ name: "Test", path: ".", defaultBranch: "main", primary: true }],
      },
      exec: { image: "ahtapot/exec:latest" },
      build: { steps: [{ name: "derle", run: "dotnet build App.slnx -c Debug" }] },
      database: { kind: "postgres", migrate: null, seed: null },
    };
    const block = "```PROFILE_JSON\n" + JSON.stringify(profile) + "\n```";
    const analyst = new Analyst(t.db, fakeRunner(block), a.dir);

    const res = await analyst.analyze({ projectId, slug: "test", name: "Test", workspaceRoot: w.dir });

    assert.equal(res.error, null, `profil reddedildi: ${res.error}`);
    assert.ok(res.profileId, "profil kaydedilmedi");
    assert.equal(res.profile?.database?.kind, "postgres", "kind korunmadı");
    assert.equal(res.profile?.database?.migrate, undefined, "migrate: null undefined'a çevrilmeliydi");
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});

test("analiz: blok hiç üretilmezse hata raporlanır", async () => {
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    const analyst = new Analyst(t.db, fakeRunner("bir şeyler anlattım ama blok yazmadım"), a.dir);

    const res = await analyst.analyze({
      projectId, slug: "x", name: "X", workspaceRoot: w.dir,
    });
    assert.match(res.error ?? "", /PROFILE_JSON/);
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});

test("onay: profil yürürlüğe girer ve öncekiler superseded olur", async () => {
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    const analyst = new Analyst(t.db, fakeRunner(validProfileBlock(w.dir)), a.dir);

    const first = await analyst.analyze({ projectId, slug: "test", name: "Test", workspaceRoot: w.dir });
    approveProfile(t.db, first.profileId!);
    assert.ok(activeProfile(t.db, projectId), "onaylı profil okunamadı");

    // İkinci analiz yeni bir sürüm üretir.
    const second = await analyst.analyze({ projectId, slug: "test", name: "Test", workspaceRoot: w.dir });
    assert.notEqual(second.profileId, first.profileId);

    approveProfile(t.db, second.profileId!);
    const rows = t.db
      .select({ id: schema.projectProfiles.id, status: schema.projectProfiles.status })
      .from(schema.projectProfiles)
      .all();
    const older = rows.find((r) => r.id === first.profileId);
    const newer = rows.find((r) => r.id === second.profileId);
    assert.equal(older?.status, "superseded", "eski profil yürürlükte kaldı");
    assert.equal(newer?.status, "approved");
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});

test("onay öncesi projenin yürürlükte profili yoktur", async () => {
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    const analyst = new Analyst(t.db, fakeRunner(validProfileBlock(w.dir)), a.dir);
    await analyst.analyze({ projectId, slug: "test", name: "Test", workspaceRoot: w.dir });

    // Taslak var ama onaylanmadı: pipeline bu projeyi kullanamaz.
    assert.equal(activeProfile(t.db, projectId), null);
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});

test("analiz: yapısal imza kaydedilir (bayatlık takibi için)", async () => {
  const w = makeWorkspace();
  const t = freshDb();
  const a = makeArtifactsDir();
  try {
    const projectId = seedProject(t.db, w.dir);
    const analyst = new Analyst(t.db, fakeRunner(validProfileBlock(w.dir)), a.dir);
    const res = await analyst.analyze({ projectId, slug: "test", name: "Test", workspaceRoot: w.dir });

    const rows = t.db
      .select({ fp: schema.workspaceAnalyses.fingerprint })
      .from(schema.workspaceAnalyses)
      .where(eq(schema.workspaceAnalyses.id, res.analysisId))
      .all();
    const fp = rows[0]?.fp as Record<string, string>;
    assert.ok(fp["#repos"], "repo imzası yok");
  } finally {
    t.cleanup();
    w.cleanup();
    a.cleanup();
  }
});
