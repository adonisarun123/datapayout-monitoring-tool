import { requireUser } from "@/lib/session";
import { getSettingsWithVersions } from "@/server/settings";
import { reauthMinutes, sessionIdleHours } from "@/server/auth";
import { AccessDenied, PageHead } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";

export default async function SettingsPage() {
  const user = await requireUser();
  if (user.role !== "ADMIN") return <AccessDenied />;
  const rows = await getSettingsWithVersions();
  return (
    <>
      <PageHead title="Settings" sub="Defaults only. Rates, percentages and POC assignments are set per device with effective dates." />
      <div className="card">
        <SettingsForm initial={Object.fromEntries(rows.map((r) => [r.key, r.value]))} versions={Object.fromEntries(rows.map((r) => [r.key, r.version]))} />
      </div>
      <div className="card">
        <h2>Fixed by deployment</h2>
        <dl className="kv">
          <dt>Business timezone</dt><dd>Asia/Kolkata (timestamps stored in UTC)</dd>
          <dt>Session idle timeout</dt><dd>{sessionIdleHours()} hours</dd>
          <dt>Password confirmation for approval</dt><dd>Required if the last confirmation was more than {reauthMinutes()} minutes ago</dd>
          <dt>Maximum hours per entry</dt><dd>{process.env.MAX_HOURS_PER_ENTRY ?? "100000"}</dd>
        </dl>
      </div>
    </>
  );
}
