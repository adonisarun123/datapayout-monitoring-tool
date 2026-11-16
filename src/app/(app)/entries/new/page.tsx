import { requireUser } from "@/lib/session";
import { getDevice } from "@/server/masters";
import { todayIST } from "@/lib/dates";
import { readParams, type SearchParams } from "@/lib/format";
import { PageHead } from "@/components/ui";
import { EntryForm } from "@/components/entry-form";

export default async function NewEntryPage({ searchParams }: { searchParams: SearchParams }) {
  await requireUser();
  const p = await readParams(searchParams);
  let initial = null;
  if (p.deviceId) {
    try {
      const { device } = await getDevice(p.deviceId);
      if (device.status === "ACTIVE") initial = { id: device.id, code: device.code, name: device.name, type_name: device.type_name };
    } catch { /* ignore a bad id */ }
  }
  return (
    <>
      <PageHead title="New data entry" sub="Record the hours of data collected for one device on one date. An entry is submitted in a single step and cannot be edited afterwards." />
      <EntryForm today={todayIST()} initialDevice={initial} />
    </>
  );
}
