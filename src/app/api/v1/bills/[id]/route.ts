import { route } from "@/lib/http";
import { getBill } from "@/server/bills";

export const GET = route({}, async ({ params }) => getBill(params.id));
