import { route } from "@/lib/http";
import { approveBill } from "@/server/bills";

// Approval is irreversible, so it needs an admin session with a recent password confirmation (FR-003).
export const POST = route({ admin: true, recentAuth: true }, async ({ actor, params, body }) => approveBill(actor, params.id, body));
