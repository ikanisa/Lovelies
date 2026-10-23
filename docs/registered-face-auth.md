# Anonymous enrollment and registered-face authentication

The active service is `services/cloudflare-api`: one Cloudflare SQLite Durable
Object owns accounts, credentials, registered references, consent, devices and
one-use challenges. Private R2 holds temporary captures and derived references.
The active service and client have no OTP flow or OTP verifier dependency.

`POST /auth/anonymous` creates an opaque, durable enrollment account. Its
`auth_method: "anonymous"` credentials can use `/me`, refresh, logout and face
enrollment, and request their own account deletion without face registration.
A separate private receipt permits deletion-status checks after account erasure;
it grants no account or media access. See
[the anonymous deletion contract](/Users/jeanbosco/Documents/Lovelies/docs/anonymous-account-deletion.md).
They cannot use gallery, photo processing, sharing or administrative
capabilities. A successful enrollment automatically returns
`auth_method: "registered_face"` credentials for **the same account**, revokes
the previous sessions and consumes the challenge in one synchronous transaction.
There is no additional sign-in form or client-controlled role upgrade.

This establishes an account-to-face reference. It does not establish a person's
civil identity, KYC status or administrative authority.
The first account receives only the server-defined `user` role.

## Wire contract

| Request | Result |
|---|---|
| `POST /auth/anonymous`, JSON `{}` | `201`, `access_token`, `refresh_token`, `expires_in:900`, `token_type:"Bearer"`, `roles:["user"]`, `account_id`, `auth_method:"anonymous"`. Extra authority fields are rejected. |
| `GET /me`, bearer | Current account summary. Anonymous scope is `anonymous_enrollment`; verified scope is `registered_face_profile`. `authenticated` reflects current durable authority. |
| `POST /auth/face/registration/challenge`, enrollment/verified bearer | Legacy JSON `{device_public_jwk, consent:{purpose:"face_authentication",policy_version,granted:true}}`. Recoverable anonymous enrollment also supplies `account_id,enrollment_key,face_handle,device_signature`, saved before dispatch. Identical retries preserve one device/consent/challenge. A P-256 public key may contain no private `d` component. |
| `POST /auth/face/registration/recovery` | Signed original-device lookup returns lifecycle, challenge and accepted capture metadata only. No session or media authority. |
| `POST /auth/face/registration/resume`, same-account anonymous bearer | Signed exact predecessor/resume key creates one successor on the same device/key/consent after expiry/session rotation; retries return that successor. No replacement during unresolved verification/media writes. |
| `PUT /auth/face/proof/{challenge_id}/{index}` | Binary JPEG/PNG/WebP. Headers: `X-Lovelies-Capture-SHA256`, `X-Lovelies-Capture-Bytes`, `X-Lovelies-Device-Signature`, `Content-Type`. Returns only a bound capture receipt. Registration also requires its original account/session bearer. |
| `POST /auth/face/registration/complete`, original bearer | JSON `{challenge_id,device_signature}`. Backend face comparison automatically returns verified credentials and profile/device metadata. |
| `POST /auth/face/challenge` | JSON `{face_handle,device_id}`. Returns an opaque one-to-one login challenge for the current registered reference. A handle alone provides no access. |
| `POST /auth/face/complete` | JSON `{challenge_id,device_signature}` following the new challenge's signed fresh capture. Returns current verified credentials. |
| `POST /auth/session/refresh` | JSON `{refresh_token}`. Atomically consumes the old refresh token, rechecks account/profile/consent/device authority and rotates credentials. |
| `POST /auth/logout`, bearer | Revokes the current session and cancels its unconsumed enrollment challenges. The client clears its local session before waiting. |

Challenges carry `protocol:"lovelies-face-auth-v1"`, `challenge_id`, `account_id`,
`device_id`, `device_revision`, `nonce`, `purpose`, `profile_id`,
`profile_revision`, `model_id`, `policy_version`, `required_captures`, `poses`,
`expires_at` (ISO UTC), and `maximum_capture_bytes:8388608`. A first profile has
null profile/model fields and requires three **distinct** fresh captures in the
`front,left,right` order. An existing-profile activation or later login requires
one fresh `front` capture against that exact reference. Expiry is 120 seconds;
aggregate capture size is at most 8 MiB. There are at most three pending
challenges and ten issued challenges per account per fifteen minutes, with at
most three verifier attempts for one challenge.

## Device signatures and private verifier

Device signatures are raw 64-byte ECDSA P-256/SHA-256, encoded as unpadded
base64url. Sign UTF-8 JSON with object keys sorted recursively, using the exported
client `faceSigningBytes` helpers. The envelope includes
`protocol:"lovelies-face-device-v1"`, challenge/nonce/purpose/account/device/
device revision/profile ID/profile revision/policy fields. Capture signatures
add `step:"capture"`, `capture_index`, `capture_sha256`, `mime`, and `byte_size`.
Completion signatures instead add `step:"complete"` and ordered
`capture_manifest:[{index,sha256,mime,byte_size}]`. The server verifies signatures
cryptographically and hashes the actual received bytes. A signature does not,
by itself, prove trusted camera capture or biometric liveness.

Only the private Cloudflare `FACE_AUTH_VERIFIER` binding is called, at
`/v1/face-auth/verify`. The multipart body contains an `envelope` JSON field,
`capture_0..2` binaries and, when present, the exact private `reference` binary.
No externally supplied URL, client score, client vector or client boolean is
accepted as identity authority. The envelope uses
`protocol:"lovelies-face-auth-verdict-v1"`, the device-bound fields, model ID,
reference digest/mode, capture manifest, required poses and millisecond expiry.

