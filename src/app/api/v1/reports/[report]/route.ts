import { route, sp } from "@/lib/http";
import { runReport } from "@/server/reports";

export const GET = route({}, async ({ params, url }) =>
  runReport(params.report, {
    dateFrom: sp(url, "dateFrom"), dateTo: sp(url, "dateTo"), typeId: sp(url, "typeId"), deviceId: sp(url, "deviceId"),
    pocId: sp(url, "pocId"), status: sp(url, "status"),
  }));
