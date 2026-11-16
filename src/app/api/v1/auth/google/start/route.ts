import crypto from "node:crypto";
import { buildAuthUrl, googleEnabled } from "@/server/google";
import { clientIp, rateLimit } from "@/lib/http";

export const dynamic = "force-dynamic";
const GOOGLE_STATE_COOKIE = "dm_google";

/** Only same-site relative paths are accepted as a return target. */
function safeNext(next: string | null): string {
  return next && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : "/";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!googleEnabled()) return Response.redirect(new URL("/login?error=google_off", url), 302);
  try { rateLimit(`google:${clientIp(req) ?? "unknown"}`, 30, 60_000); } catch { return Response.redirect(new URL("/login?error=rate", url), 302); }
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const value = Buffer.from(JSON.stringify({ state, nonce, next: safeNext(url.searchParams.get("next")) })).toString("base64url");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return new Response(null, {
    status: 302,
    headers: {
      location: buildAuthUrl(state, nonce),
      // Lax so the cookie comes back on Google's top-level redirect; short lived and single use.
      "set-cookie": `${GOOGLE_STATE_COOKIE}=${value}; Path=/api/v1/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
      "cache-control": "no-store",
    },
  });
}
