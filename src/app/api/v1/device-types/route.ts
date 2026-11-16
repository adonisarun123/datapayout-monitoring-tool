import { route } from "@/lib/http";
import { createDeviceType, listDeviceTypes } from "@/server/masters";

export const GET = route({}, async () => listDeviceTypes());
export const POST = route({ admin: true, status: 201 }, async ({ actor, body }) => createDeviceType(actor, body));
