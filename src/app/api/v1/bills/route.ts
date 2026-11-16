import { pageParams, route, sp } from "@/lib/http";
import { createBill, listBills } from "@/server/bills";

export const GET = route({}, async ({ url }) =>
  listBills({
    status: sp(url, "status"), pocId: sp(url, "pocId"), type: sp(url, "type"), approvedFrom: sp(url, "approvedFrom"),
    approvedTo: sp(url, "approvedTo"), paymentStatus: sp(url, "paymentStatus"), ...pageParams(url),
  }));
export const POST = route({ admin: true, status: 201 }, async ({ actor, body }) => createBill(actor, body));
