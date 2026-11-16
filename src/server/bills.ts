import { db, one, q, tx, type Db } from "@/lib/db";
import { conflict, forbidden, invalid, notFound, staleVersion } from "@/lib/errors";
import { requireDate } from "@/lib/dates";
import { audit, requireAdmin, type Actor } from "./audit";
import { calculate, dec, parseHours, parseMoney } from "./calc";
import { getSettings } from "./settings";

const BILL_SELECT = `
  select b.*, p.name as poc_name, cu.name as created_by_name, su.name as submitted_by_name, au.name as approved_by_name,
         ob.bill_number as original_bill_number, coalesce(pay.net, 0)::numeric(18,2) as paid
    from bills b
    join pocs p on p.id = b.poc_id
    join users cu on cu.id = b.created_by
    left join users su on su.id = b.submitted_by
    left join users au on au.id = b.approved_by
    left join bills ob on ob.id = b.original_bill_id
    left join lateral (
      select sum(case when kind = 'PAYMENT' then amount else -amount end) as net from payments where bill_id = b.id
    ) pay on true`;

/** Adds the derived payment status and outstanding balance (FR-027). Negative approved bills are credits. */
export function decorateBill<T extends { status: string; total: string; paid: string }>(b: T) {
  const total = dec(b.total);
  let paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "CREDIT" | null = null;
  let outstanding = "0.00";
  if (b.status === "APPROVED") {
    if (total.isNegative()) paymentStatus = "CREDIT";
    else {
      const paid = dec(b.paid);
      outstanding = total.minus(paid).toFixed(2);
      paymentStatus = paid.isZero() ? "UNPAID" : paid.lt(total) ? "PARTIALLY_PAID" : "PAID";
    }
  }
  return { ...b, payment_status: paymentStatus, outstanding };
}

export interface BillFilter {
  status?: string; pocId?: string; type?: string; approvedFrom?: string; approvedTo?: string; paymentStatus?: string;
  page?: number; pageSize?: number;
}

export async function listBills(f: BillFilter = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 100000);
  const page = Math.max(f.page ?? 1, 1);
  const rows = await q(
    db,
    `${BILL_SELECT}
      where ($1::text is null or b.status = $1) and ($2::uuid is null or b.poc_id = $2) and ($3::text is null or b.type = $3)
        and ($4::date is null or (b.approved_at at time zone 'Asia/Kolkata')::date >= $4)
        and ($5::date is null or (b.approved_at at time zone 'Asia/Kolkata')::date <= $5)
      order by b.created_at desc, b.id`,
    [f.status || null, f.pocId || null, f.type || null, f.approvedFrom || null, f.approvedTo || null],
  );
  let all = rows.map(decorateBill);
  if (f.paymentStatus) all = all.filter((b) => b.payment_status === f.paymentStatus);
  return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize };
}

const CURRENT_LINES = "bl.bill_id = b.id and bl.bill_revision = b.revision and bl.removed_at is null";

export async function getBill(id: string) {
  const row = await one(db, `${BILL_SELECT} where b.id = $1`, [id]);
  if (!row) throw notFound("Bill");
  const bill = decorateBill(row);
  const [lines, removedLines, decisions, payments, adjustments, revisions] = await Promise.all([
    q(
      db,
      `select bl.*,
              coalesce((select sum(al.line_amount) from bill_lines al join bills ab on ab.id = al.bill_id
                         where al.original_line_id = bl.id and ab.status = 'APPROVED' and al.bill_revision = ab.revision and al.removed_at is null), 0)::numeric(18,2)
                as approved_adjustments,
              (select ab.bill_number from bill_lines al join bills ab on ab.id = al.bill_id
                where al.original_line_id = bl.id and al.active_reservation limit 1) as adjustment_in_progress
         from bill_lines bl join bills b on b.id = bl.bill_id
        where b.id = $1 and ${CURRENT_LINES} order by bl.activity_date, bl.device_code, bl.reference, bl.id`,
      [id],
    ),
    q(db, `select bl.* from bill_lines bl where bl.bill_id = $1 and (bl.removed_at is not null or bl.bill_revision <> $2)
            order by bl.bill_revision desc, bl.activity_date, bl.id`, [id, row.revision]),
    q(db, `select d.*, u.name as actor_name from bill_decisions d join users u on u.id = d.actor_id where d.bill_id = $1 order by d.created_at, d.id`, [id]),
    q(db, `select p.*, u.name as recorded_by_name, (select r.id from payments r where r.reversal_of = p.id) as reversed_by
             from payments p join users u on u.id = p.recorded_by where p.bill_id = $1 order by p.created_at, p.id`, [id]),
    q(db, `${BILL_SELECT} where b.original_bill_id = $1 order by b.created_at`, [id]),
    q(db, `select bill_revision as revision, count(*)::int as lines, sum(line_amount) as total from bill_lines where bill_id = $1 group by bill_revision order by bill_revision`, [id]),
  ]);
  const subtotals = new Map<string, { device_code: string; hours: ReturnType<typeof dec>; amount: ReturnType<typeof dec>; lines: number }>();
  for (const l of lines) {
    const s = subtotals.get(l.device_code) ?? { device_code: l.device_code, hours: dec(0), amount: dec(0), lines: 0 };
    s.hours = s.hours.plus(l.hours); s.amount = s.amount.plus(l.line_amount); s.lines++;
    subtotals.set(l.device_code, s);
  }
  return {
    bill, lines, removedLines, decisions, payments, revisions,
    adjustments: adjustments.map(decorateBill),
    deviceSubtotals: [...subtotals.values()].map((s) => ({ device_code: s.device_code, lines: s.lines, hours: s.hours.toFixed(4), amount: s.amount.toFixed(2) })),
  };
}

