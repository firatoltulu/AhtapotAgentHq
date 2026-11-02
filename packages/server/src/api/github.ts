import type { FastifyInstance } from "fastify";

import { ApiError } from "./errors.js";
import type { ApiDeps } from "./index.js";

/**
 * Proje BAĞIMSIZ GitHub uçları — "workspace bağla" formunda henüz proje
 * yokken repo seçmek için. Proje bağımlı GitHub uçları (issue listesi,
 * tüm projelerin issue toplamı dahil) `projects.ts`'te kalır — repo çözümü
 * (`resolveGithubRepo`) orada yaşıyor.
 */
export function registerGithubRoutes(fastify: FastifyInstance, deps: ApiDeps): void {
  fastify.get("/api/github/repos", async () => {
    try {
      return { repos: await deps.github.listRepos() };
    } catch (e) {
      // /api/projects/:id/github ile AYNI 502 deseni: form'un GitHub sekmesi
      // hata gösterir, diğer iki mod (mevcut yol / URL'den klonla) etkilenmez.
      throw new ApiError(502, `GitHub repoları alınamadı: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
