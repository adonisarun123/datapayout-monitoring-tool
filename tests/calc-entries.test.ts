import { beforeEach, describe, expect, it } from "vitest";
import { db, one, q } from "@/lib/db";
import { calculate, sumMoney } from "@/server/calc";
import { correctEntry, getEntry, previewEntry, submitEntry, voidEntry } from "@/server/entries";
import { createAssignment, createRule, endDated } from "@/server/masters";
import { addDays } from "@/lib/dates";
import * as entriesRoute from "@/app/api/v1/entries/route";
import * as correctionRoute from "@/app/api/v1/entries/[id]/corrections/route";
import * as voidRoute from "@/app/api/v1/entries/[id]/void/route";
import { call, daysAgo, entry, expectError, makeWorld, sessionFor, today, type World } from "./helpers";

let w: World;
beforeEach(async () => { w = await makeWorld(); });

describe("calculation (section 5)", () => {
  it("AT-01: 100 hours at 70% and INR 100 gives 70 payable hours and 7,000.00", async () => {
    expect(calculate("100", "70", "100")).toMatchObject({ payableHoursRaw: "70", lineAmount: "7000.00" });
    const e = await entry(w, { hours: "100" });
    expect(e.hours).toBe("100.0000");
    expect(Number(e.payable_hours_raw)).toBe(70);
    expect(e.line_amount).toBe("7000.00");
    expect(e.currency).toBe("INR");
  });

  it("AT-02: 10.1234 hours at 70% and 100.25 gives raw 710.409595 and line 710.41", () => {
    const c = calculate("10.1234", "70", "100.25");
    expect(c.amountRaw).toBe("710.409595");
    expect(c.lineAmount).toBe("710.41");
  });

  it("AT-03: each line is rounded half up, and the total is the sum of rounded lines", () => {
    // 0.05 h x 70% x 100.10 = 3.5035 -> 3.50; 0.15 h x 70% x 100.10 = 10.5105 -> 10.51; 0.5 h x 1% x 1 = 0.005 -> 0.01
    const lines = [calculate("0.05", "70", "100.10"), calculate("0.15", "70", "100.10"), calculate("0.5", "1", "1")];
    expect(lines.map((l) => l.lineAmount)).toEqual(["3.50", "10.51", "0.01"]);
    expect(sumMoney(lines.map((l) => l.lineAmount))).toBe("14.02");
    // Rounding the aggregate instead would give a different answer, which is why it is never done.
    expect(calculate("0.005", "100", "1").lineAmount).toBe("0.01");
    expect(calculate("0.0049", "100", "1").lineAmount).toBe("0.00");
  });
});

