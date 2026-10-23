# Lovelies native frontend

Native Android (Kotlin/Compose) and iOS (SwiftUI) applications using the owner-selected Supabase backend. Anonymous sessions upgrade automatically after backend selfie enrollment. No OTP or liveness check. The original 48 screens remain available in explicit reference mode; the browser companion compares them with the source images.

## Supabase backend

The owner-selected backend is Supabase project `ltqfplqevxztlswlzexn`.
`services/supabase-api` owns PostgreSQL transactions and private Supabase Storage,
with a separately authenticated private YuNet/SFace inference service. The
Cloudflare implementation remains available as preserved source/provenance.
See [architecture and deployment inputs](docs/supabase-backend.md) and
[current implementation and verification](docs/release-implementation-status.md).

Anonymous app sessions upgrade only after the backend verifies all three signed
profile captures. These are custom current-authority sessions, not Supabase
managed Auth users. No privileged Supabase key is included in either native app
or the operator browser.

```sh
pnpm install --frozen-lockfile
pnpm backend:typecheck
pnpm backend:test
pnpm backend:client:test
pnpm backend:build
```

`backend:build` checks the production Edge entrypoint using Deno. Local development
uses `node --env-file=/absolute/private/config.env --experimental-transform-types
scripts/dev-supabase.mjs`. Supply the server-only settings in
`services/supabase-api/.env.example`; the runner binds only loopback and never
initializes a database, provisions buckets or substitutes a fake model/provider.
Apply reviewed migrations and provision private buckets separately. `/health`
checks the actual schema, and `/ready` additionally checks required bindings.
Those probes do not establish provider, model, device or operational acceptance.

## Review

Run from this folder:

```sh
python3 scripts/serve-preview.py --port 8765
```

