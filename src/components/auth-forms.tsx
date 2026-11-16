"use client";

import { useState, type FormEvent } from "react";
import { api, ErrorBox, type ApiError } from "./client";

export function LoginForm() {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    const res = await api("POST", "/auth/login", { email: fd.get("email"), password: fd.get("password") });
    if (res.ok) window.location.href = "/"; else { setBusy(false); setError(res.error); }
  }
  return (
    <form onSubmit={submit}>
      <ErrorBox error={error} />
      <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required autoFocus /></div>
      <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div>
      <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

export function SetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (fd.get("password") !== fd.get("confirm")) { setError({ code: "MISMATCH", message: "The two passwords do not match." }); return; }
    setBusy(true); setError(null);
    const res = await api("POST", "/auth/token", { token, password: fd.get("password") });
    setBusy(false);
    if (res.ok) setDone(true); else setError(res.error);
  }
  if (done) return <div className="alert ok" role="status">Password set. <a href="/login">Sign in</a>.</div>;
  return (
    <form onSubmit={submit}>
      <ErrorBox error={error} />
      <div className="field"><label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required autoFocus />
        <div className="help">At least 12 characters.</div></div>
      <div className="field"><label htmlFor="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required /></div>
      <button className="primary" disabled={busy}>{busy ? "Saving…" : "Set password"}</button>
    </form>
  );
}
