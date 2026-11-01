# Local Supabase operating and release runbook

The application and independent custody database have different restore lifecycles. Keep the pinned deployment, exact image/model/source identities, encrypted configuration inventory, backup keys and approved operator access recoverable outside the application host. Never use an application restore to replace the custody volume or its journal, provider plans or immutable receipts.

## Required operating assignments

Before launch, record named primary and backup owners for host/database operations, restore custody, privacy/safety review, provider credentials and mobile/store release. Record their actual escalation route, response coverage, maintenance window, backup schedule, recovery objectives and rollout observation window. These are real operating decisions; this source does not invent people, destinations or service commitments. Exercise the selected alert route and retain delivery/acknowledgement evidence before marking R05 complete.

## Read-only observation

`scripts/observe-platform.mjs` reads aggregate queue age, failed jobs, expired leases, unresolved cleanup and media writers, uncertain push records, managed Auth cleanup, waiting database locks and database size. It checks full public readiness and authenticated private custody health. It exposes no account IDs, raw queue payloads, tokens, provider messages, object keys or media. Its SQL uses a five-second statement timeout in a read-only transaction.

Supply a protected JSON thresholds file with exactly these nonnegative integer fields:

```json
{
  "max_queue_age_seconds": 60,
  "max_failed_jobs": 0,
  "max_expired_leases": 0,
  "max_cleanup_unresolved": 0,
  "max_media_writers_unsettled": 0,
  "max_push_uncertain": 0,
  "max_managed_auth_unresolved": 0,
  "max_waiting_locks": 0,
  "max_read_p95_ms": 100
}
```

These numbers are an **illustrative strict fixture**, not approved production limits. Measure normal behavior and select limits and alert persistence with the responsible operator. A nonzero unsettled writer can be normal during active processing; sustained age and repeated observation provide the operating context. Never clear an unresolved effect merely to silence an alert.

```sh
node scripts/observe-platform.mjs \
  --runtime /absolute/protected/runtime \
  --thresholds /absolute/protected/approved-thresholds.json \
  --receipt /absolute/protected/new-observation.json
```

Exit zero means the observed sample stayed within the supplied limits; exit two means attention is required; exit one means observation could not complete. The receipt is exclusively created, source-bound and marked dirty if the checkout changed. Connect this bounded command to the host's selected monitoring supervisor. It prints sanitized local output and does not send messages or configure a notification destination.

Private custody `/metrics` endpoints provide authenticated up/request/failure/duration aggregates. Restrict scraping to the private network and separate observer credential. Do not expose these endpoints, Studio, PostgreSQL, provider files or `net.http_request_queue`/Vault contents publicly. Review host disk capacity, volume health, clock synchronization, certificate expiry, backup age, container restarts and crash/ANR reports alongside application metrics.

## Capacity and contention

An opt-in `--probe-count 100 --concurrency 4` reads `/health` at bounded concurrency and records p50/p95/max latency. It measures the real read path and its PostgreSQL/journal admission cost. It does **not** establish write throughput, inference capacity or mobile latency. Run capacity work on isolated staging with the final images and representative approved data.

For B05/B06, exercise simultaneous enrollment/session renewal, upload reservations, full candidate matching batches, sharing decisions, privacy exports and maintenance. Record request arrival/completion rates, p95/p99 and error rate, CPU/RAM/disk I/O, database connection/lock waits, independent journal duration, oldest job age, retry distribution and large-export bounded memory. Repeat with one dependency slow/unavailable and after process restart. Choose the five enforced upload/processing budgets from the measured safe envelope. Preserve actual workload, source, configuration and model hashes; a read-only probe or synthetic benchmark cannot close those mixed-workload gates.

## Incident actions

| Signal | Immediate action | Safe recovery condition |
| --- | --- | --- |
| Unauthorized access, wrong recipient or compromised credential | Stop admission/rollout; restrict the affected service; preserve minimal forensic evidence; rotate through the reviewed procedure. | Negative authorization tests and exact credential/build readback pass. |
| Journal unavailable, marker mismatch or restore quarantine | Keep normal serving closed. Inspect independent control and the matching database marker. | Computed restriction replay, effect reconciliation and object inventory establish a new incarnation; no manual marker rewrite. |
| Push effect ambiguous or custody lost | Stop new provider admission; use recovery-only lookup/retirement. Keep the inbox available where current authority permits. | Every relevant started intent has an independently established terminal result; no key replacement or namespace reset. |
| Managed Auth signup/refresh/deletion uncertain | Preserve encrypted binding and original operation. Reconcile through supported Auth APIs. | Exact provider session/user outcome is verified; no direct Auth table mutation. |
| Failed/old queue item | Inspect authorized Work recovery and retained error history. | Exact original episode, current consent/authority and unstarted external effects permit re-admission. |
| Cleanup or export writer unresolved | Retain object/effect evidence and privacy holds. | Actual writer terminality and object absence/integrity are independently verified. |
| Backup missing, unauthenticated or restore rehearsal failed | Stop release expansion and repair backup custody. | Encrypted DB/Auth/Storage metadata plus bytes are authenticated and restored in an isolated drill without replacing custody. |

## Deployment, backup and rollback

Use the generated runtime and the explicit `scripts/local-supabase-*` commands. Review their new receipts after each stage. Initial bootstrap is allowed only against a proved empty deployment; existing unknown data must not be overwritten. Apply additive migrations through schema19 and record their exact checksums. Then qualify real Auth, private buckets, TLS/proxy boundaries, Cron, least privilege and custody restart durability.

Run coordinated encrypted backup and isolated restoration with the supplied tools. Independently retain custody backups and investigate whole-custody rollback as a distinct incident. Rehearse restoration of post-backup consent revocation, account erasure, media cleanup, uncertain store/push effects and authority retirement before cutover. A database dump alone is not a Storage byte backup or a restore clearance.

Managed Auth data-key rotation now has a dedicated operator workflow in
`scripts/local-supabase-rotate-managed-auth.mjs`. Follow the exact commands and
required protected inputs in `deploy/local-supabase/README.md`. Rotation creates
encrypted old/new-key escrow, closes the persistent request gate, prevents new
runtime database logins and stops writers. The all-row rewrite, independent
journal marker and immutable receipt form one guarded transition. A separate
explicit resume verifies the selected key, full database state and runtime
readiness before reopening. The narrow `abort`/`resume-aborted` path reconciles
only the original accepted empty plan whose SQL rewrite rolled back; the
original operation ID remains terminal. Preserve old keys for retained backups.
The synthetic crash tests do not replace a real host reboot, power-loss or
escrow-retrieval rehearsal.

Use the existing `com.lovelies.memories` store records and signing lineage. Verify in-place upgrade, rollback-compatible API behavior and physical-device journeys using the exact signed artifacts. Keep old supporting services during the approved compatibility period. Halt rollout for access, data-loss, deletion-fencing, persistent authentication or core-journey failures. Prefer a reviewed forward fix to replaying old authority.

The release gate verifies the integrity and scope of evidence; it does not supply missing host/device/provider/store results, independently prove receipt truth or authorize deployment. Keep every open task explicit until its actual acceptance evidence exists.
