# Complete push attempt plans, generation fencing and recovery

The selected Node gateway and production Supabase API use **v2**. This is a code
and local verification handoff; it does not deploy either service, install
credentials, certify a hosted namespace, or prove delivery on a phone. The
app-facing push registration and push-operation receipt API remain unchanged.

## Required configuration and rollout

The API and gateway must pin the same `PUSH_LEDGER_ID`,
`PUSH_LEDGER_BOOTSTRAP_ID`, and `PUSH_PROVIDER_GENERATION`. The API additionally
needs its private `PUSH_SERVICE_URL`/`PUSH_SERVICE_SECRET` binding. The gateway
needs the independently hosted `PUSH_LEDGER_URL`/`PUSH_LEDGER_TOKEN`, private
provider files, and verified APNs/FCM app identities. **Missing pins, an
uninitialized independent store, or unavailable credentials are deployment
blockers.** The examples deliberately supply no fabricated pin or secret.

The independent Worker retains its existing fixed EU namespace, class and object
name. Do not change its identity to escape a hold. A separately authorized
operator first initializes the existing v1 binding with the distinct temporary
bootstrap credential and verifies its custody. Next, `POST /v2/bootstrap` accepts:

```json
{
  "version": 2,
  "project_id": "ltqfplqevxztlswlzexn",
  "ledger_id": "<verified immutable ledger UUID>",
  "bootstrap_id": "<recorded v2 bootstrap UUID>",
  "provider_generation": "<SHA-256 of actual configured provider identity>"
}
```

V2 initialization succeeds only when the original v1 store is serving, contains
zero admitted operations and zero dispatch intents, has no orphan KV rows, and
has no v2 SQL evidence. It is atomic with its immutable generation row. Exact
binding retries are idempotent. Nonempty v1 stores remain held for explicit
independent reconciliation; there is no invented generation assignment or
complete-plan backfill. A missing v2 binding with surviving SQL tables cannot be
initialized again. V2 permanently blocks v1 reservation, start and quarantine
writes, including when the v2 KV binding is lost. Legacy receipt lookup remains
available, but cannot authorize v2 dispatch.

`node src/provider-generation.mjs` reads the same protected provider files and
configuration as server startup and prints only the derived generation and
enabled platform names. It performs no provider or ledger network request.
Set `PUSH_PROVIDER_SEND_ENABLED` and the actual intended configuration before
running it. An empty, send-disabled configuration has a different generation
from an enabled one and cannot be reused to enable sends later.

Startup verifies both independent bindings before reading provider keys, then
compares the generation derived from those keys and config with the active
independent generation and optional gateway environment pin. The API pin is
mandatory in production. Schema v15 adds the local plan and recovered-receipt
tables. Coordinate the matching API/schema/model/gateway cutover and validate
staging; this package does not run that cutover. An older API's exact schema gate
must not be bypassed by rewriting a version marker or discarding history.

## Complete immutable plan

`POST /notifications/plan` accepts a complete plan before any message dispatch:

```js
{
  protocol: 'lovelies-push-attempt-plan-v2',
  ledger_id, ledger_bootstrap_id,
  notification_id, subject_sha256, provider_generation,
  attempts: [
    { operation_key, device_id, platform, token_sha256, request_sha256 }
  ]
}
```

The subject is SHA-256 of UTF-8 `lovelies-push-subject-v2:<account UUID>`.
An operation key is `notification:<notification UUID>:<original device UUID>`.
Entries are unique and sorted by operation key. The complete set contains zero
to ten entries, matching the existing registration limit. More than ten active
devices causes a hold; there is no arbitrary prefix selection. Empty plans can
be retired and settled as inbox-only. Notification content and raw tokens never
enter the independent ledger.

`plan_sha256` is SHA-256 of recursively key-sorted canonical JSON of the entire
plan. The ledger seals the plan, every ordinal/entry hash and a unique provider
request UUID for each entry in one transaction. The API stores the same immutable
plan locally. The ledger refuses a different plan under the same notification
ID. A new or rotated device cannot be appended to an already admitted plan.

