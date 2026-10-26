# Lovelies private push provider

Implemented 23 October 2026 in `services/push-provider/`. This Node 24 service is
an authenticated provider adapter for the Supabase API notification outbox. It
uses real APNs HTTP/2 and FCM HTTP v1 protocols, with an independent Cloudflare
SQLite Durable Object receipt ledger. The Node gateway requires its serving
binding before loading provider keys; there is no application-database fallback.
Neither service is deployed and no Apple/Google notification was sent.
The existing inbox remains the authoritative notification history. Provider
acceptance means the provider accepted a request; it does not establish delivery,
a tap, current account access or physical-device behavior.

## Contract and authorization

Configure the Supabase API's existing `PUSH_SERVICE_URL` to a private/pinned HTTPS
service URL and `PUSH_SERVICE_SECRET` to the same private bearer secret used here.
The gateway refuses requests before accessing its ledger unless that secret
matches. Neither the secret nor provider keys belong in mobile builds or a
publishable repository. The default HTTP listener is loopback for a TLS reverse
proxy; restrict its network ingress to the backend. No redirects are followed to
Apple, Google or their token endpoint. Limit proxy bodies to 8 KiB and requests
to 45 seconds. The gateway also bounds request bodies and concurrent dispatches.

`POST /send` accepts exactly:

```json
{
  "operation_key": "notification:<notification UUID>:<push-device UUID>",
  "platform": "ios",
  "token": "<private current APNs or FCM token>",
  "notification": {
    "id": "<same notification UUID>",
    "title": "A photo sharing request is waiting",
    "kind": "match",
    "entity_id": "<sharing-request UUID>"
  }
}
```

`GET /operations/<URL-encoded operation_key>` reads the durable gateway receipt.
Allowed kinds/titles are the three current backend templates: match (`A photo
sharing request is waiting`), payment (`Your subscription status was updated`)
and support (`Your support request was reviewed`). Payment entity IDs retain the
backend's opaque provider/transaction identifier; match/support use UUIDs. Titles
cannot contain user names, media or arbitrary caller content. Both provider
payloads include `id` for native authenticated inbox re-fetch and routing;
`kind`/`entity_id` are hints, never access authority. Android uses a data-only FCM
message and its existing native notification channel/display code.

All receipts bind `operation_key` and have one of these statuses:

| Status | Meaning and consumer action |
| --- | --- |
| `accepted` | Persisted provider acceptance with `provider_message_id`; never resend. |
| `rejected` | Definitive provider rejection; terminal for this operation. Includes sanitized `provider_code`, `token_invalid` and diagnostic `retryable`. Even `retryable:true` does not authorize another dispatch of this operation. The inbox remains usable. |
| `ambiguous` | Dispatch may have occurred; never resend automatically. |
| `dispatching` | Dispatch was committed; result still unresolved. Wait/reconcile without a second send. |
| `preparing` | Another preflight claim is active; wait/reconcile. No message bytes have yet been sent by that claim. |
| `not_dispatched` | Credential/configuration preflight failed or its safe lease expired; a future same-key/same-payload attempt may retry only after fresh backend account/device/token/consent/epoch checks and the backend's bounded retry policy. |
| `unknown` | No gateway receipt exists; this is not evidence of successful delivery and does not itself permit a resend. |

Lookups return HTTP 200 when the ledger is readable. Most durable POST outcomes
also return 200; preflight failure returns 503 with the bound `not_dispatched`
receipt. A receipt-write outage after dispatch returns 503/`ambiguous`. The
consumer must retain validated operation-bound receipts on non-2xx responses.
Unauthorized requests return 401, invalid input 400 and same-key/payload conflicts
409. Infrastructure failures never manufacture an accepted receipt.

Invalid-token classification is explicit: APNs `BadDeviceToken`,
`DeviceTokenNotForTopic`, `Unregistered`; FCM `UNREGISTERED` and
`SENDER_ID_MISMATCH`. Generic `INVALID_ARGUMENT` does not retire a token.

## Durable duplicate and ambiguity handling

The ledger stores operation/request hashes, platform, notification UUID, provider
request UUID, state and receipts. It does not store raw device tokens, message
content, bearer credentials or signing keys. The older PostgreSQL adapter and
`services/push-provider/migrations/202610230001_push_dispatches.sql` remain as
reference implementations/tests. They are not the selected deployment path; do
not apply that migration to the application project to satisfy this boundary.

A transaction reserves each unique operation and hashes the exact canonical
payload. Conflicting payloads cannot reuse the key. A short preflight lease can
be reclaimed because no provider message was dispatched; a claim token fences an
expired owner before sending. Dispatch intent is committed before calling the
provider. `dispatching` rows are never reclaimed. If the process dies or loses
the response, the row becomes `ambiguous`; another POST only returns that status.
An acceptance followed by a database outage also stays unresolved until its
original receipt is durably known. There is no automatic retry layer after a
provider dispatch, and no claim of exactly-once device delivery.

