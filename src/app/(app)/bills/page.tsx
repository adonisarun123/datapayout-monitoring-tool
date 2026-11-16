import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listBills } from "@/server/bills";
import { listPocs } from "@/server/masters";
import { money, readParams, when, type SearchParams } from "@/lib/format";
import { Badge, Empty, FilterBar, Input, PageHead, Pager, Select } from "@/components/ui";

const STATUSES = ["DRAFT", "NEEDS_REVIEW", "PENDING_APPROVAL", "REJECTED", "APPROVED", "CANCELLED"];

export default async function BillsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const p = await readParams(searchParams);
  const [list, pocs, queue] = await Promise.all([
    listBills({ status: p.status, pocId: p.pocId, type: p.type, paymentStatus: p.paymentStatus, approvedFrom: p.approvedFrom, approvedTo: p.approvedTo, page: Number(p.page) || 1 }).catch(() => null),
    listPocs(), listBills({ status: "PENDING_APPROVAL", pageSize: 1 }),
  ]);
  const opt = (a: string[]) => a.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }));
  return (
    <>
      <PageHead title="Bills" sub="A bill is a payout statement for one POC, currency and activity period. Approval and payment are separate steps.">
        <Link className="btn" href="/bills?status=PENDING_APPROVAL">Approval queue ({queue.total})</Link>
        {user.role === "ADMIN" ? <Link className="btn primary" href="/bills/new">New bill</Link> : null}
      </PageHead>
      <FilterBar clearHref="/bills">
        <Select name="status" labelText="Status" value={p.status} options={opt(STATUSES)} />
        <Select name="paymentStatus" labelText="Payment" value={p.paymentStatus} options={opt(["UNPAID", "PARTIALLY_PAID", "PAID", "CREDIT"])} />
        <Select name="type" labelText="Type" value={p.type} options={opt(["STANDARD", "ADJUSTMENT"])} />
        <Select name="pocId" labelText="POC" value={p.pocId} options={pocs.map((x) => ({ value: x.id, label: x.name }))} />
        <Input name="approvedFrom" labelText="Approved from" type="date" value={p.approvedFrom} />
        <Input name="approvedTo" labelText="Approved to" type="date" value={p.approvedTo} />
      </FilterBar>
      {!list ? <div className="alert error" role="alert">One of the filters is not valid. Clear the filters and try again.</div> : (
        <>
          <div className="table-wrap">
            {list.rows.length ? (
              <table>
                <thead><tr><th>Bill</th><th>Type</th><th>POC</th><th>Activity period</th><th>Status</th><th className="num">Total</th><th className="num">Outstanding</th><th>Payment</th><th>Approved</th></tr></thead>
                <tbody>{list.rows.map((b) => (
                  <tr key={b.id}>
                    <td><Link href={`/bills/${b.id}`}>{b.bill_number}</Link></td>
                    <td>{b.type === "ADJUSTMENT" ? <>Adjustment of {b.original_bill_number}</> : "Standard"}</td>
                    <td>{b.poc_name}</td><td className="nowrap">{b.date_from} to {b.date_to_inclusive}</td><td><Badge status={b.status} /></td>
                    <td className="num">{money(b.currency, b.total)}</td>
                    <td className="num">{b.payment_status && b.payment_status !== "CREDIT" ? money(b.currency, b.outstanding) : ""}</td>
                    <td><Badge status={b.payment_status} /></td>
                    <td className="nowrap">{b.approved_at ? <>{when(b.approved_at)}<div className="small muted">{b.approved_by_name}</div></> : ""}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <Empty>No bills match these filters.</Empty>}
          </div>
          <Pager path="/bills" params={p} page={list.page} pageSize={list.pageSize} total={list.total} />
        </>
      )}
    </>
  );
}
