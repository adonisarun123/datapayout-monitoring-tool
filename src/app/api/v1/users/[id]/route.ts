import { route } from "@/lib/http";
import { updateUser } from "@/server/auth";

export const PATCH = route({ admin: true }, async ({ actor, params, body }) => updateUser(actor, params.id, body));