APNs/FCM do not provide a general per-message delivery-status lookup for this
contract. GET reconciles this gateway's saved receipt, not provider/device
history. If no durable acceptance or rejection can be established, leave the
ambiguous effect held and use the existing inbox; do not change operation keys
to bypass the hold. Retain ledger rows for at least as long as any original
outbox delivery/replay can exist; deleting a row would reopen its dispatch key.
Reconcile backup recovery against provider/outbox history before enabling sends.

### Selected deployment architecture: independent SQLite receipts

The 26 October implementation selects the separate Cloudflare Worker in
`services/push-provider/wrangler.ledger.jsonc` for deployment receipts. This
supersedes the PostgreSQL hosting/migration steps below for the selected runtime;
the PostgreSQL adapter and tests remain useful local reference evidence. Supabase
project `ltqfplqevxztlswlzexn` owns the application. A second schema or receipt
table in that same project would share its restore boundary and cannot provide
the required independent record of a provider dispatch.

The Node 24 gateway retains the actual APNs HTTP/2 and FCM adapters. Its
`RemoteDispatchLedger` uses pinned HTTPS with redirect denial and a 15-second
total request/response deadline. The separate Worker authenticates before
reading a body, selecting a namespace or touching storage. Both Worker and
Durable Object validate the private protocol. Requests are limited to 4 KiB,
responses to 8 KiB, and request-body reading to ten seconds. No raw device
token, notification title/entity, signing key, session or application record is
sent to this ledger. Reservation projects only the opaque operation key, exact
request SHA-256, platform and notification UUID; completion records a bounded
sanitized provider outcome. There are no provider network calls in the Worker.

The deployment is fixed to account `2209b915a85b1c11cee79b7806c6e73b`, class
`PushDispatchLedger`, EU jurisdiction and object name
`lovelies-push-dispatch-ledger-v1:ltqfplqevxztlswlzexn`. The object name does not
depend on a request, timestamp, operation key or configured ledger UUID. Keep
this namespace, migration identity and private route stable across application
restores and deploys. `workers_dev`, previews, application logs and tracing are
disabled in the reviewed configuration. A private authenticated HTTPS route and
actual EU placement still require hosted qualification.

Configure the gateway with `PUSH_LEDGER_URL` (HTTPS origin), independent
server-only `PUSH_LEDGER_TOKEN`, and immutable UUID `PUSH_LEDGER_ID`. Configure
the same token/UUID and fixed `SUPABASE_PROJECT_ID` on the Worker. Do not reuse
the backend-to-gateway `PUSH_SERVICE_SECRET` or restore-journal credential. The
mobile applications receive none of these credentials.

An ordinary request to an unbound or missing ledger fails closed with 503.
Initialization requires a distinct temporary `PUSH_LEDGER_BOOTSTRAP_TOKEN`,
which the Node gateway must never receive. Before using it, the operator must
verify the actual fresh namespace/provider binding, intended account, class,
EU selector and fixed object name against the deployment record. Perform the
one initial `POST /v1/bootstrap` with that credential and exactly
`{version:1, project_id, ledger_id, bootstrap_id}`; record the immutable ledger
and bootstrap UUIDs with custody evidence. This initializes real storage rather
than asserting release readiness. Only an exact retry of that binding is
accepted. Initialization refuses nonempty orphan storage; it cannot replace a
binding, clear quarantine or reopen an operation. Remove the temporary bootstrap
secret after verifying the saved control response and restart persistence.

Each operation has an immutable SQLite admission with unique operation and
provider-request IDs, plus immutable dispatch-intent evidence at dispatch start.
Admission/dispatch counts are checked against the binding; SQL evidence, KV
receipt/index and binding writes share one SQLite transaction. Immutable
triggers reject updates/deletes. Losing an older receipt/index pair, or restoring
its earlier prepared snapshot after dispatch, therefore fails closed instead of
manufacturing permission to send again.
Only expired `prepared` claims can be reclaimed; claim replacement fences the
old owner while retaining its provider-request ID. `startDispatch` persists
`dispatching` before acknowledging permission to send. A lost start reply means
the gateway sends nothing. A lost finish reply is reconciled with lookup;
`dispatching`, `ambiguous`, `accepted` and `rejected` are never reclaimed.

`POST /v1/quarantine`, using the private ledger credential and the bound protocol
envelope, accepts only `ledger_recovery_required` or
`storage_integrity_unconfirmed`. Quarantine is sticky: reservation and dispatch
start stop, while receipt lookup and completion of already dispatched work
remain possible. There is no clear, reset, reopen, delete, timed namespace or
alternate-key recovery API. Do not create a replacement namespace to bypass a
hold. Retain all operation evidence while any application outbox/replay could
refer to it.

Hashes and admission checks detect inconsistent partial state; they cannot
prove that an entire coherent Durable Object was never rolled back or lost.
A suspected independent-ledger loss, provider PITR action or coherent rollback
requires stopping gateway admission and operated reconciliation against external
deployment/custody/provider/outbox history before any recovery decision. A
matching control response from that same storage is not independent rollback
proof. No fresh per-operation state may be inferred from that incident.

