import { beforeEach, describe, expect, it } from "vitest";
import { db, one, q } from "@/lib/db";
import { approveBill, cancelBill, createAdjustment, createBill, excludeLines, getBill, previewBill, regenerateBill, rejectBill, submitBill } from "@/server/bills";
import { correctEntry, getEntry, voidEntry } from "@/server/entries";
import { createAssignment, createRule } from "@/server/masters";
import { recordPayment, reversePayment } from "@/server/payments";
import { updateSettings } from "@/server/settings";
import * as approveRoute from "@/app/api/v1/bills/[id]/approve/route";
import * as billsRoute from "@/app/api/v1/bills/route";
import { call, daysAgo, entry, expectError, makeWorld, sessionFor, today, type World } from "./helpers";

let w: World;
beforeEach(async () => { w = await makeWorld(); });

const scope = (w: World, over: any = {}) => ({ pocId: w.poc.id, currency: "INR", dateFrom: daysAgo(60), dateTo: today, ...over });

async function approvedBill(w: World, hours = ["10", "20"]) {
  for (const h of hours) await entry(w, { hours: h });
  let b = (await createBill(w.admin, scope(w))).bill;
  b = (await submitBill(w.admin, b.id, { expectedVersion: b.version })).bill;
  return approveBill(w.admin2, b.id, { expectedVersion: b.version });
}