// ------------------------------------------------------------------ standard bills

function billScope(input: { pocId: string; currency: string; dateFrom: string; dateTo: string }) {
  if (!input.pocId) throw invalid("REQUIRED", "Select a POC.", { field: "pocId" });
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw invalid("INVALID_CURRENCY", "Currency must be a 3-letter ISO code.");
  const dateFrom = requireDate(input.dateFrom, "From date");
  const dateTo = requireDate(input.dateTo, "To date");
  if (dateTo < dateFrom) throw invalid("INVALID_DATE_RANGE", "To date must be on or after the from date.");
  return { pocId: input.pocId, currency, dateFrom, dateTo };
}

const ELIGIBLE = `
    from data_entries e
    join data_entry_versions v on v.id = e.current_version_id
    join devices d on d.id = v.device_id
   where e.status = 'VALID' and v.poc_id = $1 and v.currency = $2 and v.activity_date >= $3 and v.activity_date <= $4
     and not exists (select 1 from bill_lines bl where bl.entry_id = e.id and bl.active_reservation)`;

/** FR-020/021: what a bill for this POC, currency and inclusive date range would contain, and what it cannot. */
export async function previewBill(actor: Actor, input: { pocId: string; currency: string; dateFrom: string; dateTo: string }) {
  requireAdmin(actor);
  const s = billScope(input);
  const params = [s.pocId, s.currency, s.dateFrom, s.dateTo];
  const eligible = await q(
    db,
    `select e.id as entry_id, v.reference, v.activity_date, d.code as device_code, v.hours, v.percentage, v.rate, v.currency,
            round(v.payable_hours_raw, 4) as payable_hours, v.line_amount ${ELIGIBLE} order by v.activity_date, d.code, e.id`,
    params,
  );
  const excluded = await q(
    db,
    `select e.id as entry_id, v.reference, v.activity_date, d.code as device_code, v.hours, v.currency, v.line_amount,
            case when v.currency <> $2 then 'DIFFERENT_CURRENCY' else 'ON_ANOTHER_BILL' end as reason, b.bill_number, b.status as bill_status
       from data_entries e
       join data_entry_versions v on v.id = e.current_version_id
       join devices d on d.id = v.device_id
       left join bill_lines bl on bl.entry_id = e.id and bl.active_reservation
       left join bills b on b.id = bl.bill_id
      where e.status = 'VALID' and v.poc_id = $1 and v.activity_date >= $3 and v.activity_date <= $4
        and (v.currency <> $2 or bl.id is not null)
      order by v.activity_date, d.code, e.id`,
    params,
  );
  const total = eligible.reduce((a, l) => a.plus(l.line_amount), dec(0)).toFixed(2);
  return { ...s, eligible, excluded, total };
}

async function nextBillNumber(d: Db, prefix: "BILL" | "ADJ") {
  const r = await one(d, "select to_char(now() at time zone 'Asia/Kolkata', 'YYYY') as y, lpad(nextval('bill_number_seq')::text, 6, '0') as n");
  return `${prefix}-${r.y}-${r.n}`;
}

