# Complete and revision 3 package reconciliation

This inventory records how the two supplied source packages were integrated into the current Lovelies tree. It does not close a readiness task or qualify a deployment. Exact package provenance, source hashes, current hashes, owner decisions and replacement hashes are in `package-reconciliation.json`.

## Coverage

| Measure | Count |
| --- | ---: |
| Complete manifest paths | 226 |
| Revision 3 manifest paths | 276 |
| Paths supplied by both | 118 |
| Unique paths reviewed | 384 |
| Current files at their original paths | 360 |
| Complete paths absent | 0 |
| Revision 3 paths replaced at other paths | 24 |

The 502 package entries describe 384 unique paths. They are not 502 implemented tasks. Every original package file was checked against its declared SHA-256 and its immutable archive member. The two patch hashes were also checked. Every current/replacement hash and every backend/native owner-declared source hash was independently checked at this snapshot.

## Selected integration

Complete is the baseline. Its manifests-v2, computed recovery-v2 and export-v3 contracts remain selected. Revision 3 contributes audience decision-v2, matching batches, push roster-v2, browser/native recovery and operational improvements. The coherent local Supabase schema is version 19; conflicting alternate version 14–16 migrations are mapped to the selected migration history rather than appended.

The backend inventory supplies 129 per-path decisions and 14 additional current implementation hashes. The native inventory supplies 75 per-path decisions and 90 additional current implementation hashes. All additional hashes are checked and listed separately from the 384-path package union. Those decisions are incorporated without modifying their source inventories. For other paths, byte relationships and integration reasons are recorded separately so a changed file is not presented as a verbatim package adoption.

4 explicitly selected files outside both packages are also hashed in a supplemental section: the current backend-readiness workflow, local Supabase architecture note, production Edge main router and isolated native custody fixture. These references do not expand the package union or constitute a complete repository/build manifest.

The selected journal and push runtime uses separately protected local Supabase PostgreSQL custody. Retained Worker adapters are compatibility sources; their presence does not select Cloudflare as the production backend. The complete local snapshot tooling captures Auth, application metadata, Storage bytes and Vault keys coherently, with independent custody retained separately.

## The 24 replaced paths

The JSON gives the full reason and every concrete replacement hash. The following is a compact index; listed tests are source references, not new test results.

### Android

- `android/RECOVERY_READINESS.md` → `android/NATIVE_RECONCILIATION.md`, `android/host-tests/native-reconciliation.json`; 1 further exact replacement in the JSON.
- `android/app/src/main/java/com/lovelies/frontend/preview/PrivacyExportRecovery.kt` → `android/app/src/main/java/com/lovelies/frontend/preview/PrivacyExportDelivery.kt`, `android/app/src/main/java/com/lovelies/frontend/preview/ChunkedPrivacyExport.kt`; 1 further exact replacement in the JSON.
- `android/host-tests/PrivacyExportRecoveryTests.kt` → `scripts/test_android_privacy_export.py`, `scripts/test-fixtures/android-push-optout/ChunkedExportTests.kt`; 1 further exact replacement in the JSON.

### iOS

- `ios/RECOVERY_READINESS.md` → `ios/README.md`, `.github/workflows/native-readiness.yml`; 2 further exact replacements in the JSON.

### Journal

- `services/restore-journal/src/paged-operations.mjs` → `services/restore-journal/src/operations.mjs`, `services/restore-journal/src/manifests.mjs`; 4 further exact replacements in the JSON.
- `services/restore-journal/test/paged-operations.test.mjs` → `services/restore-journal/test/manifest-recovery.test.mjs`, `services/restore-journal/test/runtime-operations.test.mjs`; 4 further exact replacements in the JSON.

### API

