# Lovelies readiness execution — 23 October 2026

**Local implementation has advanced; deployment and both store submissions remain blocked.** The full [90-ID disposition](release/backlog-disposition.md) names each retained obligation and its remaining acceptance. Local proof, hosted operation, physical-device behavior, signed upgrades and store acceptance are separate outcomes.

## Replacement and scope

Lovelies updates the existing Google Play and Apple records using `com.lovelies.memories`. The owner confirms there are no real Memories users, photos or subscriptions to migrate. No legacy customer importer is required. Preserve unknown/test data, signing lineage, installed-state qualification, rollback and the Memories source/recovery history. Retire donor release jobs only after both replacements are live, stable and beyond the agreed observation window.

Supabase project `ltqfplqevxztlswlzexn` is authoritative. The retained private model and push services have explicit authenticated boundaries. Anonymous-first authentication upgrades the same account only after backend verification of exactly three signed enrollment selfies. Later authentication/recovery compares fresh captures to the registered reference. No OTP or liveness/PAD is added. Matching alone grants no media access; exact approved recipient subsets, recipient acceptance, separate consent, current authority, private media and server-confirmed store entitlements remain enforced.

## Implemented and locally verified

| Boundary | Observed proof | Limit |
|---|---|---|
| Supabase engine | Asynchronous PostgreSQL transactions, private Storage adapter, queue/outbox/leases, maintenance, enrollment/recovery/profile, exact sharing, privacy/erasure, store verification and operator routes. Frozen v7 plus additive v8 = 63 private forced-RLS tables. | Hosted schema version 8/63 forced-RLS tables and backend-only policies read back after approved application; API behavior remains unqualified. Private transports/providers are controlled fixtures in local tests. |
| PostgreSQL regression | **209 distinct current cases covered**: 175 unchanged cases from the retained 209-case full attempt, plus all 34 cases in the corrected affected account-recovery file. TypeScript and actual Deno checks pass. Affected v8 strict-role/concurrency/refresh tests separately passed 49/49. | The full attempt had 205 passes and four failures because its explicit secret-scan table allowlist omitted the new encrypted receipt table. Only that test allowlist changed; the entire affected file then passed 34/34. This is not a single green 209-case aggregate run. Do not add overlapping counts. |
| Refresh delivery | Backend, Android, iOS and operator journal the original refresh/key/independent secret before dispatch, reconcile exactly one encrypted credential result, preserve absolute expiry and cancel retired attempts. Legacy refresh remains single-use. | Hosted transport loss, real persistent secure storage and lifecycle acceptance remain. No device key alone grants authentication. |
| Android | Latest checkpoint: **156 unit tests in 14 suites**, zero failures/skips, Debug app and instrumentation APK build pass, unchanged source inputs. Play upload-key continuity verified privately. | The final clipped-label, adaptive people-name, profile-header, compact-landscape-onboarding and schema3 scroll-audit and complete Profile-statistic-label corrections are frozen and included in the passing156-test build; Historical e7b11109 app V3 normal48/48,font2 48/48,landscape45/48 and keyboard15/22/45 are retained. The V5 reference Favorites viewport correction passes a fresh156-test/14-suite combined build, with a new app APK; targeted Favorites14 passes normal/font2/landscape and full48-screen matrices are underway. Connected Favorites viewport and full connected/spoken accessibility acceptance remain open. No signed release AAB or store-installed update pass. |
| iOS | **665 focused Swift host checks**, unsigned Release build and Debug build-for-testing pass with unchanged final inputs. Bundle `com.lovelies.memories`, version 1.1.0/build18, minimum17, correct Edge URL, privacy manifest and no reference photo/catalog fixtures in Release. | No final signed archive/TestFlight/in-place update. Current inspected profiles lack APNs. A fresh final-source QA-only copy and both nested dylibs are development-signed/strict-deep-verified; it omits APNs/Associated Domains and establishes no production capabilities. After retained locked/tunnel failures, the phone reconnected/unlocked and the guarded development QA update installed in place over developerbuild11 with container backup/no reset. Test01 passed initial reference lifecycle/custom-link isolation, then an unrelated floating video window blocked the gallery control. Raw failed attempt is preserved; the same-source smoke awaits owner overlay removal. Full iOS runtime/spoken accessibility/provider/store-installed update acceptance remains open. |
| Operator | **107/107** combined local operator/client tests pass. Independent reviewer closes all ten recovery/race probes, including stale tab/newer journal preservation, sign-out during crypto, exact replay and corrupt-state rejection. Service worker version `20261023-6`. | PGlite/WebCrypto/fake IndexedDB and minimal DOM tests do not qualify real deployed Chrome/Safari camera, persistent keys, service-worker updates or independent operated reviews. |
| Private model | **23 local model/service-auth checks** pass. Authenticated HTTPS boundary, canonical model artifacts and evaluation tooling retained. | Representative consented calibration/held-out evaluation, threshold approval, faithful x86 kernel/container qualification and selected hosted runtime remain open. |
| Push gateway | APNs HTTP/2, FCM HTTP v1, durable intent/receipt ledger, current-authority fences and disabled-by-default sending. **19 tests and six syntax checks pass.** | No actual provider credentials, hosted gateway or device delivery proof. |
| Public/release material | Five public policy/support/deletion pages, store copy/reviewer instructions, source-based privacy/data worksheet and platform association files are prepared locally. Pinned CI/lockfiles prepared; production npm audit found zero vulnerabilities in its 57-package scope. | Pages/association files are unpublished. Final processors, retention, audiences, mailbox operations, declarations, reviewer access and store assets need qualification/approval. Prepared CI is not a GitHub run. |

