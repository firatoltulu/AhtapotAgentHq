import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";

import type { ApiError as ApiErrorBody } from "@ahtapot/shared";

import { TransitionError } from "../engine/transition.js";
import { ProfileStateError } from "../analyst/analyst.js";
import { EngineError } from "../engine/job.js";
import { ReleaseError } from "../release/service.js";

/**
 * REST hata zarfı.
 *
 * Her 4xx/5xx aynı biçimde döner (`{ error, issues? }`), UI tek yerden
 * ayrıştırır. Bilinmeyen 500'lerde mesaj DIŞARI VERİLMEZ: yığın izi ve iç
 * yollar log'a gider, istemciye yalnız "iç hata" gider.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly issues?: ApiErrorBody["issues"],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Gövdeyi/sorguyu Zod ile doğrular; uymazsa 400 ve alan bazlı ayrıntı. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw new ApiError(
    400,
    "geçersiz istek",
    result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );
}

export function notFound(what: string, id: string): ApiError {
  return new ApiError(404, `${what} bulunamadı: ${id}`);
}

/** Alan hatalarını (durum makinesi, onay kapısı) HTTP koduna çevirir. */
export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      const body: ApiErrorBody = { error: err.message, ...(err.issues ? { issues: err.issues } : {}) };
      return reply.code(err.statusCode).send(body);
    }
    // Geçersiz geçiş ve yanlış profil durumu istemci hatasıdır: çakışma.
    if (err instanceof TransitionError || err instanceof ProfileStateError) {
      return reply.code(409).send({ error: err.message } satisfies ApiErrorBody);
    }
    if (err instanceof ReleaseError) {
      const code = err.code === "not_found" ? 404 : err.code === "unsupported" ? 400 : 409;
      return reply.code(code).send({ error: err.message } satisfies ApiErrorBody);
    }
    if (err instanceof EngineError) {
      const code = err.code === "not_found" ? 404 : err.code === "bad_edits" || err.code === "bad_input" ? 400 : 409;
      return reply.code(code).send({ error: err.message } satisfies ApiErrorBody);
    }
    // Fastify'ın kendi hataları (bozuk JSON, büyük gövde) kendi kodunu taşır.
    const known = err as { statusCode?: number; message?: string };
    if (typeof known.statusCode === "number" && known.statusCode < 500) {
      return reply.code(known.statusCode).send({ error: known.message ?? "istek hatası" });
    }
    req.log.error(err, "işlenmeyen hata");
    return reply.code(500).send({ error: "iç hata" } satisfies ApiErrorBody);
  });
}