describe("bill lifecycle", () => {
  it("creates a draft from eligible entries with snapshots, device subtotals and a total of rounded lines", async () => {
    await entry(w, { hours: "10.1234" }); // 708.638 -> 708.64
    await entry(w, { hours: "0.05" }); // 3.5 -> 3.50
    await entry(w, { deviceId: w.device2.id, hours: "99" }); // other POC, not included
    const preview = await previewBill(w.admin, scope(w));
    expect(preview.eligible).toHaveLength(2);
    expect(preview.total).toBe("712.14");
    const { bill, lines, deviceSubtotals } = await createBill(w.admin, scope(w));
    expect(bill).toMatchObject({ status: "DRAFT", total: "712.14", revision: 1, type: "STANDARD", currency: "INR" });
    expect(bill.bill_number).toMatch(/^BILL-\d{4}-000001$/);
    expect(lines.map((l) => l.line_amount).sort()).toEqual(["3.50", "708.64"]);
    expect(deviceSubtotals).toEqual([{ device_code: "DEV-001", lines: 2, hours: "10.1734", amount: "712.14" }]);
    await expectError(createBill(w.admin, scope(w)), "EMPTY_BILL"); // nothing left to bill
    await expectError(createBill(w.user, scope(w)), "FORBIDDEN");
  });

  it("preview flags entries that cannot be included: already on a bill, or in another currency", async () => {
    await entry(w, { hours: "1", activityDate: daysAgo(40) });
    await createBill(w.admin, scope(w));
    await createRule(w.admin, w.device.id, { rate: "2", currency: "USD", percentage: "70", validFrom: daysAgo(10), reason: "currency change", confirmRetroactive: true });
    await entry(w, { hours: "3", activityDate: daysAgo(5) });
    const p = await previewBill(w.admin, scope(w));
    expect(p.eligible).toHaveLength(0);
    expect(p.excluded.map((e) => e.reason).sort()).toEqual(["DIFFERENT_CURRENCY", "ON_ANOTHER_BILL"]);
    // BR-09: the USD entry bills on its own USD bill, never mixed.
    const usd = await createBill(w.admin, scope(w, { currency: "USD" }));
    expect(usd.lines.every((l) => l.currency === "USD")).toBe(true);
  });

  it("AT-10: a bill for each POC picks up only the entries dated within that POC's assignment", async () => {
    await createAssignment(w.admin, w.device.id, { pocId: w.poc2.id, validFrom: daysAgo(10), reason: "handover", confirmRetroactive: true });
    await entry(w, { hours: "5", activityDate: daysAgo(12) });
    await entry(w, { hours: "7", activityDate: daysAgo(8) });
    const a = await createBill(w.admin, scope(w));
    const b = await createBill(w.admin, scope(w, { pocId: w.poc2.id }));
    expect(a.lines.map((l) => l.hours)).toEqual(["5.0000"]);
    expect(b.lines.map((l) => l.hours)).toEqual(["7.0000"]);
  });

  it("AT-06: correcting an entry on a draft releases it and blocks submission until the bill is regenerated", async () => {
    const e = await entry(w, { hours: "10" });
    await entry(w, { hours: "20" });
    const { bill } = await createBill(w.admin, scope(w));
    const r = await correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "11", reason: "miscount" });
    expect(r.preview.releasesFromBill).toBe(bill.bill_number);
    expect(r.entry.billing_state).toBe("UNBILLED");
    const after = await getBill(bill.id);
    expect(after.bill).toMatchObject({ status: "NEEDS_REVIEW", total: "1400.00" });
    expect(after.lines).toHaveLength(1);
    await expectError(submitBill(w.admin, bill.id, { expectedVersion: after.bill.version }), "NEEDS_REGENERATION");
    const regen = await regenerateBill(w.admin, bill.id, { expectedVersion: after.bill.version });
    expect(regen.bill).toMatchObject({ status: "DRAFT", revision: 2, total: "2170.00" });
    expect(regen.lines).toHaveLength(2);
    expect((await submitBill(w.admin, bill.id, { expectedVersion: regen.bill.version })).bill.status).toBe("PENDING_APPROVAL");
  });

  it("voiding an entry on a draft also releases it and flags the bill", async () => {
    const e = await entry(w, { hours: "10" });
    await entry(w, { hours: "20" });
    const { bill } = await createBill(w.admin, scope(w));
    await voidEntry(w.admin, e.id, { expectedVersion: 1, reason: "bad batch" });
    expect((await getBill(bill.id)).bill.status).toBe("NEEDS_REVIEW");
  });

  it("AT-07: entries on a pending or approved bill cannot be corrected or voided", async () => {
    const e = await entry(w, { hours: "10" });
    let b = (await createBill(w.admin, scope(w))).bill;
    b = (await submitBill(w.admin, b.id, { expectedVersion: b.version })).bill;
    const pending = await expectError(correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "11", reason: "x" }), "ENTRY_LOCKED");
    expect(pending.message).toMatch(/Reject the bill/);
    await expectError(voidEntry(w.admin, e.id, { expectedVersion: 1, reason: "x" }), "ENTRY_LOCKED");
    await expectError(cancelBill(w.admin, b.id, { expectedVersion: b.version }), "INVALID_BILL_STATE"); // pending: reject first
    b = (await approveBill(w.admin, b.id, { expectedVersion: b.version })).bill;
    const approved = await expectError(correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "11", reason: "x" }), "ENTRY_LOCKED");
    expect(approved.message).toMatch(/adjustment/);
    await expectError(voidEntry(w.admin, e.id, { expectedVersion: 1, reason: "x" }), "ENTRY_LOCKED");
    expect((await getEntry(e.id)).entry).toMatchObject({ hours: "10.0000", version: 1, billing_state: "APPROVED" });
  });

  it("AT-08: two bills racing for the same entries: exactly one wins, the other conflicts and leaves nothing behind", async () => {
    for (let i = 0; i < 5; i++) await entry(w, { hours: String(i + 1) });
    const results = await Promise.allSettled([createBill(w.admin, scope(w)), createBill(w.admin2, scope(w)), createBill(w.admin, scope(w))]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed.every((f) => ["ENTRY_ALREADY_RESERVED", "EMPTY_BILL"].includes(f.reason.code))).toBe(true);
    expect((await one(db, "select count(*)::int as n from bills")).n).toBe(1);
    expect((await one(db, "select count(*)::int as n from bill_lines")).n).toBe(5);
    const dup = await q(db, "select entry_id from bill_lines where active_reservation group by entry_id having count(*) > 1");
    expect(dup).toHaveLength(0);
    // BR-04 is also a database constraint, independent of application code.
    const line = await one(db, "select * from bill_lines limit 1");
    await expect(db.query(
      `insert into bill_lines (bill_id, bill_revision, entry_id, entry_version_id, device_id, device_code, poc_id, reference, activity_date,
                               hours, percentage, rate, currency, payable_hours_raw, line_amount)
       values ($1, 9, $2, $3, $4, 'x', $5, 'x', $6, 1, 1, 1, 'INR', 1, 1)`,
      [line.bill_id, line.entry_id, line.entry_version_id, line.device_id, line.poc_id, line.activity_date],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("AT-13: an internal user cannot approve; the server answers 403 and the bill stays pending", async () => {
    await entry(w);
    let b = (await createBill(w.admin, scope(w))).bill;
    b = (await submitBill(w.admin, b.id, { expectedVersion: b.version })).bill;
    const res = await call(approveRoute.POST, { token: await sessionFor(w.user), params: { id: b.id }, body: { expectedVersion: b.version } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");
    expect(res.json.error.requestId).toBeTruthy();
    expect((await getBill(b.id)).bill.status).toBe("PENDING_APPROVAL");
    // No session at all is 401, and internal users cannot create bills either.
    expect((await call(approveRoute.POST, { params: { id: b.id }, body: {} })).status).toBe(401);
    expect((await call(billsRoute.POST, { token: await sessionFor(w.user), body: scope(w) })).status).toBe(403);
    // An admin approves through the API with a fresh session.
    const ok = await call(approveRoute.POST, { token: await sessionFor(w.admin2), params: { id: b.id }, body: { expectedVersion: b.version } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.bill).toMatchObject({ status: "APPROVED", approved_by: w.admin2.id });
  });

  it("approval needs a recent password confirmation (FR-003)", async () => {
    await entry(w);
    let b = (await createBill(w.admin, scope(w))).bill;
    b = (await submitBill(w.admin, b.id, { expectedVersion: b.version })).bill;
    const token = await sessionFor(w.admin);
    await db.query("update sessions set authenticated_at = now() - interval '2 hours'");
    const res = await call(approveRoute.POST, { token, params: { id: b.id }, body: { expectedVersion: b.version } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("REAUTH_REQUIRED");
    const reauth = await import("@/app/api/v1/auth/reauth/route");
    expect((await call(reauth.POST, { token, body: { password: "wrong-password-here" } })).status).toBe(401);
    expect((await call(reauth.POST, { token, body: { password: "correct-horse-battery" } })).status).toBe(200);
    expect((await call(approveRoute.POST, { token, params: { id: b.id }, body: { expectedVersion: b.version } })).status).toBe(200);
  });

  it("the separate-approver policy, when switched on, stops an admin approving their own bill", async () => {
    await updateSettings(w.admin, { require_separate_approver: true });
    await entry(w);
    let b = (await createBill(w.admin, scope(w))).bill;
    b = (await submitBill(w.admin, b.id, { expectedVersion: b.version })).bill;
    await expectError(approveBill(w.admin, b.id, { expectedVersion: b.version }), "SEPARATE_APPROVER_REQUIRED");
    expect((await approveBill(w.admin2, b.id, { expectedVersion: b.version })).bill.status).toBe("APPROVED");
  });

  it("AT-14: reject, correct, regenerate: reason kept, revision recorded, old reservations released, current lines claimed", async () => {
    const e = await entry(w, { hours: "10" });
    let b = (await createBill(w.admin, scope(w))).bill;
    b = (await submitBill(w.admin, b.id, { expectedVersion: b.version })).bill;
    await expectError(rejectBill(w.admin2, b.id, { expectedVersion: b.version, reason: "" }), "REASON_REQUIRED");
    b = (await rejectBill(w.admin2, b.id, { expectedVersion: b.version, reason: "hours look wrong" })).bill;
    expect(b.status).toBe("REJECTED");
    // Still reserved while rejected: no second bill can take the entry.
    await expectError(createBill(w.admin, scope(w)), "EMPTY_BILL");
    await correctEntry(w.admin, e.id, { expectedVersion: 1, hours: "8", reason: "recount" });
    const late = await entry(w, { hours: "2" }); // arrived after the first run
    b = (await getBill(b.id)).bill;
    expect(b.status).toBe("NEEDS_REVIEW");
    const regen = await regenerateBill(w.admin, b.id, { expectedVersion: b.version });
    expect(regen.bill).toMatchObject({ status: "DRAFT", revision: 2, total: "700.00" });
    expect(regen.lines.map((l) => l.hours).sort()).toEqual(["2.0000", "8.0000"]);
    expect(regen.lines.map((l) => l.entry_id)).toContain(late.id);
    expect(regen.decisions.map((d) => d.decision)).toEqual(["CREATED", "SUBMITTED", "REJECTED", "NEEDS_REVIEW", "REGENERATED"]);
    expect(regen.decisions.find((d) => d.decision === "REJECTED")).toMatchObject({ reason: "hours look wrong", actor_id: w.admin2.id, revision: 1 });
    // The revision-1 line is kept as history with its original figures, and no longer reserves anything.
    expect(regen.removedLines).toHaveLength(1);
    expect(regen.removedLines[0]).toMatchObject({ bill_revision: 1, hours: "10.0000", line_amount: "700.00", active_reservation: false });
    expect(regen.revisions.map((r) => r.revision)).toEqual([1, 2]);
  });

  it("a draft can drop lines but never to empty; a cancelled bill frees its entries", async () => {
    await entry(w, { hours: "1" });
    await entry(w, { hours: "2" });
    let d = await createBill(w.admin, scope(w));
    d = await excludeLines(w.admin, d.bill.id, { lineIds: [d.lines[0].id], expectedVersion: d.bill.version });
    expect(d.lines).toHaveLength(1);
    await expectError(excludeLines(w.admin, d.bill.id, { lineIds: [d.lines[0].id], expectedVersion: d.bill.version }), "EMPTY_BILL");
    await expectError(excludeLines(w.admin, d.bill.id, { lineIds: [d.lines[0].id], expectedVersion: 1 }), "STALE_VERSION");
    const c = await cancelBill(w.admin, d.bill.id, { expectedVersion: d.bill.version, reason: "wrong period" });
    expect(c.bill.status).toBe("CANCELLED");
    expect(c.lines).toHaveLength(1); // cancelled lines stay visible as history
    await expectError(submitBill(w.admin, d.bill.id, { expectedVersion: c.bill.version }), "INVALID_BILL_STATE");
    expect((await createBill(w.admin, scope(w))).lines).toHaveLength(2);
  });

  it("AT-15: an approved bill is frozen; later rate changes do not touch it, and the database refuses edits", async () => {
    const { bill, lines } = await approvedBill(w);
    await createRule(w.admin, w.device.id, { rate: "500", currency: "INR", percentage: "100", validFrom: daysAgo(300), reason: "backdated", confirmRetroactive: true });
    const again = await getBill(bill.id);
    expect(again.bill.total).toBe("2100.00");
    expect(again.lines.map((l) => [l.rate, l.percentage, l.line_amount])).toEqual(lines.map((l) => [l.rate, l.percentage, l.line_amount]));
    for (const f of [cancelBill, regenerateBill, submitBill]) await expectError(f(w.admin, bill.id, { expectedVersion: again.bill.version }), "INVALID_BILL_STATE");
    await expectError(excludeLines(w.admin, bill.id, { lineIds: [lines[0].id], expectedVersion: again.bill.version }), "INVALID_BILL_STATE");
    await expect(db.query("update bills set total = 1 where id = $1", [bill.id])).rejects.toThrow(/immutable/);
    await expect(db.query("update bill_lines set line_amount = 1 where bill_id = $1", [bill.id])).rejects.toThrow(/immutable/);
    await expect(db.query("delete from bills where id = $1", [bill.id])).rejects.toThrow(/never deleted/);
  });
});

describe("payments (FR-027, FR-028)", () => {
  const pay = (amount: string) => ({ paymentDate: today, amount, method: "NEFT", reference: `UTR-${amount}` });

  it("AT-16: partial then settling payment moves UNPAID -> PARTIALLY_PAID -> PAID; overpayment is rejected, also under concurrency", async () => {
    const { bill } = await approvedBill(w); // 2100.00
    expect(bill).toMatchObject({ payment_status: "UNPAID", outstanding: "2100.00" });
    expect((await recordPayment(w.admin, bill.id, pay("600"))).bill).toMatchObject({ payment_status: "PARTIALLY_PAID", outstanding: "1500.00" });
    await expectError(recordPayment(w.admin, bill.id, pay("1500.01")), "OVERPAYMENT");
    // Two admins each try to pay 1000 against 1500 outstanding at the same moment.
    const race = await Promise.allSettled([recordPayment(w.admin, bill.id, pay("1000")), recordPayment(w.admin2, bill.id, pay("1000"))]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("OVERPAYMENT");
    expect((await recordPayment(w.admin, bill.id, pay("500"))).bill).toMatchObject({ payment_status: "PAID", outstanding: "0.00", paid: "2100.00" });
    await expectError(recordPayment(w.admin, bill.id, pay("0.01")), "OVERPAYMENT");
    await expectError(recordPayment(w.user, bill.id, pay("1")), "FORBIDDEN");
  });

  it("BR-05: a bill cannot be paid before it is approved", async () => {
    await entry(w);
    const { bill } = await createBill(w.admin, scope(w));
    await expectError(recordPayment(w.admin, bill.id, pay("1")), "BILL_NOT_APPROVED");
  });

  it("AT-17: a reversal keeps both ledger records and recalculates the balance; it cannot be done twice", async () => {
    const { bill } = await approvedBill(w);
    const paid = await recordPayment(w.admin, bill.id, pay("2100"));
    const payment = paid.payments[0];
    await expectError(reversePayment(w.admin, payment.id, { reason: "" }), "REASON_REQUIRED");
    const rev = await reversePayment(w.admin, payment.id, { reason: "wrong account" });
    expect(rev.payments.map((p) => [p.kind, p.amount])).toEqual([["PAYMENT", "2100.00"], ["REVERSAL", "2100.00"]]);
    expect(rev.bill).toMatchObject({ payment_status: "UNPAID", paid: "0.00", outstanding: "2100.00" });
    await expectError(reversePayment(w.admin, payment.id, { reason: "again" }), "ALREADY_REVERSED");
    await expectError(reversePayment(w.admin, rev.payments[1].id, { reason: "undo" }), "NOT_REVERSIBLE");
    await expect(db.query("update payments set amount = 1")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from payments")).rejects.toThrow(/append-only/);
    expect((await recordPayment(w.admin, bill.id, pay("2100"))).bill.payment_status).toBe("PAID");
  });
});

describe("adjustments (section 8.7)", () => {
  it("a positive adjustment is its own approved, payable bill; the original is untouched", async () => {
    const original = await approvedBill(w); // lines 700.00 and 1400.00
    const line = original.lines.find((l) => l.line_amount === "700.00")!;
    await expectError(createAdjustment(w.admin, original.bill.id, { reason: "", lines: [{ originalLineId: line.id, correctedHours: "12" }] }), "REASON_REQUIRED");
    await expectError(createAdjustment(w.admin, original.bill.id, { reason: "x", lines: [{ originalLineId: line.id, correctedAmount: "700.00" }] }), "ZERO_ADJUSTMENT");
    let adj = await createAdjustment(w.admin, original.bill.id, { reason: "2 hours were missed", lines: [{ originalLineId: line.id, correctedHours: "12" }] });
    expect(adj.bill).toMatchObject({ type: "ADJUSTMENT", status: "DRAFT", total: "140.00", original_bill_id: original.bill.id, poc_id: w.poc.id, currency: "INR" });
    expect(adj.bill.bill_number).toMatch(/^ADJ-/);
    expect(adj.lines[0]).toMatchObject({ original_amount: "700.00", prior_adjustments: "0.00", corrected_amount: "840.00", line_amount: "140.00" });
    adj = await submitBill(w.admin, adj.bill.id, { expectedVersion: adj.bill.version });
    adj = await approveBill(w.admin2, adj.bill.id, { expectedVersion: adj.bill.version });
    expect(adj.bill).toMatchObject({ status: "APPROVED", payment_status: "UNPAID", outstanding: "140.00" });
    await recordPayment(w.admin, adj.bill.id, { paymentDate: today, amount: "140", method: "UPI", reference: "U1" });
    const o = await getBill(original.bill.id);
    expect(o.bill).toMatchObject({ total: "2100.00", status: "APPROVED", outstanding: "2100.00" });
    expect(o.lines.find((l) => l.id === line.id)).toMatchObject({ line_amount: "700.00", hours: "10.0000", approved_adjustments: "140.00" });
    expect(o.adjustments.map((a) => a.bill_number)).toEqual([adj.bill.bill_number]);
    // The operational entry keeps its original hours.
    expect((await getEntry(line.entry_id)).entry.hours).toBe("10.0000");
  });

  it("AT-18: an approved negative adjustment is a credit: no negative payment, no automatic offset", async () => {
    const original = await approvedBill(w);
    const line = original.lines.find((l) => l.line_amount === "1400.00")!;
    let adj = await createAdjustment(w.admin, original.bill.id, { reason: "5 hours over-reported", lines: [{ originalLineId: line.id, correctedHours: "15" }] });
    expect(adj.bill.total).toBe("-350.00");
    adj = await submitBill(w.admin, adj.bill.id, { expectedVersion: adj.bill.version });
    adj = await approveBill(w.admin2, adj.bill.id, { expectedVersion: adj.bill.version });
    expect(adj.bill).toMatchObject({ status: "APPROVED", payment_status: "CREDIT", outstanding: "0.00" });
    await expectError(recordPayment(w.admin, adj.bill.id, { paymentDate: today, amount: "1", method: "x", reference: "x" }), "NOT_PAYABLE");
    await expect(db.query("insert into payments (bill_id, kind, amount, payment_date, method, reference, recorded_by) values ($1, 'PAYMENT', -350, $2, 'x', 'x', $3)",
      [adj.bill.id, today, w.admin.id])).rejects.toMatchObject({ code: "23514" });
    // The original bill's outstanding balance is not reduced by the credit.
    expect((await getBill(original.bill.id)).bill.outstanding).toBe("2100.00");
    const { dashboard } = await import("@/server/reports");
    const d = await dashboard({});
    expect(d.approved[0]).toMatchObject({ currency: "INR", value: "2100.00", credits: "-350.00", credit_bills: 1 });
    expect(d.outstanding[0].value).toBe("2100.00");
  });

  it("deltas are cumulative: each adjustment is the target minus the original and all prior approved adjustments", async () => {
    const original = await approvedBill(w);
    const line = original.lines.find((l) => l.line_amount === "700.00")!;
    const run = async (amount: string) => {
      let a = await createAdjustment(w.admin, original.bill.id, { reason: "recount", lines: [{ originalLineId: line.id, correctedAmount: amount }] });
      a = await submitBill(w.admin, a.bill.id, { expectedVersion: a.bill.version });
      return approveBill(w.admin2, a.bill.id, { expectedVersion: a.bill.version });
    };
    expect((await run("900")).bill.total).toBe("200.00"); // 900 - 700
    const second = await run("650"); // 650 - 700 - 200
    expect(second.bill.total).toBe("-250.00");
    expect(second.lines[0]).toMatchObject({ prior_adjustments: "200.00", original_amount: "700.00" });
    expect((await run("0")).bill.total).toBe("-650.00"); // full reversal of what remains
  });

  it("AT-19: concurrent adjustments to one line: one reserves it, the other is refused until the first is settled", async () => {
    const original = await approvedBill(w);
    const line = original.lines[0];
    const mk = (amount: string, by = w.admin) => createAdjustment(by, original.bill.id, { reason: "fix", lines: [{ originalLineId: line.id, correctedAmount: amount }] });
    const race = await Promise.allSettled([mk("10"), mk("20", w.admin2)]);
    const won = race.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>;
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("LINE_UNDER_ADJUSTMENT");
    expect((await one(db, "select count(*)::int as n from bills where type = 'ADJUSTMENT'")).n).toBe(1);
    await expectError(mk("30"), "LINE_UNDER_ADJUSTMENT");
    // Cancelling the first releases the line.
    await cancelBill(w.admin, won.value.bill.id, { expectedVersion: won.value.bill.version });
    const next = await mk("30");
    expect(next.bill.status).toBe("DRAFT");
    // An adjustment prepared against an old baseline cannot be approved: simulate a stale stored baseline.
    await db.query("alter table bill_lines disable trigger bill_lines_guard");
    await db.query("update bill_lines set prior_adjustments = 99 where bill_id = $1", [next.bill.id]);
    await db.query("alter table bill_lines enable trigger bill_lines_guard");
    await expectError(submitBill(w.admin, next.bill.id, { expectedVersion: next.bill.version }), "STALE_BASELINE");
    const regen = await regenerateBill(w.admin, next.bill.id, { expectedVersion: next.bill.version });
    expect(regen.lines[0].prior_adjustments).toBe("0.00");
    expect((await submitBill(w.admin, next.bill.id, { expectedVersion: regen.bill.version })).bill.status).toBe("PENDING_APPROVAL");
  });

  it("adjustments can only be raised against an approved standard bill", async () => {
    await entry(w);
    const draft = await createBill(w.admin, scope(w));
    await expectError(createAdjustment(w.admin, draft.bill.id, { reason: "x", lines: [{ originalLineId: draft.lines[0].id, correctedAmount: "1" }] }), "INVALID_BILL_STATE");
  });
});
