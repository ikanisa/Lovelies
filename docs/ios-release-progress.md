# iOS replacement implementation checkpoint — 23 October 2026

Owner scope: Lovelies updates the existing Memories App Store listing. The owner
confirmed there are no real Memories users, photos or subscriptions to migrate.
The old repository stays a read-only identity/asset/history source. This checkpoint
records implemented native work, with hosted/provider/device/store acceptance
separate from code and protocol proof.

## Implemented in the canonical iOS app

| Checklist | Result and actual boundary |
| --- | --- |
| U02 | Release disables the reference launch argument, gallery menu and long-press entry. Debug keeps the existing screenshot review. Release build settings exclude fixture photos, reference/home grids and sample catalogs while preserving live logo, splash and supplied illustration resources. Actual signed/unsigned Release bundle exclusion must be inspected by the build owner; source patterns alone do not prove final bundle contents. |
| U04 | Library uses the server's source (`all`, `received`, `contributions`), query and orientation category, with cursor pagination preserved. Home shows contributions; New Matches shows approved received photos; All Photos combines authorized sources. Favorites filter currently loaded authorized pages, with Load more available; they do not claim a separate full-library server index. |
| U05 | Viewer supports hide/show chrome, vertical dismissal, horizontal traversal, zoom controls/gestures, VoiceOver actions and width from its actual window. Gallery supports 2–5 columns, pinch and accessible density buttons; masonry height uses its measured container instead of screen-global width. |
| U06/U07 | Favorites, anchor, density and review selection/exclusion intent use account-specific Keychain state. A restored review is intersected with a fresh server snapshot; a fresh backend preview is required before sharing. No grant or approved preview is persisted as authority. Stable destination, search query, source and orientation also restore after process termination under the current account. Active operation/progress/completion routes are excluded, and sharing still requires a fresh server snapshot and preview. Queries are bounded by UTF-16 length without splitting characters. |
| U08 | Shared History reads the real `history` action and can open authenticated current receipts. Incoming Activity remains its own inbox. |
| U09 | Help submits bounded subject/details to the actual support API and displays current request statuses and review notes. |
| U10 | Empty, loading, filtered-empty, unavailable media, service failure and original-operation reconciliation retain explicit states. Hardware and complete route acceptance remain open. |
| T04 | Connected onboarding describes selected Photos/Files picker access truthfully; it no longer presents app-made All Photos/Selected Albums/limited options as OS grants. Source picker guidance and existing cloud-provider/Files handoffs are preserved. |
| T02 | User-started uploads can receive opportunistic OS `BGProcessingTask` retries, with network required and no charging requirement. Each run is bounded to 25 seconds/four chunks, each user-started cycle to five attempts. Expiration cancels transport and persists pause; explicit Pause disables automatic retries. Cold retries restore only an existing registered session, check it on the server and refuse unresolved auth/deletion journals. Foreground work waits for background cancellation on the shared repository. Actual OS scheduling/device behavior remains unverified. |
| T06 | Selected JPEG/PNG/WebP preserve their original bytes and MIME throughout private staging and upload. The Photos picker requests current representations. Other decodable single stills (such as HEIC) use an explicitly labelled JPEG copy, with review text before Upload; RAW/animated images require conversion first. Dimensions and source sizes are bounded. Hardware/provider format tests remain open. |
| T05 | Protected previews stay in bounded memory. Startup removes abandoned temporary import/share files; active durable resumable upload files are separate and preserved. Authorized share files are removed after share completion/dismissal or account retirement. |
| T07 | Save and system Share both retrieve bytes through current server grant and entitlement checks. System Share uses a protected private temporary file and removes it after use. Export shares use the same cleanup boundary. |
| P01 | StoreKit 2 loads the configured real product; purchase passes appAccountToken for the current account. Pending/cancelled/unverified/owner-conflict/expired/revoked/sandbox states are explicit. Purchase, restore and transaction updates send signed JWS to `/subscriptions/apple/transactions`. Transactions finish only after a bound backend reply; original access remains server-authoritative. |
| P03 | Real APNs permission and token callbacks, registration, rotation cleanup, permission-off and logout removal, generic foreground notifications and authenticated tap routing are implemented. Server logout also retires auth-device tokens. Actual APNs signing/provider delivery is unverified. |
| P05 | `lovelies://match/<uuid>`, `support/<uuid>` and `payment/<uuid>` route after registration and then use current backend endpoints. HTTPS links are restricted to the configured host; a verified domain/AASA and associated-domain entitlement are still required before universal-link acceptance. |
| D02 | Privacy displays actual request lifecycle statuses, ready/expired/unavailable export state and bounded account/session-bound one-use export retrieval. The JSON is delivered to the iOS share sheet for Save to Files. A registered deletion confirmation stores its original operation and private receipt in Keychain before dispatch, checks status without an active account session, rejects mismatched/false completion, and permits a new account only after confirmed completed deletion. |
| N01 | Added `LoveliesTests` XCTest target to the shared scheme with deletion binding/completion, account library state and cancellation fence tests. This is an actual target, not a Testables placeholder. Root owns app/test builds and runtime execution. |
| N02 | Defaults now use bundle `com.lovelies.memories`, version `1.1.0` / build `18`, the Supabase Edge API base and the historical subscription product. Values can be overridden at build time. Current console versions, signing team and product must be verified before archive/upload. |
| N04 | AppIcon now includes inspected actual 1024px Lovelies PNG pixels, has no alpha, and is selected by the asset-catalog build setting. It is byte-identical to the existing donor Lovelies icon (SHA-256 `72eb84e56a84f74f4cdeb531a6ce6285a143b11565af84bb355ae28979bdd93b`). Donor files were not edited. |
| N05 | Added APNs development/production entitlements and app privacy manifest for actual account/name, biometric, photo, device, subscription and support data plus app-container file metadata reason. Console privacy disclosures, backend policies and final signed privacy report still need reconciliation. |
| Q | Shared buttons/headers use Dynamic Type styles and text wrapping; new forms use semantic fonts, accessible labels, minimum touch targets and scrolling. Navigation honors Reduce Motion. iPad/window sizing support is configured. Existing fixed-size screens and the complete VoiceOver/localization/adaptive/device matrix are not fully qualified. |

