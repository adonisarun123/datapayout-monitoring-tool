import crypto from "node:crypto";
import { promisify } from "node:util";
import { db, one, q, tx, type Db } from "@/lib/db";
import { AppError, conflict, forbidden, invalid, notFound, unauthenticated } from "@/lib/errors";
import { audit, type Actor } from "./audit";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

export const SESSION_COOKIE = "dm_session";
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const INVITE_HOURS = 72;
const RESET_HOURS = 1;
const MAX_FAILED_LOGINS = 5;
const LOCK_WINDOW_MINUTES = 15;

export const sessionIdleHours = () => Number(process.env.SESSION_IDLE_HOURS ?? 8);
export const reauthMinutes = () => Number(process.env.REAUTH_MINUTES ?? 15);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

export function validatePasswordStrength(password: unknown): string {
  if (typeof password !== "string" || password.length < 12)
    throw invalid("WEAK_PASSWORD", "Password must be at least 12 characters.");
  if (password.length > 200) throw invalid("WEAK_PASSWORD", "Password is too long.");
  return password;
}

// ------------------------------------------------------------------ sessions

export async function login(
  email: string,
  password: string,
  meta: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<{ token: string; user: Actor }> {
  const normalized = normalizeEmail(email ?? "");
  const failed = await one<{ n: string }>(
    db,
    `select count(*) as n from login_attempts
      where email_normalized = $1 and not succeeded and attempted_at > now() - ($2 || ' minutes')::interval`,
    [normalized, String(LOCK_WINDOW_MINUTES)],
  );
  if (Number(failed?.n ?? 0) >= MAX_FAILED_LOGINS)
    throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many failed sign-in attempts. Try again in 15 minutes.");

  const user = await one(db, "select * from users where email_normalized = $1", [normalized]);
  const ok = (await verifyPassword(password ?? "", user?.password_hash ?? null)) && user?.active === true;
  await db.query("insert into login_attempts (email_normalized, ip, succeeded) values ($1, $2, $3)", [
    normalized, meta.ip ?? null, ok,
  ]);
  if (!ok) {
    await audit(db, user ? { id: user.id, requestId: meta.requestId } : null, "LOGIN_FAILED", "user", user?.id ?? null, {
      after: { email: normalized },
    });
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  const token = newToken();
  const session = await one(
    db,
    "insert into sessions (user_id, token_hash, ip, user_agent) values ($1, $2, $3, $4) returning id, authenticated_at",
    [user.id, sha256(token), meta.ip ?? null, meta.userAgent ?? null],
  );
  await audit(db, { id: user.id, requestId: meta.requestId }, "LOGIN", "user", user.id);
  return { token, user: toActor(user, session, meta.requestId) };
}

function toActor(user: any, session: any, requestId?: string): Actor {
  return {
    id: user.id, role: user.role, name: user.name, email: user.email, canExport: user.can_export,
    requestId, sessionId: session?.id, authenticatedAt: session?.authenticated_at,
  };
}

/** Resolves a session token to an actor. Checked on every request: inactive users and idle sessions are refused. */
export async function getActorFromToken(token: string | undefined | null, requestId?: string): Promise<Actor | null> {
  if (!token) return null;
  const row = await one(
    db,
    `update sessions s set last_seen_at = now()
       from users u
      where s.token_hash = $1 and u.id = s.user_id and s.revoked_at is null and u.active
        and s.last_seen_at > now() - ($2 || ' hours')::interval
      returning s.id as session_id, s.authenticated_at, u.*`,
    [sha256(token), String(sessionIdleHours())],
  );
  if (!row) return null;
  return toActor(row, { id: row.session_id, authenticated_at: row.authenticated_at }, requestId);
}

export async function logout(token: string | undefined | null): Promise<void> {
  if (token) await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
}

/** FR-003: confirm the password again before a sensitive action such as bill approval. */
export async function reauthenticate(actor: Actor, password: string): Promise<void> {
  const user = await one(db, "select password_hash from users where id = $1", [actor.id]);
  if (!(await verifyPassword(password ?? "", user?.password_hash ?? null)))
    throw new AppError(401, "INVALID_CREDENTIALS", "Password is incorrect.");
  await db.query("update sessions set authenticated_at = now() where id = $1", [actor.sessionId]);
}

export function requireRecentAuth(actor: Actor): void {
  const at = actor.authenticatedAt ? new Date(actor.authenticatedAt).getTime() : 0;
  if (Date.now() - at > reauthMinutes() * 60_000)
    throw forbidden("REAUTH_REQUIRED", "Confirm your password to continue.");
}

// ------------------------------------------------------------------ users

const USER_COLS = "id, email, name, role, active, can_export, created_at, updated_at, version, (password_hash is not null) as has_password";

export async function listUsers() {
  return q(db, `select ${USER_COLS} from users order by name`);
}

async function issueToken(d: Db, userId: string, kind: "INVITE" | "RESET", createdBy: string | null): Promise<string> {
  await d.query("update auth_tokens set used_at = now() where user_id = $1 and used_at is null", [userId]);
  const token = newToken();
  await d.query(
    `insert into auth_tokens (user_id, kind, token_hash, expires_at, created_by)
     values ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)`,
    [userId, kind, sha256(token), String(kind === "INVITE" ? INVITE_HOURS : RESET_HOURS), createdBy],
  );
  return token;
}

export function tokenUrl(kind: "INVITE" | "RESET", token: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/${kind === "INVITE" ? "invite" : "reset"}/${token}`;
}

export async function createUser(
  actor: Pick<Actor, "id" | "requestId"> | null,
  input: { email: string; name: string; role: "ADMIN" | "INTERNAL_USER"; canExport?: boolean },
) {
  const email = (input.email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("INVALID_EMAIL", "Enter a valid email address.");
  if (!input.name?.trim()) throw invalid("NAME_REQUIRED", "Name is required.");
  if (input.role !== "ADMIN" && input.role !== "INTERNAL_USER") throw invalid("INVALID_ROLE", "Role is invalid.");
  return tx(async (d) => {
    const user = await one(
      d,
      `insert into users (email, email_normalized, name, role, can_export, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $6) returning ${USER_COLS}`,
      [email, normalizeEmail(email), input.name.trim(), input.role, input.canExport ?? true, actor?.id ?? null],
    );
    const token = await issueToken(d, user.id, "INVITE", actor?.id ?? null);
    await audit(d, actor, "USER_CREATED", "user", user.id, { after: user });
    return { user, inviteUrl: tokenUrl("INVITE", token) };
  });
}

export async function updateUser(
  actor: Actor,
  id: string,
  input: { name?: string; role?: "ADMIN" | "INTERNAL_USER"; active?: boolean; canExport?: boolean; version: number },
) {
  return tx(async (d) => {
    const before = await one(d, `select ${USER_COLS} from users where id = $1 for update`, [id]);
    if (!before) throw notFound("User");
    if (before.version !== input.version) throw conflict("STALE_VERSION", "This user was changed by someone else. Refresh and try again.");
    const role = input.role ?? before.role;
    const active = input.active ?? before.active;
    if (before.role === "ADMIN" && before.active && (role !== "ADMIN" || !active)) {
      // Lock the admin set so two concurrent demotions cannot remove the last admin.
      const admins = await q(d, "select id from users where role = 'ADMIN' and active for update");
      if (admins.length <= 1) throw conflict("LAST_ADMIN", "At least one active admin must remain.");
    }
    const after = await one(
      d,
      `update users set name = $2, role = $3, active = $4, can_export = $5, updated_at = now(), updated_by = $6, version = version + 1
        where id = $1 returning ${USER_COLS}`,
      [id, input.name?.trim() || before.name, role, active, input.canExport ?? before.can_export, actor.id],
    );
    if (!active) await d.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [id]);
    await audit(d, actor, "USER_UPDATED", "user", id, { before, after });
    return after;
  });
}

/** Admin issues a fresh single-use link: an invite if no password is set yet, otherwise a reset. */
export async function issueAccessLink(actor: Actor, userId: string) {
  return tx(async (d) => {
    const user = await one(d, "select id, active, password_hash from users where id = $1", [userId]);
    if (!user) throw notFound("User");
    if (!user.active) throw conflict("USER_INACTIVE", "Activate the user before issuing a link.");
    const kind = user.password_hash ? "RESET" : "INVITE";
    const token = await issueToken(d, userId, kind, actor.id);
    await audit(d, actor, kind === "RESET" ? "PASSWORD_RESET_ISSUED" : "INVITE_REISSUED", "user", userId);
    return { kind, url: tokenUrl(kind, token), expiresInHours: kind === "INVITE" ? INVITE_HOURS : RESET_HOURS };
  });
}

export async function describeToken(token: string) {
  const row = await one(
    db,
    `select t.kind, u.email, u.name from auth_tokens t join users u on u.id = t.user_id
      where t.token_hash = $1 and t.used_at is null and t.expires_at > now() and u.active`,
    [sha256(token ?? "")],
  );
  return row as { kind: "INVITE" | "RESET"; email: string; name: string } | null;
}

/** Consumes an invite/reset token (single use) and sets the password. */
export async function consumeToken(token: string, password: string, requestId?: string): Promise<void> {
  validatePasswordStrength(password);
  const hash = await hashPassword(password);
  await tx(async (d) => {
    const row = await one(
      d,
      `update auth_tokens t set used_at = now() from users u
        where t.token_hash = $1 and t.used_at is null and t.expires_at > now() and u.id = t.user_id and u.active
        returning t.user_id, t.kind`,
      [sha256(token ?? "")],
    );
    if (!row) throw invalid("TOKEN_INVALID", "This link is invalid, already used or expired. Ask an admin for a new one.");
    await d.query("update users set password_hash = $2, updated_at = now(), version = version + 1 where id = $1", [row.user_id, hash]);
    await d.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [row.user_id]);
    await audit(d, { id: row.user_id, requestId }, row.kind === "INVITE" ? "INVITE_ACCEPTED" : "PASSWORD_RESET", "user", row.user_id);
  });
}

export { unauthenticated };
