import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listPocs } from "@/server/masters";
import { readParams, type SearchParams } from "@/lib/format";
import { Badge, Empty, FilterBar, Input, PageHead, Select } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function PocsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const p = await readParams(searchParams);
  const pocs = await listPocs({ search: p.search, active: p.active ? p.active === "true" : undefined });
  return (
    <>
      <PageHead title="POCs" sub="Points of contact. By default the POC is also the payee. POCs are contact records, not user accounts." />
      <FilterBar clearHref="/pocs">
        <Input name="search" labelText="Search" value={p.search} placeholder="Name or organization" />
        <Select name="active" labelText="Status" value={p.active} options={[{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }]} />
      </FilterBar>
      <div className="table-wrap">
        {pocs.length ? (
          <table>
            <thead><tr><th>Name</th><th>Organization</th><th>Phone</th><th>Email</th><th className="num">Devices today</th><th>Status</th></tr></thead>
            <tbody>{pocs.map((x) => (
              <tr key={x.id}><td><Link href={`/pocs/${x.id}`}>{x.name}</Link></td><td>{x.organization ?? ""}</td><td>{x.phone ?? ""}</td><td>{x.email ?? ""}</td>
                <td className="num">{x.current_device_count}</td><td><Badge status={x.active ? "ACTIVE" : "INACTIVE"} /></td></tr>
            ))}</tbody>
          </table>
        ) : <Empty>No POCs yet.</Empty>}
      </div>
      {user.role === "ADMIN" ? (
        <div className="card no-print">
          <h2>Add a POC</h2>
          <ApiForm path="/pocs" submitLabel="Add POC" redirect="/pocs/:id" fields={[
            { name: "name", label: "Name", required: true }, { name: "organization", label: "Organization" },
            { name: "phone", label: "Phone" }, { name: "email", label: "Email", type: "email" },
            { name: "notes", label: "Notes", type: "textarea", help: "Keep contact details to what operations need. Do not store bank details here." },
          ]} />
        </div>
      ) : null}
    </>
  );
}
