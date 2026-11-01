# Native reconciliation and acceptance — 1 November 2026

## Active configuration and contracts

Android and iOS use the explicit public HTTPS base of the locally hosted Supabase deployment, with the path `/functions/v1/lovelies-api`. Android receives `loveliesApiUrl`; iOS receives `LOVELIES_API_ORIGIN`. Android's release task and iOS's processed Info.plist gate reject missing or malformed values. Simulator/emulator loopback HTTP remains limited to debug development. Client input contains no service-role key, database password or private Supabase administration credential.

The existing `com.lovelies.memories` identity, Android signing certificate and Play version checks, iOS signing identity, association host and published policy inputs remain release requirements. No store upload or production device acceptance is implied by source integration.

The existing Lovelies session JWT wire remains unchanged. The locally hosted backend owns its supported Supabase Auth integration. Native clients continue to bind account ID, authentication method, session lifetime and local authority generation. Anonymous enrollment, three ordinary signed captures, registered-face authentication, exact-recipient consent and original-key recovery remain required; no OTP or liveness qualification has been added.

The audience consumer uses decision-v2: minimized `at_least_13` and `guardian_required` flags, bounded annual review metadata, effective authority deadlines and signed device renewal. A legacy decision is retained only to reconcile the exact original operation; it cannot grant new product authority. Guardian and adult renewal paths keep their separate purpose consent.

The Complete package's chunked privacy export v3, session binding, expiry cleanup and immutable Save/Share owners are authoritative. The incompatible revision-3 export-v2 flow was not made active. Android's API-24 file synchronization fix remains in `OriginalMedia.kt` and its installed compatibility journey.

Android push now keeps a bounded per-device operation roster, exact typed receipts, terminal recovery disposition and durable token rotation markers. It preserves system-level notification disablement and muted-channel detection. The prior Complete single-intent journal migrates without changing its operation key or body. An explicit setting action may replace a terminal registration or revocation; routine background retries cannot mint replacement operations.

Both exact recovery responses—`409 operation_recovered_without_result` and `410 operation_retired_by_recovery`—are negative terminal evidence. Android and iOS retain the original operation key, action, input digest and original server status/code before releasing the active journal. A failed evidence write keeps the original pending. Audience status describes current eligibility and never proves a pending renewal succeeded. A fresh audience action requires renewed confirmation, and iOS APNs foreground/token callbacks remain held after a terminal operation until a new explicit notification choice. `operation_key_conflict` and unresolved `503` responses retain their original input. Terminal push evidence survives an explicitly requested replacement.

Store recovery preserves exact transaction intent and historical receipt evidence. Revision-3 account history, terminal disposition and explicit restore semantics are integrated. iOS reserves durable space before presenting StoreKit and migrates an observed Complete transaction journal to the bounded roster with the same original key and input. Historical purchase evidence never substitutes for a fresh backend entitlement. Native deletion retries retain a cleanup plan, verify account ownership and use exact public-key-bound removal.

Android checks retained credential digests across active, uncertain, archived and legacy purchase records before admitting a different account's purchase. A product change cannot reassign a foreign account's retained Play token. iOS completed-deletion cleanup retires the exact stored account authority even when bootstrap has not adopted the credential, persists the independent generation before cleanup, and preserves a newer foreign account's credential and authority generation.

## Regression coverage and commands

All commands run against synthetic fixtures unless a runner explicitly requires an isolated API/device configuration. The source and runners are not proof that execution succeeded; the integration run records commands, output and input hashes separately.

