import { route } from "@/lib/http";
import { submitBill } from "@/server/bills";

export const POST = route({ admin: true }, async ({ actor, params, body }) => submitBill(actor, params.id, body));
