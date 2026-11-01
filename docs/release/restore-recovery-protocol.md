# Restore protocol and local recovery procedure

This source implements independent restriction manifests, failed-commit
reconciliation, a generation fence for external writes, and a resumable full
restore controller. It does not deploy the journal, initialize a production
binding, run a migration against a hosted database, or certify provider custody.

The production API must use `RestoreDatabaseFence` and the effect-enabled
Storage/private-service adapters wired in the Supabase Edge entry point. The
recovery program is a privileged operator program, separate from product HTTP
routes. An unavailable journal, missing binding, mismatched checkpoint, unknown
writer, unsupported object or unproven cleanup leaves serving closed.

## What each durable record proves

| Record | Meaning |
| --- | --- |
| Original operation ID and input hash | One logical mutation and its original inputs. Reusing its ID with different input conflicts. |
| Immutable restriction manifest | The entire exact set of restrictions, including every continuation chunk. An uploaded partial manifest grants no authority. |
| Independent prepare | Restrictions are durable outside the PostgreSQL backup, and the database checkpoint is reserved. It does not prove PostgreSQL committed. |
| PostgreSQL marker | The domain changes and this exact operation/plan checkpoint committed in one database transaction. |
| Independent ACK | The trusted adapter verified that marker. Ordinary commit and restrictive recovery have distinct outcomes. |
| External-effect registration | An exact immutable attempt descriptor exists before a private PUT or mutating private-service request. It does not prove dispatch or provider acceptance. |
| Dispatch observation | The attempt was admitted in its then-current incarnation. A timeout cannot turn it into a never-dispatched attempt. |
| Recovery clearance | The authenticated restriction prefix, effect registration prefix, observation cut, retirement proof and exact cleanup proofs agree with a new SQL incarnation. |

The controller never guesses which business callback originally ran. A failed
SQL commit replays restrictions and records `restricted-abort`. A full restore
retires an interrupted operation as `restore-retired`. Both are terminal
negative outcomes, exposed as `operation_retired_by_recovery` for the original
input after current caller authorization. A changed input receives
`operation_key_conflict`. Committed SQL receipts keep their existing semantics.

## Complete manifests and bounded transport

Historical version-1 operation records remain readable and keep their original
validation and hashes. An operation needing more than 32 facts, or exceeding the
single-request budget, uses a version-2 immutable manifest. Its header binds the
original operation ID, input hash, allocations, expected SQL marker, exact fact
count, chunk count and hash-chain root. Each chunk contains at most 32 facts.

The API uploads the full manifest before the journal reserves a pending
checkpoint. The journal then appends at most one chunk per continuation call.
Each accepted index, event identity, chunk hash and full root is immutable.
Lost replies resume the same original manifest; altered indexes or content
cannot replace accepted bytes. SQL cannot commit until every fact has an
authenticated receipt and the compact prepare plan is available.

The existing 32 KiB request and 128 KiB response ceilings remain in place. Replay
pages contain at most 32 receipts; effect pages at most 32 registrations. A
controller step applies one replay page, reconciles one external effect, scans
one Storage page, or advances one erased-account episode. Storage list responses
also have byte, fragment and deadline bounds. Final inventory hashing pages SQL
proof rows in groups of 32 and does not concatenate the whole object inventory.

The originating domain transaction still selects its exact affected rows and
collects its facts before committing. This package does not claim that every
domain selector has constant total memory or that an unbounded number of facts
can finish within one hosted transaction deadline. The removal of the 32-fact
refusal is covered by continuation tests; hosted maximum-size transaction and
concurrency budgets need measurement with the final deployment limits.

## Restriction producers

Schema 15 captures exact old authority episodes in the same SQL transaction
that changes them. `RestoreDatabaseFence.prepare` merges those rows with the
explicit domain facts, deduplicates exact kind/scope pairs, persists the complete
independent manifest and drains that transaction's capture rows atomically.

