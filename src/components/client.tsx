"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

export interface ApiError { code: string; message: string; details?: any; requestId?: string }
export type ApiResult<T = any> = { ok: true; data: T } | { ok: false; error: ApiError; status: number };

/** JSON call to /api/v1. The idempotency key is supplied by the caller so a retry of the same action reuses it. */
export async function api<T = any>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      credentials: "same-origin",
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: json?.data };
    if (res.status === 401 && json?.error?.code === "UNAUTHENTICATED") {
      window.location.href = "/login?expired=1";
    }
    return { ok: false, status: res.status, error: json?.error ?? { code: "HTTP_ERROR", message: `Request failed (${res.status}).` } };
  } catch {
    return { ok: false, status: 0, error: { code: "NETWORK", message: "Could not reach the server. Check your connection and try again." } };
  }
}

export function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      {error.message}
      {error.requestId ? <div className="small">Request ID: {error.requestId}</div> : null}
    </div>
  );
}

// Server responses that mean "show this warning and ask the user to confirm", and the flag that confirms each.
const CONFIRMABLE: Record<string, (body: any, error: ApiError) => any> = {
  RETROACTIVE_CONFIRMATION_REQUIRED: (b) => ({ ...b, confirmRetroactive: true }),
  ZERO_CONFIRMATION_REQUIRED: (b) => ({ ...b, confirmZero: true }),
  WARNING_CONFIRMATION_REQUIRED: (b, e) => ({
    ...b, acknowledgedWarnings: [...(b.acknowledgedWarnings ?? []), ...(e.details?.warnings ?? []).map((w: any) => w.code)],
  }),
};

/** Runs one API action with pending/error state, server-driven confirmations and password re-confirmation. */
export function useAction(opts: { onDone?: (data: any) => void; refresh?: boolean; redirect?: string } = {}) {
  const router = useRouter();
  const key = useRef<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState<{ error: ApiError; retry: () => void } | null>(null);
  const [reauth, setReauth] = useState<{ method: string; retry: () => void } | null>(null);

  async function run(method: string, path: string, body: any = {}) {
    if (!key.current) key.current = crypto.randomUUID();
    setPending(true); setError(null); setConfirm(null);
    const res = await api(method, path, body, key.current);
    setPending(false);
    if (res.ok) {
      key.current = "";
      opts.onDone?.(res.data);
      if (opts.redirect) router.push(opts.redirect.replace(":id", res.data?.id ?? res.data?.bill?.id ?? ""));
      if (opts.refresh !== false) router.refresh();
      return res.data;
    }
    if (res.status !== 0) key.current = ""; // a completed, failed attempt frees the key; a network failure keeps it for a safe retry
    const patch = CONFIRMABLE[res.error.code];
    if (patch) setConfirm({ error: res.error, retry: () => run(method, path, patch(body, res.error)) });
    else if (res.error.code === "REAUTH_REQUIRED") setReauth({ method: res.error.details?.method ?? "password", retry: () => run(method, path, body) });
    else setError(res.error);
    return null;
  }

  const ui = (
    <>
      <ErrorBox error={error} />
      {confirm ? (
        <div className="alert warn" role="alertdialog" aria-label="Confirmation needed">
          <p>{confirm.error.message}</p>
          {(confirm.error.details?.warnings ?? []).length ? (
            <ul>{confirm.error.details.warnings.map((w: any) => <li key={w.code}>{w.message}</li>)}</ul>
          ) : null}
          <div className="actions">
            <button type="button" className="primary" onClick={confirm.retry} disabled={pending}>Confirm and continue</button>
            <button type="button" onClick={() => setConfirm(null)}>Go back</button>
          </div>
        </div>
      ) : null}
      {reauth?.method === "google" ? (
        <div className="alert info" role="alertdialog" aria-label="Confirm with Google">
          <p>This action cannot be undone. Confirm it is you with Google, then press the button again.</p>
          <div className="actions">
            <a className="btn primary" href={`/api/v1/auth/google/start?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname)}`}>Confirm with Google</a>
            <button type="button" onClick={() => setReauth(null)}>Cancel</button>
          </div>
        </div>
      ) : reauth ? <Reauth onDone={() => { const r = reauth.retry; setReauth(null); r(); }} onCancel={() => setReauth(null)} /> : null}
    </>
  );
  return { run, pending, ui, error, clear: () => { setError(null); setConfirm(null); } };
}

