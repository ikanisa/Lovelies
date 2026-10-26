# Encrypted database backups

The local operator tooling now produces, authenticates, inspects and expires
encrypted application-database backups. It does not change the serving API,
Supabase schema or Storage buckets. Hosted scheduling, off-site custody and a
fully operated independent recovery/replay workflow remain release gates.

## Boundary and format

`scripts/backup-database.mjs` runs PostgreSQL 17 `pg_dump` against only
`lovelies_private`, under the existing non-bypass `lovelies_api` role with row
security enabled. The custom archive includes the application schema and data;
it excludes Supabase managed schemas, global role credentials and Storage object
contents. A successful producer exit without warnings is required. The CLI then
uses `pg_restore --list` to inspect the recovered archive without executing SQL.

The producer selects the whole private schema, with no fixed table list or table
exclusions. Current schema v12 has 69 private tables, including `restore_control`.
Its empty state or populated database/incarnation/checkpoint/cursor and operation
receipt fields are opaque backup data: they must be reconstructed exactly, never
replaced with a new marker, cleared or treated as independent serving authority.
The archive/catalog format has no schema-version or table-count admission flag.

The source is streamed directly into AES-256-GCM encryption. The authenticated
header binds the project, environment, schema, format, archive ID, key ID and
seven-day deadline. Independent HKDF-derived keys protect encryption and the
HMAC catalog. Ciphertext and plaintext hashes, lengths and the full GCM tag are
verified before a recovery consumer receives plaintext. No plaintext dump file
is written by this tooling. Archives are bounded to 512 MiB.

Delivery verifies and reads the same private encrypted snapshot through one
retained descriptor. The temporary name is unlinked before copying, and the
descriptor closes on success or failure. Changing or replacing the original
catalog path after verification cannot replace the delivered bytes. This uses
streaming memory and temporarily requires up to one additional encrypted
archive's disk space. Copy/allocation/authentication errors prevent delivery;
it does not create a plaintext scratch file or release a serving restore.

A dedicated POSIX directory must belong to the operator and have mode 0700;
artifacts use 0600. Symlink ancestors, symlink/hardlink artifacts and broad modes
are refused. Production custody must additionally verify the actual filesystem,
ACLs, encryption/key custody and operator access. A filesystem mode alone does
not establish those operating controls.

Each authenticated archive expires exactly seven days from its start. Expiry
validates the entire recognized catalog first, then deletes verified expired
payloads before their catalog records. A retry can finish an interrupted
payload-first deletion. Unknown/orphan files are preserved and reported as
requiring reconciliation; their presence prevents the CLI reporting a complete
expiry result. Stale locks are retained for operator diagnosis. Failed production
jobs and unmanaged artifacts require an alert and bounded resolution.

## Invocation

Use the existing Node 24+ runtime and qualified absolute paths to PostgreSQL 17
`pg_dump` and `pg_restore`. Inject `LOVELIES_BACKUP_ENCRYPTION_KEY` as 32 independent
random bytes in canonical base64url, plus `PGUSER`, `PGPASSWORD` and the verified
`PGSSLROOTCERT`, through the operator's secret store. Keep the backup key separate
from application signing secrets and outside the backup catalog. Retain the
required key versions until their last managed archive expires.

Production configuration requires `PGHOST=db.ltqfplqevxztlswlzexn.supabase.co`,
`PGPORT=5432`, `PGDATABASE=postgres` and TLS `verify-full`. Inherited service,
host-address and SQL-option overrides are not forwarded. Passwords are absent
from process arguments and public diagnostics. The separate
`--local-qualification` option accepts only loopback and named disposable test
databases; those artifacts cannot be verified as production backups.

```sh
node scripts/backup-database.mjs create --directory /absolute/private/catalog \
  --pg-dump /absolute/bin/pg_dump --pg-restore /absolute/bin/pg_restore
node scripts/backup-database.mjs catalog --directory /absolute/private/catalog
node scripts/backup-database.mjs verify --directory /absolute/private/catalog --id BACKUP_UUID
node scripts/backup-database.mjs inspect --directory /absolute/private/catalog \
  --id BACKUP_UUID --pg-restore /absolute/bin/pg_restore
node scripts/backup-database.mjs expire --directory /absolute/private/catalog
```

There is no serving restore command. The verified-stream library is available
for isolated recovery qualification. Normal backup reconstruction omits owner
and privilege restoration; it does not authorize reconnecting the application.

## Observed qualification and remaining operation

The existing `pnpm backup:test` qualification passed 15 controlled cases covering interrupted producers,
corruption, wrong keys/catalog tampering, exact expiry and interrupted expiry,
unknown-file preservation, locks, permissions/links, consumer cancellation,
post-verification mutation/replacement, wrong-project/local target refusal and credential-safe CLI errors. The backend
readiness workflow includes that command and passed local actionlint 1.7.12.
GitHub billing remains parked; no passing remote run is inferred.

