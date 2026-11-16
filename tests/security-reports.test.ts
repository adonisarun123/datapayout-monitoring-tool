import { beforeEach, describe, expect, it } from "vitest";
import { db, one, q } from "@/lib/db";
import { consumeToken, createUser, describeToken, issueAccessLink, login, updateUser } from "@/server/auth";
import { approveBill, createBill, getBill, submitBill } from "@/server/bills";
import { billCsv, billPdf, reportCsv } from "@/server/exports";
import { commitDeviceImport, createDeviceType, listDeviceTypes, previewDeviceImport, updateDevice, updateDeviceType } from "@/server/masters";
import { recordPayment } from "@/server/payments";
import { dashboard, listAudit, runReport } from "@/server/reports";
import { csvCell, parseCsv } from "@/lib/csv";
import * as meRoute from "@/app/api/v1/auth/me/route";
import * as loginRoute from "@/app/api/v1/auth/login/route";
import * as entriesRoute from "@/app/api/v1/entries/route";
import * as usersRoute from "@/app/api/v1/users/route";
import * as auditRoute from "@/app/api/v1/audit-events/route";
import * as exportRoute from "@/app/api/v1/reports/[report]/export/route";
import { call, daysAgo, entry, expectError, makeWorld, PASSWORD, sessionFor, today, type World } from "./helpers";

let w: World;
beforeEach(async () => { w = await makeWorld(); });

