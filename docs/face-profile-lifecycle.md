# Face-profile lifecycle

Cloudflare owns the account, registered reference, consent, device, operation and
cleanup authority. Android and iOS manage the user's own profile from Settings.
Anonymous-first enrollment and automatic backend verification remain. There is
no OTP, public face search, liveness/PAD or identity-document flow.

## Separate purposes

| Choice | Authentication | Matching and recipient access | Private reference |
|---|---|---|---|
| Pause matching | Current sign-in remains | Revoke current matching consent, disable receiving and invalidate old candidates, recipient grants and accepted requests | Retain only while another current purpose authorizes it |
| Resume matching | Unchanged | Explicit current matching consent starts a new episode; old access remains revoked | Existing current reference |
| Replace profile | Three fresh signed pose-guided selfies must each match the old reference and be mutually consistent; publish a new revision atomically | Current separately granted matching consent binds the new revision; old recipient bindings are invalidated | Retire only the exact old reference after the new one is verified and published |
| Withdraw authentication consent | Disable face sign-in and revoke sessions, challenges, recovery keys and other devices | Separately authorized matching and processing remain | Retain if current matching requires it; otherwise retire it with confirmed cleanup |
| Restore authentication | Explicit current authentication consent and one fresh comparison against the retained reference | No matching or processing regrant | Same retained reference |
| Remove profile | Disable sign-in and revoke old authentication authority | Stop matching, receiving and old recipient access; separately authorized processing remains | Durable private cleanup; new enrollment waits for verified removal |
| Enroll after verified removal | Explicit current authentication consent and three ordinary profile selfies | Matching stays off until separately consented | New profile on the same account and original device key |

Accounts, uploads, roles and store entitlements remain through profile changes.
Revocation cannot recall copies already downloaded or forwarded. A deleted
reference cannot be used to verify a later selfie against the former face.

## Recovery and original identity

Before dispatch, the native app saves an encrypted purpose-limited management
control bound to the current account, original device, original key alias,
normalized public-key digest and device revision. Cloudflare stores its hash and
the original public key, never the private key or plaintext control secret.
Status grants no session or media access. A withdrawn or removed profile does
not silently create an anonymous replacement account.

Each action saves its UUID, exact version and explicit consent before dispatch.
Capture operations also bind their exact challenge and generation. Signed
status reconciles lost start, capture and completion replies after restart.
Settled accepted-prefix captures report `pending`; `capture_pending` means an
actual unresolved writer and `verifying` means verification is in progress.
Neither state authorizes another capture. Expired or failed generations require
an explicit successor after the original writer/verifier has settled. Cancel
and logout fence late completion; cancellation cannot undo a committed revision.

Credentials returned by completion are staged privately. The client validates
the same account, profile and unique current active device before promotion.
When the committed response was lost, metadata remains read-only and a fresh
ordinary face comparison is required to obtain credentials.

Management controls last one year. Explicit renewal requires a valid current
registered-face session and the same original device key, revision, public key
and predecessor creation UUID. The new secret/body are journaled before POST;
the old control is retained privately. Exact lost-response retries are
idempotent. An expired control with no ambiguous active operation permits an
explicit ordinary sign-in against the retained reference, followed by separate
renewal. Withdrawn consent, removed reference, revoked device and deletion holds
remain server denials. Renewal does not regrant consent.

Deletion holds take precedence, then active profile-management holds, then
saved-backup and enrollment recovery. A stable authenticated control alone does
not prevent explicit same-account saved-backup recovery. The old control is
archived only after validated recovery-device promotion.

## Cleanup truth

Reference retirement records the exact profile ID/revision, private object key
and digest. Existing cleanup authority protects a live new reference, unresolved
writers and active moderation holds. Completion requires actual DELETE and
absent HEAD, with `pending`, `failed`, `blocked` and `completed` exposed honestly.
Metadata and public reports omit private reference bytes, storage keys, control
secrets, tokens and handles.

## Implementation and evidence

- [Wire contract](/Users/jeanbosco/Documents/Lovelies/verification/face-profile-lifecycle-20261014/api-contract.md)
- [Cloudflare lifecycle](/Users/jeanbosco/Documents/Lovelies/services/cloudflare-api/src/face-profile.ts)
- [Registered-face authentication](/Users/jeanbosco/Documents/Lovelies/docs/registered-face-auth.md)
- [Android lifecycle](/Users/jeanbosco/Documents/Lovelies/android/app/src/main/java/com/lovelies/frontend/preview/FaceLifecycle.kt)
- [Swift lifecycle wire types](/Users/jeanbosco/Documents/Lovelies/ios/Lovelies/Native/CoreWire.swift)

Verification is recorded separately from this protocol description. Local
fixtures and host models do not establish iPhoneOS app/device, camera-sensor,
civil-identity, final-container, hosted deployment or store acceptance.
