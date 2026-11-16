import { clientIp, rateLimit, route } from "@/lib/http";
import { consumeToken } from "@/server/auth";

// Accepts an invite or password-reset link: single use, time limited (FR-001).
export const POST = route({ public: true }, async ({ req, body, requestId }) => {
  rateLimit(`token:${clientIp(req) ?? "unknown"}`, 20, 60_000);
  await consumeToken(String(body.token ?? ""), body.password, requestId);
  return { ok: true };
});
