import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { and, desc, eq, inArray } from "drizzle-orm";

import { parseGitRemote, ProjectProfileSchema, type ProjectProfile } from "@ahtapot/shared";

import { newId, isoNow, type Db, schema } from "../db/index.js";
import type { AgentRunner } from "../agents/runner.js";
import { loadRolePrompt } from "../agents/prompts.js";
import { fingerprintDrift, scanWorkspace, type ScanResult } from "./scan.js";
import { dockerfileAbsPath, validateDockerfileContent } from "./imageBuild.js";

/**
 * Analyst — workspace'i profile çeviren rol.
 *
 * Akış: mekanik tarama → agent yorumu → şema doğrulaması → İNSAN ONAYI.
 *
 * Onay kapısı burada pazarlık konusu değil: yanlış bir build komutu ya da
 * kaçırılmış bir hassas dosya her işi etkiler. Agent taslak üretir, insan
 * onaylar; yalnız onaylı profil pipeline'da kullanılır.
 */

/**
 * Agent çıktısından etiketli JSON bloğunu çıkarır.
 *
 * Model bloğu unutabilir ya da çevresine metin yazabilir — ikisi de normaldir.
 * Bulunamazsa hata değil `null` döner; çağıran sentezleme/yeniden deneme
 * kararını verir. Üretici taraf güvenilmez kabul edilir.
 */
export function extractBlock(text: string, tag: string): unknown | null {
  const fence = new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)```", "i");
  const m = fence.exec(text);
  const raw = m?.[1]?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Agent çıktısından etiketli HAM METİN bloğunu çıkarır.
 *
 * `extractBlock`in JSON'suz ikizi: Dockerfile JSON değildir, ayrıştırılmaz.
 * Blok yoksa `null` — çağıran kararı verir (Dockerfile'sız profil de geçerli
 * bir sonuçtur, yalnız onayda "imaj yok" dalına düşer).
 */
export function extractTextBlock(text: string, tag: string): string | null {
  const fence = new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)```", "i");
  const raw = fence.exec(text)?.[1]?.trim();
  return raw ? raw : null;
}

/**
 * Opsiyonel `Command` alanlarında (`database.migrate`, `database.seed`,
 * `live.startCommand`) agent'ın bıraktığı ANLAMSIZ değeri temizler.
 *
 * YAŞANDI: `schemaHint`teki örnek `migrate: null, seed: null` gösteriyordu
 * (bir alanı "yok" diye işaretlemenin JSON'daki en doğal yolu) ama gerçek
 * şema bu alanlarda `.optional()` — yalnız `undefined` (alanın HİÇ
 * bulunmaması) kabul eder, `null`ı `CommandSchema`nın kendisiyle eşleştirmeye
 * çalışır ve içindeki zorunlu `name`/`run` eksik kaldığı için "expected
 * string, received undefined" ile düşer. Kural 3 (üretici taraf güvenilmez):
 * agent'ı "asla null yazma" diye eğitmek yerine, orkestratör bu tek
 * kalıbı(`null` ya da `name`siz kırık nesne) SESSİZCE `undefined`a çevirir —
 * agent'ın gerçekten kastettiği "bu adım yok" durumu zaten budur.
 */
function dropEmptyOptionalCommands(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  for (const key of ["database", "live"]) {
    const section = obj[key];
    if (!section || typeof section !== "object") continue;
    const patched = { ...(section as Record<string, unknown>) };
    for (const field of ["migrate", "seed", "startCommand"]) {
      if (!(field in patched)) continue;
      const cmd = patched[field];
      const isEmpty =
        cmd === null ||
        (typeof cmd === "object" &&
          cmd !== null &&
          !(cmd as Record<string, unknown>)["name"] &&
          !(cmd as Record<string, unknown>)["run"]);
      if (isEmpty) delete patched[field];
    }
    obj[key] = patched;
  }
  return obj;
}

