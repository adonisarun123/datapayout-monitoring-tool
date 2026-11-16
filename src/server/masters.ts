import { db, one, q, tx, type Db } from "@/lib/db";
import { conflict, invalid, notFound, staleVersion } from "@/lib/errors";
import { requireDate, todayIST } from "@/lib/dates";
import { parseCsv } from "@/lib/csv";
import { audit, requireAdmin, type Actor } from "./audit";
import { dec, parsePercentage, parseRate } from "./calc";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const text = (v: unknown, max = 2000): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const required = (v: unknown, field: string, max = 200): string => {
  const s = text(v, max);
  if (!s) throw invalid("REQUIRED", `${field} is required.`, { field });
  return s;
};

// ------------------------------------------------------------------ device types

export async function listDeviceTypes() {
  return q(
    db,
    `select t.*, (select count(*)::int from devices d where d.type_id = t.id) as device_count,
            (select count(*)::int from devices d where d.type_id = t.id and d.status = 'ACTIVE') as active_device_count
       from device_types t order by t.name`,
  );
}

export async function createDeviceType(actor: Actor, input: { name: string; description?: string | null }) {
  requireAdmin(actor);
  const name = required(input.name, "Name");
  return tx(async (d) => {
    const row = await one(
      d,
      `insert into device_types (name, name_normalized, description, created_by, updated_by)
       values ($1, $2, $3, $4, $4) returning *`,
      [name, norm(name), text(input.description), actor.id],
    );
    await audit(d, actor, "DEVICE_TYPE_CREATED", "device_type", row.id, { after: row });
    return row;
  });
}

export async function updateDeviceType(
  actor: Actor,
  id: string,
  input: { name?: string; description?: string | null; active?: boolean; version: number },
) {
  requireAdmin(actor);
  return tx(async (d) => {
    const before = await one(d, "select * from device_types where id = $1 for update", [id]);
    if (!before) throw notFound("Device type");
    if (before.version !== input.version) throw staleVersion();
    const name = input.name !== undefined ? required(input.name, "Name") : before.name;
    const after = await one(
      d,
      `update device_types set name = $2, name_normalized = $3, description = $4, active = $5,
              updated_at = now(), updated_by = $6, version = version + 1 where id = $1 returning *`,
      [id, name, norm(name), input.description !== undefined ? text(input.description) : before.description,
       input.active ?? before.active, actor.id],
    );
    await audit(d, actor, "DEVICE_TYPE_UPDATED", "device_type", id, { before, after });
    return after;
  });
}

// ------------------------------------------------------------------ POCs

export async function listPocs(filter: { active?: boolean; search?: string } = {}) {
  const today = todayIST();
  return q(
    db,
    `select p.*,
            (select count(*)::int from device_poc_assignments a
              where a.poc_id = p.id and a.valid_from <= $1 and (a.valid_to_exclusive is null or a.valid_to_exclusive > $1)) as current_device_count
       from pocs p
      where ($2::boolean is null or p.active = $2)
        and ($3::text is null or p.name ilike '%' || $3 || '%' or p.organization ilike '%' || $3 || '%')
      order by p.name`,
    [today, filter.active ?? null, filter.search?.trim() || null],
  );
}

export async function getPoc(id: string) {
  const poc = await one(db, "select * from pocs where id = $1", [id]);
  if (!poc) throw notFound("POC");
  const assignments = await q(
    db,
    `select a.*, d.code as device_code, d.name as device_name from device_poc_assignments a
       join devices d on d.id = a.device_id where a.poc_id = $1 order by a.valid_from desc`,
    [id],
  );
  return { poc, assignments };
}

function pocFields(input: any) {
  const email = text(input.email, 320);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("INVALID_EMAIL", "Enter a valid email address.");
  return { phone: text(input.phone, 40), email, organization: text(input.organization, 200), notes: text(input.notes) };
}

export async function createPoc(actor: Actor, input: any) {
  requireAdmin(actor);
  const name = required(input.name, "Name");
  const f = pocFields(input);
  return tx(async (d) => {
    const row = await one(
      d,
      `insert into pocs (name, phone, email, organization, notes, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $6) returning *`,
      [name, f.phone, f.email, f.organization, f.notes, actor.id],
    );
    await audit(d, actor, "POC_CREATED", "poc", row.id, { after: row });
    return row;
  });
}

