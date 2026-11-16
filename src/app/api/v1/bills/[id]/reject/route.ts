import { route } from "@/lib/http";
import { rejectBill } from "@/server/bills";

export const POST = route({ admin: true }, async ({ actor, params, body }) => rejectBill(actor, params.id, body));
