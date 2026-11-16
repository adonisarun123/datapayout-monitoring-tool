import { route } from "@/lib/http";
import { reversePayment } from "@/server/payments";

export const POST = route({ admin: true, status: 201 }, async ({ actor, params, body }) => reversePayment(actor, params.id, body));
