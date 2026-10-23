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
| Subscription | Google Play verified `com.lovelies.memories.pro.monthly`, active monthly auto-renewing `monthlypro`,175 countries/regions; backwards compatible, one legacy price point | Apple product6799678587 is approved, one month, same product ID;41/175 regions available. Actual provider/purchase/restore remain unqualified; no store product changed |

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
used or placed in source. Both store sessions were restored in Codex. The approved existing Apple product and current regional pricing/availability were subsequently read back; actual provider credentials and purchase/restore/delivery remain unqualified.

## Current Play product/provider readback in Codex

The Codex in-app browser retained the correct IKANISA session after the external
Chrome session required sign-in. Read-only inspection confirms one subscription,
Lovelies Monthly Pro (`com.lovelies.memories.pro.monthly`), with active monthly
auto-renewing base plan`monthlypro`,175 countries/regions, one legacy price point
and backwards compatibility. Current grace is7days and automatic account hold
53days; offer changes charge at the next billing date and resubscribe is allowed.
Observed regional examples are US USD4.99, Austria EUR4.99 and Ireland EUR5.49;
these are samples, not a universal price or recommendation. Native billing must
continue using the store's localized eligible product/offer values.

Subscription pause and real-time notifications are enabled. The existing topic is
`projects/easymoai/topics/lovelies-google-play-rtdn`; notification content is
subscriptions and voided purchases only. Topic/receiver/IAM/OIDC, provider service
credentials and actual delivery still need qualification/cutover. No test
notification, price/product edit, alternative billing or external offer setup was
performed. Apple product readback is recorded below; provider and purchase/restore checks remain open.
Receipts: `play-subscription-readback.txt`, `play-base-plan-readback.txt`,
`play-monetization-readback.txt` and `play-product-final.json` in the release
verification folder.

Google Cloud readback also confirms active subscription
`projects/easymoai/subscriptions/lovelies-google-play-rtdn-push`. It pushes to
`https://lovelies.api.ikanisa.com/subscriptions/google/notifications`, with OIDC
authentication enabled as`lovelies-rtdn-push@easymoai.iam.gserviceaccount.com` and
the same old endpoint as audience. Payload unwrapping is disabled; retry is
immediate, dead lettering disabled, acknowledgement deadline10seconds and
retention7days without acknowledged messages. No subscription/IAM/configuration
was changed and no message was pulled, acknowledged or sent. This is current
configuration readback, not successful delivery. The Supabase cutover must
explicitly reconcile endpoint and expected audience with one writer and qualify
store-state refetch/idempotency; the current URL does not deliver to the new Edge
API. See`google-rtdn-subscription-readback.txt` in the verification folder.

## Current Apple product readback in Codex

The signed-in correct Lovelies record confirms subscription group `22297275`,
Lovelies Pro, and product `6799678587`, Lovelies Monthly Pro, both approved.
Product ID `com.lovelies.memories.pro.monthly` and one-month duration match the
current iOS and API configuration. Availability is **41 of175 regions**, compared
with Google's175. Current regional price samples are Austria EUR5.99 and Canada
CAD6.99; the expanded current-price table shows zero introductory offers. These
are observed samples; native purchase presentation must use eligible localized
StoreKit values. No price, region, product or reviewer note was edited.

The group shows Billing Grace Period “Set Up” and streamlined purchasing On.
Any intended grace-period or territory change requires release review; this
readback does not qualify store billing/restore, agreements/trader declarations,
provider credentials or callback delivery. Existing review notes still refer to
build14, phone-code reviewer access and Featured behavior and must be replaced
through the prepared current-version instructions. Receipts are
`apple-product-final.json`, `apple-subscription-group-readback.txt`,
`apple-subscription-product-readback.txt` and `apple-current-prices-readback.txt`
under `verification/supabase-release-20261023/`.

## Initial Apple agreement blocker (cleared after owner review)

Signed-in Business readback shows Paid Apps Agreement **Active** and Free Apps
Agreement **Active (New Agreement Available)**. Apple's banner explicitly blocks
existing-app updates/new submissions until the Account Holder reviews and accepts
the updated Apple Developer Program License Agreement. The Developer account
page specifies29 October2026 to retain membership-resource access. The final
review modal is staged in Codex for the owner; **no acceptance occurred**.
Displayed required tax-form and DSA/DAC7 statuses are Active, which does not
validate the substance of the existing non-trader/territory declarations. No
banking/tax values or reviewer credentials were copied, no financial change was
made, and no agreement was accepted. See `apple-agreements-status.json` and
`apple-agreement-review.png` in the release receipt folder.

## After the owner's agreement review

The owner reported completion. Subsequent signed-in Business readback shows the
original Program License blocking banner absent and Free Apps Agreement Active,
effective23 October2026. Paid Apps remains Active for the current period and now
shows New Agreement Available; Apple's banner offers new Paid Applications
terms for owner review. This is a different agreement from the completed Program
License step. No legal terms were accepted by this agent. Prior readback is
preserved in `apple-agreements-status-before-owner-acceptance.json`; current
status is in `apple-agreements-status.json`.
