import { route } from "@/lib/http";
import { cancelBill } from "@/server/bills";

export const POST = route({ admin: true }, async ({ actor, params, body }) => cancelBill(actor, params.id, body));
