import { route } from "@/lib/http";
import { voidEntry } from "@/server/entries";

export const POST = route({ admin: true }, async ({ actor, params, body }) => voidEntry(actor, params.id, body));
