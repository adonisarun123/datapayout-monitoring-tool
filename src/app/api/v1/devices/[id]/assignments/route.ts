import { route } from "@/lib/http";
import { createAssignment, listAssignments } from "@/server/masters";

export const GET = route({}, async ({ params }) => listAssignments(params.id));
export const POST = route({ admin: true, status: 201 }, async ({ actor, params, body }) => createAssignment(actor, params.id, body));