/** Taramayı agent'ın okuyabileceği kompakt bir özete indirger. */
export function renderScanBrief(scan: ScanResult): string {
  const lines: string[] = [];
  lines.push(`# Workspace: ${scan.root}`);
  lines.push(`Kök git reposu mu: ${scan.rootIsRepo ? "evet" : "HAYIR"}`);

  lines.push("\n## Repolar");
  for (const r of scan.repos) {
    const flags = r.nested ? "  [İÇ İÇE REPO — submodule değil]" : "";
    lines.push(`- ${r.path} · dal=${r.defaultBranch} · remote=${r.remote ?? "yok"}${flags}`);
  }

  if (scan.ignoredButPresent.length > 0) {
    lines.push("\n## Gitignore'lu ama diskte var");
    lines.push("Bunlar `git worktree` ile YENİ ÇALIŞMA AĞACINA GELMEZ.");
    lines.push("Hangisi agent'ın işine yarar, hangisi asla kopyalanmamalı — karar ver:");
    for (const p of scan.ignoredButPresent) lines.push(`- ${p}`);
  }

  if (scan.oversizedFiles.length > 0) {
    lines.push("\n## Büyük dosyalar (ham okuma)");
    for (const f of scan.oversizedFiles.slice(0, 15)) {
      lines.push(`- ${f.path} · ${(f.bytes / 1024).toFixed(0)} KB`);
    }
  }

  lines.push("\n## İşaretler");
  for (const [k, v] of Object.entries(scan.markers)) {
    if (v.length > 0) lines.push(`- ${k}: ${v.slice(0, 25).join(", ")}`);
  }

  return lines.join("\n");
}

export interface AnalyzeInput {
  projectId: string;
  slug: string;
  name: string;
  workspaceRoot: string;
  /**
   * Çağıran önceden üretebilir: REST katmanı 202 ile kimliği hemen döndürür,
   * analiz arka planda sürer. Verilmezse burada üretilir.
   */
  analysisId?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface AnalyzeResult {
  analysisId: string;
  profileId: string | null;
  profile: ProjectProfile | null;
  rationale: unknown;
  scan: ScanResult;
  runId: string;
  costMicroUsd: number;
  error: string | null;
}

export class Analyst {
  constructor(
    private readonly db: Db,
    private readonly runner: AgentRunner,
    /**
     * Dockerfile'ların yazıldığı kök. ASLA hedef workspace değil — bkz.
     * `dockerfileAbsPath` (imageBuild.ts), motorun ürettiği yapı eserleri
     * yabancı git reposuna karışmaz.
     */
    private readonly artifactsDir: string,
    /**
     * Taslak profil insan onayını bekliyor — iş olayı değil (hub'a düşmez),
     * bildirim buradan tetiklenir. Analiz dakikalar sürüyor; operatör
     * sonucu sayfayı yenileyerek beklememeli.
     */
    private readonly onDraft?: (projectId: string, profileId: string) => void,
  ) {}

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const scan = scanWorkspace(input.workspaceRoot);

    // Buraya kadar her şey senkron: `analyze()` promise'ini döndürdüğünde
    // analiz satırı DB'de vardır ve çağıran hemen sorgulayabilir.
    const analysisId = input.analysisId ?? newId();
    this.db
      .insert(schema.workspaceAnalyses)
      .values({
        id: analysisId,
        projectId: input.projectId,
        status: "running",
        fingerprint: scan.fingerprint as never,
      })
      .run();

