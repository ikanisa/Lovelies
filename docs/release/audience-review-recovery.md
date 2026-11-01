# Annual audience review, cleanup and recovery

This is the schema 16 source contract for the selected 13+ audience policy. It
complements [the v2 API contract](audience-api-contract.md),
[retention and young users](retention-and-young-users.md), and the existing
[operator browser recovery runbook](../operator-browser-recovery.md). Local
fixtures establish these code paths; they do not establish hosted deployment,
biometric-model quality, civil identity, store acceptance or an operated review
service.

## What changes at expiry

Each known declaration has a finite review date no later than 365 days after its
recorded declaration. Legacy rows without a date use the earlier of their stored
date and declaration+365 days; a migration never creates a fresh declaration.
Access guards enforce expiry immediately. A guardian's own annual deadline,
authentication consent and approval/request deadlines also stop their dependent
child's affected use immediately. The full projection's `authority_expires_at`
lets native caches and operator presentation expire at the earliest known bound.

Maintenance records the denial and cancels stale challenges, lifecycle work,
processing/candidate/publication work, grants and tickets. Old authentication,
matching and processing consents are revoked. The expired adult's dependent
approved guardian episodes are retired. A subsequent explicit renewal increments
the declaration version, so old approvals cannot regain authority.

The annual maintenance queue uses a durable compare-and-swap cursor over
`declared_at,account_id`, with at most 25 selected accounts per pass. Deterministic
unchanged malformed rows can be reported and advanced past; unknown SQL, journal,
commit or concurrent-authority failures stop the pass. A later healthy account
cannot be permanently starved by the first 100 malformed legacy rows. Guardian
expiry has its existing separate durable cursor and current-authority checks.

## Retained reference: strict 24-hour limit

`audience_review_retirements` binds the account/declaration version, effective
expiry, retirement time, original recovery deadline, exact retired reference
revision/epoch, old authentication consent and exact cleanup intent. A reference
is considered recoverable only if it was active under current authentication
consent at retirement, has no independent cleanup obligation, and remains inside
the earlier of expiry+24 hours and that consent's own expiry.

In this state the reference cannot authenticate, match or generate grants. The
cleanup guard prevents its first delete while the short recovery window remains
open. Reference re-adoption is forbidden at and after its deadline. This disjoint
time boundary prevents an in-flight delete from racing a reference re-adoption.
The final transaction also checks the deadline immediately before commit.

An explicit adult renewal includes a new, separately affirmative authentication
consent. If all exact reference/consent/device/cleanup/writer/hold conditions still
match, it removes only its never-dispatched scheduled cleanup, creates one new
consent, advances profile epoch, and returns `face_login`. Removing that schedule
is not a claim that an object was deleted. The old consent remains revoked; no
matching/processing permission, old grant or child approval is restored. The
client still completes a normal fresh face challenge before product access.

A removed reference, independent withdrawal, changed reference/device, active
writer, cleanup attempt/ambiguity, pending deletion or applicable custody hold
cannot be treated as this retained-reference case. Renewal returns or remains on
the explicit profile-recovery route. A hold does not extend the 24-hour reuse
window. An unresolved cleanup/hold stays visible and does not become proof of
object absence.

Cleanup uses the existing exact-key delete followed by absence verification.
`removal_verified_at` is recorded only from verified cleanup; a missing profile
row alone is insufficient. Once safe, private object keys/digests and reference
identifiers are removed from the review record. Independent account erasure
includes the table and its referenced objects through the existing protected
inventory, writer, hold and final-outcome rules.

## Logged-out recovery without a biometric bypass

The audience status/review protocol proves possession of the exact registered
active device and saved handle. It remains useful after session or face-reference
expiry, but grants neither a product session nor a face verdict. An adult first
makes an explicit unchanged-decision review and separate purpose choice. A minor
creates a fresh pending guardian request, including when guardian authority
expires before the child's own annual date. Fresh independent guardian approval
and the child's own fresh purpose consent remain necessary.

Native clients that retained their existing lifecycle control can use the
following narrow bridge when that control's administrative 365-day expiry aligns
with the annual review:

1. `POST /auth/face/profile/control/status` uses the old control secret **and**
   the exact active device signature. It is domain-read-only, accepts that exact
   retained expired control, and returns normal `lovelies-face-profile-v1`
   metadata plus `control_recovery:{binding,expires_at}`.
2. The user makes a separate explicit authentication-consent choice. `POST
   /auth/face/profile/control/renew ` includes ` operation_key`, lifecycle
   `expected_version`, opaque `expected_binding`, and the consent object. The
   original control key remains in its existing protected vault. Save the exact
   renewal body before sending it.
3. The signed envelope is the existing
   `lovelies-face-profile-device-v1` with step `control-status` or `control-renew`,
   account/device/control key, fresh UUID nonce, expiry within 60 seconds and all
   business fields. It has no face handle. The binding hashes current account,
   control, device, audience, profile, consent and lifecycle revisions.
4. Renewal extends only that exact retained expired control, preserving its
   secret and `control_operation_key`. It cancels obsolete pending lifecycle
   work and returns normal current metadata plus
   `control_renewal:{operation_key,from_expires_at,to_expires_at}`. The original
   receipt dates do not change on replay. No consent, profile or session is
   granted by this bridge itself.
