# Connected Android audience checks — 25 October 2026

Five connected teen-gating checks pass on the current6603 Debug app with the
production UI, repository and Android Keystore. The test uses the real Supabase
application handler over loopback HTTP and an isolated embedded PostgreSQL
schema11. It exercises no model, media or provider success; the fixture's unused
Storage adapters do not establish Supabase Storage operation.

The actual UI selects13–17, preserves the same anonymous account, creates a
pending guardian request, confirms its withdrawal and opens guest privacy/deletion
controls without face setup. The server audience projection retains zero allowed
purposes. The production repository's gallery fence denies access before a gallery
request is dispatched. No deletion request is submitted by this journey.

The separately selected test APK is
`4534c5854b6b1a18a29f023cb13289e4b77686c88eba05555ed23f4b1ef55d1f`.
The app remains byte-identical to
`6603feadedb9307d7cde916d9af0bc3869332eb5207ee02dd171524bf88397a5`;
no product source changed. All343 recorded API/Android inputs remain unchanged
through the qualifying runtime. The JVM197 and source-grid18-case results keep
their separate scopes; these counts are not summed.

The owned API36 ARM64 emulator has an actual16KB kernel with compatibility mode
disabled. Existing data was copied before and after, with no reset/uninstall.
No existing file was removed or added during the qualifying second run. Only the
exact previously owned empty encrypted fixture journal and WorkManager's SHM
bytes changed; all other original files match. Read-only copies confirm identical
logical SQLite contents and integrity. Full file-byte equality is false. The
fixture session was logged out; the emulator and HTTP server were stopped and
preserved. No other device was changed.

A separate PostgreSQL instance reconstructed from the private fixture archive
confirms one guardian-pending teen, one withdrawn request at revision2, and zero
purpose approvals, consents, media grants, face profiles or active sessions.
All six original PNGs were inspected. The pending request and withdrawn revision
are visible. The confirmation capture shows the dialog during its fade; it is
not settled raster-contrast or animation proof. The native visible-body,
confirmation action and HTTP withdrawal outcome are verified separately.

Receipts are under
`/Volumes/PRO-G40/Projects/Lovelies/verification/android-connected-audience-20261025/`:
`build-attempt4/result.json`, `runtime-attempt2/{result,native-report,fixture-readback,reconciliation}.json`.
The reconciliation SHA256 is
`3b73b373f11a51498173ba8e41c7e41c0bc68d717c40aa2ebc8de3fb9e3f6e49`.

The first test compilation's missing constant, first runtime's changed README
freeze/intermediate captures and later pre-Gradle stale README check remain
preserved failures. Stronger pending-detail/dialog visibility assertions and an
explicit exact-hash/decrypted-empty guard qualify reuse of only the prior owned
fixture journal. Unknown endpoint vaults remain protected.

Under13/adult native UI cases, a registered guardian, independent human review
and approval, camera/media/model behavior, physical devices, spoken TalkBack,
hosted operation and store-installed updates remain unqualified by this test.
The existing [replacement gates](audience-readiness-20261024.md) remain open.
