# Lovelies on locally hosted Supabase

This is the selected production deployment profile. The application database,
managed Auth, private Storage, PostgREST, Realtime, Edge Functions, Vault, Cron and
supporting PostgreSQL extensions run in the local Supabase stack. The restriction
journal and push receipt/roster authority run against a second local Supabase
PostgreSQL database, with separate credentials, schemas, volumes and a separate
Compose lifecycle. No hosted Supabase project or Cloudflare Durable Object is
used as the selected backend authority.

The logical project identifier `ltqfplqevxztlswlzexn` remains in existing protocol
envelopes. It does not select a hosted Supabase endpoint.

## Current implementation and evidence

The source includes deployment configuration, private TLS custody servers,
PostgreSQL persistence, protected scheduling, configuration generation/checking,
real-host qualification probes, coordinated encrypted snapshots, a bounded
isolated restore drill, private leaf-certificate renewal and guarded offline
managed Auth data-key rotation. The operator tools require explicit execution;
host mutations retain their receipts and recovery material.

The configuration was parsed with the official checksum-verified Docker Compose
5.6.1 standalone binary. PostgreSQL/PGlite custody tests, local protocol tests,
configuration/crypto tests and controlled loopback HTTP/TLS tests provide local
evidence. No Docker daemon, production hostname, model evaluation approval,
provider credentials or signed physical-device run is supplied by this source
package. There is no host-deployment or release-qualified receipt here.

## Version provenance

`upstream/` is an unmodified snapshot of the official Supabase Docker files at
commit `a05e7ec1d79e67cba65e3871b7caf105db27f8b1` (31 October 2026). `UPSTREAM.json`
records each original path and SHA-256. `IMAGE_PINS.json` records the published
DockerHub digests for the ten upstream service images. The override uses those
immutable digests except for the explicitly recorded Edge override below.

The upstream Compose PostgreSQL tag was 17.6.1.136. This profile instead pins the
published `supabase/postgres:17.11.0.003` digest, accounting for the documented
17.11 security fixes and the 17.11.0.003 timezone correction. This selection is
verified registry metadata, not a claim that this exact image has run here.

Edge uses the existing exact-version harness pin, ECR
`supabase/edge-runtime:v1.77.8@sha256:178c041398a33ded8219344382d0672a90051d1babbf0af03425cafe20039a75`,
instead of regressing to the upstream Compose file's 1.77.4. Its user-worker
root-certificate provider uses `SSL_CERT_FILE` with `DENO_TLS_CA_STORE=mozilla,system`;
the profile also supplies `DENO_CERT` for compatible Deno paths. Actual Edge TLS
and current application behavior remain host qualification gates.

Private Node services use Node 24.22.2 and the workspace lockfile; Caddy uses
2.11.7, both pinned by digest. Inference builds the current `services/ml-face`
source on the target host. Record its resulting image digest and approved
evaluation evidence before enabling biometric operation readiness. Do not reuse
an older published inference image as evidence for the changed source.

Relevant upstream references:

