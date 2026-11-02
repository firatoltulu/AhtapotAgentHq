import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";

import {
  AnalyzeBodySchema,
  CreateProfileBodySchema,
  CreateProjectBodySchema,
  DeleteProjectBodySchema,
  ImageBuildStatusSchema,
  parseGitRemote,
  ProfileDecisionBodySchema,
  ProjectProfileSchema,
  scrubSecrets,
  upgradeLegacyProfile,
  type ProjectProfile,
} from "@ahtapot/shared";

import { summarize } from "../analyst/validate.js";
import { computeReadStats } from "../agents/readStats.js";

import { newId, schema } from "../db/index.js";
import {
  activeProfile,
  approveProfile,
  profileDrift,
  rejectProfile,
  saveProfileDraft,
} from "../analyst/analyst.js";
import { buildProfileImage, dockerfileAbsPath, openImageBuild } from "../analyst/imageBuild.js";
import { execGit } from "../build/executor.js";
import { syncSource } from "../workspace/sourceSync.js";
import { cloneWorkspace, isRepo, repoFolderName } from "../workspace/clone.js";
import { repoSlugFromRemote } from "../git/github.js";
import { issueTemplateStatus, proposeIssueTemplates } from "../tracker/issueTemplates.js";
import { ApiError, notFound, parse } from "./errors.js";
import type { ApiDeps } from "./index.js";

type IdParams = { Params: { id: string } };

/**
 * Proje, analiz ve profil rotaları — Aşama 0'ın REST yüzü.
 *
 * Akış: proje bağla → analiz başlat (202, arka planda) → taslağı incele →
 * onayla/reddet. Onay kapısı burada da kodla korunur: taslak profil hiçbir
 * yerde "aktif" sayılmaz.
 */

/**
 * Gönderilen belgede olup şemadan geçtikten sonra KAYBOLAN alanlar.
 *
 * Tek seviye derine bakar (`exec.scratchDirs` gibi): tam ağaç karşılaştırması
 * `default()` uygulanan alanları da "değişti" sayardı ve gürültü üretirdi.
 */
function droppedKeys(sent: Record<string, unknown>, parsed: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sent)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in parsed)) { out.push(path); continue; }
    const pv = parsed[k];
    if (v && pv && typeof v === "object" && typeof pv === "object" && !Array.isArray(v) && !Array.isArray(pv)) {
      out.push(...droppedKeys(v as Record<string, unknown>, pv as Record<string, unknown>, path));
    }
  }
  return out;
}

