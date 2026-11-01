# Delegated operators and reviewed processing recovery

This source change implements scoped operator access and a narrow recovery action
for an existing photo-processing attempt. Install migrations 14–17 in order with
the matching API/journal versions in a separately qualified environment. No
operator grant is created by a migration.

## Authority policy

An independently provisioned existing `admin` account can assign capabilities to
a different registered, currently eligible adult account. Delegated accounts
keep their ordinary `user` role; their capabilities come from live database grant
episodes, not JWT claims or a browser flag. Delegates cannot delegate access.

| Capability | Authorized area |
|---|---|
| `overview.read` | Operational overview metrics |
| `users.read` | User summaries and permitted detail sections |
| `users.sessions.revoke` | Reviewed revocation of another user's session |
| `support.read` | Support queue, details and retained decision history |
| `support.review` | Support state transitions and review notes |
| `safety.read` | Safety reports and matching review queues |
| `safety.review` | Safety and match decisions |
| `guardian.read` | Guardian review queue and details |
| `guardian.review` | Independent guardian and adulthood review |
| `privacy.read` | Privacy request queue and details |
| `privacy.review` | Independent privacy request approval/rejection |
| `uploads.read` | Processing metadata, queue state and recovery diagnostics |
| `uploads.recover` | Reviewed resume of an eligible original attempt |
| `retention.read` | Retention settings and asset retention detail |
| `retention.manage` | Retention settings and maintenance scheduling |

Every changing capability requires its corresponding read capability in the
same assignment. A grant needs an explicit future expiry of at most 30 days,
a reason, a stable operation key and the exact current access revision.
Replacing a scope retires old immutable grant episodes; it does not edit them
back into authority. Account deletion and full restore retire delegated grants.
The monotonic access revision is retained after grant metadata minimization.

The admin interface hides unavailable routes and disables unauthorized controls.
The server remains authoritative. It checks current grants on route admission,
within mutation transactions, before returning saved receipts, and before
releasing operator results. The generic community operation lookup applies the
same gate. Expired grants are checked again after awaited grant reads. User
detail sections for support, safety and privacy require their own scopes;
`users.read` alone does not reveal those case classes or unrestricted history.

Full administrators manage access from **Operators**. Supported routes are:

- `GET /admin/operators` with the standard filtered pagination contract.
- `GET /admin/operators/:accountId` for current revision and grant episodes.
- `POST /admin/operators/:accountId/capabilities` with `capabilities`,
  `expires_at`, `expected_revision`, `reason` and `operation_key`.

An empty capability array and a null expiry revoke delegated access. Existing
full administrators cannot be converted into delegates through this API, and
self-management is forbidden. Full restore removes restored administrator
privilege; independently controlled provisioning is required after recovery.

## Safe processing recovery

Upload diagnostics include a revision digest and an eligibility reason. A user
with `uploads.recover` may review the attempt and submit:

`POST /admin/uploads/:assetId/attempts/:attemptId/resume`

The body contains the exact `expected_revision`, a human `reason` and a stable
`operation_key`. The backend requires a current independent operator and fresh
registered-face authority. It checks the following before requeuing:

- The original owner session/device/profile/consent and audience remain valid.
- The original asset version, checksum, model and engine identity still match.
- The attempt is unexpired and queued, stranded, or failed with a supported
  transient processing error.
- No active lease, moderation/retention hold or unresolved owner storage write
  exists; elapsed time alone does not prove an unknown write completed.
- The exact private source object's length and source metadata are verified.
- Fewer than three recovery decisions were accepted for that attempt in the
  preceding 24 hours.

Recovery resumes the same attempt, outbox and job identity. Scheduler backoff,
previous job attempts/error evidence and late-worker lease checks are retained.
The action creates no recipient, media grant, new consent, new processing model
or fresh owner authority. A repeated original key returns the same receipt only
while the operator remains authorized. A changed revision or changed input
requires a new review; a cached successful receipt does not require another
Storage HEAD request.

Current holds, ambiguous external effects, expired attempts, revoked consent,
changed source/model and changed owner authority remain ineligible. The
interface presents the concrete reason. A fresh owner action may be needed for
those cases; the operator cannot reset the safety boundary.

## Retention and verification

Operator access/recovery receipts retain their identity and input hash after
the one-year detailed-copy retention boundary. Metadata minimization is paged,
advances past malformed/held rows and preserves unknown or currently held
records. Grant deletion waits for expired/revoked authority and minimized
related receipts; the access revision remains durable.

Local tests cover current-scope routing, direct and generic saved receipt
recovery, expiry during reads/writes, no self-grants, read prerequisites,
revision conflicts, immutable episodes, original job identity, backoff/lease
preservation, holds, unresolved writes and daily recovery budgets. Full hosted
multi-operator/browser and scheduler acceptance is an environment gate.
