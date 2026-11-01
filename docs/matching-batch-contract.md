# Complete, bounded photo matching

This change removes the global1,000-other-profile admission cliff in the active
Supabase path. It does not establish recognition accuracy, hosted throughput,
production deployment, or permission to release photographs to recipients.

## Capture and immutable admission

Upload completion runs inside the existing serialized operation transaction.
It traverses current profiles in account-ID keyset pages of128, applying the
existing matching consent, account, receiving preference, block, paused-profile,
model and audience predicates. It captures the exact profile revision, template
key/digest, consent episode and audience context. A newly enrolled/reconsented
identity cannot enter an already admitted attempt.

New snapshots with at most128 eligible profiles retain the existing single-call
array form. Larger snapshots use `lovelies-photo-candidate-plan-v1` in
`processing_attempts.profiles_json`, containing `page_size`, `profile_count`,
`initial_sha256`, and `root_sha256`. All captured tuples live in
`processing_attempt_profiles`, indexed by attempt and contiguous ordinal, with
one ordinal per account. Capture writes respect the existing100-SQL-binding
limit. The transaction publishes the outbox job only after the complete count
and cumulative SHA-256 seal have been recorded. A failure during capture rolls
back the whole admission; no partial prefix becomes runnable.

The initial hash binds the attempt ID, processor nonce, source version/checksum,
model and exact inference generation. Each next hash is SHA-256 of the previous
hex hash, a newline, and the canonical captured tuple. Profile rows reject UPDATE;
privacy erasure may delete them after canceling affected live work. No old
snapshot, reference, consent or model generation is silently relabeled.

## Bounded private ranking

The active adapter accepts `POST /process-batch` and sends the authenticated
private request to `POST /internal/photo-batch`. Each call has at most128
profiles, the original private source, the explicit ranking protocol
`lovelies-photo-ranking-page-v1`, and an `include_preview` boolean. The existing
20MiB source,64KiB template,40MiB total request,6MiB response and55-second private
transport limits are unchanged. The128-profile limit keeps even maximum-sized
templates and source below the total request cap. This is a per-page bound, not
an eligible-population cap.

The private model uses the existing float32 cosine calculation, three reference
poses, per-account best pose, deterministic tie order and thresholds. For each
detected face it returns only the two closest **distinct accounts** in that page,
with their exact profile identity and distance. It returns no page-local match
acceptance. A query SHA-256 binds the original source checksum, face count and
ordered float32 query vectors; raw query embeddings never enter application
storage. All pages must return the same query digest and the same face count.

The adapter's existing request digest binds the source, complete page,
`include_preview`, protocol, request ID and inference generation. A legacy
`matches` reply cannot stand in for a ranking page. The service advertises the
additional `photo_matching_batches` capability and `photo_batch_profiles:128`
limit. The proxy allows the new private endpoint under the existing service
authentication, stream limits, deadline and redirect denial.

## Global confidence and progress

`processing_match_progress` retains the next ordinal, verified prefix hash,
query digest and at most two distances per face (up to100 faces). It stores no
template or query vectors. The application merges each page's two nearest
distinct accounts with the current global two. Any global first/second account
must have ranked first/second in its own page, so this reduction preserves the
complete-set best and runner-up without retaining every score. The unique
captured-account constraint prevents the same identity being mistaken for two
competitors across pages.

After each nonfinal page, a lease-checked transaction saves progress and returns
the attempt to `queued`. `processPhotoJob` returns `{pending:true}` only after
that durable checkpoint. The job runner returns its current queue lease to
pending, undoes only this successful page's attempt-count increment, and retains
earlier failure count/error evidence. It does not record photo completion. A
crash between checkpoint and acknowledgement resumes from the saved ordinal;
pure inference may safely be repeated if its result was never checkpointed.

Before publication, the final cumulative hash must equal the sealed root and
there must be no extra captured ordinal. The final decision applies the existing
distance threshold0.42 and positive distinct-identity margin of at least0.05 to
the **global** scores. A lone identity retains the existing absent-runner-up
distance1.0 convention. Ties and insufficient margins create no match proposal.

The original source/lease/session/generation checks surround every remote step.
Current exact profile/consent/block/audience authority is checked before template
reads and dispatch. Before and after preview publication, every retained global
winner and runner-up is checked again. If either changed, the attempt fails
closed; the discarded third score is not guessed into a replacement decision.
New candidates become proposals only. Contributor approval, recipient acceptance,
exact subset checks and media grants are unchanged.

## Privacy and rollout

Schema15 adds the two backend-only tables with forced RLS and the capture UPDATE
trigger. Deleting an owner attempt cascades through both tables. Subject erasure
must cancel affected live attempts, remove their progress, and delete that
subject's captured rows. A missing row or broken seal cannot publish a partial
result. Completed `matches_json` provenance continues to use the existing array
form; the manifest contains only opaque hashes/counts, not a cleartext subject
roster. The shared privacy writer owns these erasure steps.

Deploy the compatible proxy, private model, API and schema together through the
normal reviewed release process. Changing the model consumer source changes its
processing fingerprint. Select and qualify the resulting exact generation;
never stamp that generation onto old registered templates or in-flight attempts.
Incompatible references retain the existing explicit failure/re-enrollment path.
The patch does not mutate hosted configuration, run migrations, or send any
real user photograph to inference.

The existing15-minute immutable admission expiry, current-session expiry and
per-page lease remain in force. Resumption does not extend consent or authority.
An expired attempt fails explicitly instead of publishing an incomplete match.
Large-population throughput, repeated source decoding cost, remote template-read
latency, concurrent uploads, memory peaks and supported capacity within these
deadlines still require measurement on the selected hosted architecture. Local
synthetic counts are correctness evidence, not a production performance promise.
