# Database schema request gate

The API now rejects ordinary requests and authorized maintenance with HTTP503
`database_schema_not_ready` unless the database reports the exact supported schema
version11. It checks each request, so an already running isolate also stops after
recorded version drift. This checks migration history, not the complete database
catalog; catalog, RLS and deployment qualification remain separate. Health and
readiness remain available with503 diagnostics; readiness
does not call inference against an incompatible schema. Unauthorized internal
routes remain404, CORS preflight remains available, and normal response/body
cleanup still applies.

An owned PostgreSQL-engine fixture reproduced the previous behavior for schema8,
schema12 and an empty migration history: `/health` returned503 while anonymous
registration returned201 and created an account. The correction prevents that
write and also gates existing-session reads, refresh, logout, deletion requests
and maintenance. The regression compares every row in all68 private tables before
and after rejected requests, then restores the fixture's exact history and checks
the same handler resumes ordinary session behavior.

The controlled regression passes for all three states. TypeScript and the actual
cached Deno entrypoint check pass. The complete actual PostgreSQL17/Deno API suite
passes296 tests:295 pass, zero fail, one optional actual-model skip, with all87
inputs unchanged. The Deno test also changes schema history while its HTTP listener is
running and checks that anonymous registration stops without creating an account.
Raw counterexamples, the initial fixture-setup error and all test outputs remain
in `/Volumes/PRO-G40/Projects/Lovelies/verification/api-schema-request-gate-20261025/`.

Affected-client source review confirms this503/code does not enter the native
credential-clearing branches. Android preserves ambiguous mutation keys; Swift
and the shared JavaScript client retain their current credentials. This is static
consumer review. Six further [Swift HTTP cases](ios-connected-audience-20261025.md)
now exercise the actual API/PostgreSQL, including503 credential/journal retention
and original-key retry. A plain availability message has been added to Android
in English/Kinyarwanda; full non-incremental compilation,197 JVM tests and fresh
Debug packaging checks pass with257 unchanged inputs. The
same iOS change is now applied after the prior reference runtime became terminal.
All1,020 original host assertions passed against its staged CoreWire bytes, then
the exact16-input map was adopted after canonical equality. The current actual
Swift HTTP6/26/49-input run passed again after application. The round6 Simulator
and unsigned Release compile/package both translations; independent runtime is
pending. The new Android APK is99edd663…e6e49; its eight JNI
payloads match the previous6603 APK and fresh16KB ZIP alignment/signature checks
pass. No new Android runtime acceptance is attributed to that package; prior
grid/connected receipts retain their6603 binary scope.

This is a compatibility gate, not restore clearance. A schema11 database restored
with old sessions, consents or grants still reports11. An independently current
deletion/withdrawal ledger, authority retirement, absent-object verification and
a separate restore quarantine/release process remain required. No migration,
hosted request, provider call, serving deployment or store action is performed by
this change. The approved hosted baseline remains schema8; it cannot serve this
API until the staged additive migrations and remaining deployment prerequisites
are completed.