describe("entry submission", () => {
  it("snapshots POC, rule and terms at submission", async () => {
    const e = await entry(w, { hours: "8.5" });
    const { versions } = await getEntry(e.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ poc_id: w.poc.id, rate: "100.0000", percentage: "70.0000", currency: "INR", calculation_version: 1 });
    expect(versions[0].assignment_id).toBeTruthy();
    expect(versions[0].rule_id).toBeTruthy();
  });

  it("AT-23: no applicable POC or rule, a future date, or invalid hours blocks the entry and saves nothing", async () => {
    const before = daysAgo(401);
    await expectError(entry(w, { activityDate: before }), "BEFORE_COMMISSIONING");
    await expectError(entry(w, { activityDate: addDays(today, 1) }), "FUTURE_DATE");
    await expectError(entry(w, { hours: "0" }), "INVALID_NUMBER");
    await expectError(entry(w, { hours: "-3" }), "INVALID_NUMBER");
    await expectError(entry(w, { hours: "1.23456" }), "TOO_PRECISE");
    await expectError(entry(w, { hours: "100000.0001" }), "HOURS_TOO_LARGE");
    await expectError(entry(w, { hours: "abc" }), "INVALID_NUMBER");
    await expectError(entry(w, { reference: "   " }), "REQUIRED");

    // A device whose rule ended has no rule afterwards; one whose assignment ended has no POC.
    const [rule] = await q(db, "select id from payout_rules where device_id = $1", [w.device.id]);
    await endDated(w.admin, "rule", rule.id, { validToExclusive: daysAgo(10), reason: "contract ended", confirmRetroactive: true });
    const noRule = await expectError(entry(w, { activityDate: daysAgo(5) }), "NO_PAYOUT_RULE");
    expect(noRule.message).toMatch(/Ask an admin/);
    const [asg] = await q(db, "select id from device_poc_assignments where device_id = $1", [w.device2.id]);
    await endDated(w.admin, "assignment", asg.id, { validToExclusive: daysAgo(10), reason: "moved", confirmRetroactive: true });
    await expectError(entry(w, { deviceId: w.device2.id, activityDate: daysAgo(5) }), "NO_ASSIGNMENT");

    expect((await one(db, "select count(*)::int as n from data_entries")).n).toBe(0);
    expect((await one(db, "select count(*)::int as n from data_entry_versions")).n).toBe(0);
  });

  it("warns above the 24-hour threshold but does not block (assumption 11)", async () => {
    const p = await previewEntry({ deviceId: w.device.id, activityDate: daysAgo(3), hours: "30", reference: "x" });
    expect(p.warnings.map((x) => x.code)).toContain("HOURS_ABOVE_THRESHOLD");
    await expectError(entry(w, { hours: "30", ack: [] }), "WARNING_CONFIRMATION_REQUIRED");
    expect((await entry(w, { hours: "30", ack: ["HOURS_ABOVE_THRESHOLD"] })).hours).toBe("30.0000");
  });

  it("warns on same device/date/hours but allows it after confirmation", async () => {
    await entry(w, { hours: "4", activityDate: daysAgo(2), reference: "A" });
    await expectError(entry(w, { hours: "4", activityDate: daysAgo(2), reference: "B", ack: [] }), "WARNING_CONFIRMATION_REQUIRED");
    await entry(w, { hours: "4", activityDate: daysAgo(2), reference: "B", ack: ["POSSIBLE_DUPLICATE"] });
  });

  it("AT-12: same device and reference in a different case is rejected, even after the first was voided", async () => {
    const first = await entry(w, { reference: "Batch-77" });
    await expectError(entry(w, { reference: "  BATCH-77 " }), "DUPLICATE_REFERENCE");
    await voidEntry(w.admin, first.id, { expectedVersion: first.version, reason: "entered twice" });
    await expectError(entry(w, { reference: "batch-77" }), "DUPLICATE_REFERENCE");
    // The same reference on a different device is fine.
    await entry(w, { deviceId: w.device2.id, reference: "batch-77" });
  });

  it("AT-12: a retry with the same idempotency key returns the original response and creates nothing new", async () => {
    const token = await sessionFor(w.user);
    const body = { deviceId: w.device.id, activityDate: daysAgo(4), hours: "100.0000", reference: "BATCH-IDEM", notes: "x", acknowledgedWarnings: ["HOURS_ABOVE_THRESHOLD"] };
    const headers = { "idempotency-key": "key-1" };
    const a = await call(entriesRoute.POST, { token, body, headers, path: "/api/v1/entries" });
    const b = await call(entriesRoute.POST, { token, body, headers, path: "/api/v1/entries" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json).toEqual(a.json);
    expect(b.headers.get("x-idempotent-replay")).toBe("true");
    expect(a.json.data).toMatchObject({ hours: "100.0000", percentage: "70.0000", rate: "100.0000", currency: "INR", line_amount: "7000.00", status: "VALID", version: 1 });
    expect((await one(db, "select count(*)::int as n from data_entries")).n).toBe(1);
    const c = await call(entriesRoute.POST, { token, body: { ...body, hours: "5" }, headers, path: "/api/v1/entries" });
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("immutability and corrections", () => {
  it("AT-04: an internal user cannot update or void an entry through the service or the API", async () => {
    const e = await entry(w);
    await expectError(correctEntry(w.user, e.id, { expectedVersion: 1, hours: "1", reason: "x" }), "FORBIDDEN");
    await expectError(voidEntry(w.user, e.id, { expectedVersion: 1, reason: "x" }), "FORBIDDEN");
    const token = await sessionFor(w.user);
    const c = await call(correctionRoute.POST, { token, params: { id: e.id }, body: { expectedVersion: 1, hours: "1", reason: "x" } });
    const v = await call(voidRoute.POST, { token, params: { id: e.id }, body: { expectedVersion: 1, reason: "x" } });
    expect(c.status).toBe(403);
    expect(v.status).toBe(403);
    // There is no update or delete verb on the entries resource at all.
    expect(Object.keys(entriesRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(await import("@/app/api/v1/entries/[id]/route"))).toEqual(["GET"]);
    const after = (await getEntry(e.id)).entry;
    expect(after).toMatchObject({ hours: "10.0000", status: "VALID", version: 1 });
  });

  it("AT-05: an admin correction creates a new immutable version and a before/after audit event", async () => {
    const e = await entry(w, { hours: "10" });
    await expectError(correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "12", reason: " " }), "REASON_REQUIRED");
    const dry = await correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "12", reason: "typo", dryRun: true });
    expect(dry.saved).toBe(false);
    expect(dry.preview.after.amount).toBe("840.00");
    const r = await correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "12", reason: "typo in hours" });
    expect(r.entry).toMatchObject({ hours: "12.0000", line_amount: "840.00", version: 2, version_no: 2 });
    const { versions } = await getEntry(e.id);
    expect(versions.map((v) => [v.version_no, v.hours])).toEqual([[2, "12.0000"], [1, "10.0000"]]);
    const ev = await one(db, "select * from audit_events where action = 'ENTRY_CORRECTED' and entity_id = $1", [e.id]);
    expect(ev.reason).toBe("typo in hours");
    expect(ev.before_json.hours).toBe("10.0000");
    expect(ev.after_json.hours).toBe("12.0000");
    expect(ev.actor_id).toBe(w.admin.id);
    // Stale version is refused.
    await expectError(correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "13", reason: "again" }), "STALE_VERSION");
    // Versions and audit events cannot be rewritten, even by the database owner running plain SQL.
    await expect(db.query("update data_entry_versions set hours = 1 where entry_id = $1", [e.id])).rejects.toThrow(/append-only/);
    await expect(db.query("delete from audit_events")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from data_entries where id = $1", [e.id])).rejects.toThrow(/never deleted/);
  });

  it("a correction re-resolves POC and rule for the corrected device and date", async () => {
    const e = await entry(w, { hours: "10" });
    await createRule(w.admin, w.device2.id, { rate: "50", currency: "INR", percentage: "80", validFrom: daysAgo(30), reason: "new terms", confirmRetroactive: true });
    const r = await correctEntry(w.admin, e.id, { expectedVersion: 1, deviceId: w.device2.id, reason: "wrong device" });
    expect(r.entry).toMatchObject({ device_id: w.device2.id, poc_id: w.poc2.id, rate: "50.0000", percentage: "80.0000", line_amount: "400.00" });
  });

  it("AT-09: a rate change applies to new entries only; existing snapshots are untouched", async () => {
    const old = await entry(w, { hours: "10", activityDate: daysAgo(20) });
    await expectError(
      createRule(w.admin, w.device.id, { rate: "150", currency: "INR", percentage: "60", validFrom: daysAgo(30) }),
      "RETROACTIVE_CONFIRMATION_REQUIRED",
    );
    await createRule(w.admin, w.device.id, { rate: "150", currency: "INR", percentage: "60", validFrom: daysAgo(30), reason: "renegotiated", confirmRetroactive: true });
    expect((await getEntry(old.id)).entry).toMatchObject({ rate: "100.0000", percentage: "70.0000", line_amount: "700.00" });
    const fresh = await entry(w, { hours: "10", activityDate: daysAgo(20), ack: ["POSSIBLE_DUPLICATE"] });
    expect(fresh).toMatchObject({ rate: "150.0000", percentage: "60.0000", line_amount: "900.00" });
    const beforeChange = await entry(w, { hours: "10", activityDate: daysAgo(31) });
    expect(beforeChange.rate).toBe("100.0000");
    // A future-dated rule can be scheduled without the retroactive confirmation.
    await createRule(w.admin, w.device.id, { rate: "200", currency: "INR", percentage: "60", validFrom: addDays(today, 10) });
    expect((await entry(w, { hours: "1", activityDate: today })).rate).toBe("150.0000");
  });

  it("AT-10: after a reassignment each entry carries the POC in force on its own activity date", async () => {
    await createAssignment(w.admin, w.device.id, { pocId: w.poc2.id, validFrom: daysAgo(10), reason: "handover", confirmRetroactive: true });
    expect((await entry(w, { activityDate: daysAgo(11) })).poc_id).toBe(w.poc.id);
    expect((await entry(w, { activityDate: daysAgo(10) })).poc_id).toBe(w.poc2.id);
    expect((await entry(w, { activityDate: daysAgo(2) })).poc_id).toBe(w.poc2.id);
  });

  it("AT-11 / AT-24: overlapping ranges are rejected, including concurrently; an end date may equal the next start date", async () => {
    const [rule] = await q(db, "select * from payout_rules where device_id = $1", [w.device.id]);
    const retro = { reason: "test", confirmRetroactive: true };
    // Close the open rule at D-50, then add [D-50, D-20) and an open rule from D-20: boundaries touch, none overlap.
    await endDated(w.admin, "rule", rule.id, { validToExclusive: daysAgo(50), ...retro });
    await createRule(w.admin, w.device.id, { rate: "110", currency: "INR", percentage: "70", validFrom: daysAgo(50), validToExclusive: daysAgo(20), ...retro });
    await createRule(w.admin, w.device.id, { rate: "120", currency: "INR", percentage: "70", validFrom: daysAgo(20), ...retro });
    await expectError(
      createRule(w.admin, w.device.id, { rate: "999", currency: "INR", percentage: "70", validFrom: daysAgo(60), validToExclusive: daysAgo(40), ...retro }),
      "DATE_RANGE_OVERLAP",
    );
    // The rule is chosen by activity date: the end date is exclusive, the start date inclusive.
    expect((await entry(w, { activityDate: daysAgo(51) })).rate).toBe("100.0000");
    expect((await entry(w, { activityDate: daysAgo(50) })).rate).toBe("110.0000");
    expect((await entry(w, { activityDate: daysAgo(21) })).rate).toBe("110.0000");
    expect((await entry(w, { activityDate: daysAgo(20) })).rate).toBe("120.0000");

    // Concurrent overlapping inserts straight at the database: the exclusion constraint lets exactly one through.
    const [asg] = await q(db, "select * from device_poc_assignments where device_id = $1", [w.device2.id]);
    await endDated(w.admin, "assignment", asg.id, { validToExclusive: daysAgo(100), ...retro });
    const insert = () => db.query(
      "insert into device_poc_assignments (device_id, poc_id, valid_from, valid_to_exclusive) values ($1, $2, $3, $4)",
      [w.device2.id, w.poc.id, daysAgo(90), daysAgo(60)],
    );
    const results = await Promise.allSettled([insert(), insert(), insert()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r: any) => r.reason.code === "23P01")).toBe(true);
  });

  it("business dates follow Asia/Kolkata, not UTC", async () => {
    const { todayIST } = await import("@/lib/dates");
    // 19:00 UTC on the 15th is 00:30 IST on the 16th.
    expect(todayIST(new Date("2026-11-15T19:00:00Z"))).toBe("2026-11-16");
    expect(todayIST(new Date("2026-11-15T18:29:00Z"))).toBe("2026-11-15");
  });
});
