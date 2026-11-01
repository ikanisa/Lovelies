# Push dispatch receipt contracts

The active production contract is v2. Read [ROSTER_CONTRACT.md](ROSTER_CONTRACT.md)
for complete immutable attempt plans, the `PUSH_LEDGER_ID`,
`PUSH_LEDGER_BOOTSTRAP_ID` and `PUSH_PROVIDER_GENERATION` deployment pins,
generation derivation/fencing, empty-v1-only initialization, and mandatory
independent subject retirement before production account deletion. Missing pins
are a deployment blocker. The selected server never falls back to v1 dispatch.

## Archived v1 request-digest contract

The remaining sections describe the preserved v14 compatibility/receipt adapter
and its historical limitations. They do not describe the selected v2 sender.

This change is a code handoff. It does not show that APNs, FCM, the gateway,
the independent ledger, or mobile devices were configured or exercised live.

## Receipt fields

`POST /send` and `GET /operations/{operation_key}` return a private service
receipt with these common fields:

```json
{
  "protocol": "lovelies-push-dispatch-receipt-v1",
  "operation_key": "notification:<notification UUID>:<push device UUID>",
  "request_sha256": "<64 lowercase hexadecimal characters>",
  "status": "accepted",
  "provider_message_id": "<provider acceptance identifier>"
}
```

The digest is the existing ledger `request_sha256`. Its bytes are SHA-256 of
UTF-8 `JSON.stringify(parseDispatch(input))`, using the established property
order below. This release deliberately does not change those existing hashes:

```js
{
  operation_key,
  platform,
  token,
  notification: { id, title, kind, entity_id }
}
```

JSON whitespace and property order on the incoming HTTP body do not change the
parsed canonical request. Token bytes, notification fields, platform and operation
identity do change its digest. A receipt never contains the raw token.

An absent independent operation returns `status: "unknown"` with the same
protocol and `request_sha256: null`. This is an unresolved outcome. It never
authorizes a repeat send. Other dispositions must carry the exact stored digest.
An invalid or missing digest on an existing ledger row fails closed.

The receipt statuses retain their existing meanings. `accepted` means the
provider accepted a request; it does not prove delivery to or viewing on a device.
`not_dispatched` is the only receipt that can permit a same-request retry, after
the API rechecks current authority, the immutable digest, the token and its retry
bound. Rejected or ambiguous outcomes do not grant resend permission.

## API storage and migration

Schema v14 adds nullable `notification_deliveries.request_sha256`. The API stores
the exact dispatch binding before any provider POST and checks it before accepting
a receipt, cancelling on a definitive rejection, or retrying a proven non-dispatch.

Existing attempted rows keep a NULL binding. The migration does not reconstruct
their history from today's token or notification. They remain held for independent
reconciliation. Only a pristine queued row with zero attempts, no lease and no
receipt may receive a first-send binding. Missing or old receipt protocol versions
also remain held.

Logout, opt-out or token retirement cannot erase an acceptance received for an
already admitted attempt. The API retains that acceptance under its original lease.
For a bound retained attempt, it can also query the gateway using GET only after
authority or device retirement; that path has no POST branch and requires no raw
token. It preserves mismatched, missing and unknown histories. An active unexpired
lease is not stolen. Bounded scans continue past unresolved retained attempts.
The retired scan runs once before the bounded active-device pass. A provider or
receipt hold on one device does not prevent another independently bound device
from progressing; any unresolved delivery keeps the job nonterminal. Database,
restore-fence, admission and unexpected internal failures stop the worker instead
of being treated as ordinary per-device uncertainty.

## Deployment compatibility

The new gateway envelope can be deployed before the API change: the preceding API
ignores its additional fields. The new API requires the versioned gateway envelope
and schema v14. Applying schema v14 while the preceding API remains active makes
that API's exact schema-version gate deny requests. Coordinate the migration and
API cutover in a maintenance window and verify a staging rollout first. This
package does not run a migration or deployment.

A code-only rollback to an API expecting schema v13 is not sufficient after the
v14 migration. Do not drop preserved history or rewrite version markers to bypass
that gate; prepare and validate a compatible rollback build.

## Boundaries that remain

This receipt binds the gateway request. It does not bind APNs topic, FCM project,
provider credential or deployment generation, which remain service configuration
outside the current `parseDispatch` contract. It does not establish a complete
independent roster of all attempts after a database restore, authorize clearing an
ambiguous job, or resolve an attempted legacy row that lacks its immutable binding.
Those recovery controls remain separate release work. Gateway lookup tests and
synthetic provider receipts are local evidence, not live provider qualification.

## Local tests

The API tests cover request-digest persistence, substituted receipts, missing or
legacy protocol, a lost accepted reply, changed-content retry denial, legacy rows,
unknown-operation holds, post-retirement GET-only reconciliation, concurrent
in-flight acceptance, and fairness beyond 25 unresolved records. Provider gateway
tests cover the versioned envelope, durable duplicate and lookup responses,
missing-operation behavior, and invalid stored digest denial.

The v14 migration test verifies preserved data, all 69 private tables, forced RLS,
policies, grants, nullable additions, wrong-baseline rejection and atomic rollback
on a conflicting later column. Use the handoff's test report for the exact commands
and results that were actually executed.
