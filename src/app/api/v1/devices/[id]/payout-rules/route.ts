import { route } from "@/lib/http";
import { createRule, listRules } from "@/server/masters";

export const GET = route({}, async ({ params }) => listRules(params.id));
export const POST = route({ admin: true, status: 201 }, async ({ actor, params, body }) => createRule(actor, params.id, body));
