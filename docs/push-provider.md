# Lovelies private push provider

Implemented 23 October 2026 in `services/push-provider/`. This Node 24 service is
an authenticated provider adapter for the Supabase API notification outbox. It
uses real APNs HTTP/2 and FCM HTTP v1 protocols, with a separate durable PostgreSQL
receipt ledger. It is not deployed and no Apple/Google notification was sent.
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

The additive reviewed migration is
`services/push-provider/migrations/202610230001_push_dispatches.sql`. It creates
only private `push_provider.dispatches`, with no photo/customer import or delete.
The table stores operation/request hashes, platform, notification UUID, provider
request UUID, state and receipts. It does not store raw device tokens, message
content, bearer credentials or signing keys.

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

## Configuration and operation

Root owns workspace/lock integration. Package dependencies are `postgres@3.4.7`
and test-only `@electric-sql/pglite@0.3.14`. After the coordinator installs the
frozen workspace, run the package's `check` and `test` scripts. Production uses
`node services/push-provider/src/server.mjs`; migration is an explicit separate
`node services/push-provider/src/migrate.mjs` action with a reviewed database URL.
Do not run it against an unknown database or deploy it without authorization.

| Variable | Required purpose |
| --- | --- |
| `PUSH_DATABASE_URL` | Private PostgreSQL connection using verified TLS; dedicated gateway database identity. |
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
raw provider error messages and database URLs are not written to application logs.
No credentials are supplied by this implementation.

The migration enables RLS and revokes PUBLIC access. Keep this schema outside
Supabase's exposed API schemas and explicitly remove any inherited/default
anon/authenticated grants during role provisioning. The runtime role must be
the owner of this dedicated table (with schema USAGE), or have a reviewed,
role-specific policy plus SELECT/INSERT/UPDATE permissions. Ordinary grants
without an RLS policy are insufficient. Do not grant global BYPASSRLS merely for
this service. The gateway role needs no access to customer/application tables.
The reviewed migration, role provisioning and runtime check remain external gates.

## Evidence and remaining gates

Controlled tests cover JWT signatures/caching, pinned APNs HTTP/2 and FCM request
construction, provider acceptance/rejection/timeout/wrong-ID/redirect behavior,
internal authentication, canonical operation/payload conflicts, SQL transactional
claims, concurrent duplicates, preflight reclaim fencing, crash/receipt-write
ambiguity and HTTP adapter behavior. PGlite exercises PostgreSQL SQL semantics
locally; hosted connection/role/restart/multi-process/database failover acceptance
must still run against the selected deployed database.

Workspace logs are in
`verification/supabase-release-20261023/push-provider/`; the coordinator's final
integration result governs the submitted source. Remaining gates: reviewed
private hosting/TLS/network controls; applied private-schema migration and least
privilege role; configured real Apple/Firebase credentials and app identities;
Supabase private-service binding; authorized controlled real-device sandbox and
production-token tests; APNs/FCM delivery/rotation/opt-out/logout/tap acceptance;
monitoring of held ambiguous operations; backup/restore and rollout approval.

Implementation references checked 23 October 2026:

- [Apple APNs token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
- [Apple APNs request headers and payload](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
- [Apple APNs response meanings](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).
- [Google FCM HTTP v1 authorization and send](https://firebase.google.com/docs/cloud-messaging/send/v1-api).
- [Google projects.messages.send REST contract](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send).
