import { requireUser } from "@/lib/session";
import { listAudit } from "@/server/reports";
import { listUsers } from "@/server/auth";
import { readParams, when, type SearchParams } from "@/lib/format";
import { AccessDenied, Empty, FilterBar, Input, PageHead, Pager, Select } from "@/components/ui";

const ENTITIES = ["entry", "bill", "payment", "device", "poc", "device_type", "user", "setting", "report"];

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  if (user.role !== "ADMIN") return <AccessDenied />;
  const p = await readParams(searchParams);
  const [list, users] = await Promise.all([
    listAudit({ entityType: p.entityType, entityId: p.entityId, actorId: p.actorId, action: p.action, dateFrom: p.dateFrom, dateTo: p.dateTo, page: Number(p.page) || 1 }).catch(() => null),
    listUsers(),
  ]);
  return (
    <>
      <PageHead title="Audit log" sub="Append-only record of who did what, when and why. Times are Asia/Kolkata." />
      <FilterBar clearHref="/admin/audit">
        <Input name="dateFrom" labelText="From" type="date" value={p.dateFrom} />
        <Input name="dateTo" labelText="To" type="date" value={p.dateTo} />
        <Select name="entityType" labelText="Record type" value={p.entityType} options={ENTITIES.map((e) => ({ value: e, label: e.replace("_", " ") }))} />
        <Select name="actorId" labelText="User" value={p.actorId} options={users.map((u) => ({ value: u.id, label: u.name }))} />
        <Input name="action" labelText="Action contains" value={p.action} placeholder="e.g. APPROVED" />
        <Input name="entityId" labelText="Record ID" value={p.entityId} />
      </FilterBar>
      {!list ? <div className="alert error" role="alert">One of the filters is not valid.</div> : (
        <>
          <div className="table-wrap">
            {list.rows.length ? (
              <table>
                <thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Reason</th><th>Before / after</th></tr></thead>
                <tbody>{list.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{when(a.created_at)}</td><td>{a.actor_name ?? "System"}</td><td>{a.action.replace(/_/g, " ").toLowerCase()}</td>
                    <td>{a.entity_type}<div className="small muted">{a.entity_id}</div></td><td>{a.reason ?? ""}</td>
                    <td>{a.before_json || a.after_json ? (
                      <details><summary className="small">Show values</summary>
                        <pre className="copybox" style={{ whiteSpace: "pre-wrap", maxWidth: 520 }}>{JSON.stringify({ before: a.before_json, after: a.after_json }, null, 1)}</pre>
                        <div className="small muted">Request {a.request_id ?? "n/a"}</div></details>
                    ) : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <Empty>No audit events match these filters.</Empty>}
          </div>
          <Pager path="/admin/audit" params={p} page={list.page} pageSize={list.pageSize} total={list.total} />
        </>
      )}
    </>
  );
}
