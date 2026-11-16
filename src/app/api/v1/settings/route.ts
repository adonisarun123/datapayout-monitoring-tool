import { route } from "@/lib/http";
import { getSettingsWithVersions, updateSettings } from "@/server/settings";

export const GET = route({ admin: true }, async () => getSettingsWithVersions());
export const PATCH = route({ admin: true }, async ({ actor, body }) => updateSettings(actor, body.changes ?? {}, body.versions ?? {}));
