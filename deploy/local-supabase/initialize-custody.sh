#!/bin/sh
set -eu
# Only the dedicated custody image invokes this on a new, empty data directory.
# Generated passwords are hexadecimal; never interpolate unrestricted SQL input.
case "$CUSTODY_JOURNAL_PASSWORD:$CUSTODY_PUSH_PASSWORD" in *[!0-9a-f:]*) exit 1;; esac
[ "${#CUSTODY_JOURNAL_PASSWORD}" -ge 64 ] && [ "${#CUSTODY_PUSH_PASSWORD}" -ge 64 ]
psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres -f /etc/lovelies/custody-schema.sql
psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<SQL
ALTER ROLE lovelies_journal LOGIN PASSWORD '$CUSTODY_JOURNAL_PASSWORD';
ALTER ROLE lovelies_push LOGIN PASSWORD '$CUSTODY_PUSH_PASSWORD';
SQL