export async function updatePoc(actor: Actor, id: string, input: any) {
  requireAdmin(actor);
  return tx(async (d) => {
    const before = await one(d, "select * from pocs where id = $1 for update", [id]);
    if (!before) throw notFound("POC");
    if (before.version !== input.version) throw staleVersion();
    const merged = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    const f = pocFields(merged);
    const after = await one(
      d,
      `update pocs set name = $2, phone = $3, email = $4, organization = $5, notes = $6, active = $7,
              updated_at = now(), updated_by = $8, version = version + 1 where id = $1 returning *`,
      [id, required(merged.name, "Name"), f.phone, f.email, f.organization, f.notes, merged.active === true, actor.id],
    );
    await audit(d, actor, "POC_UPDATED", "poc", id, { before, after });
    return after;
  });
}

// ------------------------------------------------------------------ devices

const STATUSES = ["ACTIVE", "INACTIVE", "RETIRED"];

export interface DeviceFilter { typeId?: string; status?: string; search?: string; pocId?: string; page?: number; pageSize?: number }

export async function listDevices(filter: DeviceFilter = {}) {
  const today = todayIST();
  const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 500);
  const page = Math.max(filter.page ?? 1, 1);
  const params = [today, filter.typeId || null, filter.status || null, filter.search?.trim() || null, filter.pocId || null];
  const where = `
      where ($2::uuid is null or d.type_id = $2)
        and ($3::text is null or d.status = $3)
        and ($4::text is null or d.code ilike '%' || $4 || '%' or d.name ilike '%' || $4 || '%' or d.serial ilike '%' || $4 || '%')
        and ($5::uuid is null or a.poc_id = $5)`;
  const from = `
       from devices d
       join device_types t on t.id = d.type_id
       left join device_poc_assignments a on a.device_id = d.id and a.valid_from <= $1 and (a.valid_to_exclusive is null or a.valid_to_exclusive > $1)
       left join pocs p on p.id = a.poc_id
       left join payout_rules r on r.device_id = d.id and r.valid_from <= $1 and (r.valid_to_exclusive is null or r.valid_to_exclusive > $1)`;
  const total = await one<{ n: number }>(db, `select count(*)::int as n ${from} ${where}`, params);
  const rows = await q(
    db,
    `select d.*, t.name as type_name, p.id as poc_id, p.name as poc_name, r.rate, r.currency, r.percentage
       ${from} ${where} order by d.code_normalized, d.id limit ${pageSize} offset ${(page - 1) * pageSize}`,
    params,
  );
  return { rows, total: total?.n ?? 0, page, pageSize };
}

export async function getDevice(id: string) {
  const device = await one(
    db,
    "select d.*, t.name as type_name from devices d join device_types t on t.id = d.type_id where d.id = $1",
    [id],
  );
  if (!device) throw notFound("Device");
  const [assignments, rules] = await Promise.all([listAssignments(id), listRules(id)]);
  return { device, assignments, rules };
}

async function validateDeviceInput(d: Db, input: any, existing?: any) {
  const code = input.code !== undefined ? required(input.code, "Device code", 100) : existing.code;
  const name = input.name !== undefined ? required(input.name, "Display name") : existing.name;
  const typeId = input.typeId ?? existing?.type_id;
  if (!typeId) throw invalid("REQUIRED", "Device type is required.", { field: "typeId" });
  const type = await one(d, "select id, active from device_types where id = $1", [typeId]);
  if (!type) throw invalid("INVALID_TYPE", "Device type does not exist.");
  if (!type.active && typeId !== existing?.type_id) throw invalid("INACTIVE_TYPE", "Device type is inactive.");
  const status = input.status ?? existing?.status ?? "ACTIVE";
  if (!STATUSES.includes(status)) throw invalid("INVALID_STATUS", "Status must be ACTIVE, INACTIVE or RETIRED.");
  const commissionedOn = requireDate(input.commissionedOn ?? existing?.commissioned_on, "Commissioning date");
  const until = input.activeUntilExclusive !== undefined ? input.activeUntilExclusive : existing?.active_until_exclusive;
  const activeUntil = until ? requireDate(until, "Active-until date") : null;
  if (activeUntil && activeUntil <= commissionedOn)
    throw invalid("INVALID_DATE_RANGE", "Active-until date must be after the commissioning date.");
  const serial = input.serial !== undefined ? text(input.serial, 200) : existing?.serial ?? null;
  const notes = input.notes !== undefined ? text(input.notes) : existing?.notes ?? null;
  return { code, name, typeId, status, commissionedOn, activeUntil, serial, notes };
}

