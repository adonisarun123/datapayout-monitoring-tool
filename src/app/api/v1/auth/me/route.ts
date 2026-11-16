import { route } from "@/lib/http";

export const GET = route({}, async ({ actor }) => ({ id: actor.id, name: actor.name, email: actor.email, role: actor.role, canExport: actor.canExport }));