5. The client uses the existing explicit lifecycle challenge:
   `restore_authentication` for a valid retained reference, or `enroll` after
   positive verified removal. The former requires a fresh comparison; the latter
   requires fresh three-pose enrollment. Both preserve the same account and
   device binding. Matching and processing remain separate choices.

Unknown/erased controls, wrong old secrets, changed/revoked devices, disabled or
erased accounts, changed profile/consent binding, and deletion state remain
unavailable. The bridge cannot recreate them. A fresh bound proof can reconcile
an original committed receipt after face-policy rotation; a new old-policy
operation cannot grant. A late ambiguous commit returns an unresolved outcome,
so the client retains the original key and bytes.

The direct fenced status handler performs only reads and leaves the independent
restore checkpoint unchanged. The HTTP route retains its normal persistent
anti-abuse counter; that expected accounting write is distinct from a domain
control/profile/consent/operation mutation.

Admin browser vaults that do not have an original native lifecycle secret cannot
use the two-proof bridge. Their `profile_recovery` result keeps the existing
account/reference/recovery marker and uses the operator recovery runbook. Source
code cannot manufacture missing custody, another person's guardian evidence,
privileged provisioning or a revoked credential.

## Interrupted anonymous enrollment

A first enrollment may start just before the declaration's deadline. Expiry stops
its original challenge and revokes the old consent. Its unchanged durable own
session, enrollment key, device proof and resume journal still identify the same
anonymous account.

Explicit session annual renewal can rebind exactly one still-live, uncompleted
pending enrollment to one new current-policy authentication consent. The review
record retains a hash of the exact original intent/device/account/consent binding
and the old/new consent IDs. It does not store the secret, raw captures or a new
identity. The original challenge remains cancelled and keeps its original consent
reference. Signed status recognizes only that exact consent transition; signed
resume uses its original key/generation comparison to create fresh captures.

This metadata recovery is bounded by the original enrollment control's existing
expiry, which is not extended. It never reuses expired capture bytes or extends
their cleanup deadline. Multiple ambiguous intents, an independently revoked
intent/device, changed policy/binding, completed enrollment, an expired original
control or a pending writer cannot be silently replaced. Once the successor
challenge/terminal outcome makes the transition evidence unnecessary, maintenance
minimizes those fields subject to custody holds. A lost annual-renewal or resume
reply reuses the exact original business key and creates neither a second consent
nor a second successor generation.

## Migration, legacy receipts and evidence retention

`20261029230000_audience_decisions.sql` requires schema 15 and advances to 16. It
preserves the original projections of all 77 prior tables, their ACL/RLS policies,
legacy declarations, holds and receipts. New decision columns start as
`legacy-v1` with null flags/metadata, without deriving or fabricating a new
eligibility declaration. The new review table is private, forced-RLS and available
only to the narrow backend role. Anonymous/authenticated database roles have no
access. Invalid partial/null decision tuples are rejected by SQL as well as the
application. The accepted schema has 78 tables.

New declarations and journals store decision flags and server metadata. New
exports contain flags/provenance/review dates and minimized review outcomes,
never raw age labels, private template addresses/digests or control secrets.
The three outcomes remain equally inferable; no anonymization claim is made.

A valid historical original-key receipt remains usable for exact reconciliation.
It is never rewritten into a new business request. After 365 days, positively
validated settled audience declaration/renewal/control receipt payloads and
responses can be minimized, keeping the original key/action/hash and a terminal
receipt. A hold, unresolved writer/cleanup/delivery, inconsistent payload/hash or
unsettled linked guardian episode preserves the original evidence. Clients must
not discard an uncertain legacy journal on 409 upgrade-required or a restoration
fence failure.

Only after that evidence is safely settled and no applicable hold or pending
operation remains may a legacy current row older than 365 days replace its raw
label with its exactly equivalent flags. It preserves status, declaration
version, original declared date, policy and effective review deadline, and records
`legacy_declaration` source. It grants no capability, consent, guardian approval
or session. Migration itself never performs this conversion.

Minimized resolved review receipts expire after 365 days. Exact unresolved cleanup
and the latest positive removal proof needed by a still-retained, active-device
lifecycle control remain until resolved; their necessity is a specific custody
condition, not fresh biometric authority. Account erasure removes subject review
rows through its own independently approved final-outcome flow. Normal audit
classification keeps `audience.*` evidence for 365 days. Retention maintenance does
not qualify actual provider deletion, backups or scheduler cadence.

## Local evidence and remaining release work

The focused local fixtures cover migration preservation, null constraints,
unknown/minor/adult decisions, immediate expiry denial, separate consent,
original-key response loss, retired/legacy receipts, stale policy, actual stored
challenge deadlines, guardian and own review deadlines, pre/post-cleanup recovery,
365-day control expiry, no identity replacement, same-minor fresh review,
read-only restoration admission, blocked/corrupt-page fairness, holds, pending
enrollment consent/resume recovery and bounded metadata minimization. The shared
JavaScript client is also tested against actual backend responses. Native source
uses the same protocols and protected original journals.

Hosted migration/deployment, scheduler monitoring and backlog alarms, actual
Storage absence evidence, independent guardian-review operation, store signing/
submission, model/device qualification and release-owner acceptance remain real
external release gates. Local execution must not be described as their completion.