Detailed receipts remain under `verification/supabase-release-20261023/`. Source-bound current aggregate pointers are `backend-integrated-reconciled-final.json`, `admin-integrated-final.json`, `android-final.json`, `android-unit-results-final.json`, `ios-release-final.json`, `ios-debug-final.json`, `ios-release-artifact-final.json`, `ios-refresh-delivery/final-manifest.json` and `push-provider/result.json`. Original failed/pre-fix runs and source preimages are preserved. [Independent operator review](release/operator-security-review.md) records its own snapshots and closure.

## Hosted project and store readback

- Chrome reaches **Lovelies / IKANISA**, Free/Nano, EU West (Ireland), project status label Healthy. Read-only SQL observed **zero application tables, zero public tables, zero buckets and no `lovelies_api` role**; managed base tables were auth27/realtime3/storage8/vault1. Overview displayed no repository, migrations or backups. These scoped observations do not establish a complete configuration audit or authorize deleting unknown data.
- Health and Performance Advisors initially displayed zero items. The two pre-existing Security Advisor warnings concerned client EXECUTE on `public.rls_auto_enable()`. A fingerprint-guarded transaction removed only public/anon/authenticated execution; hosted readback confirms client denial, retained service-role access and unchanged definition/enabled event trigger. The explicit post-change linter rerun shows zero errors/warnings/suggestions. The main Supabase connector still denies this project.
- The owner-approved exact **v7+v8 transaction succeeded** in the visible SQL editor; readback confirms schema 8, all 63 forced-RLS tables,63 backend-only policies, zero accounts and no client schema access. Bundle SHA-256 `4af45131d43ae3e5e832b8e6a151c683cc018eb08d43c1f4f34a4e6b42bc156a`. Specific role/grant action-time approval was received before execution; this supersedes the earlier v7-only staged package. Manual SQL execution still needs supported Supabase CLI migration-history reconciliation before future db push. Three private buckets are provisioned/read back with 20971520-byte limits, expected MIME types and zero client Storage policies. No API, model, gateway or scheduler was deployed. See `supabase-v7-v8-review.sql` and `supabase-inventory-final.json` in the receipt folder.
- Google Play existing app4975869074578629128 has production1.0.5/code14; all ten uploaded versions observed maximum **16**. Candidate Android 2.0.0/code18 was unused. The privately copied donor upload key exactly matches the observed Play upload certificate; the app-signing certificate is separately recorded for website association. Existing app minimum API24 differs from candidate26 and needs compatibility qualification.
- Apple existing app **6786056510**, IKANISA team **63STJ5N27W**, is Lovelies Event Photos, production1.0.5/build14. All eight observed uploads have maximum **14**; candidate1.1.0/build18 was unused. Current production/sandbox subscription callbacks still name the earlier API host. External Chrome sessions required reauthentication; the owner requested Codex panels, where Play already had correct IKANISA access and Apple is also authenticated. Google product/base-plan/notification-topic/receiver were then inspected read-only. Google product com.lovelies.memories.pro.monthly and active monthlypro/175-country plan are verified; Apple approved one-month product6799678587/group22297275 uses the same product ID and is available41/175 regions. The owner completed the Program License review; Business readback confirms the original blocker is cleared and Free Apps is Active with23 October2026 effective date. Paid Apps remains Active and now displays New Agreement Available; the new paid terms and billing qualification remain for owner review. Substantive trader/territory declarations and actual purchase/restore/provider delivery remain unqualified. Both provider callbacks still target the earlier API host.

[Store identity and signing readback](store-update-identity.md) contains exact public certificates and preservation requirements. Highest versions must be refreshed immediately before upload. No store record, product, callback or declaration was modified.

## Current device checkpoint

The latest coordinated Pixel checkpoint is normal48/48, font2 48/48 and
landscape45/48, with46/46 applicable Back checks and all257 screenshots reviewed.
Fresh V3 keyboard routes15/22/45 pass. Three landscape failures retain their raw
records while a nested-scroller test correction is prepared. The iPhone V2
runner is built/signed/read back; the unchanged installed QA product's physical
retry still awaits owner removal of the unrelated floating video overlay.
`device-checkpoint-v3-v2-runner.json` binds this partial checkpoint.

