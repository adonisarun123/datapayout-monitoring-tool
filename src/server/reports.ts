import { db, one, q } from "@/lib/db";
import { dec } from "./calc";
import { invalid } from "@/lib/errors";
import { isValidDate } from "@/lib/dates";
import { listEntries } from "./entries";
import { listBills } from "./bills";

export interface ReportFilter {
  dateFrom?: string; dateTo?: string; typeId?: string; deviceId?: string; pocId?: string; status?: string;
}

export interface Column { key: string; label: string; numeric?: boolean }
export interface Report {
  key: string; title: string; basis: string; columns: Column[]; rows: Record<string, unknown>[];
  totals?: Record<string, unknown>[]; filters: ReportFilter;
}

export const REPORTS: Record<string, string> = {
  "device-utilization": "Device utilization",
  "poc-statement": "POC statement",
  "entry-detail": "Data entry detail",
  "billing-history": "Billing history",
  "payment-ledger": "Payment ledger",
};

function clean(f: ReportFilter): ReportFilter {
  for (const k of ["dateFrom", "dateTo"] as const)
    if (f[k] && !isValidDate(f[k])) throw invalid("INVALID_DATE", "Dates must be YYYY-MM-DD.");
  const uuid = /^[0-9a-f-]{36}$/i;
  for (const k of ["typeId", "deviceId", "pocId"] as const)
    if (f[k] && !uuid.test(f[k]!)) throw invalid("INVALID_FILTER", "Filter value is invalid.");
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as ReportFilter;
}

const ENTRY_SCOPE = `
    from data_entries e
    join data_entry_versions v on v.id = e.current_version_id
    join devices d on d.id = v.device_id
    join device_types t on t.id = d.type_id
    join pocs p on p.id = v.poc_id
   where e.status = 'VALID'
     and ($1::date is null or v.activity_date >= $1) and ($2::date is null or v.activity_date <= $2)
     and ($3::uuid is null or d.type_id = $3) and ($4::uuid is null or v.device_id = $4) and ($5::uuid is null or v.poc_id = $5)`;
const entryParams = (f: ReportFilter) => [f.dateFrom || null, f.dateTo || null, f.typeId || null, f.deviceId || null, f.pocId || null];

const NET_PAID = "coalesce((select sum(case when kind = 'PAYMENT' then amount else -amount end) from payments where bill_id = b.id), 0)";
const IST_DATE = (col: string) => `(${col} at time zone 'Asia/Kolkata')::date`;

