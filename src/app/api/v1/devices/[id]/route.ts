import { route } from "@/lib/http";
import { getDevice, updateDevice } from "@/server/masters";

export const GET = route({}, async ({ params }) => getDevice(params.id));
export const PATCH = route({ admin: true }, async ({ actor, params, body }) => updateDevice(actor, params.id, body));
