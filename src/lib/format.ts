import { formatInstantIST } from "./dates";

/** Formats a decimal string exactly (no float conversion). Always shows the currency code. */
export function money(currency: string | null | undefined, amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency: currency || "INR", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(String(amount) as unknown as number);
  } catch {
    return `${currency ?? ""} ${amount}`.trim();
  }
}

export function num(value: string | number | null | undefined, decimals = 4): string {
  if (value === null || value === undefined || value === "") return "";
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(String(value) as unknown as number);
}

export const when = (d: Date | string | null | undefined) => formatInstantIST(d);
export const label = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

export function tone(status: string | null | undefined): string {
  switch (status) {
    case "APPROVED": case "PAID": case "VALID": case "ACTIVE": return "ok";
    case "PENDING_APPROVAL": case "PARTIALLY_PAID": case "DRAFT": return "info";
    case "NEEDS_REVIEW": case "UNPAID": case "UNBILLED": case "INACTIVE": case "CREDIT": return "warn";
    case "REJECTED": case "VOID": case "CANCELLED": case "RETIRED": case "REVERSAL": return "bad";
    default: return "";
  }
}

/** Builds a query string from search params, dropping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export async function readParams(sp: SearchParams): Promise<Record<string, string | undefined>> {
  const raw = await sp;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (Array.isArray(v) ? v[0] : v) || undefined]));
}