| Producer / authority | Replay scope |
| --- | --- |
| Consent withdrawal, profile actions, audience restriction, account erasure | Account, consent and purpose; profile ID/revision where retired. Authentication withdrawal changes only the matching authentication consent binding. |
| Sessions, logout, refresh cancellation and administrator session revocation | Exact account/session. Consent-bound pending profile operations and unused challenges are cancelled only for the exact retired consent. |
| Devices and account recovery | Exact account/device/revision; sessions bound to that device revision. |
| Guardian approval and relationship termination | Exact approval/purpose plus original request revision and terminal state. A later relationship/revision is preserved. |
| Sharing decisions and grant retirement | Exact sender, recipient, request, grant and asset. Candidates never become access grants. |
| Asset and candidate retirement | Exact owner, asset/candidate and version. |
| Pair block/unblock | Exact blocker, blocked account and immutable block episode. Ending one episode cannot remove a newer episode. |
| Push device and notification setting retirement | Exact device/token hash or account/setting update version. Already attempted deliveries remain historical outcomes. |
| Moderation restrictions | Exact hold and subject or asset owner. Independent hold facts protect writes even when the owner was created after the restored backup. |
| Global, asset and privacy legal holds | Independently named hold episodes and matching end facts. A later hold is not cleared by ending an earlier one. |
| Delegated operator access | Exact account/grant/capability. Schema 17 attaches the capability trigger to the schema-15 capture function. |
| Store entitlements | Exact account/subscription/version. A retired version cannot authorize an old download ticket. |
| Privacy export delivery authority | Exact grant/session/request and publication/subject/request. |
| Deletion request, independent decision and terminal erasure | Separate exact request, reviewer/decision and erased-account facts. A request or rejection cannot be promoted to completed erasure. |

Unbound local setup does not accumulate orphan capture rows. After a database
binding exists, a writer lacking the protocol-2 transaction setting is rejected
by the authority capture/media-writer triggers. Privileged controlled restoration
explicitly uses `lovelies.restore_replay=on`; normal application transactions must
never install that bypass. Test fixture seed wrappers are explicitly separate
from the fenced runtime database.

These triggers complement the reserved-connection PostgreSQL advisory lock and
the API's current actor/capability checks. They do not turn database superuser
access or a leaked service credential into an untrusted, contained interface.

## Failed-commit reconciliation

At database admission, the adapter distinguishes two recoverable cases:

1. SQL has the exact prepared next marker and operation/plan hash. The commit
   happened, so the adapter acknowledges that exact commit without rerunning its
   callback.
2. SQL still has the exact predecessor of an independently pending prepare.
   Under the same advisory lock, the adapter finishes any accepted manifest
   continuation, reads contiguous authenticated restriction pages, applies only
   those negative facts, stores the recovered operation outcome, and advances
   SQL to the prepared marker. After that transaction commits, an independent
   reconciliation ACK records the distinct negative outcome.

A different SQL marker, invalid hash, corrupt record, missing continuation or
unavailable journal does not qualify. The caller never gets a fabricated success
receipt. Generic operations and signed profile actions check recovered outcomes
before entering their business work. Explicit raw transaction intents are also
checked before their callback. A new unrelated operation can proceed after the
restriction-only reconciliation; the retired original input cannot be executed
again merely by retrying it.

An interrupted terminal erasure remains distinguishable from SQL completion.
Its restrictive fact suppresses restored account authority. It does not invent
physical absence or a completed request from a timestamp. The full controller's
trusted erasure continuation re-runs metadata minimization and proves cleanup
before marking that erased episode completed.

## External effects and unknown outcomes

All three private Storage buckets use effect-enabled adapters:
`PHOTOS`, `QUARANTINE` and `PRIVACY_EXPORTS`. Each descriptor contains its exact
bucket/key, independently captured owner ID, byte count, payload digest, metadata
digest and database incarnation. The adapter resolves the owner from the exact
durable media write intent before the PUT. It does not derive ownership from a
restored object key or use an absent owner row as deletion permission.

A repeated Storage attempt checks the existing exact object and never dispatches
a second PUT for the same attempted effect. A lost reply remains unknown until
qualified materialization proves the exact byte count and digest. Fresh privacy
export retries use their own immutable keys/write intents; they cannot settle an
older unresolved writer by observing a different candidate.

