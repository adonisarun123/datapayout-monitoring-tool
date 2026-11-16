import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { readParams, type SearchParams } from "@/lib/format";
import { LoginForm } from "@/components/auth-forms";

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
        <LoginForm />
        <p className="small muted" style={{ marginTop: 14 }}>Forgot your password, or no account yet? Ask an administrator for a reset or invitation link. There is no public sign-up.</p>
      </div>
    </div>
  );
}
