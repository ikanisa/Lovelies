# Lovelies native Android

Kotlin and Jetpack Compose. The release target is the selected Supabase API (`ltqfplqevxztlswlzexn`): anonymous first, three ordinary Camera2 enrollment photos, signed one-use captures, then automatic registered-face authentication. A retained verified device handle supports a fresh camera sign-in after logout. There is no OTP or additional authentication screen.

The live gallery loads currently authorized metadata and protected previews. Android's photo/file pickers provide chosen images; uploads are bounded to 20 MiB and actual server processing status. Sharing uses a sparse server snapshot, global photo/person selections, individual photo-person exclusions, an immutable exact-subset preview, and an idempotent commit. Photo access begins only after recipient acceptance. A failed or uncertain operation stays visible; retries preserve the original operation key and reviewed payload.

Account controls use the current profile, photo/matching preferences, notifications, blocks, reports, sessions/devices and privacy request APIs. Favorites are encrypted local UUID references. Payment entitlements remain server-authorized; this app does not manufacture subscription access.

Before enrollment, **Delete guest account** opens native confirmation and a
dedicated privacy status view. The encrypted original request is committed
before dispatch, restored before anonymous bootstrap and reconciled with its
original key. Rejection or review expiry permits an explicit same-account
resume; completion permits explicit restart after durable local cleanup.
Deletion receipt checks carry no bearer credentials. Read
[the protocol](../docs/anonymous-account-deletion.md) and
[current verification](../verification/anonymous-deletion-20261014/README.md).
Current units include logout-phase and interrupted-write/restore regressions.

## Configuration

Debug defaults to `http://10.0.2.2:8787` for an emulator talking to a local compatible API. Override with Gradle property `loveliesDebugApiUrl`. Cleartext is permitted only for debug loopback hosts (`10.0.2.2`, `localhost`, `127.0.0.1`). Release requires `loveliesApiUrl=https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api`. The existing `CloudflareRepository` class name is historical; its HTTP wire protocol supports the Supabase function prefix.

`:app:validateLoveliesRelease` runs before a Release build. Supply verified Gradle properties `loveliesPrivacyPolicyUrl`, `loveliesTermsUrl`, `loveliesDeletionUrl`, `loveliesPlayProduct`, `loveliesLinkHost`, `loveliesFirebaseProjectId`, `loveliesFirebaseAppId`, `loveliesFirebaseApiKey` and `loveliesFirebaseSenderId`. Set `loveliesLinkHost` to `lovelies.ikanisa.com`, the host of the published association documents; a different host requires its own verified association and a corresponding release-preflight change. Policy URLs must be public HTTPS addresses; the build does not guess that local policy drafts have been published. No configuration values are printed by preflight. Store product and Firebase values must match their real consoles. Passing configuration preflight does not verify publishing, provider delivery or hosted acceptance.

The replacement package is `com.lovelies.memories`, version name `2.0.0`, code `18` (override with `loveliesVersionName` and `loveliesVersionCode`; the latter must be above the known source baseline 17). Verify the live Play Console maximum and preserve the existing signing lineage before building an upload candidate. The owner confirms no real Memories users, photos or subscriptions need migration. Retain historical source/recovery records and test an in-place update.

See [Android readiness progress](../docs/android-release-progress.md) for implementation and outstanding device/provider/store gates.

Use JDK 17+ and Android SDK 36. The portable Gradle 8.13 wrapper is included. Build/test execution is coordinated by the parent task's single runner.

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Pure protocol and actual loopback HTTP tests cover canonical capture wire, P-256 DER-to-raw signature verification, same-account session fencing, redirect rejection, sparse Aline/Eric subsets, exact immutable manifests, original-key outcomes, 100 assets and pending-acceptance access limits. These tests do not establish physical-camera or Android Keystore acceptance on a device.

The 13 October debug app and instrumentation APK built successfully with 24 unit
tests passing. Sharing and protected photo responses now require their explicit
personal source (professional mode was removed on 16 October); unrelated account/privacy operation sources retain
their separate meaning. Missing and mismatched sources cannot consume a review
or a reconciled sharing receipt.

The actual API-36 emulator journey passed 19 checks using Android Keystore,
ContentResolver, FileProvider and the production HTTP repository against fresh
local Cloudflare SQLite Durable Object/R2/Queue state and the actual host
YuNet/SFace service. It covered anonymous enrollment, automatic same-account
authentication, six real candidate edges, exact exclusions, pending requests
without access, recipient approval and private previews, entitlement denial,
original-key reconciliation, fresh selfie authentication and replay denial.
Connected screens were exercised through gallery, photo, matched people,
pair/global-person exclusions and final review. Inputs were declared photograph
fixtures, so these runs do not establish physical-camera behavior or sensor
provenance. The Docker image rebuild was blocked by its full external volume.
See `../verification/docker-native-journey-20261013/README.md` for commands and
input bindings; use `am instrument -w -r` to retain the JSON result and result
code, rather than relying on adb's exit status alone.

## Screenshot review

All 48 original screenshot layouts remain available as explicit local fixtures from the “All 48 reference screens” catalogue, or:

```sh
adb shell am start -n com.lovelies.frontend.preview/.MainActivity --ei screen 33 --ez review true
```

`screen` accepts 1–48. Fixture mode does not start the API, camera or account flows. “Return to live app” restores current server state. The root semantic description remains `Screen NN: Title`. The original reference assets and their provenance are preserved.

## Private state and actual limits

Access/refresh tokens, verified opaque device/face handle, review drafts and unresolved operation intents are AES-256-GCM encrypted in app-private no-backup storage. Device signing uses a nonexportable Android Keystore P-256 key. Protected previews are authorized afresh, held in memory, and hidden/cleared on background or logout. Unverified enrollment keys are discarded on cancellation. Ordinary logout removes tokens, drafts, operation intents and private photo references while retaining the verified hardware device identity; device revocation/forget removes that identity too. Local camera files and persisted picker grants are released on logout.

Private Cloudflare face/processing services must be configured for actual verification and matching. Their failure does not create an authenticated account, successful upload or delivered-photo result. Hosted connectivity, physical-camera accuracy, production subscription/download entitlement, store release and device security acceptance require their own runtime proof.

Android API references: [Keystore](https://developer.android.com/privacy-and-security/keystore), [Camera2](https://developer.android.com/reference/android/hardware/camera2/CameraDevice), [Photo picker](https://developer.android.com/training/data-storage/shared/photo-picker).

## Current submission status

The six approved Gradle caches have been removed and Docker recovered. The
canonical source build now needs faithful x86 Linux execution for two failing
allocator test families; no completed image or Docker-backed native result is
claimed. OpenSSL source and upstream-suite validation passed. The earlier
host-model/client results remain separate evidence.

See [the complete remaining submission work](../docs/remaining-submission-tasks.md)
and [current build evidence](../verification/docker-native-journey-20261014/README.md).
