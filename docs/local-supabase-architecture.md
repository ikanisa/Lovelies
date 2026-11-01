# Local Supabase architecture

## Current owner decision

The 1 November 2026 instruction selects locally hosted Supabase for the backend,
database and enabled Supabase capabilities. The Google Drive `supabase` starter
is configuration input. It is not evidence that a production host has been
provisioned or qualified. `deploy/local-supabase` contains the project-specific
deployment definition and pinned upstream inventory.

Android and iOS retain `com.lovelies.memories` and the existing signing lineage.
The mobile apps and admin panel call the configured HTTPS
`/functions/v1/lovelies-api` endpoint. Public media URLs use the externally
reachable HTTPS origin; private internal service names never become device URLs.
The admin panel defaults to the same HTTPS origin. Development loopback is an
explicit, separate case.

## Identity and authority

Supabase GoTrue creates and refreshes real anonymous managed sessions through
supported HTTP APIs. Lovelies keeps their access and refresh credentials encrypted
on the server under an independent key. Clients receive the existing short-lived
Lovelies capability and recoverable rotation contract. This preserves native
account/device ownership and signed-capture protocols while adding the managed
session requirement.

An anonymous Auth identity is not face verification. The application separately
requires the current account epoch, device revision, signed challenge, registered
reference, audience decision and purpose consent. A restricted read-only database
function checks that the managed session and anonymous user still exist, have not
expired or been banned, and belong to the recorded binding. User metadata grants
no authority. No application code writes directly to `auth.*`.

Auth preparation runs outside the application transaction. Ambiguous network
results remain durable unresolved work. An opaque creation marker can locate an
orphan for deletion; it can never recover a token or establish positive identity.
Account erasure requires both provider absence and physical absence of the exact
user from the local Auth database before clearing credential custody. Missing
sessions, bans and soft deletion cannot substitute for that absence. Restore
incarnations prevent restored encrypted credentials from becoming current again.

The managed Auth data key has a guarded operator rotation workflow. Its encrypted
old/new-key escrow, persistent request gate, writer quiescence and atomic journal/
database receipt preserve unresolved outcomes across restart. Positive and
aborted rotations have separate verified resumption paths; ordinary configuration
replacement cannot silently retire a durable encryption key.

No email, phone, OTP, social login, liveness/PAD, facial age estimate or civil
identity check is introduced. The app still starts anonymously, enrolls with
three signed selfies and later verifies the registered reference. Enrollment
pose guidance does not attest camera provenance.

## Data and service boundaries

| Boundary | Selected implementation | Release condition |
| --- | --- | --- |
| Business records | Private PostgreSQL schema, forced RLS and restricted backend role | Fresh and upgrade migrations, negative role tests and actual runtime readback |
| Selfies, originals, previews, exports | Private Supabase Storage buckets | Real object write/read/delete/absence and revoked-access tests |
| Application API | Local Supabase Edge Functions behind the TLS gateway | Exact configured origin, schema and all required services ready |
| Managed Auth | Local GoTrue, accessed by the server | Public API lifecycle plus current-session verification and erasure |
| Restore witness | Private journal service on independent local PostgreSQL custody | Survives application rollback; old writers fenced; restrictive replay and clearance verified |
| Push receipts and roster | Private ledger on independent local PostgreSQL custody | Ambiguous sends never become fabricated success or blind retries |
| Face processing | Authenticated private Python inference service built from the merged source | Current artifact/model hashes, security checks and representative accuracy evaluation |
| Store entitlements | Direct Apple/Google verification in the API | Real sandbox/production separation and retained app/product identities |
| Push transport | APNs/FCM adapter with durable receipts | Provider acceptance and observed device delivery recorded separately |
| Scheduled work | Local Cron/Vault/pg_net and a private maintenance route | Restricted queue/Vault grants, restart/retry/drain and alert exercises |

Application and custody databases must not share a restore unit. Separate schemas
inside a database restored from the same snapshot do not provide independent
evidence. Custody may be backed up, but restoring it requires its own controlled
procedure and cannot be an automatic side effect of application restoration.

The API and Storage network allowlists distinguish public HTTPS origins from
explicit internal service origins. The public gateway overwrites its dedicated
client-address header; callers cannot select their rate-limit identity. Studio,
database sockets, maintenance, custody and server-held Auth routes stay private.
Keys are generated for this installation; upstream example credentials are never
deployment credentials.

## Reconciled protocols

Keep Complete-package migrations through schema 17 unchanged. The additive
audience/delivery migration establishes schema 18; managed Auth establishes 19.
The independent V3 schema-14/15/16 files are superseded by this ordered lineage.
The chunked privacy export v3 protocol remains authoritative. Audience decision
v2 removes new stored age-band declarations while retaining safe handling of
historical unresolved records. Delegated operator access uses current audience
decisions and explicit independently provisioned capabilities.

Primary admin queues retain server-side search, bounded opaque cursors and
priority/oldest-work ordering. Reports and matching proposals have separately
selected collections. Child history uses its own bounded continuation. Recovery
inbox sorting does not change the primary queue cursor protocol. Review uses the
fresh current revision; a delayed response cannot repopulate a closed or retired
workspace. Encrypted drafts restore only after a fresh read and explicit action.

Global matching retains the best and runner-up candidates across every page.
Legacy pending plans incompatible with the new representation remain held for
explicit recovery. A match candidate never creates an access grant. Recipients
remain restricted to the reviewed exact subset and explicit acceptance.

## Operations and evidence

The task register preserves all 63 current tasks, 90 historical backlog mappings
and 43 review findings. Each implementation status is separate from its
qualification status. `scripts/release-gate.mjs` checks a source-bound evidence
manifest for every core release task. Its empty template is deliberately blocked.

A database dump does not back up Storage bytes. Coordinate database/Auth/Storage
metadata and the object store, record byte counts and digests, encrypt the result,
and rehearse restoration with the independent journal retained. Measure recovery
point/time, reject old authority, reconcile objects and obtain computed clearance.
Preserve unknown/test data and existing credentials/signing recovery material.

Actual host access, approved host/domain configuration, physical devices, store
and notification credentials, consented recognition data, named responders and
effective public policy/support operations remain necessary inputs to their
respective acceptance tasks. Fixture passes do not replace those observations.
Additional Supabase capabilities are enabled only for a current product use with
minimal grants; starter examples do not add features or permission to send SMS.
