import { one, tx } from "@/lib/db";
import { conflict, invalid, notFound } from "@/lib/errors";
import { requireDate, todayIST } from "@/lib/dates";
import { audit, requireAdmin, type Actor } from "./audit";
import { dec, parseMoney } from "./calc";
import { getBill } from "./bills";

async function netPaid(d: any, billId: string) {
  const r = await one(d, "select coalesce(sum(case when kind = 'PAYMENT' then amount else -amount end), 0) as net from payments where bill_id = $1", [billId]);
  return dec(r.net);
}

/** FR-027: a ledger record of a payment made elsewhere. The bill row is locked so two payments cannot overpay it. */
export async function recordPayment(
  actor: Actor,
  billId: string,
  input: { paymentDate: string; amount: string; method: string; reference: string; note?: string | null },
) {
  requireAdmin(actor);
  const amount = parseMoney(input.amount, "Amount");
  const paymentDate = requireDate(input.paymentDate, "Payment date");
  if (paymentDate > todayIST()) throw invalid("FUTURE_DATE", "Payment date cannot be in the future.");
  const method = String(input.method ?? "").trim();
  const reference = String(input.reference ?? "").trim();
  if (!method) throw invalid("REQUIRED", "Payment method is required.", { field: "method" });
  if (!reference) throw invalid("REQUIRED", "Payment reference is required.", { field: "reference" });
  await tx(async (d) => {
    const bill = await one(d, "select * from bills where id = $1 for update", [billId]);
    if (!bill) throw notFound("Bill");
    if (bill.status !== "APPROVED") throw conflict("BILL_NOT_APPROVED", "Payments can only be recorded against an approved bill.");
    if (!dec(bill.total).gt(0)) throw conflict("NOT_PAYABLE", "This bill has no positive amount payable. Negative adjustments are credits, not payments.");
    const outstanding = dec(bill.total).minus(await netPaid(d, billId));
    if (dec(amount).gt(outstanding))
      throw invalid("OVERPAYMENT", `Amount exceeds the outstanding balance of ${bill.currency} ${outstanding.toFixed(2)}.`, { outstanding: outstanding.toFixed(2) });
    const p = await one(
      d,
      `insert into payments (bill_id, kind, amount, payment_date, method, reference, note, recorded_by)
       values ($1, 'PAYMENT', $2, $3, $4, $5, $6, $7) returning *`,
      [billId, amount, paymentDate, method.slice(0, 100), reference.slice(0, 200), input.note?.toString().trim() || null, actor.id],
    );
    await audit(d, actor, "PAYMENT_RECORDED", "payment", p.id, { after: p });
  });
  return getBill(billId);
}

/** FR-028: a payment is never edited or deleted; it is reversed in full and, if needed, re-recorded. */
export async function reversePayment(actor: Actor, paymentId: string, input: { reason: string }) {
  requireAdmin(actor);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw invalid("REASON_REQUIRED", "A reason is required to reverse a payment.");
  const billId = await tx(async (d) => {
    const found = await one(d, "select bill_id from payments where id = $1", [paymentId]);
    if (!found) throw notFound("Payment");
    await d.query("select 1 from bills where id = $1 for update", [found.bill_id]);
    const payment = await one(d, "select * from payments where id = $1", [paymentId]);
    if (payment.kind !== "PAYMENT") throw conflict("NOT_REVERSIBLE", "A reversal cannot itself be reversed. Record a new payment instead.");
    const already = await one(d, "select 1 from payments where reversal_of = $1", [paymentId]);
    if (already) throw conflict("ALREADY_REVERSED", "This payment has already been reversed.");
    if ((await netPaid(d, payment.bill_id)).minus(payment.amount).isNegative())
      throw conflict("NEGATIVE_BALANCE", "Reversing this payment would make the paid balance negative.");
    const r = await one(
      d,
      `insert into payments (bill_id, kind, amount, payment_date, method, reference, reversal_of, reason, recorded_by)
       values ($1, 'REVERSAL', $2, $3, $4, $5, $6, $7, $8) returning *`,
      [payment.bill_id, payment.amount, todayIST(), payment.method, payment.reference, paymentId, reason, actor.id],
    );
    await audit(d, actor, "PAYMENT_REVERSED", "payment", paymentId, { reason, before: payment, after: r });
    return payment.bill_id as string;
  });
  return getBill(billId);
}