The [Lovelies operator workspace](http://127.0.0.1:8765/admin/) is also served
by this command. Its normal entry requires signed face authentication and a
server-provisioned administrator role. The original synthetic design is available
only through the explicit loopback `?preview=1` route.
See [admin design and verification](docs/admin-panel.md).

Open [the clickable screen review](http://127.0.0.1:8765/preview/index.html). Choose any of the 48 screens, follow its controls, and enable the reference comparison. The browser companion does not substitute for either native application.

## Android

Open `android/` in Android Studio, or run `./gradlew assembleDebug` from that folder with JDK 17 or later and Android SDK 36 installed. Install the resulting debug APK on an emulator or device.

The application ID is `com.lovelies.memories`, preserving the existing Play listing.
The internal namespace remains `com.lovelies.frontend.preview`. Reference screens
are Debug-only and never authenticate a live session. Screen-specific review is available through the screen catalogue and the launch argument:

```sh
adb shell am start -n com.lovelies.memories/com.lovelies.frontend.preview.MainActivity --ez review true --ei screen 10
```

## iOS

Open `ios/Lovelies.xcodeproj` in full Xcode, select the `Lovelies` scheme and an iPhone simulator, then run. The target requires iOS 17 or later. Device installation also requires a signing team.

Xcode27.1 and the iPhoneOS27.1 SDK are installed. The earlier unsigned Debug build
passed before this readiness slice; the changed app requires combined build and
runtime verification. Simulator initialization has an observed memory error.
The existing bundle is `com.lovelies.memories`; signing and actual store-update
qualification remain required.

## Native live behavior

Release configuration targets the selected Supabase Edge API. The native apps implement camera and
selected-photo import, encrypted credentials/device signing, private gallery,
photo/people navigation, sparse exclusions, exact recipient review, persisted
operation intents, request acceptance, profile/preferences, a notification inbox,
blocks/reports and privacy requests. Durable UI drafts, bounded background transfer retries, native store-purchase
consumers and push-device registration are implemented. Hosted/provider/OS
acceptance and remaining work are tracked in the
[submission backlog](docs/remaining-submission-tasks.md). The backend enforces approval, current
access and production-store entitlement before originals can be saved.

Guest accounts can now request deletion before face enrollment. Both native
apps preserve the original encrypted request through restart, check its private
status after credentials are retired, and recover the same guest after rejection
or request expiry. No OTP is involved. [Deletion protocol](docs/anonymous-account-deletion.md)
and [14 October verification](verification/anonymous-deletion-20261014/README.md)
record the implementation, interrupted-write/cancellation checks and current
platform limits. This closes D04's missing implementation; hosted and device
acceptance remain in the submission backlog.

Review fixtures are explicit (`review=true` on Android, `--reference-preview`
on iOS). Their sample people/photos and illustrated progress are reference
content. They never authenticate a normal session or substitute for a failed
backend. Production endpoints must be explicitly configured with HTTPS; no
hosted domain is guessed or deployed by this change.

[Backend port coverage](docs/backend-port-coverage.md) maps the borrowed donor
families, implemented handlers, changed protocols, exclusions and remaining
provider/legacy-alias boundaries. [Native journey verification](verification/docker-native-journey-20261013/README.md)
records the 13 October tests and exact inputs. Android's actual instrumented client
passed 19 journey checks and 24 unit tests; the iOS repository and URLSession
transport passed 15 real HTTP stages with 140 assertions on macOS, plus 26 wire
and 25 connection checks. Both used isolated Cloudflare local state and the real
host YuNet/SFace service with declared photograph fixtures. Android connected
screens were also exercised through gallery, photo, recipients, exclusions and
final review. Those checks did not exercise the iOS application or camera;
the newer source-bound records below distinguish current tooling and results.

The Dockerfile now vendors the exact pinned libpng source inputs and rejects a
minimized release image as an optional installation-stage input. Its libpng
source builder passed. The six approved generated Gradle caches were removed
and Docker recovered. The namespace-capable C-library build compiled and passed
25 of its 27 required vendor tests, but two allocator families failed under
Rosetta. Its exact compiled tree and failures are preserved. OpenSSL's source
build passed its full upstream suite (347 files, 4,932 checks) and package/ABI
verification. No completed new image or Docker-backed native journey is claimed.
[Current build evidence](verification/docker-native-journey-20261014/README.md)
records this state. The older [port record](verification/cloudflare-native-port/results.json)
remains unchanged. Local checks do not establish hosted Container deployment.

## Sources and verification

Enrollment now recovers interrupted start, capture and completion replies using
the same Cloudflare account and original device key. Both native apps restore a
private journal before anonymous bootstrap, reconcile backend progress and
repair interrupted credential promotion. No OTP. A lost successful completion
requires the existing fresh-selfie comparison against the registered reference.
See [the recovery protocol](docs/enrollment-recovery.md) and
[actual process-restart/sharing verification](verification/enrollment-recovery-20261014/README.md).
Full iOS application/device and hosted acceptance remain open.

Lost-device recovery uses a saved private recovery backup and a fresh selfie
verified against the same registered reference. Both native apps persist a
separate recovery journal and new device key before dispatch. Cloudflare stores
the backup hash, consumes it on completion, revokes old devices/sessions and
restores the original account. No OTP or public face search. See
[the account recovery protocol](docs/account-recovery.md) and
[current implementation and verification](verification/account-recovery-20261014/README.md).

Own face-profile management is connected in Android and iOS Settings: replace
the registered profile, pause/resume matching, remove the reference, and
withdraw/restore authentication consent separately from photo purposes.
Cloudflare validates the original account/device key and journals exact operations;
interrupted replies and restarts recover without OTP. Reference removal waits
for verified private cleanup before three-selfie re-enrollment on the same account.
See [the lifecycle protocol](docs/face-profile-lifecycle.md) and
[source-bound implementation and verification](verification/face-profile-lifecycle-20261014/README.md).

Camera capture now handles initialization failure, interruption, permission loss
and Settings return on both native platforms. Selfies remain local for **Use
photo** or **Retake**; backend quality rejection reconciles the signed challenge
and obtains an explicit successor on the original account/device key. Unknown
ordinary sign-in replies keep their private hold through the actual challenge
expiry. See [the camera recovery protocol](docs/camera-recovery.md) and
[current implementation and actual verification](verification/camera-recovery-20261014/README.md).

Personal photo uploads now keep encrypted/protected staged sources and the
original batch, selected order, caption and operation keys across interruptions
and app restarts on Android and iOS. Cloudflare acknowledges bounded private
chunks; resume reconciles accepted bytes before continuing. Pause, retry and
cancellation stay in the existing upload screen. Processing, matching and
recipient approval remain separate from transfer progress. File-backed iOS
uploads refuse redirects; both clients pause and recover without promising
unrestricted background completion. See [the upload protocol](docs/resumable-photo-uploads.md)
and [current source-bound verification](verification/resumable-uploads-20261023/README.md).

The original PNGs and PowerPoint remain intact. [Source details](DESIGN-SOURCES.md) describe the screenshot mapping and artwork extraction. `shared/catalog.json` indexes every source screen; the manifests in `shared/assets`, `shared/reference-grids` and `shared/reference-art` record source/asset SHA-256 hashes and measured crop coordinates. Each photo is an individual clickable image; selection badges, settings and navigation use real controls.

Current checks and rendered captures are retained in `verification/`. Platform READMEs explain their individual projects.

Android captures at the emulator's regular display and at the supplied screenshot proportions are separate evidence. Route checks establish rendering and local interaction, while the side-by-side images support visual inspection. They do not establish pixel equivalence, real authentication/camera/sharing behavior, iOS rendering or store acceptance.
