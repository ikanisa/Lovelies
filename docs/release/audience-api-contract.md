# Audience API contract v2

Schema version: **16**. Canonical audience protocol: **`lovelies-audience-v2`**.
The selected audience policy remains **`audience-2026-10-24-v1`**. This implements
[the selected retention and young-user policy](retention-and-young-users.md).
[Audience review and recovery](audience-review-recovery.md) describes maintenance,
legacy evidence, cleanup custody and operator handoff.

## Decisions, provenance and deadlines

Clients may ask the user to select a transient age range. Before writing a new
journal or sending a new declaration, they derive exactly one decision tuple:

| Transient selection | `at_least_13` | `guardian_required` | Initial state |
| --- | --- | --- | --- |
| Under 13 | `false` | `false` | `blocked` |
| 13–17 | `true` | `true` | `guardian_pending` |
| 18+ | `true` | `false` | `eligible` |

`false,true` is invalid. The two flags carry the same three outcomes as the old
label; this is data-shape minimization, not anonymization or reduced inferability.
No birth date, exact age, document, guardian contact detail or face-age estimate
is collected. Self declaration is not verified identity or verified adulthood.

`GET /me/audience` requires the subject's current own durable session and returns:

```json
{
  "protocol": "lovelies-audience-v2",
  "policy_version": "audience-2026-10-24-v1",
  "account_id": "<account UUID>",
  "audience": {
    "at_least_13": true,
    "guardian_required": false,
    "status": "eligible",
    "version": 1,
    "policy_version": "audience-2026-10-24-v1",
    "source": "self_declaration",
    "rule_version": "audience-13-plus-guardian-v1",
    "territory": "global",
    "declared_at": "<ISO date>",
    "next_review_at": "<ISO date>",
    "review_required": false
  },
  "guardian_request": null,
  "capabilities": {
    "face_authentication": true,
    "photo_matching": true,
    "photo_processing": true
  },
  "authority_expires_at": "<ISO date>"
}
```

Known declarations always have finite `declared_at` and `next_review_at`, with a
positive interval no longer than 365 days. The server generates these dates,
`source`, `rule_version` and `territory`; public declarations cannot choose them.
Source is `self_declaration`, `independent_review`, or `legacy_declaration`.
Legacy provenance never means that a new review took place. The selected rule
uses the global 13+ product rule; it does not assert that every country permits
identical operation or satisfies a store/legal release assessment.

Unknown audience has version 0, status `unknown`, both flags and all six provenance/
policy/date values null, `review_required:false`, and false capabilities.
Status is `unknown|blocked|guardian_pending|eligible|suspended`. A due known
adult projects `suspended`; a minor without current guardian authority projects
`guardian_pending`. An under 13 declaration stays blocked. Expiry is effective at
`now >= next_review_at`, without waiting for maintenance.

`next_review_at` describes the declaration. `authority_expires_at` separately
bounds current audience capability: the earliest enabled purpose deadline,
including own annual review, the selected guardian's annual review and current
authentication-consent expiry, guardian request/approval expiry, and applicable
current own-consent expiry. It is null when every audience capability is false.
Clients must expire private presentation at this earlier deadline. Audience
capability permits the next eligible journey only: a separate current purpose
consent, registered-face session and exact media grant still govern actual use.

## Declaration and exact recovery

`PUT /me/audience` accepts only:

```json
{
  "at_least_13": true,
  "guardian_required": false,
  "policy_version": "audience-2026-10-24-v1",
  "expected_version": 0,
  "operation_key": "<original stable operation key>"
}
```

The first declaration expects version 0. A new declaration increments one version.
A previously under 13 or minor account cannot self-escalate to a different decision;
a reviewed adult transition uses the independent administrator route. Replacing a
known decision retires its old authority, consents and grants; it never grants a
new biometric purpose implicitly. The response is the current full v2 projection.

Operation keys are 16–128 characters in `[A-Za-z0-9._:-]`; lifecycle control and
signed-request nonces use UUIDs. Clients durably save an operation's exact business
body before its first request. Unknown transport/commit outcomes require the same
key and body. A changed body conflicts. Receipt responses are historical outcomes;
current projections are freshly read and must not be inferred from the receipt.

A pre-v2 `age_band` body is accepted **only** for an existing original
`audience.declare` receipt with matching actor/key/action/hash/exact payload. It
never creates a new legacy declaration. A missing key returns 409
`audience_upgrade_required`; the client retains its uncertain original journal.
A proven restrictive restore returns `operation_recovered_without_result`, never
false absence or permission to choose a new key. A positively retired original
receipt returns 410; its original action/hash/key remain. Successful exact legacy
recovery returns the current v2 projection, not a v1 projection.