The V4 test-only Android batch subsequently compiled with unchanged frozen
inputs and an identical product APK; its new test APK is handed to the UI owner
for targeted/final landscape and actual visible-exit callbacks. Gradle reused
all14 unchanged unit-result XMLs (156 tests); no fresh unit execution is claimed.
`android-v4-test-only-review.json` binds the build and preserved V3 preimages.
V4 physical acceptance remains pending.

V4 targeted landscape20/39 then passed,14 retained Save photo5, and all three
visible exits reached the expected pane. Normal/font2 actual visible-navigation
matrices each completed48 cases with one incorrect Cancel7 assertion; unchanged
product source sends named Cancel to5, while physical Back remains6. The final
V4.2 test-only batch corrects that assertion and two nested coverage keys,
compiles with unchanged frozen inputs, and retains the exact product APK hash.
Its final corrected device runs are pending. Raw failures and the reconciled
intermediate source-backup guard failure remain; no product change, hosted or
store acceptance is inferred.

V4.2 then passes Cancel7 at both text sizes but still fails Favorites14 landscape.
The final V5 product delta fixes only the demonstrated reference14 viewport;
MainActivity and test sources are unchanged. Root's combined build and fresh
156-test/14-suite execution pass with no changed frozen inputs; new app SHA256
is e47b514f18234c719f6f53132e79b396598fdeae59b2900d8f0c3f049b169301.
New APK-bound device retakes are pending. The broader connected-host candidate
remains preserved unbuilt; connected Favorites constraints/behavior are open.

## Remaining release gates

1. The approved schema is applied/read back; reconcile Supabase CLI history, retain the clean post-change security-linter receipt, complete API/Auth/Storage/configuration inventory and establish backup/restore. Supply server-only secrets through the deployment secret store, not chat or Git.
2. Select and qualify the private inference runtime/host and representative consented model evaluation. Private Storage buckets/configuration are provisioned/read back; qualify actual object operations and configure the authenticated scheduler, push gateway, store verification/callbacks, independent operators, alarms, retention, incident/support/privacy operation and recovery.
3. Finish final corrected-source device evidence; run connected two-account Android/iOS journeys, actual camera/secure storage/Photos/Files/save/share/background/expiry/revocation/failure behavior, spoken screen-reader accessibility, localization/window coverage and release performance. Reference screens and host checks cannot substitute.
4. Supply approved published policy/support/deletion/link URLs, final provider/store authentication and callback configuration, production Apple APNs/Associated Domains profiles and final signing inputs. Build and inspect exact signed AAB/archive, validate 16 KiB/SDK/device support and install over the current store versions without uninstall/reset.
5. Approve/publish actual notices and association files, qualify the support/deletion mailbox, capture genuine candidate store assets, finalize both disclosure/rating/access/trader forms and workable reviewer enrollment/sharing/purchase access.
6. Use the locally sealed canonical source/receipts and configure the owner's intended remote/CI; execute applicable Play testing/TestFlight, fix observed feedback, then present the exact package for gated deployment/upload/submission and staged rollout. Public availability and the observation window precede Memories job/service retirement.

No completion percentage is assigned to the differently sized work packages. The owner's authorization to finish readiness remains active; missing external inputs, action-time grants and unqualified operating/device/store gates are explicit rather than represented as completed.

## Source preservation

The canonical source and a portable verification summary are sealed in local Git.
`verification/supabase-release-20261023/git-source-seal.json` records the resulting
commit/tree. No remote is configured or pushed and no GitHub CI run is claimed.
Local `verification/`, generated `deliverables/`, private signing/credentials and
build caches are excluded from source tracking and preserved on disk. Pattern
scan hits were two literal PEM-header removal strings, not embedded key material;
the bounded scan does not constitute a comprehensive secret/security audit.

## Existing Firebase registration and remaining provider configuration

The owner chose existing Firebase project `easymoai` and specifically approved registering Lovelies there. Android package `com.lovelies.memories` is registered/read back as app `1:423260854848:android:05e378657a0a819135dda5`, sender423260854848. The official client configuration is downloaded and prepared in ignored `.release-secrets/android/firebase-public-client.properties` for explicit candidate-build inputs; three public identifiers are recorded in the example. FCM HTTP v1 is enabled and legacy FCM disabled. The exact matching shared Android key has25 API restrictions and no Generative Language API; application restrictions remain None and require final shared-key review without breaking existing Cool. No restriction, billing, Analytics or IAM change, private sender key or notification occurred. The uncreated new-project draft was closed. Supabase remains authoritative.
The private inference/push host/operator and intended Git remote are still
requested inputs. Connected GitHub search found existing`ikanisa/Memories`,
not a connected Lovelies repository; no donor remote/history was changed.

The UI owner has now installed that exact V5 app in place without reset.
Favorites14 passes fresh normal/font2/landscape, including fully observed48dp
Save photo5 and actual visible Back to10 in every run, with preferences restored.
Root read/hash-checked all three raw reports; `device-checkpoint-v5-favorites.json`
binds the result. Full48 V5 matrices/visual review are underway; connected
Favorites and broader hosted/device/store acceptance remain open.