The request digest is SHA-256 of UTF-8 `JSON.stringify` of the following parsed
object in this exact property order:

```js
{
  protocol: 'lovelies-push-request-v2',
  subject_sha256,
  provider_generation,
  operation_key,
  platform,
  token,
  notification: { id, title, kind, entity_id }
}
```

The gateway validates the current fixed notification templates and recreates
that ordering. JSON whitespace or input property order cannot change it; token,
notification, account binding and provider-generation changes do. `POST /send`
accepts exactly `{protocol:'lovelies-push-send-v2', plan_sha256, dispatch}`.
Every send must match a sealed plan entry and its token/request hashes.

## Provider generation

The generation is SHA-256 of canonical provider identity JSON under
`lovelies-push-provider-generation-v1`, including the v2 dispatch protocol,
configured platforms and their exact routing/configuration:

- APNs origin/environment, topic, team ID, key ID, SHA-256 of the public key's
  DER SPKI, alert title/sound, push type, priority and expiration policy.
- FCM project, package restriction, service-account identity and project,
  public-key DER SPKI SHA-256, Android priority and TTL policy.

The digest includes no private key, OAuth token or device token. Provider
configuration is checked before preflight, after preflight and before message
bytes. A configuration change cannot silently adopt a previously admitted plan.
If the final check changes after independent start but before bytes, the gateway
records a definitive local rejection; otherwise uncertain started work stays
unresolved. Readiness fails when the local and active generations differ.

To retire a generation, `POST /v2/fence` uses the private ledger credential and
the version/project/ledger envelope with reason `provider_generation_retirement`.
The fence stops new admission/start, while historical lookup and completion
continue. `POST /v2/generations/activate` requires the distinct temporary operator
credential and the exact previous/new generation. It succeeds only while fenced
and when **every independent started intent has an immutable accepted/rejected
outcome**. The old generation is permanently retired; its unstarted plans become
cancelled. Previously used generations cannot be reactivated. Unknown outcomes
cannot be cleared by elapsed time, an activation retry or a new operation key.

## Receipts and bounded recovery

An operator can start a credential-free recovery listener with the explicit
`PUSH_RECOVERY_ONLY=true` setting. It still requires the exact independent ledger
and bootstrap pins. It may start while that store is fenced, reads no provider
key, rejects plan admission and every `/send`, and reports readiness503. Complete
roster/receipt lookup and permanent subject/plan retirement remain available.
This mode supports recovery after credential retirement or process restart; it
does not activate a generation or turn missing configuration into normal service.
Unset/false retains the normal strict startup rules.

`GET /notifications/<UUID>` returns the full plan and exactly one validated
receipt per entry. The envelope pins protocol
`lovelies-push-attempt-roster-v2`, project, ledger UUID and v2 bootstrap UUID.
`GET /notifications/page/<0-or-last-UUID>` inventories all independent plans
using stable keyset pages of at most25 and an explicit next cursor. A page does
not certify the absence of later plans. Each full-plan lookup remains at most10
entries. Independent request/reply limits are16KiB/32KiB; the private gateway's
plan request limit is16KiB and dispatch limit8KiB.

Every v2 receipt contains protocol `lovelies-push-dispatch-receipt-v2`, operation
and notification identity, plan/request/token hashes, provider generation,
original provider request UUID and status:

| Status | Meaning |
| --- | --- |
| `unstarted` | The independently admitted entry has no dispatch intent or active claim. An identical request can proceed after fresh current authority/device/configuration checks. |
| `preparing` | A bounded preflight claim exists. Its claim token fences stale owners; no message was admitted by this claim yet. |
| `dispatching` | Independent dispatch intent committed before provider bytes; never resend. |
| `ambiguous` | A started intent has no verified terminal result; never resend. |
| `accepted` | Immutable provider acceptance with a bounded provider message ID. This does not prove delivery/viewing. |
| `rejected` | Immutable definitive rejection with sanitized diagnostics. `retryable` is diagnostic, not resend authority. |
| `cancelled` | A permanent plan/subject/generation retirement fenced an entry before any dispatch intent. |

