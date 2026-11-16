import { route } from "@/lib/http";
import { previewBill } from "@/server/bills";

export const POST = route({ admin: true }, async ({ actor, body }) => previewBill(actor, body));
