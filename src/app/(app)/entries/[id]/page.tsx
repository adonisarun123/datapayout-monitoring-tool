import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getEntry } from "@/server/entries";
import { money, num, when } from "@/lib/format";
import { Badge, PageHead } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { CorrectionForm } from "@/components/entry-form";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let data: Awaited<ReturnType<typeof getEntry>>;
  try { data = await getEntry(id); } catch { notFound(); }
  const { entry: e, versions } = data;
  const admin = user.role === "ADMIN";
  const locked = e.bill_status === "PENDING_APPROVAL" || e.bill_status === "APPROVED";
  return (
    <>
      <PageHead title={`Entry ${e.reference}`} sub={<><Link href={`/devices/${e.device_id}`}>{e.device_code}</Link> · {e.activity_date} · <Badge status={e.status} /> <Badge status={e.billing_state} /></>} />
      {e.status === "VOID" ? <div className="alert error" role="status">Voided {when(e.voided_at)} by {e.voided_by_name}. Reason: {e.void_reason}. It no longer counts towards hours or bills.</div> : null}
      <div className="grid cols-2">
        <div className="card">
          <h2>Current version (v{e.version_no})</h2>
          <dl className="kv">
            <dt>Device</dt><dd>{e.device_code} · {e.device_name} ({e.type_name})</dd>
            <dt>Activity date</dt><dd>{e.activity_date}</dd>
            <dt>Recorded hours</dt><dd>{num(e.hours)}</dd>
            <dt>Reference</dt><dd>{e.reference}</dd>
            <dt>Notes</dt><dd>{e.notes ?? ""}</dd>
            <dt>Submitted</dt><dd>{when(e.submitted_at)} by {e.created_by_name}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Terms captured at submission</h2>
          <dl className="kv">
            <dt>POC</dt><dd><Link href={`/pocs/${e.poc_id}`}>{e.poc_name}</Link></dd>
            <dt>Payout percentage</dt><dd>{num(e.percentage)}%</dd>
            <dt>Rate per payable hour</dt><dd>{money(e.currency, e.rate)}</dd>
            <dt>Payable hours</dt><dd>{num(e.payable_hours_raw)}</dd>
            <dt>Amount</dt><dd><strong>{money(e.currency, e.line_amount)}</strong></dd>
            <dt>Bill</dt><dd>{e.bill_id ? <Link href={`/bills/${e.bill_id}`}>{e.bill_number}</Link> : "Not on a bill"}</dd>
          </dl>
          <p className="small muted" style={{ marginTop: 8 }}>Later changes to rates or POC assignments do not change these figures.</p>
        </div>
      </div>
      <h2>Version history</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Version</th><th>When</th><th>By</th><th>Device</th><th>Date</th><th className="num">Hours</th><th>Reference</th><th>POC</th><th className="num">%</th><th className="num">Rate</th><th className="num">Amount</th><th>Reason</th></tr></thead>
        <tbody>{versions.map((v) => (
          <tr key={v.id}><td>v{v.version_no}</td><td className="nowrap">{when(v.created_at)}</td><td>{v.changed_by_name}</td><td>{v.device_code}</td><td className="nowrap">{v.activity_date}</td>
            <td className="num">{num(v.hours)}</td><td>{v.reference}</td><td>{v.poc_name}</td><td className="num">{num(v.percentage, 2)}</td><td className="num">{num(v.rate, 2)}</td>
            <td className="num">{money(v.currency, v.line_amount)}</td><td>{v.change_reason ?? (v.version_no === 1 ? "Original submission" : "")}</td></tr>
        ))}</tbody>
      </table></div>
      {admin && e.status === "VALID" ? (
        locked ? (
          <div className="alert info no-print">
            This entry is on bill <Link href={`/bills/${e.bill_id}`}>{e.bill_number}</Link>, which is {e.bill_status === "APPROVED" ? "approved" : "pending approval"}.{" "}
            {e.bill_status === "APPROVED" ? "Approved bills are corrected with an adjustment bill raised from the bill page." : "Reject the bill before correcting or voiding the entry."}
          </div>
        ) : (
          <div className="grid cols-2 no-print">
            <div className="card"><h2>Correct entry (admin)</h2><CorrectionForm entry={e} /></div>
            <div className="card">
              <h2>Void entry (admin)</h2>
              <p className="muted">Voiding keeps the entry, its history and its reference, but removes it from valid hours and from billing. The reference cannot be reused.</p>
              <ActionButton path={`/entries/${e.id}/void`} body={{ expectedVersion: e.version }} label="Void entry" kind="danger"
                confirmText="Void this entry? This cannot be undone." reason={{ field: "reason", label: "Reason", required: true }} />
            </div>
          </div>
        )
      ) : null}
      {!admin && e.status === "VALID" ? <p className="muted no-print">Submitted entries cannot be edited. Contact an administrator if this entry needs a correction.</p> : null}
    </>
  );
}