async function insertDevice(d: Db, actor: Actor, v: Awaited<ReturnType<typeof validateDeviceInput>>) {
  return one(
    d,
    `insert into devices (code, code_normalized, serial, serial_normalized, type_id, name, status, commissioned_on,
                          active_until_exclusive, notes, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning *`,
    [v.code, norm(v.code), v.serial, v.serial ? norm(v.serial) : null, v.typeId, v.name, v.status, v.commissionedOn,
     v.activeUntil, v.notes, actor.id],
  );
}

export async function createDevice(actor: Actor, input: any) {
  requireAdmin(actor);
  return tx(async (d) => {
    const row = await insertDevice(d, actor, await validateDeviceInput(d, input));
    await audit(d, actor, "DEVICE_CREATED", "device", row.id, { after: row });
    return row;
  });
}

export async function updateDevice(actor: Actor, id: string, input: any) {
  requireAdmin(actor);
  return tx(async (d) => {
    const before = await one(d, "select * from devices where id = $1 for update", [id]);
    if (!before) throw notFound("Device");
    if (before.version !== input.version) throw staleVersion();
    const v = await validateDeviceInput(d, input, before);
    const after = await one(
      d,
      `update devices set code = $2, code_normalized = $3, serial = $4, serial_normalized = $5, type_id = $6, name = $7,
              status = $8, commissioned_on = $9, active_until_exclusive = $10, notes = $11,
              updated_at = now(), updated_by = $12, version = version + 1 where id = $1 returning *`,
      [id, v.code, norm(v.code), v.serial, v.serial ? norm(v.serial) : null, v.typeId, v.name, v.status, v.commissionedOn,
       v.activeUntil, v.notes, actor.id],
    );
    await audit(d, actor, "DEVICE_UPDATED", "device", id, { before, after });
    return after;
  });
}

// CSV import (FR-007): preview with per-row errors, then all-or-nothing commit.
export const IMPORT_HEADERS = ["code", "name", "type", "commissioned_on", "serial", "status", "notes"];

export async function previewDeviceImport(actor: Actor, csv: string) {
  requireAdmin(actor);
  const rows = parseCsv(csv ?? "");
  if (!rows.length) throw invalid("EMPTY_FILE", "The file has no rows.");
  if (rows.length > 5001) throw invalid("TOO_MANY_ROWS", "Import at most 5,000 devices at a time.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = ["code", "name", "type", "commissioned_on"].filter((h) => !header.includes(h));
  if (missing.length) throw invalid("MISSING_COLUMNS", `Missing columns: ${missing.join(", ")}. Expected: ${IMPORT_HEADERS.join(", ")}.`);
  const col = (r: string[], h: string) => (header.includes(h) ? (r[header.indexOf(h)] ?? "").trim() : "");

  const types = await q(db, "select id, name_normalized, active from device_types");
  const existing = await q(db, "select code_normalized, serial_normalized from devices");
  const codes = new Set(existing.map((e) => e.code_normalized));
  const serials = new Set(existing.map((e) => e.serial_normalized).filter(Boolean));
  const seenCodes = new Set<string>();
  const seenSerials = new Set<string>();

  const out = rows.slice(1).map((r, i) => {
    const errors: string[] = [];
    const code = col(r, "code"), name = col(r, "name"), typeName = col(r, "type"), date = col(r, "commissioned_on");
    const serial = col(r, "serial"), status = (col(r, "status") || "ACTIVE").toUpperCase(), notes = col(r, "notes");
    if (!code) errors.push("code is required");
    else if (codes.has(norm(code))) errors.push("code already exists");
    else if (seenCodes.has(norm(code))) errors.push("code is repeated in this file");
    if (code) seenCodes.add(norm(code));
    if (!name) errors.push("name is required");
    const type = types.find((t) => t.name_normalized === norm(typeName));
    if (!type) errors.push(`unknown device type "${typeName}"`);
    else if (!type.active) errors.push("device type is inactive");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) errors.push("commissioned_on must be YYYY-MM-DD");
    if (serial) {
      if (serials.has(norm(serial))) errors.push("serial already exists");
      else if (seenSerials.has(norm(serial))) errors.push("serial is repeated in this file");
      seenSerials.add(norm(serial));
    }
    if (!STATUSES.includes(status)) errors.push("status must be ACTIVE, INACTIVE or RETIRED");
    return { row: i + 2, code, name, typeName, typeId: type?.id ?? null, commissionedOn: date, serial, status, notes, errors };
  });
  return { rows: out, valid: out.length > 0 && out.every((r) => !r.errors.length), errorCount: out.filter((r) => r.errors.length).length };
}

