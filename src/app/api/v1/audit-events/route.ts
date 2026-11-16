import { pageParams, route, sp } from "@/lib/http";
import { listAudit } from "@/server/reports";

export const GET = route({ admin: true }, async ({ url }) =>
  listAudit({
    entityType: sp(url, "entityType"), entityId: sp(url, "entityId"), actorId: sp(url, "actorId"), action: sp(url, "action"),
    dateFrom: sp(url, "dateFrom"), dateTo: sp(url, "dateTo"), ...pageParams(url),
  }));
