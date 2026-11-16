# Data Monitoring Internal Tool
## Software Requirements Specification and Engineering Build Guide

**Version:** 1.0  
**Date:** 16 November 2026  
**Status:** Implementation draft  
**Audience:** Product owner, developer, QA, and AI coding agent

## 1. Product overview

Build a secure internal web application to track hours of data collected for individual devices, calculate the amount payable to the relevant point of contact (POC), and prepare bills for administrator approval. The system must retain a reliable history of every entry, correction, rate, approval, and payment status.

The business currently has three device types, with any number of physical devices under each type. An administrator maintains devices and payout settings. Internal users enter data hours but cannot edit or delete a submitted entry. Only an administrator can correct an entry, with an audit trail. A bill is finalized only when an administrator approves it.

### Outcomes
- Know the data hours recorded for each device, type, POC and period.
- Calculate payable hours and payout automatically and consistently.
- Prevent duplicate billing and unauthorized changes.
- Review and approve bills, record payment progress and export a reliable statement.

## 2. Scope and working decisions

### 2.1 MVP scope
Authentication and user management; three configurable device types; device inventory; POC management; dated rate and payout-percentage configuration; manual hour entries; administrator-only corrections; bill generation, approval and rejection; manual payment tracking; dashboards, filters, exports, and audit logs.

### 2.2 Explicit working assumptions to confirm
These are proposed defaults, not facts supplied by the business. Keep them configurable where stated.

1. **POC and payee:** Each device has one POC at any given time. For billing, the POC is the payee by default. If a POC is only an operational contact and another entity is paid, add a separate payee before production.
2. **Data entry:** Users manually enter data duration in decimal hours for a device and an activity date. There is no device integration in MVP. An entry represents incremental hours, not a cumulative device counter.
3. **Dates:** A device's POC and applicable payout settings are selected using the entry's activity date, not its creation date. Business dates use Asia/Kolkata; timestamps are stored in UTC.
4. **Billing:** An admin creates a separate bill per POC, currency and date range. Entries can be included only once in an active bill. A bill can cover multiple devices and types for the same POC.
5. **Rate:** The business configures a non-negative monetary rate per payable hour. The default payable percentage is 70%, configurable per device with effective dates. No actual rate is assumed. Each bill uses the rate and percentage captured on each entry.
6. **Entry granularity:** Multiple entries per device and date are allowed, because separate batches may exist. A reference is mandatory and unique per device; a duplicate reference is rejected. This prevents a known duplicate but cannot detect every duplicate. A warning for same device/date/hours requires user review.
7. **Amounts:** INR is the default currency, configurable at initial setup. One currency per rate and bill; no currency conversion. Store amounts using decimals, never floating point. No GST, tax withholding, deductions or automatic bank transfer in MVP. The calculated figure is a payout before any taxes or other adjustments.
8. **Approver:** Any active admin can approve a bill, including one they prepared. If separation of duties is required, enable it as a later policy before launch.
9. **Payment:** Approval is not a payment. Admin records full or partial payments manually; the app does not execute them. Store payment reference and date, not bank credentials.
10. **Void and corrections:** Approved bills are immutable. Errors are corrected through an administrator-created adjustment bill linked to the original; paid amounts and previous approvals remain unchanged. See section 8.7.
11. **No automatic 24-hour cap:** Data duration may exceed 24 hours for a calendar day, such as aggregated data. Add a configurable warning threshold, initially 24 hours, without blocking submission.
12. **Device types:** Exactly three initial types must be named by the business during setup. Admin can rename and deactivate types; adding more types is supported without a schema change.

### 2.3 Out of scope for MVP
Automatic data ingestion, live telemetry, data-file storage, external POC login, payroll or accounting integration, tax calculation, invoicing compliance, bank transfers, multi-company tenancy, and mobile-native apps. These can be added after requirements and applicable accounting rules are confirmed.

## 3. Users and access

| Capability | Internal user | Admin |
|---|---|---|
| Sign in and view permitted dashboards, device, POC, rates and bills | Yes | Yes |
| Create and immediately submit a data entry | Yes | Yes |
| Edit, delete or void a submitted entry | No | Yes, subject to bill locks and audit |
| Manage users, POCs, device types, devices and dated assignments | No | Yes |
| Configure dated rate and payout percentage | No | Yes |
| Create, edit, submit, reject and approve bills | No | Yes |
| Record or correct payment records | No | Yes |
| View audit log | No | Yes |
| Export reports and bills | Yes, if report access enabled | Yes |

