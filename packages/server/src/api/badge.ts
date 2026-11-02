import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { BRAND, type JobState } from "@ahtapot/shared";

import { schema, type Db } from "../db/index.js";
import { STAGES, stageOf } from "../tracker/stages.js";

/**
 * İşin canlı durum rozeti — issue yorumlarına gömülür.
 *
 * `/api` ALTINDA DEĞİL, kimlik istemez: GitHub görselleri kendi vekili
 * (camo) üzerinden çerezsiz çeker; korumalı uç kırık görsel olurdu. Sızan
 * yalnız aşama adı — başlık, içerik yok. İş kimliği UUIDv7 (tahmin edilemez)
 * ve bilinmeyen kimlik 404 değil gri rozet alır: kimliğin varlığı da sızmaz.
 */
export function registerBadgeRoutes(fastify: FastifyInstance, db: Db): void {
  fastify.get<{ Params: { file: string } }>("/badge/jobs/:file", async (req, reply) => {
    const id = req.params.file.replace(/\.svg$/, "");
    const row = db.select({ state: schema.jobs.state }).from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    const stage = row ? STAGES[stageOf(row.state as JobState)] : { label: "bilinmiyor", color: "9ca3af" };
    const etag = `"${stage.label}"`;
    // Camo önbelleğe alır; tazelensin diye her istekte doğrulatılır.
    void reply.header("cache-control", "no-cache, max-age=0").header("etag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.type("image/svg+xml; charset=utf-8").send(renderBadge(BRAND.displayName, stage.label, stage.color));
  });
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Shields tarzı iki parçalı rozet. Genişlik karakter sayısından kestirilir (11px sans ≈ 7px/karakter). */
export function renderBadge(left: string, right: string, color: string): string {
  const w = (s: string) => Math.round(s.length * 7 + 12);
  const lw = w(left);
  const rw = w(right);
  const total = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">
<title>${esc(left)}: ${esc(right)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="#${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(left)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text>
</g></svg>`;
}
