-- Data Monitoring Internal Tool: initial schema (SRS section 11).
-- Dates are stored without timezone (business dates in Asia/Kolkata); instants are timestamptz (UTC).

create extension if not exists btree_gist;

-- ---------------------------------------------------------------- helpers

create or replace function dm_deny_change() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: records are append-only', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------- identity

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_normalized text not null unique,
  name text not null,
  role text not null check (role in ('ADMIN', 'INTERNAL_USER')),
  active boolean not null default true,
  can_export boolean not null default true,
  password_hash text,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id) on delete restrict,
  version integer not null default 1
);

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete restrict,
  kind text not null check (kind in ('INVITE', 'RESET')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete restrict,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  authenticated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);

create table login_attempts (
  id bigserial primary key,
  email_normalized text not null,
  ip text,
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
create index login_attempts_lookup_idx on login_attempts (email_normalized, attempted_at);
create index login_attempts_ip_idx on login_attempts (ip, attempted_at);

-- ---------------------------------------------------------------- masters

create table device_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_normalized text not null unique,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id) on delete restrict,
  version integer not null default 1
);

create table pocs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  organization text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id) on delete restrict,
  version integer not null default 1
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  code_normalized text not null unique,
  serial text,
  serial_normalized text unique,
  type_id uuid not null references device_types (id) on delete restrict,
  name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE', 'RETIRED')),
  commissioned_on date not null,
  active_until_exclusive date,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id) on delete restrict,
  version integer not null default 1,
  check (active_until_exclusive is null or active_until_exclusive > commissioned_on)
);
create index devices_type_idx on devices (type_id, status);

create table device_poc_assignments (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete restrict,
  poc_id uuid not null references pocs (id) on delete restrict,
  valid_from date not null,
  valid_to_exclusive date,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  check (valid_to_exclusive is null or valid_to_exclusive > valid_from),
  constraint device_poc_assignments_no_overlap
    exclude using gist (device_id with =, daterange(valid_from, valid_to_exclusive, '[)') with &&)
);
create index device_poc_assignments_poc_idx on device_poc_assignments (poc_id, valid_from);

create table payout_rules (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete restrict,
  rate numeric(18, 4) not null check (rate >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  percentage numeric(7, 4) not null check (percentage >= 0 and percentage <= 100),
  valid_from date not null,
  valid_to_exclusive date,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  check (valid_to_exclusive is null or valid_to_exclusive > valid_from),
  constraint payout_rules_no_overlap
    exclude using gist (device_id with =, daterange(valid_from, valid_to_exclusive, '[)') with &&)
);

-- ---------------------------------------------------------------- entries

create table data_entries (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete restrict,
  reference text not null,
  normalized_reference text not null,
  current_version_id uuid,
  status text not null default 'VALID' check (status in ('VALID', 'VOID')),
  void_reason text,
  voided_by uuid references users (id) on delete restrict,
  voided_at timestamptz,
  created_by uuid not null references users (id) on delete restrict,
  submitted_at timestamptz not null default now(),
  version integer not null default 1,
  constraint data_entries_device_reference_key unique (device_id, normalized_reference)
);
create index data_entries_status_idx on data_entries (status);
create index data_entries_creator_idx on data_entries (created_by);

create table data_entry_versions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references data_entries (id) on delete restrict,
  version_no integer not null,
  device_id uuid not null references devices (id) on delete restrict,
  reference text not null,
  activity_date date not null,
  hours numeric(18, 4) not null check (hours > 0),
  notes text,
  assignment_id uuid not null references device_poc_assignments (id) on delete restrict,
  poc_id uuid not null references pocs (id) on delete restrict,
  rule_id uuid not null references payout_rules (id) on delete restrict,
  rate numeric(18, 4) not null check (rate >= 0),
  percentage numeric(7, 4) not null check (percentage >= 0 and percentage <= 100),
  currency char(3) not null,
  payable_hours_raw numeric(30, 10) not null,
  amount_raw numeric(38, 14) not null,
  line_amount numeric(18, 2) not null,
  calculation_version integer not null,
  changed_by uuid not null references users (id) on delete restrict,
  change_reason text,
  created_at timestamptz not null default now(),
  constraint data_entry_versions_entry_version_key unique (entry_id, version_no)
);
create index data_entry_versions_device_date_idx on data_entry_versions (device_id, activity_date);
create index data_entry_versions_poc_date_idx on data_entry_versions (poc_id, activity_date);

