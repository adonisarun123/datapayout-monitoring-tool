import { route } from "@/lib/http";
import { getEntry } from "@/server/entries";

export const GET = route({}, async ({ params }) => getEntry(params.id));
