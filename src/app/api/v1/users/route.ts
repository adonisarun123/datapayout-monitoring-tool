import { route } from "@/lib/http";
import { createUser, listUsers } from "@/server/auth";

export const GET = route({ admin: true }, async () => listUsers());
export const POST = route({ admin: true, status: 201 }, async ({ actor, body }) => createUser(actor, body));
