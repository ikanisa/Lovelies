# Lovelies native iOS frontend

Guest deletion is available before face enrollment through native confirmation
and the existing Privacy route. Keychain restores the original request before
anonymous bootstrap, preserves a same-account credential rotation across an
interrupted receipt write, and holds setup until status permits explicit resume
or restart. Guest status and navigation publication are fenced after logout or
cancellation. The repository and URLSession host checks are recorded in
[14 October verification](../verification/anonymous-deletion-20261014/README.md);
they do not establish an iOS app build or physical Keychain behavior.

Current replacement work is recorded in [the iOS release checkpoint](../docs/ios-release-progress.md). Lovelies updates the existing Memories App Store listing; the owner confirmed there are no real users, photos or subscriptions to migrate. The default production bundle is `com.lovelies.memories`, version `1.1.0` / build `18`, with the supplied Supabase Edge endpoint. Verify an unused higher version and the current signing team in App Store Connect before archive/upload. `LoveliesTests` is included in the shared scheme. Deployment target remains iOS 17. All older verification passages below are historical and do not establish current release acceptance.

## Reproducible reference UI runner

From the repository root, compile the frozen one-file UI runner into a new
output directory whose parent already exists:

```sh
python3 scripts/build-ios-ui-audit.py \
  --output /absolute/external/path/new-ui-runner \
  --source-sha256 cef012a6a4a9d373ec6e91e27dfc50c8c8dcf967de437eb9dc4ec64c6e3979da
```

The default source is the tracked revision4 `LoveliesFrontendAudit.swift` under
`verification/accessibility-navigation-20261023/ios-isolated-simulator/c9-candidate/`.
A later reviewed source requires explicit `--source` and its exact SHA256. The
command archives that file, generates a Simulator-only test project from the
repository templates and compiles exactly that one archived Swift file. It uses
the selected `--developer-dir` per process, preserving global Xcode selection.
Existing output directories are refused. Source hashes, actual compiler inputs,
products, the `.xctestrun` and retained raw diagnostics are in `result.json` and
the output directory. No team or device provisioning profile is needed for this
unsigned runner build.

This command builds only the runner. Runtime execution and installation require
the separately qualified app, named test device and preservation procedure.
Current app/runtime findings are in the
[source-bound UI checkpoint](../docs/release/ios-reference-ui-20261025.md).

All 48 supplied reference screens are implemented as native SwiftUI views. Images are individual cropped photo, recipient, logo and illustration assets; no entire screenshot is used as an interactive background. The user's screenshot-specific layouts, black canvas, pink controls, masonry galleries and Lovelies identity drive these views.

- Screens 01–09: welcome, sample sign-in and photo access, three guided sample selfie steps, retry, processing and setup completion.
- Screens 10–18: gallery, matches, immersive photo viewer, library tabs, favorites, search, people/date/location/media filters, activity and notifications.
- Screens 19–24: source choice, selectable photos, editable upload review, progress and completion.
- Screens 25–36: matching summary, photo/people views, reversible selections, photo and recipient review, sharing progress, history and incorrect-match report.
- Screens 37–48: profile editing, face preview selection, allowed/blocked people, privacy, photo access, notifications, storage, demo export, searchable help, account settings, no-matches and offline recovery.

The app starts in connected mode and reads its API origin from `LOVELIES_API_ORIGIN`. Debug simulator builds fall back to `http://localhost:8787`; a physical device or release build must use an explicitly configured HTTPS origin. Startup creates a restricted anonymous session through the configured Supabase-backed API. Enrollment asks for separate face-authentication consent, captures three ordinary guided selfies, signs each capture with a P-256 device key, and sends the images to the backend. The backend compares them with the real YuNet/SFace service and upgrades that same account to registered-face authentication after verification. Returning devices use the saved opaque device handle to request a fresh one-selfie challenge. The client sends captures but performs no face matching; there is no OTP or liveness/PAD step. Verification or service errors never produce a signed-in state.

The Debug-only in-app screen gallery is a separate reference mode for the 48 screenshot-matched sample routes. It uses `DemoStore`, fixture photos and recipient data, and local actions; it sends no sample data to the live account. Choosing **Return to connected app** exits that mode. Live gallery, upload, photo review, recipient selection and exclusions, final sharing review, acceptance, account, privacy and safety actions use the connected repository. Protected media still requires current backend approval; originals also require a verified production store entitlement.

