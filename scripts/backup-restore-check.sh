#!/usr/bin/env bash
# AT-22: dump a database, restore it into a scratch database, and check that entries, bill snapshots,
# payments and audit records reconcile. Usage:
#   SOURCE_URL=postgresql://... SCRATCH_URL=postgresql://.../scratch_db scripts/backup-restore-check.sh
# SCRATCH_URL must point at an EMPTY database you are happy to overwrite (never production).
set -euo pipefail
: "${SOURCE_URL:?set SOURCE_URL}"; : "${SCRATCH_URL:?set SCRATCH_URL}"
DUMP="$(mktemp -t dm-backup-XXXXXX.dump)"
trap 'rm -f "$DUMP"' EXIT
FINGERPRINT="
select 'entries', count(*)::text, coalesce(md5(string_agg(id::text || status || version, ',' order by id)), '') from data_entries
union all select 'entry_versions', count(*)::text, coalesce(sum(line_amount)::text, '0') from data_entry_versions
union all select 'bills', count(*)::text, coalesce(sum(total)::text, '0') from bills
union all select 'bill_lines', count(*)::text, coalesce(sum(line_amount)::text, '0') from bill_lines
union all select 'payments', count(*)::text, coalesce(sum(amount)::text, '0') from payments
union all select 'audit_events', count(*)::text, coalesce(md5(string_agg(id::text, ',' order by id)), '') from audit_events
order by 1"
echo "Dumping source..."
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$SOURCE_URL"
echo "Restoring into scratch..."
psql -q "$SCRATCH_URL" -c "drop schema if exists public cascade; create schema public;"
pg_restore --no-owner --no-privileges --dbname="$SCRATCH_URL" "$DUMP"
A="$(psql -At "$SOURCE_URL" -c "$FINGERPRINT")"
B="$(psql -At "$SCRATCH_URL" -c "$FINGERPRINT")"
echo "$B"
if [ "$A" = "$B" ]; then echo "RESTORE OK: source and restored copy reconcile."; else echo "RESTORE MISMATCH"; diff <(echo "$A") <(echo "$B") || true; exit 1; fi
# The restored copy must still enforce immutability.
if psql -q "$SCRATCH_URL" -c "delete from audit_events" 2>/dev/null; then echo "FAIL: audit log was deletable after restore"; exit 1; fi
echo "Append-only triggers are present after restore."
