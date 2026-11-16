import { invalid } from "./errors";

export const BUSINESS_TZ = "Asia/Kolkata";

/** Today's business date in Asia/Kolkata as YYYY-MM-DD. */
export function todayIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function requireDate(s: unknown, field: string): string {
  if (!isValidDate(s)) throw invalid("INVALID_DATE", `${field} must be a valid date (YYYY-MM-DD).`, { field });
  return s;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatInstantIST(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: BUSINESS_TZ, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(dt) + " IST"
  );
}
