import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError } from "@/lib/errors";
import { allowedEmailDomains, emailDomainAllowed } from "./auth";

// Google OpenID Connect, authorization-code flow.
// https://developers.google.com/identity/openid-connect/openid-connect
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const googleEnabled = () => !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

/** With Google sign-in configured, passwords and invite links are switched off unless PASSWORD_LOGIN=enabled. */
export const passwordLoginEnabled = () => !googleEnabled() || process.env.PASSWORD_LOGIN === "enabled";

export function redirectUri(): string {
  return `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/v1/auth/google/callback`;
}

export function buildAuthUrl(state: string, nonce: string): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("prompt", "select_account");
  // `hd` only pre-selects the Workspace domain on Google's screen. The real check is on the ID token below.
  const domains = allowedEmailDomains();
  if (domains.length === 1) u.searchParams.set("hd", domains[0]);
  return u.toString();
}

export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(), grant_type: "authorization_code",
    }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || typeof json?.id_token !== "string")
    throw new AppError(401, "GOOGLE_SIGN_IN_FAILED", "Google sign-in could not be completed. Try again.");
  return json.id_token;
}

let remoteKeys: JWTVerifyGetKey | null = null;

export interface GoogleIdentity { sub: string; email: string; name: string | null; hd: string | null }

/**
 * Verifies a Google ID token: signature against Google's published keys, issuer, audience, expiry, nonce,
 * a verified email, and (when ALLOWED_EMAIL_DOMAINS is set) that the account belongs to one of those
 * Google Workspace domains, using the `hd` claim, not just the spelling of the email address.
 */
export async function verifyIdToken(idToken: string, expectedNonce: string, keys?: JWTVerifyGetKey): Promise<GoogleIdentity> {
  const fail = (message: string) => new AppError(403, "GOOGLE_ACCOUNT_REJECTED", message);
  let payload: any;
  try {
    remoteKeys ??= createRemoteJWKSet(new URL(JWKS_URI));
    ({ payload } = await jwtVerify(idToken, keys ?? remoteKeys, {
      issuer: ISSUERS, audience: process.env.GOOGLE_CLIENT_ID!, algorithms: ["RS256"], clockTolerance: 30,
    }));
  } catch {
    throw new AppError(401, "GOOGLE_SIGN_IN_FAILED", "Google sign-in could not be verified. Try again.");
  }
  const nonceOk = typeof payload.nonce === "string" && payload.nonce.length === expectedNonce.length &&
    crypto.timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(expectedNonce));
  if (!nonceOk) throw new AppError(401, "GOOGLE_SIGN_IN_FAILED", "Google sign-in could not be verified. Try again.");
  if (typeof payload.email !== "string" || payload.email_verified !== true) throw fail("Your Google account has no verified email address.");
  const domains = allowedEmailDomains();
  if (domains.length) {
    const hd = typeof payload.hd === "string" ? payload.hd.toLowerCase() : null;
    if (!hd || !domains.includes(hd) || !emailDomainAllowed(payload.email))
      throw fail(`Sign in with your ${domains.map((d) => "@" + d).join(" or ")} Google Workspace account.`);
  }
  return { sub: String(payload.sub), email: payload.email, name: typeof payload.name === "string" ? payload.name : null, hd: payload.hd ?? null };
}
