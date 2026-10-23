# Existing-store update identity

Observed 23 October 2026 through the signed-in Play Console and App Store Connect. No listing or release
was modified. The owner confirms no real users, photos or subscriptions require
migration; the small device/install counts observed in Play do not establish real
customer data and do not authorize deleting data.

| Item | Observed value | Remaining qualification |
|---|---|---|
| Play organization | IKANISA, organization account8574763943591248082 | Release/signing permissions |
| Existing Play app | Lovelies, app4975869074578629128 | Preserve this record |
| Package | `com.lovelies.memories` | Signed candidate package/lineage readback |
| Live production | `1.0.5 (14) Pro Featured Photos`, released1 September2026,100% | All10 uploaded app versions observed; highest code16, candidate18 unused at inspection |
| Current live Android coverage | API24+, phones/tablets and additional form factors,18,889 devices | New native minimum26 changes coverage; compare candidate catalog before acceptance |
| Live target/page size | API36; Play reports supports16KB | Qualify new signed AAB and actual16KB runtime independently |
| Existing Apple identity | Lovelies Event Photos, app6786056510, bundle`com.lovelies.memories`, SKU`lovelies-ios-com-lovelies-memories`, IKANISA LTD | Console identity observed; local matching team63STJ5N27W/profile/certificate inspected separately |
| Live Apple version | 1.0.5, build14, Ready for Distribution | All8 displayed uploads across1.0.5/1.0.0 inspected; highest14, candidate1.1.0/build18 not observed as used |
| Existing product from source | `com.lovelies.memories.pro.monthly` | Verify both live product records, pricing, service credentials and notifications |

The live Play release notes describe old Featured Photos behavior. The new native
product follows its current48-screen scope; revise store copy and disclosures to
its actual private sharing/approval/entitlement behavior before submission. Do not
reintroduce retired public/professional features to match old marketing text.

The source currently proposes Android2.0.0/code18 and iOS1.1.0/build18. Android
code18 exceeds all10 observed uploaded versions (highest16); Apple build18 exceeds
the8 observed uploads (highest14). Refresh both histories immediately before
upload. Neither candidate may be
submitted until current upload history, signing and actual upgrade installation
are qualified. Keep the donor repository and existing releases recoverable until
both updated store apps are live and the observation/rollback window is complete.

Local Apple signing readback: the valid IKANISA LTD distribution identity matches
team63STJ5N27W and an existing App Store provisioning profile for
com.lovelies.memories expires9 August2027. Existing profiles have no APNs
entitlement, so push capability/profile refresh is still required before signing
the new entitlements. No existing key or profile was changed.

## Signing continuity readback

| Certificate | SHA256 from the current Play signing page |
|---|---|
| Play app signing certificate | `06:C0:F4:1F:B2:F6:5D:33:0F:70:15:44:D6:6E:30:69:87:4F:5C:58:A6:B7:DE:2C:2D:C7:0E:CD:BA:3F:37:A8` |
| Play upload certificate | `D7:A0:AA:02:BB:C9:66:5C:88:00:52:AB:6E:17:EE:0C:6D:61:C6:22:38:39:83:5C:C3:2A:74:A6:A0:DC:1C:7C` |

The recovered donor upload keystore's public certificate matches the current Play
upload certificate exactly. A verified private local copy now lives in
`.release-secrets/android/`, directory0700/files0600 and excluded from Git. The
donor files were only read and remain unchanged. The release Gradle configuration
reads that private properties file, requires the current expected certificate
fingerprint and highest uploaded version as explicit inputs, and has no debug-key
fallback. No AAB has been produced or uploaded. Receipts:
`android-upload-key-readback.json` and `android-signing-continuity.json` under
`verification/supabase-release-20261023/`.

The matching local development profile includes the paired iPhone12Pro and its
certificate has a valid local private identity. A separate copy of the compiled
Debug app was signed and strictly verified for **reference UI QA only**. It omits
APNs/associated-domain entitlements and has not been installed by this chat.
Production source entitlements remain intact. This artifact cannot establish
push, universal-link, store signing or in-place update acceptance. See
`iphone-profile-join.json` and `qa-iphone-signing.json` in the same receipt folder.

## Current Apple configuration differences

The inspected Apple app is Photo & Video, English(U.S.), with the existing
13+ global rating on current OS versions (regional exceptions and an older-OS4+
rating are displayed). The app currently identifies as a non-trader; the owner
must qualify the intended business/territory declarations. Current production
and sandbox subscription callback URLs both point to
`https://lovelies.api.ikanisa.com/subscriptions/apple/notifications`; qualify their
new Supabase destination/compatibility before cutover.

Published Apple description and reviewer notes still claim on-device-only
processing, no raw-selfie upload, phone/code reviewer access and Featured Photos.
Replace those through the next reviewed version using the prepared listing,
privacy and reviewer instructions. No existing reviewer credential was copied,
used or placed in source. Live product/pricing/notification credentials still
need current verification. The browser session expired after the readback;
future console work requires a signed-in session again.