Mutating inference, push and store service requests are also registered and
generation-fenced before dispatch. The descriptor stores a digest of the bounded
request body, not its private body. Late results are historical observations;
they cannot grant a stale invocation permission to publish metadata or send a
new request. Provider transport success remains distinct from domain acceptance.

At full recovery, registered never-dispatched effects can be cancelled. A
dispatched or unknown Storage writer with no object remains a blocker: elapsed
time, an absent SQL row, an empty cleanup queue or a single absent HEAD cannot
prove that the writer will never materialize. Exact present bytes can provide a
materialization observation, which invalidates the prior observation cut and
requires all effect proofs to be refreshed.

The controller keeps service outcomes as historical-only evidence. That is not
proof that an external push, inference task or store operation was cancelled,
nor proof of deletion in another provider. Actual gateway retention, idempotency,
late-result behavior and credential isolation remain deployment qualifications.

## Full restore sequence

Use one stable recovery UUID for the entire incident. `begin` is idempotent even
if its independent response or subsequent local run-row insertion was lost.

1. The journal creates a generation with a new incarnation and freezes the
   complete restriction and effect registration heads. Serving is quarantined.
2. The controller replays a contiguous authenticated restriction prefix. SQL
   progress advances before its independent replay ACK; a lost ACK safely
   rechecks the same exact receipts.
3. It retires old sessions, refresh deliveries, face challenges, enrollment and
   recovery credentials, profile controls, consents, guardian authority, media
   tickets/grants, privacy export authority, active store entitlements, queued
   work and delegated operator grants. It removes only `admin` from account role
   lists and keeps ordinary account data/other roles. Attempted provider work is
   retained as historical evidence.
4. Previously completed erased-account episodes re-run the idempotent private
   metadata inventory under an internal authority bound to the authenticated
   erasure, independent approval, disabled subject and active recovery. This
   authority cannot be constructed by a product route and never provisions an
   operator. Legal/moderation holds remain effective.
5. Each independent Storage effect is reconciled against exact bytes, fresh
   references and holds. A currently owned ready photo/rendition with matching
   bytes is preserved. A known unreferenced object is deleted only after exact
   rechecks, then a fresh HEAD must establish absence. Unknown objects are
   preserved and block clearance.
6. The controller traverses the complete private Storage namespaces in bounded
   pages. It will not infer an empty inventory from SQL. A protocol-2 intent with
   no independent registration can be retired as never dispatched only under
   this completed inventory/current incarnation. Legacy unresolved writers and
   unqualified old cleanup keys remain blocked.
7. Erased requests can finish only with current-run metadata audit evidence,
   zero unresolved subject writers and exact current-run absence proofs for all
   request cleanup keys. The normal retention evidence and asset minimization
   then finish. No new erasure fact or fabricated historical approval is created.
8. The controller computes the retirement/inventory digest. The journal prepares
   a clearance binding that digest, the complete replay prefix, all effect proofs
   and their current observation cut. SQL installs that exact new-incarnation
   marker; only then can the journal accept completion and reopen serving.

A late observation after provisional preparation invalidates that clearance.
The next step resets the effect proof cursor and provisional retirement digest,
re-verifies every effect, recomputes the digest and installs a new clearance for
the same recovery generation. A superseded clearance cannot complete. Retrying
an already completed recovery records its audit state without rewinding a later
SQL marker or retiring new sessions.

### Consequence for existing accounts and operators

Full recovery intentionally retires credentials and roles restored from the
backup. Fresh anonymous registration and normal fresh enrollment can operate
after clearance. Retained old account assets remain private and inaccessible
through retired sessions/devices/controls/recovery keys. The existing product
paths do not automatically rebind a newly enrolled person to one of those old
accounts. Same-account re-enrollment requires independently qualified recovery
authority; a restored face/profile row is not sufficient proof.

Full administrators also require fresh independent provisioning. This program
does not contain an administrator bootstrap shortcut. Qualify the customer
recovery and operator reprovisioning procedure before treating full restore as
an accepted production recovery journey.

## Operator command

Run from the repository root using the project's supported Node runtime and
installed dependencies. Apply migrations through the current schema using the
normal reviewed migration procedure first; the command refuses another schema.
No command here initializes a binding or rewrites a missing control row.