Focused tests exercise the real gateway port, strict private transport,
authentication before namespace selection, immutable bootstrap/quarantine,
concurrent claims, stale-owner fencing, partial-loss holds, transaction faults,
lost acknowledgements and receipt restart. Local SQLite and generated workerd
fixtures do not prove hosted EU placement, key custody, actual provider delivery
or physical-device behavior. The coordinator records the completed runtime and
shared integration results; this architecture subsection makes no deployment or
store-release claim.

## Configuration and operation

Root owns workspace/lock integration. The selected Node gateway uses built-in
HTTP/2/crypto plus the private HTTPS ledger adapter. `postgres@3.4.7` and test-only
`@electric-sql/pglite@0.3.14` remain for the historical adapter qualification.
Pinned test/build dependencies are `esbuild@0.28.1`, `miniflare@4.20260714.0` and
`wrangler@4.112.0`. Run the package's `check` and `test` scripts from the frozen
workspace. Production uses `node services/push-provider/src/server.mjs`; the
selected runtime needs no PostgreSQL connection or migration. The separate
Worker configuration must first be deployed, privately routed and initialized
under the independent custody procedure above.

| Variable | Required purpose |
| --- | --- |
| `PUSH_LEDGER_URL` | Fixed private HTTPS origin of the independently hosted receipt Worker. |
| `PUSH_LEDGER_TOKEN` | Independent server-only ledger bearer credential; never the backend/gateway or restore-journal credential. |
| `PUSH_LEDGER_ID` | Immutable UUID matched to the independently initialized ledger binding. |
| `PUSH_SERVICE_SECRET` | Private 32–256 character, whitespace-free bearer secret shared only with the backend binding. |
| `PUSH_PROVIDER_SEND_ENABLED` | Defaults false; enable `true` only for separately authorized provider testing/deployment. |
| `APNS_ENVIRONMENT` | Explicit `sandbox` or `production`, matching the signed app entitlements/token environment. |
| `APNS_TOPIC` | Verified existing app bundle ID, expected `com.lovelies.memories` for the replacement. |
| `APNS_TEAM_ID`, `APNS_KEY_ID` | Verified Apple team/key identifiers; no guessed values. |
| `APNS_PRIVATE_KEY_FILE` | Protected `.p8` P-256 provider key file; sign ES256 JWTs cached for less than one hour. |
| `FCM_PROJECT_ID` | Verified existing Firebase project with FCM HTTP v1 API enabled. |
| `ANDROID_PACKAGE_NAME` | Verified existing application identity, expected `com.lovelies.memories`. |
| `FCM_SERVICE_ACCOUNT_FILE` | Protected service-account JSON for that project and FCM permissions. Its token URI must be Google's exact OAuth endpoint. |
| `HOST`, `PORT` | Default `127.0.0.1:8091`; expose only through private network/TLS infrastructure. |

OAuth service-account assertions use RS256, the FCM scope, a one-hour maximum
lifetime and a pinned Google token endpoint. Access tokens are cached with an
expiry margin and concurrent token refreshes coalesce. Provider keys, tokens,
raw provider error messages and private service credentials are not written to application logs.
No credentials are supplied by this implementation.

Startup validates the independent ledger's bound protocol/project/UUID and its
serving state before loading any provider key or opening a listener. Missing,
uninitialized, mismatched, unreachable or quarantined storage prevents startup.
Every subsequent reservation/dispatch also checks the binding; a startup result
is not lasting authorization. Quarantine permits saved-receipt lookup and
completion of already dispatched work while denying new dispatches.

## Evidence and remaining gates

Controlled tests cover JWT signatures/caching, pinned APNs HTTP/2 and FCM request
construction, provider acceptance/rejection/timeout/wrong-ID/redirect behavior,
internal authentication, canonical operation/payload conflicts, SQL transactional
claims, concurrent duplicates, preflight reclaim fencing, crash/receipt-write
ambiguity and HTTP adapter behavior. PGlite exercises PostgreSQL SQL semantics
locally. New tests additionally exercise the selected independent SQLite ledger
and real Worker runtime, including restart and partial-rollback holds. Hosted
namespace/route/EU placement and coherent rollback incident handling remain
separate operating gates.

Workspace logs are in
`verification/supabase-release-20261023/push-provider/`; the coordinator's final
integration result governs the submitted source. Remaining gates: reviewed
private Node hosting/TLS/network controls; independently hosted Worker route/EU
placement, immutable initialization/custody and operated recovery quarantine;
configured real Apple/Firebase credentials and app identities;
Supabase private-service binding; authorized controlled real-device sandbox and
production-token tests; APNs/FCM delivery/rotation/opt-out/logout/tap acceptance;
monitoring of held ambiguous operations; backup/restore and rollout approval.

Implementation references checked 23 October 2026:

- [Apple APNs token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
- [Apple APNs request headers and payload](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
- [Apple APNs response meanings](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).
- [Google FCM HTTP v1 authorization and send](https://firebase.google.com/docs/cloud-messaging/send/v1-api).
- [Google projects.messages.send REST contract](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send).
