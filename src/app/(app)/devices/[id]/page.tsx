import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getDevice, listDeviceTypes, listPocs } from "@/server/masters";
import { getSettings } from "@/server/settings";
import { todayIST } from "@/lib/dates";
import { money, num, when } from "@/lib/format";
import { Badge, Empty, PageHead } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/client";

const RETRO = "If the start date is in the past, entries already submitted keep the terms they were saved with. They are not repriced.";

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let data: Awaited<ReturnType<typeof getDevice>>;
  try { data = await getDevice(id); } catch { notFound(); }
  const { device, assignments, rules } = data;
  const admin = user.role === "ADMIN";
  const [types, pocs, settings] = await Promise.all([listDeviceTypes(), listPocs({ active: true }), getSettings()]);
  const today = todayIST();
  const current = (r: any) => r.valid_from <= today && (!r.valid_to_exclusive || r.valid_to_exclusive > today);
  return (
    <>
      <PageHead title={`${device.code} · ${device.name}`} sub={<>{device.type_name} · <Badge status={device.status} /></>}>
        <Link className="btn" href={`/entries?deviceId=${device.id}`}>View entries</Link>
        <Link className="btn primary" href={`/entries/new?deviceId=${device.id}`}>New entry</Link>
      </PageHead>
      <div className="grid cols-2">
        <div className="card">
          <h2>Details</h2>
          <dl className="kv">
            <dt>System ID</dt><dd className="small">{device.id}</dd>
            <dt>Serial number</dt><dd>{device.serial ?? "Not recorded"}</dd>
            <dt>Commissioned on</dt><dd>{device.commissioned_on}</dd>
            <dt>Active until</dt><dd>{device.active_until_exclusive ? `${device.active_until_exclusive} (exclusive)` : "Open"}</dd>
            <dt>Notes</dt><dd>{device.notes ?? ""}</dd>
            <dt>Last updated</dt><dd>{when(device.updated_at)}</dd>
          </dl>
        </div>
        {admin ? (
          <div className="card no-print">
            <details className="fold"><summary>Edit device</summary>
              <ApiForm path={`/devices/${device.id}`} method="PATCH" submitLabel="Save changes" extra={{ version: device.version }} resetOnSuccess={false} fields={[
                { name: "code", label: "Device code", required: true, defaultValue: device.code },
                { name: "name", label: "Display name", required: true, defaultValue: device.name },
                { name: "typeId", label: "Type", type: "select", required: true, defaultValue: device.type_id, options: types.filter((t) => t.active || t.id === device.type_id).map((t) => ({ value: t.id, label: t.name })) },
                { name: "status", label: "Status", type: "select", required: true, defaultValue: device.status, options: ["ACTIVE", "INACTIVE", "RETIRED"].map((s) => ({ value: s, label: s })), help: "Only active devices accept new entries. History is always kept." },
                { name: "commissionedOn", label: "Commissioning date", type: "date", required: true, defaultValue: device.commissioned_on },
                { name: "activeUntilExclusive", label: "Active until (exclusive)", type: "date", defaultValue: device.active_until_exclusive ?? "", help: "No entries on or after this date." },
                { name: "serial", label: "Serial number", defaultValue: device.serial ?? "" },
                { name: "notes", label: "Notes", type: "textarea", defaultValue: device.notes ?? "" },
              ]} />
            </details>
          </div>
        ) : null}
      </div>

      <h2>POC assignments</h2>
      <div className="table-wrap">
        {assignments.length ? (
          <table>
            <thead><tr><th>POC</th><th>From (inclusive)</th><th>To (exclusive)</th><th>Reason</th><th>Created by</th>{admin ? <th className="no-print" /> : null}</tr></thead>
            <tbody>{assignments.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/pocs/${a.poc_id}`}>{a.poc_name}</Link> {current(a) ? <span className="badge ok">In force today</span> : null}</td>
                <td>{a.valid_from}</td><td>{a.valid_to_exclusive ?? "Open"}</td><td>{a.reason ?? ""}</td><td>{a.created_by_name ?? ""}</td>
                {admin ? <td className="no-print">{!a.valid_to_exclusive ? <EndForm kind="assignments" id={a.id} /> : null}</td> : null}
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>No POC assigned yet. Entries cannot be submitted for dates without an assignment.</Empty>}
      </div>
      {admin ? (
        <div className="card no-print">
          <h3>Assign or reassign POC</h3>
          <p className="small muted">An open-ended assignment that starts earlier is closed automatically at the new start date. {RETRO}</p>
          <ApiForm path={`/devices/${device.id}/assignments`} submitLabel="Save assignment" fields={[
            { name: "pocId", label: "POC", type: "select", required: true, options: pocs.map((p) => ({ value: p.id, label: p.name })) },
            { name: "validFrom", label: "From (inclusive)", type: "date", required: true, defaultValue: today },
            { name: "validToExclusive", label: "To (exclusive)", type: "date", help: "Leave empty for open-ended." },
            { name: "reason", label: "Reason", help: "Required for a start date in the past." },
          ]} />
        </div>
      ) : null}

      <h2>Payout rules</h2>
      <div className="table-wrap">
        {rules.length ? (
          <table>
            <thead><tr><th>From (inclusive)</th><th>To (exclusive)</th><th className="num">Payout %</th><th className="num">Rate / payable hour</th><th>Reason</th><th>Created by</th>{admin ? <th className="no-print" /> : null}</tr></thead>
            <tbody>{rules.map((r) => (
              <tr key={r.id}>
                <td>{r.valid_from} {current(r) ? <span className="badge ok">In force today</span> : null}</td><td>{r.valid_to_exclusive ?? "Open"}</td>
                <td className="num">{num(r.percentage)} {Number(r.percentage) === 0 ? <span className="badge bad">Zero</span> : null}</td>
                <td className="num">{money(r.currency, r.rate)} {Number(r.rate) === 0 ? <span className="badge bad">Zero</span> : null}</td>
                <td>{r.reason ?? ""}</td><td>{r.created_by_name ?? ""}</td>
                {admin ? <td className="no-print">{!r.valid_to_exclusive ? <EndForm kind="payout-rules" id={r.id} /> : null}</td> : null}
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>No payout rule yet. Entries cannot be submitted for dates without a rate and percentage.</Empty>}
      </div>
      {admin ? (
        <div className="card no-print">
          <h3>Add or change payout rule</h3>
          <p className="small muted">An open-ended rule that starts earlier is closed automatically at the new start date. {RETRO}</p>
          <ApiForm path={`/devices/${device.id}/payout-rules`} submitLabel="Save rule" fields={[
            { name: "rate", label: "Rate per payable hour", type: "number", required: true, help: "No default. Enter the agreed rate." },
            { name: "currency", label: "Currency", required: true, defaultValue: settings.default_currency },
            { name: "percentage", label: "Payout %", type: "number", required: true, defaultValue: settings.default_payout_percentage },
            { name: "validFrom", label: "From (inclusive)", type: "date", required: true, defaultValue: today },
            { name: "validToExclusive", label: "To (exclusive)", type: "date", help: "Leave empty for open-ended." },
            { name: "reason", label: "Reason", help: "Required for a start date in the past." },
          ]} />
        </div>
      ) : null}
    </>
  );
}

function EndForm({ kind, id }: { kind: "assignments" | "payout-rules"; id: string }) {
  return (
    <details className="fold"><summary>End</summary>
      <ApiForm path={`/${kind}/${id}/end`} submitLabel="Set end date" fields={[
        { name: "validToExclusive", label: "End date (exclusive)", type: "date", required: true },
        { name: "reason", label: "Reason" },
      ]} />
    </details>
  );
}