## Supabase API integration

The native endpoint is
`https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api`.
Both JSON/binary transport and file-backed chunk upload preserve the function
prefix. Signed download URLs accept only the configured scheme/host/port and a
canonical download ticket path, with the same namespace applied on retrieval.
Cross-origin redirects remain refused. Private upload/session/enrollment journals
remain bound to their original account/device/API deployment.

Canonical reused contracts: `/community/action` (`photos`, `inbox`, `history`,
`receipt`), `/support/requests`, `/me/entitlements`,
`/subscriptions/apple/transactions`, `/me/push-devices`, `/privacy/center`,
`/privacy-requests/<id>`, `/privacy-exports/<id>/grant`,
`/privacy-exports/retrieve`, and `/privacy/account-deletion/status`.

## Verification obtained

- At the native handoff, changed native and XCTest Swift sources pass `swiftc -frontend -parse`; the earlier complete-source parse is historical. The coordinator owns final integrated app/UI checks.
- Project, both Info plists, entitlements and privacy manifest pass `plutil -lint`.
- Current native protocol executable passes **38** checks.
- New release-readiness protocol executable passes **18** checks: wrong-origin,
  wrong-operation/request, false completion and unknown lifecycle rejection;
  exact receipt restart; account-scoped route/search/category state; unsafe operation-route rejection; Unicode query bounds; cancellation fencing.
- Native resumable-upload focused executable passes **82** checks, including current picker ownership, cold existing-account retry restoration, no anonymous bootstrap, auth-hold refusal, explicit Pause, bounded automatic retries, MIME/extension substitution rejection and byte-identical PNG/WebP staging. These controlled signatures do not establish actual decoder/device format support or OS scheduling.
- App icon is 1024 × 1024 with no alpha and matches the inspected donor hash.
- Root's first combined iPhoneOS type build found SwiftUI/StoreKit `Transaction`
  ambiguity; all references are now explicitly `StoreKit.Transaction`. The
  coordinator's subsequent app/test results govern integrated build status. Diagnostic 2 failed because its build volume reported no space, before a new compiler conclusion; its failed evidence remains preserved.

Commands used:

