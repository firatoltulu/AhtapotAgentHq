import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";

import { AnswerBodySchema, AnswerQuestionsBodySchema, ApprovalDecisionBodySchema, ChatBodySchema, CritiqueDocumentSchema, RequestCritiqueBodySchema,JobAutopilotBodySchema, GenerateTestScenariosBodySchema, JobLiveEnvBodySchema, JobModelTierBodySchema, LiveExtendBodySchema, PhaseTierOverrideBodySchema, PlanDocumentSchema, ReopenJobBodySchema, RetryJobBodySchema, SetScenarioMarkBodySchema, TestScenariosDocumentSchema, parseScenarioMarks } from "@ahtapot/shared";

import { schema } from "../db/index.js";
import { ApiError, notFound, parse } from "./errors.js";
import { diffSummary } from "../engine/job.js";
import type { ApiDeps } from "./index.js";

type IdParams = { Params: { id: string } };

/**
 * İş akışı rotaları: başlat, plan, onay kararı, sohbet.
 *
 * Kararı motor verir; burada yalnız doğrulama ve HTTP karşılığı var.
 * Uzun süren işler (planlama) 202 ile döner, ilerleme WS'ten izlenir.
 */
export function registerFlowRoutes(fastify: FastifyInstance, deps: ApiDeps): void {
  const { db, engine } = deps;

  fastify.post<IdParams>("/api/jobs/:id/start", async (req, reply) => {
    const exists = db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, req.params.id)).all()[0];
    if (!exists) throw notFound("iş", req.params.id);
    const { planning } = engine.start(req.params.id);
    planning.catch((err: unknown) => req.log.error(err, "planlama beklenmedik biçimde düştü"));
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, req.params.id)).all()[0];
    return reply.code(202).send(job);
  });

  /** Son plan + safhaları + bekleyen kapı. */
  fastify.get<IdParams>("/api/jobs/:id/plan", async (req) => {
    const plan = db.select().from(schema.plans).where(eq(schema.plans.jobId, req.params.id)).orderBy(desc(schema.plans.version)).limit(1).all()[0];
    if (!plan) throw notFound("plan", req.params.id);
    const phases = db.select().from(schema.planPhases).where(eq(schema.planPhases.planId, plan.id)).orderBy(schema.planPhases.order).all();
    const gate = db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, req.params.id), eq(schema.approvals.status, "pending"))).all()[0] ?? null;
    const versions = db.select({ id: schema.plans.id, version: schema.plans.version, status: schema.plans.status, createdAt: schema.plans.createdAt })
      .from(schema.plans).where(eq(schema.plans.jobId, req.params.id)).orderBy(desc(schema.plans.version)).all();
    // DB'deki belge HAM JSON. Şemadan geçirmeden döndürülürse eski planların
    // düz metin `openQuestions`'ı UI'a olduğu gibi gider ve istemci patlar —
    // `preprocess` yalnız parse sırasında çalışır. Bozuk belge de akışı
    // kesmesin: ham hâli dönsün, UI kendi savunmasını yapsın.
    const parsed = PlanDocumentSchema.safeParse(plan.document);
    const document = parsed.success ? parsed.data : plan.document;
    // QA case'leri buraya bindiriliyor, ayrı rotaya değil: UI zaten bu uç
    // noktayı yokluyor, ikinci bir istek fazladan yenileme döngüsü demek.
    //
    // YAŞANDI (2026-09-17): case listesi YALNIZ bekleyen kapının payload'ında
    // taşınıyordu; onay verilince kapı kapanıyor ve liste UI'dan tamamen
    // kayboluyordu — QA sekmesi "QA aşamasına gelinmedi" diyordu, oysa QA o
    // sırada o case'lerle test yazıyordu. Tablo kalıcı, kapı geçici.
    const qaCases = db.select().from(schema.qaCases)
      .where(eq(schema.qaCases.jobId, req.params.id)).orderBy(schema.qaCases.createdAt).all();
    return { ...plan, document, phases, pendingApproval: gate, versions, qaCases };
  });

  /** Belirli bir plan sürümü — sürüm listesinden geçmişe bakmak için. */
  fastify.get<{ Params: { id: string; planId: string } }>("/api/jobs/:id/plans/:planId", async (req) => {
    const plan = db.select().from(schema.plans)
      .where(and(eq(schema.plans.id, req.params.planId), eq(schema.plans.jobId, req.params.id))).all()[0];
    if (!plan) throw notFound("plan sürümü", req.params.planId);
    const phases = db.select().from(schema.planPhases).where(eq(schema.planPhases.planId, plan.id)).orderBy(schema.planPhases.order).all();
    const parsed = PlanDocumentSchema.safeParse(plan.document);
    return { ...plan, document: parsed.success ? parsed.data : plan.document, phases };
  });

  /**
   * O ANKİ worktree diff'i — safha kapısını BEKLEMEDEN.
   *
   * Kapı yükündeki diff yalnız onay anında üretiliyor; Developer yazarken
   * operatör dosyalara bakamıyor, yalnız araç çağrılarını okuyabiliyordu.
   * Aynı `diffSummary` kullanılır: sır maskeleme ve kırpma davranışı birebir.
   */
  fastify.get<IdParams>("/api/jobs/:id/diff", async (req) => {
    const job = db.select({ worktreePath: schema.jobs.worktreePath, state: schema.jobs.state })
      .from(schema.jobs).where(eq(schema.jobs.id, req.params.id)).all()[0];
    if (!job) throw notFound("iş", req.params.id);
    if (!job.worktreePath) return { ready: false, reason: "çalışma ağacı henüz hazır değil", diff: null };
    // Worktree named volume'de: okumak işin konteynerini gerektirir. Konteyner
    // ayakta değilse diff üretilemez — salt okuma için konteyner kaldırılmaz.
    const diff = await engine.liveDiff(req.params.id);
    if (!diff) return { ready: false, reason: "iş konteyneri ayakta değil", diff: null };
    return { ready: true, reason: "", diff };
  });

  fastify.get<IdParams>("/api/jobs/:id/approvals", async (req) => {
    return db.select().from(schema.approvals).where(eq(schema.approvals.jobId, req.params.id)).orderBy(desc(schema.approvals.requestedAt)).all();
  });

  fastify.post<IdParams>("/api/approvals/:id/decide", async (req, reply) => {
    const body = parse(ApprovalDecisionBodySchema, req.body);
    const result = engine.decide(req.params.id, body.decision, body.comment, body.edits, "human", body.attachmentIds ?? []);
    result.planning?.catch((err: unknown) => req.log.error(err, "yeniden planlama düştü"));
    return reply.code(result.planning ? 202 : 200).send({ jobId: result.jobId, state: result.state });
  });

  /** Aktif canlı ortam (UI "Uygulamayı aç" düğmesi buradan). */
  fastify.get<IdParams>("/api/jobs/:id/live", async (req) => {
    const rows = db.select().from(schema.liveEnvironments).where(eq(schema.liveEnvironments.jobId, req.params.id)).all();
    const active = rows.find((e) => e.status === "ready" || e.status === "starting" || e.status === "unhealthy") ?? null;
    return { active, history: rows };
  });

  /**
   * Canlı ortamı yıkıp yeniden kaldır — profil değiştiğinde.
   *
   * Koşan ortam bir kez kalktıktan sonra profil ona geçmiyor; port ya da
   * bağlantı değişikliği ancak yeniden kaldırınca etkili oluyor.
   */
  fastify.post<IdParams>("/api/jobs/:id/live/relaunch", async (req, reply) => {
    const r = await engine.relaunchLive(req.params.id);
    r.work.catch((err: unknown) => req.log.error(err, "canlı ortam yeniden kaldırılamadı"));
    return reply.code(202).send({ jobId: r.jobId, state: r.state });
  });

  /** Kalmış canlı ortamı yık — iş durumu değişmez. */
  fastify.post<IdParams>("/api/jobs/:id/live/stop", async (req) => {
    const stopped = await engine.stopLive(req.params.id);
    if (!stopped) throw new ApiError(409, "yıkılacak canlı ortam yok");
    return { stopped };
  });

  /**
   * İşe özel canlı ortam değişkenleri — tamamı yazılır. Koşan ortama geçmez;
   * "Yeniden kaldır" ya da yeniden deneme ile uygulanır.
   */
  fastify.put<IdParams>("/api/jobs/:id/live/env", async (req) => {
    const body = parse(JobLiveEnvBodySchema, req.body);
    return engine.setLiveEnv(req.params.id, body.env);
  });

  fastify.post<IdParams>("/api/jobs/:id/live/extend", async (req) => {
    const body = parse(LiveExtendBodySchema, req.body);
    const expiresAt = engine.extendLive(req.params.id, body.minutes);
    if (!expiresAt) throw new ApiError(409, "uzatılacak canlı ortam yok");
    return { expiresAt };
  });

  /**
   * Canlı test senaryoları — en son istek (üretiliyor/hazır/düştü) ve geçmiş.
   *
   * Ayrı uç, `/plan`a bindirilmedi: satır `running` iken UI bunu kısa aralıkla
   * yokluyor; plan yanıtı büyük ve o yoklamayı taşımamalı.
   */
  fastify.get<IdParams>("/api/jobs/:id/test-scenarios", async (req) => {
    const rows = db.select().from(schema.testScenarios)
      .where(eq(schema.testScenarios.jobId, req.params.id)).orderBy(desc(schema.testScenarios.createdAt)).all();
    // Tüketirken Zod (kural 3): bozuk belge UI'ı patlatmasın, `null` gitsin.
    const view = (r: (typeof rows)[number]) => {
      const parsed = TestScenariosDocumentSchema.safeParse(r.document);
      return { ...r, document: parsed.success ? parsed.data : null, marks: parseScenarioMarks(r.marks) };
    };
    const latest = rows[0];
    return {
      latest: latest ? view(latest) : null,
      history: rows.map((r) => ({ id: r.id, stage: r.stage, status: r.status, createdAt: r.createdAt })),
    };
  });

  /** Senaryo iste — 202; sonuç `GET` ile yoklanır, akışa da not düşer. */
  fastify.post<IdParams>("/api/jobs/:id/test-scenarios", async (req, reply) => {
    const body = parse(GenerateTestScenariosBodySchema, req.body ?? {});
    const r = engine.generateTestScenarios(req.params.id, body.note);
    r.work.catch((err: unknown) => req.log.error(err, "test senaryoları üretilemedi"));
    return reply.code(202).send({ id: r.id });
  });

  /**
   * İkinci göz — işin tüm eleştirileri, yeniden eskiye. UI konuya
   * (`subjectId`) göre süzer; satır sayısı plan sürümü + senaryo isteği kadar.
   */
  fastify.get<IdParams>("/api/jobs/:id/critiques", async (req) => {
    const rows = db.select().from(schema.critiques)
      .where(eq(schema.critiques.jobId, req.params.id)).orderBy(desc(schema.critiques.createdAt)).all();
    // Tüketirken Zod (kural 3): bozuk belge UI'ı patlatmasın, `null` gitsin.
    return {
      critiques: rows.map((r) => {
        const parsed = CritiqueDocumentSchema.safeParse(r.document);
        return { ...r, document: parsed.success ? parsed.data : null };
      }),
    };
  });

  /** Elle yeniden incele — 202; sonuç `critique.updated` olayıyla duyurulur. */
  fastify.post<IdParams>("/api/jobs/:id/critiques", async (req, reply) => {
    const body = parse(RequestCritiqueBodySchema, req.body ?? {});
    return reply.code(202).send(engine.requestCritique(req.params.id, body.subject, body.subjectId));
  });

  /**
   * Tek senaryonun geçti/kaldı/kararsız işareti (`state: null` kaldırır).
   * Senaryo başına ayrı çağrı: iki sekme aynı listeyi işaretlerken birinin
   * tüm listeyi yazması diğerinin işaretini ezerdi.
   */
  fastify.put<{ Params: { id: string; rowId: string; key: string } }>("/api/jobs/:id/test-scenarios/:rowId/marks/:key", async (req) => {
    const body = parse(SetScenarioMarkBodySchema, req.body ?? {});
    return { marks: engine.setScenarioMark(req.params.id, req.params.rowId, req.params.key, body.state, body.note) };
  });

  /**
   * Tarayıcı turunun kanıt görüntüsü:
   * `<artifactsDir>/<jobId>/live-<tur>/<dosya>`. Ad agent'tan geliyor
   * (kural 3): desenle sınırlı, yol kökün dışına çıkamaz.
   */
  fastify.get<{ Params: { id: string; round: string; file: string } }>("/api/jobs/:id/live-evidence/:round/:file", async (req, reply) => {
    const { id, round, file } = req.params;
    if (!/^\d{1,4}$/.test(round) || !/^[\w.-]+\.(png|jpe?g)$/i.test(file) || file.includes("..")) {
      throw new ApiError(400, "geçersiz kanıt adı");
    }
    let body: Buffer;
    try {
      body = await readFile(join(deps.artifactsDir, basename(id), `live-${round}`, file));
    } catch {
      throw new ApiError(404, "kanıt bulunamadı");
    }
    return reply.type(/\.png$/i.test(file) ? "image/png" : "image/jpeg").header("Cache-Control", "private, max-age=86400").send(body);
  });

  /**
   * İşin model seviyesini deneme başlatmadan değiştir — ör. "bir tur daha"
   * kapısını onaylamadan önce. Koşan işte de kabul: bir sonraki tur alır.
   */
  fastify.post<IdParams>("/api/jobs/:id/model-tier", async (req) => {
    const body = parse(JobModelTierBodySchema, req.body);
    return engine.setModelTier(req.params.id, body.tier);
  });

  /**
   * İşin otopilotu — yalnız geliştirme adımında insan beklenmez. Koşan işte
   * de kabul; açılınca bekleyen safha kapısı ve sorular hemen çözülür.
   */
  fastify.post<IdParams>("/api/jobs/:id/autopilot", async (req) => {
    const body = parse(JobAutopilotBodySchema, req.body);
    return engine.setAutopilot(req.params.id, body.enabled);
  });

  /** NeedsAttention'dan yeniden dene (kimlik/Docker gibi dış engel giderildiyse). */
  fastify.post<IdParams>("/api/jobs/:id/retry", async (req, reply) => {
    // Gövde isteğe bağlı: eski istemci `{}` gönderiyor, model seçimi yok.
    const body = parse(RetryJobBodySchema, req.body ?? {});
    const r = engine.retry(req.params.id, "human", body.modelTier);
    r.work.catch((err: unknown) => req.log.error(err, "yeniden deneme düştü"));
    return reply.code(202).send({ jobId: req.params.id, state: r.state });
  });

  /** NeedsAttention'daki işin PR'ı için merge kapısını aç — CI kırmızı olsa bile. */
  fastify.post<IdParams>("/api/jobs/:id/merge-gate", async (req, reply) => {
    const r = await engine.openMergeGate(req.params.id, "human");
    return reply.code(202).send({ jobId: req.params.id, ...r });
  });

  /**
   * Done/NeedsAttention işini insanın seçtiği adımdan yeniden aç.
   *
   * `retry`den farkı: orada kurtarma noktasını motor seçer, burada insan.
   * Aynı iş, aynı dal ve aynı worktree sürer — `clone`un aksine yeni iş
   * açılmaz, Developer sıfırdan koşmaz.
   */
  fastify.post<IdParams>("/api/jobs/:id/reopen", async (req, reply) => {
    const body = parse(ReopenJobBodySchema, req.body);
    const r = engine.reopen(req.params.id, body.target, body.comment, "human", body.modelTier, body.attachmentIds ?? []);
    r.work.catch((err: unknown) => req.log.error(err, "yeniden açılan iş düştü"));
    return reply.code(202).send({ jobId: req.params.id, state: r.state });
  });

  /**
   * Kapanmış işi (Cancelled/Done) yeni bir işe klonla.
   *
   * `carryPlan` ile onaylı plan taşınır ve iş doğrudan Developing'den sürer —
   * insanın onayladığı planı yeniden ürettirmek hem pahalı hem de aynı sonucu
   * vermez.
   */
  fastify.post<IdParams>("/api/jobs/:id/clone", async (req, reply) => {
    const body = (req.body ?? {}) as { carryPlan?: boolean; profileId?: string };
    const r = engine.clone(req.params.id, {
      ...(body.carryPlan !== undefined ? { carryPlan: body.carryPlan } : {}),
      ...(body.profileId ? { profileId: body.profileId } : {}),
    });
    // Plan taşındıysa iş Developing'de bekliyor; koşmayı çağıran başlatır.
    if (r.state === "Developing") {
      engine.resume(r.jobId).catch((err: unknown) => req.log.error(err, "klon geliştirmesi düştü"));
    }
    return reply.code(201).send(r);
  });

  /**
   * İşi güncel onaylı profile taşı.
   *
   * Profil düzeltildiğinde koşan iş eskisiyle kalıyordu ve taşıyacak bir yol
   * yoktu. Sayaçlar temizlenir: tavan çoğu zaman eski profilin kusuruyla dolar.
   */
  fastify.post<IdParams>("/api/jobs/:id/profile", async (req) => {
    const body = (req.body ?? {}) as { profileId?: string };
    return engine.retarget(req.params.id, body.profileId);
  });

  /** Plan kapısındaki açık soruları cevapla → Planner planı günceller. */
  fastify.post<IdParams>("/api/jobs/:id/plan/answers", async (req, reply) => {
    const body = parse(AnswerQuestionsBodySchema, req.body);
    const r = engine.answerPlanQuestions(req.params.id, body.answers, body.comment);
    r.planning.catch((err: unknown) => req.log.error(err, "soru cevabı sonrası planlama düştü"));
    return reply.code(202).send({ jobId: req.params.id, state: r.state });
  });

  /**
   * Safha başına model seviyesini elle değiştir — plan ya da safha kapısı açıkken.
   *
   * Kapı kapanmaz, plan sürümü artmaz: bu bir karar değil, kararın girdisinin
   * düzeltilmesi. İnsan tabloyu düzeltir, sonra aynı banner'dan onaylar.
   */
  fastify.post<IdParams>("/api/jobs/:id/phase-tiers", async (req) => {
    const body = parse(PhaseTierOverrideBodySchema, req.body);
    return engine.overridePhaseTiers(req.params.id, body.overrides, body.comment);
  });

  /** Sıradaki (başlamamış ilk) safha ve koşacağı model; yoksa `null`. */
  fastify.get<IdParams>("/api/jobs/:id/next-phase", async (req) => {
    return { next: engine.nextPhaseView(req.params.id) };
  });

  fastify.post<IdParams>("/api/jobs/:id/answer", async (req) => {
    const body = parse(AnswerBodySchema, req.body);
    if (!engine.answer(body.questionId, body.answer)) throw new ApiError(409, "bekleyen soru yok (süresi dolmuş olabilir)");
    return { ok: true };
  });

  fastify.get<IdParams>("/api/jobs/:id/questions", async (req) => ({ pending: engine.pendingQuestions(req.params.id) }));

  fastify.post<IdParams>("/api/jobs/:id/chat", async (req, reply) => {
    const body = parse(ChatBodySchema, req.body);
    const r = engine.chat(req.params.id, body.text, body.interrupt);
    if (!r.accepted) throw new ApiError(409, r.reason);
    r.turn?.catch((err: unknown) => req.log.error(err, "sohbet turu düştü"));
    return reply.code(202).send({ accepted: true, reason: r.reason });
  });
}
