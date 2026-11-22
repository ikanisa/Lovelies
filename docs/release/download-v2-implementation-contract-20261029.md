# Download v2 implementation contract

Status: implementation target, 29 October 2026. This file specifies the coordinated
local task12 work; it is not implementation, deployment or acceptance evidence.
The existing product, approval, consent and production store-entitlement boundaries
remain authoritative. No new service or provider work is authorized by this file.

At the 22 November 2026 source checkpoint, the API and both native clients use
the sign, status and content routes. The close route remains unimplemented. If
a signing request never reaches the server, the original Save or Share action
can remain pending after a retry.

## Fixed app interface

Use authenticated, query-free POST routes `/downloads/v2/sign`,
`/downloads/v2/status`, `/downloads/v2/close` and `/downloads/v2/content`. Every request has these exact
JSON keys:

```json
{"protocol":"lovelies-download-input-v2","operation_key":"stable-client-key","original_session_id":"canonical-uuid-jti","asset_id":"canonical-uuid","source_version":"original-source-version"}
```

The protected client journal creates a cryptographically random32-byte capability
and persists it with this original context BEFORE dispatch. Send it ONLY as
`X-Lovelies-Download-Capability: lvd_v2_<canonical-unpadded-base64url32bytes>`.
Define capability_sha256 as SHA256 of the UTF8 full header value. Never put it in
a URL or response. The original JWT jti is local context, never client authority;
the server checks its binding against authenticated sessions.

The canonical input hash binds protocol, authenticated account_id, all five
identity/context fields above and capability_sha256. Use existing canonical JSON.
The independent operation ID is
`restoreOperationID(account_id,"media.download.sign.v2",operation_key)` and its
one ticket allocation is `restoreAllocationID(operation_id,"id_0")`.

Sign/status success is HTTP200, with these exact identity fields and no ticket,
URL, capability or capability hash:

```json
{"protocol":"lovelies-download-operation-v2","status":"recorded","account_id":"uuid","operation_key":"stable-client-key","original_session_id":"uuid","asset_id":"uuid","source_version":"version","created_at":0,"expires_at":120000}
```

created_at/expires_at are safe integer UTC milliseconds, immutable on replay;
ticket life remains at most120seconds and is capped by existing session/store/
media authority deadlines. A terminal `not_issued` result has the same protocol,
status and five identity fields but OMITS both dates. Unknown/inconsistent states
return503 `download_operation_outcome_unresolved`; never classify them as absence.
Malformed context/capability is rejected without mutating another operation.

`close` actively bars issuance of the exact original operation. It returns the
same immutable recorded/not_issued envelope; it is not an absence lookup or an
external-save cancellation. Current own-account privacy identity may invoke it
even after original-session, source or entitlement drift. It never grants bytes.
The client persists a closing phase before dispatch and retains the original
context/capability through interruption or a renewed session.

`recorded` proves committed issuance only. It does not prove content delivery,
viewing or saving. A historical status read uses current own-account privacy
identity and exact original context/capability; a renewed session may inspect it
but cannot redeem the original session's content capability. Content/sign still
require all applicable registered-face/audience/guardian/media/store authority.

Content returns the actual bytes only after full authorization/integrity checks,
with truthful Content-Type/Length and `X-Lovelies-Source-Version` plus
`X-Lovelies-Content-SHA256` (lowercase hex). Clients verify both and the20MiB
existing media bound before accepting protected local staging. CORS must allow
the capability header and expose the two integrity headers. No secret is echoed.
Recheck current source/version/checksum, original session/profile/device, consent,
blocks, approval, entitlement and deadlines around Storage and final release.
Content is safely repeatable under that exact original intent/capability/current
original session before immutable expiry. Its server-side access record remains
idempotent; each read repeats the full authority/integrity checks. Clients may
use the same content request to revalidate staged bytes immediately before a
new external effect, requiring the identical source/hash. This never extends a
deadline or turns an ambiguous external save into permission to repeat it.
Retries retain the exact original ticket/intent; no fresh signing on lost replies.

## Independent issuance and no-issuance settlement

Extend the existing journal/control, not a sidecar. Typed reservations bind the
canonical descriptor/hash, one immutable ticket allocation, original lineage and
expected/next marker. They have NO restriction events, external effects or
content steps. SQL ticket/evidence MACs bind every immutable authority, lineage,
context, source, allocated ticket and deadline field. Status verifies BOTH exact
MAC/SQL evidence and exact independent committed plan/disposition within admitted
lineage. No retroactive v2 authentication/backfill of legacy ticket rows.

No redeemable ticket or content response is released before SQL COMMIT AND the
independent committed acknowledgement. Add an explicit terminal `issued` versus
`not_issued` disposition, bound in BOTH PG control/evidence and journal. Ordinary
acknowledgement must reject typed download plans rather than infer issuance from
a successor marker. The backend owner chooses the precise internal fields/API,
documents them and tests their binding; app wire fields above are fixed.

A narrow system reconciler runs before normal/read-only admission, serialized on
the existing PostgreSQL advisory lock. It can settle ONLY this new typed issuance:

- Pending plan, exact expected marker, same lineage, no ticket/operation/evidence/
  conflicting tombstone: atomically record `not_issued` and reserved successor
  marker/disposition, then independently acknowledge that exact disposition.