export async function commitDeviceImport(actor: Actor, csv: string) {
  const preview = await previewDeviceImport(actor, csv);
  if (!preview.valid)
    throw invalid("IMPORT_HAS_ERRORS", "Nothing was imported: fix the row errors and try again.", { rows: preview.rows.filter((r) => r.errors.length) });
  return tx(async (d) => {
    for (const r of preview.rows) {
      const v = await validateDeviceInput(d, { ...r, serial: r.serial || null, notes: r.notes || null });
      await insertDevice(d, actor, v);
    }
    await audit(d, actor, "DEVICES_IMPORTED", "device", null, { after: { count: preview.rows.length, codes: preview.rows.map((r) => r.code) } });
    return { imported: preview.rows.length };
  });
}

// ------------------------------------------------------------------ effective-dated assignments and rules

export async function listAssignments(deviceId: string) {
  return q(
    db,
    `select a.*, p.name as poc_name, u.name as created_by_name from device_poc_assignments a
       join pocs p on p.id = a.poc_id left join users u on u.id = a.created_by
      where a.device_id = $1 order by a.valid_from desc`,
    [deviceId],
  );
}

export async function listRules(deviceId: string) {
  return q(
    db,
    `select r.*, u.name as created_by_name from payout_rules r left join users u on u.id = r.created_by
      where r.device_id = $1 order by r.valid_from desc`,
    [deviceId],
  );
}

interface DatedInput { validFrom: string; validToExclusive?: string | null; reason?: string | null; confirmRetroactive?: boolean }

/** FR-011: a record that starts in the past needs a reason and an explicit confirmation. */
function checkRetroactive(effectiveDate: string, input: { reason?: string | null; confirmRetroactive?: boolean }) {
  if (effectiveDate >= todayIST()) return;
  if (!input.confirmRetroactive || !text(input.reason))
    throw invalid(
      "RETROACTIVE_CONFIRMATION_REQUIRED",
      "This change takes effect in the past. Entries already submitted keep the terms they were saved with and will not be repriced. Enter a reason and confirm to continue.",
    );
}

async function prepareDated(d: Db, table: "device_poc_assignments" | "payout_rules", deviceId: string, input: DatedInput) {
  const device = await one(d, "select id from devices where id = $1 for update", [deviceId]);
  if (!device) throw notFound("Device");
  const validFrom = requireDate(input.validFrom, "Start date");
  const validTo = input.validToExclusive ? requireDate(input.validToExclusive, "End date") : null;
  if (validTo && validTo <= validFrom) throw invalid("INVALID_DATE_RANGE", "End date must be after the start date.");
  checkRetroactive(validFrom, input);
  // Close the open-ended predecessor at the new start date, so a change is one action for the admin.
  const closed = await q(
    d,
    `update ${table} set valid_to_exclusive = $2 where device_id = $1 and valid_to_exclusive is null and valid_from < $2 returning id`,
    [deviceId, validFrom],
  );
  return { validFrom, validTo, closedIds: closed.map((c) => c.id) };
}

