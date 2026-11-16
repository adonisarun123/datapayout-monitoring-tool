import { db, one, q, tx } from "@/lib/db";
import { invalid, staleVersion } from "@/lib/errors";
import { audit, requireAdmin, type Actor } from "./audit";
import { parseDecimal, parsePercentage } from "./calc";

export interface Settings {
  default_currency: string;
  hours_warning_threshold: string;
  organization_name: string;
  default_payout_percentage: string;
  require_separate_approver: boolean;
}

export async function getSettings(): Promise<Settings> {
  const rows = await q<{ key: string; value: any }>(db, "select key, value from settings");
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as unknown as Settings;
}

export async function getSettingsWithVersions() {
  return q(db, "select key, value, modified_at, version from settings order by key");
}

const validators: Record<keyof Settings, (v: unknown) => unknown> = {
  default_currency: (v) => {
    if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw invalid("INVALID_CURRENCY", "Currency must be a 3-letter ISO code.");
    return v;
  },
  hours_warning_threshold: (v) => parseDecimal(v, "Warning threshold", { maxDecimals: 4, maxIntegerDigits: 14 }),
  organization_name: (v) => {
    if (typeof v !== "string" || !v.trim()) throw invalid("INVALID_NAME", "Organization name is required.");
    return v.trim().slice(0, 200);
  },
  default_payout_percentage: (v) => parsePercentage(v, "Default payout percentage"),
  require_separate_approver: (v) => v === true || v === "true",
};

/** Changing the default currency never converts existing entries; it only prefills new rules. */
export async function updateSettings(actor: Actor, changes: Partial<Record<keyof Settings, unknown>>, versions: Record<string, number> = {}) {
  requireAdmin(actor);
  return tx(async (d) => {
    for (const [key, raw] of Object.entries(changes)) {
      const validate = validators[key as keyof Settings];
      if (!validate) throw invalid("UNKNOWN_SETTING", `Unknown setting: ${key}`);
      const value = validate(raw);
      const before = await one(d, "select value, version from settings where key = $1 for update", [key]);
      if (before && versions[key] !== undefined && versions[key] !== before.version) throw staleVersion();
      if (before && JSON.stringify(before.value) === JSON.stringify(value)) continue;
      await d.query(
        `insert into settings (key, value, modified_by) values ($1, $2, $3)
         on conflict (key) do update set value = excluded.value, modified_by = excluded.modified_by, modified_at = now(), version = settings.version + 1`,
        [key, JSON.stringify(value), actor.id],
      );
      await audit(d, actor, "SETTING_CHANGED", "setting", key, { before: before?.value, after: value });
    }
    return getSettingsWithVersionsIn(d);
  });
}

async function getSettingsWithVersionsIn(d: any) {
  return q(d, "select key, value, modified_at, version from settings order by key");
}
