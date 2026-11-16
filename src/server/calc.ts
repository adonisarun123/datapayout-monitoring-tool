import Decimal from "decimal.js";
import { invalid } from "@/lib/errors";

/** Bump when the formula changes; stored on every entry version. */
export const CALCULATION_VERSION = 1;

// Independent Decimal constructor so precision/rounding here cannot be changed elsewhere.
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;
export const dec = (v: string | number | Decimal) => new D(v);

export interface Calculation {
  payableHoursRaw: string; // full precision
  amountRaw: string; // full precision
  lineAmount: string; // 2 dp, rounded half up
}

/**
 * SRS section 5:
 *   raw_payable_hours = hours × percentage / 100
 *   raw_amount        = raw_payable_hours × rate
 *   line amount       = round_half_up(raw_amount, 2)
 * Nothing is rounded before the final step.
 */
export function calculate(hours: string, percentage: string, rate: string): Calculation {
  const payable = dec(hours).times(dec(percentage)).div(100);
  const amount = payable.times(dec(rate));
  return {
    payableHoursRaw: payable.toFixed(),
    amountRaw: amount.toFixed(),
    lineAmount: amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  };
}

export function sumMoney(values: string[]): string {
  return values.reduce((acc, v) => acc.plus(dec(v)), dec(0)).toFixed(2);
}

/** Parses a non-negative decimal string, rejecting anything with more precision than allowed (BR-02). */
export function parseDecimal(
  value: unknown,
  field: string,
  opts: { maxDecimals: number; maxIntegerDigits: number; allowZero?: boolean; allowNegative?: boolean },
): string {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw invalid("INVALID_NUMBER", `${field} must be a decimal number.`, { field });
  const negative = s.startsWith("-");
  if (negative && !opts.allowNegative) throw invalid("INVALID_NUMBER", `${field} cannot be negative.`, { field });
  const [intPart, fracPart = ""] = s.replace("-", "").split(".");
  if (fracPart.length > opts.maxDecimals)
    throw invalid("TOO_PRECISE", `${field} allows at most ${opts.maxDecimals} decimal places.`, { field });
  if (intPart.replace(/^0+/, "").length > opts.maxIntegerDigits)
    throw invalid("NUMERIC_OVERFLOW", `${field} is too large.`, { field });
  const d = dec(s);
  if (d.isZero() && !opts.allowZero) throw invalid("INVALID_NUMBER", `${field} must be greater than zero.`, { field });
  return d.toFixed(opts.maxDecimals);
}

export const parseHours = (v: unknown, field = "Hours") => parseDecimal(v, field, { maxDecimals: 4, maxIntegerDigits: 14 });
export const parseRate = (v: unknown, field = "Rate") => parseDecimal(v, field, { maxDecimals: 4, maxIntegerDigits: 14, allowZero: true });
export const parseMoney = (v: unknown, field = "Amount", allowZero = false) =>
  parseDecimal(v, field, { maxDecimals: 2, maxIntegerDigits: 16, allowZero });
export function parsePercentage(v: unknown, field = "Percentage"): string {
  const p = parseDecimal(v, field, { maxDecimals: 4, maxIntegerDigits: 3, allowZero: true });
  if (dec(p).gt(100)) throw invalid("INVALID_PERCENTAGE", `${field} must be between 0 and 100.`, { field });
  return p;
}