export async function createAssignment(actor: Actor, deviceId: string, input: DatedInput & { pocId: string }) {
  requireAdmin(actor);
  return tx(async (d) => {
    const poc = await one(d, "select id, active from pocs where id = $1", [input.pocId]);
    if (!poc) throw invalid("INVALID_POC", "POC does not exist.");
    if (!poc.active) throw invalid("INACTIVE_POC", "A device can only be assigned to an active POC.");
    const p = await prepareDated(d, "device_poc_assignments", deviceId, input);
    const row = await one(
      d,
      `insert into device_poc_assignments (device_id, poc_id, valid_from, valid_to_exclusive, reason, created_by)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [deviceId, input.pocId, p.validFrom, p.validTo, text(input.reason), actor.id],
    );
    await audit(d, actor, "ASSIGNMENT_CREATED", "device", deviceId, { reason: text(input.reason), after: { ...row, closedPrevious: p.closedIds } });
    return row;
  });
}

export async function createRule(
  actor: Actor,
  deviceId: string,
  input: DatedInput & { rate: string; currency: string; percentage: string; confirmZero?: boolean },
) {
  requireAdmin(actor);
  const rate = parseRate(input.rate);
  const percentage = parsePercentage(input.percentage);
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw invalid("INVALID_CURRENCY", "Currency must be a 3-letter ISO code.");
  if ((dec(rate).isZero() || dec(percentage).isZero()) && !input.confirmZero)
    throw invalid("ZERO_CONFIRMATION_REQUIRED", "A zero rate or zero percentage pays nothing. Confirm to save it anyway.");
  return tx(async (d) => {
    const p = await prepareDated(d, "payout_rules", deviceId, input);
    const row = await one(
      d,
      `insert into payout_rules (device_id, rate, currency, percentage, valid_from, valid_to_exclusive, reason, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [deviceId, rate, currency, percentage, p.validFrom, p.validTo, text(input.reason), actor.id],
    );
    await audit(d, actor, "PAYOUT_RULE_CREATED", "device", deviceId, { reason: text(input.reason), after: { ...row, closedPrevious: p.closedIds } });
    return row;
  });
}

/** Sets the end date of an assignment or rule. Snapshots on existing entries are untouched. */
export async function endDated(
  actor: Actor,
  kind: "assignment" | "rule",
  id: string,
  input: { validToExclusive: string; reason?: string | null; confirmRetroactive?: boolean },
) {
  requireAdmin(actor);
  const table = kind === "assignment" ? "device_poc_assignments" : "payout_rules";
  return tx(async (d) => {
    const before = await one(d, `select * from ${table} where id = $1 for update`, [id]);
    if (!before) throw notFound(kind === "assignment" ? "Assignment" : "Payout rule");
    const validTo = requireDate(input.validToExclusive, "End date");
    if (validTo <= before.valid_from) throw invalid("INVALID_DATE_RANGE", "End date must be after the start date.");
    checkRetroactive(validTo, input);
    const after = await one(d, `update ${table} set valid_to_exclusive = $2 where id = $1 returning *`, [id, validTo]);
    await audit(d, actor, kind === "assignment" ? "ASSIGNMENT_ENDED" : "PAYOUT_RULE_ENDED", "device", before.device_id, {
      reason: text(input.reason), before, after,
    });
    return after;
  });
}

/** The single assignment and rule in force for a device on a business date (BR-01). */
export async function resolveTerms(d: Db, deviceId: string, date: string) {
  const assignment = await one(
    d,
    `select a.*, p.name as poc_name from device_poc_assignments a join pocs p on p.id = a.poc_id
      where a.device_id = $1 and a.valid_from <= $2 and (a.valid_to_exclusive is null or a.valid_to_exclusive > $2)`,
    [deviceId, date],
  );
  const rule = await one(
    d,
    `select * from payout_rules where device_id = $1 and valid_from <= $2 and (valid_to_exclusive is null or valid_to_exclusive > $2)`,
    [deviceId, date],
  );
  return { assignment, rule };
}
