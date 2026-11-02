import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";

import {
  LoginBodySchema,
  PushSubscriptionBodySchema,
  TotpCodeBodySchema,
  type PushStatus,
} from "@ahtapot/shared";

import { SESSION_COOKIE, readCookie, sessionCookie, type AuthService } from "../auth/service.js";
import type { Notifier } from "../notify/notifier.js";
import { parse } from "./errors.js";

/**
 * Giriş, TOTP kurulumu ve push aboneliği uçları.
 *
 * Kimlik gerektirmeyenler (`PUBLIC_AUTH_PATHS`) yalnız giriş adımlarıdır;
 * kurulum ve abonelik uçları normal `onRequest` kapısından geçer.
 */

/** Oturum açmadan erişilebilen uçlar — `app.ts` kapısı bunları atlar. */
export const PUBLIC_AUTH_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/totp",
  "/api/auth/logout",
]);

export interface AuthRouteDeps {
  auth: AuthService;
  notifier: Notifier;
  sessionTtlHours: number;
}

export function sessionFrom(req: FastifyRequest): string | undefined {
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

export function bearerFrom(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

function meta(req: FastifyRequest) {
  return { userAgent: String(req.headers["user-agent"] ?? ""), ip: req.ip };
}

export function registerAuthRoutes(fastify: FastifyInstance, deps: AuthRouteDeps): void {
  const { auth, notifier } = deps;

  const setSession = (req: FastifyRequest, reply: FastifyReply, value: string, maxAgeSec: number) => {
    reply.header("set-cookie", sessionCookie(value, { secure: req.protocol === "https", maxAgeSec }));
  };

  fastify.get("/api/auth/status", async (req) => auth.status(sessionFrom(req)));

  fastify.post("/api/auth/login", async (req, reply) => {
    const body = parse(LoginBodySchema, req.body);
    // AuthError `statusCode` taşır; ortak hata işleyicisi `{ error }` zarfıyla döner.
    const r = auth.login(body.token, meta(req));
    // Bekleyen oturum 5 dk yaşar; çerez de o kadar.
    setSession(req, reply, r.session, r.next ? 300 : deps.sessionTtlHours * 3600);
    return auth.status(r.session);
  });

  fastify.post("/api/auth/totp", async (req, reply) => {
    const body = parse(TotpCodeBodySchema, req.body);
    const session = auth.verifyLoginTotp(sessionFrom(req), body.code, meta(req));
    setSession(req, reply, session, deps.sessionTtlHours * 3600);
    return auth.status(session);
  });

  fastify.post("/api/auth/logout", async (req, reply) => {
    auth.logout(sessionFrom(req));
    setSession(req, reply, "", 0);
    return { ok: true };
  });

  // ── TOTP kurulumu (oturum şart) ────────────────────────────────────────

  fastify.post("/api/auth/totp/setup", async () => auth.beginTotpSetup());

  fastify.post("/api/auth/totp/confirm", async (req, reply) => {
    const body = parse(TotpCodeBodySchema, req.body);
    const current = auth.authenticate(sessionFrom(req), bearerFrom(req));
    const sessionId = current.ok ? current.sessionId : null;
    const fresh = auth.confirmTotpSetup(body.code, sessionId, meta(req));
    if (fresh) setSession(req, reply, fresh, deps.sessionTtlHours * 3600);
    return auth.status(fresh ?? sessionFrom(req));
  });

  fastify.post("/api/auth/totp/disable", async (req) => {
    const body = parse(TotpCodeBodySchema, req.body);
    auth.disableTotp(body.code, req.ip);
    return auth.status(sessionFrom(req));
  });

  // ── Push bildirimleri ──────────────────────────────────────────────────

  fastify.get("/api/push", async (): Promise<PushStatus> => ({
    publicKey: notifier.vapidKeys().publicKey,
    subscriptions: notifier.subscriptionCount(),
    ntfy: notifier.ntfyEnabled,
  }));

  fastify.post("/api/push/subscribe", async (req) => {
    const body = parse(PushSubscriptionBodySchema, req.body);
    notifier.subscribe(body, String(req.headers["user-agent"] ?? ""));
    return { ok: true, subscriptions: notifier.subscriptionCount() };
  });

  fastify.post("/api/push/unsubscribe", async (req) => {
    const body = parse(z.object({ endpoint: z.string().min(1) }), req.body);
    notifier.unsubscribe(body.endpoint);
    return { ok: true, subscriptions: notifier.subscriptionCount() };
  });

  /** Kurulumu doğrulamak için: bildirim gerçekten telefona düşüyor mu. */
  fastify.post("/api/push/test", async () => {
    await notifier.notify({
      title: "Deneme bildirimi",
      body: "Bildirimler çalışıyor — agent sizi beklediğinde buraya düşecek.",
      url: "/",
      tag: "test",
    });
    return { ok: true, subscriptions: notifier.subscriptionCount(), ntfy: notifier.ntfyEnabled };
  });
}
