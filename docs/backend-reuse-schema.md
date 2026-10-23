# Reused backend schema and Edge source

The donor is `/Volumes/T7/Recovered-G-PRO/MEMORIES`, a recovered dirty checkout
at `e373d06ce13c1e2b957622f0076a70f097ed2280`. The import preserves the actual
current source bytes. It does not copy accounts, photos, provider credentials,
project links, generated state, or deployment configuration.

`verification/backend-reuse/donor-schema-import.json` records the original and
target paths, byte lengths and SHA-256 hashes for 270 copied files: 168 SQL
migrations, 17 shared Edge modules, 62 function/WhatsApp source and lock/test
files, and 23 SQL/Edge test scripts and supporting library/policy files. All
copied bytes were compared with their donor files. The 40 affected source
bindings in the existing final sharing/privacy seal still match the live donor.
That seal covers its stated feature boundary, rather than the complete backend.

## Dependency boundary

```text
Native client / browser client
  -> Worker API OR Supabase Edge route adapters
     -> root shared/*.ts authority and immutable-operation contracts
     -> supabase/functions/_shared/*.ts service and privacy contracts
     -> Supabase PostgREST RPC + current application schema
     -> protected media storage, processing queues and ML runtime
```

The Worker entrypoint imports shared contracts and several Edge helper modules.
The Edge dispatcher imports `services/api-worker/src/gallery_metadata.ts` as
well as the root shared contracts. Copying only `services/api-worker`, only
`supabase/functions`, or only the new sharing migrations is insufficient.
Those cross-directory relative paths are retained in this workspace.

| Reusable capability | Principal source/schema prerequisites |
|---|---|
| Account/session authority, roles and revocation | `shared/access-session-revocation.ts`, `shared/session-authority-policy.ts`, Edge signed-credential/Supabase REST helpers; `users`, `user_roles`, OTP/session/refresh/revocation tables and their current RPCs |
| Consented identity and private matching | `shared/face-consent-policy.ts`, photo-matching/result contracts and current processing adapters; biometric consent, identity profiles, embeddings, detected faces and immutable processing-attempt/origin tables |
| Uploads and protected gallery/search | Upload-attempt cleanup, gallery metadata and private-media helpers; `media_assets`, `media_renditions`, owned batches, access grants and current gallery gates; actual storage and processing bindings |
| Personal/professional reviewed sharing | Community contract plus the six `20261014…` migrations, on the earlier contribution/media/identity/session schema; snapshot/preview approval and recipient acceptance remain distinct |
| Privacy export and erasure | Shared privacy-review/execution contracts and Edge export/erasure inventories; approved requests, retention/legal-hold authorizer, execution leases, cleanup acknowledgements and reviewed-sharing redaction |
| Existing subscriptions/operator capabilities | Their existing entitlement, billing, provider, fraud/audit and operator-policy schema; external providers must be configured independently for the target |

The database requires the Supabase platform's `auth` and `storage` schema,
`anon`/`authenticated`/`service_role` roles and correct default/function ACLs,
`auth.uid()`, the expected Realtime publication, and `pgcrypto`/`vector` in
`extensions`. Application `users` and role/profile tables are separate from
provider Auth objects. A minimal test role/table fixture is not their production
replacement. Original object keys, checksums, rendition purpose and protected
access checks must remain bound to the actual configured storage.

## Historical schema import prerequisites

All 168 migration files are retained unchanged. The folder has two distinct
files using version **20261001013000**:

- `20261001013000_community_payout_beneficiary_guard.sql`
- `20261001013000_unconfigured_print_client_access.sql`

No file was deleted, renamed or reordered to hide this collision. A full replay
must reconcile the intended migration-ledger identity against the authoritative
history. Historical migrations also evolve or retire earlier tables/functions;
choosing files by feature name alone does not establish a valid schema closure.

The donor's archived provider DDL remains absent at
`outputs/fullstack-qa-20260914/tools/application-provider-schema-complete.sql`.
The historical full-schema/atomic PostgREST runners depend on that artifact and
their documented provider prerequisites. The six additive sharing/privacy
migrations cannot be applied to an empty database by themselves.

For an existing compatible schema, apply all six together in their original
order only after checking their enum, column, function, ACL and history
prerequisites:

1. `20261014010000_reviewed_sharing_v1.sql`
2. `20261014020000_reviewed_sharing_gallery_gate_v1.sql`
3. `20261014030000_reviewed_sharing_legacy_origin_v1.sql`
4. `20261014040000_reviewed_sharing_inference_origin_v1.sql`
5. `20261014050000_reviewed_sharing_professional_owner_v1.sql`
6. `20261014060000_reviewed_sharing_privacy_v1.sql`

For a fresh target, obtain or reconstruct and verify the compatible complete
provider/application schema in an isolated database, then prove full replay
and actual route/ACL/storage behavior. Selective reuse is practical for source
and explicit contracts; selective schema import needs an independently verified
dependency closure or a validated consolidated baseline. The copied historical
folder is source material, not an automatically applied installation.

## Portable local checks

The unchanged `scripts/test-reviewed-sharing-database.mjs` reads the actual
current SQL migrations and selected existing function fragments. Its source
reader prerequisites are listed in the import manifest. It also requires the
Worker owner's copied `services/api-worker/test/fixtures/community-database.sql`.
The fixture supplies deliberately minimal local prerequisite tables, roles and
synthetic data. It exercises the real reviewed-sharing, origin, gallery and
privacy SQL; it does **not** replay the complete provider/history schema.

After the root owner supplies the pinned dependencies, root can run:

```sh
node scripts/test-reviewed-sharing-database.mjs --professional
node scripts/test-reviewed-sharing-database.mjs --postgres --professional
```

The caller-facing source/prerequisite inventory command uses only files in this
workspace; it does not need the donor mount or provider credentials:

```sh
node scripts/check-backend-schema.mjs --json
node scripts/check-backend-schema.mjs --require-ready
```

The ordinary command exits zero only when the recorded source and SQL-reader
prerequisites are present and match. It still reports `provider_ready=false`.
The strict command exits two because full provider/history readiness is
unverified. Missing or changed source also exits two with an inventory failure. The root
owner supplies the `backend:schema:check` package-script mapping.

The first command uses pinned PostgreSQL-WASM dependencies. The optional second
uses an already cached Supabase PostgreSQL image with network disabled and
removes only its owned disposable container. Copied Edge/shared tests use
synthetic SQL/storage/ML ports and preserve their original labels and assertions.
The `scripts/fixtures` and Worker/shared dependencies are assembled by their
separate owner. The root owner serializes all execution and records fresh target
results; this copy owner ran no tests, builds, Docker or provider operations.

Current status is **source copied and hash-verified; provider_ready=false**.
Target provider configuration, complete schema replay, real cross-account
authorization/storage/queue checks, model/provider acceptance and deployment
remain separate gates. No imported source or local fixture establishes them.
