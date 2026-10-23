# Camera capture and recovery

Android and iOS keep camera readiness separate from face-profile activation.
Cloudflare owns the account, registered reference, consent and authentication.
Anonymous enrollment upgrades automatically only after backend verification of
the required selfies. No OTP, Face ID substitution or liveness/PAD is added.

## Permission and camera lifecycle

The capture screen distinguishes permission not yet requested, granted, denied,
restricted where supported, and revoked. Permission is checked again on return
from Settings and before capture. A denied camera offers the appropriate request
or Settings action. Initialization has a bounded wait and an explicit retry;
disconnect, unavailable hardware, capture timeout and interruptions clear readiness.

Leaving the foreground stops/releases camera work and retires unsent reviews.
Return rechecks permission and starts a fresh camera generation. Callbacks from
an old surface, request or generation cannot publish a photo or restore readiness.
Android uses Camera2/TextureView; iOS serializes AVFoundation configuration and
capture work off the main thread. Photo callbacks are tied to the exact request,
and iOS waits for final capture success before offering the photo for review.

Preview mirroring and signed JPEG orientation are distinct. Review decodes the
upright image with its orientation metadata; retaking never modifies an already
accepted signed capture. Physical orientation/camera behavior requires device
verification separate from the software state and declared-photo tests.

## Review, use and retake

A fresh selfie is kept as a bounded local candidate. It is not uploaded until
the user chooses **Use photo**. **Retake** discards that unsent candidate without
changing the accepted manifest or sending another proof. Backgrounding, leaving
the screen, permission loss, account changes or capture-context expiry retire it.

Approval rechecks the exact account, device/key, challenge, generation, pose and
next capture index, along with foreground and size limits. Accepted captures are
immutable. Local JPEG decoding or camera readiness never proves face quality,
matching, sign-in or profile activation.

## Quality errors and signed recovery

Cloudflare returns bounded `422` completion codes for no usable face, multiple
usable faces, insufficient aggregate quality or an invalid image. The public
response contains the error code only, with no reference, capture index, numerical
score or identity details. Low quality advises better light and steadiness; it
does not claim a separately measured blur or lighting diagnosis. The existing
model quality and comparison thresholds are unchanged.

A quality-rejected set is terminal failed. The backend attempts exact private
proof cleanup and retains durable retry rows if cleanup is unavailable. The app
checks signed status, then explicitly obtains a successor generation on the same
account and original device key and retakes the required set. It cannot use a
rejected photo anyway or overwrite an accepted slot.

Oversized, unsupported or unavailable capture responses retain their existing
input/storage errors. Ambiguous proof/completion replies require reconciliation
before another write. Existing enrollment, saved-key recovery and profile-lifecycle
journals keep their authority and purpose boundaries.

Ordinary retained-device sign-in also saves a private hold before proof/completion
dispatch. Unknown replies stay held until the original challenge expires; retry
does not create a new guest or substitute a device key. Completion credentials
are staged until current account/profile and unique active original-device checks
pass. Explicit logout retires and revokes staged credential authority before it
can be published. Expired staged credentials cannot be repeatedly installed as
a successful sign-in; recovery preserves the original identity for a fresh selfie.

## Evidence

- [Current implementation and actual execution results](/Users/jeanbosco/Documents/Lovelies/verification/camera-recovery-20261014/README.md)
- [Quality wire contract](/Users/jeanbosco/Documents/Lovelies/verification/camera-recovery-20261014/quality-contract.md)
- [Enrollment recovery](/Users/jeanbosco/Documents/Lovelies/docs/enrollment-recovery.md)
- [Profile lifecycle](/Users/jeanbosco/Documents/Lovelies/docs/face-profile-lifecycle.md)

Execution results are recorded separately. Local models, declared photographs,
state tests and emulator callbacks do not establish physical camera provenance,
camera-sensor attestation, civil identity, model qualification, hosted deployment
or store acceptance. Full iPhoneOS app/Keychain/Secure Enclave checks require the
corresponding SDK and device environment.
