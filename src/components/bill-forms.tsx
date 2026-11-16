"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ErrorBox, useAction, type ApiError } from "./client";

const money = (currency: string, amount: string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, currencyDisplay: "code" }).format(amount as unknown as number);

export function BillBuilder({ pocs, defaults }: { pocs: { id: string; name: string }[]; defaults: { pocId?: string; currency: string; dateFrom: string; dateTo: string } }) {
  const router = useRouter();
  const [form, setForm] = useState({ pocId: defaults.pocId ?? "", currency: defaults.currency, dateFrom: defaults.dateFrom, dateTo: defaults.dateTo });
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => { setForm({ ...form, [k]: v }); setPreview(null); };

  async function run(create: boolean) {
    setBusy(true); setError(null);
    const res = create ? await api("POST", "/bills", form, crypto.randomUUID()) : await api("POST", "/bills/preview", form);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    if (create) router.push(`/bills/${res.data.bill.id}`); else setPreview(res.data);
  }
  return (
    <>
      <div className="card">
        <div className="form-grid">
          <div className="field"><label htmlFor="b-poc">POC *</label>
            <select id="b-poc" value={form.pocId} onChange={(e) => set("pocId", e.target.value)}><option value="">Select…</option>{pocs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div className="field"><label htmlFor="b-cur">Currency *</label><input id="b-cur" value={form.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></div>
          <div className="field"><label htmlFor="b-from">Activity from (inclusive) *</label><input id="b-from" type="date" value={form.dateFrom} onChange={(e) => set("dateFrom", e.target.value)} /></div>
          <div className="field"><label htmlFor="b-to">Activity to (inclusive) *</label><input id="b-to" type="date" value={form.dateTo} onChange={(e) => set("dateTo", e.target.value)} /></div>
        </div>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" disabled={busy || !form.pocId} onClick={() => run(false)}>Preview eligible entries</button>
          {preview?.eligible.length ? <button type="button" className="primary" disabled={busy} onClick={() => run(true)}>Create draft bill ({preview.eligible.length} lines, {money(preview.currency, preview.total)})</button> : null}
        </div>
      </div>
      {preview ? (
        <>
          <h2>Eligible entries ({preview.eligible.length})</h2>
          <div className="table-wrap">
            {preview.eligible.length ? (
              <table>
                <thead><tr><th>Activity date</th><th>Device</th><th>Reference</th><th className="num">Hours</th><th className="num">%</th><th className="num">Rate</th><th className="num">Payable hours</th><th className="num">Amount</th></tr></thead>
                <tbody>{preview.eligible.map((l: any) => (
                  <tr key={l.entry_id}><td>{l.activity_date}</td><td>{l.device_code}</td><td>{l.reference}</td><td className="num">{l.hours}</td><td className="num">{l.percentage}</td>
                    <td className="num">{l.rate}</td><td className="num">{l.payable_hours}</td><td className="num">{money(l.currency, l.line_amount)}</td></tr>
                ))}</tbody>
                <tfoot><tr><td colSpan={7}>Total (sum of rounded lines)</td><td className="num">{money(preview.currency, preview.total)}</td></tr></tfoot>
              </table>
            ) : <div className="empty">No unbilled valid entries for this POC, currency and period. An empty bill cannot be created.</div>}
          </div>
          {preview.excluded.length ? (
            <>
              <h2>Cannot be included ({preview.excluded.length})</h2>
              <div className="table-wrap"><table>
                <thead><tr><th>Activity date</th><th>Device</th><th>Reference</th><th className="num">Amount</th><th>Why</th></tr></thead>
                <tbody>{preview.excluded.map((l: any) => (
                  <tr key={l.entry_id}><td>{l.activity_date}</td><td>{l.device_code}</td><td>{l.reference}</td><td className="num">{money(l.currency, l.line_amount)}</td>
                    <td>{l.reason === "DIFFERENT_CURRENCY" ? `Different currency (${l.currency}); bill it separately` : `Already on bill ${l.bill_number} (${String(l.bill_status).replace(/_/g, " ").toLowerCase()})`}</td></tr>
                ))}</tbody>
              </table></div>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function ExcludeLines({ billId, version, lines }: { billId: string; version: number; lines: { id: string; label: string }[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const action = useAction({ onDone: () => setPicked([]) });
  return (
    <details className="fold"><summary>Exclude lines from this draft</summary>
      <p className="small muted">Excluded entries go back to unbilled and can be included in a later bill.</p>
      {lines.map((l) => (
        <label key={l.id} style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} />{l.label}
        </label>
      ))}
      {action.ui}
      <button type="button" disabled={!picked.length || action.pending} onClick={() => action.run("POST", `/bills/${billId}/exclude-lines`, { lineIds: picked, expectedVersion: version })}>
        Exclude {picked.length || ""} selected
      </button>
    </details>
  );
}

export function AdjustmentForm({ billId, currency, lines }: { billId: string; currency: string; lines: { id: string; label: string; hours: string; current: string; busy: string | null }[] }) {
  const [mode, setMode] = useState<"hours" | "amount">("hours");
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const action = useAction({ redirect: "/bills/:id", refresh: false });
  const chosen = Object.entries(values).filter(([, v]) => v.trim() !== "");
  return (
    <div>
      <p className="small muted">Enter the corrected value for each line that was wrong. The adjustment is the corrected amount minus the original amount and any adjustments already approved for that line. The original bill, its lines and its payments are not changed.</p>
      <div className="field" role="radiogroup" aria-label="Correct by">
        <label style={{ display: "inline", fontWeight: 400, marginRight: 16 }}><input type="radio" checked={mode === "hours"} onChange={() => { setMode("hours"); setValues({}); }} />Corrected hours (repriced at the line&apos;s own rate and percentage)</label>
        <label style={{ display: "inline", fontWeight: 400 }}><input type="radio" checked={mode === "amount"} onChange={() => { setMode("amount"); setValues({}); }} />Corrected amount</label>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Line</th><th className="num">Billed hours</th><th className="num">Amount incl. approved adjustments</th><th>{mode === "hours" ? "Corrected hours" : `Corrected amount (${currency})`}</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.id}><td>{l.label}</td><td className="num">{l.hours}</td><td className="num">{money(currency, l.current)}</td>
            <td>{l.busy ? <span className="badge warn">Adjustment {l.busy} in progress</span>
              : <input aria-label={`Corrected value for ${l.label}`} inputMode="decimal" value={values[l.id] ?? ""} onChange={(e) => setValues({ ...values, [l.id]: e.target.value })} placeholder="Leave empty if correct" />}</td></tr>
        ))}</tbody>
      </table></div>
      <div className="field"><label htmlFor="adj-reason">Reason *</label><textarea id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {action.ui}
      <button type="button" className="primary" disabled={action.pending || !chosen.length || !reason.trim()}
        onClick={() => action.run("POST", `/bills/${billId}/adjustments`, {
          reason, lines: chosen.map(([originalLineId, v]) => (mode === "hours" ? { originalLineId, correctedHours: v.trim() } : { originalLineId, correctedAmount: v.trim() })),
        })}>Create adjustment draft</button>
    </div>
  );
}
