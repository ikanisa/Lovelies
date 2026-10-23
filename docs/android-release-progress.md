# Android replacement readiness — 23 October 2026

The intended store update uses `com.lovelies.memories`, version `2.0.0`, code
`18`. The coordinator observed ten Play Console uploads with highest version code
`16` on 23 October. Release preflight requires
`-PloveliesKnownHighestPlayVersionCode=16`; refresh that observation before upload.
Original signing lineage and an installed-app update still need verification.
The owner confirms there are no real Memories users, photos or
subscriptions to import. Historical source and recovery assets remain preserved.

## Implemented locally

- **N02 / R01–R02 / SP08:** Supabase Edge Function URL prefix and configured
  JWT issuer are supported without changing the account/device/challenge wire
  contracts. Release fixtures are disabled; sample photographs live in Debug
  assets. Release API origin must select `ltqfplqevxztlswlzexn`.
- **J01–J10:** cursor pagination, debounced server search/source filtering,
  separate incoming requests/outgoing history, viewer paging/zoom, persisted
  account-scoped route/scroll/query/review state, support request creation and
  history are connected. Search changes retire the old cursor immediately;
  response generations prevent stale pages/loading flags from crossing queries.
  Paginated/search authentication failure clears private presentation and grants.
- **T02 / T05 / T07:** WorkManager resumes opted-in encrypted upload journals
  with network/storage constraints and bounded backoff. Foreground/background
  owners share a transfer lease; account/device/batch and consent are checked
  before work. Server-authorized originals save unchanged supported bytes through
  MediaStore or a temporary FileProvider grant. Low-version save permission,
  chooser cancellation, cleanup and current-session fences are explicit.
- **P01 / P04 / P05:** Play Billing purchase/restore reads actual Play plans and
  sends purchase tokens to server verification. Entitlements remain server-owned.
  Failed Play restore queries report unavailable rather than claiming no active
  subscription. FCM registration is opt-in, account/device bound and rotated;
  private notification copy exposes no photo/person metadata. App Links accept
  only configured HTTPS request/notification IDs and reauthorize current records.
- **D02–D03:** ready exports use the original request, guarded one-time grant
  and document destination. Registered deletion uses durable original intent and
  server status, with pending/failure/completed presentation and verified restart.
  Guest deletion, face lifecycle/recovery, exact-subset review and picker ownership
  protections are retained.
- **D01 / D05:** public Privacy/Terms/Deletion URLs are explicit Gradle inputs;
  native policy links reject absent, unsafe or credential-bearing URLs. No local
  policy draft is represented as published. `validateLoveliesRelease` fails before
  Release build when required API/policy/store/Firebase/link values are missing.
- **Q01–Q02:** shared controls have 48 dp targets, buttons/headers grow with
  text, headings and screen panes are named, checkbox/switch roles are explicit,
  viewer gestures have accessibility actions, and live photo/person summaries
  use Android plurals. Static screen copy is partly extracted in `values/copy.xml`.

This is implementation status. It is not hosted acceptance, physical camera,
hardware-key attestation, live billing/push, signing, store approval or deployment.

## Verification and ownership

The root coordinator owns shared Gradle builds and device/integration runs.
`verification/supabase-release-20261023/android-diagnostic-2.json` and its log
record that diagnostic independently. This worker did not start another Gradle
build. Focused JVM model evidence is retained under
`android/verification/readiness-models-20261023/`; it binds exact source hashes
and keeps the initial incomplete-host-classpath failure. Refer to `result.json`
for the final compiler/test outcome: compilation passed and **130 JVM tests
passed**. A host test never verifies Android Keystore,
Camera2, MediaStore, WorkManager or FCM runtime behavior.

Android screen/shared-UI ownership was handed back on 23 October to coordinate a
separate 48-screen accessibility/responsive pass. `Components.kt`,
`MainActivity.kt`, `LiveScreens.kt` and resources were frozen at that handoff;
the receiving owner must preserve cloud source selection, picker ownership,
plural resources and policy links. Help Center requires a scrollable content area
for compact/enlarged text after the policy rows; policy links before enrollment
and within the purchase sheet also need that owner's integration.

