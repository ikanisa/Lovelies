# Push delivery and independent local Supabase custody

Updated 1 November 2026. The active topology uses locally hosted Supabase PostgreSQL for both application data and a separately operated custody database. The custody database belongs to a different Compose project and uses external persistent volumes, separate roles, secrets and backup lifecycle. Application rollback never restores custody alongside it. The older Cloudflare Worker/SQLite adapter remains a compatibility test fixture; it is not the selected deployment.

## Services and private boundary

The application Edge API owns account/device/consent authority and notification jobs. `services/push-provider/src/server.mjs` performs actual APNs HTTP/2 and FCM HTTP v1 calls. `src/ledger-server.mjs` runs the immutable plan/receipt/roster protocol over private TLS, using the transactional PostgreSQL adapter shared with the restore journal. Each service has its own minimal role and schema. No custody database or service port is publicly published.

`deploy/local-supabase/compose.custody.yml` and `compose.production.yml` are the active deployment definitions. `scripts/local-supabase-configure.mjs` generates protected environment files and independent credentials; values and provider files remain outside Git. Both provider configurations, exact identities and explicit send enablement are necessary for delivery readiness. A send-disabled or recovery-only service reports unready for delivery rather than a false success.

The existing Android package and Apple bundle identity are `com.lovelies.memories`. Real APNs environment/topic/team/key and Firebase project/service-account/package bindings must come from their existing accounts. No new store identity or provider credential is fabricated by this implementation.

## Complete immutable plans

The API and gateway use the version-two complete-plan and roster contract. Before any send, the ledger atomically records the entire notification attempt set, including the subject digest, immutable provider generation and exact request/token digests for all intended original devices. A restored application snapshot can recover this complete set even if its local delivery or device rows disappeared.

The gateway sends only against a matching sealed plan. Provider configuration changes are fenced by a digest derived from actual protected provider configuration and public key material. New devices or rotated tokens cannot be substituted into an existing plan. Exact lost acknowledgements are reconciled under the original key; there is no automatic second dispatch after an ambiguous effect.

| Durable disposition | Permitted interpretation |
| --- | --- |
| Unstarted | No independent dispatch intent exists; current authority and exact binding must still be checked before preflight. |
| Preparing | A bounded preflight claim exists; only an expired claim can be reclaimed under the same immutable plan. |
| Dispatching or ambiguous | The effect may have occurred. Preserve the hold and reconcile; do not resend or replace the key. |
| Accepted | Provider acceptance is durably recorded. This does not prove device delivery, display or viewing. |
| Rejected | A definitive sanitized rejection is recorded. Retry diagnostics do not authorize replay of the effect. |
| Cancelled | Independent retirement fenced an entry before any dispatch intent. |

The PostgreSQL transaction, immutable evidence tables, namespace lock and integrity checks retain the Complete protocol's atomicity. Partial receipt/index loss fails closed. A coherent rollback or loss of the entire custody database cannot be detected from that database's own hashes alone; stop admission and reconcile against independently retained custody/deployment/provider evidence before resuming.

## Recovery, opt-out and erasure

Recovery-only mode reads historical plans and receipts and can permanently retire a subject or plan. It reads no provider key, rejects admission and sends, and reports delivery unready. A generation cannot be reactivated or replaced to bypass unresolved started intents.

The API checks the complete roster before acting and performs a final reconciliation to retain late provider acceptance after logout, opt-out or device removal. One expected uncertain device need not starve another independently bound entry; database, restore or unexpected failures still stop the batch. A job settles only after its plan is retired and every entry has a terminal disposition.

Account erasure first obtains an independent permanent subject-retirement proof while the approved deletion execution lease remains current. The proof covers every independent plan, including attempts absent from a restored application snapshot. Application cleanup cannot discard unresolved evidence or infer an empty provider history from empty local SQL. This is dispatch quiescence, not an APNs/FCM erasure receipt.

No raw device token, notification title, private key, session credential or photograph is stored in the independent ledger. Immutable operation identifiers, digests and sanitized outcomes remain while restoration or replay can refer to them. Retention changes require a reviewed custody/recovery design; do not clear the database or create a new namespace to remove a hold.

## Configuration and operation

| Configuration | Purpose |
| --- | --- |
| `PUSH_SERVICE_URL`, `PUSH_SERVICE_SECRET` | Private API-to-gateway binding. |
| `PUSH_LEDGER_URL`, `PUSH_LEDGER_TOKEN` | Independently authenticated gateway-to-custody binding. |
| `PUSH_LEDGER_ID`, `PUSH_LEDGER_BOOTSTRAP_ID` | Immutable initialized custody identities, matched by API and gateway. |
| `PUSH_PROVIDER_GENERATION` | Digest of the actual provider configuration; activation requires a fenced and reconciled prior generation. |
| `PUSH_PROVIDER_SEND_ENABLED` | Explicit enabling of configured providers. False never satisfies delivery readiness. |
| `PUSH_RECOVERY_ONLY` | Credential-free lookup/retirement service; sends remain disabled. |
| `APNS_*`, `FCM_*`, `ANDROID_PACKAGE_NAME` | Protected provider files and verified existing app bindings. |
| Observer credential and private TLS files | Authenticated health/metrics and verified internal service transport. |

Generate the provider fingerprint with `node services/push-provider/src/provider-generation.mjs` against the actual protected files. The command sends no provider request. Bootstrap uses a distinct temporary operator credential that the gateway never receives; remove it after exact binding readback. Unknown or nonempty legacy history is held for explicit reconciliation, not assigned invented generation evidence.

Run `pnpm push:check`, `pnpm push:test` and the custody tests from the frozen lockfile. PGlite tests exercise PostgreSQL SQL semantics; legacy Worker tests exercise compatibility and fault behavior. They do not establish native PostgreSQL transport, restart durability, provider acceptance, phone delivery or host placement.

The authoritative wire details are in [ROSTER_CONTRACT.md](../services/push-provider/ROSTER_CONTRACT.md); [RECEIPT_CONTRACT.md](../services/push-provider/RECEIPT_CONTRACT.md) records the prior contract. The host qualifier and coordinated backup/restore tools are under `scripts/local-supabase-*`. Release requires actual host evidence plus signed-device APNs/FCM rotation, opt-out, logout, tap routing, outage and ambiguous-effect acceptance on the exact submitted builds.