```sh
xcrun swiftc ios/Lovelies/Native/CoreWire.swift ios/Lovelies/Native/CameraRecovery.swift ios/Tests/NativeProtocolTests.swift -o /tmp/lovelies-native-protocol-current
/tmp/lovelies-native-protocol-current
xcrun swiftc ios/Lovelies/Native/CoreWire.swift ios/Lovelies/Native/CameraRecovery.swift ios/Tests/NativeReleaseReadinessTests.swift -o /tmp/lovelies-native-release-readiness
/tmp/lovelies-native-release-readiness
```

## Remaining iOS acceptance and implementation gates

- Root's combined app/test type/build and simulator/device runs, signed archive,
  certificate/profile/team/Push capability and App Store Connect validation.
- Actual Supabase hosted endpoint, face-verifier, original/media/export/deletion
  jobs and provider current-session integration. Local protocol passes do not
  establish hosted acceptance or physical camera behavior.
- Actual App Store product, sandbox purchase/restore/pending/refund/revoke/renewal
  and server notification acceptance; public privacy policy and subscription
  legal links/configuration; agreements and review access.
- Actual APNs delivery/rotation/opt-out, configured universal-link host/AASA and
  physical tap-through behavior.
- OS background retry admission, expiration, network interruption, locked/rebooted
  device, Low Power Mode/Background App Refresh settings and foreground handoff
  still need physical-device acceptance. Scheduling is opportunistic; no continuous
  closed-app/force-quit upload or completion timing is promised (T02).
- Original JPEG/PNG/WebP preservation and explicitly labelled JPEG conversion are
  implemented; actual Photos/Files/iCloud HEIC/JPEG/PNG/WebP, metadata/orientation,
  wide-gamut/HDR, size limits and RAW/animated rejection need physical-device
  acceptance (T06). Saving/sharing server originals does not transcode their bytes.
- Complete localization, full Dynamic Type/VoiceOver/reduced-motion journey matrix,
  photos permission changes, low storage/interruption and physical devices.
- Full-library favorites server indexing remains distinct from account-scoped
  local favorites and the implemented stable destination/search restoration.
- Existing app update-over-install, new icon/screenshots/metadata, final store
  disclosures, release approval, uploads, review responses and rollout verification.

Design authority used: consolidated `revolut-design@jean-bosco-skills` maintained
source, DESIGN and mobile-pattern references; dark Lovelies supplied UI retained.
New layouts are product adaptations, with no current screenshot parity claim.
No OTP, liveness, photographer applications or payment-settings controls added.

## 23 October resumed native slice and ownership handoff

Application-input writes were frozen for the coordinator's integrated build after
updating `NativeServices.swift`, `BackendRepository.swift`, `UploadRecovery.swift`,
`CoreWire.swift`, `LiveAppStore.swift`, `CameraAndPhotos.swift`, both Info plists,
Release resource exclusions and focused tests. `LoveliesApp.swift` received only
scene-phase/background-bootstrap/route-persistence hooks;
`LiveSharingAndSettings.swift` received one import-format review explanation.
The source-picker handoff, allow-list and picker-ownership fences were preserved.
A separate UI owner now holds the main/reference view files for accessibility,
back/close behavior, responsive layout and localization; those changes require
its own checkpoint and the coordinator's final integrated evidence.

