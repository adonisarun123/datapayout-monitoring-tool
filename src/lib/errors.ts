export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details = {}) => new AppError(400, code, message, details);
export const unauthenticated = (message = "Sign in to continue.") => new AppError(401, "UNAUTHENTICATED", message);
export const forbidden = (code = "FORBIDDEN", message = "You do not have permission to do this.") =>
  new AppError(403, code, message);
export const notFound = (what = "Record") => new AppError(404, "NOT_FOUND", `${what} was not found.`);
export const conflict = (code: string, message: string, details = {}) => new AppError(409, code, message, details);
export const invalid = (code: string, message: string, details = {}) => new AppError(422, code, message, details);

export const staleVersion = () =>
  conflict("STALE_VERSION", "This record was changed by someone else. Refresh and try again.");

/** Maps well-known PostgreSQL errors to AppErrors; returns null if not recognised. */
export function fromPgError(e: any): AppError | null {
  if (!e || typeof e.code !== "string") return null;
  switch (e.code) {
    case "23P01": // exclusion violation
      return conflict("DATE_RANGE_OVERLAP", "The date range overlaps an existing record for this device.");
    case "23505": {
      const c = String(e.constraint ?? "");
      if (c === "data_entries_device_reference_key")
        return conflict("DUPLICATE_REFERENCE", "This reference has already been used for this device.");
      if (c === "bill_lines_entry_reservation_key")
        return conflict("ENTRY_ALREADY_RESERVED", "One or more entries are already on another active bill.");
      if (c === "bill_lines_original_line_reservation_key")
        return conflict("LINE_UNDER_ADJUSTMENT", "One or more lines already have an adjustment in progress.");
      if (c === "users_email_normalized_key") return conflict("DUPLICATE_EMAIL", "A user with this email already exists.");
      if (c === "devices_code_normalized_key") return conflict("DUPLICATE_DEVICE_CODE", "This device code is already in use.");
      if (c === "devices_serial_normalized_key") return conflict("DUPLICATE_SERIAL", "This serial number is already in use.");
      if (c === "device_types_name_normalized_key") return conflict("DUPLICATE_TYPE_NAME", "A device type with this name already exists.");
      return conflict("DUPLICATE", "A record with the same unique value already exists.");
    }
    case "40P01":
    case "40001":
      return conflict("CONCURRENT_UPDATE", "Another change was in progress. Refresh and try again.");
    case "22003":
      return invalid("NUMERIC_OVERFLOW", "A number is too large or too precise to store.");
    case "23503":
      return conflict("REFERENCED_RECORD", "This record is referenced by other records and cannot be changed this way.");
    case "23514":
      return invalid("CHECK_FAILED", "A value is outside its permitted range.");
    default:
      return null;
  }
}
