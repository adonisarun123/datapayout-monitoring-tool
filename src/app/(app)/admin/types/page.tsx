import { requireUser } from "@/lib/session";
import { listDeviceTypes } from "@/server/masters";
import { AccessDenied, Badge, PageHead } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function TypesPage() {
  const user = await requireUser();
  if (user.role !== "ADMIN") return <AccessDenied />;
  const types = await listDeviceTypes();
  return (
    <>
      <PageHead title="Device types" sub="Rename the three placeholder types to match the business. Types with history are deactivated, never deleted." />
      <div className="grid cols-2">
        {types.map((t) => (
          <div className="card" key={t.id}>
            <h2>{t.name} <Badge status={t.active ? "ACTIVE" : "INACTIVE"} /></h2>
            <p className="muted">{t.device_count} devices, {t.active_device_count} active</p>
            <ApiForm path={`/device-types/${t.id}`} method="PATCH" submitLabel="Save" extra={{ version: t.version }} resetOnSuccess={false} fields={[
              { name: "name", label: "Name", required: true, defaultValue: t.name },
              { name: "description", label: "Description", defaultValue: t.description ?? "" },
              { name: "active", label: "Active (new devices can use this type)", type: "checkbox", defaultValue: t.active },
            ]} />
          </div>
        ))}
        <div className="card">
          <h2>Add a type</h2>
          <ApiForm path="/device-types" submitLabel="Add type" fields={[{ name: "name", label: "Name", required: true }, { name: "description", label: "Description" }]} />
        </div>
      </div>
    </>
  );
}
