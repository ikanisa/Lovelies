# Deletion receipt contract correction — 25 October 2026

An overdue pending deletion could become untrackable immediately after successful
completion: its original status deadline was already past, and finalization did
not establish the final-outcome window until later maintenance. A preserved local
counterexample completes a forty-day-old request and receives a status404.

The iOS consumer also retained the older seven-day request limit and required
different request/receipt deadlines, rejecting the current API's equal thirty-day
creation deadlines. Both mobile parsers treated the receipt deadline as permanently
immutable, rejecting the legitimate final-outcome update. Actual API-produced
synthetic replies reproduce both consumer failures.

## Resulting behavior

- Delete rejection/completion atomically records the final status and its
  thirty-day read-only receipt window. A failed receipt write rolls back that
  finalization; the request remains trackable and can retry. Fallible dispatch or
  maintenance is not required to preserve the window. Revoked receipts stay revoked.
- Mobile parsers accept the current creation deadlines and an overdue nonterminal
  receipt. They allow the first final outcome to establish the bounded window,
  while rejecting later renewal, changed request/account/operation scope and
  completion regression. Earlier seven-day test-state shapes remain supported.
- iOS retains an overdue pending journal for a server status check. It does not
  create a replacement account, extend original-request replay or infer cleanup.

No authentication, capture, consent, schema, photo access or subscription contract
changes. Hosted schema8 remains unchanged; v9–v11 are still staged separately.

## Qualified evidence

| Scope | Actual result |
|---|---|
| API candidate | 293 tests: 292 pass, zero fail, one optional actual-model skip. Actual PostgreSQL, cached Deno entrypoint/check and TypeScript pass. All 86 inputs remain unchanged; canonical adoption matches those exact bytes. |
| Canonical API | TypeScript and the cached Deno graph pass after adoption, with the same 86 inputs unchanged. |
| Android | Old parser fails the actual-producer final-window case. Corrected non-incremental main/test compilation and all 194 JVM tests pass with unchanged inputs. |
| Swift guest deletion | Old parser rejects the actual-producer creation reply. Corrected production repository/parser passes 101 controlled checks, including retained overdue status and no automatic anonymous bootstrap. |
| Original Swift hosts | All 1,020 original controlled checks pass again against the adopted CoreWire/Repository. |
| Private media hosts | All 35 controlled checks pass again against the adopted graph. |
| Current native packages | Android Debug app/test APKs and the combined iOS Simulator app/runner plus unsigned Release compile. The current Android APK passes LOAD/congruence and stored-ZIP alignment; all eight native-library payloads match the earlier artifact. |

The shared producer JSON has SHA-256
`4b4e831057cee2ec419dabb9d6c78f90bdaeb914e0c910eb954ae807bbc50fc1`.
It contains synthetic public reply fields, no status secrets or credentials.
Android's generated maps are bound to the identical resource bytes; Swift reads
the JSON directly. Its producer is the actual local API handler with synthetic
verification and in-memory PostgreSQL, not a production or physical-camera test.

External receipts are under
`/Volumes/PRO-G40/Projects/Lovelies/verification/deletion-receipt-terminal-fix-20261025/`
(`full-api-attempt1/result.json`, `canonical-adoption.json`,
`canonical-checks/result.json`) and
`deletion-receipt-native-contract-20261025/`
(`android-baseline-attempt1`, `android-corrected-full-attempt1`,
`ios-baseline-attempt1`, `ios-candidate-guest-attempt2`,
`ios-original-hosts-current-attempt1`, `ios-private-media-current-attempt1`,
`android-current-package-attempt1`). The combined iOS build receipt is
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-grouped-ui-round3-20261025-attempt2/build-result.json`.
The first invalid-token counterexample, missing-fixture working-directory attempt
and tool-path preflight failures are preserved without product-failure credit.

The earlier five Android/four Swift HTTP journeys and physical iPhone test retain
their exact pre-correction API85/native artifact scope. These new local results do
not silently requalify hosted operation, the final signed app, store-installed
updates, optical capture, operated deletion/backup or store review.

The current fdb Debug APK separately passes12 anonymous-deletion checks over HTTP
against the production Supabase handler and isolated embedded PostgreSQL. Both
before-dispatch and after-commit reply loss preserve the original intent; actual
Android Keystore/vault rehydration, pending status and protected-access fences are
exercised. This is repository rehydration within one instrumentation process,
not a killed-process or final operator-completion test. The two actual pending
requests are preserved in a private database archive and independently read back.

The wrapper's original failure remains: its full-byte preservation assertion saw
WorkManager SHM/WAL changes. Separate readback confirms unchanged main database
and lock bytes, no added/removed files, equal empty logical SQLite tables and
integrity checks. Original and later app-data copies are preserved; overall byte
equality is false. The qualified bounded receipt is
`/Volumes/PRO-G40/Projects/Lovelies/verification/android-deletion-connected-20261025-attempt3/reconciliation.json`,
SHA-256 `9932c3a46db684cf959dfb6d964127fb91b7da51148f8f9e0c19909219eb7b13`.
Earlier setup/shell-quoting and post-copy guard failures are retained. The raw
preexisting test text says Cloudflare/workerd; the pinned bridge and recovered
schema11 database independently establish Supabase-handler/PostgreSQL authority.