describe("access control", () => {
  it("AT-21: a deactivated user is refused on the next request, even with a session issued earlier", async () => {
    const token = await sessionFor(w.user);
    expect((await call(meRoute.GET, { method: "GET", token })).status).toBe(200);
    const u = await one(db, "select version from users where id = $1", [w.user.id]);
    await updateUser(w.admin, w.user.id, { active: false, version: u.version });
    expect((await call(meRoute.GET, { method: "GET", token })).status).toBe(401);
    expect((await call(entriesRoute.GET, { method: "GET", token })).status).toBe(401);
    expect((await call(entriesRoute.POST, { token, body: {} })).status).toBe(401);
    await expectError(login(w.user.email, PASSWORD, {}), "INVALID_CREDENTIALS");
    // History still names the deactivated user.
    expect((await one(db, "select name from users where id = $1", [w.user.id])).name).toBe("Irfan Internal");
  });

  it("sessions expire after 8 idle hours and every protected route needs one", async () => {
    const token = await sessionFor(w.user);
    await db.query("update sessions set last_seen_at = now() - interval '9 hours'");
    expect((await call(meRoute.GET, { method: "GET", token })).status).toBe(401);
    expect((await call(meRoute.GET, { method: "GET" })).status).toBe(401);
    expect((await call(meRoute.GET, { method: "GET", token: "not-a-real-token" })).status).toBe(401);
  });

  it("admin-only endpoints refuse internal users; the role comes from the session, never the request", async () => {
    const token = await sessionFor(w.user);
    expect((await call(usersRoute.GET, { method: "GET", token })).status).toBe(403);
    expect((await call(auditRoute.GET, { method: "GET", token })).status).toBe(403);
    const res = await call(usersRoute.POST, { token, body: { email: "x@example.test", name: "X", role: "ADMIN", actorId: w.admin.id } });
    expect(res.status).toBe(403);
  });

  it("cross-origin writes are refused (CSRF)", async () => {
    const token = await sessionFor(w.user);
    const res = await call(entriesRoute.POST, { token, body: {}, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CROSS_ORIGIN");
  });

  it("login sets an HTTP-only cookie, never returns the password hash, and locks after repeated failures", async () => {
    const ok = await call(loginRoute.POST, { body: { email: w.admin.email.toUpperCase(), password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/dm_session=.+HttpOnly; SameSite=Lax/);
    expect(ok.text).not.toMatch(/scrypt|password/i);
    for (let i = 0; i < 5; i++) expect((await call(loginRoute.POST, { body: { email: w.user.email, password: "wrong-wrong-wrong" } })).status).toBe(401);
    const locked = await call(loginRoute.POST, { body: { email: w.user.email, password: PASSWORD } });
    expect(locked.status).toBe(429);
  });

  it("invites are single-use and time-limited; no plaintext password is stored", async () => {
    const { user, inviteUrl } = await createUser(w.admin, { email: "New.Person@example.test", name: "New Person", role: "INTERNAL_USER" });
    const token = inviteUrl!.split("/").pop()!;
    expect(await describeToken(token)).toMatchObject({ kind: "INVITE", email: "New.Person@example.test" });
    await expectError(consumeToken(token, "short"), "WEAK_PASSWORD");
    await consumeToken(token, "a-long-enough-password");
    await expectError(consumeToken(token, "a-long-enough-password"), "TOKEN_INVALID");
    const row = await one(db, "select password_hash from users where id = $1", [user.id]);
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain("a-long-enough-password");
    expect((await login("new.person@example.test", "a-long-enough-password", {})).user.id).toBe(user.id);
    // A reset link expires.
    const link = await issueAccessLink(w.admin, user.id);
    expect(link.kind).toBe("RESET");
    await db.query("update auth_tokens set expires_at = now() - interval '1 minute' where used_at is null");
    await expectError(consumeToken(link.url.split("/").pop()!, "another-long-password"), "TOKEN_INVALID");
    await expectError(createUser(w.admin, { email: "new.person@EXAMPLE.test", name: "Dup", role: "INTERNAL_USER" }), "DUPLICATE_EMAIL");
    // Secrets never reach the audit log.
    const leaked = await q(db, "select 1 from audit_events where before_json::text ~* 'scrypt|token_hash' or after_json::text ~* 'scrypt|token_hash'");
    expect(leaked).toHaveLength(0);
  });

  it("at least one active admin always remains", async () => {
    const v = async (id: string) => (await one(db, "select version from users where id = $1", [id])).version;
    await updateUser(w.admin, w.admin2.id, { active: false, version: await v(w.admin2.id) });
    await expectError(updateUser(w.admin, w.admin.id, { active: false, version: await v(w.admin.id) }), "LAST_ADMIN");
    await expectError(updateUser(w.admin, w.admin.id, { role: "INTERNAL_USER", version: await v(w.admin.id) }), "LAST_ADMIN");
  });
});

describe("masters", () => {
  it("three placeholder types are seeded by the migration; types are renamed or deactivated, never deleted", async () => {
    const { migrate } = await import("../scripts/migrate");
    await migrate(process.env.DATABASE_URL!, () => {}); // idempotent
    const t = await createDeviceType(w.admin, { name: "Logger" });
    await expectError(createDeviceType(w.admin, { name: " LOGGER " }), "DUPLICATE_TYPE_NAME");
    const renamed = await updateDeviceType(w.admin, t.id, { name: "Field Logger", active: false, version: t.version });
    expect(renamed).toMatchObject({ name: "Field Logger", active: false, version: 2 });
    await expect(db.query("delete from device_types where id = $1", [w.typeId])).rejects.toMatchObject({ code: "23503" });
    expect((await listDeviceTypes()).find((x) => x.id === w.typeId)).toMatchObject({ device_count: 2, active_device_count: 2 });
  });

  it("CSV import previews per-row errors and commits all or nothing", async () => {
    const bad = "code,name,type,commissioned_on,serial\nDEV-010,Ten,Recorder,2026-01-01,S1\nDEV-001,Dup,Recorder,2026-01-01,S2\nDEV-011,Eleven,Nope,01/02/2026,S1\n";
    const p = await previewDeviceImport(w.admin, bad);
    expect(p.valid).toBe(false);
    expect(p.rows[0].errors).toEqual([]);
    expect(p.rows[1].errors).toEqual(["code already exists"]);
    expect(p.rows[2].errors).toEqual(['unknown device type "Nope"', "commissioned_on must be YYYY-MM-DD", "serial is repeated in this file"]);
    await expectError(commitDeviceImport(w.admin, bad), "IMPORT_HAS_ERRORS");
    expect((await one(db, "select count(*)::int as n from devices")).n).toBe(2);
    const good = "code,name,type,commissioned_on\nDEV-010,Ten,recorder,2026-01-01\nDEV-011,\"Eleven, spare\",Recorder,2026-02-01\n";
    expect(await commitDeviceImport(w.admin, good)).toEqual({ imported: 2 });
    expect((await one(db, "select name from devices where code = 'DEV-011'")).name).toBe("Eleven, spare");
    await expectError(previewDeviceImport(w.user, good), "FORBIDDEN");
  });

  it("a retired device keeps its history but takes no new entries", async () => {
    const e = await entry(w);
    const d = await one(db, "select version from devices where id = $1", [w.device.id]);
    await updateDevice(w.admin, w.device.id, { status: "RETIRED", version: d.version });
    await expectError(entry(w), "DEVICE_NOT_ACTIVE");
    expect((await one(db, "select count(*)::int as n from data_entries where id = $1", [e.id])).n).toBe(1);
    await expectError(updateDevice(w.admin, w.device.id, { status: "ACTIVE", version: d.version }), "STALE_VERSION");
  });
});

describe("reports and exports", () => {
  async function scenario() {
    await entry(w, { hours: "10", activityDate: daysAgo(9) }); // 700.00
    await entry(w, { hours: "0.05", activityDate: daysAgo(8) }); // 3.50
    const voided = await entry(w, { hours: "50", activityDate: daysAgo(7), ack: ["HOURS_ABOVE_THRESHOLD"] });
    const { voidEntry } = await import("@/server/entries");
    await voidEntry(w.admin, voided.id, { expectedVersion: 1, reason: "test data" });
    await entry(w, { deviceId: w.device2.id, hours: "4", activityDate: daysAgo(6) }); // 280.00, POC 2
    let b = (await createBill(w.admin, { pocId: w.poc.id, currency: "INR", dateFrom: daysAgo(30), dateTo: today })).bill;
    b = (await submitBill(w.admin, b.id, { expectedVersion: b.version })).bill;
    b = (await approveBill(w.admin2, b.id, { expectedVersion: b.version })).bill;
    await recordPayment(w.admin, b.id, { paymentDate: today, amount: "203.50", method: "NEFT", reference: "=cmd|' /C calc'!A0" });
    return b;
  }

  it("AT-20: report totals reconcile to the filtered lines, and voided entries are not counted", async () => {
    await scenario();
    const util = await runReport("device-utilization", { dateFrom: daysAgo(30), dateTo: today });
    expect(util.rows.map((r) => [r.device_code, r.hours, r.amount])).toEqual([["DEV-001", "10.0500", "703.50"], ["DEV-002", "4.0000", "280.00"]]);
    expect(util.totals).toEqual([{ currency: "INR", entries: 3, hours: "14.0500", payable_hours: "9.8350", amount: "983.50" }]);
    const detail = await runReport("entry-detail", { dateFrom: daysAgo(30), dateTo: today, pocId: w.poc.id });
    const valid = detail.rows.filter((r) => r.status === "VALID");
    expect(detail.rows).toHaveLength(3);
    expect(valid.reduce((a, r) => a + Number(r.line_amount), 0).toFixed(2)).toBe(detail.totals![0].amount);
    expect(detail.totals![0]).toMatchObject({ entries: 2, amount: "703.50" });
    const narrow = await runReport("device-utilization", { dateFrom: daysAgo(8), dateTo: daysAgo(8) });
    expect(narrow.totals).toEqual([{ currency: "INR", entries: 1, hours: "0.0500", payable_hours: "0.0350", amount: "3.50" }]);
    const stmt = await runReport("poc-statement", {});
    expect(stmt.rows.find((r) => r.poc_name === "Meera Fictional")).toMatchObject({ entry_value: "703.50", unbilled: "0", approved: "703.50", paid: "203.50", outstanding: "500.00" });
    expect(stmt.rows.find((r) => r.poc_name === "Dev Fictional")).toMatchObject({ entry_value: "280.00", unbilled: "280.00", approved: "0" });
    const ledger = await runReport("payment-ledger", {});
    expect(ledger.totals).toEqual([{ currency: "INR", signed_amount: "203.50" }]);
    const d = await dashboard({});
    expect(d.totalHours.hours).toBe("14.0500");
    expect(d.unbilled).toEqual([{ currency: "INR", entries: 1, hours: "4.0000", value: "280.00" }]);
    expect(d.approved[0]).toMatchObject({ value: "703.50", bills: 1 });
    expect(d.payments[0].net).toBe("203.50");
    expect(d.outstanding[0].value).toBe("500.00");
  });

  it("AT-20: mixed currencies are reported separately, never added together", async () => {
    await entry(w, { hours: "10" });
    const { createRule } = await import("@/server/masters");
    await createRule(w.admin, w.device2.id, { rate: "2", currency: "USD", percentage: "50", validFrom: daysAgo(20), reason: "usd", confirmRetroactive: true });
    await entry(w, { deviceId: w.device2.id, hours: "10" });
    const util = await runReport("device-utilization", {});
    expect(util.totals).toEqual([
      { currency: "INR", entries: 1, hours: "10.0000", payable_hours: "7.0000", amount: "700.00" },
      { currency: "USD", entries: 1, hours: "10.0000", payable_hours: "5.0000", amount: "10.00" },
    ]);
    expect((await dashboard({})).hours.map((h) => h.currency)).toEqual(["INR", "USD"]);
  });

  it("AT-20: CSV exports neutralise formula cells and carry filters, timestamp and user", async () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-350.00")).toBe("'-350.00");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    const b = await scenario();
    const csv = await reportCsv(await runReport("payment-ledger", { dateFrom: daysAgo(1) }), w.admin);
    const cells = parseCsv(csv).flat();
    expect(cells).toContain("'=cmd|' /C calc'!A0");
    expect(cells.some((c) => /^[=+@]/.test(c))).toBe(false);
    expect(csv).toMatch(/Generated by,Asha Admin/);
    expect(csv).toMatch(new RegExp(`Filters,dateFrom=${daysAgo(1)}`));
    const detail = await getBill(b.id);
    const billText = await billCsv(detail, w.admin);
    expect(billText).toMatch(/Status,APPROVED/);
    expect(billText).toMatch(/not a tax invoice/);
    expect(billText).toMatch(/Outstanding,500.00/);
    const pdf = await billPdf(detail, w.admin);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("exports respect the per-user export permission and are audited", async () => {
    await scenario();
    const token = await sessionFor(w.user);
    const ok = await call(exportRoute.GET, { method: "GET", token, params: { report: "device-utilization" }, path: "/api/v1/reports/device-utilization/export" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/csv/);
    await db.query("update users set can_export = false where id = $1", [w.user.id]);
    const denied = await call(exportRoute.GET, { method: "GET", token, params: { report: "device-utilization" } });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("EXPORT_NOT_ALLOWED");
    const audit = await listAudit({ action: "REPORT_EXPORTED" });
    expect(audit.total).toBe(1);
    expect(audit.rows[0]).toMatchObject({ actor_name: "Irfan Internal", entity_id: "device-utilization" });
    expect(audit.rows[0].request_id).toBeTruthy();
  });

  it("FR-031: sensitive actions leave audit events with actor, entity, reason and before/after", async () => {
    await scenario();
    const actions = (await q(db, "select distinct action from audit_events")).map((r) => r.action);
    for (const a of ["ASSIGNMENT_CREATED", "PAYOUT_RULE_CREATED", "DEVICE_CREATED", "POC_CREATED", "ENTRY_SUBMITTED", "ENTRY_VOIDED",
      "BILL_CREATED", "BILL_SUBMITTED", "BILL_APPROVED", "PAYMENT_RECORDED"]) expect(actions).toContain(a);
    const approved = await one(db, "select * from audit_events where action = 'BILL_APPROVED'");
    expect(approved).toMatchObject({ actor_id: w.admin2.id, entity_type: "bill" });
    expect(approved.after_json).toMatchObject({ status: "APPROVED", total: "703.50" });
  });
});

describe("email domain restriction (ALLOWED_EMAIL_DOMAINS)", () => {
  it("only allowed domains can be invited, accept an invite, sign in or keep a session", async () => {
    const outsider = await createUser(w.admin, { email: "pat@gmail.com", name: "Pat Outside", role: "INTERNAL_USER" });
    const token = await sessionFor(w.user); // an example.test user with a live session
    process.env.ALLOWED_EMAIL_DOMAINS = " Vahan.co , @example.org ";
    try {
      for (const email of ["x@gmail.com", "x@vahan.co.evil.com", "x@notvahan.co", "x@sub.vahan.co", "vahan.co@evil.com"])
        await expectError(createUser(w.admin, { email, name: "X", role: "INTERNAL_USER" }), "EMAIL_DOMAIN_NOT_ALLOWED");
      const ok = await createUser(w.admin, { email: "Priya@VAHAN.co", name: "Priya", role: "INTERNAL_USER" });
      await consumeToken(ok.inviteUrl!.split("/").pop()!, "a-long-enough-password");
      expect((await login("priya@vahan.co", "a-long-enough-password", {})).user.name).toBe("Priya");
      expect((await createUser(w.admin, { email: "a@example.org", name: "A", role: "INTERNAL_USER" })).user.email).toBe("a@example.org");
      // People invited before the rule existed are shut out too.
      await expectError(consumeToken(outsider.inviteUrl!.split("/").pop()!, "a-long-enough-password"), "EMAIL_DOMAIN_NOT_ALLOWED");
      await expectError(login(w.user.email, PASSWORD, {}), "INVALID_CREDENTIALS");
      expect((await call(meRoute.GET, { method: "GET", token })).status).toBe(401);
    } finally {
      delete process.env.ALLOWED_EMAIL_DOMAINS;
    }
    expect((await call(meRoute.GET, { method: "GET", token })).status).toBe(200);
  });
});
