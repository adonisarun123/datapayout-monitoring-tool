import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listDevices, listDeviceTypes, listPocs, IMPORT_HEADERS } from "@/server/masters";
import { todayIST } from "@/lib/dates";
import { money, num, readParams, type SearchParams } from "@/lib/format";
import { Badge, Empty, FilterBar, Input, PageHead, Pager, Select } from "@/components/ui";
import { ApiForm } from "@/components/client";
import { ImportForm } from "@/components/import-form";

export default async function DevicesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const p = await readParams(searchParams);
  const [list, types, pocs] = await Promise.all([
    listDevices({ typeId: p.typeId, status: p.status, search: p.search, pocId: p.pocId, page: Number(p.page) || 1 }),
    listDeviceTypes(), listPocs(),
  ]);
  const admin = user.role === "ADMIN";
  const activeTypes = types.filter((t) => t.active).map((t) => ({ value: t.id, label: t.name }));
  return (
    <>
      <PageHead title="Devices" sub="Each row is one physical unit. Quantities are counts of device records." />
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        {types.map((t) => (
          <div className="stat" key={t.id}>
            <div className="label">{t.name}{t.active ? "" : " (inactive)"}</div>
            <div className="value">{t.device_count}</div>
            <div className="basis">{t.active_device_count} active</div>
          </div>
        ))}
      </div>
      <FilterBar clearHref="/devices">
        <Input name="search" labelText="Search" value={p.search} placeholder="Code, name or serial" />
        <Select name="typeId" labelText="Type" value={p.typeId} options={types.map((t) => ({ value: t.id, label: t.name }))} />
        <Select name="status" labelText="Status" value={p.status} options={["ACTIVE", "INACTIVE", "RETIRED"].map((s) => ({ value: s, label: s }))} />
        <Select name="pocId" labelText="Current POC" value={p.pocId} options={pocs.map((x) => ({ value: x.id, label: x.name }))} />
      </FilterBar>
      <div className="table-wrap">
        {list.rows.length ? (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th>Current POC</th><th className="num">Payout %</th><th className="num">Rate / payable hour</th></tr></thead>
            <tbody>
              {list.rows.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/devices/${d.id}`}>{d.code}</Link></td><td>{d.name}</td><td>{d.type_name}</td><td><Badge status={d.status} /></td>
                  <td>{d.poc_name ? <Link href={`/pocs/${d.poc_id}`}>{d.poc_name}</Link> : <span className="badge warn">No POC today</span>}</td>
                  <td className="num">{d.percentage ? num(d.percentage, 2) : <span className="badge warn">No rule today</span>}</td>
                  <td className="num">{d.rate ? money(d.currency, d.rate) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No devices match these filters.</Empty>}
      </div>
      <Pager path="/devices" params={p} page={list.page} pageSize={list.pageSize} total={list.total} />
      {admin ? (
        <div className="grid cols-2 no-print">
          <div className="card">
            <h2>Add a device</h2>
            <ApiForm path="/devices" submitLabel="Add device" redirect="/devices/:id" fields={[
              { name: "code", label: "Device code", required: true, help: "Unique, human-readable." },
              { name: "name", label: "Display name", required: true },
              { name: "typeId", label: "Type", type: "select", options: activeTypes, required: true },
              { name: "commissionedOn", label: "Commissioning date", type: "date", required: true, defaultValue: todayIST() },
              { name: "serial", label: "Serial number", help: "Optional; unique when given." },
              { name: "notes", label: "Notes", type: "textarea" },
            ]} />
          </div>
          <div className="card">
            <h2>Import devices from CSV</h2>
            <p className="small muted">Columns: {IMPORT_HEADERS.join(", ")}. The first four are required. Nothing is saved unless every row is valid.</p>
            <ImportForm />
          </div>
        </div>
      ) : null}
    </>
  );
}
