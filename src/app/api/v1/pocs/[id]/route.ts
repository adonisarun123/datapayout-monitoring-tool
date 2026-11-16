import { route } from "@/lib/http";
import { getPoc, updatePoc } from "@/server/masters";

export const GET = route({}, async ({ params }) => getPoc(params.id));
export const PATCH = route({ admin: true }, async ({ actor, params, body }) => updatePoc(actor, params.id, body));
