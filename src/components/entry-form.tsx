"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ErrorBox, type ApiError } from "./client";

interface DeviceOption { id: string; code: string; name: string; type_name: string }

function money(currency: string, amount: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, currencyDisplay: "code" }).format(amount as unknown as number);
}

export function DevicePicker({ value, onChange }: { value: DeviceOption | null; onChange: (d: DeviceOption | null) => void }) {
  const [term, setTerm] = useState("");
  const [options, setOptions] = useState<DeviceOption[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (value) return;
    const t = setTimeout(async () => {
      const res = await api("GET", `/devices?status=ACTIVE&pageSize=15&search=${encodeURIComponent(term)}`);
      if (res.ok) setOptions(res.data.rows);
    }, 200);
    return () => clearTimeout(t);
  }, [term, value]);
  if (value)
    return (
      <div className="field">
        <label>Device *</label>
        <div className="actions"><strong>{value.code}</strong><span className="muted">{value.name} · {value.type_name}</span>
          <button type="button" onClick={() => { onChange(null); setTerm(""); setOpen(true); }}>Change</button></div>
      </div>
    );
  return (
    <div className="field">
      <label htmlFor="device-search">Device *</label>
      <input id="device-search" role="combobox" aria-expanded={open} aria-controls="device-options" aria-autocomplete="list" value={term}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search active devices by code, name or serial" autoComplete="off" />
      {open ? (
        <div id="device-options" role="listbox" className="table-wrap" style={{ marginTop: 4, maxHeight: 220, overflowY: "auto" }}>
          {options.length ? options.map((d) => (
            <button type="button" role="option" aria-selected={false} key={d.id} onClick={() => { onChange(d); setOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid var(--line)", borderRadius: 0 }}>
              <strong>{d.code}</strong> <span className="muted">{d.name} · {d.type_name}</span>
            </button>
          )) : <div className="empty">No active devices match.</div>}
        </div>
      ) : null}
    </div>
  );
}

export function EntryForm({ today, initialDevice }: { today: string; initialDevice: DeviceOption | null }) {
  const [device, setDevice] = useState<DeviceOption | null>(initialDevice);
  const [activityDate, setDate] = useState(today);
  const [hours, setHours] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<any>(null);
  const key = useRef("");

  // Server-side preview: the terms and value shown here come from the server, never from client arithmetic.
  useEffect(() => {
    setPreview(null); setPreviewError(null); setConfirming(false);
    if (!device || !activityDate || !hours.trim()) return;
    const t = setTimeout(async () => {
      const res = await api("POST", "/entries/preview", { deviceId: device.id, activityDate, hours: hours.trim(), reference: reference || "preview" });
      if (res.ok) setPreview(res.data); else setPreviewError(res.error);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, activityDate, hours]);

  async function submit() {
    if (!device || !preview) return;
    if (!key.current) key.current = crypto.randomUUID();
    setBusy(true); setError(null);
    const res = await api("POST", "/entries", {
      deviceId: device.id, activityDate, hours: hours.trim(), reference, notes,
      acknowledgedWarnings: preview.warnings.map((w: any) => w.code),
    }, key.current);
    setBusy(false);
    if (res.ok) {
      key.current = "";
      setSaved(res.data); setConfirming(false); setHours(""); setReference(""); setNotes(""); setPreview(null);
    } else {
      if (res.status !== 0) key.current = "";
      setConfirming(false);
      if (res.error.code === "WARNING_CONFIRMATION_REQUIRED") setPreview({ ...preview, warnings: [...preview.warnings, ...(res.error.details?.warnings ?? [])] });
      setError(res.error);
    }
  }

  const ready = !!device && !!preview && !!reference.trim();
  return (
    <div className="grid cols-2">
      <div className="card">
        {saved ? (
          <div className="alert ok" role="status">
            Entry saved: {saved.hours} hours for {saved.device_code} on {saved.activity_date}, {money(saved.currency, saved.line_amount)}.{" "}
            <Link href={`/entries/${saved.id}`}>View entry</Link>. It can no longer be edited; ask an admin if it needs a correction.
          </div>
        ) : null}
        <DevicePicker value={device} onChange={(d) => { setDevice(d); setSaved(null); }} />
        <div className="form-grid">
          <div className="field"><label htmlFor="activityDate">Activity date *</label>
            <input id="activityDate" type="date" max={today} value={activityDate} onChange={(e) => setDate(e.target.value)} required />
            <div className="help">The date the data was collected (Asia/Kolkata). Not today&apos;s date unless that is when it happened.</div></div>
          <div className="field"><label htmlFor="hours">Data hours *</label>
            <input id="hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 7.5" autoComplete="off" required />
            <div className="help">Hours for this batch only, in decimal hours (up to 4 decimals). Not a running total.</div></div>
        </div>
        <div className="field"><label htmlFor="reference">Source / batch reference *</label>
          <input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. BATCH-2026-11-15-001" autoComplete="off" required />
          <div className="help">Must be unique for this device. A repeated reference is rejected as a duplicate.</div></div>
        <div className="field"><label htmlFor="notes">Notes</label><textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <ErrorBox error={error} />
        {confirming ? (
          <div className="alert warn" role="alertdialog" aria-label="Confirm submission">
            <p><strong>Submit this entry?</strong> {hours} hours for {device?.code} on {activityDate}, reference {reference}. Once submitted you cannot edit or delete it.</p>
            {preview?.warnings.length ? <p>By submitting you confirm you have reviewed the warnings shown.</p> : null}
            <div className="actions"><button type="button" className="primary" disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Yes, submit"}</button>
              <button type="button" onClick={() => setConfirming(false)}>Go back</button></div>
          </div>
        ) : (
          <button type="button" className="primary" disabled={!ready} onClick={() => { setError(null); setSaved(null); setConfirming(true); }}>Review and submit</button>
        )}
      </div>
      <div className="card" aria-live="polite">
        <h2>Terms for this entry</h2>
        {previewError ? <div className="alert error" role="alert">{previewError.message}</div> : null}
        {preview ? (
          <>
            <dl className="kv">
              <dt>POC on that date</dt><dd>{preview.terms.pocName}</dd>
              <dt>Payout percentage</dt><dd>{preview.terms.percentage}%</dd>
              <dt>Rate per payable hour</dt><dd>{money(preview.terms.currency, preview.terms.rate)}</dd>
              <dt>Payable hours</dt><dd>{preview.terms.payableHours}</dd>
              <dt>Estimated amount</dt><dd><strong>{money(preview.terms.currency, preview.terms.amount)}</strong></dd>
            </dl>
            <p className="small muted" style={{ marginTop: 10 }}>Payable hours = hours × percentage. Amount = payable hours × rate, rounded half up to 2 decimals. Before any taxes or other adjustments.</p>
            {preview.warnings.map((w: any) => <div className="alert warn" role="status" key={w.code}>{w.message}</div>)}
          </>
        ) : !previewError ? <p className="muted">Choose a device and date and enter hours to see the POC, percentage, rate and value that will apply.</p> : null}
      </div>
    </div>
  );
}

export function CorrectionForm({ entry }: { entry: any }) {
  const [device, setDevice] = useState<DeviceOption | null>({ id: entry.device_id, code: entry.device_code, name: entry.device_name, type_name: entry.type_name });
  const [activityDate, setDate] = useState<string>(entry.activity_date);
  const [hours, setHours] = useState<string>(entry.hours);
  const [reference, setReference] = useState<string>(entry.reference);
  const [notes, setNotes] = useState<string>(entry.notes ?? "");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const body = (extra: object) => ({ expectedVersion: entry.version, deviceId: device?.id, activityDate, hours: String(hours).trim(), reference, notes, reason, ...extra });
  async function review() {
    setBusy(true); setError(null); setPreview(null);
    const res = await api("POST", `/entries/${entry.id}/corrections`, body({ dryRun: true }));
    setBusy(false);
    if (res.ok) setPreview(res.data.preview); else setError(res.error);
  }
  async function save() {
    setBusy(true); setError(null);
    const res = await api("POST", `/entries/${entry.id}/corrections`, body({ acknowledgedWarnings: preview.warnings.map((w: any) => w.code) }), crypto.randomUUID());
    setBusy(false);
    if (res.ok) window.location.reload(); else { setPreview(null); setError(res.error); }
  }
  return (
    <div>
      <DevicePicker value={device} onChange={(d) => { setDevice(d); setPreview(null); }} />
      <div className="form-grid">
        <div className="field"><label htmlFor="c-date">Activity date *</label><input id="c-date" type="date" value={activityDate} onChange={(e) => { setDate(e.target.value); setPreview(null); }} /></div>
        <div className="field"><label htmlFor="c-hours">Data hours *</label><input id="c-hours" inputMode="decimal" value={hours} onChange={(e) => { setHours(e.target.value); setPreview(null); }} /></div>
        <div className="field"><label htmlFor="c-ref">Reference *</label><input id="c-ref" value={reference} onChange={(e) => { setReference(e.target.value); setPreview(null); }} /></div>
      </div>
      <div className="field"><label htmlFor="c-notes">Notes</label><textarea id="c-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="field"><label htmlFor="c-reason">Reason for correction *</label><textarea id="c-reason" value={reason} onChange={(e) => setReason(e.target.value)} required /></div>
      <ErrorBox error={error} />
      {preview ? (
        <div className="alert warn" role="alertdialog" aria-label="Confirm correction">
          <p><strong>Confirm this correction.</strong> The current version is kept in history; a new version is created with the terms in force for the corrected device and date.</p>
          <div className="table-wrap"><table>
            <thead><tr><th /><th>Date</th><th className="num">Hours</th><th>Reference</th><th className="num">%</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
            <tbody>
              <tr><td>Before</td><td>{preview.before.activityDate}</td><td className="num">{preview.before.hours}</td><td>{preview.before.reference}</td><td className="num">{preview.before.percentage}</td><td className="num">{preview.before.rate}</td><td className="num">{money(preview.before.currency, preview.before.amount)}</td></tr>
              <tr><td>After</td><td>{preview.after.activityDate}</td><td className="num">{preview.after.hours}</td><td>{preview.after.reference}</td><td className="num">{preview.after.percentage}</td><td className="num">{preview.after.rate}</td><td className="num">{money(preview.after.currency, preview.after.amount)}</td></tr>
            </tbody></table></div>
          <p>POC after correction: {preview.after.pocName}.</p>
          {preview.releasesFromBill ? <p>This entry will be released from bill {preview.releasesFromBill}, which must then be regenerated before it can be submitted.</p> : null}
          {preview.warnings.map((w: any) => <p key={w.code}>Warning: {w.message}</p>)}
          <div className="actions"><button type="button" className="primary" disabled={busy} onClick={save}>Save correction</button><button type="button" onClick={() => setPreview(null)}>Go back</button></div>
        </div>
      ) : <button type="button" className="primary" disabled={busy || !reason.trim() || !device} onClick={review}>Review correction</button>}
    </div>
  );
}
