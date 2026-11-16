import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { readParams, type SearchParams } from "@/lib/format";
import { LoginForm } from "@/components/auth-forms";
import { googleEnabled, passwordLoginEnabled } from "@/server/google";
import { allowedEmailDomains } from "@/server/auth";

const ERRORS: Record<string, string> = {
  no_account: "Your Google account is not set up for this tool. Ask an administrator to add you.",
  domain: "That Google account is not allowed. Use your company Google Workspace account.",
  cancelled: "Google sign-in was cancelled.",
  state: "The sign-in attempt expired. Try again.",
  google: "Google sign-in could not be completed. Try again.",
  google_off: "Google sign-in is not configured.",
  rate: "Too many attempts. Wait a minute and try again.",
};

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  if (await currentUser()) redirect("/");
  const p = await readParams(searchParams);
  return (
    <div className="login">
      <div className="card">
        <h1>Data Monitoring</h1>
        <p className="muted">Sign in with your invited account.</p>
        {p.expired ? <div className="alert warn" role="status">Your session has expired. Sign in again.</div> : null}
        {p.error ? <div className="alert error" role="alert">{ERRORS[p.error] ?? ERRORS.google}</div> : null}
        {googleEnabled() ? (
          <p><a className="btn primary" href="/api/v1/auth/google/start" style={{ display: "block", textAlign: "center" }}>Sign in with Google</a></p>
        ) : null}
        {googleEnabled() && allowedEmailDomains().length ? <p className="small muted">Use your {allowedEmailDomains().map((d) => `@${d}`).join(" or ")} Google account.</p> : null}
        {passwordLoginEnabled() ? (
          <>
            {googleEnabled() ? <p className="small muted">Or sign in with a password:</p> : null}
            <LoginForm />
            <p className="small muted" style={{ marginTop: 14 }}>Forgot your password, or no account yet? Ask an administrator for a reset or invitation link. There is no public sign-up.</p>
          </>
        ) : <p className="small muted">No account yet? Ask an administrator to add you. There is no public sign-up.</p>}
      </div>
    </div>
  );
}
