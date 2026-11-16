import { route } from "@/lib/http";
import { correctEntry } from "@/server/entries";

export const POST = route({ admin: true }, async ({ actor, params, body }) => correctEntry(actor, params.id, body));