## Explicit adult annual renewal

`POST /me/audience/renew` accepts the same flags/policy/version/key for a known,
due, unchanged adult decision, plus a distinct affirmative purpose consent:

```json
{
  "purpose": "face_authentication",
  "policy_version": "<current face policy>",
  "granted": true
}
```

The object above is the `consent` field. It must come from a separate unchecked
control; age selection does not imply consent. Own restricted sessions may use
this route. No response issues credentials or starts a camera/challenge.

The full v2 response adds:

```json
{
  "renewal": {
    "operation_key": "<original key>",
    "from_version": 1,
    "to_version": 2,
    "next_step": "face_login"
  }
}
```

`next_step` is `face_login` only when this explicit new consent can bind the exact
reference still legally retained in its original recovery window. Otherwise it is
`profile_recovery`. The old authentication consent, matching/processing consents,
old grants and prior guardian approvals stay retired. A new face login or the
existing explicit profile lifecycle is required. The old registered bearer does
not regain product authority from the new audience projection.

A unique, still-live anonymous enrollment may instead bind one fresh consent to
its unchanged original device/intent/epoch. Its original cancelled challenge is
not reactivated or rewritten. Existing signed enrollment status/resume, using the
original enrollment/resume keys, creates fresh captures. The receipt remains
`profile_recovery`; clients retain the original enrollment journal and account.
This metadata transition expires with the original enrollment control, and does
not extend capture retention or reuse an old image.

Exact committed receipt recovery accepts the original well-formed consent policy
after a policy rotation. Current-policy validation applies before a **new** grant.
The current projection remains restricted when current policy/reference authority
is absent. An unknown old-policy request cannot grant consent or extend a control.

## Signed own-device audience status and review

A logged-out registered identity can use its exact existing active device key and
saved face handle. These routes require no product bearer:

| Route | Signed step | Additional immutable business fields |
| --- | --- | --- |
| `POST /auth/face/audience/status` | `status` | None |
| `POST /auth/face/audience/renew` | `renew` | Adult flags, policy, expected version, key, separate consent |
| `POST /auth/face/audience/guardian-review` | `guardian-review` | Minor flags, policy, expected version, key; no purpose consent |

Every request includes `account_id`, `device_id`, `face_handle`, UUID
`request_nonce`, integer millisecond `request_expires_at` in the next 60 seconds,
and `device_signature`. Sign canonical stable JSON:

```text
{protocol:"lovelies-audience-device-v1",step,...all request fields except device_signature}
```

Retries retain the business key/body and sign a fresh nonce/deadline. The server
rechecks exact account/device/handle/key revisions, enabled registered identity,
request deadline, deletion state and restoration admission. Status remains
available after reference cleanup, but revoked/mismatched devices remain denied.
A signature is only an own-device binding; it is not a face match or civil identity.

The response contains exactly the following current fields, plus an optional
historical `renewal` receipt:

```text
{protocol:"lovelies-audience-device-v1",account_id,device_id,request_nonce,
 audience:<v2 audience object>,authority_expires_at,
 renewal_available,guardian_review_available,next_step,guardian_request,renewal?}
```

`guardian_request` is always present: null or only
`{id,state,revision,policy_version,expires_at}`. No guardian identity or evidence
is exposed. There are no product-capability booleans, credentials or challenges.

`renewal_available` specifically means explicit unchanged-adult annual renewal is
available. Such a due adult has current `next_step:"audience_review"` and null
`authority_expires_at`. `guardian_review_available` is separately true when a
known minor may explicitly renew their declaration/request: own annual expiry,
or an expired/inactive guardian episode before that date. A still-valid approval
or live pending request cannot be replaced through this route. The current steps
are `audience_review|guardian_review|face_login|profile_recovery`.

Minor review creates a new declaration version and fresh seven-day pending
request atomically, retires old episodes and returns a receipt whose `next_step`
is `guardian_review` and whose `guardian_request_id` names that new request. An
exact retry returns the same request and version. There is no child purpose
consent or product grant. A distinct guardian and fresh independent reviewer must
approve again, followed by the child's separate consent and fresh face lifecycle.
No minor route changes the decision to adult.

## Existing guardian and independent-review routes

`POST /me/guardian-requests` accepts `{expected_version,policy_version,
operation_key}` for a current own minor declaration. Returns HTTP 201
`{guardian_request,audience:<full v2 projection>}`. A due declaration requires
explicit declaration/review renewal first. No SMS/email invitation is sent.

