# Enrollment recovery

Cloudflare owns the enrollment state. Android and iOS retain a private, durable
journal and the original device key so an interrupted request cannot silently
replace the anonymous account. There is no OTP.

Before initial dispatch, the journal records the account, enrollment UUID,
existing device-key reference, canonical public key, explicit authentication
consent, policy and random face handle. Cloudflare stores the handle hash and
creates one bound device/consent/challenge for that enrollment UUID. Identical
start retries return those original bindings; changed inputs fail.

Signed recovery returns current progress and accepted capture metadata. It
returns no credentials, photo access, raw captures or private reference data.
An authoritative missing start requires current same-account anonymous
credentials. A generic error or unavailable status never authorizes a new
account or replacement key.

| Recovered state | Action |
|---|---|
| Pending | Verify exact accepted capture hashes, indices, MIME and byte sizes; continue the first missing slot. Raw selfie files remain transient. |
| Capture pending / verifying | Retain the journal/key and reconcile again; do not duplicate or replace an unresolved request. |
| Restart required | Refresh the same anonymous account if necessary and obtain one successor on the original device/key/consent. New nonce and challenge require three fresh captures. |
| Registered | The original completion committed. Do not replay it. Use one fresh signed selfie against that exact registered profile to obtain credentials if the response was lost. |
| Missing key / revoked or changed authority | Keep the account recovery hold; do not create a replacement key or guest. |

Received completion credentials are journaled before separate device/session
promotion. Interrupted local writes can resume promotion after current-session
validation. A journal retires after durable promotion succeeds. Cancel, back
and background pause an unresolved enrollment.

Guest deletion has priority. Its local hold freezes enrollment while retaining
the same-account journal/key. The server cancels anonymous registration
challenges in the deletion-creation transaction and rechecks that fence after
verifier/media awaits. Confirmed deletion can retire that account's pending
key; rejection or expiry can resume its original account and enrollment. An
ambiguous hold never publishes a replacement account or authentication.

Recovery metadata expires thirty days after initial start. Cleanup waits for
related writers and capture deletion before retiring metadata; active registered
devices and profiles survive metadata expiry. Account erasure removes enrollment
rows before their challenge/device/consent foreign-key targets.

The [wire contract](/Users/jeanbosco/Documents/Lovelies/verification/enrollment-recovery-20261014/api-contract.md)
specifies signatures, short request deadlines, response fields and successor
replay. [Verification](/Users/jeanbosco/Documents/Lovelies/verification/enrollment-recovery-20261014/README.md)
separates local runtime/native results from hosted, physical-device and release
acceptance. A signed capture binds bytes to a challenge; it does not establish
liveness, civil identity or camera attestation.
