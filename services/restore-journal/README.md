# Independent restriction journal and database checkpoint protocol

This private supporting service stores minimal restriction facts outside the
Lovelies application database's restore boundary. Supabase remains the account,
consent, review and media-access authority. The service now supplies an independent
database binding, serving admission, immutable operation manifests and commit
checkpoints. It detects a mismatched database copy when the trusted API adapter
supplies that copy's marker. The API now has a strict client and PostgreSQL
transaction/checkpoint integration, required by both serving entrypoints. Reads
use actual PostgreSQL READ ONLY transactions; writes acknowledge their complete
plan before committing the matching local marker. Post-commit reconciliation
reacquires the shared lock and rereads PostgreSQL before acknowledging a cached
successor. It can recover an exact committed marker after a lost reply without
rerunning a callback.

Domain restriction producers/stable allocation consumption, generation fences
across external effects, actual replay, object inventory/cleanup and computed
safe recovery completion remain unfinished. Default empty-event mutation
checkpoints alone do not implement deletion/withdrawal suppression. There is no
recovery-clear endpoint. Do not deploy the application as restore-qualified from
these local protocol tests.

The Worker and its SQLite Durable Object authenticate before body reads and
storage/namespace access. The project is fixed to `ltqfplqevxztlswlzexn`; the
production namespace selection is `jurisdiction('eu')`. Supply the independent
server-only `RESTORE_JOURNAL_TOKEN` and keep it out of clients and logs. The
current configuration has no public route and is not deployed. Production
Supabase access requires an explicit authenticated HTTPS endpoint and verified
provider placement/custody; the local tests cannot establish either.

## Restriction facts

- `POST /v1/events` accepts exactly `{version:1, project_id, operation_id, kind,
  scope}`. `operation_id` is a stable UUID for the exact logical effect, retained
  across transport retries. Each kind has the strict scope in `SCOPE_FIELDS`.
  IDs are UUIDs; revisions/versions are bounded opaque strings. Personal text,
  biometric/media content, object URLs and arbitrary fields are rejected.
- Each append atomically writes its sequence/hash-chain receipt, operation index
  and tail. An exact operation/payload retry returns the original receipt;
  conflicting reuse returns 409. A caller must not report a restrictive operation
  successful without independently acknowledging its journal fact.
- `GET /v1/head` returns the validated tail sequence/hash. This checks the tail
  and its operation index, not every historical entry or restore clearance.
- `GET /v1/events?after=0&limit=100` returns a bounded contiguous replay page with
  the current head, next cursor and `has_more`. Replay must verify continuity
  against its trusted prior hash and continue through a freshly checked head.
  Missing/modified entries fail closed. Journal unavailability fails closed.
- Before database binding, event-only appends retain this behavior. After binding,
  a new fact must be in an operation manifest so its database checkpoint cannot
  be skipped. Exact historical event retries still return their original receipt.
- No endpoint applies deletion, approves an erasure, changes an application
  record or clears a serving quarantine. There is no manual receipt-shaped
  approval or environment flag that certifies recovery.

## Database operation protocol

All requests use the same server-only authentication and fixed project, with
`protocol: "lovelies-restriction-journal-v1"` in successful responses. A database
marker has exactly this shape:

```json
{
  "database_id": "<fixed UUID>",
  "incarnation_id": "<independently generated UUID>",
  "checkpoint": { "revision": 0, "hash": "<64 lowercase hexadecimal characters>" },
  "cursor": { "sequence": 0, "hash": "<64 lowercase hexadecimal characters>" }
}
```

The event cursor and the authoritative database checkpoint are different chains.
Every authoritative mutation advances the checkpoint, including a grant or other
mutation with an empty restriction manifest. Store the exact marker in the same
PostgreSQL transaction as the mutation and operation receipt. Keeping that copy in
PostgreSQL is necessary for comparison; it is never independent restore evidence.

