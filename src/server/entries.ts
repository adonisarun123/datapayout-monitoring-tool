import { db, one, q, tx, type Db } from "@/lib/db";
import { conflict, invalid, notFound, staleVersion } from "@/lib/errors";
import { requireDate, todayIST } from "@/lib/dates";
import { audit, requireAdmin, type Actor } from "./audit";
import { calculate, CALCULATION_VERSION, dec, parseHours } from "./calc";
import { resolveTerms } from "./masters";
import { getSettings } from "./settings";

export const normalizeReference = (s: string) => s.trim().toLowerCase();
const maxHours = () => process.env.MAX_HOURS_PER_ENTRY ?? "100000";

export type EntryWarning = { code: "HOURS_ABOVE_THRESHOLD" | "POSSIBLE_DUPLICATE" | "ZERO_VALUE_TERMS"; message: string };

export interface EntryInput {
  deviceId: string;
  activityDate: string;
  hours: string;
  reference: string;
  notes?: string | null;
  acknowledgedWarnings?: string[];
}

const ENTRY_SELECT = `
  select e.id, e.status, e.version, e.submitted_at, e.created_by, cu.name as created_by_name,
         e.void_reason, e.voided_at, vu.name as voided_by_name,
         v.id as version_id, v.version_no, v.device_id, d.code as device_code, d.name as device_name,
         t.id as type_id, t.name as type_name, v.reference, v.activity_date, v.hours, v.notes,
         v.poc_id, p.name as poc_name, v.rate, v.percentage, v.currency, v.payable_hours_raw, v.line_amount,
         v.calculation_version, bl.bill_id, b.bill_number, b.status as bill_status,
         case when e.status = 'VOID' then 'VOID' when b.id is null then 'UNBILLED' else b.status end as billing_state
    from data_entries e
    join data_entry_versions v on v.id = e.current_version_id
    join devices d on d.id = v.device_id
    join device_types t on t.id = d.type_id
    join pocs p on p.id = v.poc_id
    join users cu on cu.id = e.created_by
    left join users vu on vu.id = e.voided_by
    left join bill_lines bl on bl.entry_id = e.id and bl.active_reservation
    left join bills b on b.id = bl.bill_id`;

export interface EntryFilter {
  dateFrom?: string; dateTo?: string; deviceId?: string; typeId?: string; pocId?: string; createdBy?: string;
  status?: string; billingState?: string; reference?: string; page?: number; pageSize?: number;
}

function entryWhere(f: EntryFilter) {
  const params = [
    f.dateFrom || null, f.dateTo || null, f.deviceId || null, f.typeId || null, f.pocId || null, f.createdBy || null,
    f.status || null, f.billingState || null, f.reference?.trim() || null,
  ];
  const where = `
   where ($1::date is null or v.activity_date >= $1) and ($2::date is null or v.activity_date <= $2)
     and ($3::uuid is null or v.device_id = $3) and ($4::uuid is null or d.type_id = $4)
     and ($5::uuid is null or v.poc_id = $5) and ($6::uuid is null or e.created_by = $6)
     and ($7::text is null or e.status = $7)
     and ($8::text is null or (case when e.status = 'VOID' then 'VOID' when b.id is null then 'UNBILLED' else b.status end) = $8)
     and ($9::text is null or v.reference ilike '%' || $9 || '%')`;
  return { params, where };
}

export async function listEntries(f: EntryFilter = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 100000);
  const page = Math.max(f.page ?? 1, 1);
  const { params, where } = entryWhere(f);
  const rows = await q(
    db,
    `${ENTRY_SELECT} ${where} order by v.activity_date desc, e.submitted_at desc, e.id limit ${pageSize} offset ${(page - 1) * pageSize}`,
    params,
  );
  // Totals cover the whole filtered set (valid entries only), per currency, so they reconcile with the lines.
  const totals = await q(
    db,
    `select v.currency, count(*)::int as entries, sum(v.hours) as hours, round(sum(v.payable_hours_raw), 4) as payable_hours,
            sum(v.line_amount) as amount
       from (${ENTRY_SELECT} ${where}) x join data_entry_versions v on v.id = x.version_id
      where x.status = 'VALID' group by v.currency order by v.currency`,
    params,
  );
  const count = await one<{ n: number }>(db, `select count(*)::int as n from (${ENTRY_SELECT} ${where}) x`, params);
  return { rows, totals, total: count?.n ?? 0, page, pageSize };
}

