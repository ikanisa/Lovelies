# Cloudflare backend and registered-face sign-in

Owner direction, 13 October 2026: all backend hosting and databases use
Cloudflare. Face sign-in verifies a fresh camera capture against the face
registered with Lovelies. This supersedes the earlier specification's exclusion
of face authentication. Existing photo, sharing, entitlement, recovery and
privacy boundaries remain.

The active port uses a Worker, an authoritative SQLite-backed Durable Object,
private R2 storage and Cloudflare processing/verification service bindings.
Account, credential, consent, source, matching, review, request and grant records
share one transactional authority. There is no Supabase/PostgREST fallback.
The imported PostgreSQL backend and its evidence are retained as history.

Registered-face authentication uses an expiring one-use server challenge,
the existing account-level registered profile, explicit authentication-purpose
consent, a registered device key and a trusted verification result. The server
checks the exact capture, nonce, account, profile/model version and current
credential/consent state. Missing model service or invalid face comparison refuses a session.
No liveness/PAD, blink/head-turn or camera-injection qualification is required. A photo-matching candidate cannot authenticate an account.
Default authentication creates a restricted anonymous session. Exactly three
enrollment captures bind the initial account-level profile; trusted verification
automatically upgrades that same account to a registered-face session and revokes
the anonymous credential. Subsequent verification compares a fresh selfie against
the exact existing profile. There is no OTP flow. Anonymous credentials do not
authorize matched-photo access or reviewed sharing.

Anonymous sessions are Lovelies application sessions implemented on Cloudflare
Workers and SQLite Durable Objects. This is not Cloudflare Access SSO or an
assertion that Cloudflare supplies a managed consumer anonymous-auth product.
The app sends the existing camera enrollment captures; backend services verify
them and create/revoke sessions without an additional sign-in screen.

The implemented core is at `services/cloudflare-api/src`. The default commands
and `backend/local-entry.ts` use it. The account/session, enrollment, photo
preferences, bounded upload, queued matching, protected gallery, immutable
sharing review, exact recipient acceptance, profile and privacy routes run on
Cloudflare's runtime and SQLite authority. Unsupported legacy routes have no
database fallback.

Sharing captures the private processor's source, profile, consent and model
evidence. Snapshot, exclusions, final recipient subset and commit preserve the
actual graph. Commit creates pending requests with zero grants; acceptance
revalidates the exact approved subset in one transaction. Lost responses use
the original operation key. Changed consent, account, model, source, block or
profile state cannot create access. Ordinary personal batches retain their ownership checks. Photographer roles and
professional upload/sharing modes were removed on 16 October to match the current
frontend; legacy data remains inaccessible through those retired modes and stays
subject to privacy cleanup.

Privacy export/deletion requires independent approval. Exports exclude peer
graphs and credentials and use current-session, one-time grants. Deletion
disables the account and retires authority atomically, redacts its counterpart
records, and verifies private object cleanup while preserving unaffected
approvals and retained audit/financial evidence. An unresolved storage writer
blocks completion. Existing weaker SQLite schemas are rejected without wiping
or silently altering their objects.