| Surface | Maintained entry point | Scope |
|---|---|---|
| Android app | `android/gradlew :app:testDebugUnitTest :app:assembleDebug` from `android` | Kotlin/Compose application compile and JVM protocol/regression suite |
| Android push, exports and ownership | `python3 scripts/test_android_push_optout.py` | Actual-source push, chunked export v3, session retirement and private-file ownership with explicit host platform fakes |
| Android push recovery | `python3 scripts/test_android_push_recovery.py --output <new-directory>` | Exact-key receipt reconciliation, terminal disposition and prior-journal migration |
| Android repository | `python3 scripts/test_android_repository_readiness.py --output <new-directory>` | Actual repository push and generic operation recovery |
| Android store | `python3 scripts/test_android_store_recovery.py --output <new-directory>` | Store state machine, account history and Play wrapper against synthetic billing boundaries |
| Android audience | `python3 scripts/test_android_audience_readiness.py --output <new-directory>` | Actual repository decision-v2, signed renewal and retained control recovery |
| Apple controlled consumers | `python3 scripts/test-ios-openface.py --suite controlled --output <new-directory>` on macOS with Xcode | Actual repository/source tests, including both Complete recovery and separate revision-3 store/deletion and audience renewal suites |
| Apple readiness host | `bash ios/Tests/run-readiness-host-tests.sh` on macOS with Xcode | Protocol, release, session/export/store/deletion and audience renewal suites |
| Release input guards | `python3 ios/Tests/test_release_origin.py` and `python3 ios/Tests/test_release_policy_urls.py` | Offline origin and public policy URL validation |

Kotlin host runners accept explicit `--kotlinc` and `--java` paths and require an already installed coroutine jar. They never download a toolchain. The export-only compatibility entry point explicitly delegates the maintained combined export-v3 suite; it does not compile the discarded export-v2 protocol.

### Explicit revision-3 supersessions

| Inactive revision-3 path | Maintained replacement |
|---|---|
| `android/RECOVERY_READINESS.md` | This reconciliation record and current run evidence; historical pass counts are not inherited. |
| `ios/RECOVERY_READINESS.md` | This reconciliation record and current Apple acceptance requirements; unexecuted Swift sources are not passes. |
| `android/app/src/main/java/com/lovelies/frontend/preview/PrivacyExportRecovery.kt` | Complete `PrivacyExportDelivery.kt` plus `ChunkedPrivacyExport.kt`, using export v3. |
| `android/host-tests/PrivacyExportRecoveryTests.kt` | Actual export-v3, authority and file-ownership cases executed by `scripts/test_android_push_optout.py`. |
| `scripts/test_android_privacy_export.py` | Compatibility entry point delegates `test_android_push_optout.py`; there is no dangling dependency on the absent export-v2 files. |

The native GitHub workflow bounds Android workers and JVM memory, compiles the Debug application and XCTest target, attempts an unsigned Release simulator build with an explicit reserved HTTPS API fixture, and runs controlled Swift regressions. It retains build logs and Apple result bundles. Release keeps the existing processed-artifact policy checks: configure the four approved public URL repository variables `LOVELIES_PRIVACY_POLICY_URL`, `LOVELIES_TERMS_URL`, `LOVELIES_SUPPORT_URL` and `LOVELIES_ACCOUNT_DELETION_URL`. Missing values fail the Release job; the workflow supplies no substitute policy pages. These lanes do not sign or distribute a store artifact.

## Remaining external acceptance

1. Run the combined source through the shared Android build and installed API-24/current-API journeys. Exercise rotation, process death, notifications disabled at app/channel/runtime levels, picker/permission round trips, Save/Share ownership changes, exported files and receipt recovery against the isolated locally hosted Supabase deployment.
2. Compile and execute the controlled Swift suites and app target with the pinned Apple toolchain. Run iPhone/iPad simulator journeys and physical Keychain, camera, notification, local authentication, photo permission and background upload cases.
3. Validate actual self-hosted TLS trust and device reachability, foreground/background and offline recovery, exact account transitions, audience/guardian expiry, entitlement revocation and restart behavior using the deployed local Supabase configuration.
4. Exercise real Play/App Store sandbox transactions, purchase cancellation/pending states, transaction redelivery and restore, APNs/FCM delivery and notification routing under approved provider credentials.
5. Complete VoiceOver/TalkBack, enlarged text, contrast and touch target checks; physical camera quality/accuracy, memory/performance, signing lineage, association host, privacy labels/policies and in-place update acceptance. Publish only after the release owner accepts the resulting evidence.

No physical-device, App Store/Play Console or production deployment completion is recorded by this integration document.
