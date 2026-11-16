import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listEntries } from "@/server/entries";
import { listDeviceTypes, listPocs } from "@/server/masters";
import { money, num, qs, readParams, when, type SearchParams } from "@/lib/format";
import { Badge, Empty, FilterBar, Input, PageHead, Pager, Select } from "@/components/ui";

const STATES = ["UNBILLED", "DRAFT", "NEEDS_REVIEW", "PENDING_APPROVAL", "REJECTED", "APPROVED", "VOID"];

export default async function EntriesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const p = await readParams(searchParams);
  const [list, types, pocs] = await Promise.all([
    listEntries({ dateFrom: p.dateFrom, dateTo: p.dateTo, deviceId: p.deviceId, typeId: p.typeId, pocId: p.pocId, createdBy: p.createdBy,
      status: p.status, billingState: p.billingState, reference: p.reference, page: Number(p.page) || 1 }).catch(() => null),
    listDeviceTypes(), listPocs(),
  ]);
  const canExport = user.role === "ADMIN" || user.canExport;
  return (
    <>
      <PageHead title="Entries" sub="Filtered by activity date (Asia/Kolkata). Each row shows the current version of the entry.">
        {canExport ? <a className="btn" href={`/api/v1/reports/entry-detail/export${qs({ dateFrom: p.dateFrom, dateTo: p.dateTo, deviceId: p.deviceId, typeId: p.typeId, pocId: p.pocId, status: p.status })}`}>Export CSV</a> : null}
        <Link className="btn primary" href="/entries/new">New entry</Link>
      </PageHead>
      <FilterBar clearHref="/entries">
        <Input name="dateFrom" labelText="Activity from" type="date" value={p.dateFrom} />
        <Input name="dateTo" labelText="Activity to" type="date" value={p.dateTo} />
        <Select name="typeId" labelText="Device type" value={p.typeId} options={types.map((t) => ({ value: t.id, label: t.name }))} />
        <Select name="pocId" labelText="POC" value={p.pocId} options={pocs.map((x) => ({ value: x.id, label: x.name }))} />
        <Select name="status" labelText="Status" value={p.status} options={[{ value: "VALID", label: "Valid" }, { value: "VOID", label: "Void" }]} />
        <Select name="billingState" labelText="Billing state" value={p.billingState} options={STATES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))} />
        <Input name="reference" labelText="Reference" value={p.reference} />
        {p.deviceId ? <input type="hidden" name="deviceId" value={p.deviceId} /> : null}
      </FilterBar>
      {!list ? <div className="alert error" role="alert">One of the filters is not valid. Clear the filters and try again.</div> : (
        <>
          <div className="table-wrap">
            {list.rows.length ? (
              <table>
                <thead><tr><th>Activity date</th><th>Device</th><th>Type</th><th>POC (at entry)</th><th>Reference</th><th className="num">Hours</th>
                  <th className="num">Payable hours</th><th className="num">Amount</th><th>Entered by</th><th>Billing</th></tr></thead>
                <tbody>{list.rows.map((e) => (
                  <tr key={e.id} style={e.status === "VOID" ? { opacity: 0.6 } : undefined}>
                    <td className="nowrap"><Link href={`/entries/${e.id}`}>{e.activity_date}</Link></td>
                    <td><Link href={`/devices/${e.device_id}`}>{e.device_code}</Link></td><td>{e.type_name}</td><td>{e.poc_name}</td><td>{e.reference}</td>
                    <td className="num">{num(e.hours)}</td><td className="num">{num(e.payable_hours_raw)}</td>
                    <td className="num">{money(e.currency, e.line_amount)}{Number(e.rate) === 0 || Number(e.percentage) === 0 ? <> <span className="badge bad">Zero terms</span></> : null}</td>
                    <td><span title={when(e.submitted_at)}>{e.created_by_name}</span></td>
                    <td><Badge status={e.billing_state} />{e.bill_number ? <> <Link className="small" href={`/bills/${e.bill_id}`}>{e.bill_number}</Link></> : null}</td>
                  </tr>
                ))}</tbody>
                <tfoot>{list.totals.map((t) => (
                  <tr key={t.currency}><td colSpan={5}>Total for all {t.entries} valid entries matching the filters ({t.currency})</td>
                    <td className="num">{num(t.hours)}</td><td className="num">{num(t.payable_hours)}</td><td className="num">{money(t.currency, t.amount)}</td><td colSpan={2} /></tr>
                ))}</tfoot>
              </table>
            ) : <Empty>No entries match these filters.</Empty>}
          </div>
          <Pager path="/entries" params={p} page={list.page} pageSize={list.pageSize} total={list.total} />
        </>
      )}
    </>
  );
}