alter table data_entries
  add constraint data_entries_current_version_fk
  foreign key (current_version_id) references data_entry_versions (id) on delete restrict
  deferrable initially deferred;

create trigger data_entry_versions_append_only
  before update or delete on data_entry_versions
  for each row execute function dm_deny_change();

create or replace function dm_data_entries_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'data entries are never deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'VOID' then
    raise exception 'a voided entry cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger data_entries_guard
  before update or delete on data_entries
  for each row execute function dm_data_entries_guard();

-- ---------------------------------------------------------------- bills

create sequence bill_number_seq;

create table bills (
  id uuid primary key default gen_random_uuid(),
  bill_number text not null unique,
  type text not null check (type in ('STANDARD', 'ADJUSTMENT')),
  original_bill_id uuid references bills (id) on delete restrict,
  poc_id uuid not null references pocs (id) on delete restrict,
  currency char(3) not null,
  date_from date not null,
  date_to_inclusive date not null,
  status text not null check (status in
    ('DRAFT', 'NEEDS_REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED')),
  revision integer not null default 1,
  total numeric(18, 2) not null default 0,
  adjustment_reason text,
  created_by uuid not null references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  submitted_by uuid references users (id) on delete restrict,
  submitted_at timestamptz,
  approved_by uuid references users (id) on delete restrict,
  approved_at timestamptz,
  approval_comment text,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (date_to_inclusive >= date_from),
  check ((type = 'ADJUSTMENT') = (original_bill_id is not null))
);
create index bills_status_idx on bills (status);
create index bills_poc_idx on bills (poc_id, status);
create index bills_original_idx on bills (original_bill_id);

create or replace function dm_bills_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'bills are never deleted' using errcode = 'P0001';
  end if;
  if old.status = 'APPROVED' then
    raise exception 'an approved bill is immutable' using errcode = 'P0001';
  end if;
  if old.status = 'CANCELLED' then
    raise exception 'a cancelled bill cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger bills_guard
  before update or delete on bills
  for each row execute function dm_bills_guard();

create table bill_lines (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete restrict,
  bill_revision integer not null,
  -- standard lines
  entry_id uuid references data_entries (id) on delete restrict,
  entry_version_id uuid references data_entry_versions (id) on delete restrict,
  -- adjustment lines
  original_line_id uuid references bill_lines (id) on delete restrict,
  original_amount numeric(18, 2),
  prior_adjustments numeric(18, 2),
  corrected_amount numeric(18, 2),
  corrected_hours numeric(18, 4),
  -- snapshots
  device_id uuid not null references devices (id) on delete restrict,
  device_code text not null,
  poc_id uuid not null references pocs (id) on delete restrict,
  reference text not null,
  activity_date date not null,
  hours numeric(18, 4) not null,
  percentage numeric(7, 4) not null,
  rate numeric(18, 4) not null,
  currency char(3) not null,
  payable_hours_raw numeric(30, 10) not null,
  line_amount numeric(18, 2) not null,
  -- reservation metadata (the only mutable part of a line)
  active_reservation boolean not null default true,
  removed_at timestamptz,
  removed_reason text check (removed_reason in ('EXCLUDED', 'ENTRY_CORRECTED', 'ENTRY_VOIDED')),
  created_at timestamptz not null default now(),
  check ((entry_id is not null and entry_version_id is not null and original_line_id is null)
      or (entry_id is null and entry_version_id is null and original_line_id is not null))
);
create index bill_lines_bill_idx on bill_lines (bill_id, bill_revision);
create index bill_lines_original_idx on bill_lines (original_line_id);