The database uses [Cloudflare SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
One authority provides transactions across sender and recipient records;
capacity and performance qualification remain required before a scaled release.

The following core checks were recorded before the completed face-service and
remaining-capability port. They remain historical evidence for that earlier
slice; current native-port results follow below.

| Check | Actual result |
|---|---|
| Cloudflare runtime | 38 passed, zero failed/skipped; actual workerd, SQLite DO, R2 and Queues with explicitly synthetic private verifier/processor fixtures. Includes the real Fetch SDK calling the real Worker. |
| Schema and privacy units | 22 passed, zero failed; actual local SQLite transactions, immutable records, approval and cleanup failure cases. |
| Reusable client | 27 passed, zero failed; anonymous enrollment, automatic same-account upgrade, signed capture transport, session fences and reviewed sharing. |
| Typechecks | Worker and Node test projects passed. |
| Application bundle | Wrangler 4.112.0 dry-run passed; no deployment. The bundle excludes fixture SQL controls, OTP, Supabase and PostgREST. |
| Running local API HTTP | 14 checks passed, including a real anonymous token, restricted photo access, logout and unavailable unconfigured face verification. No new unhandled stream errors after the bounded control-body repair. |
| Preview HTTP | Six tests passed; six actual running-server readbacks passed. All three public client modules are served; configuration is denied. |
| Preservation | All 405 historical imports and their donor source hashes match; 519 recorded native/browser/reference paths match. The earlier sealed backend record is unchanged. |

Source, logs and bundle hashes are bound in
[the current verification record](../verification/cloudflare-face-auth/final-results.json).
The earlier test results describe the historical backend only. Failed and
diagnostic runs are retained: unfinished initial exports, Miniflare inspector
setup/deadlock, the pinned runtime's unsupported `redirect:error`, Node test
type declarations, missing hot-reloaded local signing configuration, native
HTTP control-body relay errors and the overwritten private export cache header.
The repairs retain authorization and original privacy assertions.

The guarded preview remains on `http://127.0.0.1:8765/preview/index.html`, and the
current API on `http://127.0.0.1:8787`. Ignored, mode-0600 local signing keys were
generated for development; no donor credentials were copied. `/health` probes
SQLite; `/ready` remains unavailable for the missing private verifier/processor
bindings and their policy/model configuration.

## Completed native and remaining-capability port

The target now contains the copied MEMORIES `services/ml-face` implementation,
the YuNet and SFace ONNX models, and a Lovelies-only private adapter. A
normalized source comparison before the Docker repair found 586 donor files byte-identical, two
modified donor files (`Dockerfile`, with three package-name changes, and this
port-specific `README.md`), no missing donor files, and five Lovelies-only
additions. The two model hashes and licenses are in
`services/ml-face/models/model-manifest.json`. Their local evaluation status
remains monitored-pilot; model smoke tests do not qualify production thresholds
or identity assurance.

Cloudflare routes face verification and photo processing through private
`FaceVerifier` and `PhotoProcessor` bindings. `services/ml-container-worker`
defines those service entrypoints and a Cloudflare Container with runtime
internet egress disabled. Wrangler dry-runs validate Worker bindings and
Container configuration; they do not build the large Container image or deploy
it. The Worker’s SQLite Durable Object remains the single authority for
anonymous bootstrap, challenge and consent state, registered-profile ownership,
session upgrade, exact photo-recipient approval and all new backend route
families. Account access upgrades automatically after backend face verification;
there is no OTP flow or client-side face matcher.

The Android and iOS repositories now use the Cloudflare face/session protocol.
They create an anonymous session first, capture three signed registration
selfies, and adopt the backend-upgraded session. Returning registered devices
submit a fresh signed selfie to the server. Face enrollment and login are
backend comparisons against the stored reference. The UI does not run a face
model; there is no OTP or liveness/PAD step. The unchanged reference-screen
gallery remains a separate fixture mode.

Current locally verified results are recorded in
`verification/cloudflare-native-port`:

| Check | Actual result |
|---|---|
| Worker typecheck | Worker and Node test projects passed after the final test-helper correction. |
| Cloudflare API units | 56 passed, zero failed. |
| Cloudflare workerd runtime | 46 passed, zero failed or skipped; actual SQLite DO, R2 and Queues, with explicit fixture private-provider bindings. |
| Backend client | 27 passed, zero failed. |
| Real face journey | Actual workerd/SQLite DO/R2/Queue and the target Python YuNet/SFace model passed anonymous enrollment, same-account upgrade, private photo processing, proposal-only matching, exact recipient acceptance, reduced private preview, entitlement denial, fresh-face login and one-use challenge replay checks. Inputs were provided reference-photo variants, not physical camera captures. |
| Python model service | 719 passed and 1 skipped in the imported deterministic suite; a separate 8-test real-model run passed (five Lovelies adapter checks and three model smoke checks; those three smoke checks overlap the imported-suite count). |
| Private ML Worker | Typecheck passed, 5 service-security tests passed, and Wrangler configuration dry-run passed. |
| Cloudflare Worker bundle | Wrangler dry-run passed at 1228.96 KiB (226.01 KiB gzip) with Durable Object, R2, Queue and both private service bindings. No deployment. |
| Android | `:app:testDebugUnitTest` and `:app:assembleDebug` passed; 19 tests passed across protocol and bounded HTTP transport suites. No physical device was connected. |
| iOS | All Swift sources parsed; the project and both Info plists passed `plutil`; 23 CoreWire checks and 25 native connection/CryptoKit checks passed on the macOS host. Full Xcode/iOS SDK and simulator are unavailable, so there is no iOS build or device acceptance. |

The full Dockerfile image build was attempted in earlier diagnostic runs but
did not complete: the uncached build hit an upstream digest mismatch and a
subsequent runtime-layer attempt lacked `/bin/sh`. A local cached-runtime build
did pass its model-integrity startup assertion. Only 13 GiB remained available
on the 97%-full 460 GiB volume, so the large uncached build was not retried.
Wrangler dry-runs validate Cloudflare configuration and bindings; they do not
build or deploy that image. There has been no hosted deployment, production
migration, paid provider call or store release. Physical-camera and physical-device Keystore
acceptance, a supported Xcode/simulator build, Cloudflare deployment, Apple and
Google store-provider configuration, push-provider receipts and model operating
evaluation remain open gates. No liveness/PAD, movement challenge or
camera-injection qualification is required under the owner's current policy.

## Docker repair and actual native HTTP journeys

The next source build replaced the retired libpng download URLs with the exact
hash-verified Debian source archives and descriptor in the target checkout.
An exec-form preflight now rejects a completed, minimized release image as an
optional installation-stage runtime. The default still builds the source
components, installs their verified replacements before minimization, and
exports a nonroot scratch runtime. Source/patch hashes and codec, ABI and
hardening controls are unchanged.

The repaired libpng source stage completed successfully. The full default build
then failed because Docker's backing volume on PRO-G40 filled and its internal
filesystem became read-only; Docker could not restart with approximately
32 MiB free. No completed new image or Docker-backed journey is claimed. An
inventory identified six replaceable generated Gradle 8.14/9.1 cache paths.
The owner subsequently authorized their deletion; the 14 October receipt
records about 10.31 GiB freed and preserves active Gradle 8.13, dependency
downloads, SDKs, Docker data and projects. Docker recovered. The subsequent
canonical namespace-capable glibc run compiled successfully, passed 25 of 27
required fixtures, and failed two allocator families under Rosetta. Its source
and test outputs are preserved for faithful x86 Linux execution. OpenSSL's
upstream suite passed (347 files, 4,932 checks); package, ABI and hardening
readbacks passed. The new final image and Docker-backed native runs remain
unaccepted. See [current build evidence](../verification/docker-native-journey-20261014/README.md)
and [remaining submission tasks](remaining-submission-tasks.md).

Native verification continued against separate fresh Cloudflare local state
directories and the real target YuNet/SFace service on the host. The real wire
responses exposed an iOS personal-source contract mismatch and an Android
domain-source validation mistake. Those are fixed. Sharing and protected media
required an explicit matching personal/professional source in that historical run.
The current frontend-aligned contract accepts only personal media; unrelated account,
privacy and safety operation sources retain their domain meaning. Missing or
mismatched sharing sources cannot consume the reviewed receipt or operation.

| Check | Actual 13 October result |
|---|---|
| Android build and units | Debug and instrumentation APKs built; 24 unit tests passed, zero failed/skipped. |
| Actual Android journey | 19 checks passed on an API-36 emulator using production repository/HTTP, Android Keystore, ContentResolver and FileProvider, actual workerd/SQLite DO/R2/Queue, and the real host model service. |
| Android connected screens | Actual gallery → photo → matched people → pair/global-person exclusions → final immutable preview exercised; seven states captured across six routes. Additional UI review contained only P4/Aline after excluding Eric. |
| Swift protocol checks | 26 wire checks and 25 connection checks passed; all 18 app/test Swift files parsed. |
| Actual Swift HTTP journey | 15 stages and 140 assertions passed with production repository and URLSession HTTP, CryptoKit software signing and an in-memory host secret store. Full Xcode/iOS SDK remains absent, so no iOS app/UI/camera build is claimed. |
| Approved sharing graph | Both native clients verified P1/Aline, P2/Aline+Eric, P3/Eric and P4/Aline+Eric; excluding P3 and P4/Eric yielded Aline P1/P2/P4 and Eric P2: three distinct photos, two recipients, four approved pairs. Candidates and commit created no access; exact recipient acceptance did. |
| Authentication/access fences | Automatic same-account upgrade after three signed enrollments, revoked old anonymous session, separate purpose consent, fresh one-selfie registered comparison, replay denial, private approved previews and actual missing-entitlement denial. No OTP or liveness flow. |

Inputs are supplied reference-photograph variants, not camera captures or sensor
evidence. The representative model operating evaluation, physical-camera/device
behavior, iOS rendering, hosted Cloudflare deployment and store release remain
separate unresolved gates. Current paths, hashes, successful runs and preserved
failures are in
[the native journey record](../verification/docker-native-journey-20261013/README.md).

## Anonymous deletion and current native regression

The active SQLite schema is now version 3. Its additive migration preserves
existing accounts, credentials and operations and adds a deletion-status receipt
independent of erased sessions/operations. A current anonymous account can
request only its own deletion, without face enrollment. Export, gallery,
uploads, sharing, private media and administrative operations retain their
registered-face guards. Existing independent review, legal holds, writer fences
and verified private R2 cleanup still apply.

Native clients commit the original encrypted key/token/account/origin before
dispatch and restore that hold before bootstrap. The server retains only the
token hash; metadata containing the supplied secret is rejected before writes.
Uncredentialed status reveals only the bound lifecycle, not account/reviewer
identity or media authority. It survives credential erasure for 30 days and
distinguishes the existing seven-day request expiry. Completion is reported only
after the stored deletion job finishes verified cleanup.

Android and iOS now provide pre-enrollment confirmation, private status, exact
request reconciliation, explicit same-account resume after rejection/expiry and
explicit restart after completion. Local persistence and task/session fences
were repaired and covered by regression tests. [The protocol](anonymous-account-deletion.md)
and [current source-bound results](../verification/anonymous-deletion-20261014/README.md)
record all checks, retained failures, exact inputs and platform limits. No hosted
deployment, destructive production migration or store release occurred.