/** FR-029 / section 14. Every money figure is per currency; each block states its own date basis. */
export async function dashboard(raw: ReportFilter) {
  const f = clean(raw);
  const ep = entryParams(f);
  const dates = [f.dateFrom || null, f.dateTo || null, f.pocId || null];
  const [hours, unbilled, pending, approved, payments, outstanding, counts] = await Promise.all([
    q(db, `select v.currency, count(*)::int as entries, sum(v.hours) as hours, round(sum(v.payable_hours_raw), 4) as payable_hours,
                  sum(v.line_amount) as value ${ENTRY_SCOPE} group by v.currency order by v.currency`, ep),
    q(db, `select v.currency, count(*)::int as entries, sum(v.hours) as hours, sum(v.line_amount) as value ${ENTRY_SCOPE}
              and not exists (select 1 from bill_lines bl where bl.entry_id = e.id and bl.active_reservation)
            group by v.currency order by v.currency`, ep),
    q(db, `select b.currency, count(*)::int as bills, sum(b.total) as value from bills b
            where b.status = 'PENDING_APPROVAL' and ($1::uuid is null or b.poc_id = $1) group by b.currency order by b.currency`, [f.pocId || null]),
    q(db, `select b.currency,
                  count(*) filter (where b.total > 0)::int as bills,
                  coalesce(sum(b.total) filter (where b.total > 0), 0) as value,
                  count(*) filter (where b.total < 0)::int as credit_bills,
                  coalesce(sum(b.total) filter (where b.total < 0), 0) as credits
             from bills b
            where b.status = 'APPROVED' and ($1::date is null or ${IST_DATE("b.approved_at")} >= $1)
              and ($2::date is null or ${IST_DATE("b.approved_at")} <= $2) and ($3::uuid is null or b.poc_id = $3)
            group by b.currency order by b.currency`, dates),
    q(db, `select b.currency, sum(case when p.kind = 'PAYMENT' then p.amount else -p.amount end) as net,
                  coalesce(sum(p.amount) filter (where p.kind = 'PAYMENT'), 0) as paid,
                  coalesce(sum(p.amount) filter (where p.kind = 'REVERSAL'), 0) as reversed
             from payments p join bills b on b.id = p.bill_id
            where ($1::date is null or p.payment_date >= $1) and ($2::date is null or p.payment_date <= $2) and ($3::uuid is null or b.poc_id = $3)
            group by b.currency order by b.currency`, dates),
    q(db, `select b.currency, count(*) filter (where b.total - ${NET_PAID} > 0)::int as bills, sum(b.total - ${NET_PAID}) as value
             from bills b where b.status = 'APPROVED' and b.total > 0 and ($1::uuid is null or b.poc_id = $1)
            group by b.currency order by b.currency`, [f.pocId || null]),
    one(db, `select (select count(*)::int from devices where status = 'ACTIVE') as active_devices,
                    (select count(*)::int from devices) as devices,
                    (select count(*)::int from pocs where active) as pocs,
                    (select count(*)::int from bills where status in ('DRAFT', 'NEEDS_REVIEW', 'REJECTED')) as open_drafts`),
  ]);
  const totalHours = await one(db, `select coalesce(sum(v.hours), 0) as hours, count(*)::int as entries ${ENTRY_SCOPE}`, ep);
  return { filters: f, totalHours, hours, unbilled, pending, approved, payments, outstanding, counts };
}

