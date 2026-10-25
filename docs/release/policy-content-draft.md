# Replacement policy content for the native Lovelies release

24 October update: the selected age/guardian and retention decisions are in
`retention-and-young-users.md`; their current review copy is in `web/`. The prose
below preserves the 23 October source draft. Unknown audience/retention choices
below are historical gaps, not new requests for owner approval. Production
publication still requires verified implementation and operations.

Prepared 23 October 2026 from the current implementation. This is a reviewable
release draft; it is not a statement that the new backend is deployed or that the
current website has been updated. Confirm the private inference operator/location,
retention necessity, audience, territories and support operation before publication.

The current public privacy and deletion pages were inspected in Chrome. They
still describe phone verification, on-device-only vectors, raw selfies never
being uploaded, photographer/event portals and Featured Photos. Those descriptions
must be replaced for this native release. Preserve the old published edition as
history rather than silently treating it as the new policy.

## Privacy notice text

Lovelies is provided by IKANISA LTD. Contact **info@ikanisa.com** about support,
privacy, an incorrect match or an account-deletion request. The current public
Play listing identifies IKANISA LTD, 204 FL1, Rue d'Argens, Gzira GZR1367, Malta.
Reconfirm controller/contact details before publishing this edition.

Lovelies provides private photo libraries and reviewed photo sharing. It creates
an anonymous account when you start. If you choose face authentication, the app
captures three profile selfies with ordinary front/left/right pose guidance and
uploads those images through encrypted transport to the private backend. The
backend compares them before registering a face reference and upgrading that same
account. Later sign-in uses a fresh signed capture compared with that registered
reference. There is no phone or email OTP, liveness test or civil-identity check.
The comparison does not prove that an image came from a camera sensor.

Face authentication, photo matching and processing uploaded photos have separate
consent controls. Authentication consent does not itself enable the other purposes.
Matching identifies possible recipients for review; it does not give them access.
A sender reviews the exact photo/recipient selection and exclusions. A recipient
must accept the relevant request before current access can be granted. Requests,
consent changes, blocks and account/device/session status are checked by the server.

The service handles account and device identifiers, device public keys, signed
capture proofs, uploaded selfies, derived face references, photos and reduced
previews, captions you provide, consent and sharing records, profile/preferences,
support and safety cases, privacy requests, purchase verification records,
notification tokens if enabled, and security/operational audit records. Device
private signing keys remain in protected device/browser storage; they are not
uploaded. The app does not request access to your entire library merely to enroll
your face. Photo import uses the photos/files you choose through system controls.

Supabase project ltqfplqevxztlswlzexn in EU West (Ireland) is the selected backend
for private PostgreSQL records and private Storage. A separately authenticated
private YuNet/SFace service processes the necessary image/reference bytes. Record
its actual hosting operator and location here after deployment qualification.
These data are not sent to messaging providers for face verification. Apple and
Google process store purchases. APNs/FCM process opted-in device notification
tokens and generic account-update messages; private photos and face references
are not included in notification text. Record any additional processor that is
actually enabled before completing store disclosures.

Photos, captures and exports are private. The service checks current authority
before issuing short-lived preview, original or export access. An original
requires the relevant access and a current verified production store entitlement.
The service cannot withdraw copies already saved or shared outside Lovelies by a
recipient. Do not upload content that you lack permission to process or share.

Capture files are temporary processing evidence and are scheduled for cleanup
following completion or expiry. Reference deletion, account deletion and retention
jobs require actual object deletion followed by absence verification; a failed or
uncertain cleanup remains pending. Active profile references, photos and operational
records follow the configured retention policy and any justified hold. The
selected schedule is recorded in [retention-and-young-users.md](retention-and-young-users.md).
Local enforcement now includes 60-day original/preview deadlines, 14-day inactive
reference-address minimization, native cache expiry within two days, and a 30-day
maximum routine account-security audit setting. The hosted schema8 baseline still
has the historical audit setting until the qualified additive migration is applied.
Local implementation does not establish hosted cleanup or provider backup expiry.
Publish the selected active schedule and backup-expiry period after operational
configuration and necessity review. Preserve only justified
financial, security, legal-hold and minimal erasure evidence after deletion.

You can review purpose consent, stop matching, manage the face profile, block or
report a person/content, request export and request account deletion in Settings.
Face-profile replacement/removal and sensitive account actions use fresh authority
and durable request/status handling. Deletion is available before enrollment too.
A deletion request is tracked through review and verified cleanup; submission does
not mean deletion has already completed. If the app is inaccessible, email the
published support address as described below. Support verifies account ownership
before disclosing or changing private data. Never email selfies, face references,
private keys, recovery secrets or payment-card details.

Store subscriptions are managed through the purchasing Apple/Google account.
Deleting Lovelies data does not cancel a store subscription. Cancel renewal in
your store account if desired. Refund, renewal, expiry and revocation follow the
verified store records and applicable store terms.

## Terms content to publish alongside privacy

Use Lovelies only for photos you are entitled to upload/process/share. Respect the
people pictured and their privacy choices. A possible face match is a suggestion,
not a guarantee of identity or permission. Review every proposed audience and photo
subset. Do not use the service for unlawful, abusive or objectionable content.
Report an incorrect match/content or block an unwanted account using the app; the
support address above is available if the app cannot be used.

Subscriptions are optional store purchases. Display the actual store-localized
price, period and renewal terms before purchase, provide restore/manage controls,
and describe the actual original-download entitlement. A pending, failed, expired
or revoked purchase does not grant original access. The Apple standard EULA remains
linked on iOS alongside these product terms. Preserve any required consumer rights;
final legal terms and market/audience decisions require the controller's review.

## External account-deletion page content

**Delete your Lovelies account**

In the app, open Settings → Privacy → Delete account. This route is also available
for an anonymous account before face registration. Confirm the request and retain
its displayed status/recovery information until it completes. You can return to
the original request after restart. No phone/email OTP is used.

If you cannot access the app, email **info@ikanisa.com** with the subject
**Lovelies account deletion**. Include the account ID or an existing support/privacy
request ID if you have it, the approximate last-use date and a return contact.
Do not include photos, biometric material, device keys, a recovery backup secret
or payment-card details. Support will explain a proportionate ownership check and
how to track the request before changing private account data. An email itself is
not proof of ownership or completed deletion. Operate this mailbox and record the
request in the controlled privacy workflow; do not automate deletion from an
unverified email.

The deletion workflow covers eligible account/profile and consent data, private
media/references, gallery/share links and related operational records, subject to
current authority, writer fences and justified holds. It retains only justified
financial/security/minimal erasure evidence. Publish the approved retention and
completion periods. Previously downloaded external copies cannot be withdrawn.
Cancel store subscription renewal separately in Apple/Google settings.

This page must contain a working email link and readable instructions without
requiring app installation. Verify the mailbox/request handling before marking
Google Play's external-deletion requirement complete.
