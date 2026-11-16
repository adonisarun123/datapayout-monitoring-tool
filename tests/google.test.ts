import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { db, one } from "@/lib/db";
import { consumeToken, createUser, issueAccessLink, login, loginWithGoogle, updateUser } from "@/server/auth";
import { buildAuthUrl, passwordLoginEnabled, verifyIdToken } from "@/server/google";
import * as startRoute from "@/app/api/v1/auth/google/start/route";
import * as callbackRoute from "@/app/api/v1/auth/google/callback/route";
import * as meRoute from "@/app/api/v1/auth/me/route";
import { call, expectError, makeWorld, PASSWORD, type World } from "./helpers";

let w: World;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
const CLIENT = "test-client.apps.googleusercontent.com";

async function idToken(claims: Record<string, unknown>, opts: { key?: CryptoKey; aud?: string; iss?: string; exp?: string } = {}) {
  return new SignJWT({ email_verified: true, nonce: "nonce-123", hd: "vahan.co", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(opts.iss ?? "https://accounts.google.com").setAudience(opts.aud ?? CLIENT)
    .setSubject("google-sub-1").setIssuedAt().setExpirationTime(opts.exp ?? "5m").sign(opts.key ?? (keys.privateKey as CryptoKey));
}

beforeEach(async () => {
  w = await makeWorld();
  keys = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" }] });
  process.env.GOOGLE_CLIENT_ID = CLIENT;
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.ALLOWED_EMAIL_DOMAINS = "vahan.co";
});
afterEach(() => {
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAIL_DOMAINS", "PASSWORD_LOGIN"]) delete process.env[k];
});

describe("Google ID token verification", () => {
  it("accepts a correctly signed token for a verified vahan.co Workspace account", async () => {
    const id = await verifyIdToken(await idToken({ email: "priya@vahan.co", name: "Priya" }), "nonce-123", jwks);
    expect(id).toMatchObject({ email: "priya@vahan.co", hd: "vahan.co", sub: "google-sub-1" });
  });

  it("rejects forged, misdirected, expired or replayed tokens", async () => {
    const other = await generateKeyPair("RS256");
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co" }, { key: other.privateKey as CryptoKey }), "nonce-123", jwks), "GOOGLE_SIGN_IN_FAILED");
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co" }, { aud: "someone-else" }), "nonce-123", jwks), "GOOGLE_SIGN_IN_FAILED");
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co" }, { iss: "https://evil.example" }), "nonce-123", jwks), "GOOGLE_SIGN_IN_FAILED");
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co" }, { exp: "-10m" }), "nonce-123", jwks), "GOOGLE_SIGN_IN_FAILED");
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co" }), "a-different-nonce", jwks), "GOOGLE_SIGN_IN_FAILED");
    await expectError(verifyIdToken("not.a.jwt", "nonce-123", jwks), "GOOGLE_SIGN_IN_FAILED");
  });

  it("rejects accounts outside the Workspace, even if the email address looks right", async () => {
    // A personal Google account has no hd claim; a different Workspace has a different one.
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co", hd: undefined }), "nonce-123", jwks), "GOOGLE_ACCOUNT_REJECTED");
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co", hd: "other.com" }), "nonce-123", jwks), "GOOGLE_ACCOUNT_REJECTED");
    await expectError(verifyIdToken(await idToken({ email: "pat@gmail.com", hd: "vahan.co" }), "nonce-123", jwks), "GOOGLE_ACCOUNT_REJECTED");
    await expectError(verifyIdToken(await idToken({ email: "priya@vahan.co", email_verified: false }), "nonce-123", jwks), "GOOGLE_ACCOUNT_REJECTED");
  });
});

describe("Google sign-in", () => {
  it("signs in only people an admin has added, and never creates accounts by itself", async () => {
    await expectError(loginWithGoogle({ sub: "s", email: "stranger@vahan.co", name: null, hd: "vahan.co" }, {}), "NO_ACCOUNT");
    expect((await one(db, "select count(*)::int as n from users where email_normalized = 'stranger@vahan.co'")).n).toBe(0);
    const { user, inviteUrl } = await createUser(w.admin, { email: "Priya@vahan.co", name: "Priya", role: "INTERNAL_USER" });
    expect(inviteUrl).toBeNull(); // no link is issued: there is nothing to hand to the wrong person
    const { token } = await loginWithGoogle({ sub: "s", email: "priya@VAHAN.co", name: "Priya", hd: "vahan.co" }, {});
    const me = await call(meRoute.GET, { method: "GET", token });
    expect(me.json.data).toMatchObject({ id: user.id, role: "INTERNAL_USER" });
    const u = await one(db, "select version from users where id = $1", [user.id]);
    await updateUser(w.admin, user.id, { active: false, version: u.version });
    await expectError(loginWithGoogle({ sub: "s", email: "priya@vahan.co", name: null, hd: "vahan.co" }, {}), "NO_ACCOUNT");
    expect((await call(meRoute.GET, { method: "GET", token })).status).toBe(401);
  });

  it("switches passwords and links off once Google is configured, unless explicitly kept", async () => {
    expect(passwordLoginEnabled()).toBe(false);
    await expectError(login(w.admin.email, PASSWORD, {}), "PASSWORD_LOGIN_DISABLED");
    await expectError(consumeToken("anything", "a-long-enough-password"), "PASSWORD_LOGIN_DISABLED");
    await expectError(issueAccessLink(w.admin, w.user.id), "PASSWORD_LOGIN_DISABLED");
    process.env.PASSWORD_LOGIN = "enabled";
    process.env.ALLOWED_EMAIL_DOMAINS = "";
    expect((await login(w.admin.email, PASSWORD, {})).user.id).toBe(w.admin.id);
  });

  it("start sends the browser to Google with state, nonce and the domain hint; callback refuses a mismatched state", async () => {
    const res = await startRoute.GET(new Request("http://localhost:3000/api/v1/auth/google/start?next=https://evil.example/x"));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("client_id")).toBe(CLIENT);
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/v1/auth/google/callback");
    expect(to.searchParams.get("hd")).toBe("vahan.co");
    expect(to.searchParams.get("scope")).toBe("openid email profile");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/dm_google=.+HttpOnly; SameSite=Lax/);
    const saved = JSON.parse(Buffer.from(cookie.split(";")[0].split("=")[1], "base64url").toString());
    expect(saved.state).toBe(to.searchParams.get("state"));
    expect(saved.nonce).toBe(to.searchParams.get("nonce"));
    expect(saved.next).toBe("/"); // an off-site return target is dropped
    expect(buildAuthUrl("s", "n")).toContain("prompt=select_account");

    const bad = await callbackRoute.GET(new Request("http://localhost:3000/api/v1/auth/google/callback?state=forged&code=abc", { headers: { cookie: cookie.split(";")[0] } }));
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe("http://localhost:3000/login?error=state");
    const none = await callbackRoute.GET(new Request("http://localhost:3000/api/v1/auth/google/callback?state=x&code=abc"));
    expect(none.headers.get("location")).toBe("http://localhost:3000/login?error=state");
    expect(none.headers.get("set-cookie")).not.toMatch(/dm_session=[^;]/);
  });
});
