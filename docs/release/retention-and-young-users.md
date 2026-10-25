# Lovelies retention and young-user release decisions

Decision date: **24 October 2026**. The owner selected **ages 13 and above, with
a supported guardian-consent process for ages 13–17**, and delegated the remaining
retention decisions. The periods below are the selected engineering and operating
targets for this release. They are not a statement that current code, provider
settings or support operations already enforce them. No additional owner choice
is needed to implement this schedule.

This document specifies the product controls and the evidence needed before the
corresponding public promises are made. It is not a legal opinion or a finding
of worldwide compliance. The selected processors are Supabase in Ireland for
the application database and private Storage, and a separately authenticated
Cloudflare EU/WEUR private inference service. The latter's deployed Worker is
currently disabled for serving; selection is not production qualification.

## Why these periods

The schedule limits data to its actual purpose. A private photo library needs a
predictable availability window; authentication needs the current reference,
not a permanent archive of capture images. Support needs a short case history,
and incident investigation needs minimized events rather than photographs or
face vectors. The European Commission describes purpose, minimization and
storage limitation, and requires concrete erasure/review limits. These principles
do not prescribe a universal seven-year period for Lovelies data.
[European Commission: processing principles](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/principles-gdpr_en).

The following numbers are Lovelies operating decisions, not statutory periods.
Any longer exception must identify a specific obligation or case, the necessary
fields, its owner, review date and release condition. Financial bookkeeping is a
separate class: its applicable statutory period must be recorded by the finance
owner. A bookkeeping obligation never justifies retaining selfies, face vectors,
private photographs or an unrestricted account audit trail.

## Selected schedule

All days are elapsed calendar days. Earlier withdrawal, valid erasure or loss of
authority overrides a normal availability period. A failed deletion remains a
visible retry obligation; a deadline never authorizes deletion under a stale
lease, an unsettled writer or an unreviewed hold.

