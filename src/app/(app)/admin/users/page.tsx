import { requireUser } from "@/lib/session";
import { allowedEmailDomains, listUsers } from "@/server/auth";
import { when } from "@/lib/format";
import { AccessDenied, Badge, PageHead } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/client";

export default async function UsersPage() {
  const user = await requireUser();
  if (user.role !== "ADMIN") return <AccessDenied />;
  const users = await listUsers();
  return (
    <>
      <PageHead title="Users" sub="There is no public sign-up. Invite people here; deactivating a user removes access immediately but keeps their name on history." />
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Export</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id}>
            <td>{u.name}{u.id === user.id ? " (you)" : ""}</td><td>{u.email}</td><td>{u.role === "ADMIN" ? "Admin" : "Internal user"}</td>
            <td><Badge status={u.active ? "ACTIVE" : "INACTIVE"} />{!u.has_password ? <> <span className="badge warn">Invite pending</span></> : null}</td>
            <td>{u.role === "ADMIN" || u.can_export ? "Yes" : "No"}</td><td className="nowrap">{when(u.created_at)}</td>
            <td>
              <div className="actions">
                <ActionButton path={`/users/${u.id}`} method="PATCH" body={{ active: !u.active, version: u.version }} label={u.active ? "Deactivate" : "Activate"} kind={u.active ? "danger" : undefined}
                  confirmText={u.active ? `Deactivate ${u.name}? They are signed out at once and cannot sign in.` : undefined} />
                <ActionButton path={`/users/${u.id}`} method="PATCH" body={{ role: u.role === "ADMIN" ? "INTERNAL_USER" : "ADMIN", version: u.version }} label={u.role === "ADMIN" ? "Make internal user" : "Make admin"}
                  confirmText={`Change ${u.name}'s role?`} />
                {u.role !== "ADMIN" ? <ActionButton path={`/users/${u.id}`} method="PATCH" body={{ canExport: !u.can_export, version: u.version }} label={u.can_export ? "Remove export" : "Allow export"} /> : null}
                {u.active ? <ActionButton path={`/users/${u.id}/access-link`} label={u.has_password ? "Reset link" : "New invite link"}
                  showResult={{ key: "url", label: "Single-use link. Send it to the user over a trusted channel; it is shown only once." }} /> : null}
              </div>
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="card">
        <h2>Invite a user</h2>
        {allowedEmailDomains().length ? <p className="muted">Only {allowedEmailDomains().map((d) => `@${d}`).join(", ")} email addresses can be invited or sign in.</p> : null}
        <ApiForm path="/users" submitLabel="Create user and invite link" successText="User created." showResult={{ key: "inviteUrl", label: "Single-use invite link, valid for 72 hours. Send it to the user over a trusted channel; it is shown only once." }} fields={[
          { name: "name", label: "Name", required: true }, { name: "email", label: "Email", type: "email", required: true },
          { name: "role", label: "Role", type: "select", required: true, defaultValue: "INTERNAL_USER", options: [{ value: "INTERNAL_USER", label: "Internal user" }, { value: "ADMIN", label: "Admin" }] },
          { name: "canExport", label: "Can export reports and bills", type: "checkbox", defaultValue: true },
        ]} />
      </div>
    </>
  );
}
