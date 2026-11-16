import { db, one } from "@/lib/db";
import { addDays, todayIST } from "@/lib/dates";
import type { Actor } from "@/server/audit";
import { hashPassword, login } from "@/server/auth";
import { createAssignment, createDevice, createPoc, createRule } from "@/server/masters";
import { submitEntry } from "@/server/entries";

export const PASSWORD = "correct-horse-battery";
export const today = todayIST();
export const daysAgo = (n: number) => addDays(today, -n);

export async function resetDb() {
  await db.query(`truncate idempotency_requests, audit_events, payments, bill_decisions, bill_lines, bills, data_entry_versions,
    data_entries, payout_rules, device_poc_assignments, devices, pocs, device_types, login_attempts, sessions, auth_tokens, settings, users cascade`);
  await db.query(`insert into settings (key, value) values ('default_currency', '"INR"'), ('hours_warning_threshold', '"24"'),
    ('organization_name', '"Test Org"'), ('default_payout_percentage', '"70"'), ('require_separate_approver', 'false')`);
  await db.query("alter sequence bill_number_seq restart with 1");
}

let n = 0;
const uniq = () => `${Date.now().toString(36)}${++n}`;

export async function makeUser(role: "ADMIN" | "INTERNAL_USER", name = role === "ADMIN" ? "Asha Admin" : "Irfan Internal") {
  const email = `${uniq()}@example.test`;
  const u = await one(
    db,
    "insert into users (email, email_normalized, name, role, password_hash) values ($1, $1, $2, $3, $4) returning *",
    [email, name, role, await hashPassword(PASSWORD)],
  );
  const actor: Actor = { id: u.id, role, name, email, canExport: true, requestId: "test", authenticatedAt: new Date() };
  return actor;
}

export async function sessionFor(actor: Actor) {
  return (await login(actor.email, PASSWORD, {})).token;
}

export interface World {
  admin: Actor; admin2: Actor; user: Actor; typeId: string; poc: any; poc2: any; device: any; device2: any;
}

/** One device type, two POCs, two devices. Device 1: POC 1, 70% at INR 100 from 400 days ago. */
export async function makeWorld(): Promise<World> {
  await resetDb();
  const admin = await makeUser("ADMIN");
  const admin2 = await makeUser("ADMIN", "Bala Admin");
  const user = await makeUser("INTERNAL_USER");
  const type = await one(db, "insert into device_types (name, name_normalized) values ('Recorder', 'recorder') returning id");
  const poc = await createPoc(admin, { name: "Meera Fictional" });
  const poc2 = await createPoc(admin, { name: "Dev Fictional" });
  const start = daysAgo(400);
  const retro = { reason: "initial setup", confirmRetroactive: true };
  const device = await createDevice(admin, { code: "DEV-001", name: "Unit 1", typeId: type.id, commissionedOn: start });
  const device2 = await createDevice(admin, { code: "DEV-002", name: "Unit 2", typeId: type.id, commissionedOn: start });
  for (const [d, p] of [[device, poc], [device2, poc2]] as const) {
    await createAssignment(admin, d.id, { pocId: p.id, validFrom: start, ...retro });
    await createRule(admin, d.id, { rate: "100", currency: "INR", percentage: "70", validFrom: start, ...retro });
  }
  return { admin, admin2, user, typeId: type.id, poc, poc2, device, device2 };
}

let refNo = 0;
export async function entry(w: World, over: Partial<{ deviceId: string; activityDate: string; hours: string; reference: string; by: Actor; ack: string[] }> = {}) {
  return submitEntry(over.by ?? w.user, {
    deviceId: over.deviceId ?? w.device.id,
    activityDate: over.activityDate ?? daysAgo(5),
    hours: over.hours ?? "10",
    reference: over.reference ?? `BATCH-${++refNo}`,
    acknowledgedWarnings: over.ack ?? ["HOURS_ABOVE_THRESHOLD", "POSSIBLE_DUPLICATE", "ZERO_VALUE_TERMS"],
  });
}

/** Calls a route handler the way Next.js would, with a session cookie and same-origin headers. */
export async function call(
  handler: (req: Request, ctx: any) => Promise<Response>,
  opts: { method?: string; path?: string; body?: unknown; token?: string | null; params?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { host: "localhost:3000", ...(opts.headers ?? {}) };
  if (method !== "GET") { headers.origin ??= "http://localhost:3000"; headers["content-type"] = "application/json"; }
  if (opts.token) headers.cookie = `dm_session=${opts.token}`;
  const res = await handler(
    new Request(`http://localhost:3000${opts.path ?? "/api/v1/test"}`, {
      method, headers, body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
    }),
    { params: Promise.resolve(opts.params ?? {}) },
  );
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

export async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    if (e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
