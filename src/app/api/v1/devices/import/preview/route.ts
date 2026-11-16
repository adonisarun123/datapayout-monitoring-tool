import { route } from "@/lib/http";
import { previewDeviceImport } from "@/server/masters";

export const POST = route({ admin: true }, async ({ actor, body }) => previewDeviceImport(actor, String(body.csv ?? "")));
