# Lost-device account recovery

The owner selected a saved private recovery key plus a fresh registered-face
selfie. This is A02, separate from [interrupted enrollment recovery](enrollment-recovery.md).
Anonymous-first enrollment and automatic backend upgrade remain. No OTP.

While signed in, the user can create a private backup in Account & Security.
The native app generates 256 random bits, saves them encrypted before requesting
registration, and offers explicit backup/copy. Cloudflare stores only its hash,
bound to that exact account, face reference/model/digest, account/profile epochs,
authentication consent and policy. One backup is current, valid for one year;
replacing or revoking it cancels its pending recovery attempts. Identical current
requests reconcile; an old operation never silently rotates the newer backup.

The backup format is `LVR1:<account UUID>:<opaque recovery key>`. It is a private
account locator and recovery capability, not a password or a photo-access grant.
If all device keys and this backup are lost, recovery remains unavailable. The
app does not scan other registered users' faces or create a replacement identity
on the account being recovered.

On a new device or after reinstall, Recover my account imports the saved backup.
A separate encrypted journal and new P256 alias precede dispatch. The backend
issues a signed, one-use, one-capture challenge against the account's exact
current registered reference. The original device private key is neither copied
nor recreated. Matching and photo-processing permissions remain independent.

Only a bound private verifier result can complete recovery. The final transaction
consumes the backup and challenge, activates the new device on the same account,
revokes old devices and sessions, and issues registered-face credentials.
The existing face reference, roles, entitlements, consents, approved subsets and
photo ownership remain. Matching candidates never become access grants.

Lost start/capture replies are reconciled through new-key-signed metadata. Expired
proofs require a fresh successor on the same pending device; in-flight writers
and verifiers prevent replacement. A committed but lost completion response
returns metadata only and requires a new fresh-selfie login using the saved new
device. Credentials are saved and validated against current `/me` before local
identity promotion. Deletion holds take priority over recovery. Changed or
withdrawn authentication authority never regrants consent through a backup.

The exact request/signature/receipt contract is recorded in
[the A02 wire contract](../verification/account-recovery-20261014/api-contract.md).
SQLite migration v5 is additive; local tests do not authorize production
migration or hosted deployment. Device, camera, Keychain/Secure Enclave, hosted
and release acceptance remain separately evidenced.