## Required remaining acceptance

| IDs | Concrete gate |
|---|---|
| SP01–SP10 / B05–B07 | Inspect/configure the actual selected Supabase project; apply reviewed schema, private buckets, API, inference and maintenance scheduling; exercise hosted database/storage/jobs and operator controls. |
| N02–N03 / R01–R02 | Verify Play Console package/version/signing, supply original signing inputs, produce a signed AAB, and test an actual update over the installed live Memories build. No legacy imports are needed. |
| P01–P05 | Verify actual product/base-plan/offer eligibility, pending/declined/cancelled/restored purchases and backend acknowledgement/callbacks with Play testing; qualify real FCM receipts, opt-out/token rotation and verified App Links asset association. |
| D01 / D05–D07 | Publish accurate policy/deletion/support resources, supply verified URLs, and operate review/moderation/privacy handling. Match Data Safety/disclosures to actual configured providers. |
| Q01 | Complete real TalkBack traversal, announcements, focus restoration, contrast and gesture alternatives across the connected core journeys; source semantics are not screen-reader acceptance. |
| Q02 | Extract remaining hardcoded dynamic/status/error copy, agree supported locales and translate them; test plurals, long names and large font. Existing English resources do not establish full localization. |
| Q03 | Verify Android system animation-scale/reduced-motion behavior, rotations, compact phones, tablets/foldables, safe areas and keyboard reflow. No device matrix has passed for these new changes. |
| Q04–Q05 / T01–T08 | Test physical cameras, Keystore, original MediaStore writes/share grants, cloud-only imports, permission loss, force-stop/process death, low storage, interrupted/ambiguous operations, logout/account switch and consent/session/device revocation. |
| Q06 / T06 / N06 | Measure startup/scroll/viewer memory/large-library behavior; verify formats/color/orientation and final release ELF/ZIP 16 KiB layout on a compatible runtime. |
| Q07 / S01–S09 | Freeze source, pass full source-bound build/security/cross-platform hosted regression, prepare real store artifacts/disclosures/reviewer access, then complete authorized submission/review/rollout. |

The release preflight checks configuration shape and target selection. It does
not validate ownership, publish URLs, deploy the API or prove provider readiness.

## Refresh response-loss recovery — local protocol implementation

All nine refresh callers now use one delivery path, including the original
anonymous enrollment, guest-deletion reconciliation, regular registered session,
face-profile renewal/promotion/login and account-recovery promotion. Before any
dispatch, the encrypted atomic session document saves the original refresh token,
a random UUID `rotation_key`, and a canonical base64url secret generated from
32 random bytes. The request uses `lovelies-refresh-delivery-v1`; no credential or
delivery secret is logged or exposed through the journal's string representation.

A retry reuses the exact original attempt. A validated successor must be durably
stored by the existing account/device/operation phase before the active journal
is cleared. A restart after credential-save success but journal-clear failure
recognizes the stored successor and retains its delivery proof while repairing
the phase, without dispatching another predecessor rotation. The response's
absolute `access_expires_at` must match the JWT expiry. Already expired replayed
access is saved first, then its successor refresh token gets a fresh durable
rotation intent; `expires_in` never manufactures a new access lifetime.

Unknown or rejected active refresh delivery retains the original encrypted slot
and blocks replacement-anonymous bootstrap. Explicit logout retires the journal
in the same durable document before clearing local authentication. A delayed
reply cannot pass the retired intent or prior session fence. A bounded
best-effort call to `/auth/session/refresh/cancel` sends the original delivery
body; only the exact protocol/key/account `cancelled` acknowledgement is accepted,
and credential-bearing replies are rejected. Unconfirmed retired records remain
encrypted for reconciliation and are never used for sign-in. Fresh verified face
authentication may supersede the active scope while preserving its retired
refresh record. Existing enrollment/deletion journals remain authoritative.