export function registerProjectRoutes(fastify: FastifyInstance, deps: ApiDeps): void {
  const { db, analyst } = deps;

  /**
   * Süren analizler — proje başına EN FAZLA BİR. İki analiz aynı anda iki taslak
   * üretir ve insan hangisini onaylayacağını bilemez; ayrıca ikisi de para yakar.
   * Süreç içi tutulur: analiz zaten süreç içi bir promise'tir, süreç ölürse
   * ikisi birlikte ölür ve açılışta `reconcileInterruptedAnalyses` satırı kapatır.
   */
  const running = new Map<string, string>();

  /**
   * Süren klonlar — `running`den AYRI: analiz ve klon bağımsız kaynaklar,
   * aynı projede ikisi teorik olarak çakışmaz ama karıştırılmamalı.
   */
  const cloning = new Set<string>();

  /**
   * Süren imaj build'leri (profileId → buildId). `running`/`cloning` ile aynı
   * kalıp: aynı profil için ikinci bir build boşuna CPU yakar ve iki satır
   * aynı etiketi yazmaya çalışır.
   */
  const buildingImages = new Map<string, string>();

  /**
   * Silinmekte olan projeler. Silme işleri tek tek `await` ile yıkarken
   * analiz/klon/imaj build'i başlatılabiliyordu; bunlar silinen satırlara
   * yazar ya da proje gittikten sonra yetim dosya bırakır.
   */
  const deleting = new Set<string>();
  function assertNotDeleting(projectId: string): void {
    if (deleting.has(projectId)) throw new ApiError(409, "proje siliniyor");
  }

  function getProject(id: string) {
    const rows = db.select().from(schema.projects).where(eq(schema.projects.id, id)).all();
    const p = rows[0];
    if (!p) throw notFound("proje", id);
    return p;
  }

  /**
   * Workspace dizinini sunucu mu klonladı? Silmeye izin veren TEK koşul bu:
   * `sourceGitUrl` dolu VE yol `workspacesRoot`un altında. İkisinden biri
   * eksikse dizin dışarıdan bağlanmıştır (insanın çalışma kopyası).
   */
  function ownsWorkspaceDir(project: typeof schema.projects.$inferSelect): boolean {
    if (!project.sourceGitUrl || !deps.workspacesRoot) return false;
    const base = resolve(deps.workspacesRoot);
    const rel = relative(base, resolve(project.workspaceRoot));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  /**
   * Projenin GitHub repo'sunu çözer: önce `sourceGitUrl` (klonla kurulmuşsa),
   * yoksa workspace'in `origin` remote'u. İkisi de yoksa/GitHub değilse null —
   * issue ekranı bu durumda "repo bulunamadı" gösterir, hata fırlatmaz.
   */
  async function resolveGithubRepo(project: typeof schema.projects.$inferSelect): Promise<string | null> {
    if (project.sourceGitUrl) {
      const slug = repoSlugFromRemote(project.sourceGitUrl);
      if (slug) return slug;
    }
    if (!existsSync(project.workspaceRoot)) return null;
    const remote = await execGit(deps.hostExec, project.workspaceRoot, ["remote", "get-url", "origin"], { allowFailure: true });
    return repoSlugFromRemote(remote.trim());
  }

  /**
   * Bağlanan workspace'in reposuna issue şablonlarını önerir (bkz.
   * `tracker/issueTemplates.ts`). Arka planda koşar ve FIRLATMAZ: `gh` yoksa,
   * repo GitHub değilse ya da yetki yetmiyorsa bağlanma yine başarılıdır —
   * şablon bir iyileştirme, bağlantının ön koşulu değil. Sonuç denetim izine
   * yazılır; proje sayfası durumu ayrıca canlı okur.
   */
  function autoProposeIssueTemplates(projectId: string): void {
    void (async () => {
      const project = getProject(projectId);
      const repo = await resolveGithubRepo(project);
      if (!repo) return;
      const result = await proposeIssueTemplates(deps.github, repo);
      if (result.state !== "opened") return;
      db.insert(schema.auditLog)
        .values({
          id: newId(), actor: "system", action: "project.issue_templates",
          subjectType: "project", subjectId: projectId,
          detail: { repo, url: result.url, paths: result.paths } as never,
        })
        .run();
      fastify.log.info({ projectId, repo, url: result.url }, "issue şablonları için PR açıldı");
    })().catch((err: unknown) => {
      fastify.log.warn({ projectId, err: scrubSecrets(err instanceof Error ? err.message : String(err)) }, "issue şablonları önerilemedi");
    });
  }

  /**
   * Klonu arka planda başlatır: `workspaceStatus` HEMEN "pending" yazılır
   * (önce niyet, kural 2), sonuç geldiğinde "ready"/"failed" ile kapanır.
   */
  function startClone(projectId: string, gitUrl: string, root: string): void {
    cloning.add(projectId);
    cloneWorkspace(deps.hostExec, gitUrl, root, {
      // İki kanal: sunucu log'u (`docker logs`) anlık takip için, DB'deki
      // `workspaceError` (son satırlar) sonradan UI'da okumak için. Klon
      // dakikalar sürüyor; hata anında ikisinden birine bakılabilmeli.
      // scrubSecrets: token'lı bir remote URL'si log'a düşebilir (kural 4).
      onLine: (stream, line) => fastify.log.info({ projectId, root, stream }, `clone: ${scrubSecrets(line)}`),
    })
      .then(() => {
        db.update(schema.projects)
          .set({ workspaceStatus: "ready", workspaceError: null })
          .where(eq(schema.projects.id, projectId))
          .run();
        autoProposeIssueTemplates(projectId);
      })
      .catch((err: unknown) => {
        const msg = scrubSecrets(err instanceof Error ? err.message : String(err));
        db.update(schema.projects)
          .set({ workspaceStatus: "failed", workspaceError: msg })
          .where(eq(schema.projects.id, projectId))
          .run();
      })
      .finally(() => cloning.delete(projectId));
  }

  /**
   * İmaj build'ini arka planda başlatır ve kimliğini HEMEN döndürür.
   *
   * `/analyze` ile aynı fire-and-forget deseni: satır senkron açılır (kural 2,
   * önce niyet), `docker build` dakikalar sürer, istemci polling ile izler.
   * `buildProfileImage` fırlatmaz — hata `profile_image_builds.error`a yazılır.
   */
  function startImageBuild(
    docker: NonNullable<ApiDeps["docker"]>,
    input: { profileId: string; workspaceRoot: string; dockerfilePath: string; imageRef: string },
  ): string {
    const buildId = openImageBuild(db, { profileId: input.profileId, imageRef: input.imageRef });
    buildingImages.set(input.profileId, buildId);
    // Taban önce: eski taban üstüne build edilen imaj, etiketi uyuşmayacağı
    // için ilk işte yeniden build edilirdi. Taban hazırlanamazsa hata build'e
    // geçer: taban varsa build yine denenir, yoksa bu hatayla düşer (bkz.
    // `ImageBuildInput.baseError`).
    (deps.agentImages?.ensureBase() ?? Promise.resolve(""))
      .then(
        () => undefined,
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          fastify.log.warn({ err: message }, "agent tabanı hazırlanamadı");
          return message;
        },
      )
      .then((baseError) =>
        buildProfileImage(
          { docker, db, artifactsDir: deps.artifactsDir },
          { ...input, buildId, ...(baseError !== undefined ? { baseError } : {}) },
        ),
      )
      .catch((err: unknown) => fastify.log.error(err, "imaj build'i beklenmedik biçimde düştü"))
      // SİLMEDEN ÖNCE "hâlâ benim kaydım mı" diye bakılır: koşulsuz
      // `delete(profileId)` hızlı düşen bir build'in, ardından başlatılmış
      // İKİNCİ bir build'in kaydını silmesine yol açardı — o zaman aynı imaj
      // etiketine iki `docker build` yarışırdı, yani bu map'in önlemek için
      // var olduğu durum.
      .finally(() => {
        if (buildingImages.get(input.profileId) === buildId) buildingImages.delete(input.profileId);
      });
    return buildId;
  }

  /**
   * Profilin imajı için build başlatılabilir mi? Üç hâl ayrılır çünkü üçü de
   * farklı bir kullanıcı deneyimi gerektirir (bkz. `/decision`).
   */
  async function imageBuildPlan(profile: ProjectProfile, project: typeof schema.projects.$inferSelect): Promise<
    | { kind: "exists" }
    | { kind: "buildable"; dockerfilePath: string; imageRef: string; workspaceRoot: string }
    | { kind: "blocked"; reason: string }
  > {
    // Docker yoksa imajın varlığı BİLİNEMEZ. Bilinmeyeni engel SAYMIYORUZ:
    // Docker'sız bir kurulumda hiçbir profil onaylanamaz hâle gelirdi. Onay
    // geçer, build atlanır; iş başlatma yolundaki imaj kontrolü zaten duruyor.
    const docker = deps.docker;
    if (!docker) return { kind: "exists" };

    try {
      await docker.getImage(profile.exec.image).inspect();
      // VAR OLAN İMAJ YENİDEN BUILD EDİLMEZ: onay düğmesine basan insan
      // dakikalarca süren sürpriz bir build beklemiyor.
      return { kind: "exists" };
    } catch (err) {
      // YALNIZ 404 "imaj yok" demektir. Daemon kapalı, soket izni yok ya da
      // kimlik hatası gibi durumlarda imajın varlığı BİLİNMİYOR demektir —
      // bunu "yok" sayıp sert 409'a düşmek, Docker'ı geçici erişilemez olan
      // kullanıcının profilini onaylayamaz hâle getirirdi (kural: bilinmeyen
      // engel değildir).
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== 404) return { kind: "exists" };
    }

    if (!profile.exec.dockerfile) {
      return {
        kind: "blocked",
        reason:
          `imaj yerelde yok (${profile.exec.image}) ve profilde \`exec.dockerfile\` tanımlı değil — ` +
          "yeniden analiz edin (Analyst Dockerfile üretir) ya da imajı elle build edin",
      };
    }

    // Dockerfile artık PROJE workspace'inde DEĞİL, sunucunun kendi artifact
    // deposunda yaşıyor (bkz. `dockerfileAbsPath`, `ExecSchema.dockerfile`) —
    // `project.workspaceRoot`'a göre çözmek, motorun ürettiği dosyayı yabancı
    // repoya karıştırdığı eski (hatalı) davranışa geri dönerdi.
    const dockerfileAbs = dockerfileAbsPath(deps.artifactsDir, project.id);
    if (!existsSync(dockerfileAbs)) {
      return {
        kind: "blocked",
        reason: `profildeki Dockerfile diskte yok: ${profile.exec.dockerfile}`,
      };
    }

    return {
      kind: "buildable",
      dockerfilePath: profile.exec.dockerfile,
      // Alan adı `workspaceRoot` kalır (build bağlamı kökü anlamında), ama
      // artık proje workspace'i DEĞİL — bkz. `ImageBuildInput.workspaceRoot`
      // doc-comment'i (imageBuild.ts).
      imageRef: profile.exec.image,
      workspaceRoot: dirname(dockerfileAbs),
    };
  }

  /**
   * Anasayfa'nın "Projeler" kartı özet ister: profil sürümü, bekleyen/koşan iş
   * sayısı, toplam maliyet. Proje başına ayrı sorgu YERİNE tüm işler tek
   * seferde çekilip JS'te gruplanır — kart sayısı kadar round-trip açmamak için.
   */
  fastify.get("/api/projects", async () => {
    const rows = db
      .select()
      .from(schema.projects)
      .orderBy(desc(schema.projects.createdAt))
      .all();

    const versions = new Map(
      db
        .select({ id: schema.projectProfiles.id, version: schema.projectProfiles.version })
        .from(schema.projectProfiles)
        .all()
        .map((p) => [p.id, p.version] as const),
    );

    const allJobs = db
      .select({
        projectId: schema.jobs.projectId,
        state: schema.jobs.state,
        phase: schema.jobs.phase,
        costMicroUsd: schema.jobs.costMicroUsd,
      })
      .from(schema.jobs)
      .all();

    const stats = new Map<string, { waiting: number; running: number; costMicroUsd: number }>();
    for (const j of allJobs) {
      const s = stats.get(j.projectId) ?? { waiting: 0, running: 0, costMicroUsd: 0 };
      const gate = j.state === "PlanReview" || j.state === "LiveTest" || j.state === "QACases" || j.state === "PRReview";
      if (j.state === "NeedsAttention" || gate) s.waiting += 1;
      else if (j.phase === "starting" || j.phase === "running") s.running += 1;
      s.costMicroUsd += j.costMicroUsd;
      stats.set(j.projectId, s);
    }

    return rows.map((p) => ({
      ...p,
      runningAnalysisId: running.get(p.id) ?? null,
      activeProfileVersion: p.activeProfileId ? versions.get(p.activeProfileId) ?? null : null,
      jobStats: stats.get(p.id) ?? { waiting: 0, running: 0, costMicroUsd: 0 },
    }));
  });

  /**
   * "Workspace bağla" popup'ının yazarken canlı doğrulaması: yol var mı, git
   * deposu mu, remote'u ne. Salt okunur — hiçbir şey yazmaz, dizine dokunmaz.
   */
  fastify.get<{ Querystring: { path?: string } }>("/api/workspace-probe", async (req) => {
    const raw = req.query.path;
    if (!raw) return { exists: false, isRepo: false, remoteUrl: null };
    const root = resolve(raw);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { exists: false, isRepo: false, remoteUrl: null };
    }
    const repo = await isRepo(deps.hostExec, root);
    if (!repo) return { exists: true, isRepo: false, remoteUrl: null };
    const remoteUrl = (await execGit(deps.hostExec, root, ["remote", "get-url", "origin"], { allowFailure: true })).trim();
    return { exists: true, isRepo: true, remoteUrl: remoteUrl || null };
  });

  /**
   * Emsal yolu tamamlama: YALNIZ `workspacesRoot`un doğrudan alt dizinleri —
   * başka hiçbir dizin, alt dizinlerin içi de listelenmez; uç host dosya
   * sistemini gezdirmesin. Kök host'la AYNI yola bağlı (compose), yani dönen
   * yol agent konteynerine bağlanabilen gerçek host yoludur. Salt okunur.
   *
   * `q` yalnız süzgeçtir, hiçbir zaman okunacak dizini seçmez: son segmenti
   * ad içinde aranır ("E:\...\Bal" ya da "bal" aynı sonucu verir).
   */
  fastify.get<{ Querystring: { q?: string } }>("/api/reference-dirs", async (req) => {
    if (!deps.workspacesRoot) return { root: null, dirs: [] };
    const base = resolve(deps.workspacesRoot);
    const needle = ((req.query.q ?? "").trim().replace(/^"(.*)"$/, "$1").split(/[\\/]/).pop() ?? "").toLowerCase();

    let names: string[];
    try {
      const entries = await readdir(base, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    } catch {
      names = [];
    }
    const dirs = names
      .filter((n) => n.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b, "tr"))
      .map((n) => join(base, n));
    return { root: base, dirs: dirs.slice(0, 50) };
  });

  fastify.post("/api/projects", async (req, reply) => {
    const body = parse(CreateProjectBodySchema, req.body);
    // Klon adresi aynı zamanda PR'ın remote'u olur (`primaryRemote`): bozuk
    // ya da token taşıyan bir URL burada durmalı — klon bittikten sonra değil.
    if (body.gitUrl) {
      const r = parseGitRemote(body.gitUrl);
      if (!r.ok) throw new ApiError(400, `gitUrl geçersiz: ${r.reason}`);
    }

    let root: string;
    if (body.workspaceRoot) {
      root = resolve(body.workspaceRoot);
    } else if (body.gitUrl && deps.workspacesRoot) {
      // Repo adı slug'dan DEĞİL gitUrl'den türetiliyor: kullanıcı GitHub
      // listesinden seçtiğinde slug'ı henüz elle değiştirmemiş olabilir,
      // repo adı daha güvenilir kaynak (bkz. Projects.tsx selectRepo).
      const workspacesRoot = resolve(deps.workspacesRoot);
      root = resolve(join(workspacesRoot, repoFolderName(body.gitUrl)));
      // Savunma derinliği: `repoFolderName` zaten tek güvenli segment üretiyor
      // (kural 3 — üretici taraf güvenilmez, sınır burada da tekrar zorlanır).
      // `relative()` ".."le başlıyorsa ya da mutlak dönüyorsa hedef kökün dışında.
      const rel = relative(workspacesRoot, root);
      if (rel === "" || rel.startsWith("..") || resolve(workspacesRoot, rel) !== root) {
        throw new ApiError(400, "gitUrl'den türetilen hedef workspace kökünün dışına çıkıyor");
      }
    } else {
      throw new ApiError(
        400,
        body.gitUrl
          ? "workspaceRoot verilmedi ve sunucuda AHTAPOT_WORKSPACES_ROOT tanımlı değil"
          : "workspaceRoot verilmeli (gitUrl'süz oluşturmada zorunlu)",
      );
    }
    const exists = existsSync(root);

    // gitUrl'süz eski davranış: workspace GERÇEK olmalı, yoksa 400.
    if (!body.gitUrl) {
      if (!exists || !statSync(root).isDirectory()) {
        throw new ApiError(400, `workspace dizini bulunamadı: ${root}`);
      }
    } else if (exists) {
      if (!statSync(root).isDirectory()) {
        throw new ApiError(400, `hedef bir dizin değil: ${root}`);
      }
      // VAR ama BOŞ olan dizin engel değil: kullanıcı yolu önceden açmış ya da
      // düşen bir klondan kalmış olabilir — ikisinde de `git clone` sorunsuz
      // çalışır ve kaybedilecek bir şey yoktur. Eskiden 400 dönüyordu ve
      // kullanıcı sunucuya girip elle silmek zorunda kalıyordu (yaşandı).
      // DOLU dizinde hâlâ duruyoruz: yıkıcı silme insan onayı ister.
      if (readdirSync(root).length > 0) {
        throw new ApiError(
          400,
          `hedef dizin boş değil, gitUrl'süz oluşturun ya da boş bir yol verin: ${root}`,
        );
      }
    }

    const dup = db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.slug, body.slug))
      .all();
    if (dup.length > 0) throw new ApiError(409, `slug zaten kullanımda: ${body.slug}`);

    const id = newId();
    db.insert(schema.projects)
      .values({
        id,
        slug: body.slug,
        name: body.name,
        workspaceRoot: root,
        ...(body.gitUrl ? { sourceGitUrl: body.gitUrl, workspaceStatus: "pending" as const } : {}),
      })
      .run();

    db.insert(schema.auditLog)
      .values({
        id: newId(),
        actor: "human",
        action: "project.create",
        subjectType: "project",
        subjectId: id,
        detail: { slug: body.slug, workspaceRoot: root, gitUrl: body.gitUrl ?? null } as never,
      })
      .run();

    if (body.gitUrl) {
      startClone(id, body.gitUrl, root);
      return reply.code(202).send(getProject(id));
    }
    autoProposeIssueTemplates(id);
    return reply.code(201).send(getProject(id));
  });

  /**
   * Klon başarısız olan projeyi yeniden dener. Proje kaydı silinmez — audit
   * izi (kim, ne zaman, hangi URL) korunur; yalnız `retry` bu durumdan çıkarır.
   */
  fastify.post<IdParams>("/api/projects/:id/retry-clone", async (req, reply) => {
    const project = getProject(req.params.id);
    assertNotDeleting(project.id);
    if (project.workspaceStatus !== "failed") {
      throw new ApiError(409, `proje "failed" durumunda değil: ${project.workspaceStatus}`);
    }
    if (!project.sourceGitUrl) {
      throw new ApiError(400, "projenin kayıtlı bir gitUrl'i yok");
    }
    if (cloning.has(project.id)) {
      throw new ApiError(409, "bu proje için klon zaten sürüyor");
    }

    // BURADA SİLME YOK. Eskiden "repo değilse" `workspaceRoot` özyinelemeli
    // siliniyordu; ama "geçerli repo değil" ile "bu dizini biz yarattık" aynı
    // şey değil — kullanıcının bağladığı (boş) dizin de bu koşulu geçerdi.
    // `cloneWorkspace` artık geçici dizine klonlayıp yalnız başarıda yerine
    // taşıyor, yani düşen bir klon hedefte zaten kalıntı bırakmıyor.
    // Hedef dolu ve repo değilse klon kendi hatasını üretir (taşıma düşer).
    db.update(schema.projects)
      .set({ workspaceStatus: "pending", workspaceError: null })
      .where(eq(schema.projects.id, project.id))
      .run();

    startClone(project.id, project.sourceGitUrl, project.workspaceRoot);
    return reply.code(202).send(getProject(project.id));
  });

  /**
   * Projeyi (workspace'i) SİLER: işleri, profilleri, analizleri, imaj build
   * kayıtlarını ve artifact dosyalarını. İşler `engine.purge` ile tek tek
   * kaldırılır — iptalle aynı yol, konteyner/volume/kira yetim kalmaz.
   *
   * `Done` işler de silinir: iş iptalinde bitmiş iş korunuyor ama proje
   * gidince o işin bakacağı profil de gidiyor, geride tutarsız bir satır kalırdı.
   *
   * Diskteki dizin VARSAYILAN olarak kalır. Yalnız `removeFiles` istenmişse ve
   * dizini sunucu kendisi klonlamışsa (`ownsWorkspaceDir`) silinir; dışarıdan
   * bağlanan repo insanın kendi çalışma kopyasıdır, motorun silme yetkisi yok.
   */
  fastify.delete<IdParams>("/api/projects/:id", async (req) => {
    const project = getProject(req.params.id);
    const body = parse(DeleteProjectBodySchema, req.body ?? {});
    assertNotDeleting(project.id);

    // Arka planda süren bir iş silinen satırlara yazmaya çalışır (analiz taslak
    // ekler, klon `workspaceStatus` günceller, build satırını kapatır).
    if (running.has(project.id)) throw new ApiError(409, "analiz sürüyor; bitince silin");
    if (cloning.has(project.id)) throw new ApiError(409, "klon sürüyor; bitince silin");

    const profileIds = db
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.projectId, project.id))
      .all()
      .map((p) => p.id);
    const busyBuild = profileIds.find((pid) => buildingImages.has(pid));
    if (busyBuild) throw new ApiError(409, "profil imajı build ediliyor; bitince silin");

    if (body.removeFiles && !ownsWorkspaceDir(project)) {
      throw new ApiError(400, "bu dizin sunucu tarafından klonlanmadı; dosyalar silinemez");
    }

    // İlk `await`ten ÖNCE, senkron: aradaki başlatmalar bu işareti görür.
    deleting.add(project.id);
    try {
      const jobIds = db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(eq(schema.jobs.projectId, project.id))
        .all()
        .map((j) => j.id);
      for (const jobId of jobIds) {
        await deps.engine.stopRun(jobId, "proje silindi");
        await deps.engine.purge(jobId);
        deps.hub.emit({ type: "job.deleted", jobId, seq: 0, at: new Date().toISOString(), reason: "proje silindi" });
      }

      const analysisIds = db
        .select({ id: schema.workspaceAnalyses.id })
        .from(schema.workspaceAnalyses)
        .where(eq(schema.workspaceAnalyses.projectId, project.id))
        .all()
        .map((a) => a.id);
      const imageBuildIds = profileIds.length === 0 ? [] : db
        .select({ id: schema.profileImageBuilds.id })
        .from(schema.profileImageBuilds)
        .where(inArray(schema.profileImageBuilds.profileId, profileIds))
        .all()
        .map((b) => b.id);

      const incomplete: string[] = [];
      // Dosyalar DB'den ÖNCE (purge ile aynı gerekçe): silme düşerse satır kalır
      // ve yeniden denenebilir; tersi yetim dosyayı keşfedilemez yapardı.
      await rm(join(deps.artifactsDir, project.id), { recursive: true, force: true })
        .catch(() => { incomplete.push("artifacts"); });
      for (const bid of imageBuildIds) {
        await rm(join(deps.artifactsDir, "image-builds", `${bid}.log`), { force: true })
          .catch(() => { incomplete.push(`image-build-log:${bid}`); });
      }
      if (body.removeFiles) {
        await rm(project.workspaceRoot, { recursive: true, force: true })
          .catch(() => { incomplete.push("workspace"); });
      }

      db.transaction((tx) => {
        const subjects = [project.id, ...profileIds, ...analysisIds];
        tx.delete(schema.auditLog).where(inArray(schema.auditLog.subjectId, subjects)).run();
        tx.delete(schema.approvals).where(eq(schema.approvals.projectId, project.id)).run();
        if (profileIds.length > 0) {
          tx.delete(schema.profileImageBuilds).where(inArray(schema.profileImageBuilds.profileId, profileIds)).run();
        }
        tx.delete(schema.projectProfiles).where(eq(schema.projectProfiles.projectId, project.id)).run();
        tx.delete(schema.workspaceAnalyses).where(eq(schema.workspaceAnalyses.projectId, project.id)).run();
        tx.delete(schema.projectReleases).where(eq(schema.projectReleases.projectId, project.id)).run();
        tx.delete(schema.projects).where(eq(schema.projects.id, project.id)).run();
        // Proje satırı artık yok: iz `detail`de, `subjectId` yetim doğmasın
        // (`job.purge_incomplete` kalıbı).
        tx.insert(schema.auditLog).values({
          id: newId(),
          actor: "human",
          action: "project.delete",
          detail: {
            projectId: project.id,
            slug: project.slug,
            workspaceRoot: project.workspaceRoot,
            jobs: jobIds.length,
            removeFiles: body.removeFiles,
            incomplete,
          } as never,
        }).run();
      });

      return { id: project.id, deleted: true, jobs: jobIds.length, removedFiles: body.removeFiles && !incomplete.includes("workspace"), incomplete };
    } finally {
      deleting.delete(project.id);
    }
  });

  fastify.get<IdParams>("/api/projects/:id", async (req) => {
    const project = getProject(req.params.id);

    const active = project.activeProfileId
      ? db
          .select({
            id: schema.projectProfiles.id,
            version: schema.projectProfiles.version,
            approvedAt: schema.projectProfiles.approvedAt,
            approvedBy: schema.projectProfiles.approvedBy,
          })
          .from(schema.projectProfiles)
          .where(eq(schema.projectProfiles.id, project.activeProfileId))
          .all()[0] ?? null
      : null;

    const latestAnalysis =
      db
        .select({
          id: schema.workspaceAnalyses.id,
          status: schema.workspaceAnalyses.status,
          error: schema.workspaceAnalyses.error,
          note: schema.workspaceAnalyses.note,
          createdAt: schema.workspaceAnalyses.createdAt,
        })
        .from(schema.workspaceAnalyses)
        .where(eq(schema.workspaceAnalyses.projectId, project.id))
        .orderBy(desc(schema.workspaceAnalyses.createdAt))
        .limit(1)
        .all()[0] ?? null;

    return {
      ...project,
      activeProfile: active,
      latestAnalysis,
      runningAnalysisId: running.get(project.id) ?? null,
      canRemoveFiles: ownsWorkspaceDir(project),
    };
  });

  /**
   * Bayatlık ayrı uçta: workspace'i yeniden tarar (git çağrıları, dizin
   * dolaşımı). Detay ucunu ucuz tutmak için her açılışta değil, UI istediğinde.
   */
  fastify.get<IdParams>("/api/projects/:id/drift", async (req) => {
    const project = getProject(req.params.id);
    const drift = profileDrift(db, project.id);
    // Onaylı profil yoksa ya da elle yazılmışsa (imzasız) bayatlık BİLİNEMEZ.
    if (!drift) return { known: false, stale: false, changed: [], added: [], removed: [] };
    return { known: true, ...drift };
  });

  // ── Analiz ───────────────────────────────────────────────────────────────

  fastify.post<IdParams>("/api/projects/:id/analyze", async (req, reply) => {
    const project = getProject(req.params.id);
    const body = parse(AnalyzeBodySchema, req.body);
    assertNotDeleting(project.id);

    if (running.has(project.id)) {
      throw new ApiError(409, `bu proje için analiz zaten sürüyor: ${running.get(project.id)}`);
    }
    // ÖNCE DURUMA BAK, SONRA DİSKE. Klon `<dest>.ahtapot-clone-*` geçici
    // dizininde sürer ve yalnız BİTİNCE yerine taşınır (clone.ts) — yani
    // `pending` boyunca `workspaceRoot` gerçekten YOKTUR. Yalnız `existsSync`e
    // bakmak bu ara durumu "dizin artık yok" diye raporluyordu: UI projeyi
    // kurar kurmaz analizi zincirlediği için hata her klonlu bağlamada
    // düşüyordu ve kullanıcı sonradan baktığında dizini yerinde buluyordu
    // (yaşandı, 2026-09-22). Durum bilindiğinde onu söylemek gerekir.
    if (project.workspaceStatus === "pending") {
      throw new ApiError(409, "workspace klonu sürüyor; klon bitince analizi başlatın");
    }
    if (project.workspaceStatus === "failed") {
      throw new ApiError(
        400,
        `workspace klonu başarısız; önce yeniden deneyin: ${project.workspaceError ?? "sebep kaydedilmemiş"}`,
      );
    }
    if (!existsSync(project.workspaceRoot)) {
      throw new ApiError(400, `workspace dizini artık yok: ${project.workspaceRoot}`);
    }

    const analysisId = newId();
    running.set(project.id, analysisId);

    // Analiz dakikalar sürer; istek beklemez. Kimlik önceden üretildi, satır
    // `analyze()` döner dönmez DB'de — istemci hemen sorgulayabilir.
    const pending = analyst.analyze({
      projectId: project.id,
      slug: project.slug,
      name: project.name,
      workspaceRoot: project.workspaceRoot,
      analysisId,
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
      ...(body.maxBudgetUsd !== undefined ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
    });
    pending
      .then((res) => {
        if (res.error) req.log.warn({ analysisId, error: res.error }, "analiz başarısız");
        else req.log.info({ analysisId, profileId: res.profileId }, "analiz tamam, taslak hazır");
      })
      .catch((err: unknown) => req.log.error(err, "analiz beklenmedik biçimde düştü"))
      .finally(() => running.delete(project.id));

    return reply.code(202).send({ analysisId, status: "running" });
  });

  /**
   * Bir rolün son işlerde okuduğu dosyalar — tekrar eden okumanın ölçümü
   * (bkz. `agents/readStats.ts`). Salt okunur.
   */
  fastify.get<IdParams & { Querystring: { role?: string; jobs?: string; top?: string } }>(
    "/api/projects/:id/agent-reads",
    async (req) => {
      const project = getProject(req.params.id);
      const bounded = (v: string | undefined, def: number, max: number) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
      };
      return computeReadStats(db, project.id, {
        role: req.query.role ?? "planner",
        jobs: bounded(req.query.jobs, 20, 200),
        top: bounded(req.query.top, 40, 500),
      });
    },
  );

  /** Kod haritasının durumu (karar §35). Salt okunur. */
  fastify.get<IdParams>("/api/projects/:id/codemap", async (req) => {
    const project = getProject(req.params.id);
    if (!deps.codeMap) throw new ApiError(404, "kod haritası bu sunucuda kapalı");
    return deps.codeMap.status(project.id, activeProfile(db, project.id));
  });

  /**
   * Künyelerin kendisi — insan, agent'ın `/codemap`te gördüğünü görsün.
   * Harita LLM çıktısı: REST'e çıkmadan `scrubSecrets`ten geçer (kural 4).
   */
  fastify.get<IdParams>("/api/projects/:id/codemap/map", async (req) => {
    const project = getProject(req.params.id);
    if (!deps.codeMap) throw new ApiError(404, "kod haritası bu sunucuda kapalı");
    const map = deps.codeMap.map(project.id);
    return { map: map ? (JSON.parse(scrubSecrets(JSON.stringify(map))) as typeof map) : null };
  });

  /**
   * Tam üretimi başlatır (202). Onaylı profil şart (kural 8) ve profilde
   * `agents.codeMap.enabled` açık olmalı — motor yetenek sunar, profil açar.
   */
  fastify.post<IdParams>("/api/projects/:id/codemap", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!deps.codeMap) throw new ApiError(404, "kod haritası bu sunucuda kapalı");
    const profile = activeProfile(db, project.id);
    if (!profile) throw new ApiError(409, "onaylı profil yok");
    if (!profile.agents.codeMap.enabled) throw new ApiError(409, "profilde agents.codeMap.enabled kapalı");
    const started = deps.codeMap.generate(project.id, profile);
    return reply.code(202).send({ started, status: deps.codeMap.status(project.id, profile) });
  });

  /**
   * Kaynak workspace'i uzaktaki varsayılan dala elle ilerletir — iş açılışında
   * ve saatlik zamanlayıcıda koşan aynı senkron (`sourceSync.ts`). Yetki
   * sorunları (ör. başka kullanıcıya ait `FETCH_HEAD`) orada kendiliğinden
   * onarılır; düşen repo `reason`/`dir`/`user` ile döner, UI gösterir.
   */
  fastify.post<IdParams>("/api/projects/:id/sync-source", async (req) => {
    const project = getProject(req.params.id);
    assertNotDeleting(project.id);
    if (project.workspaceStatus !== "ready") throw new ApiError(409, `workspace hazır değil: ${project.workspaceStatus}`);
    const profile = activeProfile(db, project.id);
    if (!profile) throw new ApiError(409, "onaylı profil yok");
    const results = await syncSource(deps.hostExec, profile.workspace.root, profile.workspace.repos);
    return { results: results.map((r) => (r.status === "skipped" ? { ...r, reason: scrubSecrets(r.reason) } : r)) };
  });

  fastify.get<IdParams>("/api/projects/:id/analyses", async (req) => {
    const project = getProject(req.params.id);
    return db
      .select({
        id: schema.workspaceAnalyses.id,
        status: schema.workspaceAnalyses.status,
        error: schema.workspaceAnalyses.error,
        note: schema.workspaceAnalyses.note,
        agentRunId: schema.workspaceAnalyses.agentRunId,
        createdAt: schema.workspaceAnalyses.createdAt,
        updatedAt: schema.workspaceAnalyses.updatedAt,
      })
      .from(schema.workspaceAnalyses)
      .where(eq(schema.workspaceAnalyses.projectId, project.id))
      .orderBy(desc(schema.workspaceAnalyses.createdAt))
      .all();
  });

  fastify.get<IdParams>("/api/analyses/:id", async (req) => {
    const rows = db
      .select()
      .from(schema.workspaceAnalyses)
      .where(eq(schema.workspaceAnalyses.id, req.params.id))
      .all();
    const a = rows[0];
    if (!a) throw notFound("analiz", req.params.id);

    // Bu analizden doğan taslak varsa bağla — UI "incele" düğmesini buradan çizer.
    const profile =
      db
        .select({ id: schema.projectProfiles.id, version: schema.projectProfiles.version, status: schema.projectProfiles.status })
        .from(schema.projectProfiles)
        .where(eq(schema.projectProfiles.analysisId, a.id))
        .all()[0] ?? null;

    return { ...a, profile };
  });

  // ── Profiller ────────────────────────────────────────────────────────────

  fastify.get<IdParams>("/api/projects/:id/profiles", async (req) => {
    const project = getProject(req.params.id);
    // Belge listede taşınmaz: onlarca sürüm × tam profil gereksiz yük.
    return db
      .select({
        id: schema.projectProfiles.id,
        version: schema.projectProfiles.version,
        status: schema.projectProfiles.status,
        analysisId: schema.projectProfiles.analysisId,
        approvedAt: schema.projectProfiles.approvedAt,
        approvedBy: schema.projectProfiles.approvedBy,
        createdAt: schema.projectProfiles.createdAt,
      })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.projectId, project.id))
      .orderBy(desc(schema.projectProfiles.version))
      .all();
  });

  /**
   * Elle yazılmış ya da düzenlenmiş taslak. Analyst'in ürettiğini UI'da
   * düzeltip yeniden göndermenin yolu budur: eski taslak yerinde kalır, yeni
   * sürüm doğar. Şema doğrulaması aynı — elle yazan da "üretici taraf".
   */
  fastify.post<IdParams>("/api/projects/:id/profiles", async (req, reply) => {
    const project = getProject(req.params.id);
    const body = parse(CreateProfileBodySchema, req.body);

    if (body.document.slug !== project.slug) {
      throw new ApiError(400, `profil slug'ı projeyle uyuşmuyor: ${body.document.slug} ≠ ${project.slug}`);
    }
    // Remote yazıldığı anda doğrulanır; boş bırakmak serbest (klon URL'sine
    // düşülür). Şemada değil burada: bkz. `gitRemote.ts`.
    for (const repo of body.document.workspace.repos) {
      if (repo.remote === undefined) continue;
      const r = parseGitRemote(repo.remote);
      if (!r.ok) throw new ApiError(400, `repo ${repo.name}: remote geçersiz — ${r.reason}`);
    }

    const rationale = body.note ? { _note: { why: body.note, source: "insan" } } : null;
    const id = saveProfileDraft(db, project.id, body.document, rationale, null);

    // Zod bilinmeyen alanları SESSİZCE atıyor. Yaşandı: `scratchDirs` içeren
    // taslak, alanı henüz tanımayan bir sunucuya gönderildi; alan düştü, profil
    // "geçerli" göründü ve build günlerce yanlış çalıştı. Düşenleri söyle —
    // reddetme (eski profiller kırılmasın), ama sessiz de kalma.
    const sent = (req.body as { document?: Record<string, unknown> } | undefined)?.document;
    // Eski servis biçimi (`live.dependencies`, `live.cloneDb` nesnesi) düşmüyor,
    // TAŞINIYOR: karşılaştırma çevrilmiş hâlle yapılır, yoksa yanlış alarm olur.
    const dropped = sent
      ? droppedKeys(upgradeLegacyProfile(sent) as Record<string, unknown>, body.document as unknown as Record<string, unknown>)
      : [];

    const row = db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, id)).all()[0];
    return reply.code(201).send(dropped.length > 0 ? { ...row, droppedFields: dropped } : row);
  });

  fastify.get<IdParams>("/api/profiles/:id", async (req) => {
    const rows = db
      .select()
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, req.params.id))
      .all();
    const p = rows[0];
    if (!p) throw notFound("profil", req.params.id);
    // Belge şemadan geçirilerek döner: alan eklenmeden önce kaydedilmiş
    // profilde yeni alan YOK, UI ise varsayılanı varsayıp çöküyordu
    // (YAŞANDI: `exec.registries` undefined → proje sayfası boş). Şemaya
    // uymayan belge ham döner — doğrulama ekranı neyin bozuk olduğunu göstersin.
    const parsed = ProjectProfileSchema.safeParse(p.document);
    return parsed.success ? { ...p, document: parsed.data } : p;
  });

  /**
   * Profil doğrulama — onaydan önce mekanik denetim. Sonuç kaydedilmez; her
   * çağrı yeniden ölçer (workspace değişmiş olabilir).
   */
  fastify.post<IdParams>("/api/profiles/:id/validate", async (req) => {
    const row = db.select({ document: schema.projectProfiles.document }).from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, req.params.id)).all()[0];
    if (!row) throw notFound("profil", req.params.id);
    const parsed = ProjectProfileSchema.safeParse(row.document);
    if (!parsed.success) throw new ApiError(409, "profil belgesi şemaya uymuyor; doğrulanamaz");
    const checks = await deps.validate(parsed.data);
    return { checks, ...summarize(checks) };
  });

  /**
   * KAYDEDİLMEMİŞ belgeyi doğrular — düzenleme ekranının "Doğrula"sı.
   *
   * Sürüm ucu (`/api/profiles/:id/validate`) kayıtlı belgeyi ölçer; düzenlerken
   * onu çağırmak eski hâlin sonucunu yeni hâlinmiş gibi gösterirdi. Burada
   * belge taslak olarak YAZILMAZ: her "Doğrula" yeni bir sürüm doğursaydı
   * liste denemelerle dolardı.
   *
   * Şemaya uymayan belge 409 değil, hata satırlarıyla döner: düzenleyen insan
   * hangi alanın bozuk olduğunu görmeli, "doğrulanamaz" demek yetmez.
   */
  fastify.post<IdParams>("/api/projects/:id/profiles/validate", async (req) => {
    const project = getProject(req.params.id);
    const document = (req.body as { document?: unknown } | undefined)?.document;
    const parsed = ProjectProfileSchema.safeParse(document);
    if (!parsed.success) {
      const checks = parsed.error.issues.map((i) => ({
        id: i.path.map(String).join(".") || "document",
        level: "error" as const,
        message: scrubSecrets(i.message),
      }));
      return { checks, ...summarize(checks) };
    }
    const checks = await deps.validate(parsed.data);
    // Kayıt (`POST .../profiles`) uyuşmayan slug'ı 400 ile reddediyor;
    // doğrulama aynı belgeye "temiz" demesin.
    if (parsed.data.slug !== project.slug) {
      checks.unshift({
        id: "slug",
        level: "error",
        message: `profil slug'ı projeyle uyuşmuyor: ${parsed.data.slug} ≠ ${project.slug}`,
      });
    }
    return { checks, ...summarize(checks) };
  });

  /**
   * Profil sürümünü SİLER. `Cancel`'daki gibi hard-delete, ama kapsamı daha
   * dar: burada iş zinciri YOK, çünkü profil işlerin altındaki zemin — bir
   * işin hâlâ referans verdiği profili silmek o işin geçmişini (hangi imaj,
   * hangi build komutuyla koştuğunu) ortadan kaldırır. Bu yüzden herhangi bir
   * işin (durumu ne olursa olsun — Done dahil, geçmiş iş de profile bakar)
   * bu profili taşıması engel: 409.
   *
   * Aktif profilse `projects.activeProfileId` de temizlenir — aksi hâlde proje
   * var olmayan bir profile işaret eden bir kayıt taşırdı.
   */
  fastify.delete<IdParams>("/api/profiles/:id", async (req) => {
    const rows = db
      .select({ id: schema.projectProfiles.id, projectId: schema.projectProfiles.projectId })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, req.params.id))
      .all();
    const row = rows[0];
    if (!row) throw notFound("profil", req.params.id);

    const referencing = db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.profileId, row.id))
      .all();
    if (referencing.length > 0) {
      throw new ApiError(
        409,
        `bu profili kullanan ${referencing.length} iş var; profil silinemez`,
      );
    }

    db.transaction((tx) => {
      tx.update(schema.projects)
        .set({ activeProfileId: null })
        .where(eq(schema.projects.activeProfileId, row.id))
        .run();
      tx.delete(schema.projectProfiles).where(eq(schema.projectProfiles.id, row.id)).run();
    });

    return { id: row.id, deleted: true };
  });

  /**
   * Profildeki TÜM işleri bu profile taşır — "tüm işlere uygula".
   *
   * Profil sürümlendiği için tek bir işi taşımak (`POST /api/jobs/:id/profile`)
   * yetmiyordu: bir düzeltme onaylandığında o projenin her işi tek tek elle
   * taşınmak zorundaydı ve pratikte hiç taşınmıyordu.
   *
   * KOŞAN İŞLER ATLANIR, iş tümden reddedilmez: koşan tek bir iş yüzünden
   * kırk işin taşınmaması kullanıcıya bir şey kazandırmaz. Atlananlar yanıtta
   * adıyla döner, insan onları sonra taşır.
   *
   * Zaten hedefte olan işler sayılmaz ama hata da değildir (idempotent).
   */
  fastify.post<IdParams>("/api/profiles/:id/apply-to-jobs", async (req) => {
    const target = db
      .select({
        id: schema.projectProfiles.id,
        status: schema.projectProfiles.status,
        version: schema.projectProfiles.version,
        projectId: schema.projectProfiles.projectId,
      })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, req.params.id))
      .all()[0];
    if (!target) throw notFound("profil", req.params.id);
    // Onay kapısı kodla korunur (kural 8): taslak profille iş koşmaz, dolayısıyla
    // taslağa toplu taşıma da yapılmaz.
    if (target.status !== "approved") {
      throw new ApiError(409, `profil onaylı değil (${target.status}); önce onaylayın`);
    }

    const jobs = db
      .select({ id: schema.jobs.id, profileId: schema.jobs.profileId, title: schema.jobs.title })
      .from(schema.jobs)
      .where(eq(schema.jobs.projectId, target.projectId))
      .all();

    const moved: string[] = [];
    const skipped: { id: string; title: string; reason: string }[] = [];
    for (const job of jobs) {
      if (job.profileId === target.id) continue;
      try {
        deps.engine.retarget(job.id, target.id, "human");
        moved.push(job.id);
      } catch (err) {
        // `busy` beklenen bir sonuç; geri kalanı da aynı şekilde raporlanır —
        // tek bir işin düşmesi kalanları taşımayı engellemez.
        skipped.push({ id: job.id, title: job.title, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      profileId: target.id,
      version: target.version,
      moved: moved.length,
      alreadyOnTarget: jobs.filter((j) => j.profileId === target.id).length,
      skipped,
    };
  });

  /**
   * Onay/ret. Onayda İMAJ da işin parçasıdır — üç hâl ayrılır:
   *
   *  (a) imaj zaten var → hemen onayla, build YOK (sürpriz rebuild yapmayız).
   *  (b) imaj yok ama `exec.dockerfile` var → hemen onayla, arka planda build
   *      başlat, yanıtta `imageBuildId` dön (istemci polling'le izler).
   *  (c) imaj yok ve tarif de yok → 409. Eskiden bu hâl onayı geçiyordu ve iş
   *      saatler sonra "image not found" ile düşüyordu; kapı burada.
   */
  fastify.post<IdParams>("/api/profiles/:id/decision", async (req) => {
    const body = parse(ProfileDecisionBodySchema, req.body);
    const rows = db
      .select({
        id: schema.projectProfiles.id,
        document: schema.projectProfiles.document,
        projectId: schema.projectProfiles.projectId,
      })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, req.params.id))
      .all();
    if (!rows[0]) throw notFound("profil", req.params.id);

    let imageBuildId: string | null = null;

    if (body.decision === "approve") {
      // Onay kapısı kodla korunur (kural 8) — ama kapı yalnız `status` alanını
      // korumakla yetiniyordu, belgenin GÜNCEL şemayla hâlâ geçerli olduğunu
      // denetlemiyordu. YAŞANDI: `referenceRepos[].path` alanı `gitUrl`e
      // dönüştüğünde (şema sürümü atladı), önceden onaylanmış bir profil DB'de
      // öylece durdu ve iş ilk kullanıldığında `bad_profile` ile patladı —
      // teşhis dakikalar sürdü, engelleme onaydan ÖNCE olmalıydı.
      const parsed = ProjectProfileSchema.safeParse(rows[0].document);
      if (!parsed.success) {
        const detail = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`).join(" · ");
        throw new ApiError(409, `profil güncel şemayla uyuşmuyor, onaylanamaz: ${detail}`);
      }

      // Karar ONAYDAN ÖNCE ölçülür: (c) hâlinde profil onaylanmamalı. Eksik
      // imaj `validate` ucunda "error" olarak zaten görünüyordu ama insan hiç
      // "Doğrula"ya basmadan onaylayabiliyordu — iş saatler sonra Planning'de
      // "image not found" ile düşüyordu (yaşandı, 2026-09-19). `exec.image`
      // diğer check'lerden (build komutu, port vb.) FARKLI: koşu sırasında
      // düzeltilemez, iş baştan hiç kalkamaz — bu yüzden yalnız bu onayı SERT
      // engeller, geri kalanı hâlâ "insan görüp yine de onaylayabilir".
      const project = getProject(rows[0].projectId);
      const plan = await imageBuildPlan(parsed.data, project);
      if (plan.kind === "blocked") throw new ApiError(409, plan.reason);
      // `imageBuildPlan` beklenirken silme başlamış olabilir.
      assertNotDeleting(project.id);

      // `approveProfile` saf senkron DB transaction'ı OLARAK KALIR; build onun
      // içinde değil burada tetiklenir. Böylece onay mantığı Docker'a bağlanmaz.
      approveProfile(db, req.params.id);

      if (plan.kind === "buildable" && deps.docker) {
        imageBuildId = buildingImages.get(req.params.id)
          ?? startImageBuild(deps.docker, {
            profileId: req.params.id,
            workspaceRoot: plan.workspaceRoot,
            dockerfilePath: plan.dockerfilePath,
            imageRef: plan.imageRef,
          });
      }
    } else rejectProfile(db, req.params.id, body.comment);

    const after = db
      .select({ id: schema.projectProfiles.id, status: schema.projectProfiles.status, projectId: schema.projectProfiles.projectId })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, req.params.id))
      .all()[0];
    return { ...after, imageBuildId };
  });

  // ── İmaj build'leri ──────────────────────────────────────────────────────

  /** Profilin imaj build geçmişi — en yeni önce. */
  fastify.get<IdParams>("/api/profiles/:id/image-builds", async (req) => {
    return db
      .select({
        id: schema.profileImageBuilds.id,
        profileId: schema.profileImageBuilds.profileId,
        status: schema.profileImageBuilds.status,
        imageRef: schema.profileImageBuilds.imageRef,
        error: schema.profileImageBuilds.error,
        createdAt: schema.profileImageBuilds.createdAt,
        updatedAt: schema.profileImageBuilds.updatedAt,
      })
      .from(schema.profileImageBuilds)
      .where(eq(schema.profileImageBuilds.profileId, req.params.id))
      .orderBy(desc(schema.profileImageBuilds.createdAt))
      .all();
  });

  /** Tek build — UI bunu polling'le okur (build olayı WS'te taşınmıyor). */
  fastify.get<IdParams>("/api/image-builds/:id", async (req) => {
    const row = db
      .select({
        id: schema.profileImageBuilds.id,
        profileId: schema.profileImageBuilds.profileId,
        status: schema.profileImageBuilds.status,
        imageRef: schema.profileImageBuilds.imageRef,
        error: schema.profileImageBuilds.error,
        hasLog: schema.profileImageBuilds.logRef,
        createdAt: schema.profileImageBuilds.createdAt,
        updatedAt: schema.profileImageBuilds.updatedAt,
      })
      .from(schema.profileImageBuilds)
      .where(eq(schema.profileImageBuilds.id, req.params.id))
      .all()[0];
    if (!row) throw notFound("imaj build'i", req.params.id);
    // Durum sütunu TEXT (enum yok, CLAUDE.md); tüketirken Zod doğrular
    // (kural 3, üçüncü katman). Tanınmayan değer istemciye sessizce geçmez.
    const status = ImageBuildStatusSchema.safeParse(row.status);
    if (!status.success) throw new ApiError(500, `build durumu tanınmıyor: ${row.status}`);
    return { ...row, status: status.data, hasLog: row.hasLog !== null };
  });

  /**
   * Build'in tam log dosyası.
   *
   * Yol DB'den geliyor; yine de `artifactsDir` altında kaldığı DOĞRULANIR —
   * `/jobs/:id/builds/:buildId/log` ile aynı kalıp (kural 3).
   */
  fastify.get<IdParams>("/api/image-builds/:id/log", async (req, reply) => {
    const row = db
      .select({ logRef: schema.profileImageBuilds.logRef })
      .from(schema.profileImageBuilds)
      .where(eq(schema.profileImageBuilds.id, req.params.id))
      .all()[0];
    if (!row) throw notFound("imaj build'i", req.params.id);
    // Build sürüyorsa log henüz yazılmamıştır: boş metin, 404 değil — UI
    // "bekleniyor" gösterebilsin.
    if (!row.logRef) return reply.type("text/plain; charset=utf-8").send("");

    const root = resolve(deps.artifactsDir);
    const path = resolve(row.logRef);
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ApiError(400, "log yolu artifact kökünün dışında");
    }

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new ApiError(404, "log dosyası bulunamadı");
    }
    return reply.type("text/plain; charset=utf-8").send(text);
  });

  /**
   * İmajı ELLE build eder — düşen bir build'i yeniden denemenin yolu.
   *
   * Onaydan bağımsız: profil zaten onaylıyken build düşmüş olabilir (ağ, disk,
   * bozuk tarif). Burada imajın VARLIĞINA bakılmaz; kullanıcı açıkça istiyor.
   */
  fastify.post<IdParams>("/api/profiles/:id/build-image", async (req, reply) => {
    const row = db
      .select({ document: schema.projectProfiles.document, projectId: schema.projectProfiles.projectId })
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.id, req.params.id))
      .all()[0];
    if (!row) throw notFound("profil", req.params.id);
    if (!deps.docker) throw new ApiError(409, "Docker erişilemiyor; imaj build edilemez");

    const parsed = ProjectProfileSchema.safeParse(row.document);
    if (!parsed.success) throw new ApiError(409, "profil belgesi şemaya uymuyor; build edilemez");
    if (!parsed.data.exec.dockerfile) {
      throw new ApiError(409, "profilde `exec.dockerfile` tanımlı değil; build edilecek tarif yok");
    }

    const inFlight = buildingImages.get(req.params.id);
    if (inFlight) throw new ApiError(409, `bu profil için build zaten sürüyor: ${inFlight}`);

    const project = getProject(row.projectId);
    assertNotDeleting(project.id);
    // `imageBuildPlan` ile aynı kök: proje workspace'i DEĞİL, artifactsDir.
    const dockerfileAbs = dockerfileAbsPath(deps.artifactsDir, project.id);
    if (!existsSync(dockerfileAbs)) {
      throw new ApiError(409, `profildeki Dockerfile diskte yok: ${parsed.data.exec.dockerfile}`);
    }

    const buildId = startImageBuild(deps.docker, {
      profileId: req.params.id,
      workspaceRoot: dirname(dockerfileAbs),
      dockerfilePath: parsed.data.exec.dockerfile,
      imageRef: parsed.data.exec.image,
    });
    return reply.code(202).send({ imageBuildId: buildId, status: "running" });
  });

  // ── GitHub issue'ları ────────────────────────────────────────────────────

  /** Repo çözümü + varsa açık issue sayısı — üst çubuktaki toggle rozeti için. */
  fastify.get<IdParams>("/api/projects/:id/github", async (req) => {
    const project = getProject(req.params.id);
    const repo = await resolveGithubRepo(project);
    if (!repo) return { repo: null, issues: [] };
    try {
      const issues = await deps.github.listIssues(repo);
      return { repo, issues };
    } catch (e) {
      // `gh` host'ta yok ya da oturum kapalı: ekran boş liste görür, 500 değil —
      // Profil onayı sekmesi bundan bağımsız çalışmaya devam etmeli.
      throw new ApiError(502, `GitHub issue'ları alınamadı: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  /** Issue şablonlarının repodaki durumu — proje sayfasındaki kart. */
  fastify.get<IdParams>("/api/projects/:id/github/issue-templates", async (req) => {
    const project = getProject(req.params.id);
    const repo = await resolveGithubRepo(project);
    if (!repo) return { repo: null, status: null };
    try {
      return { repo, status: await issueTemplateStatus(deps.github, repo) };
    } catch (e) {
      throw new ApiError(502, `Issue şablonları okunamadı: ${scrubSecrets(e instanceof Error ? e.message : String(e))}`);
    }
  });

  /**
   * Eksik şablonlar için PR açar — bağlanırken otomatik öneri düşmüşse ya da
   * workspace bu özellikten önce bağlanmışsa. Idempotent: zaten varsa, PR
   * bekliyorsa ya da kapatılmışsa yazmadan durumu döner.
   */
  fastify.post<IdParams>("/api/projects/:id/github/issue-templates", async (req) => {
    const project = getProject(req.params.id);
    const repo = await resolveGithubRepo(project);
    if (!repo) throw new ApiError(400, "proje bir GitHub reposuna bağlı değil");
    let status;
    try {
      status = await proposeIssueTemplates(deps.github, repo);
    } catch (e) {
      throw new ApiError(502, `Issue şablonları önerilemedi: ${scrubSecrets(e instanceof Error ? e.message : String(e))}`);
    }
    if (status.state === "opened") {
      db.insert(schema.auditLog)
        .values({
          id: newId(), actor: "human", action: "project.issue_templates",
          subjectType: "project", subjectId: project.id,
          detail: { repo, url: status.url, paths: status.paths } as never,
        })
        .run();
    }
    return { repo, status };
  });

  fastify.get<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/issues/:number",
    async (req) => {
      const project = getProject(req.params.id);
      const repo = await resolveGithubRepo(project);
      if (!repo) throw new ApiError(400, "proje bir GitHub reposuna bağlı değil");
      const number = Number(req.params.number);
      if (!Number.isInteger(number) || number <= 0) throw new ApiError(400, "geçersiz issue numarası");
      try {
        return await deps.github.issueDetail(repo, number);
      } catch (e) {
        throw new ApiError(502, `Issue okunamadı: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  /**
   * TÜM workspace'lerin açık issue'ları — İşler ekranının "GitHub issue'ları"
   * sekmesi. Her issue'ya bağlı iş (varsa) sunucuda eşlenir: istemcinin iş
   * listesi sayfalı (limit 100) olduğundan eski bir bağlı iş orada görünmeyebilir.
   *
   * Bir projenin `gh` çağrısı düşerse TÜM yanıt 502 olmaz; o proje `error`
   * taşır, diğerleri listelenir. Tek bozuk remote ekranı karartmamalı.
   */
  fastify.get("/api/github/issues", async () => {
    const projects = db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).all();
    const linked = db
      .select({
        id: schema.jobs.id,
        projectId: schema.jobs.projectId,
        externalRef: schema.jobs.externalRef,
        state: schema.jobs.state,
        phase: schema.jobs.phase,
        updatedAt: schema.jobs.updatedAt,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.source, "github_issue"))
      .orderBy(desc(schema.jobs.updatedAt))
      .all();

    const out = await Promise.all(
      projects.map(async (p) => {
        const base = { projectId: p.id, projectName: p.name, repo: null as string | null, error: null as string | null };
        let repo: string | null;
        try {
          repo = await resolveGithubRepo(p);
        } catch (e) {
          return { ...base, error: `repo çözülemedi: ${e instanceof Error ? e.message : String(e)}`, issues: [] };
        }
        if (!repo) return { ...base, issues: [] };
        try {
          const issues = await deps.github.listIssues(repo);
          return {
            ...base,
            repo,
            issues: issues.map((i) => {
              // İptal edilmemiş iş iptal edilmişten önce gelir: issue'yu tutan
              // (ve yeni iş açmayı engelleyen) odur; eski iptaller geri planda.
              const mine = linked.filter((j) => j.projectId === p.id && j.externalRef === `#${i.number}`);
              const job = mine.find((j) => j.state !== "Cancelled") ?? mine[0] ?? null;
              return { ...i, linkedJob: job ? { id: job.id, state: job.state, phase: job.phase } : null };
            }),
          };
        } catch (e) {
          return { ...base, repo, error: scrubSecrets(e instanceof Error ? e.message : String(e)).slice(0, 500), issues: [] };
        }
      }),
    );
    return { fetchedAt: new Date().toISOString(), projects: out };
  });
}
