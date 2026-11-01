# Exact queue repair

Queue admission distinguishes a durable queue receipt from completion of its
domain work. A stopped `job_queue` row whose photo attempt, privacy request or
notification is still live remains unresolved. Ordinary outbox scans preserve
that mismatch and continue fairly to other work. They do not reset the stopped
row or falsely record a handoff.

The administrator repair endpoint provides a separate, explicit path for work
whose current durable evidence proves that the **same queued episode** can be
resumed. It does not revive a failed domain episode, replace a source version,
change consent, recreate an approval, or discard uncertainty about an external
effect.

## Operator contract

`GET /admin/queue-repairs` is a current-administrator recovery inbox. It supports
the shared `q`, `status`, `sort`, `limit` and `cursor` contract and returns
`{queue_repairs:[...],page}`. The default `status=attention` selects stopped queues
with missing or nonterminal domain work. `all`, `failed` and `completed` allow
the operator to inspect other stopped rows; `q` searches exact keys/domain IDs,
category and error code. Every row has both `id` and `job_id` equal to its queue
hash, plus category, queue/domain state, lifetime attempt/error metadata and
timestamps. It contains no payload or eligibility decision and makes no provider
calls. Exact detail inspection follows selection, so a full inbox page cannot
produce a provider request per row.

`GET /admin/queue-repairs/{job_id}` requires a current registered administrator.
The job ID is the SHA-256 digest of the canonical category and exact payload.
The response contains one `queue_repair` object:

| Field | Meaning |
| --- | --- |
| `job_id`, `category` | Exact queue identity and domain family |
| `queue_state`, `attempts`, `error_code` | Current stopped queue evidence |
| `domain_id`, `domain_status` | Exact bound domain identity and current state |
| `eligible`, `blocked_reason` | Current decision and a fixed denial code |
| `fingerprint` | Hash of the complete private inspection evidence |
| `action` | `resume_exact_work` when eligible; otherwise `null` |

No object keys, session credentials, profile templates, model input, export
contents, or provider request material appear in this projection.

`POST /admin/queue-repairs/{job_id}` accepts only:

```json
{
  "operation_key": "a new UUID retained until its outcome is known",
  "expected_fingerprint": "the exact 64-character hash returned by GET",
  "reason": "the operator's review reason"
}
```

The mutation requires an actual face login completed for this exact current
administrator session within five minutes. Refreshing a session does not satisfy
that requirement. The endpoint rechecks current authority and all evidence inside
the database transaction. A changed preview returns
`409 queue_repair_snapshot_changed`; a current held preview returns
`409 queue_repair_blocked`.

The exact current administrator, session, face consent, audience authority and
five-minute login deadline remain bound through independent journal prepare,
the final SQL commit boundary and response release. If an outcome may already
have committed, `503 queue_repair_outcome_unresolved` preserves the original
operation key for reconciliation. A proven same-connection rollback may instead
return the existing definitive `409 operation_recovered_without_result` after
the original intent has been retired; it never reruns the repair callback.

An admitted repair returns
`{queue_repair:{job_id,category,domain_id,action:"resume_exact_work",status:"admitted",repaired_at}}`.
The response is a historical admission receipt, not a claim that work has
completed. Clients refresh the domain detail and queue evidence after success.
They retain the exact operation key and body across uncertain transport outcomes.
An exact retry returns the same receipt and creates no second audit or enqueue.
Reusing a key for different input is rejected.

## Evidence required

Every repair requires canonical category/payload/hash agreement and a stopped
queue row (`failed` or `completed`) with both lease fields absent. Merely expired
leases do not qualify.

For a photo, the exact attempt must still be `queued`, unleased, unexpired and
without a completion, error, rendition key or matches result. Current owner
session, account, source, consent, audience and model-generation checks must all
pass. A captured paged match plan must retain its exact root and valid next-page
progress. Repair preserves that progress, so completed inference pages are not
repeated. Existing output for the source version, a competing live attempt,
pending writers or unresolved subject cleanup keeps the job held.

For privacy work, the exact request must still be `queued`, with a current
independent administrator approval and its exact noncancelled approval outbox.
The subject and request lifetime must still qualify. No execution lease,
failure/completion, erased-metadata witness, export publication, export snapshot,
request cleanup or pending subject writer may exist. Deletion also checks the
complete current global, request, subject, asset and moderation holds.

For notifications, the endpoint reads the complete independent attempt roster
under the configured immutable ledger, bootstrap and provider-generation pins.
The ledger must be serving, the exact nonempty plan must still be active, and
every receipt must be `unstarted`. The identical local immutable plan, any local
receipt evidence, current notification authority, active device registrations,
token hashes and exact original request hashes must agree. Inspection only makes
GET requests. Missing plans, attempted or ambiguous receipts, retired plans,
cancelled deliveries, changed generations and conflicting legacy history stay
held. An external outage or unverifiable response is a service failure, not an
eligible or safely cancelled preview.
An `ambiguous` SQL job caused solely by a failed provider preflight can qualify
when this complete independent proof establishes that every attempt is still
unstarted. The prior domain state is preserved in the audit; an ambiguous
independent receipt never qualifies.

## Atomic handoff and history

A successful transaction changes only the exact stopped queue row to `pending`,
makes it available now, clears its prior completion timestamp, and records the
exact existing domain outbox as handed off. It does not call the queue binding,
Storage or a delivery provider to perform work. Normal workers subsequently
claim a new lease and repeat their own current authority checks.

The queue's lifetime attempt count and previous error remain intact at admission.
The audit records those values, the previous state, previous completion and
availability times, the exact evidence fingerprint, current administrator and
reason. A successful worker may clear its current error as usual; the audit
preserves the repair history. An additional failure at an exhausted retry budget
stops again instead of receiving an unbounded automatic retry allowance.
The operation receipt and reason are linked to both the operator and the repaired
data subject, so the existing subject export/erasure lineage includes them.

All repair reads and writes remain subject to the independent restore fence.
This feature cannot reopen an arbitrary restored database, replace missing
external inventory, retire old credentials, or settle an ambiguous provider or
object write.

## Local regression gate

`services/supabase-api/test/queue-repair-runtime.test.mjs` exercises live
authentication, exact retries and stale previews, durable holds and external-work
evidence, actual photo/privacy worker completion, preserved lifetime attempt
counts, and continuation from a previously sealed photo matching page. The
notification companion, `queue-repair-notification-runtime.test.mjs`, verifies
complete independent unsent-plan admission, useful one-time delivery through the
normal worker, changed payload/device authority, missing and conflicting history,
dispatch transitions, retirement, outages and bootstrap pin failures. Fixtures
use private in-memory object stores and synthetic processors/providers; they make
no production provider calls. `queue-repair-restore-runtime.test.mjs` advances the
operator's review deadline during an actual independent journal prepare and
proves that queue/outbox work is rolled back and the exact original intent is
retired safely. The inbox regression traverses more than 150 stopped rows without
provider reads and checks literal search, cursor binding and denied access.