The own-session public request projection is `{id,child_account_id,state,revision,
policy_version,created_at,expires_at,purposes:{face_authentication,photo_matching,
photo_processing}}`. States are ` pending|under_review|approved|rejected|withdrawn|
expired `. Purpose booleans are currently effective approvals. ` GET
/me/guardian-requests/:id ` returns `{guardian_request}` only to the child or bound
guardian; foreign callers receive 404. No guardian/reviewer identity or evidence
reference appears in the child's projection.

`POST /guardian-requests/:id/claim` accepts `{expected_revision,policy_version,
relationship_attested:true,purposes:[...],operation_key}`. Purposes are a nonempty,
unique subset of the three supported values. It requires a separate current
registered-face adult account. The state becomes `under_review`; no capability or
child consent activates. A bound guardian cannot silently be replaced.

`GET /admin/guardian-requests` is the paginated independent-review queue, with the
existing status/query/sort/cursor contract. The administrator needs an actual
completed face login tied to their exact current session within five minutes;
refresh does not manufacture fresh review. Operator rows add guardian account,
reviewed date, requested purposes and `evidence_recorded`, without returning an
evidence reference or raw document.

`POST /admin/guardian-requests/:id/review` accepts `{expected_revision,
policy_version,decision:"approve"|"reject",evidence_method:
"independent_live_review"|"independent_document_review",evidence_reference,
adult_verified:true,parental_responsibility_verified:true,operation_key}`.
The opaque evidence reference is 16–128 characters in `[A-Za-z0-9._:-]`, not a URL
or document content. Approval needs both verification judgments, a separate fresh
administrator, current adult guardian authority and unchanged child declaration.
The reviewer differs from child and guardian. Approval lasts at most 365 days;
its expiry does not rewrite the child's declaration metadata. False judgments
cannot approve. Reviewer training and actual independent evidence remain operated
release requirements.

`POST /guardian-requests/:id/withdraw` accepts `{expected_revision,operation_key}`
under own restricted child/guardian session authority. It immediately excludes
old processing, cancels biometric work, retires proposals/grants/tickets and
purpose consents, and schedules exact cleanup. Later approval cannot restore old
consents or media access.

`POST /admin/audience/:account_id/adult-review` accepts `{expected_version,
policy_version,evidence_method,evidence_reference,adult_verified:true,
operation_key}`. A fresh independent adult administrator reviews the transition;
self review is forbidden. The new v2 source is `independent_review`. It grants no
purpose consent or face/media authority. `GET /admin/users/:account_id` includes
the full v2 audience projection; reviewers use its actual version.

## Challenge, client and error boundaries

All usable registration/login/recovery/replacement/resume/lifecycle challenges
carry `audience_authority:{protocol:"lovelies-audience-challenge-v1",account_id,
challenge_id,device_id,purpose,policy_version,audience_version,expires_at}`.
Persisted challenge expiry and its outer response expiry are bounded by the
current audience/guardian/consent deadline and, when relevant, the original 24h
reference recovery window. The nested expiry cannot exceed that deadline.
Current checks run again during capture, provider work and final publication.

Clients validate exact account/device/challenge/purpose binding, positive current
version and future expiry. No challenge authority implies adulthood, another
purpose, media access or a general session. No error auto-declares adulthood,
auto-consents, opens a camera/picker, or creates a replacement anonymous account.
Unknown legacy identities remain restricted and preserve their original journals.

Expected errors include missing/current-policy audience 403 `audience_required`,
under 13 `age_not_supported`, minor `guardian_approval_required`, adult
`audience_restricted`, version/conflict 409, forbidden self-escalation 409
`audience_age_review_required`, policy 409 `audience_policy_changed`, separate
consent 400 `explicit_auth_consent_required`, unchanged-proof 404
`audience_device_unavailable`, expired proof 401 `audience_request_expired`, and
`guardian_review_pending`/`guardian_review_not_due` 409. Receipt retirement 410,
`operation_recovered_without_result` 409, and
`audience_operation_outcome_unresolved` 503 retain their exact recovery meaning;
clients keep uncertain immutable journals.

Restricted own privacy/export/deletion/logout/security controls remain available
under their existing authorization. `GET /privacy/operations/:operation_key`
returns only the original own privacy request receipt or its truthful absence;
it does not expose product/share results. Anti-abuse accounting remains active
on signed HTTP routes even when the domain status operation is read-only.
