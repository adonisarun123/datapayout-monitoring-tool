import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getBill } from "@/server/bills";
import { getSettings } from "@/server/settings";
import { sumMoney } from "@/server/calc";
import { todayIST } from "@/lib/dates";
import { money, num, when } from "@/lib/format";
import { Badge, Empty, PageHead } from "@/components/ui";
import { ActionButton, ApiForm, PrintButton } from "@/components/client";
import { AdjustmentForm, ExcludeLines } from "@/components/bill-forms";

export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let data: Awaited<ReturnType<typeof getBill>>;
  try { data = await getBill(id); } catch { notFound(); }
  const { bill: b, lines, removedLines, decisions, payments, adjustments, deviceSubtotals, revisions } = data;
  const settings = await getSettings();
  const admin = user.role === "ADMIN";
  const canExport = admin || user.canExport;
  const adj = b.type === "ADJUSTMENT";
  const v = { expectedVersion: b.version };
  const approved = b.status === "APPROVED";
  const payable = approved && Number(b.total) > 0;
  const selfApprovalBlocked = settings.require_separate_approver && b.created_by === user.id;
  return (
    <>
      <PageHead title={`${adj ? "Adjustment" : "Bill"} ${b.bill_number}`}
        sub={<>{settings.organization_name} · {adj ? "Adjustment statement" : "Payout statement"} · not a tax invoice</>}>
        <PrintButton />
        {canExport ? <><a className="btn" href={`/api/v1/bills/${b.id}/export?format=pdf`}>PDF</a><a className="btn" href={`/api/v1/bills/${b.id}/export?format=csv`}>CSV</a></> : null}
      </PageHead>

      <div className={`alert ${approved ? "ok" : b.status === "CANCELLED" || b.status === "REJECTED" ? "error" : "warn"}`} role="status">
        <strong>{approved ? "APPROVED" : `NOT APPROVED: ${b.status.replace(/_/g, " ")}`}</strong>
        {approved ? <> by {b.approved_by_name} on {when(b.approved_at)}. Figures are final.</> : null}
        {b.status === "NEEDS_REVIEW" ? <> An entry on this bill was corrected or voided. Regenerate the bill before submitting it.</> : null}
        {b.status === "PENDING_APPROVAL" ? <> Lines are locked. Entries on this bill cannot be corrected until it is rejected.</> : null}
        {b.status === "REJECTED" ? <> Entries stay reserved for this bill and can be corrected. Regenerate it to resubmit, or cancel it to free the entries.</> : null}
        {b.status === "DRAFT" ? <> Review the lines, then submit for approval.</> : null}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <dl className="kv">
            <dt>POC</dt><dd><Link href={`/pocs/${b.poc_id}`}>{b.poc_name}</Link></dd>
            <dt>Activity period</dt><dd>{b.date_from} to {b.date_to_inclusive} (inclusive, Asia/Kolkata)</dd>
            <dt>Currency</dt><dd>{b.currency}</dd>
            {adj ? <><dt>Adjusts</dt><dd><Link href={`/bills/${b.original_bill_id}`}>{b.original_bill_number}</Link></dd><dt>Reason</dt><dd>{b.adjustment_reason}</dd></> : null}
            <dt>Revision</dt><dd>{b.revision}</dd>
            <dt>Prepared by</dt><dd>{b.created_by_name}, {when(b.created_at)}</dd>
            {b.submitted_at ? <><dt>Submitted</dt><dd>{b.submitted_by_name}, {when(b.submitted_at)}</dd></> : null}
            {b.approval_comment ? <><dt>Approval comment</dt><dd>{b.approval_comment}</dd></> : null}
          </dl>
        </div>
        <div className="card">
          <dl className="kv">
            <dt>{adj ? "Adjustment total" : "Total"}</dt><dd><strong style={{ fontSize: 18 }}>{money(b.currency, b.total)}</strong></dd>
            {payable ? <>
              <dt>Paid</dt><dd>{money(b.currency, b.paid)}</dd>
              <dt>Outstanding</dt><dd><strong>{money(b.currency, b.outstanding)}</strong> <Badge status={b.payment_status} /></dd>
            </> : null}
            {b.payment_status === "CREDIT" ? <><dt>Treatment</dt><dd><Badge status="CREDIT" /> Reconcile outside this tool. It is not offset against other bills automatically.</dd></> : null}
          </dl>
          <p className="small muted" style={{ marginTop: 10 }}>Each line is rounded half up to 2 decimals, then lines are summed. Payout before any taxes or other adjustments.</p>
        </div>
      </div>

      {admin ? (
        <div className="card no-print">
          <h2>Actions</h2>
          <div className="actions" style={{ alignItems: "flex-start" }}>
            {b.status === "DRAFT" ? <ActionButton path={`/bills/${b.id}/submit`} body={v} label="Submit for approval" kind="primary" confirmText="Submit this bill? Its lines will be locked and its entries cannot be corrected until it is rejected." /> : null}
            {["DRAFT", "NEEDS_REVIEW", "REJECTED"].includes(b.status) ? <ActionButton path={`/bills/${b.id}/regenerate`} body={v} label="Regenerate" confirmText={adj ? "Recalculate this adjustment against the current baseline?" : "Release the current lines and rebuild this bill from all entries now eligible for this POC, currency and period? The current lines are kept as a past revision."} /> : null}
            {b.status === "PENDING_APPROVAL" ? (
              selfApprovalBlocked ? <span className="badge warn">You prepared this bill; another admin must approve it</span>
                : <ActionButton path={`/bills/${b.id}/approve`} body={v} label="Approve" kind="primary" confirmText={`Approve ${b.bill_number} for ${money(b.currency, b.total)}? Approval is final: the bill can never be edited, cancelled or deleted afterwards.`} reason={{ field: "comment", label: "Approval comment (optional)" }} />
            ) : null}
            {b.status === "PENDING_APPROVAL" ? <ActionButton path={`/bills/${b.id}/reject`} body={v} label="Reject" kind="danger" reason={{ field: "reason", label: "Reason for rejection", required: true }} /> : null}
            {["DRAFT", "NEEDS_REVIEW", "REJECTED"].includes(b.status) ? <ActionButton path={`/bills/${b.id}/cancel`} body={v} label="Cancel bill" kind="danger" confirmText="Cancel this bill and release its entries? A cancelled bill is kept as history and cannot be approved." reason={{ field: "reason", label: "Reason (optional)" }} /> : null}
            {approved || b.status === "CANCELLED" ? <span className="muted">{approved ? "Approved bills cannot be edited, cancelled or deleted. Correct errors with an adjustment below." : "This bill is cancelled."}</span> : null}
          </div>
          {b.status === "DRAFT" && !adj && lines.length > 1 ? (
            <div style={{ marginTop: 12 }}><ExcludeLines billId={b.id} version={b.version} lines={lines.map((l) => ({ id: l.id, label: `${l.activity_date} · ${l.device_code} · ${l.reference} · ${money(l.currency, l.line_amount)}` }))} /></div>
          ) : null}
        </div>
      ) : null}

      <h2>Lines ({lines.length})</h2>
      <div className="table-wrap">
        {lines.length ? (
          <table>
            <thead><tr><th>Activity date</th><th>Device</th><th>Reference</th><th className="num">Hours</th><th className="num">Payout %</th><th className="num">Rate</th>
              {adj ? <><th className="num">Original</th><th className="num">Prior adjustments</th><th className="num">Corrected to</th><th className="num">Adjustment</th></>
                : <><th className="num">Payable hours</th><th className="num">Amount</th>{approved ? <th className="num">Approved adjustments</th> : null}</>}</tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id}>
                <td className="nowrap">{l.activity_date}</td><td>{l.device_code}</td>
                <td>{l.entry_id ? <Link href={`/entries/${l.entry_id}`}>{l.reference}</Link> : l.reference}</td>
                <td className="num">{num(l.hours)}{l.corrected_hours ? <div className="small muted">corrected to {num(l.corrected_hours)}</div> : null}</td>
                <td className="num">{num(l.percentage, 2)}</td><td className="num">{num(l.rate, 2)}</td>
                {adj ? <><td className="num">{money(l.currency, l.original_amount)}</td><td className="num">{money(l.currency, l.prior_adjustments)}</td><td className="num">{money(l.currency, l.corrected_amount)}</td><td className="num"><strong>{money(l.currency, l.line_amount)}</strong></td></>
                  : <><td className="num">{num(l.payable_hours_raw)}</td><td className="num">{money(l.currency, l.line_amount)}</td>{approved ? <td className="num">{Number(l.approved_adjustments) !== 0 ? money(l.currency, l.approved_adjustments) : ""}</td> : null}</>}
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={adj ? 9 : 7}>Total</td><td className="num">{money(b.currency, b.total)}</td>{!adj && approved ? <td /> : null}</tr></tfoot>
          </table>
        ) : <Empty>This bill has no current lines.</Empty>}
      </div>

      {!adj && deviceSubtotals.length ? (
        <>
          <h2>Device subtotals</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Device</th><th className="num">Lines</th><th className="num">Hours</th><th className="num">Amount</th></tr></thead>
            <tbody>{deviceSubtotals.map((s) => <tr key={s.device_code}><td>{s.device_code}</td><td className="num">{s.lines}</td><td className="num">{num(s.hours)}</td><td className="num">{money(b.currency, s.amount)}</td></tr>)}</tbody>
          </table></div>
        </>
      ) : null}

      {approved && payable ? (
        <>
          <h2>Payment ledger</h2>
          <p className="small muted">Records of payments made outside this tool. Recording a payment here does not move any money.</p>
          <div className="table-wrap">
            {payments.length ? (
              <table>
                <thead><tr><th>Payment date</th><th>Kind</th><th className="num">Amount</th><th>Method</th><th>Reference</th><th>Note / reason</th><th>Recorded by</th>{admin ? <th className="no-print" /> : null}</tr></thead>
                <tbody>{payments.map((p) => (
                  <tr key={p.id}><td>{p.payment_date}</td><td><Badge status={p.kind === "REVERSAL" ? "REVERSAL" : "PAID"} text={p.kind === "REVERSAL" ? "Reversal" : "Payment"} /></td>
                    <td className="num">{p.kind === "REVERSAL" ? "−" : ""}{money(b.currency, p.amount)}</td><td>{p.method}</td><td>{p.reference}</td><td>{p.reason ?? p.note ?? ""}</td>
                    <td>{p.recorded_by_name}<div className="small muted">{when(p.created_at)}</div></td>
                    {admin ? <td className="no-print">{p.kind === "PAYMENT" && !p.reversed_by ? <ActionButton path={`/payments/${p.id}/reversals`} label="Reverse" kind="danger" confirmText="Record a reversal of this payment? Both records stay in the ledger. This does not reverse any bank transfer." reason={{ field: "reason", label: "Reason", required: true }} /> : p.reversed_by ? <span className="muted small">Reversed</span> : null}</td> : null}</tr>
                ))}</tbody>
              </table>
            ) : <Empty>No payments recorded.</Empty>}
          </div>
          {admin && Number(b.outstanding) > 0 ? (
            <div className="card no-print">
              <h3>Record a payment</h3>
              <ApiForm path={`/bills/${b.id}/payments`} submitLabel="Record payment" successText="Payment recorded." fields={[
                { name: "paymentDate", label: "Payment date", type: "date", required: true, defaultValue: todayIST() },
                { name: "amount", label: `Amount (${b.currency})`, type: "number", required: true, defaultValue: b.outstanding, help: `Outstanding: ${money(b.currency, b.outstanding)}. Cannot exceed it.` },
                { name: "method", label: "Method", required: true, placeholder: "NEFT, UPI, cheque…" },
                { name: "reference", label: "Payment reference", required: true, help: "Transaction reference only. Never bank credentials." },
                { name: "note", label: "Note", type: "textarea" },
              ]} />
            </div>
          ) : null}
        </>
      ) : null}

      {!adj && approved ? (
        <>
          <h2>Adjustments</h2>
          <div className="table-wrap">
            {adjustments.length ? (
              <table><thead><tr><th>Adjustment</th><th>Status</th><th>Reason</th><th className="num">Amount</th><th>Payment</th></tr></thead>
                <tbody>{adjustments.map((a) => <tr key={a.id}><td><Link href={`/bills/${a.id}`}>{a.bill_number}</Link></td><td><Badge status={a.status} /></td><td>{a.adjustment_reason}</td><td className="num">{money(a.currency, a.total)}</td><td><Badge status={a.payment_status} /></td></tr>)}</tbody></table>
            ) : <Empty>No adjustments raised against this bill.</Empty>}
          </div>
          {admin ? (
            <div className="card no-print">
              <details className="fold"><summary>Raise an adjustment</summary>
                <AdjustmentForm billId={b.id} currency={b.currency} lines={lines.map((l) => ({
                  id: l.id, label: `${l.activity_date} · ${l.device_code} · ${l.reference}`, hours: l.hours,
                  current: sumMoney([l.line_amount, l.approved_adjustments]), busy: l.adjustment_in_progress,
                }))} />
              </details>
            </div>
          ) : null}
        </>
      ) : null}

      <h2>History</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>Revision</th><th>Event</th><th>By</th><th>Reason / comment</th></tr></thead>
        <tbody>{decisions.map((d) => <tr key={d.id}><td className="nowrap">{when(d.created_at)}</td><td>{d.revision}</td><td>{d.decision.replace(/_/g, " ").toLowerCase()}</td><td>{d.actor_name}</td><td>{d.reason ?? ""}</td></tr>)}</tbody>
      </table></div>
      {removedLines.length ? (
        <details className="fold no-print"><summary>Past revisions and removed lines ({removedLines.length}); revisions: {revisions.map((r) => `r${r.revision}: ${r.lines} lines`).join(", ")}</summary>
          <div className="table-wrap"><table>
            <thead><tr><th>Revision</th><th>Activity date</th><th>Device</th><th>Reference</th><th className="num">Hours</th><th className="num">Amount</th><th>Why not current</th></tr></thead>
            <tbody>{removedLines.map((l) => <tr key={l.id}><td>{l.bill_revision}</td><td>{l.activity_date}</td><td>{l.device_code}</td><td>{l.reference}</td><td className="num">{num(l.hours)}</td><td className="num">{money(l.currency, l.line_amount)}</td>
              <td>{l.removed_reason ? l.removed_reason.replace(/_/g, " ").toLowerCase() : "superseded by regeneration"}</td></tr>)}</tbody>
          </table></div>
        </details>
      ) : null}
    </>
  );
}