- Permissions are enforced on the server and database access path, not merely by hiding UI controls.
- All MVP internal users can see all operational records and bills. If commercial values are sensitive, introduce a separate permission before rollout.
- No public sign-up. An admin invites or creates accounts. Deactivation revokes access without deleting historical attribution. Keep at least one active admin.
- POCs are contact records, not user accounts. Admin may also be an entry creator and bill approver.

## 4. Core concepts

| Term | Meaning |
|---|---|
| Device type | Classification of a device; initially three types. |
| Device | Individually identifiable physical unit. Quantity is the count of device records, not one shared entry for an inventory batch. |
| POC | Person associated with a device for a date range and, by default, its payee. |
| Activity date | Business date to which recorded hours relate. |
| Data entry | A submitted, auditable record of incremental data hours for one device and date. |
| Payable hours | Entered hours multiplied by the applicable payout percentage. |
| Rate | Amount payable for one payable hour in a specified currency. |
| Bill | A statement for one POC and period containing eligible entries or approved-bill adjustments. |
| Payment | A manually recorded payment against an approved bill; it is not an actual transfer. |

## 5. Payout calculations

For each entry:

```
raw_payable_hours = recorded_hours × payout_percentage / 100
raw_amount = raw_payable_hours × hourly_rate
bill_line_amount = round_half_up(raw_amount, 2 decimal places)
bill_total = sum(bill_line_amount for all bill lines)
```

- Compute using decimal arithmetic with at least 6 fractional digits in intermediate results. Do not round the percentage or hours before multiplication. Show payable hours to 4 decimals for readability, with full-precision calculation underneath. Currency amounts use two decimals, rounded half up **per line**, then summed. Display currency and calculation details on the bill.
- Example: 100.0000 hours × 70% = 70 payable hours. If the rate is ₹100 per payable hour, payout = 70 × ₹100 = **₹7,000.00**. The ₹100 rate is an example only.
- Different devices or dates can have different rates and percentages, so never multiply aggregate hours by a single rate unless all lines share the same terms.
- Zero rate or percentage is permitted only with explicit admin confirmation and is visibly flagged. A missing applicable assignment, rate, currency, or percentage blocks submission. Negative data hours or negative rates are invalid; negative adjustment amounts are permitted only through the adjustment workflow.
- Entries snapshot the assignment, POC, rate, currency, percentage, source setting IDs and calculation version when submitted. Later changes to settings never silently reprice them. An admin must explicitly correct an eligible entry to apply different terms, with a reason and before/after audit.

## 6. Functional requirements

### 6.1 Identity and administration
- **FR-001:** A user signs in using an invited account. Use established authentication with secure password handling or an organization SSO provider. Password reset and invitation links must be single-use and time-limited.
- **FR-002:** Admin creates, activates or deactivates users and assigns `ADMIN` or `INTERNAL_USER`. Record who performed these actions. Do not display or store plaintext passwords.
- **FR-003:** Deny inactive accounts on every authenticated request. Admin access and changes are auditable. Sessions expire after 8 hours of inactivity and require reauthentication for bill approval; policy may be configured at deployment.

### 6.2 Device types, POCs and devices
- **FR-004:** Seed three placeholder types, named by admin at setup. A type has a unique name, optional description and active status. Do not delete a type with history; deactivate it.
- **FR-005:** Admin manages POCs with name, optional phone, email, organization, notes and active status. Limit contact details to what is necessary. Device assignment requires an active POC at assignment creation.
- **FR-006:** Each device has an immutable system ID, unique human-readable device code, type, display name, optional serial number, status (`ACTIVE`, `INACTIVE`, `RETIRED`), commissioning date and notes. Serial number, when provided, is unique. Retired devices retain all history.
- **FR-007:** Admin can add devices individually or through an admin-only CSV import with preview, per-row errors and all-or-nothing commit. A type's quantity is derived from device records and filterable by status.
- **FR-008:** Store dated POC assignments for each device. One assignment applies on any given date. Intervals are inclusive start, exclusive end; end may be open. Reject overlaps transactionally. Allow reassignment without rewriting historical entries.
- **FR-009:** Disallow new activity for a device on dates outside its active period; retain its historic entries. A future-dated assignment or rate may be scheduled.

