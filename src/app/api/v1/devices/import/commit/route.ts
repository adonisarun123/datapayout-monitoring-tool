import { route } from "@/lib/http";
import { commitDeviceImport } from "@/server/masters";

export const POST = route({ admin: true }, async ({ actor, body }) => commitDeviceImport(actor, String(body.csv ?? "")));