function Reauth({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await api("POST", "/auth/reauth", { password });
    setBusy(false);
    if (res.ok) onDone(); else setError(res.error);
  }
  return (
    <form className="alert info" onSubmit={submit} aria-label="Confirm your password">
      <p>This action cannot be undone. Confirm your password to continue.</p>
      <ErrorBox error={error} />
      <div className="field"><label htmlFor={id}>Password</label>
        <input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></div>
      <div className="actions"><button className="primary" disabled={busy}>Confirm</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

export interface FieldDef {
  name: string; label: string;
  type?: "text" | "date" | "number" | "email" | "password" | "select" | "textarea" | "checkbox";
  options?: { value: string; label: string }[];
  required?: boolean; defaultValue?: string | boolean; help?: string; placeholder?: string;
}

/**
 * Data-driven form used across admin screens. Posts JSON to an API path, merges `extra` (for example the
 * record version), and can show a value from the response (for example a one-time invite link).
 */
export function ApiForm(props: {
  path: string; method?: string; fields: FieldDef[]; extra?: Record<string, unknown>; submitLabel: string;
  confirmText?: string; redirect?: string; showResult?: { key: string; label: string }; successText?: string; resetOnSuccess?: boolean;
  children?: ReactNode;
}) {
  const [result, setResult] = useState<any>(null);
  const [asking, setAsking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const uid = useId();
  const action = useAction({
    redirect: props.redirect,
    onDone: (d) => { setResult(d ?? {}); if (props.resetOnSuccess !== false) formRef.current?.reset(); },
  });

  function collect(): Record<string, unknown> {
    const fd = new FormData(formRef.current!);
    const body: Record<string, unknown> = { ...(props.extra ?? {}) };
    for (const f of props.fields) {
      if (f.type === "checkbox") body[f.name] = fd.get(f.name) === "on";
      else {
        const v = String(fd.get(f.name) ?? "").trim();
        body[f.name] = v === "" ? null : v;
      }
    }
    return body;
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    setResult(null);
    if (props.confirmText && !asking) { setAsking(true); return; }
    setAsking(false);
    action.run(props.method ?? "POST", props.path, collect());
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate={false}>
      <div className="form-grid">
        {props.fields.map((f) => {
          const id = `${uid}-${f.name}`;
          return (
            <div className="field" key={f.name} style={f.type === "textarea" ? { gridColumn: "1 / -1" } : undefined}>
              {f.type === "checkbox" ? (
                <label htmlFor={id}><input id={id} name={f.name} type="checkbox" defaultChecked={f.defaultValue === true} />{f.label}</label>
              ) : (
                <>
                  <label htmlFor={id}>{f.label}{f.required ? " *" : ""}</label>
                  {f.type === "select" ? (
                    <select id={id} name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? "")}>
                      <option value="">Select…</option>
                      {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.type === "textarea" ? (
                    <textarea id={id} name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? "")} placeholder={f.placeholder} />
                  ) : (
                    <input id={id} name={f.name} type={f.type === "number" ? "text" : f.type ?? "text"} inputMode={f.type === "number" ? "decimal" : undefined}
                      required={f.required} defaultValue={String(f.defaultValue ?? "")} placeholder={f.placeholder} autoComplete="off" />
                  )}
                </>
              )}
              {f.help ? <div className="help">{f.help}</div> : null}
            </div>
          );
        })}
      </div>
      {props.children}
      {action.ui}
      {asking ? (
        <div className="alert warn" role="alertdialog">
          <p>{props.confirmText}</p>
          <div className="actions"><button className="primary" disabled={action.pending}>Yes, continue</button>
            <button type="button" onClick={() => setAsking(false)}>Cancel</button></div>
        </div>
      ) : (
        <button className="primary" disabled={action.pending}>{action.pending ? "Working…" : props.submitLabel}</button>
      )}
      {result && !action.error ? (
        <div className="alert ok" role="status" style={{ marginTop: 12 }}>
          {props.successText ?? "Saved."}
          {props.showResult && result[props.showResult.key] ? (
            <><div className="small" style={{ marginTop: 6 }}>{props.showResult.label}</div><div className="copybox">{String(result[props.showResult.key])}</div></>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/** One-click action with optional confirmation and optional mandatory reason. */
export function ActionButton(props: {
  path: string; method?: string; body?: Record<string, unknown>; label: string; confirmText?: string;
  reason?: { field: string; label: string; required?: boolean }; kind?: "primary" | "danger"; redirect?: string;
  showResult?: { key: string; label: string };
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<any>(null);
  const id = useId();
  const action = useAction({ redirect: props.redirect, onDone: (d) => { setOpen(false); setReason(""); setResult(d); } });
  const needsPanel = !!props.confirmText || !!props.reason;
  const go = () => action.run(props.method ?? "POST", props.path, { ...(props.body ?? {}), ...(props.reason ? { [props.reason.field]: reason } : {}) });
  return (
    <div style={{ display: "inline-block", verticalAlign: "top", maxWidth: 460 }}>
      {!open ? (
        <button type="button" className={props.kind ?? ""} disabled={action.pending} onClick={() => (needsPanel ? setOpen(true) : go())}>
          {action.pending ? "Working…" : props.label}
        </button>
      ) : (
        <div className="alert warn" role="alertdialog" aria-label={props.label}>
          {props.confirmText ? <p>{props.confirmText}</p> : null}
          {props.reason ? (
            <div className="field"><label htmlFor={id}>{props.reason.label}{props.reason.required ? " *" : ""}</label>
              <textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} required={props.reason.required} autoFocus /></div>
          ) : null}
          <div className="actions">
            <button type="button" className="primary" disabled={action.pending || (props.reason?.required && !reason.trim())} onClick={go}>{props.label}</button>
            <button type="button" onClick={() => { setOpen(false); action.clear(); }}>Cancel</button>
          </div>
        </div>
      )}
      {action.ui}
      {result && props.showResult && result[props.showResult.key] ? (
        <div className="alert ok" role="status"><div className="small">{props.showResult.label}</div><div className="copybox">{String(result[props.showResult.key])}</div></div>
      ) : null}
    </div>
  );
}

export function LogoutButton() {
  return <button type="button" onClick={async () => { await api("POST", "/auth/logout"); window.location.href = "/login"; }}>Sign out</button>;
}

export function PrintButton() {
  return <button type="button" onClick={() => window.print()}>Print</button>;
}