- `services/supabase-api/src/privacy-export-inventory.ts` → `services/supabase-api/src/privacy-export-catalog.ts`, `services/supabase-api/src/privacy-export-schema.ts`; 6 further exact replacements in the JSON.
- `services/supabase-api/src/privacy-export-snapshot.ts` → `services/supabase-api/src/privacy-export-catalog.ts`, `services/supabase-api/src/privacy-export-schema.ts`; 6 further exact replacements in the JSON.
- `services/supabase-api/src/privacy-restriction-replay.ts` → `services/supabase-api/src/restore-replay.ts`, `services/supabase-api/src/restore-recovery.ts`; 4 further exact replacements in the JSON.
- `services/supabase-api/src/restore-restrictions.ts` → `services/supabase-api/src/restore-replay.ts`, `services/supabase-api/src/restore-database.ts`; 11 further exact replacements in the JSON.
- `services/supabase-api/test/admin-pagination-runtime.test.mjs` → `services/supabase-api/test/operator-queue-readiness.test.mjs`, `services/supabase-api/test/admin-child-pagination-runtime.test.mjs`; 2 further exact replacements in the JSON.
- `services/supabase-api/test/audience-v2-migration.test.mjs` → `services/supabase-api/test/reconciled-schema-migration.test.mjs`, `services/supabase-api/test/audience-v2-runtime.test.mjs`; 1 further exact replacement in the JSON.
- `services/supabase-api/test/notification-outbox-migration.test.mjs` → `services/supabase-api/test/reconciled-schema-migration.test.mjs`, `services/supabase-api/test/notification-preservation-fairness.test.mjs`; 1 further exact replacement in the JSON.
- `services/supabase-api/test/privacy-export-delivery-runtime.test.mjs` → `services/supabase-api/test/chunked-privacy-exports.test.mjs`, `services/supabase-api/test/privacy-export-grant-idempotency.test.mjs`; 3 further exact replacements in the JSON.
- `services/supabase-api/test/privacy-restriction-replay.test.mjs` → `services/supabase-api/test/restore-erasure-replay.test.mjs`, `services/supabase-api/test/restore-privacy-terminal-runtime.test.mjs`; 3 further exact replacements in the JSON.
- `services/supabase-api/test/readiness-recovery-migration.test.mjs` → `services/supabase-api/test/reconciled-schema-migration.test.mjs`, `services/supabase-api/test/delivery-migration.test.mjs`; 3 further exact replacements in the JSON.
- `services/supabase-api/test/restore-effects.test.mjs` → `services/supabase-api/test/restore-effect-adapters.test.mjs`, `services/supabase-api/test/restore-invocation-runtime.test.mjs`; 2 further exact replacements in the JSON.
- `services/supabase-api/test/restore-paged-client.test.mjs` → `services/supabase-api/test/restore-journal-client.test.mjs`, `services/supabase-api/test/restore-transaction.test.mjs`; 2 further exact replacements in the JSON.
- `services/supabase-api/test/restore-restrictions-runtime.test.mjs` → `services/supabase-api/test/restore-device-revoke-runtime.test.mjs`, `services/supabase-api/test/restore-own-session-runtime.test.mjs`; 5 further exact replacements in the JSON.
- `services/supabase-api/test/restore-rollback-runtime.test.mjs` → `services/supabase-api/test/restore-database.test.mjs`, `services/supabase-api/test/restore-controller-runtime.test.mjs`; 6 further exact replacements in the JSON.
- `services/supabase-api/test/restore-test-events.mjs` → `services/supabase-api/test/restore-plan-fixture.mjs`, `services/supabase-api/test/restore-database-fixture.mjs`; 2 further exact replacements in the JSON.

### Migrations

- `supabase/migrations/20261029143000_outbox_scan.sql` → `supabase/migrations/20261101012732_audience_and_delivery_reconciliation.sql`, `services/supabase-api/test/reconciled-schema-migration.test.mjs`; 2 further exact replacements in the JSON.
- `supabase/migrations/20261029190000_readiness_recovery.sql` → `supabase/migrations/20261029130000_restore_recovery_protocol.sql`, `supabase/migrations/20261029140000_chunked_privacy_exports.sql`; 3 further exact replacements in the JSON.
- `supabase/migrations/20261029230000_audience_decisions.sql` → `supabase/migrations/20261101012732_audience_and_delivery_reconciliation.sql`, `services/supabase-api/test/reconciled-schema-migration.test.mjs`; 1 further exact replacement in the JSON.

## Snapshot and remaining acceptance

The inventory records working-tree hashes on branch `implementation/local-supabase-20261101` with HEAD `17df5efa0c312f0c7fee979ab3f2d91669243186`, and explicitly records whether the tree is dirty. That HEAD label alone does not qualify the integrated candidate. Regenerate after a source change, then seal the eventual clean release commit and artifacts through the separate release evidence process.

Actual local Supabase startup, selected-image and disk durability, pinned Edge execution, coherent application/Auth/Storage/Vault restore, load and operational ownership, provider/device journeys, signing and store acceptance remain separate gates. Generic disposable PostgreSQL transaction, restart and archive evidence has a narrower scope. Historical package logs and replacement test names do not satisfy operational acceptance.

The scratch helper `../implementation_work/regenerate-package-reconciliation.py` reproduces this documentation from the immutable package archives/extractions and owner inventories. It rejects missing replacements, manifest/archive mismatches, stale owner hashes and concurrent source changes. It does not execute package code or tests.