export async function getEntry(id: string) {
  const entry = await one(db, `${ENTRY_SELECT} where e.id = $1`, [id]);
  if (!entry) throw notFound("Entry");
  const versions = await q(
    db,
    `select v.*, d.code as device_code, p.name as poc_name, u.name as changed_by_name
       from data_entry_versions v join devices d on d.id = v.device_id join pocs p on p.id = v.poc_id
       join users u on u.id = v.changed_by where v.entry_id = $1 order by v.version_no desc`,
    [id],
  );
  return { entry, versions };
}

/** Validates a prospective entry and prices it with the terms in force on its activity date. */
async function evaluate(
  d: Db,
  input: { deviceId: string; activityDate: string; hours: string },
  opts: { excludeEntryId?: string; requireActiveDevice: boolean },
) {
  if (!input.deviceId) throw invalid("REQUIRED", "Select a device.", { field: "deviceId" });
  const device = await one(
    d,
    "select d.*, t.name as type_name from devices d join device_types t on t.id = d.type_id where d.id = $1",
    [input.deviceId],
  );
  if (!device) throw invalid("INVALID_DEVICE", "Device does not exist.", { field: "deviceId" });
  if (opts.requireActiveDevice && device.status !== "ACTIVE")
    throw invalid("DEVICE_NOT_ACTIVE", `Device ${device.code} is ${device.status.toLowerCase()}; new entries are not accepted for it.`);

  const activityDate = requireDate(input.activityDate, "Activity date");
  const today = todayIST();
  if (activityDate > today) throw invalid("FUTURE_DATE", "Activity date cannot be in the future (Asia/Kolkata).", { field: "activityDate" });
  if (activityDate < device.commissioned_on)
    throw invalid("BEFORE_COMMISSIONING", `Activity date is before the device was commissioned (${device.commissioned_on}).`, { field: "activityDate" });
  if (device.active_until_exclusive && activityDate >= device.active_until_exclusive)
    throw invalid("OUTSIDE_ACTIVE_PERIOD", `Device ${device.code} was not active on that date.`, { field: "activityDate" });

  const hours = parseHours(input.hours);
  if (dec(hours).gt(dec(maxHours())))
    throw invalid("HOURS_TOO_LARGE", `Hours cannot exceed ${maxHours()} per entry.`, { field: "hours" });

  const { assignment, rule } = await resolveTerms(d, device.id, activityDate);
  if (!assignment)
    throw invalid("NO_ASSIGNMENT", `Device ${device.code} has no POC assigned on ${activityDate}. Ask an admin to add an assignment covering that date.`);
  if (!rule)
    throw invalid("NO_PAYOUT_RULE", `Device ${device.code} has no payout rule on ${activityDate}. Ask an admin to add a rate and percentage covering that date.`);

  const calc = calculate(hours, rule.percentage, rule.rate);
  const settings = await getSettings();
  const warnings: EntryWarning[] = [];
  if (dec(hours).gt(dec(settings.hours_warning_threshold)))
    warnings.push({ code: "HOURS_ABOVE_THRESHOLD", message: `${hours} hours is above the ${settings.hours_warning_threshold}-hour warning threshold for one entry.` });
  const dup = await one(
    d,
    `select e.id, v.reference from data_entries e join data_entry_versions v on v.id = e.current_version_id
      where e.status = 'VALID' and v.device_id = $1 and v.activity_date = $2 and v.hours = $3 and ($4::uuid is null or e.id <> $4) limit 1`,
    [device.id, activityDate, hours, opts.excludeEntryId ?? null],
  );
  if (dup)
    warnings.push({ code: "POSSIBLE_DUPLICATE", message: `An entry with the same device, date and hours already exists (reference ${dup.reference}).` });
  if (dec(rule.rate).isZero() || dec(rule.percentage).isZero())
    warnings.push({ code: "ZERO_VALUE_TERMS", message: "The payout rule for this date has a zero rate or zero percentage, so this entry pays nothing." });

  return {
    device, activityDate, hours, assignment, rule, calc, warnings,
    terms: {
      deviceCode: device.code, deviceName: device.name, typeName: device.type_name,
      pocId: assignment.poc_id, pocName: assignment.poc_name,
      percentage: rule.percentage, rate: rule.rate, currency: rule.currency,
      payableHours: dec(calc.payableHoursRaw).toFixed(4), amount: calc.lineAmount,
    },
  };
}

function requireAcknowledged(warnings: EntryWarning[], acknowledged: string[] | undefined) {
  const missing = warnings.filter((w) => !(acknowledged ?? []).includes(w.code));
  if (missing.length)
    throw invalid("WARNING_CONFIRMATION_REQUIRED", "Review and confirm the warnings before submitting.", { warnings: missing });
}

