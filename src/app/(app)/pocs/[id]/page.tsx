import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getPoc } from "@/server/masters";
import { listBills } from "@/server/bills";
import { todayIST } from "@/lib/dates";
import { money } from "@/lib/format";
import { Badge, Empty, PageHead } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function PocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let data: Awaited<ReturnType<typeof getPoc>>;
  try { data = await getPoc(id); } catch { notFound(); }
  const { poc, assignments } = data;
  const bills = await listBills({ pocId: id, pageSize: 200 });
  const today = todayIST();
  const current = assignments.filter((a) => a.valid_from <= today && (!a.valid_to_exclusive || a.valid_to_exclusive > today));
  return (
    <>
      <PageHead title={poc.name} sub={<>{poc.organization ?? "No organization"} · <Badge status={poc.active ? "ACTIVE" : "INACTIVE"} /></>}>
        <Link className="btn" href={`/entries?pocId=${poc.id}`}>Entries</Link>
        <Link className="btn" href={`/reports/poc-statement?pocId=${poc.id}`}>Statement</Link>
        {user.role === "ADMIN" ? <Link className="btn primary" href={`/bills/new?pocId=${poc.id}`}>New bill</Link> : null}
      </PageHead>
      <div className="grid cols-2">
        <div className="card">
          <h2>Contact</h2>
          <dl className="kv"><dt>Phone</dt><dd>{poc.phone ?? ""}</dd><dt>Email</dt><dd>{poc.email ?? ""}</dd><dt>Notes</dt><dd>{poc.notes ?? ""}</dd></dl>
        </div>
        {user.role === "ADMIN" ? (
          <div className="card no-print">
            <details className="fold"><summary>Edit POC</summary>
              <ApiForm path={`/pocs/${poc.id}`} method="PATCH" submitLabel="Save changes" extra={{ version: poc.version }} resetOnSuccess={false} fields={[
                { name: "name", label: "Name", required: true, defaultValue: poc.name }, { name: "organization", label: "Organization", defaultValue: poc.organization ?? "" },
                { name: "phone", label: "Phone", defaultValue: poc.phone ?? "" }, { name: "email", label: "Email", type: "email", defaultValue: poc.email ?? "" },
                { name: "active", label: "Active (can receive new device assignments)", type: "checkbox", defaultValue: poc.active },
                { name: "notes", label: "Notes", type: "textarea", defaultValue: poc.notes ?? "" },
              ]} />
            </details>
          </div>
        ) : null}
      </div>
      <h2>Devices assigned today ({current.length})</h2>
      <div className="table-wrap">
        {current.length ? (
          <table><thead><tr><th>Device</th><th>Name</th><th>Since</th><th>Until (exclusive)</th></tr></thead>
            <tbody>{current.map((a) => <tr key={a.id}><td><Link href={`/devices/${a.device_id}`}>{a.device_code}</Link></td><td>{a.device_name}</td><td>{a.valid_from}</td><td>{a.valid_to_exclusive ?? "Open"}</td></tr>)}</tbody></table>
        ) : <Empty>No devices assigned today.</Empty>}
      </div>
      <h2>Assignment history</h2>
      <div className="table-wrap">
        {assignments.length ? (
          <table><thead><tr><th>Device</th><th>From (inclusive)</th><th>To (exclusive)</th><th>Reason</th></tr></thead>
            <tbody>{assignments.map((a) => <tr key={a.id}><td><Link href={`/devices/${a.device_id}`}>{a.device_code}</Link></td><td>{a.valid_from}</td><td>{a.valid_to_exclusive ?? "Open"}</td><td>{a.reason ?? ""}</td></tr>)}</tbody></table>
        ) : <Empty>No assignment history.</Empty>}
      </div>
      <h2>Bills</h2>
      <div className="table-wrap">
        {bills.rows.length ? (
          <table><thead><tr><th>Bill</th><th>Period</th><th>Status</th><th className="num">Total</th><th className="num">Outstanding</th><th>Payment</th></tr></thead>
            <tbody>{bills.rows.map((b) => (
              <tr key={b.id}><td><Link href={`/bills/${b.id}`}>{b.bill_number}</Link></td><td>{b.date_from} to {b.date_to_inclusive}</td><td><Badge status={b.status} /></td>
                <td className="num">{money(b.currency, b.total)}</td><td className="num">{b.payment_status && b.payment_status !== "CREDIT" ? money(b.currency, b.outstanding) : ""}</td><td><Badge status={b.payment_status} /></td></tr>
            ))}</tbody></table>
        ) : <Empty>No bills for this POC yet.</Empty>}
      </div>
    </>
  );
}
