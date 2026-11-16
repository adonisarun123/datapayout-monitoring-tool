import { route } from "@/lib/http";
import { regenerateBill } from "@/server/bills";

export const POST = route({ admin: true }, async ({ actor, params, body }) => regenerateBill(actor, params.id, body));