| Data class | Selected availability and deletion rule | Necessity and boundary |
|---|---|---|
| Enrollment, sign-in, recovery and replacement capture images | Use only for the bound operation. Queue cleanup immediately on completion, rejection, cancellation or challenge expiry; target verified active-object deletion within **1 hour**, maximum normal recovery window **24 hours**. | No capture archive, training corpus or manual age assessment. The challenge's 120-second validity is not a guarantee that its bytes have already been deleted. |
| Inference images, crops, embeddings and temporary files | Request-local lifetime; remove on success, failure and timeout before reuse. No persistent inference image/vector logs. If a durable work object is unavoidable, apply the same **24-hour** maximum and exact-key cleanup obligation. | Keep only the registered reference or other explicitly necessary, separately consented output. Do not create a new face-crop archive merely because a legacy setting exists. |
| Current registered face reference | While at least one current, valid authentication or matching purpose requires it. Retire the former reference on replacement and stop use immediately when its last valid purpose ends; target verified deletion within **24 hours**. | Authentication and matching remain separate choices. Pause of one purpose does not silently withdraw the other; no reference remains available to a withdrawn purpose. |
| Inactive-profile reconciliation metadata | Up to **14 days** after reference retirement, only for non-image retry/status reconciliation; purge when no writer, cleanup, recovery or justified hold still requires it. | Preserve the 14-day cleanup concept without retaining a revoked biometric reference for 14 days. Outstanding deletion work must remain until resolved, with an incident escalation instead of a false purge receipt. |
| Uploaded originals, previews, captions and photo-linked matching outputs | Preserve **60 days from upload creation**, with explicit expiry shown to the user; revoke access at expiry and verify active-object deletion within the following **24 hours**. Delete earlier on eligible user/account deletion. | Subscription or repeated viewing does not silently reset expiry. Derived photo data cannot outlive its source or the applicable matching purpose. Changing the global period must not silently rewrite versioned asset deadlines. |
| Incomplete resumable uploads | Preserve the existing **7-day** transfer expiry, then queue verified cleanup within **24 hours**. Earlier explicit cancellation takes precedence. | A general cache purge must not erase a valid, recoverable upload. Unknown writer outcomes must first be reconciled against the original transfer. |
| App-managed temporary preview/cache copies | Maximum **2 days** from creation, with immediate logical invalidation on revocation, account switch, sign-out or deletion and best-effort secure local removal. | Enforce on both native platforms, including restart and offline paths. Copies deliberately saved to the user's Photos/Files or another recipient's device are outside app recall; explain this separately. |
| Privacy export packages | Existing **24-hour** availability; one-time, current-session download grant no longer than **5 minutes**. Queue object cleanup at expiry or earlier account erasure and verify absence. | Exports remain private and must not become durable email attachments. A user's downloaded copy is outside the server cleanup guarantee. |
| Unfinished guardian requests/invitations | **7 days**, then expire and delete unneeded contact/evidence intake within **24 hours**. | Pending status grants no capture, upload, matching or gallery authority. Renewal creates a fresh reviewed request; it cannot bypass age rules. |
| Consent, guardian approval and withdrawal receipts | While the relevant purpose is active, then **365 days** of minimal receipt evidence. | Retain purpose, policy version, pseudonymous subject/approver reference, method, decision and dates; no selfies, vectors, raw documents or unrelated support narrative. This supports a bounded annual control/complaint review, not a seven-year biometric archive. The annual necessity review may shorten it. |
| Routine application/inference diagnostic logs | **7 days**; redact bodies, credentials, recovery secrets, media keys, image bytes, vectors and unnecessary query text before logging. | Troubleshoot recent failures without building a content history. Confirm the actual gateway, provider and container fields, not only the application logger. |
| Account security/rate-limit events | **30 days** of minimized, access-controlled events; raw network identifiers no longer than **7 days** unless a specific incident requires them. | Investigate abuse and replay patterns. A confirmed incident may retain the exact relevant subset for **180 days after case closure**, with a monthly necessity review. |
| Privileged operator and privacy/erasure audit | **365 days** of minimized action/outcome evidence; keep required unresolved cleanup obligations until verified. | Enables the annual operator review and correction of failed erasure. Exclude capture bodies, face references, full share graphs and free-text content. Pseudonymous IDs remain personal data while linkable. |
| Ordinary support cases | While open, with review every **30 days**, then **90 days after closure**. Safety/privacy complaints may retain their necessary subset for **180 days after closure**. | Delete accidental photo/secret attachments immediately through controlled cleanup. A guardian's approval does not grant general access to a young user's library or private cases. |
| Purchase verification | Necessary account/token binding while entitlement or a refund/revocation dispute remains active, then **180 days** after final expiry/resolution; reduce to required financial facts thereafter. | Isolate statutory financial records under their evidenced schedule. Do not put raw store credentials or card details into support or audit records. |
| Deletion status and restore-suppression evidence | Keep the receipt usable for **30 days after final outcome**, and minimized suppression/completion facts for **365 days**. | Allows an unresolved request to remain trackable and prevents resurrection from backup. No biometric content belongs in the suppression ledger. |
| Recoverable database backups and any separately operated media backups | Select a rolling **7-day** maximum; encrypted, restricted to disaster recovery, then expire. No extra ad hoc copies, debug dumps or media replication outside the inventory. | Seven days covers recent operator failure while keeping the full erasure timetable below. No paid backup/PITR upgrade is implied. Configure a supported existing-plan option or an operated encrypted backup before release. |

Routine erasure aims to remove active account, reference, media, grants and
eligible metadata within **7 days of receipt**, and to age all eligible residual
backup copies out by **day 14**. The external maximum for ordinary, non-exempt
data is **30 days from receipt**, including residual backups, rather than 30 days
for live data plus another backup window. Respond by the earlier of that limit
and the applicable one-calendar-month deadline. Resolve ownership promptly;
approval must not silently reset the clock. Notify the person of a specifically
justified retained class, reason and review route. A failure beyond the target is
an incident, not grounds for a fabricated completion status. The Commission's
rights guidance describes the one-month response requirement and the qualified
right to erasure.
[European Commission: individual rights](https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en).

