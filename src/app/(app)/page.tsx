import Link from "next/link";
import { requireUser } from "@/lib/session";
import { dashboard } from "@/server/reports";
import { listDeviceTypes, listPocs } from "@/server/masters";
import { money, num, qs, readParams, type SearchParams } from "@/lib/format";
import { FilterBar, Input, PageHead, Select } from "@/components/ui";

function Stat({ label, basis, rows, render, href }: { label: string; basis: string; rows: any[]; render: (r: any) => React.ReactNode; href?: string }) {
  return (
    <div className="stat">
      <div className="label">{href ? <Link href={href}>{label}</Link> : label}</div>
      {rows.length ? rows.map((r, i) => <div className="value" key={i}>{render(r)}</div>) : <div className="value muted">None</div>}
      <div className="basis">{basis}</div>
    </div>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  await requireUser();
  const p = await readParams(searchParams);
  let d: Awaited<ReturnType<typeof dashboard>>;
  let filterError: string | null = null;
  try { d = await dashboard(p); } catch (e: any) { filterError = e.message; d = await dashboard({}); }
  const [types, pocs] = await Promise.all([listDeviceTypes(), listPocs()]);
  const range = d.filters.dateFrom || d.filters.dateTo ? `${d.filters.dateFrom ?? "start"} to ${d.filters.dateTo ?? "today"}` : "all dates";
  const entryQs = qs({ dateFrom: d.filters.dateFrom, dateTo: d.filters.dateTo, typeId: d.filters.typeId, pocId: d.filters.pocId });
  return (
    <>
      <PageHead title="Dashboard" sub={`Showing ${range}. All dates and times are Asia/Kolkata. Amounts are never combined across currencies.`} />
      {filterError ? <div className="alert error" role="alert">{filterError}</div> : null}
      <FilterBar clearHref="/">
        <Input name="dateFrom" labelText="From" type="date" value={p.dateFrom} />
        <Input name="dateTo" labelText="To" type="date" value={p.dateTo} />
        <Select name="typeId" labelText="Device type" value={p.typeId} options={types.map((t) => ({ value: t.id, label: t.name }))} />
        <Select name="pocId" labelText="POC" value={p.pocId} options={pocs.map((x) => ({ value: x.id, label: x.name }))} />
      </FilterBar>

      <h2>Activity</h2>
      <div className="grid cols-4" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="label"><Link href={`/entries${entryQs}`}>Recorded hours</Link></div>
          <div className="value">{num(d.totalHours.hours)}</div>
          <div className="basis">{d.totalHours.entries} valid entries, by activity date</div>
        </div>
        <Stat label="Payable hours" basis="Hours × payout %, by activity date" rows={d.hours} render={(r) => <>{num(r.payable_hours)} <span className="small muted">({r.currency} terms)</span></>} />
        <Stat label="Estimated unbilled value" basis="Valid entries not on any active bill, by activity date. An estimate, not an approved liability."
          rows={d.unbilled} render={(r) => money(r.currency, r.value)} href={`/entries${qs({ dateFrom: d.filters.dateFrom, dateTo: d.filters.dateTo, pocId: d.filters.pocId, billingState: "UNBILLED" })}`} />
        <div className="stat">
          <div className="label"><Link href="/devices">Devices</Link></div>
          <div className="value">{d.counts.active_devices} active</div>
          <div className="basis">{d.counts.devices} device records in total, {d.counts.pocs} active POCs</div>
        </div>
      </div>

      <h2>Billing</h2>
      <div className="grid cols-4" style={{ marginBottom: 20 }}>
        <Stat label="Pending approval" basis="Current queue, not date filtered" rows={d.pending} href="/bills?status=PENDING_APPROVAL"
          render={(r) => <>{money(r.currency, r.value)} <span className="small muted">({r.bills} bill{r.bills === 1 ? "" : "s"})</span></>} />
        <Stat label="Approved bill value" basis="Positive bills, by approval date" rows={d.approved.filter((r) => r.bills > 0)} href="/bills?status=APPROVED"
          render={(r) => <>{money(r.currency, r.value)} <span className="small muted">({r.bills})</span></>} />
        <Stat label="Payments" basis="Payments less reversals, by payment date" rows={d.payments} render={(r) => money(r.currency, r.net)} href="/reports/payment-ledger" />
        <Stat label="Outstanding" basis="Approved positive bills less net payments, as of now" rows={d.outstanding.filter((r) => Number(r.value) !== 0)} href="/bills?status=APPROVED&paymentStatus=UNPAID"
          render={(r) => <>{money(r.currency, r.value)} <span className="small muted">({r.bills})</span></>} />
        <Stat label="Credits" basis="Approved negative adjustments, by approval date. Shown separately; never subtracted from outstanding automatically."
          rows={d.approved.filter((r) => r.credit_bills > 0)} href="/bills?paymentStatus=CREDIT"
          render={(r) => <>{money(r.currency, r.credits)} <span className="small muted">({r.credit_bills})</span></>} />
        <div className="stat">
          <div className="label"><Link href="/bills">Open drafts</Link></div>
          <div className="value">{d.counts.open_drafts}</div>
          <div className="basis">Draft, rejected or needs-review bills</div>
        </div>
      </div>
    </>
  );
}