### 6.3 Configuration and effective dates
- **FR-010:** Admin manages a dated payout rule per device: rate, currency, percentage, start and optional exclusive end date. Range 0–100% inclusive. Prevent overlapping rules for the same device. Prepopulate 70% but require a rate to be entered.
- **FR-011:** Changing a rule creates or closes effective-dated records; never overwrite past snapshots. Before saving a retroactive rule or assignment, show a warning that existing snapshots will not change, and record admin and reason. A correction of already-billed records follows bill lock rules.
- **FR-012:** Admin can choose default currency, 24-hour warning threshold and an organization name for exports. Configuration changes are audited. Changing currency never converts existing entries.

### 6.4 Data entry and correction
- **FR-013:** The entry form includes active device, activity date, positive decimal hours (up to 4 decimal places), mandatory source/batch reference, optional notes, submitter, and server-generated submission timestamp. Show applicable POC, percentage, rate, payable hours and estimated amount before confirmation.
- **FR-014:** The entry is submitted in one action; there are no server-saved drafts in MVP. After submission it is immutable to internal users, including through API, CSV, direct object access or retry. Show a confirmation before submission.
- **FR-015:** Enforce unique `(device_id, normalized_reference)` across all entries, including voids. Trim whitespace and compare case-insensitively. A retry with the same idempotency key returns the original result rather than creating a second entry. Warn on a possible duplicate device/date/hours but permit intentional entries with different references after confirmation.
- **FR-016:** Permit past activity dates from device commissioning onward; reject future activity dates. Validate positive hours and impose a sensible technical maximum of 100,000 per entry, configurable by deployment. Above threshold, show a warning, not an error.
- **FR-017:** Admin may correct an unbilled entry or an entry attached to a draft or rejected bill. Require a reason; record old/new values, actor and time. A correction must preserve the initial submitted entry version and create a new version. For entries on a draft or rejected bill, atomically release the entry from that bill and mark the bill `NEEDS_REVIEW`; it must be regenerated before submission. No edits while a bill is pending approval.
- **FR-018:** Admin can void an entry only when it is not attached to a pending or approved bill. Require a reason; retain its history and reference. For a draft/rejected bill, release the entry and mark bill `NEEDS_REVIEW`. Approved bill errors use adjustments (section 8.7). Voided entries do not contribute to reports of valid hours or bills, but appear in audit views.
- **FR-019:** List entries with device, type, date, POC snapshot, hours, payable hours, amount, creator and billing state. Filter by dates, device/type, POC, creator, status and reference. Provide paginated search and CSV export, respecting permissions.

### 6.5 Bills and approvals
- **FR-020:** Admin selects POC, currency and inclusive activity date range, previews unbilled, valid entries and creates a draft. Include each eligible entry in at most one non-cancelled bill. Store immutable snapshots of entry version, hours, calculation terms, POC and line amount on bill creation. Device and POC assignments can vary over time.
- **FR-021:** Draft shows bill number, period, POC, currency, line items, totals, device subtotals, creator, status and timestamps. Admin can exclude selected lines or regenerate from eligible entries while in draft. Preview separately flags entries that cannot be included due to missing eligibility, existing bill locks or mixed currency. Empty bills are not allowed.
- **FR-022:** Admin submits a valid draft for approval. Submission locks its lines and blocks entries from correction or void until rejection or cancellation. A submitted bill is `PENDING_APPROVAL`; no silent recalculation is allowed.
- **FR-023:** Only an admin can approve or reject a pending bill. Require a rejection reason; an approval comment is optional. Approve in a database transaction after verifying state, entry locks, versions and totals; write approver identity and time. Approval freezes all lines and financial values permanently.
- **FR-024:** A rejected bill retains its history and locked entry associations, but its entries may be corrected as specified in FR-017. Admin may regenerate and resubmit or cancel it. Regeneration atomically releases all old line reservations, selects current eligible entries, recalculates and marks draft, retaining a bill revision history. A `NEEDS_REVIEW` bill cannot be submitted until regenerated. A cancelled unapproved bill releases all entry reservations; cancelled lines remain historical and cannot be approved.
- **FR-025:** Provide printable bill and downloadable PDF or CSV, with bill status, statement number, period, POC, line detail, terms, totals and approver. Clearly label approved/unapproved and show outstanding balance. A statement is not represented as a statutory tax invoice.
- **FR-026:** Approved bills cannot be edited, cancelled or deleted. Adjustments are separate linked, approved documents; no original figures are overwritten.