BGTask integration follows Apple's [background task launch and expiration
contract](https://developer.apple.com/documentation/uikit/using-background-tasks-to-update-your-app).
The redirect-refusing ephemeral chunk transport remains; the implementation does
not substitute an unattended background URLSession that loses this redirect rule.
The focused local result is saved in `ios/Tests/native-release-finish-result.json`.

## Refresh delivery reconciliation — 23 October 2026

The optional backend contract is `lovelies-refresh-delivery-v1`. Every native
rotation now stores its original credentials, UUID `rotation_key`, canonical
32-random-byte base64url `delivery_secret`, API origin and owner/device binding
in device-only protected storage before dispatching. A same-process secure-vault
CAS and session epoch fence protect preparation, response adoption and retirement.
The secret/original token never appear in a UI summary or application log.

All anonymous, enrollment promotion, registered, ordinary-login, account-recovery,
face-profile and guest-deletion activation paths share this central rotation
implementation. Replay returns the original stored successor. The client uses
`access_expires_at`, not a new clock derived from replayed `expires_in`; an expired
successor is durably adopted before any new-key successor rotation. Its full
validated response survives a later owner-journal, credential-slot or retirement
write failure. Existing enrollment/profile/recovery journal-first ordering and
guest-deletion receipt/slot compensation remain intact.

Unknown outcomes and `refresh_invalid`, `refresh_delivery_expired` or
`refresh_delivery_unavailable` retain the original protected request and cannot
fall through to a replacement anonymous account. Wrong account/method/operation,
API deployment, owner/device binding, newer local journal or retired epoch cannot
adopt a late result. Legacy refresh-only one-use behavior remains a backend
contract; native requests use the optional delivery protocol.

Explicit logout first persists suspension and then clears local public authority.
It independently attempts `/auth/session/refresh/cancel` using the exact original
protocol/token/key/secret; logout does not wait for that cancellation request.
Only a bound `cancelled` acknowledgement confirms cancellation. Lost replies keep
the protected suspension for restart reconciliation. A fresh backend-verified
session can replace the active local scope while the old cancellation request
stays in a bounded protected archive; old delivery/cancellation responses cannot
overwrite the fresh session. Archived outstanding cancellations retry at most
four per bootstrap. Archive capacity is bounded without deleting old authority.

This slice changes only `Native/CoreWire.swift`, `Native/DeviceIdentity.swift`,
`Native/BackendRepository.swift`, the new `Tests/NativeRefreshDeliveryTests.swift`
and optional-protocol reply fields in four existing controlled fixtures. Existing
assertions were retained. No screen, shared component, app routing, project,
signing, Info plist or build configuration was changed. Root owns the subsequent
combined Release/Debug builds and runtime/hosted acceptance. Focused commands,
raw failed attempts, successful logs and the final source manifest are retained
in `verification/supabase-release-20261023/ios-refresh-delivery/`.

The final frozen source passed 665 controlled host checks: 69 refresh-delivery,
222 enrollment, 85 guest-deletion, 107 account-recovery and 182 face-profile
checks. All five focused compiles and executions passed. The new cases include
response loss after commit, restart replay, secure-storage failures, expired
delivery, local CAS races, logout during dispatch, lost cancellation replies,
fresh-session replacement with archived cancellation, and failure to delete the
old secure credential slot. A suspended leftover slot cannot be published by
bootstrap. Final results and source hashes are in `final-manifest.json`; the
four existing owner suites are recorded in `final-owner-suites/`.

These are controlled transport/storage proofs. Hosted Supabase encryption and
receipt/cancellation deployment, real device Keychain/restart lifecycle, signed
update installation and store/provider acceptance remain separate release gates.

## Root final combined-source checkpoint

Both unsigned **Release build and Debug build-for-testing pass** for the final
arrow/protocol source with unchanged input hashes, independently of the665 host
checks above. Release readback confirms bundle`com.lovelies.memories`,
version1.1.0/build18, minimum17, the selected Supabase Edge URL, privacy manifest,
real AppIcon and absent reference-photo/catalog fixtures. Receipts are
`ios-release-final.json`, `ios-debug-final.json`, `ios-final-inputs.json` and
`ios-release-artifact-final.json` under `verification/supabase-release-20261023/`.

A separate final-source Debug app and its two nested dylibs were development-
signed and strict/deep verified for the exact paired iPhone12Pro. It remains a
private QA-only copy (`qa-iphone-final-signing.json`), omits APNs/Associated Domains
and is not installed. The prior DDI mount was blocked by the locked device. No
uninstall/reset or production signing/store/provider/update acceptance occurred.
Current distribution profiles lack APNs and final policy URLs remain blank; the
release preflight correctly rejects those missing inputs/signature.

Apple app6786056510/team63STJ5N27W, its existing production1.0.5/build14 and all
eight uploads (maximum14) were observed before its sign-in expired. Product/
provider/capability and exact signed update qualification remain. Supabase schema8/
63 forced-RLS tables and private buckets are applied/read back; actual API/private
model/provider deployment and hosted/device qualification remain separate. See
the [current release status](release-implementation-status.md).
