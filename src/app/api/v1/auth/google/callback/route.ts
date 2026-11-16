import crypto from "node:crypto";
import { clientIp, readCookie, sessionCookie, toAppError } from "@/lib/http";
import { loginWithGoogle, logout, SESSION_COOKIE } from "@/server/auth";
import { exchangeCode, googleEnabled, verifyIdToken } from "@/server/google";

export const dynamic = "force-dynamic";
const GOOGLE_STATE_COOKIE = "dm_google";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const clearState = `${GOOGLE_STATE_COOKIE}=; Path=/api/v1/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const back = (code: string) => {
    const headers = new Headers({ location: new URL(`/login?error=${code}`, url).toString(), "cache-control": "no-store" });
    headers.append("set-cookie", clearState);
    return new Response(null, { status: 302, headers });
  };
  if (!googleEnabled()) return back("google_off");
  try {
    let saved: { state: string; nonce: string; next: string };
    try { saved = JSON.parse(Buffer.from(readCookie(req, GOOGLE_STATE_COOKIE) ?? "", "base64url").toString()); } catch { return back("state"); }
    const state = url.searchParams.get("state") ?? "";
    // The state must match the one issued to this browser, or the response did not come from our own request.
    if (!saved?.state || state.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) return back("state");
    const code = url.searchParams.get("code");
    if (!code) return back(url.searchParams.get("error") === "access_denied" ? "cancelled" : "google");

    const identity = await verifyIdToken(await exchangeCode(code), saved.nonce);
    const { token } = await loginWithGoogle(identity, { ip: clientIp(req), userAgent: req.headers.get("user-agent"), requestId });
    await logout(readCookie(req, SESSION_COOKIE)); // a fresh sign-in replaces any earlier session in this browser
    const headers = new Headers({ location: new URL(saved.next || "/", url).toString(), "cache-control": "no-store" });
    headers.append("set-cookie", sessionCookie(token));
    headers.append("set-cookie", clearState);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    const err = toAppError(e, requestId);
    return back(err.code === "NO_ACCOUNT" ? "no_account" : err.code === "GOOGLE_ACCOUNT_REJECTED" ? "domain" : "google");
  }
}
