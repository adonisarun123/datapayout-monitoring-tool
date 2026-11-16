import { route } from "@/lib/http";
import { previewEntry } from "@/server/entries";

export const POST = route({}, async ({ body }) => previewEntry(body));
