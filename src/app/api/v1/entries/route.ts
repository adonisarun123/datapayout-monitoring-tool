import { pageParams, route, sp } from "@/lib/http";
import { listEntries, submitEntry } from "@/server/entries";

export const GET = route({}, async ({ url }) =>
  listEntries({
    dateFrom: sp(url, "dateFrom"), dateTo: sp(url, "dateTo"), deviceId: sp(url, "deviceId"), typeId: sp(url, "typeId"),
    pocId: sp(url, "pocId"), createdBy: sp(url, "createdBy"), status: sp(url, "status"), billingState: sp(url, "billingState"),
    reference: sp(url, "reference"), ...pageParams(url),
  }));

// Any signed-in user may submit. There is deliberately no PUT/PATCH/DELETE on entries.
export const POST = route({ status: 201 }, async ({ actor, body }) => submitEntry(actor, body));
