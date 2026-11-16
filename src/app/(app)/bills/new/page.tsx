import { requireUser } from "@/lib/session";
import { listPocs } from "@/server/masters";
import { getSettings } from "@/server/settings";
import { addDays, todayIST } from "@/lib/dates";
import { readParams, type SearchParams } from "@/lib/format";
import { AccessDenied, PageHead } from "@/components/ui";
import { BillBuilder } from "@/components/bill-forms";

export default async function NewBillPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  if (user.role !== "ADMIN") return <AccessDenied />;
  const p = await readParams(searchParams);
  const [pocs, settings] = await Promise.all([listPocs(), getSettings()]);
  const today = todayIST();
  return (
    <>
      <PageHead title="New bill" sub="Preview the unbilled, valid entries for one POC, currency and activity period, then create a draft. Each entry can be on only one active bill." />
      <BillBuilder pocs={pocs.map((x) => ({ id: x.id, name: x.name }))} defaults={{ pocId: p.pocId, currency: settings.default_currency, dateFrom: addDays(today, -30), dateTo: today }} />
    </>
  );
}