    const schemaHint = JSON.stringify(
      {
        version: 1,
        slug: input.slug,
        name: input.name,
        workspace: {
          root: scan.root,
          rootIsRepo: scan.rootIsRepo,
          repos: [{ name: "", path: "", defaultBranch: "", primary: true }],
          ignoredButNeeded: [],
        },
        exec: { image: "", egressAllowlist: [] },
        services: [{ name: "", image: "", internalPort: 0, healthCmd: "", optional: false }],
        build: {
          preSteps: [{ name: "", run: "", cwd: "." }],
          steps: [{ name: "", run: "", cwd: ".", whenChanged: [], exceptPaths: [] }],
          forbiddenFlags: [],
        },
        // Canlı ortam ve servis/klon isteyen takımların ORTAK env'i (analyst.md).
        appEnv: {},
        test: {
          suites: [
            {
              id: "",
              command: { name: "", run: "" },
              services: [""],
              cloneDb: false,
              preSteps: [{ name: "", run: "" }],
              runAt: "qa",
            },
          ],
        },
        live: {
          app: { containerPort: 0 },
          services: [""],
          cloneDb: false,
          emptyEnv: [],
          healthcheck: { path: "/", expectStatus: [200] },
          readiness: { logPattern: "", minCaptureValue: 0 },
          // Adım komutları dalın kapsamını env'den okur (analyst.md "DAST").
          dast: {
            enabled: false,
            scope: { mode: "branch", files: [], routePattern: "", routePrefix: "", whenEmpty: "full" },
            steps: [{ id: "", image: "", run: "", report: { format: "junit", file: "" }, timeoutMinutes: 15 }],
            minRisk: "high",
            autoFix: false,
          },
        },
        // migrate/seed OPSİYONEL: adım yoksa alanı HİÇ YAZMA (null DEĞİL —
        // şema `null`ı kabul etmez, "alan yok" ile "alan null" aynı şey
        // değildir). Buradaki `migrate` örneği "varsa nasıl görünür"ü gösterir.
        database: { kind: "none", migrate: { name: "", run: "" } },
        git: { branchRequired: true },
        workflow: { developing: "single", commitPolicy: "onApproval", review: { autoTrigger: false } },
        release: { enabled: false, tagPattern: "v{version}", workflow: { file: "release.yml", bumpInput: "bump" } },
        security: { sensitiveFiles: [], neverCopy: [], deniedBashPatterns: [] },
      },
      null,
      2,
    );

    const prompt = [
      renderScanBrief(scan),
      "",
      "## Profil şeması (alan adları bağlayıcı, örnek değerler yalnız biçim gösterir)",
      "```json",
      schemaHint,
      "```",
      "",
      "Workspace'i incele ve üç bloğu üret: ```PROFILE_JSON```, ```RATIONALE_JSON``` ve ```DOCKERFILE```.",
      "Gerekçeleri dosya:satır ile kaynaklandır. Emin olmadığını uydurma.",
      "DOCKERFILE bloğu JSON DEĞİL ham metindir; ilk satırı `FROM ahtapot/agent-base` olmalı.",
      `İmaj etiketi olarak \`exec.image\` alanına \`ahtapot/${input.slug}:latest\` yaz.`,
    ].join("\n");

    let run;
    try {
      run = await this.runner.run({
        jobId: null,
        role: "analyst",
        prompt,
        model: input.model ?? "claude-opus-5-5",
        effort: "high",
        maxTurns: input.maxTurns ?? 60,
        maxBudgetUsd: input.maxBudgetUsd ?? 5,
        cwd: scan.root,
        // Analyst SALT OKUNUR: yazma araçları yapısal olarak kapalı.
        disallowedTools: ["Write", "Edit", "NotebookEdit", "MultiEdit"],
        systemPrompt: loadRolePrompt("analyst"),
      });
    } catch (err) {
      // Sürücü fırlatırsa (kimlik yok, SDK çöktü) satır "running"da KALMAMALI —
      // aksi hâlde UI sonsuza dek "analiz sürüyor" gösterir.
      const error = err instanceof Error ? err.message : String(err);
      this.db
        .update(schema.workspaceAnalyses)
        .set({ status: "failed", error })
        .where(eq(schema.workspaceAnalyses.id, analysisId))
        .run();
      return {
        analysisId, profileId: null, profile: null, rationale: null, scan,
        runId: "", costMicroUsd: 0, error,
      };
    }

