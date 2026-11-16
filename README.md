# Data Monitoring Internal Tool

Internal web app to record hours of data collected per device, calculate the payout owed to each point of contact (POC), and prepare bills for administrator approval, with a full history of every entry, correction, rate, approval and payment.

Built from `docs/SRS.md` (the specification this repository implements). Next.js 16 (App Router, TypeScript) and PostgreSQL.

## What it does

- **Devices, types and POCs** with effective-dated POC assignments and payout rules (rate, currency, percentage) per device.
- **Data entries**: one-step submission, priced with the POC and rule in force on the activity date and snapshotted. Internal users cannot edit or delete an entry. Admins correct or void with a reason; every version is kept.
- **Bills**: preview, draft, submit, approve or reject, regenerate, cancel. An entry can be on only one active bill. Approved bills are frozen.
- **Adjustments**: errors on an approved bill are corrected by a linked adjustment bill. Negative adjustments are credits, listed separately.
- **Payment ledger**: manual payment records and reversals against approved bills. The app never moves money.
- **Dashboard, five reports, CSV exports, bill PDF, audit log.**

## Run it locally

Requires Node 20+ and PostgreSQL 14+ (the `btree_gist` extension must be available; it is on Neon, RDS and stock Postgres).

```bash
npm install
cp .env.example .env            # set DATABASE_URL and APP_URL
npm run migrate                 # creates the schema, seeds 3 placeholder device types and default settings
npm run bootstrap-admin -- you@example.com "Your Name"   # prints a single-use link to set your password
npm run dev                     # http://localhost:3000
```

Optional, for a development or UAT database only:

```bash
npm run seed:demo               # fictional POCs, devices, entries and bills
```

Do not seed demo data into production. Entries, bills, payments and audit events can never be deleted, by design, so production must start from a freshly migrated, empty database.

### First-time setup in the app

1. Admin > Device types: rename the three placeholder types.
2. POCs: add each POC.
3. Devices: add devices one by one or by CSV import, then on each device add a POC assignment and a payout rule (rate, currency, percentage, start date). The percentage is prefilled with 70; the rate has no default.
4. Admin > Users: invite internal users. Each invite produces a single-use link valid for 72 hours. There is no email integration, so the admin passes the link on.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Development server, production build, production server |
| `npm run migrate` | Apply `migrations/*.sql` in order (idempotent) |
| `npm run bootstrap-admin` | Create the first admin and print an invite link. No password is generated or stored |
| `npm run seed:demo` | Fictional demo data (refuses to run with `NODE_ENV=production`) |
| `npm test` | Acceptance and integration tests against a real PostgreSQL database |
| `npm run typecheck` | TypeScript check |
| `scripts/backup-restore-check.sh` | Dump, restore into a scratch database and reconcile (AT-22) |

### Tests

Tests run against a real database so that the constraints, triggers and row locks are exercised, not mocked. Create an empty database and point `TEST_DATABASE_URL` at it (default `postgresql://dm:dm@localhost:5432/dm_test`). **The test run drops and recreates the `public` schema of that database.**

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/dm_test npm test
```

| SRS acceptance test | Where |
|---|---|
| AT-01 to AT-03 calculation and rounding | `tests/calc-entries.test.ts` |
| AT-04, AT-05 immutability and admin correction | `tests/calc-entries.test.ts` |
| AT-09 to AT-12, AT-23, AT-24 effective dates, overlaps, duplicates, validation | `tests/calc-entries.test.ts` |
| AT-06 to AT-08, AT-13 to AT-15 bill lifecycle, locks, concurrency | `tests/billing.test.ts` |
| AT-16, AT-17 payments and reversals | `tests/billing.test.ts` |
| AT-18, AT-19 adjustments, credits, concurrent adjustments | `tests/billing.test.ts` |
| AT-20, AT-21 reports, exports, inactive users | `tests/security-reports.test.ts` |
| AT-22 backup and restore | `scripts/backup-restore-check.sh` (run by hand against your host) |

## Deploying

Any Node host with a PostgreSQL database works. For Vercel with Neon:

1. Create a Neon project, copy the pooled connection string.
2. Set `DATABASE_URL`, `DATABASE_SSL=require` and `APP_URL` (the public URL) as environment variables on the host.
3. From your machine, with the same `DATABASE_URL`: `npm run migrate`, then `npm run bootstrap-admin -- you@example.com "Your Name"`.
4. Deploy. Health check: `GET /api/v1/health`.

Environment variables are listed in `.env.example`. No secret is committed to this repository.

## Architecture

A modular monolith. Business rules live in server-side services and in the database, never only in the browser.

```
migrations/001_init.sql   schema, constraints, triggers
src/server/               domain services (the only place rules are implemented)
  calc.ts                 decimal arithmetic, line-level rounding
  auth.ts                 sessions, invites, password reset, users
  masters.ts              device types, POCs, devices, dated assignments and rules, CSV import
  entries.ts              submit, preview, correct, void
  bills.ts                preview, draft, regenerate, submit, approve, reject, cancel, adjustments
  payments.ts             payment ledger and reversals
  reports.ts, exports.ts  dashboard, reports, audit queries, CSV and PDF
