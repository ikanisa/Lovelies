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
exclusions. Hosted schema v13 and the locally qualified candidate each have 69
private tables, including `restore_control`.
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
node scripts/backup-database.mjs health --directory /absolute/private/catalog \
  --pg-restore /absolute/bin/pg_restore --max-age-hours 26
node scripts/backup-database.mjs verify --directory /absolute/private/catalog --id BACKUP_UUID
node scripts/backup-database.mjs inspect --directory /absolute/private/catalog \
  --id BACKUP_UUID --pg-restore /absolute/bin/pg_restore
node scripts/backup-database.mjs expire --directory /absolute/private/catalog
```

`health` acquires the catalog's cooperative lease, authenticates and decrypts
every managed archive, checks an explicit freshness bound and lists the newest
verified encrypted snapshot using the supplied PostgreSQL 17 `pg_restore`. It
rechecks the on-disk catalog after listing, then returns
`local_backup_artifact_verified` only if no archive is expired, future-dated,
stale, missing, corrupt or accompanied by unmanaged files. The example's 26-hour
bound is illustrative; operators must use their actual recovery-point target.
This check refuses a missing directory rather than creating one, never deletes
files, and returns exit 2 for a catalog needing attention and exit 1 for an
invalid or unverifiable check. A clock anomaly also fails closed.

To bound work, a health check accepts at most 4,096 directory entries, 256
archives and 8 GiB of authenticated archive bytes; it verifies the catalog
twice and reads the archives multiple times. A limit breach is a failure
requiring operator attention, not a healthy result. The current v1 implementation
uses one key per catalog: a mixed old/new
key catalog cannot be verified by this command and fails closed. Safe key
rotation and monitoring of every retained key generation remain operational
requirements. Use a trusted PostgreSQL binary and authenticated key source.
The result is a point-in-time observation of these local artifacts, not proof of
the original source database, required schema/data completeness, removal of an
entire catalog entry, scheduler operation, off-site custody, Storage object
backups, recovery clearance, physical expiry or a usable production restore.
The lease coordinates the provided tools; it does not prevent an uncooperative
process from modifying files after the check.

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

The v12/69-table qualification is
`/Volumes/PRO-G40/Projects/Lovelies/verification/encrypted-backup-schema12-20261026/`
(`actual-postgres.mjs`, `run-instructions.md`, `source-seal.json`). It reuses the
actual dump/encryption/reconstruction/RLS/expiry flow with native PostgreSQL 17
binaries selected by the integration owner. It additionally preserves a real
nonzero opaque `restore_control` checkpoint/operation receipt, then compares that
exact reconstructed marker against a later checkpoint established by an actual
source transaction. The journal/client/database gate uses production source with
an explicit controlled in-memory HTTP fixture for this qualification; it cannot
establish provider custody or independent persistence.

The first actual PostgreSQL 17.11 attempt completed five checks and its dump,
catalog verification and `pg_restore` commands exited successfully. All 69 table
row hashes matched after reconstruction. The next direct `restore_control`
assertion failed because postgres.js returns a `Result` array subclass while the
expected container was a plain array. That runner defect and the original
failure/cleanup evidence remain preserved. The second attempt normalizes only
that container with `Array.from`; exact row values/types/cardinality and all
other checks remain unchanged.

Root executed `attempt-02/` against the existing disposable native PostgreSQL
17.11 lane with the existing synthetic key: all 11 checks pass, all 52 source
inputs remain unchanged, and only newly created source/reconstruction databases
were cleaned up. All69 private tables/row hashes and the nonzero committed
restore-control row reconstruct exactly. Forced RLS and absence of client/public
grants survive; omitted backend ACLs keep the reconstruction unusable for
serving. Exact seven-day encrypted-payload/catalog expiry passes. A real later
source transaction advances its checkpoint; independent comparison then
quarantines the old reconstructed marker, and guarded reads fail without row
mutation. Receipt: `attempt-02/result.json`. This is a fresh69-table result;
the historical68-table result retains its original scope.

The production journal/database fence runs through a controlled in-memory HTTP
fixture here. This proves the local restore mismatch behavior, not independent
provider persistence, deployed custody, media replay/cleanup or serving recovery.
Private server metadata and the existing synthetic qualification key were
injected by root; no key was generated or hosted backup/provider action run.

After the sharing collector changed the database/operation input closure, root
repeated the affected reconstruction in `attempt-03/` with the same unmodified
runner and existing synthetic key. All11 checks pass again; all53 inputs,
including the new collector, remain unchanged. This is the current source-bound
schema12 backup result; attempts01/02 remain preserved. It does not close the
hosted custody, scheduler, media replay or serving-recovery gates above.

The subsequent invocation/deletion-allocation change is qualified by the same
unmodified runner in `attempt-04/`: all11 actualPG checks pass with53 unchanged
inputs. This supersedes attempt03 for the affected current database/operation
closure, retaining every earlier failure and receipt. Hosted custody, source/
media inventory and serving recovery remain unqualified.


The26October `attempt-05` refresh passes the same11 actual native PostgreSQL17.11
schema12/69-table encryption/reconstruction/expiry/quarantine checks against the
current deletion/consent/retention source. The qualified runner is unchanged
(`4f33a39577a5af1308bca023e99bc7672aebfec7825af6712cffb0e422a668b4`);
all53 sealed inputs remain unchanged and the existing synthetic key was reused.
Receipt: `/Volumes/PRO-G40/Projects/Lovelies/verification/encrypted-backup-schema12-20261026/attempt-05/result.json`.
This does not establish hosted/off-site custody, media replay or serving clearance.

The 27 October local schema-13 reconstruction passed 13 checks on PostgreSQL
17.11. It preserved all 69 table hashes and the exact text of NULL, known and
unknown ticket-authority values, retained the constrained private role and RLS,
and quarantined an older restored marker. The existing synthetic key was reused,
the source seal was unchanged, and the owned disposable databases were cleaned
up. The independent journal in this test was an in-memory fixture. Receipt:
`/Volumes/PRO-G40/Projects/Lovelies/verification/encrypted-backup-schema13-20261027/attempt-02/result.json`.
This repeat includes the later refresh-cancellation source change; attempt-01
remains preserved as the preceding source-bound result.
Hosted/off-site custody, Storage reconstruction, replay and serving clearance
remain open.