export async function runReport(key: string, raw: ReportFilter): Promise<Report> {
  const f = clean(raw);
  const title = REPORTS[key];
  if (!title) throw invalid("UNKNOWN_REPORT", "Unknown report.");
  switch (key) {
    case "device-utilization": {
      const rows = await q(
        db,
        `select d.code as device_code, d.name as device_name, t.name as type_name, d.status, v.currency, count(*)::int as entries,
                sum(v.hours) as hours, round(sum(v.payable_hours_raw), 4) as payable_hours, sum(v.line_amount) as amount
           ${ENTRY_SCOPE} group by d.id, d.code, d.name, t.name, d.status, v.currency order by d.code, v.currency`,
        entryParams(f),
      );
      const totals = await q(
        db,
        `select v.currency, count(*)::int as entries, sum(v.hours) as hours, round(sum(v.payable_hours_raw), 4) as payable_hours, sum(v.line_amount) as amount
           ${ENTRY_SCOPE} group by v.currency order by v.currency`,
        entryParams(f),
      );
      return {
        key, title, filters: f, rows, totals,
        basis: "Valid entries by activity date (Asia/Kolkata). Amounts are the per-entry rounded values at submission; voided entries are excluded.",
        columns: [
          { key: "device_code", label: "Device" }, { key: "device_name", label: "Name" }, { key: "type_name", label: "Type" },
          { key: "status", label: "Status" }, { key: "currency", label: "Currency" }, { key: "entries", label: "Entries", numeric: true },
          { key: "hours", label: "Recorded hours", numeric: true }, { key: "payable_hours", label: "Payable hours", numeric: true },
          { key: "amount", label: "Amount", numeric: true },
        ],
      };
    }
    case "poc-statement": {
      const rows = await q(
        db,
        `with ent as (
           select v.poc_id, v.currency, count(*)::int as entries, sum(v.hours) as hours, sum(v.line_amount) as entry_value,
                  coalesce(sum(v.line_amount) filter (where not exists
                    (select 1 from bill_lines bl where bl.entry_id = e.id and bl.active_reservation)), 0) as unbilled
             ${ENTRY_SCOPE} group by v.poc_id, v.currency
         ), bil as (
           select b.poc_id, b.currency,
                  coalesce(sum(b.total) filter (where b.total > 0), 0) as approved,
                  coalesce(sum(b.total) filter (where b.total < 0), 0) as credits,
                  coalesce(sum(${NET_PAID}) filter (where b.total > 0), 0) as paid
             from bills b
            where b.status = 'APPROVED' and ($1::date is null or ${IST_DATE("b.approved_at")} >= $1)
              and ($2::date is null or ${IST_DATE("b.approved_at")} <= $2) and ($5::uuid is null or b.poc_id = $5)
            group by b.poc_id, b.currency
         )
         select p.name as poc_name, p.organization, coalesce(ent.currency, bil.currency) as currency,
                coalesce(ent.entries, 0) as entries, coalesce(ent.hours, 0) as hours, coalesce(ent.entry_value, 0) as entry_value,
                coalesce(ent.unbilled, 0) as unbilled, coalesce(bil.approved, 0) as approved, coalesce(bil.paid, 0) as paid,
                coalesce(bil.approved, 0) - coalesce(bil.paid, 0) as outstanding, coalesce(bil.credits, 0) as credits
           from ent full join bil on bil.poc_id = ent.poc_id and bil.currency = ent.currency
           join pocs p on p.id = coalesce(ent.poc_id, bil.poc_id)
          order by p.name, 3`,
        entryParams(f),
      );
      return {
        key, title, filters: f, rows,
        basis: "Hours, entry value and unbilled estimate: valid entries by activity date. Approved, paid, outstanding and credits: bills approved in the date range (approval date, Asia/Kolkata); paid is all payments to date on those bills. Device and type filters apply to the entry columns only. Credits are listed separately and are not netted against outstanding.",
        columns: [
          { key: "poc_name", label: "POC" }, { key: "organization", label: "Organization" }, { key: "currency", label: "Currency" },
          { key: "entries", label: "Entries", numeric: true }, { key: "hours", label: "Recorded hours", numeric: true },
          { key: "entry_value", label: "Entry value", numeric: true }, { key: "unbilled", label: "Unbilled (estimate)", numeric: true },
          { key: "approved", label: "Approved bills", numeric: true }, { key: "paid", label: "Paid", numeric: true },
          { key: "outstanding", label: "Outstanding", numeric: true }, { key: "credits", label: "Credits", numeric: true },
        ],
      };
    }
    case "entry-detail": {
      const r = await listEntries({ dateFrom: f.dateFrom, dateTo: f.dateTo, typeId: f.typeId, deviceId: f.deviceId, pocId: f.pocId, status: f.status, pageSize: 100000 });
      return {
        key, title, filters: f, totals: r.totals,
        rows: r.rows.map((e) => ({ ...e, payable_hours: dec(e.payable_hours_raw).toDecimalPlaces(4).toFixed(4) })),
        basis: "Entries by activity date (Asia/Kolkata), current version. Totals count valid entries only; voided entries are listed but not totalled.",
        columns: [
          { key: "activity_date", label: "Activity date" }, { key: "device_code", label: "Device" }, { key: "type_name", label: "Type" },
          { key: "poc_name", label: "POC" }, { key: "reference", label: "Reference" }, { key: "hours", label: "Hours", numeric: true },
          { key: "percentage", label: "Payout %", numeric: true }, { key: "rate", label: "Rate", numeric: true },
          { key: "payable_hours", label: "Payable hours", numeric: true }, { key: "currency", label: "Currency" },
          { key: "line_amount", label: "Amount", numeric: true }, { key: "status", label: "Status" },
          { key: "billing_state", label: "Billing state" }, { key: "bill_number", label: "Bill" }, { key: "created_by_name", label: "Entered by" },
        ],
      };
    }
    case "billing-history": {
      const r = await listBills({ pocId: f.pocId, status: f.status, approvedFrom: f.dateFrom, approvedTo: f.dateTo, pageSize: 100000 });
      return {
        key, title, filters: f, rows: r.rows,
        basis: "Bills of every status. A date range filters by approval date (Asia/Kolkata), so it shows approved bills only. Negative approved adjustments are credits.",
        columns: [
          { key: "bill_number", label: "Bill" }, { key: "type", label: "Type" }, { key: "poc_name", label: "POC" },
          { key: "date_from", label: "Period from" }, { key: "date_to_inclusive", label: "Period to" }, { key: "status", label: "Status" },
          { key: "currency", label: "Currency" }, { key: "total", label: "Total", numeric: true }, { key: "paid", label: "Paid", numeric: true },
          { key: "outstanding", label: "Outstanding", numeric: true }, { key: "payment_status", label: "Payment status" },
          { key: "approved_by_name", label: "Approved by" }, { key: "approved_at", label: "Approved at" },
        ],
      };
    }
    case "payment-ledger": {
      const params = [f.dateFrom || null, f.dateTo || null, f.pocId || null];
      const where = `where ($1::date is null or p.payment_date >= $1) and ($2::date is null or p.payment_date <= $2) and ($3::uuid is null or b.poc_id = $3)`;
      const rows = await q(
        db,
        `select p.payment_date, b.bill_number, pc.name as poc_name, p.kind, b.currency,
                case when p.kind = 'PAYMENT' then p.amount else -p.amount end as signed_amount,
                p.method, p.reference, p.reason, p.note, u.name as recorded_by_name, p.created_at
           from payments p join bills b on b.id = p.bill_id join pocs pc on pc.id = b.poc_id join users u on u.id = p.recorded_by
           ${where} order by p.payment_date, p.created_at, p.id`,
        params,
      );
      const totals = await q(
        db,
        `select b.currency, sum(case when p.kind = 'PAYMENT' then p.amount else -p.amount end) as signed_amount
           from payments p join bills b on b.id = p.bill_id ${where} group by b.currency order by b.currency`,
        params,
      );
      return {
        key, title, filters: f, rows, totals,
        basis: "Ledger records by payment date. Reversals are shown as negative amounts on the date they were recorded. This is ledger tracking only, not bank activity.",
        columns: [
          { key: "payment_date", label: "Payment date" }, { key: "bill_number", label: "Bill" }, { key: "poc_name", label: "POC" },
          { key: "kind", label: "Kind" }, { key: "currency", label: "Currency" }, { key: "signed_amount", label: "Amount", numeric: true },
          { key: "method", label: "Method" }, { key: "reference", label: "Reference" }, { key: "reason", label: "Reversal reason" },
          { key: "recorded_by_name", label: "Recorded by" },
        ],
      };
    }
  }
  throw invalid("UNKNOWN_REPORT", "Unknown report.");
}

export interface AuditFilter { entityType?: string; entityId?: string; actorId?: string; action?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number }

export async function listAudit(f: AuditFilter = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const params = [f.entityType || null, f.entityId || null, f.actorId || null, f.action || null, f.dateFrom || null, f.dateTo || null];
  const where = `
     where ($1::text is null or a.entity_type = $1) and ($2::text is null or a.entity_id = $2) and ($3::uuid is null or a.actor_id = $3)
       and ($4::text is null or a.action ilike '%' || $4 || '%')
       and ($5::date is null or ${IST_DATE("a.created_at")} >= $5) and ($6::date is null or ${IST_DATE("a.created_at")} <= $6)`;
  const rows = await q(
    db,
    `select a.*, u.name as actor_name from audit_events a left join users u on u.id = a.actor_id ${where}
      order by a.created_at desc, a.id limit ${pageSize} offset ${(page - 1) * pageSize}`,
    params,
  );
  const total = await one<{ n: number }>(db, `select count(*)::int as n from audit_events a ${where}`, params);
  return { rows, total: total?.n ?? 0, page, pageSize };
}