An accepted deletion should immediately restrict product processing and retire
new access while preserving request/status, withdrawal and proportionate ownership
recovery. Preserve the independent reviewer and writer/lease/version checks.
Delete confirmation still requires actual object deletion followed by confirmed
absence. Do not silently cancel a valid erasure request because an internal
seven-day review window elapsed.

For holds, keep the global default **off**. Use a scoped record with reason,
necessary fields/objects, authorized owner, expiry and review at least every
**30 days**. A hold stops ordinary reuse and sharing of the held content. Lift it
as soon as the ground ends and resume exact cleanup; do not retain an entire
minor's account because a small case record is required.

## Backup and recovery operation

The 7-day backup choice is a release configuration requirement, not an observed
Supabase setting. Supabase documents different backup windows by plan; database
backups cover database records, including embedded references, but **not Storage
object contents**. Its published project-deletion timetable is not a timetable
for individual account deletion. Inventory actual automated backups, WAL/PITR,
manual dumps, logs, object copies and any operator-held exports separately.
[Supabase: database backups](https://supabase.com/docs/guides/platform/backups),
[Supabase: residency and retention](https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq).

Exclude temporary capture/quarantine objects, inference work files and generated
privacy exports from any separately operated media backup. Persistent database
references still require the restricted residual-backup handling below.

Restrict deleted data in retained backups from application use, and expire it on
the verified rolling schedule. Before any restored copy becomes accessible,
replay the current deletion/withdrawal suppression ledger, retire restored
sessions, tokens, consent and grants, and verify absent objects. Re-enrollment
must never reactivate old grants. A restore rehearsal must demonstrate these
steps and the final expiry of affected backups. Do not claim irrecoverable
erasure while any eligible restorable copy remains.

## Ages 13–17 and guardian authority

Malta's IDPC confirms that S.L. 586.11 lowers the Article 8 information-society
consent age to **13**. This is a specific consent threshold; it is not general
permission to process biometric data, proof of contractual capacity, or a rule
that every country permits every 13-year-old workflow. Lovelies applies its
owner-selected guardian safeguard to **all users aged 13–17**, even where the
local Article 8 threshold is lower.
[Malta IDPC: legislation](https://idpc.org.mt/our-office/legislation/).

Biometric recognition for unique authentication/identification needs its own
valid processing basis and special-category condition. For the consent design,
obtain an explicit, informed and separate decision for face authentication,
photo matching and uploaded-photo processing, and make withdrawal accessible.
An airport-specific EDPB opinion confirms the explicit-consent issue but does
not decide Lovelies' lawfulness or children's processing.
[EDPB Opinion 11/2024, paragraph 15](https://www.edpb.europa.eu/system/files/2024-05/edpb_opinion_202411_facialrecognitionairports_en.pdf),
[EDPB consent guidance](https://www.edpb.europa.eu/documents/guideline/guidelines-052020-on-consent-under-regulation-2016679_en).

The minimum implementation is:

1. Before camera permission/capture, upload, inference or protected matching,
   obtain a neutral eligibility decision. Store only `at_least_13`,
   `guardian_required`, source/method, applicable territory/rule version,
   declaration date and next review. A transient age band may derive those
   decisions; full date of birth, face-age inference and precise location are
   unnecessary. Unknown or conflicting age stays restricted. Under-13 users do
   not enter registration or media processing; retain support/privacy/deletion
   access and minimal neutral information.
2. A 13–17 account starts `guardian_pending`. Provide child-readable and adult
   notices before collecting a guardian decision. The child makes their own
   separate purpose choices. A guardian records the corresponding authorizations
   for that exact child account and policy version; neither action substitutes
   for the other. Declining matching does not imply acceptance of another purpose.
3. Require a distinct guardian principal and a distinct current operator reviewer
   for a support-assisted decision. Record the evidence method and minimized
   result. A checkbox, possession of the child's device, store purchase approval,
   shared surname, email reply, registered-face match or adult self-declaration
   alone does **not** establish parental responsibility. Do not automatically
   convert an unknown historical/test account into an adult account.
4. Prefer an evaluated platform-supervised relationship/age signal where it is
   actually available, coupled to a purpose-specific guardian authorization and
   current reviewer decision. Apple Declared Age Range and Google Play Age
   Signals supply useful contextual signals; their presence or approval to
   install is not explicit consent to Lovelies' face processing. Qualify their
   actual regional/OS coverage, spoofing/replay resistance and withdrawal path.
   If adequate authority cannot be established through the supported process,
   the account remains pending with an explanation and human review route. Do
   not manufacture a parent-verification result to make enrollment proceed.
5. Keep adult/guardian assessment separate from the three-selfie comparator.
   Add no OTP, civil-identity documents or verification journey, liveness/PAD,
   blink/head-turn challenge, camera-injection qualification or civil-identity
   claim. Ordinary enrollment poses remain unchanged.
6. Bind audience/guardian purpose approval versions into the current authority
   checked before byte upload, inference and asynchronous publication. Check
   **both** source owner and potential recipient; otherwise another account
   could still match a restricted minor. A candidate never grants media access.
7. Withdrawal, expiry, unresolved dispute or new required purpose immediately
   stops the affected use, cancels stale challenges/work, retires old grants and
   queues cleanup. Existing status/privacy/deletion/revocation routes remain
   usable without obtaining a new guardian approval. Guardian approval grants
   no ability to view the child's photos, impersonate them or approve sharing
   on their behalf. On reaching adulthood, obtain a fresh own-purpose decision;
   do not infer a birthday or silently carry guardian consent forward.

Review the guardian authority and eligibility decision at least annually, and
earlier when the applicable rule, purpose or relationship changes. An unresolved
review cannot silently extend an expired approval. This review needs an updated
eligibility decision, not a retained exact birthday.

These are application controls; they do not warrant a claim that the app has
proved age or civil identity. The EDPB's adopted age-assurance statement requires
proportionate, effective methods and minimal attributes, and identifies the
weakness of self-declaration for high-risk processing. Evaluate and document the
actual process, including refusal, error, appeal and accessibility cases, before
admitting minors to biometric processing.
[EDPB Statement 1/2025, sections 2.2–2.5](https://www.edpb.europa.eu/system/files/2025-04/edpb_statement_20250211ageassurance_v1-2_en.pdf).

Apple's age-range declaration can be self- or guardian-declared; it is not a
universal identity certificate. The framework's required capability and OS
coverage are additional engineering work, not assumed present. Google's
supervised status is likewise an account supervision signal. Neither integration
is asserted implemented in Lovelies by this document.
[Apple: age assurance Q&A](https://developer.apple.com/support/age-assurance/),
[Google: AgeSignalsVerificationStatus](https://developer.android.com/google/play/age-signals/reference/com/google/android/play/agesignals/model/AgeSignalsVerificationStatus).

## Current implementation gaps and release acceptance

On 25 October the native cache implementation passed all 192 Android JVM tests
(including 14 new cache cases), the original 1,020 iOS host checks and 35 separate
iOS private-media checks. Expiry is bound to the original creation/session clock;
cache hits do not renew it. Denial, expiry and account/session changes retire the
private presentation. Restart cleanup is limited to recognized app-owned temporary
files; encrypted resumable uploads, protected capture drafts, unknown files and
copies deliberately saved to Photos/Files are preserved. These are local tests,
not physical-device or hosted deletion acceptance.

The new 14-day inactive-profile phase removes old reference keys/digests only
after verified cleanup, a fresh absent Storage HEAD and an unchanged transaction
snapshot. It preserves holds, current references, pending recovery/challenges,
ambiguous cleanup and unsettled/newer writers. Exact minimal completion facts keep
signed status and fresh three-capture re-enrollment truthful without retaining
the old address or issuing credentials. Source classes take bounded alternating
turns. The current API regression and its exact receipts are recorded in the
linked integration checkpoint.

[The encrypted database producer/catalog](database-backups.md) now passes local
operator checks and actual PostgreSQL dump/isolated reconstruction, including
seven-day expiry. Hosted scheduling, independent off-site custody, a current
suppression ledger and replay operation, and startup restore quarantine remain
unimplemented or unqualified. A privacy export is not a database backup, and a
deletion fact restored from the same database snapshot is not an independent
anti-resurrection record. Actual backup operation and restored-data suppression
must be implemented and rehearsed before publishing those guarantees.

The source inventory is independently detailed in the source-bound
`guardian-retention-gap.json` receipt. This table preserves the initial inspected snapshot. Implementation has since advanced; see
[audience-readiness-20261024.md](audience-readiness-20261024.md) for current local
results and hosted/operating gaps. The original snapshot is retained below:

| Surface | Observed now | Required before the public claim |
|---|---|---|
| Age/guardian | No active audience/guardian authority tables, routes or native pre-capture gate were found in the inspected snapshot. Existing face consent does not prove age/relationship. | Add the narrow contract, reviewed guardian operation and both-side current-purpose guards; qualify rejection, race, withdrawal and pending-state privacy access. |
| Media retention | `retention.ts` calculates original/preview expiry from 60-day defaults and uses current-version/hold/writer checks, leased exact deletion and absence verification. | Operate a monitored maintenance schedule and qualify expiry plus retry under the actual hosted providers. A selected default alone is insufficient. |
| Legacy 14/2/2,555 settings | `face_crop_days=14`, `free_cache_days=2` and `audit_days=2555` are stored/read/updateable, but the inspected server retention code does not consume them as separate purge schedules. `audit_days` schema/validation rejects values below 2,555. | Implement category-specific cleanup and amend the audit constraint through an additive migration. Keep the baseline migration/history. Do not relabel 14 as already implemented profile inactivity expiry or 2 as verified native cache expiry. |
| Capture and export cleanup | Terminal/expired capture proofs have bounded exact cleanup; exports expire after 24 hours and grants after at most five minutes. | Verify scheduler cadence, backlog age, crash/retry/late-writer handling, object absence and alarms; no indefinite sensitive retry queue. |
| Deletion | Valid delete requests remain actionable beyond their thirty-day review target; original-age7/30day backlog monitoring exists. [Atomic final-outcome receipt and mobile contract corrections pass locally](deletion-receipt-contract-20261025.md), including overdue status, rollback/retry and revoked-receipt fences. | Configure and demonstrate actual review, alerts/escalation, complete cleanup and backup/restore suppression. Local status availability does not prove on-time erasure or operated completion. Account disablement or metadata erasure alone must not claim completed files/backups. |
| Logs, audit, support, backups | No current operated category purge, provider retention or restore-suppression rehearsal is established by this policy work. | Configure exact fields/periods and operators, inventory processor copies, demonstrate expiry, restore suppression and alarms. No new cost or provider is authorized merely by this design. |

For store declarations, the intended Google audience is 13–15, 16–17 and adults,
subject to the implemented/operated workflow and each market's rules. Google
warns that these groups can include children in some locales; a 13+ selection
does not automatically remove Families obligations. Apple's age rating must be
answered from actual content and safeguards. Its 2.5.13 facial-authentication
rule still requires LocalAuthentication where possible; document the necessary
account-authentication architecture and qualify review expectations rather than
claiming the chosen minimum age resolves that rule. Apple's privacy rules also
require actual retention/deletion disclosure and an accessible deletion route.
[Google: target audience settings](https://support.google.com/googleplay/android-developer/answer/9867159?hl=en),
[Apple: guidelines 2.5.13 and 5.1](https://developer.apple.com/app-store/review/guidelines/).

Publish the numerical schedule only after the relevant enforcement, provider
configuration and operation have been verified. Preserve the prior published
edition, carry these decisions into the replacement privacy/deletion/terms
pages and store forms, and keep source/local proof distinct from hosted,
physical-device and store acceptance. This document authorizes no deletion of
unknown/test data, replay of baseline DDL, new paid service or store publication.
