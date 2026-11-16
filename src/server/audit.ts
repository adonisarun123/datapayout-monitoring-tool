import type { Db } from "@/lib/db";
import { forbidden } from "@/lib/errors";

export interface Actor {
  id: string;
  role: "ADMIN" | "INTERNAL_USER";
  name: string;
  email: string;
  canExport: boolean;
  requestId?: string;
  sessionId?: string;
  authenticatedAt?: Date;
}

const SECRET_KEYS = new Set(["password", "password_hash", "token", "token_hash", "passwordHash"]);

function scrub(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

export async function audit(
  d: Db,
  actor: Pick<Actor, "id" | "requestId"> | null,
  action: string,
  entityType: string,
  entityId: string | null,
  opts: { reason?: string | null; before?: unknown; after?: unknown } = {},
): Promise<void> {
  await d.query(
    `insert into audit_events (actor_id, action, entity_type, entity_id, reason, before_json, after_json, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actor?.id ?? null,
      action,
      entityType,
      entityId,
      opts.reason ?? null,
      opts.before === undefined ? null : JSON.stringify(scrub(opts.before)),
      opts.after === undefined ? null : JSON.stringify(scrub(opts.after)),
      actor?.requestId ?? null,
    ],
  );
}

export function requireAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") throw forbidden();
}
