import { route } from "@/lib/http";
import { updateDeviceType } from "@/server/masters";

export const PATCH = route({ admin: true }, async ({ actor, params, body }) => updateDeviceType(actor, params.id, body));
