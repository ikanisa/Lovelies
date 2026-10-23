# Resumable personal photo uploads

The existing Android and iOS upload screens keep one durable batch, its selection
order and caption, and a private staged copy of each selected source. Transfer
records bind the Cloudflare origin, account and registered device. They retain the
original reserve, complete and cancel operation keys. A restart or interrupted
reply resumes that batch rather than creating another upload or account.

Android protects the journal and staged files using its Keystore and encrypted
atomic files in app-private no-backup storage. iOS uses its device-only Keychain
journal and protected Application Support files. Tokens are not scheduler input.
Each explicit resume revalidates the current account, device, session and photo
processing consent. Logout pauses retained work; a different account cannot use
it. Late callbacks cannot publish into a newer account or presentation.

## Transfer and recovery

`POST /uploads/session` opts in with `resumable: true`, the full lowercase SHA-256,
byte size, MIME type, original operation key and personal batch ID. Cloudflare
returns an asset and a bounded chunk endpoint. JPEG, PNG and WebP sources are
limited to 20 MiB. The legacy non-resumable route remains compatible.

`PUT /uploads/:id/chunks?offset=N` accepts contiguous 256 KiB chunks, with a smaller
final chunk and `X-Lovelies-Chunk-SHA256`. An identical offset, size and digest is
an idempotent replay. Gaps, changed overlaps and invalid hashes fail. Durable
private R2 writes precede acknowledged offsets. Local bytes are checked against
the staged source before sending; client progress reports the server's accepted
bytes.

`GET /uploads/:id/status` supplies the durable accepted offset, original metadata
and separate transfer/processing state. After a lost response, the clients
reconcile this same asset and original operation. A full acknowledged prefix can
still need private assembly. Cloudflare verifies each chunk, the full digest and
supported image bytes before publishing an uploaded source. Interrupted assembly
can be retried without sending the accepted prefix again. Invalid final content
is terminal rather than an endless full-progress retry.

Completion uses the original operation key and starts processing only after
verified source assembly. A known failed processing attempt can receive a new
complete key only on explicit retry. An uncertain operation retains its original
identity. Status and operation reconciliation do not create a second asset or
processing attempt.

A terminal source rejection can be explicitly discarded locally before choosing
a corrected source. Its server error, asset and operation identity stay recorded;
discarding local bytes does not claim successful processing or remote erasure.

## Pause, cancellation and lifecycle

Pause stops advancing to the next chunk and cancels the active client request.
The server may already have accepted that chunk; resume trusts server status.
The current implementations use bounded native tasks and explicit resume after
interruption or relaunch. They do not promise uninterrupted execution after a
user force-quit, arbitrary background scheduling or automatic login.

Cancellation persists its original operation before sending
`POST /uploads/:id/cancel`. Cloudflare immediately fences publication, then
durably cleans exact private source/chunk objects after writers settle and
applicable retention/moderation holds permit deletion. `cleanup_pending` remains
truthful. Owner status and cancellation remain available after photo-processing
consent withdrawal; writing, assembly and processing do not. Already processing
or ready photos cannot be silently deleted by cancelling a transfer.

Unfinished transfers expire after seven days. Uploaded, processing and ready
photos are outside that unfinished-transfer expiry. Account deletion also
inventories transfer objects and cascades the new metadata under the existing
approved privacy workflow.

## Sharing and evidence

An uploaded or processed photo is still private. Matching produces candidates,
not grants. The gallery to photo to matched recipients to exclusions to final
review and authorized approval path retains its current session, exact recipient
subset, block/consent and store-entitlement checks. Anonymous-first authentication
and backend registered-selfie verification remain unchanged, with no OTP.

See the [source-bound verification record](../verification/resumable-uploads-20261023/README.md)
for actual results and remaining native-device, hosted and release acceptance.