- Exact successor with verified issued rows: independently acknowledge `issued`.
- Exact successor with verified no-issuance tombstone: acknowledge `not_issued`.
- Independently committed plan with a restored predecessor, unrelated/legacy plan,
  unexpected marker, mixed evidence, corruption or uncertainty: hold/quarantine.

It NEVER reconstructs a missing ticket, reruns signing or aborts a restriction,
external effect, content operation or generic legacy plan. Acquiring the same PG
lock and checking the expected marker ensures the original transaction cannot
later commit. Interrupted no-issuance SQL commit/ack is itself reconciled from
its exact independently bound disposition. No generic abort flag/manual restore
clearance is introduced. Retention/erasure resolve the pending typed reservation
before ordinary admission; preserve minimal authenticated disposition within the
existing retention policy without permanent foreign-key deletion holds.

For a never-delivered request or a rejection before independent preparation,
status remains unresolved. `close` acquires the same PostgreSQL lock, verifies
current independent admission and the exact namespace, and either returns an
already committed exact disposition or actively reserves a new download-only
closure plan in the independent journal. The closure variant binds the original
operation ID/input/context/capability/ticket allocation and its presealed
not_issued proof; it has NO issued alternative, restriction events or effects.
SQL atomically records that not_issued proof and reserved successor, and typed
independent settlement must complete before a terminal response. A delayed sign
cannot issue across this original-operation barrier. Unknown, conflicting,
legacy, mixed-source or restored history remains unresolved/quarantined.
Interrupted closure preparation/commit/settlement is recovered by the same
narrow typed reconciler. Retrying this exact closure cannot issue a ticket.

Use a NEW additive migration after v14. Preserve prior rows, migrations and
history. Locally qualify v13→v14→v15 and old binary/schema/ack rejection. Fence v1
sign/content ingress and generic operation lookup for download results, including
mixed-source keys. Actual deployed old writers/credentials/in-flight drainage,
backup/custody and log redaction remain separately verified hosted cutover gates.

## Native delivery and external-effect ownership

Both native implementations use a dedicated protected journal, not generic
mutation-result lookup. Persist original intent before sign, phase before content
attempt, hash-verified protected staging, and external save/share started/completed
state. Never equate issuance/status with download or saved success. Reconcile sign
before any retry. A not_issued disposition permits only a NEW EXPLICIT user action
with a new key/capability; it does not silently replay the old operation.
After unknown or rejected signing, and after restart in the signing phase, use
status and then this exact closure when unresolved; never re-sign an uncertain
request. Preserve a definitive original precondition error only after closure
has a verified terminal result, so a missing entitlement can open the existing
purchase flow without losing the original operation. An unresolved closure
stays unknown. A verified not_issued result requires a new explicit Save/Share
action; purchase completion cannot automatically replace it with a new key.
An intent still in its durable prepared/intent phase may make its first sign
dispatch after persisting signing. Content/staged/external phases never close
and replace an existing ambiguous external effect.
Persist external-start before the first mutating provider call, including file
creation/opening that could truncate a destination. Recheck authority after
provider/stream preparation and immediately before the byte/Photos write. Preserve
exact-owned cleanup and uncertain partial outcomes; do not delete unknown files.

Preserve uncertain content/save outcomes through process death/account change.
Gate presentation and every effect by the original current account/session and
media authority. Do not automatically repeat an ambiguous Photos/Files/share
side effect. Use existing encrypted/protected private file primitives, cleanup,
expiry and existing UI feedback/actions; add no new screens or commercial flow.
Retire temporary bytes through existing privacy/account rules while retaining
minimal unresolved metadata. Durable legacy generic download adoption must finish
before its generic slot is released; legacy histories remain unknown and cannot
gain v2 proof. Do not delete unknown installed/test data to pass recovery.
Purchase completion preserves the original action/context. It may resume only
the same safe intent through typed status and fresh authority, never issue a
fresh key after not_issued or repeat an ambiguous external effect automatically.

## Ownership and required proof

Backend/journal owner: recovery_scope — API, journal, SQL/schema/migration,
retention/erasure integration, backend tests and necessary backend caller fixtures.
iOS owner: notifications_review — iOS wire/repository/protected staging and actual
save/share callers plus affected Swift tests. Android owner: retention_review —
corresponding Kotlin repository/journals/staging/controllers and affected tests.
Root owns shared interface changes, docs, integration, shared builds and service
processes. No worker starts servers/builds/provider calls. Backend shared sources
remain frozen until root releases the current complementary test run; new
unreferenced implementation modules may be prepared meanwhile.

Acceptance includes every input binding substitution; exact-key concurrency;
SQL-commit/lost-ack; accepted prepare/acknowledged rollback; racing original commit
and system reconciliation; interrupted not-issued commit/ack; independently
committed same-schema rollback quarantine; expiry/current authority changes;
renewed-session status versus original-session content; wrong/rotated MAC key;
erasure/retention; both clients' lost replies/process death/staging failures/
legacy adoption/account changes; interrupted external save; v1 and generic lookup
rejection. Use native PG lock/transaction evidence and actual journal handlers;
synthetic media/native fixtures remain distinct from real providers/devices/store.