- [Pinned Supabase Docker source](https://github.com/supabase/supabase/tree/a05e7ec1d79e67cba65e3871b7caf105db27f8b1/docker)
- [PostgreSQL 15.19/17.11 upgrade changes](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes)
- [Auth external URL prefix](https://supabase.com/changelog/47093-self-hosted-supabase-api-external-url-to-include-auth-v1)
- [Envoy default gateway](https://supabase.com/changelog/48048-self-hosted-supabase-envoy-becomes-the-default-api-gateway-b)
- [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart)
- [Queued pg_net credential visibility](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)
- [Docker Compose merge rules](https://docs.docker.com/reference/compose-file/merge/)

## Exact endpoint and trust contracts

| Purpose | Selected value | Boundary |
| --- | --- | --- |
| Public Supabase origin | `https://<owned-hostname>` | Caddy, publicly trusted TLS |
| Public Lovelies API | `https://<owned-hostname>/functions/v1/lovelies-api` | Mobile/admin/public runtime input |
| Internal Supabase | `http://api-gw:8000` | Exact trusted private origin; no published port |
| Restore journal | `https://restore-journal:8443` | Private CA; runtime or separate bootstrap token |
| Push ledger | `https://push-ledger:8443` | Private CA; runtime or separate bootstrap token |
| Push gateway | `http://push-provider:8091` | Exact private origin plus independent service bearer |
| Inference | `https://ml-proxy:8443` | Private TLS plus `ML_INFERENCE_SECRET`; private proxy to port 8080 |
| Application database | `db:5432` | Explicit internal plaintext profile; no host port |
| Custody database | `custody-db:5432` | Separate private network and role credentials; no host port |

The private PostgreSQL transport exception is scoped to exact Docker hostnames.
Remote database operation must use `verify-full` and a matching trusted CA; no
arbitrary hostname, query-string option or cloud fallback makes plaintext valid.
The API login role is `lovelies_runtime`, with NOINHERIT and SET authority into
the `lovelies_api` NOLOGIN role. Migration guards require that `lovelies_api`
remain NOLOGIN. The custody roles have no schema ownership, role management,
cross-schema access, DELETE or DDL authority.

Caddy exposes only 80/443. Studio binds to host loopback 127.0.0.1:54323 for an
operator tunnel. Auth remains internal: clients never receive the GoTrue tokens
or Supabase keys. Public `/auth/v1/**` and the internal maintenance route return
404. The single-function router admits only `lovelies-api`; the upstream demo
functions are not public application endpoints.

Caddy overwrites `X-Lovelies-Client-IP` with its actual remote peer. This profile
assumes Caddy is the Internet-facing peer. Qualify a different trusted proxy
chain explicitly before deployment. The GoTrue anonymous quota is aggregate for
the server-held Auth integration. The generated 600/hour setting is an initial
staging input, requiring workload and capacity qualification.

## Generate a new private configuration

Use a dedicated operator account, Docker Engine and Compose with support for
`!reset` (syntax floor 2.24.4; this profile was checked on 5.6.1). Review current
engine/Compose security updates on the deployment host. Run one profile per
host; the named volumes and upstream container names are deliberate identities.
The tool refuses to adopt an existing unlabelled volume.

Build the public site with the root-owned `scripts/prepare-public-site.py`, then
stage it using the existing preview server's exact public allowlist:

```sh
python scripts/local-supabase-stage-public.py \
  --public-site /srv/lovelies-web-build/public \
  --output /srv/lovelies-release
```

Use the staged `/srv/lovelies-release/public` directory below. The stage contains
only allowed public/admin/client files and shared images, copied using no-follow
file reads. Configuration checks verify its full hash inventory and reject extra
files or symlinks. The proxy mounts this stage; it never mounts the repository's
admin or client source directories. Controlled actual-Caddy tests verify that
admin/client test files, repository internals, Auth and maintenance routes are
unavailable.

```sh
node scripts/local-supabase-configure.mjs \
  --host api.your-owned-domain.example \
  --email operations@your-owned-domain.example \
  --runtime /srv/lovelies-private/runtime \
  --public-site /srv/lovelies-release/public

node scripts/local-supabase-check.mjs \
  --runtime /srv/lovelies-private/runtime --docker \
  --receipt /srv/lovelies-evidence/configuration-check.json
```

Choose real owned DNS and operator addresses. The parent of the new runtime
directory must exist. The generator refuses to overwrite an existing directory.
Runtime files and keys are private; do not commit, publish or log them. The
non-secret `config.json` is the common endpoint contract for operational tools.
Use the parser in `local-supabase-common.mjs`; do not execute `.env` files as shell
code. A root-owned generated runtime runs the service containers as root with
dropped capabilities; use a dedicated non-root operator for production files.

The generator intentionally leaves model/artifact/policy pins empty and provider
sends disabled. It creates distinct database, JWT, capability, managed Auth AES,
media, maintenance, custody, observer and provider-service secrets. It creates
private 90-day service leaf certificates under a separate local CA. Keep the CA
private key and backup encryption key in controlled offline recovery custody.

## Initial installation and migration

```sh
node scripts/local-supabase-operate.mjs initialize \
  --runtime /srv/lovelies-private/runtime --execute \
  --receipt /srv/lovelies-evidence/initial-install.json
```

This creates labelled external volumes, starts independent custody, starts the
local Supabase base services, applies the exact ordered existing SQL files,
records successful source hashes, creates the restricted login role, creates the
three private 20 MiB buckets and initializes authority only at genesis. It then
installs protected maintenance and starts the API and disabled push gateway.
Public ingress and inference remain separate explicit operations.

The migration inventory is `lovelies_deployment.applied_migrations`. A failed
script does not receive a completed inventory record. A modified earlier file
or existing schema without this inventory is preserved for operator review.
Use this same migration path for later additions; coordinate a deliberate
history reconciliation before switching to a different migration runner.

Initial journal binding is allowed only with no accounts, managed Auth users,
Storage objects or non-genesis marker. An exact interrupted genesis retry may
verify the existing initial marker; it never updates that row. Any advanced or
restored copy requires recovery. The API has no implicit bootstrap path.

Cron invokes the private maintenance endpoint every minute. The bearer lives in
Vault; no credential is embedded in the checked-in SQL. On this self-hosted
installation the real owner revokes default `pg_net`/Vault grants and verifies
that API roles cannot read queued credentials or invoke scheduling directly.
Recheck these negative grants after extension, webhook or PostgreSQL upgrades.
The owner and pg_net worker retain the privileges they need.

## Providers, inference, and ingress

Use current protected provider files, the existing app identities and the
`provider-generation.mjs` inspection command to derive the actual generation.
That command does not send a notification. The v2 custody protocol permits a
generation activation only after the current generation is fenced and all
started intents are settled. Unknown outcomes remain blocking evidence. Never
delete a binding, invent a generation hash or bootstrap over history.

For recovery set `PUSH_RECOVERY_ONLY=true`, restart the gateway, and keep the
ordinary API fenced. Recovery mode does not load provider credentials or admit
plans/sends. It permits exact historical lookup and subject/plan retirement.
`/ready` remains unavailable. Returning to normal operation requires actual
provider generation and delivery qualification, not changing one boolean.

The separate inference profile builds the current source:

```sh
node scripts/local-supabase-operate.mjs inference \
  --runtime /srv/lovelies-private/runtime --execute \
  --receipt /srv/lovelies-evidence/inference-build.json
```

Install the approved model, policy, artifact and processing fingerprints into
the private API environment. Preserve `ML_DEPLOYMENT_TRANSPORT=https_service`
and the matching independent inference secret. Native model evaluation, current
image provenance and resource limits remain required release evidence.

After the release's configuration/domain/security gates, `operate.mjs publish`
starts the configured public proxy. This command's receipt is a start record,
not a claim that operational qualification passed.

## Real host qualification

```sh
node scripts/local-supabase-qualify.mjs \
  --runtime /srv/lovelies-private/runtime --execute --restart-custody \
  --receipt /srv/lovelies-evidence/host-qualification.json
```

Run this on the intended staging host and candidate before production. It checks
actual running container configuration, trusted public HTTPS, schema 19, full
readiness, blocked public routes, ordered migration hashes, actual database role
denials, managed Auth signup/refresh/logout, private Storage byte integrity and
client denials, synthetic cleanup, Cron delivery and optional custody restart.
Synthetic users and objects belong only to this run and are removed afterwards.
If cleanup fails, inspect those resources before retrying.

The output includes sanitized effective-configuration and ordered migration
inventory sidecars with exact hashes, the source commit and dirty-tree status,
and observed image digest. An optional `--backend-artifact` hashes an operator
supplied candidate; it is explicitly not proof that its bytes were installed.
The release gate separately requires candidate-to-container binding. No partial
host or restore receipt is relabelled as the gate's passed deployment/task
qualification envelope.

## Coherent backup, expiry, and restore drill

`local-supabase-backup.mjs create` stops only previously running application
writers and ingress, disables the Lovelies Cron job, captures one complete app
database snapshot (including Auth and private metadata), captures Storage bytes
and the Vault configuration volume, and captures independent custody separately.
Runtime recovery keys are a separately encrypted escrow component. It verifies
that custody did not change during the quiesced snapshot and resumes only the
services and schedule that were previously running. `resumption.json` reports
that outcome even if capture fails.

All components stream through AES-256-GCM with distinct derived keys, authenticated
component identity and hashes. The manifest has an independent HMAC. The backup
key is not included in the snapshot. The coordinated format is distinct from
the older app-schema-only backup format; never substitute one for the other.
Managed Auth requires `auth` and `lovelies_private` from the same snapshot and
the correct encrypted recovery key material.

```sh
node scripts/local-supabase-backup.mjs create --execute \
  --runtime /srv/lovelies-private/runtime \
  --directory /srv/lovelies-backups/snapshot-new \
  --receipt /srv/lovelies-evidence/snapshot-new.json

node scripts/local-supabase-backup.mjs verify \
  --runtime /srv/lovelies-private/runtime \
  --directory /srv/lovelies-backups/snapshot-new
```

Snapshots expire after seven days. `expire --execute` removes only an authenticated
expired bundle with the expected file inventory. Unknown files are preserved.
`local-supabase-backup-scheduled.mjs --runtime ... --directory ...` creates a new
dated snapshot and expires eligible prior bundles. Install it in the host's
controlled timer and monitor its result; scheduling source alone is not proof of
successful operated backups. The host-operation lock prevents overlapping
backup/provision/certificate operations. After a killed process, inspect its
record and service state before deliberately removing a stale lock.

Use two actual snapshots from the same database incarnation, an older app copy
and a newer independent custody copy:

```sh
node scripts/local-supabase-restore-drill.mjs --execute \
  --runtime /srv/lovelies-private/runtime \
  --snapshot /srv/lovelies-backups/older \
  --custody-snapshot /srv/lovelies-backups/newer \
  --receipt /srv/lovelies-evidence/isolated-restore.json
```

The drill restores only newly named, isolated containers/volumes with no public
ports or outbound network. It verifies authenticated Storage bytes and metadata,
the old database marker, denial by newer custody and quarantine after restart.
It stops and preserves its isolated resources for inspection. It does not restore
the serving custody database or automatically clean up evidence.

Complete the existing recovery-v2 controller against the isolated candidate,
including managed Auth retirement, push retirement, restriction replay,
inventory/absence proofs, pending effects, and computed serving completion.
Then repeat application-negative access and actual provider/device scenarios.
The supplied drill explicitly leaves these later gates unrun; it cannot declare
full recovery based only on a successful `pg_restore` or a quarantine response.

The `operations` Compose profile supplies a private operator image with the
frozen `@lovelies/supabase-api` production dependencies and the canonical
Node 24 `--experimental-transform-types` recovery entrypoint. It receives the
private API environment, Storage secret and trusted custody CA, and joins only
the application/custody networks. Use its `status`, `begin` or bounded `step`
command with the chosen recovery UUID; it exposes no port. A recovery-only push
gateway may be selected with `PUSH_RECOVERY_SERVICE_URL` and
`PUSH_RECOVERY_SERVICE_SECRET`; otherwise the configured private push gateway is
used. Recovery invokes subject retirement/proof, never a new send. The controller
requires current managed Auth, capability, media and provider-generation inputs
and will keep ambiguous provider creation or delivery work fenced.
The operator entry point also requires an open persistent lifecycle gate with
the configured managed Auth key fingerprint. It cannot automatically resume
recovery while an offline key rotation is pending.

Keep custody outside application rollback procedures and backup permissions.
Separate projects/volumes provide that logical boundary on one host. A whole-host
or whole-custody rollback is a distinct incident: hashes within the rolled-back
store cannot prove their own freshness. Stop admission, preserve the incident
copies and reconcile independent retained evidence/provider outcomes. Operational
custody location, host isolation, offline key custody and incident ownership must
be qualified for the selected infrastructure.

## Credential and certificate rotation

`local-supabase-rotate-certificates.mjs --runtime ... --execute --receipt ...`
renews private service leaves under the same CA, verifies each SAN/signature,
preserves protected prior leaves and recreates the affected services. It does
not rotate a data key or rebind protocol authority. Rotate the CA with overlapping
trust on every Deno/Node client before replacing certificates; a near-expiry CA
blocks this leaf-only helper.

Database passwords, service bearer tokens and Supabase signing keys require a
coordinated staging/restart/readback procedure. Keep old keys in controlled
recovery custody for the current backup horizon. Rotating Supabase JWT signing
keys invalidates server-held Auth access credentials and requires refresh/recovery
qualification. The distinct `MANAGED_AUTH_ENCRYPTION_KEY` has a dedicated offline
operator workflow described below. Provider key changes require a new fenced
generation. These different credentials have different recovery semantics.

### Managed Auth encryption-key rotation

`scripts/local-supabase-rotate-managed-auth.mjs` implements a planned outage for
this one AES-256-GCM key. It preserves every managed Auth binding and authority
column, including expired, prepared, ambiguous and retiring credentials. It
does not call the Auth provider or write `auth.*`. Every non-null ciphertext is
authenticated with the original account, incarnation, Auth user and Auth session
AAD; exact token IDs and expiry must still match the row. A corrupt or mixed-key
row prevents the entire rewrite.

The generated `rotation.env` holds a separate private database login. Bootstrap
provisions that NOINHERIT role with SET authority into the existing NOLOGIN app
role and SELECT/INSERT on an operator-only receipt table. It receives no receipt
UPDATE/DELETE/TRUNCATE privilege. The runtime and app roles cannot read that
table or enter the operator role. The worker checks its privilege and SQL logging
boundaries before reading ciphertexts.

Choose and retain one new UUID for the operation. Build the current private
operator image on the target host before invoking these commands. Keep the
private runtime directory, its encrypted backups and the separate backup key
under the approved operator recovery custody.

```sh
node scripts/local-supabase-rotate-managed-auth.mjs rotate --execute \
  --runtime /srv/lovelies-private/runtime \
  --rotation-id REPLACE_WITH_ONE_NEW_UUID

node scripts/local-supabase-rotate-managed-auth.mjs verify --execute \
  --runtime /srv/lovelies-private/runtime \
  --rotation-id THE_SAME_UUID

node scripts/local-supabase-rotate-managed-auth.mjs resume --execute \
  --runtime /srv/lovelies-private/runtime \
  --rotation-id THE_SAME_UUID
```

The first command creates authenticated encrypted escrow containing both keys
and the exact before/after API configuration. It durably records the gate and
disables new `lovelies_runtime` database logins before disabling the protected
Cron job and stopping application writers and ingress. Existing runtime database
sessions must be absent before the worker can rewrite anything.
Before closing the gate, the command verifies the static inputs, effective
Compose environment and running Edge environment against the exact local
`db:5432/postgres` database and `lovelies_runtime` credentials. A different
database, TLS profile or inherited database URL is rejected.
It then takes the shared advisory transaction lock, admits the current restore
lineage, authenticates every row in bounded pages and re-encrypts with fresh
96-bit IVs. The journal's next marker, full-row digest receipt and all ciphertext
updates commit in the same SQL transaction. SQL admission, explicit intent,
prepare and committed acknowledgement use the existing restore-fence protocol.
An empty table still requires its own committed receipt and next marker.
The worker reads 128 rows at a time and refuses an inventory above one million
rows or any numeric value outside JavaScript's exact integer range. A refusal
rolls back the complete rewrite; do not work around it with partial batches or
mixed keys. Size the offline window and qualify these bounds on the target host.

After exact database and journal readback, the API environment changes by an
atomic compare-and-swap against its original bytes. A third configuration state
is preserved for review. `rotate` and `verify` leave writers stopped. They do not
open traffic. Repeating the same operation can verify an already committed
receipt; it never blindly re-encrypts a state with a missing acknowledgement.

`resume` requires the exact new configuration and a fresh complete database
readback. It starts the API in verification-only mode, where the Edge main
worker permits only GET requests for the exact normalized health and readiness
paths. Every request reads the current gate and compares it with the process's
actual key fingerprint. Private probes require schema 19 and managed Auth
readiness, then recheck the full row digest and independent receipt. Only after
durable resumption authorization does the last atomic gate update open normal
requests and restore the prior scheduler/ingress state. This limited readback
does not qualify inference, providers, devices or the overall release.

The gate's **directory** is mounted read-only into Edge and the recovery operator,
so atomic file replacement remains visible. Missing, malformed or symlinked
gate state fails closed. A Docker or host restart cannot open an incomplete
rotation. Other host mutation helpers reject a closed lifecycle. A killed
orchestrator can leave `host-operation.lock`; inspect its PID and service state
before deliberately clearing a stale lock and using the same rotation ID.

The operation directory retains encrypted escrow, authenticated immutable intent,
the database receipt and private runtime readback. Immutable files are staged
and fsynced before atomic no-replace publication; a retry can finish a recognized
same-inode publication interrupted after its final link. Unknown links and
malformed records remain preserved. Configuration retries finish file and parent
directory durability even when the exact new bytes are already present.
A lost SQL COMMIT reply is
resolved only by the exact receipt, full new-key row digest and independent
acknowledgement. A lost configuration rename reply is resolved only by the exact
planned bytes. Unknown or corrupted state never triggers automatic resumption,
credential clearing or replacement custody.

For the specific case where the independent journal accepted preparation but
the SQL transaction rolled back, `abort` can invoke the existing restricted-abort
reconciliation. It requires the exact expected marker, unchanged full old-key
row set, no positive receipt, no other pending/recovery generation, and the exact
original v1 plan with no events, allocations or cursor movement. It cannot
reconcile a foreign restriction plan or undo a positive key rotation. The
negative receipt and recovered-operation marker commit together; a fresh
transaction checks both, every old-key row and the independent recovered state.

```sh
node scripts/local-supabase-rotate-managed-auth.mjs abort --execute \
  --runtime /srv/lovelies-private/runtime \
  --rotation-id THE_SAME_UUID

node scripts/local-supabase-rotate-managed-auth.mjs resume-aborted --execute \
  --runtime /srv/lovelies-private/runtime \
  --rotation-id THE_SAME_UUID
```

`abort` leaves writers stopped and the original configuration intact.
`resume-aborted` is the explicit old-key readiness path, bound to the distinct
negative receipt and encrypted escrow. It follows the same private health,
managed Auth, full-row and journal readback gates as positive resumption. The
original rotation ID remains permanently terminal; any future rotation needs a
new operator intent. Nonempty, foreign or otherwise unrecognized recovery state
remains closed for controlled recovery rather than being generalized into this
narrow helper.

Retain the old key escrow for **every** database snapshot still within retention;
do not delete it merely because the new runtime is healthy. The encrypted
runtime snapshot now includes the rotation records, lifecycle and operator
configuration. The backup master key remains separate. Exact-host execution,
reboot/crash drills, offline escrow retrieval and operated rotation evidence are
still required before H08 can be accepted for production.