/** Claims every currently eligible entry for the bill's revision. Returns the number of lines created. */
async function claimEligible(d: Db, bill: { id: string; revision: number; poc_id: string; currency: string; date_from: string; date_to_inclusive: string }) {
  const params = [bill.poc_id, bill.currency, bill.date_from, bill.date_to_inclusive];
  // Lock entries in id order so concurrent bill runs and corrections queue instead of deadlocking.
  const ids = (await q(d, `select e.id ${ELIGIBLE} order by e.id for update of e`, params)).map((r) => r.id);
  if (!ids.length) throw invalid("EMPTY_BILL", "There are no eligible unbilled entries for this POC, currency and period.");
  await d.query(
    `insert into bill_lines (bill_id, bill_revision, entry_id, entry_version_id, device_id, device_code, poc_id, reference,
                             activity_date, hours, percentage, rate, currency, payable_hours_raw, line_amount)
     select $1, $2, e.id, v.id, v.device_id, d.code, v.poc_id, v.reference, v.activity_date, v.hours, v.percentage, v.rate,
            v.currency, v.payable_hours_raw, v.line_amount
       from data_entries e join data_entry_versions v on v.id = e.current_version_id join devices d on d.id = v.device_id
      where e.id = any($3::uuid[])`,
    [bill.id, bill.revision, ids],
  );
  return ids.length;
}

async function recalcTotal(d: Db, billId: string): Promise<string> {
  const r = await one(
    d,
    `update bills b set total = coalesce((select sum(bl.line_amount) from bill_lines bl where ${CURRENT_LINES}), 0)
      where b.id = $1 returning total`,
    [billId],
  );
  return r.total;
}

async function decision(d: Db, billId: string, revision: number, kind: string, actor: Actor, reason?: string | null) {
  await d.query("insert into bill_decisions (bill_id, revision, decision, actor_id, reason) values ($1, $2, $3, $4, $5)", [
    billId, revision, kind, actor.id, reason ?? null,
  ]);
}

export async function createBill(actor: Actor, input: { pocId: string; currency: string; dateFrom: string; dateTo: string }) {
  requireAdmin(actor);
  const s = billScope(input);
  const id = await tx(async (d) => {
    const poc = await one(d, "select id from pocs where id = $1", [s.pocId]);
    if (!poc) throw invalid("INVALID_POC", "POC does not exist.");
    const bill = await one(
      d,
      `insert into bills (bill_number, type, poc_id, currency, date_from, date_to_inclusive, status, created_by)
       values ($1, 'STANDARD', $2, $3, $4, $5, 'DRAFT', $6) returning *`,
      [await nextBillNumber(d, "BILL"), s.pocId, s.currency, s.dateFrom, s.dateTo, actor.id],
    );
    const lines = await claimEligible(d, bill);
    const total = await recalcTotal(d, bill.id);
    await decision(d, bill.id, 1, "CREATED", actor);
    await audit(d, actor, "BILL_CREATED", "bill", bill.id, { after: { bill_number: bill.bill_number, lines, total, ...s } });
    return bill.id as string;
  });
  return getBill(id);
}

async function lockBill(d: Db, id: string, expectedVersion: number | undefined) {
  const bill = await one(d, "select * from bills where id = $1 for update", [id]);
  if (!bill) throw notFound("Bill");
  if (expectedVersion !== undefined && bill.version !== expectedVersion) throw staleVersion();
  return bill;
}

function requireStatus(bill: any, allowed: string[], action: string) {
  if (!allowed.includes(bill.status))
    throw conflict("INVALID_BILL_STATE", `A bill that is ${bill.status.replace(/_/g, " ").toLowerCase()} cannot be ${action}.`, { status: bill.status });
}

export async function excludeLines(actor: Actor, billId: string, input: { lineIds: string[]; expectedVersion: number }) {
  requireAdmin(actor);
  if (!Array.isArray(input.lineIds) || !input.lineIds.length) throw invalid("REQUIRED", "Select at least one line to exclude.");
  await tx(async (d) => {
    const bill = await lockBill(d, billId, input.expectedVersion);
    requireStatus(bill, ["DRAFT"], "edited");
    const removed = await q(
      d,
      `update bill_lines set active_reservation = false, removed_at = now(), removed_reason = 'EXCLUDED'
        where bill_id = $1 and bill_revision = $2 and removed_at is null and id = any($3::uuid[]) returning id`,
      [billId, bill.revision, input.lineIds],
    );
    if (removed.length !== new Set(input.lineIds).size) throw invalid("INVALID_LINES", "One or more lines are not on this bill.");
    const left = await one(d, "select count(*)::int as n from bill_lines where bill_id = $1 and bill_revision = $2 and removed_at is null", [billId, bill.revision]);
    if (!left.n) throw invalid("EMPTY_BILL", "A bill cannot be empty. Cancel the bill instead.");
    const total = await recalcTotal(d, billId);
    await d.query("update bills set version = version + 1, updated_at = now() where id = $1", [billId]);
    await decision(d, billId, bill.revision, "LINES_EXCLUDED", actor, `${removed.length} line(s) excluded`);
    await audit(d, actor, "BILL_LINES_EXCLUDED", "bill", billId, { before: { total: bill.total }, after: { total, lineIds: input.lineIds } });
  });
  return getBill(billId);
}

