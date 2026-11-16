import { route } from "@/lib/http";
import { excludeLines } from "@/server/bills";

export const POST = route({ admin: true }, async ({ actor, params, body }) => excludeLines(actor, params.id, body));