function cleanReference(reference: unknown): string {
  const s = typeof reference === "string" ? reference.trim() : "";
  if (!s) throw invalid("REQUIRED", "A source/batch reference is required.", { field: "reference" });
  if (s.length > 200) throw invalid("TOO_LONG", "Reference is too long.", { field: "reference" });
  return s;
}
const cleanNotes = (n: unknown) => (typeof n === "string" && n.trim() ? n.trim().slice(0, 2000) : null);

/** FR-013: what the user sees before confirming. Nothing is saved. */
export async function previewEntry(input: EntryInput) {
  const e = await evaluate(db, input, { requireActiveDevice: true });
  return { terms: e.terms, warnings: e.warnings, hours: e.hours, activityDate: e.activityDate };
}

async function insertVersion(
  d: Db, entryId: string, versionNo: number, e: Awaited<ReturnType<typeof evaluate>>,
  reference: string, notes: string | null, actorId: string, reason: string | null,
) {
  return one(
    d,
    `insert into data_entry_versions
       (entry_id, version_no, device_id, reference, activity_date, hours, notes, assignment_id, poc_id, rule_id, rate,
        percentage, currency, payable_hours_raw, amount_raw, line_amount, calculation_version, changed_by, change_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,
    [entryId, versionNo, e.device.id, reference, e.activityDate, e.hours, notes, e.assignment.id, e.assignment.poc_id,
     e.rule.id, e.rule.rate, e.rule.percentage, e.rule.currency, e.calc.payableHoursRaw, e.calc.amountRaw,
     e.calc.lineAmount, CALCULATION_VERSION, actorId, reason],
  );
}

/** FR-014: one action, saved atomically with its snapshots; immutable to internal users afterwards. */
export async function submitEntry(actor: Actor, input: EntryInput) {
  const reference = cleanReference(input.reference);
  const notes = cleanNotes(input.notes);
  const id = await tx(async (d) => {
    const e = await evaluate(d, input, { requireActiveDevice: true });
    requireAcknowledged(e.warnings, input.acknowledgedWarnings);
    const entry = await one(
      d,
      "insert into data_entries (device_id, reference, normalized_reference, created_by) values ($1, $2, $3, $4) returning id",
      [e.device.id, reference, normalizeReference(reference), actor.id],
    );
    const version = await insertVersion(d, entry.id, 1, e, reference, notes, actor.id, null);
    await d.query("update data_entries set current_version_id = $2 where id = $1", [entry.id, version.id]);
    await audit(d, actor, "ENTRY_SUBMITTED", "entry", entry.id, { after: version });
    return entry.id as string;
  });
  return (await getEntry(id)).entry;
}

/**
 * Locks, in a fixed order (bill, then entry), the bill an entry is reserved on and the entry itself.
 * Entries on pending or approved bills are refused; entries on draft/rejected bills are released and
 * the bill is flagged NEEDS_REVIEW (FR-017, FR-018).
 */
async function lockEntryForChange(d: Db, actor: Actor, entryId: string, expectedVersion: number, cause: "ENTRY_CORRECTED" | "ENTRY_VOIDED", dryRun: boolean) {
  const reserved = await one(d, "select bill_id from bill_lines where entry_id = $1 and active_reservation", [entryId]);
  let bill: any = null;
  if (reserved) bill = await one(d, "select * from bills where id = $1 for update", [reserved.bill_id]);
  const entry = await one(d, "select * from data_entries where id = $1 for update", [entryId]);
  if (!entry) throw notFound("Entry");
  if (entry.version !== expectedVersion) throw staleVersion();
  if (entry.status === "VOID") throw conflict("ENTRY_VOID", "This entry has been voided and cannot be changed.");
  // Re-read the reservation now that the locks are held.
  const line = await one(d, "select id, bill_id from bill_lines where entry_id = $1 and active_reservation", [entryId]);
  if (line && (!bill || bill.id !== line.bill_id)) throw conflict("CONCURRENT_UPDATE", "Another change was in progress. Refresh and try again.");
  if (line) {
    if (bill.status === "PENDING_APPROVAL")
      throw conflict("ENTRY_LOCKED", `This entry is on bill ${bill.bill_number}, which is pending approval. Reject the bill before changing the entry.`);
    if (bill.status === "APPROVED")
      throw conflict("ENTRY_LOCKED", `This entry is on approved bill ${bill.bill_number}. Approved bills are corrected with an adjustment bill.`);
    if (!dryRun) {
      await d.query("update bill_lines set active_reservation = false, removed_at = now(), removed_reason = $2 where id = $1", [line.id, cause]);
      await d.query(
        `update bills set status = 'NEEDS_REVIEW', version = version + 1, updated_at = now(),
                total = coalesce((select sum(line_amount) from bill_lines where bill_id = $1 and bill_revision = bills.revision and removed_at is null), 0)
          where id = $1`,
        [bill.id],
      );
      await d.query(
        "insert into bill_decisions (bill_id, revision, decision, actor_id, reason) values ($1, $2, 'NEEDS_REVIEW', $3, $4)",
        [bill.id, bill.revision, actor.id, cause === "ENTRY_CORRECTED" ? "An entry on this bill was corrected." : "An entry on this bill was voided."],
      );
    }
  }
  return { entry, bill: line ? bill : null };
}

export interface CorrectionInput {
  expectedVersion: number;
  deviceId?: string; activityDate?: string; hours?: string; reference?: string; notes?: string | null;
  reason: string; acknowledgedWarnings?: string[]; dryRun?: boolean;
}

/** FR-017: admin-only correction. Keeps every prior version and writes a before/after audit event. */
export async function correctEntry(actor: Actor, entryId: string, input: CorrectionInput) {
  requireAdmin(actor);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw invalid("REASON_REQUIRED", "A reason is required for a correction.");
  const result = await tx(async (d) => {
    const { entry, bill } = await lockEntryForChange(d, actor, entryId, input.expectedVersion, "ENTRY_CORRECTED", !!input.dryRun);
    const before = await one(d, "select * from data_entry_versions where id = $1", [entry.current_version_id]);
    const deviceId = input.deviceId ?? before.device_id;
    const reference = cleanReference(input.reference ?? before.reference);
    const notes = input.notes !== undefined ? cleanNotes(input.notes) : before.notes;
    const e = await evaluate(
      d,
      { deviceId, activityDate: input.activityDate ?? before.activity_date, hours: input.hours ?? before.hours },
      { excludeEntryId: entryId, requireActiveDevice: deviceId !== before.device_id },
    );
    const preview = {
      before: { deviceId: before.device_id, activityDate: before.activity_date, hours: before.hours, reference: before.reference,
                pocId: before.poc_id, percentage: before.percentage, rate: before.rate, currency: before.currency, amount: before.line_amount },
      after: { deviceId: e.device.id, activityDate: e.activityDate, hours: e.hours, reference, ...e.terms },
      warnings: e.warnings,
      releasesFromBill: bill ? bill.bill_number : null,
    };
    if (input.dryRun) {
      const clash = await one(
        d, "select 1 from data_entries where device_id = $1 and normalized_reference = $2 and id <> $3",
        [e.device.id, normalizeReference(reference), entryId],
      );
      if (clash) throw conflict("DUPLICATE_REFERENCE", "This reference has already been used for this device.");
      return { preview, saved: false };
    }
    requireAcknowledged(e.warnings, input.acknowledgedWarnings);
    const version = await insertVersion(d, entryId, before.version_no + 1, e, reference, notes, actor.id, reason);
    await d.query(
      `update data_entries set device_id = $2, reference = $3, normalized_reference = $4, current_version_id = $5, version = version + 1
        where id = $1`,
      [entryId, e.device.id, reference, normalizeReference(reference), version.id],
    );
    await audit(d, actor, "ENTRY_CORRECTED", "entry", entryId, { reason, before, after: version });
    return { preview, saved: true };
  });
  return { ...result, entry: (await getEntry(entryId)).entry };
}

/** FR-018: void keeps the entry, its history and its reference; it just stops counting. */
export async function voidEntry(actor: Actor, entryId: string, input: { expectedVersion: number; reason: string }) {
  requireAdmin(actor);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw invalid("REASON_REQUIRED", "A reason is required to void an entry.");
  await tx(async (d) => {
    const { entry } = await lockEntryForChange(d, actor, entryId, input.expectedVersion, "ENTRY_VOIDED", false);
    await d.query(
      "update data_entries set status = 'VOID', void_reason = $2, voided_by = $3, voided_at = now(), version = version + 1 where id = $1",
      [entryId, reason, actor.id],
    );
    await audit(d, actor, "ENTRY_VOIDED", "entry", entryId, { reason, before: { status: entry.status }, after: { status: "VOID" } });
  });
  return (await getEntry(entryId)).entry;
}
