import { readFile, copyFile, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";

import {
  CancelJobBodySchema,
  CreateJobBodySchema,
  ListJobsQuerySchema,
  scrubSecrets,
} from "@ahtapot/shared";

import { newId, schema } from "../db/index.js";
import { resolveToken } from "../git/github.js";
import { downloadIssueImages, type IssueImageResult } from "../git/issueImages.js";
import { ApiError, notFound, parse } from "./errors.js";
import type { ApiDeps } from "./index.js";

type IdParams = { Params: { id: string } };

/**
 * İş rotaları.
 *
 * Faz 1'in bu diliminde iş yalnız AÇILIR ve İPTAL EDİLİR; Planning'e geçiş
 * Planner rolüyle birlikte gelecek. İki kural şimdiden kodda:
 *
 *  1. Onaylı profili olmayan projede iş açılamaz — `activeProfileId` boşsa 409.
 *     İş, açıldığı andaki profil sürümünü taşır; profil sonradan değişse bile
 *     iş kendi sürümüyle koşar.
 *  2. İptal bir durum GEÇİŞİ değil, SİLME'dir — bkz. `/cancel` ucu. Diğer her
 *     durum değişikliği hâlâ yalnız `transition()` üzerinden olur.
 */
export function registerJobRoutes(fastify: FastifyInstance, deps: ApiDeps): void {
  const { db, hub } = deps;

  function getJob(id: string) {
    const rows = db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).all();
    const j = rows[0];
    if (!j) throw notFound("iş", id);
    return j;
  }

  fastify.get("/api/jobs", async (req) => {
    const q = parse(ListJobsQuerySchema, req.query);
    const filters: SQL[] = [];
    if (q.projectId) filters.push(eq(schema.jobs.projectId, q.projectId));
    if (q.state) filters.push(eq(schema.jobs.state, q.state));

    // Liste ekranı hangi profil sürümüyle koştuğunu göstermeli — join tek
    // sorguda gelsin diye; ayrı bir profil sorgusu her satır için N+1 olurdu.
    const rows = db
      .select({ job: schema.jobs, profileVersion: schema.projectProfiles.version })
      .from(schema.jobs)
      .leftJoin(schema.projectProfiles, eq(schema.jobs.profileId, schema.projectProfiles.id))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.jobs.updatedAt))
      .limit(q.limit)
      .all();

    return rows.map(({ job, profileVersion }) => ({ ...job, profileVersion: profileVersion ?? null }));
  });

  fastify.post("/api/jobs", async (req, reply) => {
    const body = parse(CreateJobBodySchema, req.body);

    const projects = db
      .select({ id: schema.projects.id, activeProfileId: schema.projects.activeProfileId })
      .from(schema.projects)
      .where(eq(schema.projects.id, body.projectId))
      .all();
    const project = projects[0];
    if (!project) throw notFound("proje", body.projectId);

    // ONAY KAPISI: taslak profille iş koşmaz. Yanlış build komutu her işi bozar.
    if (!project.activeProfileId) {
      throw new ApiError(409, "projenin onaylı profili yok; önce analiz edip profili onaylayın");
    }

    // Issue başına TEK iş: aynı issue'dan iki iş iki dal, iki PR ve iki
    // "Closes #n" üretir; biri birleşince diğeri kapanmış bir issue'ya çalışır.
    // Yalnız iptal edilmiş iş issue'yu serbest bırakır — Done iş de engeldir,
    // aynı issue ikinci kez açılmaz.
    const assertIssueFree = (q: Pick<typeof db, "select">) => {
      if (!body.externalRef) return;
      const existing = q
        .select({ id: schema.jobs.id, state: schema.jobs.state })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.projectId, project.id), eq(schema.jobs.externalRef, body.externalRef)))
        .all()
        .find((j) => j.state !== "Cancelled");
      if (existing) {
        throw new ApiError(409, `${body.externalRef} için iş zaten var: ${existing.id} (${existing.state})`);
      }
    };
    assertIssueFree(db);

    // Ekler bu işten ÖNCE yüklenmişti (jobId'siz); hepsi gerçekten var mı ve
    // henüz başka bir işe bağlanmamış mı diye burada doğrulanır — istemcinin
    // gönderdiği kimliğe güvenilmez (kural 3).
    const attachments = body.attachmentIds.length > 0
      ? db.select({ id: schema.jobAttachments.id, jobId: schema.jobAttachments.jobId, path: schema.jobAttachments.path, fileName: schema.jobAttachments.fileName })
          .from(schema.jobAttachments)
          .where(inArray(schema.jobAttachments.id, body.attachmentIds))
          .all()
      : [];
    const missing = body.attachmentIds.filter((aid) => !attachments.some((a) => a.id === aid));
    if (missing.length > 0) throw new ApiError(400, `ek bulunamadı: ${missing.join(", ")}`);
    const taken = attachments.filter((a) => a.jobId);
    if (taken.length > 0) throw new ApiError(409, `ek zaten başka bir işe bağlı: ${taken.map((a) => a.id).join(", ")}`);

    const id = newId();

    // Konteyner mount'u iş oluşmadan önce hazır olmalı (Planning ilk turda
    // okur): dosyalar `uploads/`den `<artifactsDir>/<jobId>/resources/`e
    // KOPYALANIR, taşınmaz — orijinal ek kaydı `/api/uploads/:id/file`
    // üzerinden hâlâ servis edilebilsin diye.
    // İş satırı yazılamazsa (eşzamanlı aynı issue → 409) bu dizin sahipsiz
    // kalırdı — aynı kimlik bir daha üretilmez, kimse silmez. Hata yolunda silinir.
    const jobDir = join(deps.artifactsDir, id);
    const resourcesDir = join(jobDir, "resources");
    let images: IssueImageResult | null = null;
    let created;
    try {
      if (attachments.length > 0) {
        await mkdir(resourcesDir, { recursive: true });
        for (const a of attachments) {
          await copyFile(a.path, join(resourcesDir, a.fileName));
        }
      }
      // Issue gövdesindeki GitHub görselleri de aynı köke iner — Planner metinde
      // yalnız bağlantıyı görür, içeriği ancak dosyayı Read ile açarak görür.
      // İndirme hatası işi düşürmez: görselsiz plan, hiç plan olmamasından iyi;
      // insan sebebi iş akışında görür.
      if (body.source === "github_issue" && body.description) {
        try {
          images = await downloadIssueImages(body.description, resourcesDir, await resolveToken());
        } catch (err) {
          images = { saved: [], failed: [{ url: "", reason: err instanceof Error ? err.message : String(err) }] };
        }
      }
      // İş ve ilk olay (seq 1) aynı commit'te: biri olup diğeri olmayan bir iş
      // replay'de görünmez. Yayın commit'ten sonra.
      created = db.transaction((tx) => {
        // Yukarıdaki denetimle buradaki yazma arasında `await` (ek kopyalama)
        // var: aynı issue için eşzamanlı iki istek ikisi de denetimi geçebilirdi.
        // Transaction senkron — bu ikinci denetimle yazma arasına istek giremez.
        assertIssueFree(tx);
        tx.insert(schema.jobs)
          .values({
            id,
            projectId: project.id,
            profileId: project.activeProfileId,
            title: body.title,
            description: body.description,
            externalRef: body.externalRef ?? null,
            externalUrl: body.externalUrl ?? null,
            source: body.source,
            targetRepos: body.targetRepos,
            referencePaths: body.referencePaths,
            priority: body.priority,
            state: "Draft",
            phase: "done",
          })
          .run();
        if (body.attachmentIds.length > 0) {
          tx.update(schema.jobAttachments)
            .set({ jobId: id })
            .where(inArray(schema.jobAttachments.id, body.attachmentIds))
            .run();
        }
        return hub.record(id, { type: "job.state", state: "Draft", phase: "done", loopCounts: {} }, tx);
      });
    } catch (err) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    hub.emit(created);
    if (images && (images.saved.length > 0 || images.failed.length > 0)) {
      const lines = [`Issue görselleri: ${images.saved.length} indirildi${images.saved.length ? ` (${images.saved.join(", ")})` : ""}.`];
      for (const f of images.failed) lines.push(`- indirilemedi${f.url ? `: ${withoutQuery(f.url)}` : ""} — ${f.reason}`);
      // İş yazıldı: bildirim düşerse yanıt 500 olmamalı — istemci işi yok sanıp
      // yeniden açmaya çalışır, issue kilidi 409 döner.
      try {
        hub.publish(id, { type: "agent.message", runId: "", role: "system", content: scrubSecrets(lines.join("\n")) });
      } catch (err) {
        req.log.warn({ err, jobId: id }, "issue görseli bildirimi yazılamadı");
      }
    }

    return reply.code(201).send(getJob(id));
  });

  /** İşe bağlı ekler — iş detayında "önizle" bağlantıları için. */
  fastify.get<IdParams>("/api/jobs/:id/attachments", async (req) => {
    const job = getJob(req.params.id);
    return db
      .select({
        id: schema.jobAttachments.id,
        fileName: schema.jobAttachments.fileName,
        mimeType: schema.jobAttachments.mimeType,
        sizeBytes: schema.jobAttachments.sizeBytes,
        createdAt: schema.jobAttachments.createdAt,
      })
      .from(schema.jobAttachments)
      .where(eq(schema.jobAttachments.jobId, job.id))
      .all();
  });

  fastify.get<IdParams>("/api/jobs/:id", async (req) => {
    const job = getJob(req.params.id);
    const transitions = db
      .select()
      .from(schema.jobTransitions)
      .where(eq(schema.jobTransitions.jobId, job.id))
      .orderBy(asc(schema.jobTransitions.createdAt))
      .all();
    // Detay sayfası da hangi profil sürümüyle koştuğunu göstermeli (liste ile aynı alan).
    const profileVersion = job.profileId
      ? (db.select({ version: schema.projectProfiles.version })
          .from(schema.projectProfiles)
          .where(eq(schema.projectProfiles.id, job.profileId))
          .all()[0]?.version ?? null)
      : null;
    return { ...job, profileVersion, transitions };
  });

  /**
   * İptal = SİLME. Kullanıcı bir işi iptal ettiğinde ekranda `Cancelled` bir
   * kalıntı bırakmıyoruz — işe ait DB satırları, worktree, konteyner ve
   * volume tamamen kaldırılır. `Cancelled` durumu bu yüzden hiç yazılmaz;
   * durum makinesi bu geçişte devre dışı, çünkü hedef zaten "iş yok".
   *
   * Bitmiş bir işi (`Done`) iptal etmeye çalışmak 409 verir; iş zaten yoksa
   * (daha önce silinmişse) `getJob` 404 fırlatır.
   */
  fastify.post<IdParams>("/api/jobs/:id/cancel", async (req) => {
    const job = getJob(req.params.id);
    const body = parse(CancelJobBodySchema, req.body);

    if (job.state === "Done") {
      throw new ApiError(409, "bitmiş iş silinemez");
    }

    // Koşan agent turu ÖNCE kesilir: silme sırasında hâlâ yazan bir tur,
    // yarı silinmiş satırlara mesaj eklemeye çalışabilir.
    const stopped = await deps.engine.stopRun(job.id, `insan iptal etti: ${body.reason || "gerekçe verilmedi"}`);

    // `purge()` ÖNCE, duyuru SONRA: sıra tersiyse (CodeRabbit ile yakalandı,
    // 2026-09-19) `purge()` hata verirse istemci ana sayfaya gitmiş oluyordu
    // ama iş DB'de kalıyordu — ekran ile gerçek durum uyuşmuyordu. `purge()`
    // içindeki hata burada YUTULMAZ: DB silme başarısızsa istek 500 döner ve
    // istemci hâlâ eski ekranda kalır, en azından tutarlı bir yalan söylemez.
    await deps.engine.purge(job.id);

    // Canlı izleyicilere anlık duyuru — DB'ye yazılmaz (job zaten silindi).
    // UI bunu görürse ekrandan hemen kaldırır; kaçırırsa liste ucu (job artık
    // dönmez) aynı sonucu bir sonraki taze bilgide verir.
    hub.emit({
      type: "job.deleted",
      jobId: job.id,
      seq: 0,
      at: new Date().toISOString(),
      reason: body.reason || "kullanıcı iptal etti",
    });

    return { jobId: job.id, deleted: true, stopped };
  });

  /**
   * İşin build adımları — UI build sekmesi geçmişi buradan çizer.
   *
   * `build.log` olayları artık DB'ye yazılmıyor (hub `EPHEMERAL_TYPES`);
   * koşan build canlı akışta, BİTEN build'in tam çıktısı log dosyasında.
   * Bu uç dosyayı değil kaydı döndürür; içerik `/log` ucundan alınır.
   */
  fastify.get<IdParams>("/api/jobs/:id/builds", async (req) => {
    const job = getJob(req.params.id);
    return db
      .select({
        id: schema.builds.id,
        phaseId: schema.builds.phaseId,
        stepName: schema.builds.stepName,
        command: schema.builds.command,
        skipped: schema.builds.skipped,
        skipReason: schema.builds.skipReason,
        exitCode: schema.builds.exitCode,
        durationMs: schema.builds.durationMs,
        hasLog: schema.builds.logRef,
        createdAt: schema.builds.createdAt,
      })
      .from(schema.builds)
      .where(eq(schema.builds.jobId, job.id))
      .orderBy(asc(schema.builds.createdAt))
      .all()
      .map((b) => ({ ...b, hasLog: b.hasLog !== null }));
  });

  /**
   * Bir build adımının TAM log dosyası.
   *
   * Dosya `<artifactsDir>/<jobId>/build-<buildId>.log`. Yol DB'den geliyor;
   * yine de `artifactsDir` altında kaldığı DOĞRULANIR — `logRef`e güvenip
   * doğrudan okumak, o sütuna yazabilen herhangi bir kusuru dosya sistemi
   * okumasına çeviren bir yol olurdu (kural 3: üretici taraf güvenilmez).
   */
  fastify.get<{ Params: { id: string; buildId: string } }>(
    "/api/jobs/:id/builds/:buildId/log",
    async (req, reply) => {
      const job = getJob(req.params.id);
      const row = db
        .select({ logRef: schema.builds.logRef })
        .from(schema.builds)
        .where(and(eq(schema.builds.id, req.params.buildId), eq(schema.builds.jobId, job.id)))
        .all()[0];
      if (!row) throw notFound("build", req.params.buildId);
      if (!row.logRef) throw new ApiError(404, "bu adımın log dosyası yok");

      const root = resolve(deps.artifactsDir);
      const path = resolve(row.logRef);
      // `relative` ".." ile başlıyorsa yol kökün dışında.
      const rel = relative(root, path);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new ApiError(400, "log yolu artifact kökünün dışında");
      }

      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        // Dosya silinmiş olabilir (disk temizliği): kayıp log 404'tür, 500 değil.
        throw new ApiError(404, "log dosyası bulunamadı");
      }
      return reply.type("text/plain; charset=utf-8").send(text);
    },
  );
}

/** İmzalı adresin sorgu dizesi (jwt, X-Amz-Signature) iş akışına yazılmaz. */
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}
