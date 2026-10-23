# Store privacy and data-safety worksheet

Prepared **23 October 2026** for the new native implementation. This is a source-
based worksheet, not submitted console answers. Reconcile it with the final
deployed services, enabled SDK configuration and every version still distributed.
The existing listing's on-device-only and phone-verification claims do not fit
this implementation.

## Current data flows

| Implementation data | Proposed Apple categories | Proposed Google categories | Purpose and required/optional decision |
|---|---|---|---|
| Anonymous/registered account IDs, consent records and account-security audit links | User ID | User IDs | App functionality/account management and security. Required for account services; anonymous does not mean unlinked. |
| Device registration ID, public signing key and opted-in APNs/FCM token or installation identifier | Device ID | Device or other IDs | Device-bound security; optional notification delivery. Declare actual SDK/provider collection separately. Private device keys are not uploaded. |
| Three registration selfies, later authentication/recovery captures and derived registered face reference | Photos or Videos; Sensitive Info for biometric reference | Photos; Other info for biometric reference, subject to the console's current available types | Authentication and fraud/security functionality. Explicit authentication consent; required to use registered-face features. Separate optional matching consent does not make required authentication collection optional. |
| Chosen uploaded photographs, reduced previews and derived matching references | Photos or Videos; Sensitive Info for face-derived references | Photos; Other info for face-derived references | User-selected uploads and separately consented processing/matching. Match suggestions create no recipient access. Do not label this on-device-only. |
| Profile display name/avatar, caption, support/safety/privacy requests and reviewer notes | Name; Photos or Videos; Customer Support; Other User Content, as actually entered | Name; Photos; Other user-generated content | User-provided profile/content and requested support or privacy operation. Optional fields must really be optional in every supported flow. |
| Purchase token/signed transaction, product, account binding, verification, expiry/refund/revocation records | Purchase History | Purchase history | Store entitlement verification and fraud prevention. No developer receipt of card/bank details is implemented. Optional purchase. |
| Sharing requests, recipient decisions, favorites and notification/activity records | Product Interaction and/or Other User Content, according to the final fields | App interactions and/or Other user-generated content | Private sharing, selection, current authorization and requested updates. Account-linked. |
| Server logs, rate/security signals, processing failures, request IDs and retention/erasure evidence | Diagnostics or Other Diagnostic Data where applicable | Diagnostics or Other app performance data where applicable | Security and reliable operation. Inspect the actual hosting, inference and provider log fields/retention before choosing final answers. |
| Gallery search text sent in API queries | Search History if retained/collected under Apple's definition | In-app search history according to actual off-device processing | App functionality. Inspect gateway/database logs; do not infer that query text is never retained. |

All account-scoped rows are linked to the account/device in the current design.
No advertising SDK, advertising identifier, data broker or cross-company tracking
is intentionally enabled by this source. That observation is not a completed SDK
or provider audit and does not justify automatically answering every tracking or
sharing question “No.”

Original JPEG/PNG/WebP bytes may retain embedded EXIF metadata. The current code
does not establish that all originals have GPS metadata removed. Inspect real
imports and processor/provider treatment; account for any location actually
collected or derived. Camera permission alone does not imply microphone, contacts
or location collection.

## Sharing and processors

Identify Supabase, the selected private inference hosting operator, Apple/Google
store verification, APNs/FCM and any enabled telemetry/logging service. Confirm
contracts, regions, actual payloads, retention and whether each acts only on
IKANISA's instructions. Photos and references must not enter notification payloads.
User-directed recipient sharing and a user's external system share sheet must be
assessed against the stores' actual sharing definitions/exceptions; neither
private buckets nor TLS alone establish end-to-end encryption.

The private model service reads image/reference bytes. Therefore the product
must not claim that the developer or its processors cannot read those bytes.
Only claim encryption in transit after verifying **all** configured production
transports, providers and SDKs.

## Completion gates

1. Approve audience/age rating, territories, processors, active retention and backup
   expiry; publish the corresponding policy/support/terms/deletion edition.
2. Read the exact signed artifacts' SDK/privacy manifests and network behavior,
   including FCM initialization/opt-out and server/provider logging.
3. Verify in-app deletion, the public deletion request page and the operated mailbox
   with tracked ownership/review/cleanup. A requested deletion is not completed
   erasure; deleting app data does not cancel store renewal.
4. Enter and review the two existing app records' current forms. Preserve a dated
   export/screenshots of the exact answers; do not submit this worksheet as proof.

## Primary guidance checked

- Apple's [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
  categorizes biometric data as Sensitive Info and requires assessment of linkage,
  purposes and third-party practices. Its account-linked definitions apply even
  without a person's civil name.
- Google's [Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)
  covers off-device collection, SDKs, pseudonymous data, collection purposes and
  sharing exceptions. Reconcile required/optional answers with actual availability
  of features and consent controls.
- Google's [account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
  require in-app and web request paths for account-creating apps. Apple's
  [review guidelines](https://developer.apple.com/app-store/review/guidelines/)
  also require in-app account deletion.

These links inform the worksheet; they are not a store or legal approval.