src/lib/http.ts           route wrapper: session and role check on every request, CSRF origin check,
                          idempotency keys, error envelope, request IDs
src/app/api/v1/           JSON API (SRS section 12)
src/app/(app)/            screens (server-rendered; forms call the API)
```

What the database itself enforces, independent of application code:

- No overlapping POC assignments or payout rules per device (GiST exclusion constraints).
- An entry on at most one active bill, and one in-progress adjustment per original line (partial unique indexes).
- Unique device code, serial, and `(device, reference)` case-insensitively.
- Entry versions, bill decisions, payments and audit events are append-only; bill line snapshots and approved bills are immutable; entries and bills cannot be deleted (triggers).
- Positive hours, 0 to 100 percentage, non-negative rates, positive payment amounts (check constraints).

## Deviations from the SRS recommendation

The SRS allows substitutions that do not change business rules. These were made:

| SRS suggestion | What was built | Why |
|---|---|---|
| Prisma or another ORM | `pg` with plain SQL and SQL migrations | The design depends on exclusion constraints, partial unique indexes, triggers and explicit row locks, which an ORM does not model. |
| A maintained auth provider | Built-in email and password: scrypt hashes, opaque session tokens stored hashed, HTTP-only SameSite cookies, single-use invite and reset links | No external dependency was specified. See limitations: there is no MFA. |
| PDF or CSV bill | Both, plus a print stylesheet | |

## Working assumptions applied

The SRS section 2.2 defaults are applied as written. In particular: the POC is the payee; hours are incremental per batch; terms are selected by activity date in Asia/Kolkata; one bill per POC, currency and date range; INR default; no tax, withholding or bank transfer; any admin may approve any bill. One addition: **Admin > Settings has a "require a different admin to approve" switch, off by default**, so separation of duties can be turned on without a code change.

The questions in SRS section 17 remain open for the product owner. None is answered by this code beyond those defaults.

## Limitations (not implemented, or not verified)

- **No MFA and no SSO.** The SRS asks for MFA for admins before production "where available". It is not available here. Put the app behind an SSO or identity-aware proxy, or add MFA, before production use.
- **No email.** Invite and reset links are shown once to the admin, who passes them on.
- **Rate limiting is per server instance** (in memory), plus a database-backed lockout after 5 failed sign-ins per email in 15 minutes. On multi-instance or serverless hosting, add a shared limiter at the edge.
- **Append-only is enforced by triggers**, which also bind the database owner in normal use, but an owner can drop a trigger. For stricter separation, run the app with a role that does not own the tables.
- **PDF text is Latin-1 only.** Names in other scripts print as `?` in the PDF; the on-screen bill and the CSV are unaffected.
- **Not load tested.** The 50 users, 10,000 devices, 1 million entries target has indexes to suit it but has not been measured. Report and bill list queries are not paginated in SQL for exports.
- **Backups, monitoring, alerting and retention are hosting concerns** and are not configured by this repository. `scripts/backup-restore-check.sh` verifies a restore; it was run against local PostgreSQL only.
- **Credits are tracked, not allocated.** Negative adjustments are listed as credits and must be reconciled outside the tool, as the SRS specifies for MVP.
- **Accessibility** follows the basics (labels, keyboard access, status text alongside colour) but has not had a formal audit.
- This tool produces payout statements. It does not produce tax invoices, calculate tax, or execute payments.
