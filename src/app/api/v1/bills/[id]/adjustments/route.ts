import { route } from "@/lib/http";
import { createAdjustment } from "@/server/bills";

export const POST = route({ admin: true, status: 201 }, async ({ actor, params, body }) => createAdjustment(actor, params.id, body));