| Route | Exact request fields beyond `version:1, project_id` | Result |
| --- | --- | --- |
| `POST /v1/control/bootstrap` | `database_id, bootstrap_id` (UUIDs) | One immutable binding with a generated incarnation and checkpoint; only an empty/genesis journal may begin serving. Nonzero facts enter preserved quarantine. Exact retry returns the original binding and current control. |
| `GET /v1/control` | No body or query | Current validated independent control. |
| `POST /v1/admission` | `marker` | `admitted:true` only when the copy exactly matches serving control and the current journal head. |
| `POST /v1/operations/prepare` | `operation_id, input_hash, expected, allocations, events` | One atomic immutable plan, all event receipts, and an independent pending fence. |
| `GET /v1/operations/:operation_id` | No body or query | Original plan and derived pending/committed status; 404 `operation_not_found` if absent. |
| `POST /v1/operations/:operation_id/acknowledge` | `plan_hash, marker` | Exact prepared successor acknowledgement, or the original committed receipt on retry. |
| `POST /v1/recovery/begin` | `recovery_id, expected` | Immutable recovery generation and new proposed incarnation; ordinary serving remains quarantined. |

Bootstrap is an explicit initial-deployment action. Bind one fixed database UUID
once, check the immutable `binding.initial_marker`, and install that marker only
as part of the trusted first deployment. An absent PostgreSQL marker after
deployment must fail closed. Never automatically copy independent control into
an old database or invoke bootstrap on each request. A retry cannot replace the
binding, rewind its checkpoint or reopen quarantine. This service cannot verify
that an application database is genuinely a fresh initial deployment. An
empty/genesis journal is required for a serving bootstrap. If the journal already
contains event-only facts, bootstrap preserves them and binds only in quarantine
with reason `preexisting_restrictions`. Installing its marker or retrying bootstrap
cannot open serving. This version has no computed recovery-completion protocol,
so a nonzero prebinding journal remains closed until that protocol is implemented
and qualifies replay/cleanup; no caller assertion can substitute for it.

Prepare accepts a stable logical `operation_id` UUID and `input_hash` SHA-256.
The trusted API derives that ID from the actor, action and existing operation
key, without disclosing the key. Jobs use the exact resource/episode operation.
Look up the operation before generating new IDs. `allocations` is an object with
only fixed slots `id_0` through `id_31`, each a distinct UUID; the API owns their
operation-specific meaning. `events` is an ordered array of zero through 32
existing strict events with distinct event-operation IDs. The request may contain
at most 32 allocations and 32,768 UTF-8 bytes. No arbitrary labels, reasons,
tokens, client operation keys, business response, URLs, media or biometric bytes
belong in the plan. Previously recorded event IDs cannot be adopted by a new
manifest.

Ordinary control responses are exactly `{protocol, project_id, control}`; admission
adds `admitted:true`. An operation response adds `operation`. Control is exactly:

```text
{state: "serving" | "pending" | "quarantined", marker,
 pending_operation_id: UUID | null, recovery_generation_id: UUID | null}
```

Operation is exactly `{plan, plan_hash, status, committed_at}`, with status
`pending` or `committed` and `committed_at` null or positive integer milliseconds.
The immutable plan contains exactly:

```text
{version:1, project_id, operation_id, input_hash, expected, allocations,
 events, next, prepared_at, receipts}
```

`plan_hash` is SHA-256 of the canonical plan. Canonical JSON recursively sorts
object keys lexicographically and preserves array order. Each receipt is the
existing event hash-chain receipt, in manifest order, contiguous after
`expected.cursor`; all manifest receipts have `recorded_at === prepared_at`.
`next` preserves the database and incarnation, increments checkpoint revision by
one, and names the final receipt cursor (or the unchanged cursor for zero events).
Its checkpoint hash is SHA-256 of canonical:

```text
{protocol: "lovelies-restriction-journal-v1",
 kind: "database-checkpoint-v1", project_id, operation_id, input_hash,
 expected, allocations, events, cursor: next.cursor}
```

Successful envelopes are bounded at 131,072 bytes. Every successful route returns
200; errors are only `{error: <fixed code>}` and never include request contents or
private diagnostics. The outer Worker and the Durable Object authenticate before
body/storage access. Neither accepts queries, compressed JSON or alternate RPC
write methods for this protocol.

The API must hold its reserved PostgreSQL advisory lock while reading and
comparing the database marker, looking up/preparing the stable operation,
applying SQL and storing `plan.next` in that same SQL transaction. Prepare must
complete before PostgreSQL commit or irreversible effects. After commit, the
adapter independently acknowledges exactly `plan_hash` and `plan.next` before a
successful application response. Acknowledgement is an assertion by this trusted
adapter, not a PostgreSQL attestation: calling it before actual commit breaks the
protocol. Reads and internal jobs also require fresh admission, including checks
after asynchronous effects where relevant. Do not automatically retry arbitrary
transaction callbacks containing external effects. Read-only database operations
must acquire the same lock before loading their marker; a stale snapshot racing a
new committed checkpoint would correctly fail comparison and quarantine serving.