The backend verdict must echo every bound identity/reference/capture/policy
field and contain a current `verified_at`, unexpired `expires_at`, `receipt_id`
and `identity_verified:true`. First registration also requires
`enrollment_verified:true` plus
`registered_reference:{model_id,revision,template_sha256,template_base64}`.
`template_base64` is **unpadded base64url**, at most 64 KiB of derived reference
bytes. The server chooses its private R2 key and profile ID. An existing profile
requires `reference_match:true` and returns no replacement reference.

**Owner policy: no liveness.** No PAD, blink, movement challenge, head-turn
verification or camera-injection qualification is required. Three profile
selfies retain ordinary enrollment pose guidance. The private copied YuNet/SFace
service detects one usable face in each selfie, compares their embeddings and
returns a private registered template. Subsequent authentication compares a
fresh challenge-bound selfie with that template. A device signature binds image
bytes to a challenge; it does not certify a camera sensor or a live person.

Missing model service or an invalid bound verdict returns `503` without an
upgraded session. Failed face/reference comparison returns `401`. Every crypto,
capture, R2 and provider await is followed by a current account/session/profile/
consent/device/challenge check. Challenge consumption, session creation and
account upgrade are atomic. Authentication, photo matching and photo processing
consents remain separate.

Raw captures have no public URL. Pending private writes are recorded before R2
PUT and settle only after the actual promise settles, preventing erasure from
finishing ahead of a late writer. Consumed, failed, cancelled or expired captures
are deleted and checked absent before their proof rows retire.
`cleanupFaceProofs` is called by root maintenance; failed deletions remain durable
retry obligations. Only the derived registered reference is retained.

Enrollment journals and the [recovery contract](/Users/jeanbosco/Documents/Lovelies/docs/enrollment-recovery.md)
preserve account/device bindings across interrupted responses and restarts.
Recovery of a committed enrollment grants no credentials; a lost completion
response requires the existing fresh-selfie comparison against the same private
registered reference. Guest deletion freezes enrollment and wins the final
transaction race. No OTP or replacement anonymous account is introduced.

## Client and remaining integration

```js
const anonymous = await client.startAnonymous();
const challenge = await client.startFaceRegistration({
  devicePublicJwk: nativeDevicePublicKey,
  policyVersion: currentExplicitlyAcceptedAuthPolicy,
});
for (let index = 0; index < challenge.poses.length; index++) {
  const capture = await captureLiveCameraPose(challenge.poses[index], challenge);
  await client.uploadFaceCapture(challenge, {
    index, bytes: capture.bytes, mime: capture.mime,
    sign: nativeP256Sign, // Signs supplied canonical bytes; retains its private key.
  });
}
const verified = await client.completeFaceRegistration(challenge, {
  sign: nativeP256Sign,
});
// Save verified.registeredFace + device-key association in the native adapter.
// verified.session contains a summary, never bearer/refresh tokens.
```

Android implements Camera2 capture, Android Keystore P256 signing and encrypted
credential storage. iOS implements AVFoundation capture, Keychain/P256 signing
and a URLSession repository. Both default to anonymous bootstrap and upgrade
from the backend completion response. Review fixtures are selected explicitly;
they are never an authentication fallback. Native device/runtime verification
results are recorded in `verification/cloudflare-native-port`.

The JavaScript SDK accepts caller-owned capture/signing functions. Its
credentials remain in private memory and its epoch/account fences reject late
responses. Native adapters retire their own capture and protected image buffers.
Ordinary logout clears credentials, images and operation drafts while retaining
only the hardware key and encrypted opaque face/device handle for a fresh-selfie
sign-in. Device revocation and account deletion also retire those references.

No face/session write is automatically replayed after an ambiguous response.
If successful enrollment/refresh returned no recoverable response, use the saved
face handle and original device key with a **new** fresh-capture challenge.
Lost-device recovery uses an explicitly saved private backup plus a fresh selfie
against the same current registered reference. See
[the account recovery contract](account-recovery.md). The backup selects one
account, never grants media/session access by itself, and cannot silently replace
the reference or regrant withdrawn authentication consent. Old devices and
sessions are revoked only after backend verification activates the new device.

Android and iOS also implement [own face-profile lifecycle](face-profile-lifecycle.md).
Cloudflare binds signed management operations to the original account and device
key. Replacement compares three fresh selfies against the existing reference
before publishing a new revision. Pause/resume controls matching and receiving;
authentication-consent withdrawal separately revokes sign-in authority. A retained
reference permits explicit consent restoration with one fresh comparison. When
no remaining purpose authorizes the reference, removal requires actual private
cleanup before three-selfie enrollment on the same account and original key.
Neither restoration nor re-enrollment silently regrants matching/processing.
Private management journals survive restart and explicit logout without retaining
session credentials; read-only status does not grant sign-in or photo access.

Both native capture flows also implement [camera recovery](camera-recovery.md):
bounded initialization, permission rechecks, interruption retirement, local
review/use/retake and bounded backend quality errors. Known quality rejection
reconciles signed status before a successor challenge; accepted slots cannot be
overwritten. Unknown ordinary sign-in proof/completion replies remain held on
the original account/device key through the actual challenge expiry. Exact
terminal `401 face_verification_failed` permits explicit fresh sign-in; other
unauthorized responses do not create a guest or silently switch authority.
Staged completion credentials require current profile/active-device validation,
and explicit logout retires them before revocation.

Focused protocol tests use actual workerd, SQLite Durable Objects and R2 with
explicitly synthetic private inference fixtures. The copied Python service also
has tests loading the actual YuNet/SFace ONNX files and exercising its private
adapters. These results are local implementation evidence; hosted deployment,
physical-camera testing, face-accuracy evaluation and store release acceptance
remain separate. There is no liveness acceptance gate.
