import { csvResponse, route, sp } from "@/lib/http";
import { runReport } from "@/server/reports";
import { reportCsv } from "@/server/exports";
import { audit } from "@/server/audit";
import { db } from "@/lib/db";
import { todayIST } from "@/lib/dates";

export const GET = route({ exportPermission: true }, async ({ params, url, actor }) => {
  const report = await runReport(params.report, {
    dateFrom: sp(url, "dateFrom"), dateTo: sp(url, "dateTo"), typeId: sp(url, "typeId"), deviceId: sp(url, "deviceId"),
    pocId: sp(url, "pocId"), status: sp(url, "status"),
  });
  await audit(db, actor, "REPORT_EXPORTED", "report", params.report, { after: { filters: report.filters, rows: report.rows.length } });
  return csvResponse(`${params.report}-${todayIST()}.csv`, await reportCsv(report, actor));
});
