import Link from "next/link";
import { requireUser } from "@/lib/session";
import { getSettings } from "@/server/settings";
import { LogoutButton } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const settings = await getSettings();
  const admin = user.role === "ADMIN";
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">{settings.organization_name}</div>
        <Link href="/">Dashboard</Link>
        <Link href="/entries/new">New data entry</Link>
        <Link href="/entries">Entries</Link>
        <Link href="/devices">Devices</Link>
        <Link href="/pocs">POCs</Link>
        <Link href="/bills">Bills</Link>
        <Link href="/reports">Reports</Link>
        {admin ? (
          <>
            <div className="group">Admin</div>
            <Link href="/admin/users">Users</Link>
            <Link href="/admin/types">Device types</Link>
            <Link href="/admin/settings">Settings</Link>
            <Link href="/admin/audit">Audit log</Link>
          </>
        ) : null}
        <div className="who">
          <div>{user.name}</div>
          <div className="muted">{admin ? "Administrator" : "Internal user"}</div>
          <LogoutButton />
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