### 6.6 Payments, reports and audit
- **FR-027:** Admin records a payment only for an approved positive-payable bill, with date, positive amount, method, reference and optional note. Payments cannot exceed the current outstanding amount; use transactional locking. Payment status derives as `UNPAID`, `PARTIALLY_PAID`, or `PAID`. A negative adjustment is tracked as a credit, not a payment.
- **FR-028:** A payment record is never silently modified/deleted. To fix it, admin records a reversal with reason and a new payment if needed. Reversal must not produce a negative paid balance. Record all changes with actor/time; this is only ledger tracking, not an actual bank reversal.
- **FR-029:** Dashboard shows total hours, payable hours, estimated value of valid unbilled hours, pending bills, approved bill value, payments and outstanding amount. Clearly state date basis: hours and unbilled value by activity date; bills by approval date; payments by payment date. Show credits separately; do not subtract them automatically. Filters include activity/approval/payment dates as applicable, device type, device and POC.
- **FR-030:** Reports include device utilization, POC statement, data entry detail, billing history and payment ledger. Totals should reconcile with underlying filtered lines; distinguish estimates from approved liabilities. CSV exports escape formula-leading cells to prevent spreadsheet formula injection.
- **FR-031:** Audit events record actor, action, entity, timestamp, reason, request correlation ID and before/after values where applicable, including sensitive configuration, entry, bill, payment and access changes. Audit records are append-only to application users. Do not put passwords or secrets in logs.

## 7. Business rules and validation

| ID | Rule |
|---|---|
| BR-01 | Device has exactly one effective POC assignment and one payout rule on the activity date; neither interval may overlap. |
| BR-02 | Record hours as `decimal(18,4)`, percentage as `decimal(7,4)`, rate as `decimal(18,4)`, money as `decimal(18,2)`; validate range and reject precision overflow. |
| BR-03 | An entry snapshots its POC and rule. Backdated setting changes do not affect it automatically. |
| BR-04 | A valid entry can belong to at most one active bill, enforced by a database constraint and transactional reservations. |
| BR-05 | Approval and payment are distinct events and permissions. A bill cannot be paid before approval. |
| BR-06 | Corrections and voids are admin-only and require a reason. They are not allowed on pending or approved bill entries. |
| BR-07 | Never physically delete data entries, approved bills, payments, audit events or referenced master records. Deactivate or void with reason. |
| BR-08 | Date ranges and rates are evaluated in Asia/Kolkata; stored instants use UTC. Bill date range is inclusive on the UI, translated to a half-open interval internally. |
| BR-09 | Bill line currency matches bill currency; no mixing or conversion. |
| BR-10 | Totals, statuses and permissions are calculated or checked server-side. Client calculations are previews only. |

## 8. Workflows

### 8.1 Initial setup
1. Admin signs in through the initial secure bootstrap process, renames the three device types, creates POCs and adds devices.
2. Assign each device an effective POC and a payout rule, entering rate, currency and percentage.
3. Admin creates internal users and checks their access. Never leave seeded or default credentials in production.

### 8.2 Entry submission
1. Internal user selects device and activity date; server looks up effective assignment and rule.
2. User enters hours, unique batch reference and notes. Screen previews terms and value and shows relevant warnings.
3. On confirmation, server revalidates eligibility, reserves the reference and saves the entry and snapshots atomically. Entry is immediately locked from user edits.
4. User can view the saved entry and contact an admin for correction.

### 8.3 Admin correction
1. Admin opens an entry, reviews its current version and billing status, enters new values and reason.
2. Server verifies role, optimistic version, reference uniqueness and bill state. Resolve new POC/rule using the corrected device/date, show before/after and require explicit confirmation.
3. For draft or rejected reservations, mark bill `NEEDS_REVIEW` and release the changed entry; then save a new entry version and audit event in one transaction. Pending/approved entries are blocked.

### 8.4 Bill lifecycle
`DRAFT → PENDING_APPROVAL → APPROVED` or `PENDING_APPROVAL → REJECTED → DRAFT → PENDING_APPROVAL`. `DRAFT` or `REJECTED` may become `NEEDS_REVIEW` upon entry correction/void; regeneration returns it to `DRAFT`. Draft, rejected and needs-review bills may be cancelled. Rejection and resubmission retain revisions and approval decisions.

1. Admin previews eligible entries by POC, currency and date range; creates draft with a unique generated bill number.
2. Admin reviews detail, excludes lines if needed, and submits. Server validates and locks the bill.
3. Admin approves or rejects with a reason. Approval is final and records an immutable snapshot. A rejected bill stays reserved until regenerated or cancelled.
4. Admin records payments separately; derived status changes with ledger entries.

