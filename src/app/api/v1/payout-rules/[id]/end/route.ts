import { route } from "@/lib/http";
import { endDated } from "@/server/masters";

export const POST = route({ admin: true }, async ({ actor, params, body }) => endDated(actor, "rule", params.id, body));
