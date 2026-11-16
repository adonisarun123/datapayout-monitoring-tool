import { clientIp, rateLimit, route, sessionCookie } from "@/lib/http";
import { login } from "@/server/auth";

export const POST = route({ public: true }, async ({ req, body, requestId }) => {
  rateLimit(`login:${clientIp(req) ?? "unknown"}`, 20, 60_000);
  const { token, user } = await login(String(body.email ?? ""), String(body.password ?? ""), {
    ip: clientIp(req), userAgent: req.headers.get("user-agent"), requestId,
  });
  return Response.json(
    { data: { id: user.id, name: user.name, role: user.role }, requestId },
    { headers: { "set-cookie": sessionCookie(token), "cache-control": "no-store" } },
  );
});
