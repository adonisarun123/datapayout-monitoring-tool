"use client";

import { useState } from "react";
import { useAction } from "./client";

export function SettingsForm({ initial, versions }: { initial: Record<string, any>; versions: Record<string, number> }) {
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const action = useAction({ onDone: () => setSaved(true) });
  const set = (k: string, v: any) => { setS({ ...s, [k]: v }); setSaved(false); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); action.run("PATCH", "/settings", { changes: s, versions }); }}>
      <div className="form-grid">
        <div className="field"><label htmlFor="s-org">Organization name</label><input id="s-org" value={s.organization_name} onChange={(e) => set("organization_name", e.target.value)} />
          <div className="help">Shown on exports and bills.</div></div>
        <div className="field"><label htmlFor="s-cur">Default currency</label><input id="s-cur" maxLength={3} value={s.default_currency} onChange={(e) => set("default_currency", e.target.value.toUpperCase())} />
          <div className="help">Prefills new payout rules and bills. Changing it never converts existing entries or bills.</div></div>
        <div className="field"><label htmlFor="s-pct">Default payout %</label><input id="s-pct" inputMode="decimal" value={s.default_payout_percentage} onChange={(e) => set("default_payout_percentage", e.target.value)} />
          <div className="help">Prefills new payout rules only. Existing rules are unchanged.</div></div>
        <div className="field"><label htmlFor="s-thr">Hours warning threshold</label><input id="s-thr" inputMode="decimal" value={s.hours_warning_threshold} onChange={(e) => set("hours_warning_threshold", e.target.value)} />
          <div className="help">Entries above this show a warning. They are not blocked.</div></div>
      </div>
      <div className="field">
        <label htmlFor="s-sep"><input id="s-sep" type="checkbox" checked={s.require_separate_approver === true} onChange={(e) => set("require_separate_approver", e.target.checked)} />
          Require a different admin to approve a bill than the one who prepared it</label>
        <div className="help">Off by default. With it off, one admin can prepare, approve and mark a bill as paid.</div>
      </div>
      {action.ui}
      {saved ? <div className="alert ok" role="status">Settings saved. The change is recorded in the audit log.</div> : null}
      <button className="primary" disabled={action.pending}>Save settings</button>
    </form>
  );
}
