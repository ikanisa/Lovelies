# Backup subprocess custody

`scripts/backup-database.mjs` uses the same owned-process coordinator for
`pg_dump`, `pg_restore --list` and both version probes. Commands use explicit
absolute binaries and argument arrays, with no shell. Process records contain
identities and hashes rather than credentials, database output or command text.

## Completion and interruption

On a qualified POSIX host each tool has an owned process group. Before spawning,
the coordinator fsyncs an authenticated intent into the existing private backup
directory. It then records the observed child PID, process start identity, host
boot identity and controlling process identity. A controller nonce binds the
archive lock to this exact process generation.

Success requires the direct child exit, closure of both output streams and proof
that the owned group has stopped. A zero exit code alone is insufficient. Version
output, stderr and archive-list output have separate bounds. Timeouts and consumer
failures request SIGTERM only for the owned group, then SIGKILL after a bounded
grace period. A second bounded deadline turns an unproven stop into a durable
unknown-outcome hold. The coordinator releases its local stream handles so a
descendant cannot leave the CLI hanging forever.

New CLI work refuses outstanding process-custody records before probing a tool
or starting another backup. The encrypted catalog still refuses unknown files
and never adopts a partial archive as a successful backup.

## Inspecting a hold

Use the recorded process UUID, without its filename prefix:

```sh
node scripts/backup-database.mjs process-status --directory /absolute/private/backups --id PROCESS_UUID
node scripts/backup-database.mjs reconcile-process --directory /absolute/private/backups --id PROCESS_UUID
```

The existing `LOVELIES_BACKUP_ENCRYPTION_KEY` is required to authenticate the
record. `process-status` reports a custody hold and never reports a successful
backup. Reconciliation on Linux requires the original controller to have stopped,
the same host boot generation, an unchanged child identity, and an observed
stopped group. It never sends a signal using a PID read from disk. A matching
v2 archive lock is released only when the last process hold has been reconciled;
an earlier PID-only lock or a different nonce is retained for qualified review.
Neither operation deletes or adopts an archive, rewrites its catalog or reports
the interrupted backup as successful.

Prepared records without an observed child identity retain their hold: there is
an uncertain spawn window. Host reboot, PID reuse, a changed record, an active
controller, an inaccessible process identity, a still-running descendant, and
unqualified host identity mechanisms also retain their holds. The encrypted key
and host process inventory must be available to the responsible operator; code
cannot invent missing custody evidence.

## Local evidence and host limits

The local tests launch synthetic tools and cover ordinary completion,
SIGTERM-resistant children, inherited descendant streams, output bounds, consumer
failure, unrelated-process preservation, active-controller denial, tampering,
controller death, and identity-bound release of its matching archive lock. The
encrypted archive, CLI, output-limit and health regressions exercise the integrated
coordinator. The optional native `pg_restore` structural test remains skipped
unless its binary is explicitly supplied.

The qualified process-group model assumes the trusted PostgreSQL toolchain does
not escape its group or hand work to an unrelated service. Real PostgreSQL
binaries, production service managers, independent backup placement, process
identity behavior and restore drills still require qualification on the intended
host. The coordinator preserves unknown outcomes instead of declaring those
external checks complete.