Provide secrets through the process environment, never command-line flags:

| Variable | Value |
| --- | --- |
| `LOVELIES_DATABASE_URL` | Approved direct PostgreSQL URL for this controlled recovery; role must be able to select `lovelies_api`. |
| `LOVELIES_DATABASE_CA` | Optional PEM CA contents when an explicit CA is required. Non-loopback database connections verify TLS. |
| `SUPABASE_URL` | Exact selected project URL `https://ltqfplqevxztlswlzexn.supabase.co`; loopback is accepted only for local rehearsals. |
| `LOVELIES_STORAGE_SECRET` | Privileged Storage credential for the same project. |
| `RESTORE_JOURNAL_URL` | Independently operated journal endpoint. |
| `RESTORE_JOURNAL_TOKEN` | Dedicated server-only journal token. |

```sh
node --experimental-transform-types services/supabase-api/scripts/restore-recovery.mjs status --recovery-id RECOVERY_UUID
node --experimental-transform-types services/supabase-api/scripts/restore-recovery.mjs begin --recovery-id RECOVERY_UUID
node --experimental-transform-types services/supabase-api/scripts/restore-recovery.mjs step --recovery-id RECOVERY_UUID --steps 10
```

Replace `RECOVERY_UUID` with the single incident UUID. Each invocation runs at
most the requested 1–100 steps; default is one. Repeat `step` with that original
ID after interruption. Output includes phase, counts, generation hash and
clearance hash, without credentials, object keys, account IDs or provider bodies.
Only the independent completed state is a serving-clearance result.

| Stop/error | Required response |
| --- | --- |
| `restore_writer_unresolved` | Preserve the old writer and object evidence. Obtain an independently qualified terminal/materialization outcome; do not force absence. |
| `restore_cleanup_held` | Preserve bytes and the active hold. Resolve only through the applicable authorized hold process. |
| `restore_hold_metadata_unresolved` | An active independent hold lacks its exact SQL policy/request/asset binding. Preserve quarantine; qualify that missing held metadata before ordinary retention can resume. |
| `restore_unknown_object_preserved` | Identify the exact object/ownership independently. Do not delete unknown/test data to obtain a green result. |
| `restore_uninventoried_writer` / `restore_legacy_cleanup_unqualified` | Qualify the historical writer baseline; an absent restored row is insufficient evidence. |
| `restore_object_replaced` / `restore_reference_changed` | Investigate identity/content mismatch. Never accept replacement bytes as the original attempt. |
| `restore_writer_fence_required` | Stop the obsolete non-fenced application writer. Do not add the privileged replay bypass to serving code. |
| Journal/database identity or integrity error | Retain quarantine and original evidence; do not create a replacement binding or invent a checkpoint. |

## Local verification and remaining qualification

The dedicated self-contained tests are:

```sh
node --experimental-transform-types --test --test-isolation=none --test-concurrency=1 services/restore-journal/test/manifest-recovery.test.mjs services/supabase-api/test/restore-effect-adapters.test.mjs services/supabase-api/test/restore-operation-outcome.test.mjs
node --max-old-space-size=512 --experimental-transform-types --test --test-isolation=none --test-concurrency=1 services/supabase-api/test/restore-controller-runtime.test.mjs
node --max-old-space-size=512 --experimental-transform-types --test --test-isolation=none --test-concurrency=1 services/supabase-api/test/restore-database.test.mjs
```

Run the database files serially. The harness supports its existing disposable
PostgreSQL lane and otherwise uses PGlite; report which lane actually ran.
Local mock-bucket and journal restart/fault results do not certify hosted
Storage semantics, database failover, independent backup custody or optical
recognition. Keep test counts tied to the exact final source/log checkpoint.

Before deployment, qualify the independent journal's durability/custody,
credential separation, old-worker shutdown, provider late-write behavior,
complete namespace listing, database transaction limits, operated backups and a
controlled restoration of the exact deployed schema. A historical writer universe
that predates this protocol requires an independently qualified baseline. This
controller deliberately offers no inferred baseline, `force-clear`, SQL-only
green flag, automatic binding creation or destructive unknown-object cleanup.