-- BR-04: an entry can sit on at most one active bill; same for an original line under adjustment.
create unique index bill_lines_entry_reservation_key
  on bill_lines (entry_id) where active_reservation and entry_id is not null;
create unique index bill_lines_original_line_reservation_key
  on bill_lines (original_line_id) where active_reservation and original_line_id is not null;

create or replace function dm_bill_lines_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'bill lines are never deleted' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'active_reservation' - 'removed_at' - 'removed_reason')
     is distinct from
     (to_jsonb(old) - 'active_reservation' - 'removed_at' - 'removed_reason') then
    raise exception 'bill line snapshots are immutable' using errcode = 'P0001';
  end if;
  if new.active_reservation and not old.active_reservation then
    raise exception 'a released reservation cannot be re-activated' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger bill_lines_guard
  before update or delete on bill_lines
  for each row execute function dm_bill_lines_guard();

create table bill_decisions (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete restrict,
  revision integer not null,
  decision text not null check (decision in
    ('CREATED', 'LINES_EXCLUDED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REGENERATED', 'NEEDS_REVIEW')),
  actor_id uuid not null references users (id) on delete restrict,
  reason text,
  created_at timestamptz not null default now()
);
create index bill_decisions_bill_idx on bill_decisions (bill_id, created_at);

create trigger bill_decisions_append_only
  before update or delete on bill_decisions
  for each row execute function dm_deny_change();

-- ---------------------------------------------------------------- payments

create table payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete restrict,
  kind text not null check (kind in ('PAYMENT', 'REVERSAL')),
  amount numeric(18, 2) not null check (amount > 0),
  payment_date date not null,
  method text not null,
  reference text not null,
  note text,
  reversal_of uuid unique references payments (id) on delete restrict,
  reason text,
  recorded_by uuid not null references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((kind = 'REVERSAL') = (reversal_of is not null)),
  check (kind = 'PAYMENT' or reason is not null)
);
create index payments_bill_idx on payments (bill_id);
create index payments_date_idx on payments (payment_date);

create trigger payments_append_only
  before update or delete on payments
  for each row execute function dm_deny_change();

-- ---------------------------------------------------------------- audit, idempotency, settings

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references users (id) on delete restrict,
  action text not null,
  entity_type text not null,
  entity_id text,
  reason text,
  before_json jsonb,
  after_json jsonb,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_events_entity_idx on audit_events (entity_type, entity_id, created_at);
create index audit_events_created_idx on audit_events (created_at);
create index audit_events_actor_idx on audit_events (actor_id, created_at);

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function dm_deny_change();

create table idempotency_requests (
  actor_id uuid not null references users (id) on delete restrict,
  operation text not null,
  key text not null,
  request_hash text not null,
  status text not null check (status in ('IN_PROGRESS', 'COMPLETED')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation, key)
);

create table settings (
  key text primary key,
  value jsonb not null,
  modified_by uuid references users (id) on delete restrict,
  modified_at timestamptz not null default now(),
  version integer not null default 1
);

insert into settings (key, value) values
  ('default_currency', '"INR"'),
  ('hours_warning_threshold', '"24"'),
  ('organization_name', '"Data Monitoring"'),
  ('default_payout_percentage', '"70"'),
  ('require_separate_approver', 'false');

-- FR-004: three placeholder types, renamed by an admin at setup.
insert into device_types (name, name_normalized, description) values
  ('Device Type 1', 'device type 1', 'Placeholder. Rename during setup.'),
  ('Device Type 2', 'device type 2', 'Placeholder. Rename during setup.'),
  ('Device Type 3', 'device type 3', 'Placeholder. Rename during setup.');