    const rawProfile = extractBlock(run.text, "PROFILE_JSON");
    const rationale = extractBlock(run.text, "RATIONALE_JSON");

    if (!rawProfile) {
      const error = `agent PROFILE_JSON bloğu üretmedi (bitiş: ${run.subtype})`;
      this.db
        .update(schema.workspaceAnalyses)
        .set({ status: "failed", error, agentRunId: run.runId })
        .where(eq(schema.workspaceAnalyses.id, analysisId))
        .run();
      return {
        analysisId, profileId: null, profile: null, rationale, scan,
        runId: run.runId, costMicroUsd: run.costMicroUsd, error,
      };
    }

    // Üretici taraf güvenilmez: şema doğrulaması geçmeyen profil kaydedilmez.
    // Sentez adımı (kural 3, orta katman): agent'ın "bu adım yok" derken
    // yazdığı `null`/kırık nesneleri temizler — anlamı DEĞİŞTİRMEZ, yalnız
    // Zod'un beklediği biçime (alanın yokluğu) çevirir.
    const parsed = ProjectProfileSchema.safeParse(dropEmptyOptionalCommands(rawProfile));
    if (!parsed.success) {
      const error = `profil şemaya uymuyor: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(" · ")}`;
      this.db
        .update(schema.workspaceAnalyses)
        .set({ status: "failed", error, agentRunId: run.runId, findings: rawProfile as never })
        .where(eq(schema.workspaceAnalyses.id, analysisId))
        .run();
      return {
        analysisId, profileId: null, profile: null, rationale, scan,
        runId: run.runId, costMicroUsd: run.costMicroUsd, error,
      };
    }