On 26 October, the encryption library, operator CLI and both controlled-test
files still match their recorded 25 October source seals. The schema change does
not alter that cryptographic/catalog implementation, so those unchanged cases
remain applicable. A fresh v12 reconstruction is a separate affected check.

The recorded 25 October PostgreSQL 17.6.1 fixture run used the production CLI and
flags through fixed wrappers for the existing owned container's binaries. It
encrypted and inspected the dump and reconstructed the then-current v11/68
private tables in a newly created isolated database, verifying every row hash,
the unknown test record and hold. Original source rows remained unchanged. All
68 reconstructed tables retained forced RLS and
zero client/public table grants; omitted backend ACLs left this particular
reconstruction unusable for serving. A separately copied encrypted artifact
passed the exact seven-day expiry boundary. Both disposable databases were removed;
the owned container was stopped and preserved. No hosted or customer data was used.

A real counterexample changed an 8 MiB encrypted fixture after initial verification:
altered plaintext reached the old consumer before GCM's final rejection. The
corrected snapshot delivers only the originally verified bytes under that same
mutation. A smaller first probe did not reproduce the race and remains recorded.
The original 13-case and PostgreSQL runs retain their source scope. All 15 cases
and all nine actual PostgreSQL checks were refreshed after the correction.

Current receipts:
`/Volumes/PRO-G40/Projects/Lovelies/verification/encrypted-backup-snapshot-fix-20261025/`
(`counterexample2.json`, `counterexample-fixed.json`,
`operator-current/{result,source-seal}.json`,
`actual-pg17/{result,source-seal,owned-container-cleanup}.json`). Earlier attempts,
failures and synthetic artifacts remain preserved. Keys and synthetic database
artifacts remain private and outside Git.

The prepared v12/69-table adaptation is
`/Volumes/PRO-G40/Projects/Lovelies/verification/encrypted-backup-schema12-20261026/`
(`actual-postgres.mjs`, `run-instructions.md`, `source-seal.json`). It reuses the
actual dump/encryption/reconstruction/RLS/expiry flow with native PostgreSQL 17
binaries selected by the integration owner. It additionally preserves a real
nonzero opaque `restore_control` checkpoint/operation receipt, then compares that
exact reconstructed marker against a later checkpoint established by an actual
source transaction. The journal/client/database gate uses production source with
an explicit controlled in-memory HTTP fixture for this qualification; it cannot
establish provider custody or independent persistence.

That adaptation is prepared for the integration owner's existing PostgreSQL 17.11
lane; it has not established a fresh actual v12 reconstruction pass yet. The old
68-table result must not be relabelled as current 69-table restore evidence.
Private server metadata and an existing synthetic qualification key are injected
only by the integration owner. The preparer did not read those credentials,
generate keys, access the running server or execute a backup/reconstruction.

Before release, configure and observe a monitored backup/expiry schedule with
independent off-site custody and recovery-key access. Inventory provider backups,
WAL/PITR and any media copies separately. Independently current deletion/withdrawal
replay, absent-object checks, retirement of restored sessions/consents/grants and
computed recovery completion must be operated and qualified before making any
restored copy accessible. The isolated reconstruction above does not qualify
that serving restore or prove the published erasure deadline.

The existing `services/push-provider` dispatch ledger is not that suppression
ledger. Its separate PostgreSQL connection has no qualified production custody
at this checkpoint, and its rows track push dispatch outcomes. Reusing another
schema in the application database would still share a provider-wide restore
boundary. The independent restriction-journal service and database fence now
exist in source. The production API requires the journal connection and compares
the local control row to independently current serving state under its reserved
database lock, including reads and internal jobs. Missing control never causes
request-time bootstrap; a supported-schema rollback with an old marker fails
closed. An exact committed SQL marker can reconcile a lost acknowledgement, but
a pending predecessor is never automatically replayed or assumed aborted.

The journal permits a serving bootstrap only at empty genesis; existing facts
bind in quarantine. Its recovery-begin generation cannot clear quarantine, and
there is no manual clear endpoint or flag. Provider custody, full restriction
replay, object cleanup/inventory and computed recovery completion remain open.
An encrypted archive's copied `restore_control` row, a valid GCM tag, a successful
SQL reconstruction or an omitted-ACL repair cannot certify current consent,
deletion completion or serving recovery. A planned restore must enter independent
recovery before replacing the database; never overwrite the independent journal
or use an archive's marker to reset it.

The separate [database request gate](schema-request-gate-20261025.md) prevents API
work against an older, newer or missing schema history. Schema v12 alone cannot
identify an old v12 backup. The independent checkpoint fence supplements that
schema check; it does not complete suppression replay, physical cleanup or
recovery-completion obligations. The focused database-gate tests cover old-marker
rollback denial separately from encrypted archive reconstruction.

Supabase documents separate plan-dependent backup availability and explains that
database backups do not contain Storage objects. Its Free plan guidance calls for
regular exports with off-site custody. This local implementation does not change
the project's plan. [Supabase database backups](https://supabase.com/docs/guides/platform/backups),
[PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).
