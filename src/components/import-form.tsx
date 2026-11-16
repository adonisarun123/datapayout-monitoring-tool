"use client";

import { useState } from "react";
import { api, ErrorBox, type ApiError } from "./client";

export function ImportForm() {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(step: "preview" | "commit") {
    setBusy(true); setError(null); setDone(null);
    const res = await api("POST", `/devices/import/${step}`, { csv });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    if (step === "preview") setPreview(res.data);
    else { setDone(res.data.imported); setPreview(null); setCsv(""); }
  }
  return (
    <div>
      <div className="field">
        <label htmlFor="csv-file">CSV file</label>
        <input id="csv-file" type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setPreview(null); } }} />
      </div>
      <div className="field">
        <label htmlFor="csv-text">or paste CSV</label>
        <textarea id="csv-text" value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} placeholder={"code,name,type,commissioned_on\nDEV-100,Unit 100,Device Type 1,2026-11-01"} />
      </div>
      <ErrorBox error={error} />
      {done !== null ? <div className="alert ok" role="status">{done} device{done === 1 ? "" : "s"} imported. Refresh the page to see them.</div> : null}
      <div className="actions">
        <button type="button" disabled={busy || !csv.trim()} onClick={() => run("preview")}>Preview</button>
        {preview?.valid ? <button type="button" className="primary" disabled={busy} onClick={() => run("commit")}>Import {preview.rows.length} devices</button> : null}
      </div>
      {preview ? (
        <div style={{ marginTop: 12 }}>
          {preview.valid ? <div className="alert ok">All {preview.rows.length} rows are valid.</div>
            : <div className="alert error" role="alert">{preview.errorCount} of {preview.rows.length} rows have errors. Nothing will be imported until they are fixed.</div>}
          <div className="table-wrap"><table>
            <thead><tr><th>Row</th><th>Code</th><th>Name</th><th>Type</th><th>Commissioned</th><th>Result</th></tr></thead>
            <tbody>{preview.rows.map((r: any) => (
              <tr key={r.row}><td>{r.row}</td><td>{r.code}</td><td>{r.name}</td><td>{r.typeName}</td><td>{r.commissionedOn}</td>
                <td>{r.errors.length ? <span className="badge bad">{r.errors.join("; ")}</span> : <span className="badge ok">OK</span>}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      ) : null}
    </div>
  );
}
