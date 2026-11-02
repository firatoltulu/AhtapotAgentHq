import { mkdirSync, createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { newId, schema } from "../db/index.js";
import { ApiError, notFound } from "./errors.js";
import type { ApiDeps } from "./index.js";

/**
 * İzin verilen ekler, UZANTIYA göre. Tarayıcı `.md`/`.log`/`.csv` için çoğu
 * zaman boş ya da keyfi `type` bildirir; güvenilir olan ad, MIME'ı biz türetiriz.
 * Görsel dışındakiler (html, metin) agent'ın `resources/` dizininde okuyacağı
 * girdidir — tarayıcıda çalıştırılmaz (aşağıda `sendFile`).
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  yaml: "text/plain",
  yml: "text/plain",
};

/**
 * "Yeni iş" formunun ekleri (görsel, html, metin).
 *
 * İki aşamalı: iş henüz YOK iken dosya buradan yüklenir (`jobId: null` ile
 * kaydedilir), iş oluşunca `CreateJobBody.attachmentIds` ile eşleştirilip
 * satıra `jobId` yazılır. Form gönderilmeden vazgeçilirse ek `jobId`siz kalır
 * — temizlik kapsam dışı (Faz 1: tek kullanıcı, düşük hacim).
 */
export function registerUploadRoutes(fastify: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;
  const uploadsDir = join(deps.artifactsDir, "uploads");

  fastify.post("/api/uploads", async (req) => {
    const file = await req.file();
    if (!file) throw new ApiError(400, "dosya verilmedi");
    const ext = file.filename.toLowerCase().split(".").pop() ?? "";
    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) {
      throw new ApiError(400, `desteklenmeyen tür: .${ext} — izinli: ${Object.keys(MIME_BY_EXT).join(", ")}`);
    }

    mkdirSync(uploadsDir, { recursive: true });
    const id = newId();
    // Ad diskte kullanılmadan önce temizlenir: çok satırlı ya da yol ayracı
    // taşıyan bir dosya adı (kural 3 — istemci güvenilmez) `uploadsDir` dışına
    // yazmayı denememeli.
    const safeName = file.filename.replace(/[/\\]/g, "_").slice(-150);
    const path = join(uploadsDir, `${id}-${safeName}`);

    let sizeBytes = 0;
    file.file.on("data", (chunk: Buffer) => { sizeBytes += chunk.length; });
    await pipeline(file.file, createWriteStream(path));
    // `@fastify/multipart` limiti aşınca stream'i sessizce keser ve `file.file.truncated` işaretler.
    if (file.file.truncated) throw new ApiError(400, "dosya 5 MB sınırını aşıyor");

    db.insert(schema.jobAttachments)
      .values({ id, jobId: null, fileName: safeName, mimeType, sizeBytes, path })
      .run();

    return { id, fileName: safeName, mimeType, sizeBytes };
  });

  fastify.delete<{ Params: { id: string } }>("/api/uploads/:id", async (req) => {
    const row = db.select().from(schema.jobAttachments)
      .where(eq(schema.jobAttachments.id, req.params.id)).all()[0];
    if (!row) throw notFound("ek", req.params.id);
    if (row.jobId) throw new ApiError(409, "bu ek zaten bir işe bağlı, silinemez");
    db.delete(schema.jobAttachments).where(eq(schema.jobAttachments.id, row.id)).run();
    return { ok: true };
  });

  /** Ekin dosyasını sunar — form önizlemesi ve iş detayındaki "Önizle" için. */
  fastify.get<{ Params: { id: string } }>("/api/uploads/:id/file", async (req, reply) => {
    const row = db.select().from(schema.jobAttachments)
      .where(eq(schema.jobAttachments.id, req.params.id)).all()[0];
    if (!row) throw notFound("ek", req.params.id);
    // Görsel dışı ek (özellikle HTML) uygulamayla AYNI origin'den sunulur:
    // olduğu gibi `text/html` verilirse içindeki script oturumla çalışır.
    // Düz metin + sandbox CSP ile yalnız kaynak olarak görüntülenir.
    const isImage = row.mimeType.startsWith("image/");
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox")
      .type(isImage ? row.mimeType : "text/plain; charset=utf-8")
      .send(createReadStream(row.path));
  });
}