### 8.5 Concurrent actions
- Every mutable record has a version. Update requests include the version; stale updates return `409 Conflict` with a refresh message.
- Bill creation and regeneration claim entries transactionally; parallel attempts cannot reserve the same entry. Approval uses a row lock and rechecks all line versions. Payments lock the bill and ledger before computing outstanding balance.
- Sensitive mutation endpoints support an idempotency key scoped to user and operation. Same key and same request returns the original response; same key with a different body returns conflict.

### 8.6 Corrections after submission and approval
- Pending: reject or cancel following allowed state transitions before correcting an entry. Pending bills cannot be cancelled directly; reject first.
- Approved: never edit original entry as it was billed. Create a linked adjustment bill based on the original bill line. Original bill, line and payment history stay unchanged.

### 8.7 Adjustment and credit handling
- Admin selects an approved bill and one or more original lines, enters the corrected target values and mandatory reason. The system displays original amount, corrected amount and signed delta. Each approved adjustment is a separate bill of type `ADJUSTMENT` linked to the original and uses the same currency and POC. All adjustments follow draft, review, approval and audit rules.
- Adjustment line delta = corrected cumulative target amount minus original amount and all prior **approved** adjustment deltas for that original line. Pending adjustments reserve the affected original line so concurrent adjustments cannot double count. Reject/cancel releases this reservation; regenerate rechecks the baseline. Validate and lock the baseline when approving.
- Positive adjustment creates a separately payable approved bill with its own payment ledger. Negative adjustment creates a credit balance; no negative payment is recorded. MVP lists credits and outstanding amounts separately for manual accounting; it does not automatically offset balances or record refunds. Zero-value adjustment is rejected. Admin must reconcile credits outside the tool until a credit allocation feature is built.
- This process changes financial liability only. The original operational entry and recorded original hours remain historical; reports must show original hours and adjustment amounts separately to avoid rewriting activity history.

## 9. Screens and UX

1. **Login / reset:** sign-in, reset, session-expired and access-denied states.
2. **Dashboard:** totals with date-basis labels; unbilled hours, approval queue, unpaid bills, payments and credits; filters and drilldowns.
3. **Devices:** list, type and status filters, device counts, add/edit, dated POC and rule history; individual device details.
4. **POCs:** contacts, devices currently assigned, historical assignments, statements and status.
5. **New data entry:** searchable device selector, date, hours, unique reference, notes, terms preview, duplicate/threshold warnings and submit confirmation.
6. **Entries:** searchable list, statuses, detail and version history; admin-only correction/void with reason.
7. **Bills:** preview, draft editor, approval queue, rejected/needs-review states, printable detail, adjustment and payment ledger.
8. **Reports:** device, POC, billing and payment reports with filters and export.
9. **Admin:** users, types, defaults and audit log. Settings show effective dates and warning for retroactive changes.

Responsive for desktop and tablet, usable on mobile. Display loading, empty, access-denied and error states. Use accessible labels, keyboard navigation, clear status text in addition to colour, and confirmation for irreversible approval. Financial values show currency and timezone explicitly.

## 10. Recommended architecture

A modular monolith is appropriate for this internal tool. Recommended stack: Next.js with TypeScript for UI and server APIs, PostgreSQL for transactional storage, Prisma or another mature ORM, a maintained authentication provider, and server-side PDF generation. Use a managed PostgreSQL service with backups and a secure application host. The stack is a recommendation and can be substituted without changing the business rules. Avoid placing authorization or calculation logic solely in the client.

**Logical modules:** auth/RBAC; device inventory; POC and effective-dated assignment; payout configuration; entries and versions; billing and adjustments; payment ledger; reports; audit; export. Centralize calculation and authorization in tested server-side domain services. Background processing is optional for large exports; no job queue is required for MVP.

## 11. Data model

All IDs are UUIDs. Use `created_at`, `created_by`, and where applicable `updated_at`, `updated_by`, `version`. Foreign keys are restrictive; retain historical references. Amount fields use the types in BR-02. Store dates without timezone and event instants as UTC timestamptz.