/** The cumulative baseline for an adjustment line: original amount and all prior approved deltas. */
async function adjustmentBaseline(d: Db, originalLineId: string) {
  const r = await one(
    d,
    `select ol.*, coalesce((select sum(al.line_amount) from bill_lines al join bills ab on ab.id = al.bill_id
                             where al.original_line_id = ol.id and ab.status = 'APPROVED' and al.bill_revision = ab.revision and al.removed_at is null), 0)::numeric(18,2) as prior
       from bill_lines ol where ol.id = $1`,
    [originalLineId],
  );
  return r as any;
}

async function insertAdjustmentLine(d: Db, billId: string, revision: number, originalLineId: string, correctedAmount: string, correctedHours: string | null) {
  const base = await adjustmentBaseline(d, originalLineId);
  const delta = dec(correctedAmount).minus(base.line_amount).minus(base.prior);
  if (delta.isZero())
    throw invalid("ZERO_ADJUSTMENT", `Line ${base.reference}: the corrected amount equals the current billed amount, so there is nothing to adjust.`);
  await d.query(
    `insert into bill_lines (bill_id, bill_revision, original_line_id, original_amount, prior_adjustments, corrected_amount, corrected_hours,
                             device_id, device_code, poc_id, reference, activity_date, hours, percentage, rate, currency, payable_hours_raw, line_amount)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [billId, revision, originalLineId, base.line_amount, base.prior, correctedAmount, correctedHours, base.device_id, base.device_code,
     base.poc_id, base.reference, base.activity_date, base.hours, base.percentage, base.rate, base.currency, base.payable_hours_raw, delta.toFixed(2)],
  );
}

/** FR-024: release the old revision's reservations and claim afresh, atomically, keeping the old lines as history. */
export async function regenerateBill(actor: Actor, billId: string, input: { expectedVersion: number }) {
  requireAdmin(actor);
  await tx(async (d) => {
    const bill = await lockBill(d, billId, input.expectedVersion);
    requireStatus(bill, ["DRAFT", "REJECTED", "NEEDS_REVIEW"], "regenerated");
    const old = await q(d, "select * from bill_lines where bill_id = $1 and bill_revision = $2 and removed_at is null", [billId, bill.revision]);
    await d.query("update bill_lines set active_reservation = false where bill_id = $1 and active_reservation", [billId]);
    const revision = bill.revision + 1;
    await d.query("update bills set revision = $2 where id = $1", [billId, revision]);
    if (bill.type === "STANDARD") await claimEligible(d, { ...bill, revision });
    else {
      if (!old.length) throw invalid("EMPTY_BILL", "This adjustment has no lines left. Cancel it instead.");
      for (const l of old) await insertAdjustmentLine(d, billId, revision, l.original_line_id, l.corrected_amount, l.corrected_hours);
    }
    const total = await recalcTotal(d, billId);
    if (bill.type === "ADJUSTMENT" && dec(total).isZero()) throw invalid("ZERO_ADJUSTMENT", "The adjustment nets to zero.");
    await d.query(
      "update bills set status = 'DRAFT', submitted_at = null, submitted_by = null, version = version + 1, updated_at = now() where id = $1",
      [billId],
    );
    await decision(d, billId, revision, "REGENERATED", actor);
    await audit(d, actor, "BILL_REGENERATED", "bill", billId, {
      before: { revision: bill.revision, status: bill.status, total: bill.total }, after: { revision, status: "DRAFT", total },
    });
  });
  return getBill(billId);
}

/** Re-checks that every line still matches its source before a state change that locks or freezes it. */
async function verifyLines(d: Db, bill: any) {
  const lines = await q(d, "select * from bill_lines where bill_id = $1 and bill_revision = $2 and removed_at is null", [bill.id, bill.revision]);
  if (!lines.length) throw invalid("EMPTY_BILL", "A bill cannot be empty.");
  const sum = lines.reduce((a, l) => a.plus(l.line_amount), dec(0));
  if (!sum.eq(bill.total)) throw conflict("BILL_OUT_OF_DATE", "Bill total no longer matches its lines. Regenerate the bill.");
  if (lines.some((l) => !l.active_reservation)) throw conflict("BILL_OUT_OF_DATE", "Some lines are no longer reserved. Regenerate the bill.");
  if (bill.type === "STANDARD") {
    const stale = await one(
      d,
      `select count(*)::int as n from bill_lines bl join data_entries e on e.id = bl.entry_id
        where bl.bill_id = $1 and bl.bill_revision = $2 and bl.removed_at is null
          and (e.status <> 'VALID' or e.current_version_id <> bl.entry_version_id)`,
      [bill.id, bill.revision],
    );
    if (stale.n) throw conflict("BILL_OUT_OF_DATE", "Some entries changed after this bill was prepared. Regenerate the bill.");
  } else {
    const original = await one(d, "select status from bills where id = $1", [bill.original_bill_id]);
    if (original?.status !== "APPROVED") throw conflict("BILL_OUT_OF_DATE", "The original bill is not approved.");
    for (const l of lines) {
      const base = await adjustmentBaseline(d, l.original_line_id);
      const delta = dec(l.corrected_amount).minus(base.line_amount).minus(base.prior);
      if (!dec(base.prior).eq(l.prior_adjustments) || !delta.eq(l.line_amount))
        throw conflict("STALE_BASELINE", "Another adjustment to the same line was approved since this one was prepared. Regenerate it.");
    }
    if (sum.isZero()) throw invalid("ZERO_ADJUSTMENT", "The adjustment nets to zero.");
  }
}

export async function submitBill(actor: Actor, billId: string, input: { expectedVersion: number }) {
  requireAdmin(actor);
  await tx(async (d) => {
    const bill = await lockBill(d, billId, input.expectedVersion);
    if (bill.status === "NEEDS_REVIEW")
      throw conflict("NEEDS_REGENERATION", "An entry on this bill changed. Regenerate the bill before submitting it.");
    requireStatus(bill, ["DRAFT"], "submitted");
    await verifyLines(d, bill);
    await d.query(
      "update bills set status = 'PENDING_APPROVAL', submitted_at = now(), submitted_by = $2, version = version + 1, updated_at = now() where id = $1",
      [billId, actor.id],
    );
    await decision(d, billId, bill.revision, "SUBMITTED", actor);
    await audit(d, actor, "BILL_SUBMITTED", "bill", billId, { before: { status: bill.status }, after: { status: "PENDING_APPROVAL", total: bill.total } });
  });
  return getBill(billId);
}

/** FR-023: approval verifies state, locks, versions and totals in one transaction, then freezes the bill for good. */
export async function approveBill(actor: Actor, billId: string, input: { expectedVersion: number; comment?: string | null }) {
  requireAdmin(actor);
  const settings = await getSettings();
  await tx(async (d) => {
    const bill = await lockBill(d, billId, input.expectedVersion);
    requireStatus(bill, ["PENDING_APPROVAL"], "approved");
    if (settings.require_separate_approver && bill.created_by === actor.id)
      throw forbidden("SEPARATE_APPROVER_REQUIRED", "A bill must be approved by an admin other than the one who prepared it.");
    await verifyLines(d, bill);
    const comment = typeof input.comment === "string" && input.comment.trim() ? input.comment.trim() : null;
    // An approved adjustment stops reserving its original lines so later adjustments can build on it.
    if (bill.type === "ADJUSTMENT") await d.query("update bill_lines set active_reservation = false where bill_id = $1 and active_reservation", [billId]);
    await d.query(
      `update bills set status = 'APPROVED', approved_by = $2, approved_at = now(), approval_comment = $3, version = version + 1, updated_at = now()
        where id = $1`,
      [billId, actor.id, comment],
    );
    await decision(d, billId, bill.revision, "APPROVED", actor, comment);
    await audit(d, actor, "BILL_APPROVED", "bill", billId, { reason: comment, before: { status: bill.status }, after: { status: "APPROVED", total: bill.total, revision: bill.revision } });
  });
  return getBill(billId);
}

export async function rejectBill(actor: Actor, billId: string, input: { expectedVersion: number; reason: string }) {
  requireAdmin(actor);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw invalid("REASON_REQUIRED", "A reason is required to reject a bill.");
  await tx(async (d) => {
    const bill = await lockBill(d, billId, input.expectedVersion);
    requireStatus(bill, ["PENDING_APPROVAL"], "rejected");
    await d.query("update bills set status = 'REJECTED', version = version + 1, updated_at = now() where id = $1", [billId]);
    await decision(d, billId, bill.revision, "REJECTED", actor, reason);
    await audit(d, actor, "BILL_REJECTED", "bill", billId, { reason, before: { status: bill.status }, after: { status: "REJECTED" } });
  });
  return getBill(billId);
}

/** Only unapproved, non-pending bills can be cancelled; a pending bill must be rejected first (8.6). */
export async function cancelBill(actor: Actor, billId: string, input: { expectedVersion: number; reason?: string | null }) {
  requireAdmin(actor);
  await tx(async (d) => {
    const bill = await lockBill(d, billId, input.expectedVersion);
    requireStatus(bill, ["DRAFT", "REJECTED", "NEEDS_REVIEW"], "cancelled");
    await d.query("update bill_lines set active_reservation = false where bill_id = $1 and active_reservation", [billId]);
    await d.query("update bills set status = 'CANCELLED', version = version + 1, updated_at = now() where id = $1", [billId]);
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
    await decision(d, billId, bill.revision, "CANCELLED", actor, reason);
    await audit(d, actor, "BILL_CANCELLED", "bill", billId, { reason, before: { status: bill.status }, after: { status: "CANCELLED" } });
  });
  return getBill(billId);
}

// ------------------------------------------------------------------ adjustments (section 8.7)

export interface AdjustmentInput {
  reason: string;
  lines: { originalLineId: string; correctedAmount?: string; correctedHours?: string }[];
}

export async function createAdjustment(actor: Actor, originalBillId: string, input: AdjustmentInput) {
  requireAdmin(actor);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw invalid("REASON_REQUIRED", "A reason is required for an adjustment.");
  if (!Array.isArray(input.lines) || !input.lines.length) throw invalid("REQUIRED", "Select at least one line to adjust.");
  if (new Set(input.lines.map((l) => l.originalLineId)).size !== input.lines.length)
    throw invalid("DUPLICATE_LINES", "Each original line can appear once in an adjustment.");
  const id = await tx(async (d) => {
    const original = await one(d, "select * from bills where id = $1 for share", [originalBillId]);
    if (!original) throw notFound("Bill");
    if (original.type !== "STANDARD" || original.status !== "APPROVED")
      throw conflict("INVALID_BILL_STATE", "Adjustments can only be raised against an approved standard bill.");
    const bill = await one(
      d,
      `insert into bills (bill_number, type, original_bill_id, poc_id, currency, date_from, date_to_inclusive, status, adjustment_reason, created_by)
       values ($1, 'ADJUSTMENT', $2, $3, $4, $5, $6, 'DRAFT', $7, $8) returning *`,
      [await nextBillNumber(d, "ADJ"), original.id, original.poc_id, original.currency, original.date_from, original.date_to_inclusive, reason, actor.id],
    );
    for (const l of [...input.lines].sort((a, b) => a.originalLineId.localeCompare(b.originalLineId))) {
      const ol = await one(
        d,
        "select * from bill_lines where id = $1 and bill_id = $2 and bill_revision = $3 and removed_at is null for update",
        [l.originalLineId, original.id, original.revision],
      );
      if (!ol) throw invalid("INVALID_LINES", "One or more lines are not on the original bill.");
      let correctedHours: string | null = null;
      let correctedAmount: string;
      if (l.correctedHours !== undefined && l.correctedHours !== null && l.correctedHours !== "") {
        correctedHours = /^0+(\.0+)?$/.test(String(l.correctedHours).trim()) ? "0.0000" : parseHours(l.correctedHours, "Corrected hours");
        correctedAmount = calculate(correctedHours, ol.percentage, ol.rate).lineAmount;
      } else {
        correctedAmount = parseMoney(l.correctedAmount, "Corrected amount", true);
      }
      await insertAdjustmentLine(d, bill.id, 1, ol.id, correctedAmount, correctedHours);
    }
    const total = await recalcTotal(d, bill.id);
    if (dec(total).isZero()) throw invalid("ZERO_ADJUSTMENT", "The adjustment nets to zero.");
    await decision(d, bill.id, 1, "CREATED", actor, reason);
    await audit(d, actor, "ADJUSTMENT_CREATED", "bill", bill.id, { reason, after: { bill_number: bill.bill_number, original: original.bill_number, total } });
    return bill.id as string;
  });
  return getBill(id);
}
