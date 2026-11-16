import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { REPORTS, runReport, type Report } from "@/server/reports";
import { listDeviceTypes, listPocs } from "@/server/masters";
import { qs, readParams, when, type SearchParams } from "@/lib/format";
import { Empty, FilterBar, Input, PageHead, Select } from "@/components/ui";
import { PrintButton } from "@/components/client";

const cell = (v: unknown) => (v instanceof Date ? when(v) : v === null || v === undefined ? "" : String(v));

export default async function ReportPage({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: SearchParams }) {
  const user = await requireUser();
  const { report: key } = await params;
  if (!REPORTS[key]) notFound();
  const p = await readParams(searchParams);
  const filters = { dateFrom: p.dateFrom, dateTo: p.dateTo, typeId: p.typeId, deviceId: p.deviceId, pocId: p.pocId, status: p.status };
  let report: Report | null = null;
  let error: string | null = null;
  try { report = await runReport(key, filters); } catch (e: any) { error = e.message; }
  const [types, pocs] = await Promise.all([listDeviceTypes(), listPocs()]);
  const usesTypes = key === "device-utilization" || key === "entry-detail" || key === "poc-statement";
  return (
    <>
      <PageHead title={REPORTS[key]} sub={<Link href="/reports">All reports</Link>}>
        <PrintButton />
        {user.role === "ADMIN" || user.canExport ? <a className="btn primary" href={`/api/v1/reports/${key}/export${qs(filters)}`}>Export CSV</a> : null}
      </PageHead>
      <FilterBar clearHref={`/reports/${key}`}>
        <Input name="dateFrom" labelText="From" type="date" value={p.dateFrom} />
        <Input name="dateTo" labelText="To" type="date" value={p.dateTo} />
        {usesTypes ? <Select name="typeId" labelText="Device type" value={p.typeId} options={types.map((t) => ({ value: t.id, label: t.name }))} /> : null}
        <Select name="pocId" labelText="POC" value={p.pocId} options={pocs.map((x) => ({ value: x.id, label: x.name }))} />
      </FilterBar>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      {report ? (
        <>
          <div className="alert info" role="note"><strong>Date basis:</strong> {report.basis}</div>
          <div className="table-wrap">
            {report.rows.length ? (
              <table>
                <thead><tr>{report.columns.map((c) => <th key={c.key} className={c.numeric ? "num" : ""}>{c.label}</th>)}</tr></thead>
                <tbody>{report.rows.map((r, i) => <tr key={i}>{report!.columns.map((c) => <td key={c.key} className={c.numeric ? "num" : ""}>{cell(r[c.key])}</td>)}</tr>)}</tbody>
                {report.totals?.length ? (
                  <tfoot>{report.totals.map((t, i) => (
                    <tr key={i}>{report!.columns.map((c, j) => (
                      <td key={c.key} className={c.numeric ? "num" : ""}>{j === 0 ? `Total ${t.currency ?? ""}` : c.key === "currency" ? cell(t.currency) : c.numeric ? cell(t[c.key === "line_amount" ? "amount" : c.key]) : ""}</td>
                    ))}</tr>
                  ))}</tfoot>
                ) : null}
              </table>
            ) : <Empty>No records for these filters.</Empty>}
          </div>
          <p className="small muted">{report.rows.length.toLocaleString("en-IN")} rows. Generated {when(new Date())} for {user.name}.</p>
        </>
      ) : null}
    </>
  );
}
