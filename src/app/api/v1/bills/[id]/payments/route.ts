import { route } from "@/lib/http";
import { getBill } from "@/server/bills";
import { recordPayment } from "@/server/payments";

export const GET = route({}, async ({ params }) => (await getBill(params.id)).payments);
export const POST = route({ admin: true, status: 201 }, async ({ actor, params, body }) => recordPayment(actor, params.id, body));