Accepted/rejected receipts also include `provider_message_id`, `provider_code`,
`retryable` and `token_invalid`. Unknown/missing/malformed legacy histories do not
become a v2 unstarted entry. A readable bound absence permits creation only of a
new complete plan when no local attempted history contradicts it. Missing
independent history after a saved receipt remains held.

The API reads the whole independent roster first. It can reconstruct its local
plan and outcomes even when a restored snapshot lost all device/delivery rows.
Recovered outcomes have no device foreign key and need no retained raw token.
Lookup-only recovery never re-registers a token or sends to a substituted device.
The bounded active pass isolates expected provider uncertainty, so one unknown
device does not block another independently bound entry. Database, restore or
unexpected internal failures still stop execution. A final complete refresh
records late acceptance after opt-out, token removal or account epoch changes.
The job settles only when its plan is permanently retired and all entries have
terminal dispositions. An accepted outcome cannot be overwritten by a stale GET.

Lost reserve/start/finish acknowledgements never trigger a blind resend. Only a
subsequent independently proved unstarted disposition can allow preflight again.
Claims expire after 30 seconds; dispatch intents do not. Immutable PostgreSQL histories
and checked KV counters share the same transaction; inconsistent partial loss
fails closed. Missing pins, wrong bootstrap, altered hashes and old protocols
also fail closed.

## Account deletion and evidence retention

Production deletion requires `retirePushSubject(ctx, subjectAccountID)` after a
current approved deletion execution lease is committed and rechecked, outside
the metadata transaction. The independent subject retirement is permanent. It
prevents every future plan/start for that subject, including attempts missing
from a restored application database. Its SQL aggregate covers **all** independent
subject plans and started outcomes, not only the first inventory page.

The helper reconciles at most 25 locally unresolved notifications per pass,
marking examination durably before lookups so failures do not starve later work.
It returns a proof only when every started intent is settled. The proof is a
frozen, process-local capability issued by the validated helper, bound to the
database object and subject. A JSON copy, supplied object, wrong subject,
changed ledger/bootstrap pins or missing proof is rejected. If execution restarts,
repeat the idempotent independent retirement and obtain a new proof.

`beginAccountErasure` revalidates its deletion authority/holds and passes this
proof into `eraseNotificationSubject(ctx, subject, proof)`. The latter also refuses
to discard any locally unresolved v2 or attempted legacy evidence. Production
cannot infer an empty independent history from empty SQL. No-provider/no-pin
compatibility is limited to explicit local `APP_ENV=test` fixtures containing no
v2 rows. Own notification plans and recovered receipt metadata are included in
privacy export; raw tokens are excluded.

The returned proof deliberately says `provider_erasure_verified:false`.
Dispatch quiescence is **not** an APNs/FCM erasure receipt. Immutable independent
hashes, operation IDs and sanitized outcomes remain retained while replay or
unresolved history can refer to them. This code supplies no provider erasure
receipt and no unreviewed independent-history deletion/reset endpoint.

## Operator repair and limits of local evidence

The protected queue-repair flow may re-admit an exact terminal queue entry only
when a fresh complete independent plan is nonempty/current and every entry is
unstarted. It rechecks current account authority, active original devices,
original token/request hashes, unchanged local plan and pristine local history.
The preview fingerprint excludes unrelated global ledger counters. Planless,
retired, preparing, attempted or uncertain work remains blocked; the same-key
worker and gateway still recheck before every start. Repair does not mint a
notification, new plan or provider outcome.

Local tests cover PostgreSQL custody roles/atomicity, legacy SQLite/HTTP adapter
compatibility, generation identity,
complete inventory, lost acknowledgements, duplicate callers, missing local
SQL/devices, opt-out races and deletion proof enforcement. Real APNs/FCM
credentials and delivery, actual independent local Supabase custody and placement,
coordinated rollout, coherent whole-ledger rollback incident handling,
and physical-device release acceptance remain external qualification gates.
An entire coherently rolled-back independent store is not proven intact by its
own hashes; stop admission and reconcile custody/provider history on such an
incident. This code does not claim exactly-once device delivery.
