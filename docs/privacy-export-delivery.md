# Private export snapshots and resumable delivery

This repository supports the original one-use export grant, replayable delivery
v2, and chunked delivery v3. All three require the current account/session. An
export request still needs an independent approved privacy review. The additive
schema-16 migration and the source changes belong in the same coordinated API
release; the migration does not grant serving or restore clearance.

## Production and durable recovery

The export worker first materializes the explicit projections in
`privacy-export-catalog.ts` into private SQL snapshot segments in one transaction.
All projections are evaluated by one `INSERT SELECT`, giving them one PostgreSQL
statement snapshot even when another writer does not use the application's
advisory lock. The statement captures all rows from every included dataset, with a stable
order and no 25,000-row total limit. It does not return the account's entire data
to the API process. These segments omit secrets, device public keys, face
templates/vectors, private storage paths and counterpart identity graphs. The
financial projection includes only the approved amounts, currency and status.

Subsequent jobs read immutable segments in bounded fragments. A continuation
creates at most four 1 MiB chunks. Each chunk receives its exact object key,
digest, length, continuation cursor and media-write intent before Storage is
called. Every actual PUT, including the root manifest, has a unique immutable
key and writer intent. A complete verified read can recover a lost reply using
the existing bytes. If the key is absent, a retry allocates a distinct attempt
and retains the older unresolved writer and exact cleanup obligation. Absence
or a lease timeout never establishes that an earlier PUT has terminated. Only
an unpublished pending candidate may move to the replacement; verified chunk
bindings remain immutable. The next cursor commits only after the exact stored
bytes verify. A portable incremental SHA-256 state binds the whole
concatenated file without loading it in memory. That state can contain a private
tail of at most 63 bytes and is cleared once it is no longer required.

The durable job/outbox machinery continues queued work. The independent request,
review, account and lease are rechecked before each publication step. New source
records and source edits after capture cannot enter an older continuation. A
partial snapshot, pending chunk or missing chunk cannot become a published
export. Source segments are erased after publication. Their pending retention
deadline cancels an unfinished export and schedules exact-object cleanup.

For compatibility, a completed file at most 20 MiB is assembled within that
existing bounded allocation and published as a flat JSON file. Its intermediate
chunks become cleanup obligations. Larger exports remain chunked. The full-file
byte count and all indices must be JavaScript safe integers; there is no former
20 MiB or 25,000-row limit on a chunked artifact. Database, device disk and
operating capacity remain finite and must be qualified for the intended load.

## Delivery v3 wire contract

The caller durably saves one create key and a distinct acknowledgement key
before dispatch. `POST /privacy-exports/:request_id/deliveries` accepts exactly
`{"operation_key":"..."}`. It returns the existing v2 response for a flat file.
For a chunked file it returns:

```json
{
  "protocol": "lovelies-privacy-export-delivery-v3",
  "operation_key": "the-original-create-key",
  "request_id": "request-uuid",
  "delivery_id": "delivery-uuid",
  "publication_id": "publication-uuid",
  "account_id": "account-uuid",
  "session_id": "session-jti",
  "state": "available",
  "expires_at": "an-ISO-8601-deadline",
  "sha256": "the-complete-file-sha256",
  "bytes": 30000000,
  "chunk_count": 29,
  "chunk_bytes": 1048576,
  "manifest_sha256": "the-last-descriptor-chain-hash",
  "retrieve_path": "/privacy-exports/deliveries/delivery-uuid/manifest?offset=0",
  "ack_path": "/privacy-exports/deliveries/delivery-uuid/ack"
}
```

The example identifiers/digests are descriptive placeholders, not valid fixture
credentials. V3 expires at the earliest of one hour, publication expiry and the
original server session expiry. V2 retains its five-minute maximum. Refreshing
to another session does not transfer the old delivery. All responses are private
and must not be cached by shared infrastructure.

`GET .../manifest?offset=0` returns at most 128 descriptors. The next offset is
either null or the exact offset to request; offsets are nonnegative multiples
of 128. No other query parameter or duplicate offset is accepted. The fields
are `protocol: lovelies-privacy-export-manifest-v1`, `publication_id`,
`total_bytes`, `sha256`, `chunk_count`, `chunk_bytes`, `manifest_sha256`, `offset`,
`next_offset`, `previous_root`, and `chunks`.

Each descriptor contains `index`, `bytes`, `sha256`, `root_sha256` and
`retrieve_path`. The first chain root is:

```text
SHA256(UTF8(canonicalJSON({
  protocol: "lovelies-privacy-export-chunks-v1", publication_id
})))
```

For each descriptor, in exact index order, the next root is:

```text
SHA256(UTF8(canonicalJSON({previous_sha256, index, bytes, sha256})))
```

Canonical JSON sorts object keys lexicographically, emits integral numbers in
ordinary decimal form and uses normal JSON string escaping, with no whitespace.
The final root must equal the delivery's `manifest_sha256`. Page boundaries do
not reset the chain. Every chunk except the last has exactly 1,048,576 bytes;
the last has the remaining positive byte count. A client must also require the
exact expected descriptor count, total bytes, publication identity and original
same-origin paths.

`GET /privacy-exports/deliveries/:id/chunks/:index` returns
`application/octet-stream`. Those raw bytes are a fragment of one UTF-8 JSON
file, and a chunk boundary may split a multibyte character. Do not decode chunks
individually. Verify each fragment's length/digest, persist it under an exact
protected ownership identity and advance local progress only after persistence
has succeeded. Downloaded chunks can be verified and reused after process or
transport failure under the original unexpired delivery and session.

Before presenting the completed file or acknowledging it, concatenate the raw
fragments in order using bounded streaming I/O, verify the whole-file digest and
size, and ensure the descriptor chain is complete. The v3 format is fixed JSON;
the exported file keeps a `.json` extension. A device without sufficient space
must retain recoverable progress and explain the failure, not report delivery.

`POST .../ack` takes exactly `{operation_key, sha256}`, using the distinct saved
acknowledgement key and the complete-file digest. The response is replayable.
Acknowledgement retires the publication and creates exact cleanup obligations
for the manifest object and every chunk. A lost acknowledgement reply does not
authorize a new publication or cause a second logical acknowledgement.

## Retirement and verification boundaries

Expiry, account erasure and acknowledgement retire public access. Account
erasure also removes unfinished SQL snapshot content and clears hash-state
tails. Exact chunk keys remain in cleanup obligations until deletion/absence
has actually been checked. An uncertain writer continues to block a claim that
all bytes have been erased. An older producer's late acknowledged completion
can settle only its own writer, and its obsolete key remains scheduled for exact
cleanup. It cannot overwrite or republish its successor. Retention requires
every exact cleanup obligation, including abandoned attempts and duplicate
records, to resolve before removing lifecycle metadata. It respects current
legal and moderation holds and cannot use a bucket-prefix listing to delete
unknown objects.

The controlled tests cover a real PostgreSQL fixture with more than 25,000 rows
and a resulting file above 20 MiB, lost chunk/publication/acknowledgement replies,
snapshot consistency, cross-account/session denial, response-time expiry,
Storage tampering, chunk pagination, held writes returning after successor ACK,
held-copy cleanup, erasure, migration atomicity and SHA-256
restart vectors. Synthetic local evidence does not establish hosted capacity,
provider behavior, filesystem power-loss behavior or native release acceptance.