    // Dockerfile'ı SUNUCU yazar, agent değil: Analyst salt-okunur kalıyor
    // (`disallowedTools` değişmedi).
    //
    // HİÇBİR ZAMAN hedef workspace'e yazılmaz — motorun ürettiği bir yapı
    // eseri, bağlı olduğu YABANCI git reposunu kirletmemeli (yaşandı,
    // 2026-09-20: önceki sürüm `<scan.root>/docker/<slug>/Dockerfile`e
    // yazıyordu, Northwind'in kendi deposunu git-dirty hale getiriyordu). Aynı
    // kuralın ters yönü daha önce `docker/northwind/Dockerfile`ın ENGINE
    // reposundan silinmesine yol açmıştı (o dosya tek bir projeye özeldi,
    // motora ait olmamalıydı) — burada motor kendi tarafını düzeltiyor.
    // Dosya artık `dockerfileAbsPath()` ile artifactsDir altında, sunucuya
    // ait bir konuma yazılır.
    //
    // Şema doğrulamasından SONRA: geçersiz bir profil için diske dosya
    // bırakmanın anlamı yok. Doğrulama düşerse `exec.dockerfile` boş kalır ve
    // profil yine kaydedilir — onay akışı o zaman "imaj yok, tarif de yok"
    // dalına düşüp sert biçimde durdurur.
    const profile = parsed.data;
    // REMOTE TARAMADAN SENTEZLENİR (kural 3, orta katman).
    //
    // YAŞANDI (2026-09-24): repo URL'siyle klonlanan workspace'te tarama
    // `origin`i biliyordu ama şablonda alan olmadığı için Analyst `remote`
    // yazmadı; iş "PR açılmadı (remote GitHub değil)" diyerek Done oldu.
    // Mekanik bir gerçek LLM'in hatırlamasına bırakılmaz — agent yazdıysa
    // onunki kalır, yazmadıysa aynı yoldaki reponun `origin`i girer.
    for (const repo of profile.workspace.repos) {
      if (repo.remote) continue;
      const found = scan.repos.find((r) => r.path === repo.path)?.remote;
      // Biçimi bozuk ya da token taşıyan origin profile KOPYALANMAZ (kural 4).
      if (found && parseGitRemote(found).ok) repo.remote = found;
    }
    // Blok gelmemesi ya da reddedilmesi analizi DÜŞÜRMEZ; nedeni analiz
    // satırında not düşülür ki UI "imaj neden build edilmedi" sorusunu
    // cevaplayabilsin. Durum yine `succeeded` — profil geçerli, yalnız imajsız.
    let dockerfileNote: string | null = null;
    const dockerfile = extractTextBlock(run.text, "DOCKERFILE");
    if (dockerfile) {
      const check = validateDockerfileContent(dockerfile);
      if (!check.ok) {
        dockerfileNote = `DOCKERFILE bloğu reddedildi: ${check.reason}`;
      } else {
        const abs = dockerfileAbsPath(this.artifactsDir, input.projectId);
        try {
          mkdirSync(dirname(abs), { recursive: true });
          // Dockerfile satır sonuna duyarlı değil ama CRLF'li bir heredoc
          // konteyner içinde kırılır; normalize edilmiş hâli yazılır.
          writeFileSync(abs, `${dockerfile.replace(/\r\n/g, "\n")}\n`, "utf8");
          // MUTLAK yol saklanır: okuyan taraf (`imageBuildPlan`,
          // `buildProfileImage`) "neye göreli" diye yorumlamak zorunda
          // kalmasın — gizli bir "şuna göreli" sözleşmesi tam olarak bugünkü
          // hatanın (workspace'e göreli sanılması) kaynağıydı.
          profile.exec.dockerfile = abs;
        } catch (err) {
          // Yazılamayan dosya analizi ÖLDÜRMEZ: profil (imajsız da olsa)
          // insanın incelemesine değer.
          dockerfileNote = `Dockerfile yazılamadı: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } else {
      dockerfileNote = "agent DOCKERFILE bloğu üretmedi; imaj otomatik build edilmeyecek";
    }

    // Yayın dışa dönük ve geri alınamaz: agent önerse de açık gelmez (kural 3 —
    // üretici taraf güvenilmez). Workflow adı ve girdiler öneri olarak kalır.
    profile.release.enabled = false;
    profile.release.schedule.mode = "off";

    const profileId = saveProfileDraft(this.db, input.projectId, profile, rationale, analysisId);

    this.db
      .update(schema.workspaceAnalyses)
      .set({ status: "succeeded", agentRunId: run.runId, findings: rawProfile as never, note: dockerfileNote })
      .where(eq(schema.workspaceAnalyses.id, analysisId))
      .run();
    this.onDraft?.(input.projectId, profileId);

    return {
      analysisId, profileId, profile: parsed.data, rationale, scan,
      runId: run.runId, costMicroUsd: run.costMicroUsd, error: null,
    };
  }

}

/**
 * Yarıda kalmış analizleri kapatır — sunucu açılışında çağrılır.
 *
 * Analiz süreç içi bir promise'te sürer; süreç ölürse satır "running"da kalır
 * ve hiçbir şey onu tamamlamaz. "Önce niyet yazılır" kuralının bedeli budur:
 * açılışta niyeti görüp sonucu olmayan kayıt yarıda kalmış sayılır.
 */
export function reconcileInterruptedAnalyses(db: Db): number {
  const stuck = db
    .select({ id: schema.workspaceAnalyses.id })
    .from(schema.workspaceAnalyses)
    .where(eq(schema.workspaceAnalyses.status, "running"))
    .all();

  for (const s of stuck) {
    db.update(schema.workspaceAnalyses)
      .set({ status: "failed", error: "sunucu yeniden başladı; analiz yarıda kaldı" })
      .where(eq(schema.workspaceAnalyses.id, s.id))
      .run();
  }
  return stuck.length;
}

/**
 * Taslağı bir sonraki sürüm numarasıyla kaydeder.
 *
 * Analyst çıktısı da insanın elle yazdığı profil de buradan geçer; ikisi de
 * `draft` doğar ve onay kapısından geçmeden yürürlüğe girmez.
 */
export function saveProfileDraft(
  db: Db,
  projectId: string,
  profile: ProjectProfile,
  rationale: unknown,
  analysisId: string | null,
): string {
  return db.transaction((tx) => {
    const existing = tx
      .select({ version: schema.projectProfiles.version })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.projectId, projectId))
      .all();

    const version = existing.reduce((max, r) => Math.max(max, r.version), 0) + 1;
    const id = newId();

    tx.insert(schema.projectProfiles)
      .values({
        id,
        projectId,
        version,
        status: "draft",
        document: profile as never,
        rationale: (rationale ?? null) as never,
        analysisId,
      })
      .run();

    return id;
  });
}

export class ProfileStateError extends Error {
  constructor(readonly profileId: string, readonly status: string, readonly wanted: string) {
    super(`profil ${wanted} değil (${status}): ${profileId}`);
    this.name = "ProfileStateError";
  }
}

/** Proje başına tutulan `superseded` profil sürümü sayısı. */
export const SUPERSEDED_KEEP = 5;

/**
 * Profili onaylar ve projenin aktif profili yapar.
 *
 * Onaydan önce hiçbir iş bu profille koşamaz. Yalnız TASLAK onaylanır; önceki
 * onaylı sürüm `superseded` olur. Geçmişin en yeni `SUPERSEDED_KEEP` sürümü ve
 * bir işin gösterdiği her sürüm tutulur; hangi işin hangi profille koştuğu
 * izlenebilir kalır. Diğer taslaklara ve reddedilmişlere dokunulmaz:
 * bekleyen bir taslağı sessizce geçersiz kılmak insanın düzenlemesini yutardı.
 */
export function approveProfile(db: Db, profileId: string, approvedBy = "human"): void {
  db.transaction((tx) => {
    const rows = tx
      .select({ projectId: schema.projectProfiles.projectId, status: schema.projectProfiles.status })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, profileId))
      .all();

    const row = rows[0];
    if (!row) throw new Error(`profil bulunamadı: ${profileId}`);
    if (row.status !== "draft") throw new ProfileStateError(profileId, row.status, "taslak");
    const projectId = row.projectId;

    tx.update(schema.projectProfiles)
      .set({ status: "superseded" })
      .where(
        and(
          eq(schema.projectProfiles.projectId, projectId),
          eq(schema.projectProfiles.status, "approved"),
        ),
      )
      .run();

    tx.update(schema.projectProfiles)
      .set({ status: "approved", approvedAt: isoNow(), approvedBy })
      .where(eq(schema.projectProfiles.id, profileId))
      .run();

    tx.update(schema.projects)
      .set({ activeProfileId: profileId })
      .where(eq(schema.projects.id, projectId))
      .run();

    // Eski sürümleri buda: her onay bir `superseded` doğuruyor ve liste
    // sınırsız uzuyordu. İşin gösterdiği sürüm silinmez (kotada sayılır ama
    // kalır) — iş o profile bakarak koşuyor/koştu. Aynı kural 0011 migration'ında.
    const doomed = tx
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.projectId, projectId), eq(schema.projectProfiles.status, "superseded")))
      .orderBy(desc(schema.projectProfiles.version))
      .all()
      .slice(SUPERSEDED_KEEP)
      .map((p) => p.id);
    if (doomed.length > 0) {
      const inUse = new Set(
        tx
          .select({ profileId: schema.jobs.profileId })
          .from(schema.jobs)
          .where(inArray(schema.jobs.profileId, doomed))
          .all()
          .map((j) => j.profileId),
      );
      const prune = doomed.filter((id) => !inUse.has(id));
      if (prune.length > 0) {
        // Build log dosyaları (`<artifactsDir>/image-builds/<id>.log`) burada
        // silinmez: bu fonksiyon saf DB transaction'ı kalıyor (bkz. `/decision`).
        tx.delete(schema.profileImageBuilds).where(inArray(schema.profileImageBuilds.profileId, prune)).run();
        tx.delete(schema.auditLog).where(inArray(schema.auditLog.subjectId, prune)).run();
        tx.delete(schema.projectProfiles).where(inArray(schema.projectProfiles.id, prune)).run();
      }
    }

    tx.insert(schema.auditLog)
      .values({
        id: newId(),
        actor: approvedBy,
        action: "profile.approve",
        subjectType: "project_profile",
        subjectId: profileId,
      })
      .run();
  });
}

/** Taslağı reddeder. Kayıt silinmez; "neden reddedildi" denetim izinde kalır. */
export function rejectProfile(db: Db, profileId: string, comment = "", actor = "human"): void {
  db.transaction((tx) => {
    const rows = tx
      .select({ status: schema.projectProfiles.status })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, profileId))
      .all();

    const row = rows[0];
    if (!row) throw new Error(`profil bulunamadı: ${profileId}`);
    if (row.status !== "draft") throw new ProfileStateError(profileId, row.status, "taslak");

    tx.update(schema.projectProfiles)
      .set({ status: "rejected" })
      .where(eq(schema.projectProfiles.id, profileId))
      .run();

    tx.insert(schema.auditLog)
      .values({
        id: newId(),
        actor,
        action: "profile.reject",
        subjectType: "project_profile",
        subjectId: profileId,
        detail: { comment } as never,
      })
      .run();
  });
}

/**
 * Yürürlükteki profil hâlâ workspace'e uyuyor mu?
 *
 * Onaylı profilin analizindeki imza yeniden taranan imzayla karşılaştırılır.
 * Bayat profil işi DURDURMAZ, UI uyarır; kararı insan verir. Elle yazılmış
 * profilin (analizsiz) imzası yoktur — bayatlık bilinemez, `null` döner.
 */
export function profileDrift(
  db: Db,
  projectId: string,
): { stale: boolean; changed: string[]; added: string[]; removed: string[] } | null {
  const rows = db
    .select({
      analysisId: schema.projectProfiles.analysisId,
      workspaceRoot: schema.projects.workspaceRoot,
    })
    .from(schema.projects)
    .innerJoin(
      schema.projectProfiles,
      eq(schema.projects.activeProfileId, schema.projectProfiles.id),
    )
    .where(eq(schema.projects.id, projectId))
    .all();

  const active = rows[0];
  if (!active?.analysisId) return null;

  const analyses = db
    .select({ fingerprint: schema.workspaceAnalyses.fingerprint })
    .from(schema.workspaceAnalyses)
    .where(eq(schema.workspaceAnalyses.id, active.analysisId))
    .all();
  const before = analyses[0]?.fingerprint as Record<string, string> | null | undefined;
  if (!before) return null;

  try {
    const after = scanWorkspace(active.workspaceRoot).fingerprint;
    return fingerprintDrift(before, after);
  } catch (err) {
    // Workspace taşınmış/silinmişse bayatlık BİLİNEMEZ; bu bir sunucu hatası
    // değil. Önceden existsSync yetmez: kontrol ile tarama arasında silinebilir.
    if (!existsSync(active.workspaceRoot)) return null;
    throw err;
  }
}

/** Projenin yürürlükteki profilini döndürür; onaylı profil yoksa null. */
export function activeProfile(db: Db, projectId: string): ProjectProfile | null {
  const rows = db
    .select({ document: schema.projectProfiles.document })
    .from(schema.projects)
    .innerJoin(
      schema.projectProfiles,
      eq(schema.projects.activeProfileId, schema.projectProfiles.id),
    )
    .where(eq(schema.projects.id, projectId))
    .all();

  const doc = rows[0]?.document;
  if (!doc) return null;
  const parsed = ProjectProfileSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}