`RefreshDeliveryTest.kt` adds ten focused cases for replay identity, canonical
secrets, account/device binding, absolute expiry, write-before-dispatch failure,
lost committed responses, successor-save failure, clear-write recovery, session
retirement and cancellation acknowledgements. These tests were prepared for the
coordinator's shared run; this worker did not run Gradle or claim new build/device
acceptance. The earlier final UI checkpoint (146 tests in 13 suites plus main and
test APKs) predates these non-UI changes. The coordinator must rerun affected
unit/build checks and qualify hosted response-loss/cancellation and physical
Keystore/process-death behavior before release.

## Root combined-source checkpoint after final reflow repair

The ten refresh-delivery tests are now included in the successful root Gradle
run: **156 tests/14 suites, zero failures/errors/skips**, Debug app and test APK
packaging, unchanged input manifest. The UI owner's six-file scroll/reflow repair
freeze matches this build. Receipts are `android-final.json`,
`android-unit-results-final.json` and `android-final-inputs.json` under
`verification/supabase-release-20261023/`; prior failed/intermediate runs remain.
The exact fresh APKs are on the coordinated physical Pixel retest path for normal/
enlarged/landscape nested-scroll and keyboard cases. This is not yet their final
physical pass or connected/provider/spoken-screen-reader acceptance.

Both store identities/histories and exact Play upload-key certificate continuity
are now observed. The original key is privately copied with restrictive
permissions and Git exclusion; release builds validate the expected certificate
and observed maximum code. No signed AAB/store upload/in-place upgrade is accepted.
Supabase schema8/63 forced-RLS tables/private policies and three private buckets
are applied/read back; the API/inference/providers remain undeployed. See the
[current release status](release-implementation-status.md) for remaining gates.

## Previous root schema2/landscape repair checkpoint

The nine-file freeze `scroll-label-target-v2-final-freeze.json` was verified before
root's sole combined build. **156 unit tests in14 suites passed**, with zero
failures/errors/skips; Debug app and the custom accessibility-runner test APK
both package successfully. `android-final-inputs.json` readback reports no changed
inputs. That checkpoint's APK SHA256 values are:

- App: `311b1e4b0846114b6a19014bf3ce09188fc705caa8271351be411bfe38fe61e9`.
- Phone tests: `4f80d7c8a3b2610fd1b248add68884386291d77da3dd6bb4edff4982ce4e4570`.

This includes the final clipped-label/adaptive-name/profile-header/compact
landscape-onboarding corrections and revised scroll audit. The previous passing
APKs, test results, logs and proof preimage are preserved in
`verification/supabase-release-20261023/before-final-landscape-repair/`. Fresh
normal/enlarged/landscape/scroll and keyboard retakes are in progress under the
coordinated UI owner; earlier fixture passes are not relabelled as current-source
acceptance. No signed AAB/store upload or installed-store upgrade is established.

## Latest root schema3/Profile-label checkpoint

Root verified `scroll-label-target-v3-final-freeze.json` and ran the sole combined
build. **156 unit tests in14 suites passed**, zero failures/errors/skips; Debug
app and instrumentation APK packaged with no changed source inputs. App SHA256
is `e7b11109de7dac436d3cd51d8d55a577f03f1232af92063409b3952110c5c641`;
test APK is `804efce8c69b2cbf1dc361b0b63d37f805787640271aaed2682edc7082c9776c`.
This adds complete labels to the three Profile statistics and corrects observed
audit restoration/provenance defects without lowering its target/name/coverage
requirements. Immutable copies are hash-checked/installed with replacement on
the Pixel by the UI owner; fresh schema3 matrices are running.

Previous schema2 physical results remain preserved: normal48/48, font2 47/48
(route43 restoration failure) and landscape41/48;203 font2/landscape PNGs were
visually reviewed. Keyboard routes15/22/45 passed on that schema2 checkpoint.
Those are not relabelled as schema3 passes. Root preserved its prior build/APKs
in `before-android-v3-profile-label/`; raw device failures/preimages remain with
the UI owner's receipts. No signed store package/provider/in-place update pass
is established by fixture verification.

The UI owner's fresh schema3 normal and font2 matrices now both pass48/48 on the
immutable V3 APKs. The complete landscape matrix remains running; current
keyboard/connected/spoken accessibility gates are not closed by those fixture
passes. The prior schema2 failures remain unchanged in their original evidence.
