import type Dockerode from "dockerode";
import type { FastifyInstance } from "fastify";

import { BRAND, type ProjectProfile } from "@ahtapot/shared";

import type { CodeMapper } from "../codemap/mapper.js";
import type { ValidationCheck } from "../analyst/validate.js";

import { schema, type Db } from "../db/index.js";
import { resolveToken } from "../git/github.js";
import type { EventHub } from "../ws/hub.js";
import type { Analyst } from "../analyst/analyst.js";
import type { IdentityPool } from "../agents/identity.js";
import type { JobEngine } from "../engine/job.js";
import type { CommandExecutor } from "../build/executor.js";
import type { GitHubClient } from "../git/github.js";
import { registerErrorHandler } from "./errors.js";
import { registerProjectRoutes } from "./projects.js";
import { registerGithubRoutes } from "./github.js";
import { registerJobRoutes } from "./jobs.js";
import { registerFlowRoutes } from "./approvals.js";
import { registerUploadRoutes } from "./uploads.js";
import { registerReleaseRoutes } from "./releases.js";
import type { ReleaseService } from "../release/service.js";

/**
 * REST katmanı.
 *
 * İnce tutulur: doğrulama (Zod) + yetki + alan çağrısı. İş kuralları alan
 * modüllerinde (analyst, engine) yaşar; rotalar onları çağırır, tekrar yazmaz.
 * Böylece aynı kural WS üzerinden de tetiklendiğinde iki kopya olmaz.
 */
export interface ApiDeps {
  db: Db;
  /** Çalışan Ahtapot sürümü (`version.ts`); UI üst çubuğunda görünür. */
  appVersion?: string;
  hub: EventHub;
  analyst: Analyst;
  pool: IdentityPool;
  engine: JobEngine;
  /** Build log dosyalarının kökü; `/builds/:buildId/log` ucu bununla sınırlanır. */
  artifactsDir: string;
  /** Profil doğrulayıcı (Docker ve port aralığı app tarafından bağlanır). */
  validate: (profile: ProjectProfile) => Promise<ValidationCheck[]>;
  /** Host'ta git clone için — proje oluşturmada `gitUrl` verildiğinde kullanılır. */
  hostExec: CommandExecutor;
  /** Workspace GitHub issue ekranı: `gh issue list`/`view`, host'ta koşar. */
  github: GitHubClient;
  /** Tanımlıysa clone/github modlarında workspaceRoot otomatik türetilir. */
  workspacesRoot?: string;
  /**
   * Profil onayında imaj build'i için PAYLAŞILAN Docker istemcisi.
   *
   * Testlerde verilmez (null): o zaman imajın varlığı BİLİNEMEZ ve onay
   * build'siz geçer — imajsız profil reddedilmez. Bilinmeyeni engel saymak,
   * Docker'sız bir kurulumda hiçbir profilin onaylanamaması demekti.
   */
  docker?: Dockerode | null;
  /**
   * Profil imajı build'inden ÖNCE agent tabanını tazeler — eski taban üstüne
   * build edilen imaj ilk işte yeniden build edilirdi.
   */
  agentImages?: { ensureBase(): Promise<string> };
  /** Hedef repodaki release workflow'u; verilmezse release uçları kayıtlanmaz. */
  releases?: ReleaseService;
  /** Kod haritası; verilmezse harita uçları 404 döner. */
  codeMap?: CodeMapper;
}

export function registerApi(fastify: FastifyInstance, deps: ApiDeps): void {
  registerErrorHandler(fastify);

  fastify.get("/api/system", async () => ({
    brand: BRAND.displayName,
    version: deps.appVersion ?? "dev",
    /** Anahtar değeri ASLA dönmez — yalnız sayı ve açılış zamanı. */
    identities: deps.pool.status(),
    /** Ham yol DEĞİL — yalnız "tanımlı mı"; sunucu diskinin gerçek yolu istemciye sızmasın. */
    workspacesRoot: deps.workspacesRoot != null,
    /**
     * Token DEĞERİ dönmez, yalnız varlığı: issue okuma, push ve PR bu kimliğe
     * bağlı. Yoksa İşler ekranı üst çubukta söyler — PR adımında düşmeden önce.
     */
    github: { token: (await resolveToken()) !== "" },
    /** Şu an agent/komut koşturan iş sayısı — kapıda bekleyen ve kırık sayılmaz. */
    jobs: { running: runningJobCount(deps.db) },
    at: new Date().toISOString(),
  }));

  registerProjectRoutes(fastify, deps);
  registerGithubRoutes(fastify, deps);
  registerJobRoutes(fastify, deps);
  registerFlowRoutes(fastify, deps);
  registerUploadRoutes(fastify, deps);
  registerReleaseRoutes(fastify, deps);
}

const IDLE_STATES = new Set(["Draft", "Done", "Cancelled", "NeedsAttention"]);

function runningJobCount(db: Db): number {
  return db
    .select({ state: schema.jobs.state, phase: schema.jobs.phase })
    .from(schema.jobs)
    .all()
    .filter((j) => !IDLE_STATES.has(j.state) && (j.phase === "starting" || j.phase === "running")).length;
}