| Entity | Key fields and constraints |
|---|---|
| `users` | id, unique normalized email, name, role, active, auth provider ID, timestamps, version. |
| `device_types` | id, unique normalized name, description, active, timestamps. |
| `pocs` | id, name, phone, email, organization, notes, active, timestamps, version. |
| `devices` | id, unique code, unique nullable serial, type_id, name, status, commissioned_on, active_until_exclusive, notes, version. |
| `device_poc_assignments` | id, device_id, poc_id, valid_from, valid_to_exclusive nullable, created_by, reason. Non-overlapping range per device. |
| `payout_rules` | id, device_id, rate, currency ISO code, percentage, valid_from, valid_to_exclusive nullable, reason, created_by. Non-overlapping range per device. |
| `data_entries` | id, device_id, normalized_reference, current_version_id, created_by, submitted_at, status (`VALID`, `VOID`), version. Unique device + normalized_reference. |
| `data_entry_versions` | id, entry_id, version_no, activity_date, hours, notes, assignment_id, poc_id snapshot, rule_id, rate, percentage, currency, raw payable hours, rounded line amount, calculation_version, changed_by, change_reason, timestamp. Unique entry_id + version_no. Append-only. |
| `bills` | id, unique bill_number, type (`STANDARD`, `ADJUSTMENT`), original_bill_id nullable, poc_id, currency, date_from, date_to_inclusive, status, revision, total, created_by, submitted_at, approved_by, approved_at, version. |
| `bill_lines` | id, bill_id, bill_revision, entry_id / entry_version_id for standard, original_line_id for adjustment, device/POC/terms snapshots, signed line_amount, active_reservation flag. Historical lines retained for every revision. |
| `bill_decisions` | id, bill_id, revision, decision, actor_id, reason/comment, timestamp. Append-only. |
| `payments` | id, bill_id, kind (`PAYMENT`, `REVERSAL`), amount positive, payment_date, method, reference, reversal_of nullable, reason, recorded_by, timestamp. Ledger is append-only. |
| `audit_events` | id, actor_id, action, entity_type/id, timestamp, reason, before_json, after_json, request_id. Append-only. |
| `idempotency_requests` | actor_id, operation, key, request_hash, status, response reference, created_at; unique actor/operation/key. |
| `settings` | key, typed value, modified_by, modified_at, version. |

**Database enforcement:** PostgreSQL range exclusion constraints with `btree_gist` for assignment and rule non-overlap; check end > start, positive hours, percentage range and non-negative rates; partial unique index on `bill_lines(entry_id)` where active reservation is true; similar partial unique reservation for adjustment `original_line_id`; unique constraints on normalized code, references and bill number. Acquire row locks in consistent order. Bill revision snapshots are immutable; releasing reservation changes only reservation metadata, not historic financial snapshots. Audit tables and versions should deny update/delete to application roles.

## 12. API contract outline

Use authenticated `/api/v1` JSON endpoints. Each request is checked against the role matrix. Sensitive mutations accept `Idempotency-Key`; updates send version. Filtered list responses use pagination and stable sort. Derive actor from session, never request body. Currency amounts serialize as decimal strings.

| Method and path | Purpose | Access |
|---|---|---|
| GET/POST `/device-types` | List/create types | All / admin |
| GET/POST `/devices` | List/create devices | All / admin |
| GET/PATCH `/devices/:id` | Read/update device | All / admin |
| POST `/devices/import/preview`, `/devices/import/commit` | Validate/commit import | Admin |
| GET/POST `/pocs` | List/create POCs | All / admin |
| PATCH `/pocs/:id` | Edit/deactivate POC | Admin |
| GET/POST `/devices/:id/assignments` | View/create dated assignments | All / admin |
| GET/POST `/devices/:id/payout-rules` | View/create dated rules | All / admin |
| GET/POST `/entries` | List/submit entry | All |
| GET `/entries/:id` | Entry and version history | All |
| POST `/entries/:id/corrections` or `/void` | Audited correction/void | Admin |
| POST `/bills/preview` | Preview eligible lines and exclusions | Admin |
| GET/POST `/bills` | List/create draft | All / admin |
| GET `/bills/:id` | Details and revisions | All |
| POST `/bills/:id/regenerate`, `/submit`, `/approve`, `/reject`, `/cancel` | State transitions | Admin |
| POST `/bills/:id/adjustments` | Create linked adjustment | Admin |
| GET/POST `/bills/:id/payments` | View/record payment | All / admin |
| POST `/payments/:id/reversals` | Record payment reversal | Admin |
| GET `/reports/:report`, `/reports/:report/export` | Filtered report / CSV | All, subject to export permission |
| GET `/audit-events` | Filtered audit | Admin |
| GET/PATCH `/settings`, GET/POST/PATCH `/users` | Admin settings/users | Admin |

Consistent error envelope: `{ "error": { "code": "ENTRY_LOCKED", "message": "...", "details": {}, "requestId": "..." } }`. Use `400` malformed input, `401` unauthenticated, `403` forbidden, `404` inaccessible/missing record, `409` conflict/duplicate/state, `422` invalid business values, `429` rate limited, `500` unexpected error. Do not expose database traces.

Example entry request:

```json
{
  "deviceId": "<uuid>",
  "activityDate": "2026-11-15",
  "hours": "100.0000",
  "reference": "BATCH-2026-11-15-001",
  "notes": "Optional note"
}
```

Example response data: `{ "id": "<uuid>", "hours": "100.0000", "percentage": "70.0000", "payableHours": "70.0000", "rate": "100.0000", "currency": "INR", "amount": "7000.00", "status": "VALID", "version": 1 }`. Rates are example data, never hard-coded.

## 13. Security, operational and non-functional requirements

- HTTPS everywhere; secure, HTTP-only cookies, CSRF protections for cookie-authenticated writes, robust input validation, parameterized queries and standard security headers. Rate-limit login and sensitive endpoints. Use a well-maintained auth implementation and an MFA-capable provider; require MFA for admins before production where available.
- Enforce least-privilege database credentials, separate development/staging/production, environment-managed secrets and secret rotation. No real customer data in sample seeds or repository. Restrict access to exports and server logs.
- Back up the database daily with point-in-time recovery where supported; retain for at least 30 days as a proposed default. Test restore before go-live and quarterly afterward. Proposed targets: RPO 24 hours with daily backups, RTO 8 hours; confirm business needs and host capabilities.
- Provide structured logs, health check, error monitoring and alerts for failed backups, application errors and database capacity. Never log credentials. Define data retention and privacy policy with the business; do not set automatic deletion until approved.
- Initial design target: 50 internal users, 10,000 devices and 1 million entries, subject to load testing and hosting. Typical filtered list target under 2 seconds at p95 under agreed test load; bulk exports may run asynchronously. Add indexes on device/date, POC/date, entry state and bill status; profile actual queries.
- Preserve referential integrity; transactional writes for entry submissions, state transitions, reservations and payments. Store only contact information needed for operations.

## 14. Reporting definitions

| Measure | Definition |
|---|---|
| Recorded hours | Sum of current valid entry hours by activity date, excluding voided entries. Approved original entries remain included. |
| Payable hours | Sum of unrounded hours × snapshot percentage, displayed to 4 decimals. |
| Estimated unbilled value | Sum of per-entry rounded amounts for valid entries not reserved on an active standard bill. This is an estimate, not an approved liability. |
| Approved bill value | Sum of approved positive standard/adjustment bills by approval date; show approved negative adjustments as credits separately. |
| Paid | Payments less payment reversals by payment date. |
| Outstanding | Per approved positive bill, bill amount less net payments. Credits are shown separately and never silently netted. |
| Device count | Count of individual device records, with status filter. |

All totals must be currency-specific. A dashboard date filter labels each measure's date basis; do not present different date bases as a single reconciliation without explanation. Export includes filter values, generation timestamp, currency and user.

## 15. Acceptance tests

| ID | Scenario | Expected result |
|---|---|---|
| AT-01 | Record 100 hours, 70%, ₹100/hour | 70 payable hours, ₹7,000.00 line amount. |
| AT-02 | Enter 10.1234 hours, 70%, ₹100.25 | Raw amount 710.409595; line amount ₹710.41. |
| AT-03 | Multiple lines with fractional amounts | Each line rounded half up to 2 decimals; total equals sum of rounded lines. |
| AT-04 | Internal user attempts entry update/void via UI and API | Both rejected; entry remains unchanged. |
| AT-05 | Admin corrects unbilled entry with reason | New immutable version and audit event record before/after. |
| AT-06 | Correct an entry on a draft bill | Entry released; draft becomes NEEDS_REVIEW; submission blocked until regenerated. |
| AT-07 | Attempt to correct pending or approved bill entry | Rejected; pending bill must first be rejected; approved requires adjustment. |
| AT-08 | Two bills concurrently try to reserve same entry | Exactly one succeeds; other returns conflict without partial changes. |
| AT-09 | Rate changes for future date or retroactively | New entry uses effective terms; existing snapshot and approved bills unchanged. |
| AT-10 | Reassign device POC during period | Each entry and bill uses assignment in force on its activity date. |
| AT-11 | Overlapping assignment/rule dates | Save rejected, including concurrent requests; boundary end date can equal next start date. |
| AT-12 | Same device/reference entered with different case | Duplicate rejected even if old record was voided. Same idempotency-key retry returns original response. |
| AT-13 | Submit bill, then internal user attempts approval | Server returns 403; state remains pending. |
| AT-14 | Reject pending bill and regenerate | Reason retained, revision recorded, old reservations released and current eligible lines claimed atomically. |
| AT-15 | Approve bill and alter historical rate | Approved values remain unchanged; financial correction requires approved linked adjustment. |
| AT-16 | Partial payment then payment to settle balance | Status changes UNPAID → PARTIALLY_PAID → PAID; overpayment rejected under concurrency. |
| AT-17 | Reverse payment | Ledger retains both records; balance/status recalculated without negative paid balance. |
| AT-18 | Negative adjustment approved | Credit displayed separately; no negative payment or automatic offset. |
| AT-19 | Concurrent adjustments to original line | One reserves the line; second cannot approve against stale baseline. |
| AT-20 | Filter/export reports | Totals reconcile to selected underlying records; mixed currencies are separated and CSV formula cells escaped. |
| AT-21 | Inactive user calls any protected endpoint | Access denied even with a previously issued session. |
| AT-22 | Back up and restore to staging | Documented restore completes and entries, bill snapshots and audit records reconcile. |
| AT-23 | No applicable POC/rule, future date or invalid hours | Entry blocked with actionable message; no partial entry created. |
| AT-24 | Two settings intervals meet at a boundary | Correct rule and POC are selected for the activity date in Asia/Kolkata. |

