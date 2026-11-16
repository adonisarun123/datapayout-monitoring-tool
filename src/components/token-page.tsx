import { describeToken } from "@/server/auth";
import { SetPasswordForm } from "./auth-forms";
import { passwordLoginEnabled } from "@/server/google";

export async function TokenPage({ token, kind }: { token: string; kind: "INVITE" | "RESET" }) {
  if (!passwordLoginEnabled())
    return (
      <div className="login"><div className="card"><h1>Sign in with Google</h1>
        <p>Passwords and invitation links are no longer used for this tool. <a href="/login">Go to sign in</a> and use your company Google account.</p></div></div>
    );
  const info = await describeToken(token);
  return (
    <div className="login">
      <div className="card">
        <h1>{kind === "INVITE" ? "Accept invitation" : "Reset password"}</h1>
        {info && info.kind === kind ? (
          <>
            <p className="muted">{info.name} ({info.email})</p>
            <SetPasswordForm token={token} />
          </>
        ) : (
          <div className="alert error" role="alert">This link is invalid, has already been used, or has expired. Ask an administrator for a new one.</div>
        )}
      </div>
    </div>
  );
}
