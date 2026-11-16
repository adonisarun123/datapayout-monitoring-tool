import crypto from "node:crypto";
import { db, one } from "./db";
import { AppError, forbidden, fromPgError, unauthenticated } from "./errors";
import { getActorFromToken, requireRecentAuth, SESSION_COOKIE } from "@/server/auth";
import type { Actor } from "@/server/audit";

export interface RouteArgs {
  req: Request;
  url: URL;
  actor: Actor;
  params: Record<string, string>;
  body: any;
  requestId: string;
}

interface RouteOptions {
  /** No session required (login, invite acceptance). */
  public?: boolean;
  admin?: boolean;
  /** Needs the per-user export permission. */
  exportPermission?: boolean;
  /** Needs a recent password confirmation (FR-003: bill approval). */
  recentAuth?: boolean;
  status?: number;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

export function sessionCookie(token: string | null): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return token
    ? `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`
    : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function errorResponse(e: AppError, requestId: string): Response {
  return Response.json(
    { error: { code: e.code, message: e.message, details: e.details ?? {}, requestId } },
    { status: e.status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

/** CSRF defence for cookie-authenticated writes: a browser write must come from this origin. */
function checkOrigin(req: Request, url: URL) {
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
    let ok = false;
    try {
      const o = new URL(origin);
      ok = o.host === host || (!!process.env.APP_URL && o.origin === new URL(process.env.APP_URL).origin);
    } catch { /* malformed origin */ }
    if (!ok) throw forbidden("CROSS_ORIGIN", "Cross-origin requests are not allowed.");
  } else if (req.headers.get("sec-fetch-site") === "cross-site") {
    throw forbidden("CROSS_ORIGIN", "Cross-origin requests are not allowed.");
  }
}

// Small in-process limiter for sensitive endpoints. Per instance only; put a shared limiter in front for multi-instance hosting.
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    return;
  }
  if (++b.count > limit) throw new AppError(429, "RATE_LIMITED", "Too many requests. Wait a moment and try again.");
}

export function toAppError(e: unknown, requestId: string): AppError {
  if (e instanceof AppError) return e;
  const pg = fromPgError(e);
  if (pg) return pg;
  if ((e as any)?.code === "P0001") return new AppError(409, "IMMUTABLE_RECORD", String((e as any).message));
  if ((e as any)?.code === "22P02") return new AppError(400, "MALFORMED_INPUT", "A value has the wrong format.");
  console.error(JSON.stringify({ level: "error", requestId, message: (e as any)?.message ?? String(e), stack: (e as any)?.stack }));
  return new AppError(500, "INTERNAL_ERROR", "Something went wrong. Quote the request ID if you report this.");
}

/**
 * Wraps a route handler with: request ID, session + role checks on every request, origin check on writes,
 * JSON body parsing, idempotency keys and the standard error envelope (SRS section 12).
 */
export function route(opts: RouteOptions, handler: (a: RouteArgs) => Promise<unknown>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const url = new URL(req.url);
    const write = req.method !== "GET" && req.method !== "HEAD";
    let idem: { actorId: string; operation: string; key: string } | null = null;
    try {
      if (write) checkOrigin(req, url);
      let actor = null as Actor | null;
      if (!opts.public) {
        actor = await getActorFromToken(readCookie(req, SESSION_COOKIE), requestId);
        if (!actor) throw unauthenticated();
        if (opts.admin && actor.role !== "ADMIN") throw forbidden();
        if (opts.exportPermission && actor.role !== "ADMIN" && !actor.canExport)
          throw forbidden("EXPORT_NOT_ALLOWED", "You do not have permission to export.");
        if (opts.recentAuth) requireRecentAuth(actor);
      }
      let body: any = {};
      let rawBody = "";
      if (write) {
        rawBody = await req.text();
        if (rawBody) {
          try { body = JSON.parse(rawBody); } catch { throw new AppError(400, "MALFORMED_JSON", "Request body is not valid JSON."); }
          if (body === null || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "MALFORMED_JSON", "Request body must be a JSON object.");
        }
      }
      const params = (await ctx?.params) ?? {};

      const key = write && actor ? req.headers.get("idempotency-key") : null;
      if (key && actor) {
        if (key.length > 200) throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency key is too long.");
        const operation = `${req.method} ${url.pathname}`;
        const hash = crypto.createHash("sha256").update(rawBody).digest("hex");
        const inserted = await one(
          db,
          `insert into idempotency_requests (actor_id, operation, key, request_hash, status) values ($1, $2, $3, $4, 'IN_PROGRESS')
           on conflict do nothing returning key`,
          [actor.id, operation, key, hash],
        );
        if (!inserted) {
          const prior = await one(db, "select * from idempotency_requests where actor_id = $1 and operation = $2 and key = $3", [actor.id, operation, key]);
          if (prior && prior.request_hash !== hash)
            throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used with a different request.");
          if (prior?.status === "COMPLETED")
            return Response.json(prior.response_body, { status: prior.response_status, headers: { "x-request-id": requestId, "x-idempotent-replay": "true", "cache-control": "no-store" } });
          throw new AppError(409, "REQUEST_IN_PROGRESS", "The original request is still being processed.");
        }
        idem = { actorId: actor.id, operation, key };
      }

      const result = await handler({ req, url, actor: actor as Actor, params, body, requestId });
      if (result instanceof Response) {
        if (idem) await db.query("delete from idempotency_requests where actor_id = $1 and operation = $2 and key = $3", [idem.actorId, idem.operation, idem.key]);
        result.headers.set("x-request-id", requestId);
        return result;
      }
      const payload = { data: result ?? null, requestId };
      const status = opts.status ?? 200;
      if (idem)
        await db.query(
          "update idempotency_requests set status = 'COMPLETED', response_status = $4, response_body = $5 where actor_id = $1 and operation = $2 and key = $3",
          [idem.actorId, idem.operation, idem.key, status, JSON.stringify(payload)],
        );
      return Response.json(payload, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
    } catch (e) {
      // Only successful results are replayed; a failed attempt frees its key so the user can fix and retry.
      if (idem) {
        try { await db.query("delete from idempotency_requests where actor_id = $1 and operation = $2 and key = $3", [idem.actorId, idem.operation, idem.key]); } catch { /* ignore */ }
      }
      return errorResponse(toAppError(e, requestId), requestId);
    }
  };
}

export function pageParams(url: URL) {
  return {
    page: Number(url.searchParams.get("page") ?? 1) || 1,
    pageSize: Number(url.searchParams.get("pageSize") ?? 50) || 50,
  };
}
export const sp = (url: URL, k: string) => url.searchParams.get(k) || undefined;

export function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "_")}"`,
      "cache-control": "no-store",
    },
  });
}