## 16. Build plan and definition of done

### Phase 1 — Foundation
Set up repository, environments, PostgreSQL migrations, auth/RBAC, initial admin provisioning, audit infrastructure, device types, POCs, devices and dated assignments/rules. Verify access controls and interval constraints.

### Phase 2 — Entries and calculations
Build entry form, server validation and shared decimal calculation engine, snapshot storage, admin correction/void, duplicate protection and entry list. Test calculation, immutability, retroactive changes and concurrency.

### Phase 3 — Billing and payment ledger
Implement reservation, preview, draft, regeneration, decision history, approval, payment tracking, reversals and linked adjustment/credit handling. Exercise transactions, stale versions, approval locks and double-billing prevention.

### Phase 4 — Reports and operations
Build dashboards, filtered exports and printable bill, audit viewer, logging/monitoring, backups, restore test, accessibility and responsive UX. Prepare deployment instructions and user guide.

### Phase 5 — UAT and launch
Seed representative fictional scenarios for all three types and multiple POCs. Admin and internal users complete acceptance tests. Confirm POC/payee, rates, rounding, dates, approval authority, credit accounting, tax and retention policies. Migrate verified actual masters, remove demo data, check backups and MFA, and release after business sign-off.

**Done means:** acceptance tests pass; server-side authorization and DB constraints are tested; no hard-coded rates or credentials; business rules reconcile; backups can be restored; critical vulnerabilities addressed; documentation, setup, migrations and an admin handover are complete.

## 17. Questions for the product owner before production

1. What are the names of the three device types, and does each physical unit have a unique identifier?
2. Is the POC the actual payee? If not, should one payee be associated with several POCs or devices?
3. Are hours entered as individual batches, daily totals or cumulative readings? What is the source reference and can the same data be captured twice under different references?
4. Is 70% always the rule, or can it vary by device, POC, type, date or contract? What are the actual rates and currency?
5. Is a rate determined by activity date or by billing date? Should corrections ever reprice historical entries?
6. What is the billing cycle? Can POCs have multiple contracts or multiple bills for overlapping periods?
7. Must an approver be different from the person who created the bill or entered data? Who is allowed to view financial data?
8. Are taxes, withholding, deductions, bank details, formal tax invoices, credit offsets or refunds needed? If yes, specify before production and obtain accounting guidance.
9. Should administrators be able to approve their own entries, and who reconciles negative credits externally?
10. What retention, access, backup and recovery commitments apply? Are device files or evidence needed in future?

## 18. Copy-paste prompt for an AI coding agent

> Build the **Data Monitoring Internal Tool** using this SRS as the source of truth. Start by summarizing unresolved product decisions and apply the stated MVP assumptions without inventing rates or device names. Implement a modular Next.js/TypeScript application with PostgreSQL and server-side authorization, or explain any proposed substitution. Deliver migrations, an `.env.example` with no secrets, safe demo seeds, README, setup commands, admin bootstrap, and automated tests for the acceptance cases. Use decimal arithmetic and line-level rounding, effective-dated POC/rate snapshots, immutable submitted entries for internal users, admin-only audited corrections, transactional bill reservation and approvals, payment ledger and linked adjustments. Apply database constraints and idempotency. Build usable responsive screens, dashboards and exports, then run the tests and document any limitations. Do not claim integrations, payments, tax compliance or production readiness that have not been implemented and verified.
