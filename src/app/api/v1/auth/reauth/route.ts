import { rateLimit, route } from "@/lib/http";
import { reauthenticate } from "@/server/auth";

export const POST = route({}, async ({ actor, body }) => {
  rateLimit(`reauth:${actor.id}`, 10, 60_000);
  await reauthenticate(actor, String(body.password ?? ""));
  return { ok: true };
});