A prepared operation fences all other ordinary serving. Admission with either
its known predecessor or known successor returns 409 `operation_pending` without
quarantine; this covers a read arriving between SQL commit and acknowledgement.
Only trusted reconciliation under the database lock may resolve that pending
operation. An unexpected marker persists 409 `serving_quarantined`; a bad exact
acknowledgement does the same. Exact retries return the original immutable plan,
including its allocated IDs, after lost replies or PostgreSQL rollback. They never
replace it, skip restrictions, rewind a later checkpoint or clear quarantine.
The adapter must inspect the current control even on a historical 200 receipt.

## Recovery boundary

A lost PostgreSQL commit response is ambiguous. Under the reserved database lock,
an exact prepared successor/operation receipt may justify the exact acknowledgement.
The predecessor alone does not prove that a transaction never committed: the
database could have been restored. Preserve the pending plan and enter recovery
when the original transaction cannot be established. Never drop a prepared
restriction or create fresh IDs to get past the fence.

Recovery begin permanently fences the current service state and records one
immutable generation: prior marker, any pending operation, independently generated
new incarnation, current journal head, a fixed reason and generation hash. Exact
retry is stable. A different generation is rejected while this generation is
active. The present foundation deliberately has no recovery-complete/clear route,
so it cannot open even the new proposed incarnation. No bootstrap, historical
acknowledgement or environment flag can bypass that fence.

The future recovery worker must prove contiguous restriction replay against a
fresh independent head, exact episode semantics, old-incarnation credential and
delivery retirement, pending-operation reconciliation, and resource cleanup with
independent object inventory/absence checks. It must preserve later independent
consent, adulthood, profile, device and block episodes. Only a computed protocol
covering those effects may install a new database marker and open that generation.
An event-only cursor, same-schema version, same-database outbox or operator boolean
cannot supply this evidence.

`account-deletion-requested` records only the accepted request; it does not
authorize physical erasure or permanently prohibit a later reviewed recovery.
`account-deletion-reviewed` retains the exact independent decision and reviewer.
Only `account-erased` is a terminal erasure fact. Consent, guardian, profile,
sharing-request, session, device and asset retirement names the exact old
episode. Matching pause/resume on the same reference uses the withdrawn consent
ID, not a permanent profile ban. Pair block/end events name the exact blocking
operation. Ending a block grants no sharing access and cannot revive old grants;
new independent consent/approval is still required by the application.

The journal deliberately has no timer that discards suppression or operation
facts. Retention/minimisation/compaction must be implemented with the independent
backup horizon and verified replay protocol before making a production retention
promise. The intended published 365-day suppression period is not qualified by
this foundation. Keep provider restore/custody and operator separation explicit.

## Local checks

```sh
pnpm restore-journal:test
pnpm restore-journal:check
pnpm restore-journal:build
```

The build is a dry run. Unit cases exercise strict schemas, authentication before
reads, concurrent idempotency/conflicts, rollback/outage, corruption, pagination,
clock/sequence limits and scoped event preservation. The separate runtime case
executes the actual outer Worker and SQLite Durable Object, with concurrent
HTTP appends, full hash-chain paging and dispose/restart persistence. workerd
does not implement jurisdiction restrictions: a test-only selector seam records
the requested `eu` namespace and forwards to the real local DO. Production code
has no jurisdiction fallback. This is not EU-placement, hosted restoration,
independent guardian-review or store acceptance evidence.

Operation cases additionally cover stable allocations, concurrent exact prepares,
bounded manifests, empty-event checkpoints, pre/post-commit pending fences,
lost replies, PostgreSQL rollback simulation, incorrect acknowledgement,
same-schema rollback quarantine, immutable recovery and metadata corruption.
The operation runtime case exercises the actual outer Worker and SQLite DO over
HTTP with persistence/restarts and test-only injected exceptions after real
SQLite writes. It qualifies transactional rollback and protocol persistence;
it does not perform an application database restore or cleanup.
