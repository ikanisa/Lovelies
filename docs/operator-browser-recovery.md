# Recovering access after loss of an operator browser profile

This procedure covers a lost device, a cleared browser profile, unavailable
IndexedDB, or an unrecoverable browser signing key. It uses independent
re-enrollment and controlled privilege provisioning. It does not export a
non-extractable signing key, impersonate the old account, or treat a new enrollment
as recovery of the old identity.

It also covers an explicit annual-renewal result of `profile_recovery` when the
original reference or required authority has already retired and the browser
cannot complete a supported same-account recovery. Preserve the existing device
reference and journals in that case. Renewal of eligibility is not restoration
of a removed face reference, old purpose consent, privilege or private grant.
Use an available supported same-account recovery first; do not clear the profile
or replace an uncertain renewal merely to get past the notice.

The procedure is ready for an operator rehearsal. Provisioning real accounts,
changing production roles, revoking live sessions and proving hosted results
require the intended environment and its authorized people. None of those
actions was performed while preparing this document.

## Required preparation

Maintain at least two independently provisioned, usable registered-face
administrators on separately controlled browser profiles. Test the recovery
administrator's login and current eligibility before relying on it. Each person
must use their own signing key, consent and face authentication; a shared vault,
copied browser profile or token passed between people is not this control.

Record the approved HTTPS origin, environment, API configuration, exact operator
account IDs, custodians, and independent control-plane provisioning authority in
the restricted operating record. Keep credentials, recovery secrets, biometric
material and free-text case content out of that record. Confirm that the approved
control-plane mechanism can grant and remove the `admin` role with independently
reviewed exact-account changes, current-state checks and a retained audit trail.
The browser has no role editor. A database service key must never be pasted into
the browser or its runtime configuration.

The existing application protects the last registered administrator and forbids
self-management through the account-management route. Keep an independently
usable administrator throughout this procedure. A count of role rows alone does
not prove a person can still log in. If no usable independent administrator or
approved provisioning authority remains, stop privileged recovery and use the
project's authorized control-plane incident process; do not disable the guards
or manufacture a session.

## 1. Identify the affected account and contain access

Record the incident reference, environment, exact old account ID and known device
or session IDs from the controlled operator inventory. Resolve any identity
ambiguity before selecting records. A display name, email, photo or the operator's
recollection is not a substitute for the account ID.

From the independently provisioned recovery administrator's browser, perform a
fresh registered-face login, open **Users**, and fetch the exact old account's
current details. Traverse every page of sessions and audit history; a first-page
count is not a complete inventory. Preserve IDs, current statuses and relevant
outcomes in the restricted incident record, without copying tokens or response
bodies containing private data.

If the old browser/device may be compromised, remove the old account's privileged
role through the approved control-plane procedure promptly, with a second
authorized reviewer and a still-usable independent administrator. Read back the
exact old and remaining administrator accounts. Do not grant new privileges
merely to satisfy the last-admin count. Do not edit independent restore markers,
historical operation receipts, consent evidence or unrelated roles to make the
change proceed. A restore fence or unknown control-plane outcome remains an
incident requiring its own reconciliation.

Use the existing **Revoke** action on each exact affected session. Its API is
`POST /admin/users/{old_account_id}/sessions/revoke` with `session_id`, a concise
incident reason, and one original `operation_key`. The server requires current
administrator authority and a face login within five minutes. Refresh the
session list and renew face authentication when required; do not replace a
refused request with direct table edits.

Reconcile an uncertain revocation using its original saved operation before
starting a replacement. Read back the exact session and verify that it is no
longer current. The operation revokes one session; it does **not** revoke a device
key, remove the account's role, delete the account, or prove that every issued
session has been found. Record those separate outcomes accurately. If device
retirement is required, use the account's existing authenticated security/recovery
procedure or the authorized incident process. The recovery administrator must
not impersonate the old account to invoke an own-device route.

## 2. Preserve unresolved operations

If the old browser remains accessible, retain its encrypted pending-operation
journal and reconcile each exact original operation before clearing the profile.
Sign-out retires current authority; it is not evidence that a pending server
action never happened. Unsent notes and submitted operations have different
lifetimes, as described in [the live workspace guide](../admin/README.md).

If the profile or journal is already lost, preserve the relevant backend audit,
operation, queue and independent-journal evidence. Inspect current subject/case
state with the independent administrator. Do not repeat a privacy approval,
erasure, guardian decision, session revocation or queue repair under a new key
because its old browser result cannot be found. A lost key cannot be inferred
from a similar-looking operation. Keep uncertain work held until its original
outcome is established; use the existing exact work-recovery inspection only
when its server proof says that original work is resumable.

Do not delete the old account as a shortcut for retiring administrator access.
Account erasure has a separate independent-review, hold, writer, provider and
cleanup protocol. Its evidence must remain available until that protocol permits
retirement.

## 3. Enroll and provision the replacement

Create a fresh browser profile at the approved origin. Follow the normal neutral
audience declaration, separate purpose consent and signed three-selfie enrollment
flow. Resolve annual audience review through the explicit supported renewal
journey before camera access. No OTP, liveness test, civil-identity claim or copied
native signing key is introduced by this recovery procedure.

Before provisioning, record the exact newly created account and registered
device IDs from the authenticated result. Confirm with an independent reviewer
that they belong to the replacement operator and the intended environment. Do
not copy the old account ID into local storage, transplant its device reference,
transfer its biometric reference, replay its captures or rewrite pending
operations to the new account.

The authorized control-plane custodian grants only the required operator role
to this exact new account, using the approved current-state-checked provisioning
procedure and retaining the incident/reviewer/audit reference. New enrollment
alone has no privileged effect. If provisioning returns an unknown result, read
back and reconcile that original change before making another change.

After provisioning, perform a new face login in the replacement browser. Verify
that `/me` identifies the exact new account and its current role, then exercise a
read-only admin collection and account detail in the intended environment.
Confirm that a fresh ordinary account is still denied the admin routes. Do not
test recovery by approving or deleting an unrelated real user's data.

## 4. Confirm retirement and close the incident

Confirm the old account no longer has administrator authority, every identified
affected session is revoked, and the replacement and independent recovery
administrator can each still log in. Check old-key/old-session denial through an
authorized controlled probe if those credentials are still available. An absent
old browser prevents that probe; record the missing observation instead of
claiming it passed.

Resolve or explicitly retain all unknown operations and device-retirement work.
Keep the old profile intact until its remaining recovery evidence is no longer
needed. Clear only the exact retired profile under the custodian's procedure;
clearing browser storage cannot erase server or provider evidence.

The final incident record names the old/new/recovery account IDs, environment,
independent reviewer, approved provisioning and demotion results, exact session
revocations and readbacks, remaining device or operation holds, and the time and
owner of the next review. Re-establish two usable independent administrators.
Schedule a controlled lost-profile rehearsal and verify current browser storage,
cross-tab, camera, HTTPS/CORS and service-worker behavior at the deployed origin.

## Rehearsal acceptance

Use designated test operator accounts. Demonstrate a cleared profile receiving
no inherited authority; distinct replacement identity; independent provisioning;
fresh face checks; last-admin and self-management refusal; all session pages;
lost-response reconciliation without duplicate mutation; old-role and session
denial; and recovery with a deliberately unresolved old operation left held.
Record the actual deployed versions and observed results. Local source tests or
this written procedure do not substitute for that rehearsal.
