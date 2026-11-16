import { route, sp } from "@/lib/http";
import { createPoc, listPocs } from "@/server/masters";

export const GET = route({}, async ({ url }) => {
  const active = sp(url, "active");
  return listPocs({ active: active === undefined ? undefined : active === "true", search: sp(url, "search") });
});
export const POST = route({ admin: true, status: 201 }, async ({ actor, body }) => createPoc(actor, body));
