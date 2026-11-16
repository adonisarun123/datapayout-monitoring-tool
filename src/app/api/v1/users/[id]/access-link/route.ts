import { route } from "@/lib/http";
import { issueAccessLink } from "@/server/auth";

export const POST = route({ admin: true }, async ({ actor, params }) => issueAccessLink(actor, params.id));
