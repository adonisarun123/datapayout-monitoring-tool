import { readCookie, route, sessionCookie } from "@/lib/http";
import { logout, SESSION_COOKIE } from "@/server/auth";

export const POST = route({ public: true }, async ({ req, requestId }) => {
  await logout(readCookie(req, SESSION_COOKIE));
  return Response.json({ data: null, requestId }, { headers: { "set-cookie": sessionCookie(null) } });
});
