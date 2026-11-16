import Link from "next/link";
import { requireUser } from "@/lib/session";
import { PageHead } from "@/components/ui";

const ITEMS: [string, string, string][] = [
  ["device-utilization", "Device utilization", "Entries, recorded hours, payable hours and value per device, by activity date."],
  ["poc-statement", "POC statement", "Per POC: hours, unbilled estimate, approved bills, payments, outstanding and credits."],
  ["entry-detail", "Data entry detail", "Every entry with its captured terms and billing state."],
  ["billing-history", "Billing history", "All bills with status, totals, payment status and approver."],
  ["payment-ledger", "Payment ledger", "Payments and reversals by payment date."],
];

export default async function ReportsPage() {
  await requireUser();
  return (
    <>
      <PageHead title="Reports" sub="Each report states its date basis. Totals are per currency and reconcile with the rows shown." />
      <div className="grid cols-2">
        {ITEMS.map(([key, title, text]) => (
          <div className="card" key={key}><h2><Link href={`/reports/${key}`}>{title}</Link></h2><p className="muted">{text}</p></div>
        ))}
      </div>
    </>
  );
}