Within reference mode, navigation and sample selections use `DemoStore`. Empty upload/photo/recipient selections disable forward actions. Editing a review keeps selected photos, recipients and captions. Blocking a sample person removes them from recipient selection. Timed fixture progress cancels when navigating away. The screen gallery, accessible from any ••• menu or by holding a page header/wordmark, provides all 48 routes and seeds screenshot selections. Progress screens opened from that gallery stay still for review.

Images are included individually in the Xcode resources build phase and copied to the bundle root. `AssetImage` also accepts a `Resources/` prefix to support a folder-based import. The original screenshots and shared crop provenance are outside this project and remain unchanged.

`reference-grids.json` supplies measured photo rectangles for screens 11, 14, 15, 21, 26, 28, 29, 30, 33, 37 and 38. These are individual photo crops with native photo buttons, selection/favorite controls and recipient markers. Native opaque masks cover baked source controls; their measured bounds determine control positions and diameters. Screen 30 uses bright screen-29 photo variants with native dimming. The direct screen-33 reference montage has seven rectangles for six selected logical photos, including two variants of photo 1. Normal sharing and edited reviews use the actual selected photo IDs/crops in those measured slots, with additional selected photos flowing below; they never substitute reference-only photo content. Screen 26's two partial bottom rectangles are documented demo aliases for city/cathedral photo IDs in the shared source manifest. Missing source-map resources fall back to the older native grids and do not establish visual parity.

The introduction collage and processing, completion, sharing, empty and offline heroes use extracted noninteractive artwork. Text, progress state, captions, navigation and actions remain native. Screen 38 uses its own camera crop and four Jasmine thumbnails. Source 07's retry portrait retains its original quality without added blur.

Local verification on 13 October 2026: `swiftc -frontend -parse` passed for every app and test source; `plutil -lint` passed for the project and both Info plists; the CoreWire protocol executable passed 23 checks; and the native repository/connection executable passed 25 checks using CryptoKit signatures and controlled transport/key fixtures. These protocol tests do not exercise the Cloudflare Worker, real Keychain/Secure Enclave, camera, or a physical device. This host has Apple Command Line Tools but no full Xcode, iOS SDK or simulator runtime, so an iOS app build, simulator interaction and visual comparison remain unverified. The screenshot references use different viewport proportions and very small photo/avatar crops; actual safe areas, system rendering, crops and enlarged text need simulator review before exact visual fidelity can be claimed. App signing, distribution and a finished store icon remain outside this stage.

The subsequent actual HTTP run found and fixed the old personal-source contract:
snapshots, previews and operation receipts now require the explicit source to
equal the requested personal source; professional mode was removed on 16 October. Missing or wrong sources still
fail. The updated wire executable passed 26 checks; the connection executable
passed 25. All 18 app/test Swift files parsed.

`Tests/NativeLiveHTTPJourney.swift` compiles the actual production repository,
wire protocol and URLSession transport. Against an isolated actual local
Cloudflare runtime and real host YuNet/SFace service, it passed 15 stages and
140 assertions: anonymous enrollment and same-account upgrade, the six-edge
photo graph, exclusions and exact approved subsets, denied access before
acceptance, approved private previews, denied unentitled originals, original-key
reconciliation, logout, fresh-face authentication and one-use challenge replay.
The three-selfie inputs are declared reference-photograph variants. CryptoKit
software signing and in-memory secrets replace the host's unavailable iOS
device services; no transport, verifier or matching success is fabricated.
This is a native-client network test on macOS, not an iOS application, camera,
Keychain or Secure Enclave test. The Docker rebuild was blocked by its full
external backing volume; the passing HTTP run used the host model service.
Commands and exact bindings are in
`../verification/docker-native-journey-20261013/README.md`.

## Current submission status

The six approved Gradle caches have been removed and Docker recovered. The
canonical source build now needs faithful x86 Linux execution for two failing
allocator test families; no completed image or Docker-backed native result is
claimed. OpenSSL source and upstream-suite validation passed. The earlier
host-model/client results remain separate evidence.

See [the complete remaining submission work](../docs/remaining-submission-tasks.md)
and [current build evidence](../verification/docker-native-journey-20261014/README.md).
