import type { FastifyInstance } from "fastify";
import { eq, isNull } from "drizzle-orm";

import { PauseReleaseBodySchema, StartReleaseBodySchema } from "@ahtapot/shared";

import { schema } from "../db/index.js";
import { ApiError, parse } from "./errors.js";
import type { ApiDeps } from "./index.js";

type IdParams = { Params: { id: string } };

/**
 * Hedef repodaki release workflow'u — elle tetik, dry-run, duraklatma.
 *
 * Tetik yalnız buradan ve zamanlayıcıdan gelir; agent'lara kapalı.
 */
export function registerReleaseRoutes(fastify: FastifyInstance, deps: ApiDeps): void {
  const service = deps.releases;
  if (!service) return;

  /**
   * Tüm projelerin güncel sürüm tag'i (`{ [projectId]: { repo, tag, version } | null }`).
   * Proje listesinden AYRI uç: liste `gh`e bekletilmez, rozet sonradan dolar.
   * Projeler paralel okunur; biri düşerse yalnız onun rozeti boş kalır.
   */
  fastify.get("/api/projects/versions", async () => {
    const rows = deps.db.select({ id: schema.projects.id }).from(schema.projects)
      .where(isNull(schema.projects.archivedAt)).all();
    const entries = await Promise.all(rows.map(async (r) => [r.id, await service.currentVersion(r.id)] as const));
    return Object.fromEntries(entries);
  });

  fastify.get<IdParams>("/api/projects/:id/release", async (req) => {
    const projectId = req.params.id;
    const active = service.activeProfile(projectId);
    const inFlight = service.inFlight(projectId);
    // Tembel yenileme: yanıtı `gh`e bekletmez, bir sonraki yoklama günceli görür.
    if (inFlight) void service.refresh(inFlight);
    const project = deps.db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    if (!project) throw new ApiError(404, `proje bulunamadı: ${projectId}`);
    return {
      config: active?.profile.release ?? null,
      current: await service.currentVersion(projectId),
      pausedUntil: project.releasePausedUntil,
      nextRunAt: service.nextRunAt(projectId),
      inFlight,
      history: service.history(projectId),
    };
  });

  fastify.post<IdParams>("/api/projects/:id/release", async (req, reply) => {
    const body = parse(StartReleaseBodySchema, req.body);
    const started = service.start(req.params.id, { trigger: "manual", actor: "human", bump: body.bump });
    // Elle tetikte yuva yok; null yalnız zamanlı turda dönebilir.
    if (!started) throw new ApiError(409, "yayın başlatılamadı");
    return reply.code(202).send({ releaseId: started.id });
  });

  /**
   * Turun ne yapacağını gösterir — hiçbir şey yazmaz, tetiklemez. `bump`
   * verilmezse ZAMANLI tur hesaplanır (auto bump, değişiklik/CI atlaması).
   * Workflow dosyası repoda yoksa ya da etkin değilse burada uyarılır;
   * gerçek tetikte bu, `gh workflow run`ın anlaşılmaz 404'ü olurdu.
   */
  fastify.post<IdParams>("/api/projects/:id/release/dry-run", async (req) => {
    const body = parse(StartReleaseBodySchema.partial(), req.body);
    const plan = await service.plan(req.params.id, body.bump ? { bump: body.bump } : {});
    const warnings: string[] = [];
    if (deps.github.listWorkflows) {
      const flows = await deps.github.listWorkflows(plan.repo);
      // Profilde yol da yazılmış olabilir; karşılaştırma dosya adıyla.
      const f = plan.workflowFile.split(/[\\/]/).pop() || plan.workflowFile;
      if (!flows.some((w) => w.path.endsWith(`/${f}`) || w.name === f)) {
        warnings.push(`${f} ${plan.repo} reposunda etkin bir workflow değil (var olanlar: ${flows.map((w) => w.path).join(", ") || "yok"})`);
      }
    }
    return { plan, warnings, nextRunAt: service.nextRunAt(req.params.id) };
  });

  fastify.post<IdParams>("/api/projects/:id/release/pause", async (req) => {
    const body = parse(PauseReleaseBodySchema, req.body);
    service.setPause(req.params.id, body.until, "human");
    return { pausedUntil: body.until, nextRunAt: service.nextRunAt(req.params.id) };
  });
}
