# Lovelies replacement integration — 25 October 2026

The replacement is **not ready for runtime deployment or store submission**.
The owner has authorized completing that work. The remaining gates below are
technical and operating requirements, not a renewed request for authorization.

Supabase project `ltqfplqevxztlswlzexn` remains the backend target. Preserve the
existing `com.lovelies.memories` store identities and signing lineage. No real
Memories customers, photos or subscriptions require an import; preserve unknown
or test records and source history. The audience is 13+, with independently
reviewed guardian authorization for ages 13–17. There is no OTP or liveness/PAD.

## Implemented and checked within bounded snapshots

| Surface | Actual evidence | Scope and current limitation |
|---|---|---|
| Audience and guardian API | Age declaration, separate purpose approvals, independent fresh operator review, reviewed adulthood, current challenge authority, withdrawal and private cleanup implemented. Three independently found lineage/replay/cleanup P1s were fixed; 11 focused runtime tests passed and a second source review closed those fixes. | Additive v9/v10/v11 are local only: audience tables, immutable engine bindings and a private scan cursor, 68 total application tables. Fresh hosted catalog readback remains schema8/63 with forced RLS and zero client/public table ACLs. No hosted forward migration, adult backfill or import occurred. |
| Whole API regression run | `backend-aggregate-attempt6`: **285 tests, 284 passed, zero failed, one skipped**, with 84 unchanged inputs. The actual Deno Edge entrypoint, real PostgreSQL concurrency and non-superuser migration cases ran. Current TypeScript and Deno type checks pass. | The one skip is actual OpenFace HTTP, awaiting the accepted runtime. Earlier failed runs remain preserved. The last failure was a hardcoded local inspector login; the corrected test proves exact original role restoration and retains restricted-role/advisory-lock/rollback assertions. |
| Android | Full non-incremental JVM suite: **178 passed, zero failures/errors/skips**; main/test compilation passed with 83 unchanged inputs. Independent review closed strong collection authorization and exact camera/picker callback ownership. | Current strong own-profile checks precede collection and staging while weak privacy remains usable. The earlier four stale incremental-bytecode failures are retained; full recompilation passed on unchanged source. No new APK installation or device acceptance is claimed. |
| iOS | Ten controlled host suites: **1,020 checks passed** (874 recovery/wire, 64 audience, 82 upload). Corrected strong collection/camera ownership passed peer review. Fresh unsigned device Release and Simulator Debug builds passed with 202 frozen inputs and actual compiler-file-list checks, including two reference accessibility text-size fixes. | Latest built Release executable `96279137…b2b2`; Simulator dylib `e32f1f31…dd45` is held before installation while further demonstrated sharing-caption consumers are reviewed together. Installed `595aa0f4…9cfa` has bounded reference smoke/keyboard proof; connected age/guardian UI remains untested because the actual backend is not deployed. No full matrix, physical-device, signing/archive/store acceptance. Failed runs remain retained. |
| Operator workspace | Strict audience/challenge and minimized guardian/adulthood review controls implemented. **All 94 controlled operator tests passed**, including service worker and backend integration. Three reviewed fixes preserve durable uncertain-action replay, clear private state on product denial, and recheck capture authority after awaits. | Saved key/body/account remains exact through reauthentication and withdrawal. Actual browser camera, hosted roles and independently operated guardian review remain unqualified. The earlier55 pure checks remain a separate snapshot. |
| Additive database migration | Real PostgreSQL/PGlite v11 composite cursor checks passed 4/4. The exact staged v9–v11 transaction passed with a seeded unknown/test account and policy/hold preservation. Adult receipt continuation handles more than 20 recent reviews, invalidates backdated generation changes and fails closed on malformed checkpoints. | Five empty private tables, two nullable generation columns; no imports, backfills, deletion or new role membership. Current hosted readback on 25 October is still8/63/forced RLS/zero client-public table ACLs. The exact transaction is staged, pending the browser-policy action-time grant confirmation. |
| Public policy package | Five updated HTML pages and 95 local links checked. The 13-file allow-list was uploaded as an isolated preview. Dashboard inventory and actual browser rendering confirm immutable deployment `62953714-2a67-4c49-80dd-75d12ecf0376`. | [Privacy preview](https://62953714.lovelies-web.pages.dev/privacy/) is a review draft, not an effective policy. The generated branch alias initially returned Deployment Not Found. Terminal readback returned Cloudflare1010/403, so current byte/header qualification remains open. Production and shared admin/photo hosts were preserved. |

The backend/operator source is committed as `b8bb1879596a8ac5bf6d4529f24927bcbb37c810`.
The private [ikanisa/Lovelies repository](https://github.com/ikanisa/Lovelies) and
local origin were created and verified on 25 October; Memories is preserved.
The bounded source commit excludes active ML, native-client and UI work. GitHub
CI/delivery receipts remain separate from local tests and hosted/store acceptance.

The selected numerical periods and guardian controls are in
[retention-and-young-users.md](retention-and-young-users.md); their protocol is
[audience-api-contract.md](audience-api-contract.md). Selection is not proof of
provider retention, backup expiry, monitored cleanup or trained review operation.

## Required before replacing the live app

1. Preserve the passing bounded retention/maintenance implementation and complete
   actual retention operation, including the remaining backup/restore, minimized
   receipt lifecycle, inactive-profile and cache requirements. Qualify the exact
   native inference image, security scan and representative evaluations. The
   controlled whole API and actual PostgreSQL/Deno checks pass.
2. Complete the grouped reference accessibility fixes and qualify their rebuilt
   consumers, then qualify actual connected age/guardian/picker/camera/privacy
   flows. Strong collection implementation, 1,020 host checks and178 JVM tests pass. Reference-screen tests do not cover the new connected audience UI.
3. Reconcile supported Supabase migration history, qualify/apply the reviewed
   additive migration sequence, deploy API/private inference and configure
   server-only workload credentials, schedules, alarms and failure recovery.
4. Demonstrate actual retention, object absence, backup expiry and restore
   suppression. Qualify independent guardian/privacy/support operators and the
   mailbox/ownership/status workflow before making the public promises effective.
5. Publish qualified notices/support/deletion/association routes while preserving
   the existing admin/photo domains. Set the real native policy and link inputs.
   Current iOS artifact preflight still reports exactly six gates: link host,
   four public URLs and a valid distribution signature.
6. Qualify APNs/FCM and store verification/notification callbacks, reviewer
   enrollment/sharing/purchase access, accurate privacy/data-safety/audience/rating
   declarations, genuine assets and remote CI/source sealing. Resolve Apple2.5.13
   account-authentication architecture: current iOS code does not use
   LocalAuthentication; age13+ alone does not resolve that store requirement.
7. Refresh all-track store build maxima; build and inspect signed AAB/archive,
   qualify in-place updates over store installations without reset/uninstall,
   perform testing/review submission and verify both live updates. Retire the
   donor repository only after stable replacement and the observation period.

The Apple v127 agreement, existing-ID capabilities/profile and saved store-copy
drafts retain their own verified records. They do not establish a submitted or
published release. Prior source-bound device/provider/model results remain
historical when their inputs differ; counts above must not be added together.

## Retained execution evidence

All paths below are under
`verification/supabase-release-20261023/audience-implementation/`:

- `p1-remediation/handoff.json`: focused API fixes and hashes.
- `backend-aggregate-attempt2/` and `backend-aggregate-attempt3/`: original and later failed full regressions.
- `final-affected-attempt1/`: typecheck pass and36/39 affected runtime snapshot.
- `operator-p2-pure-attempt1/`:55 pure current operator/session checks.
- `postgres-migration-v11-attempt2/` and `staged-v9-v11-composite/`: current real PostgreSQL/PGlite composite schema and exact transaction preservation proof; prior editions remain preserved.
- `backend-aggregate-attempt4/`: preserved283/285 failure snapshot; `attempt5/` records Docker preflight only, no tests.
- `backend-aggregate-attempt6/`: current284/285 pass, one actual-inference skip,84 unchanged inputs.
- `backend-deno-check-20261025/`: current cached Deno import-graph check.
- `operator-aggregate-20261025/`: complete94-pass controlled operator suite.
- `github-canonical-20261025/`: private repository identity, bounded source seal and delivery/CI readback.
- `hosted-readback-20261025/`: current schema8/63/forcedRLS/no-client-ACL browser readback; prior24 October evidence remains preserved.
- `android-unit-attempt1/` historical171-pass; `android-unit-attempt2/` preserved incremental ABI failure; `android-unit-attempt3/` full178-pass recompilation.
- `ios-collection-host-attempt1/result.json`: ten suites and1,020 current host checks.
- `ios-build-attempt3/`: strong collection/callback fix artifact595.
- `ios-build-attempt4/{result.json,artifacts-readback.json,preflight.log}`:
  two reference text-size fixes, immutable180-file QA artifacte32 and six remaining artifact gates. Prior builds are retained.
- `operator-focused/`, `operator-integration-attempt1/`: bounded workspace proof,
  preserved failed attempt and corrected exact account/key/body regression.

Public preview staging/deployment/rendering and failed readbacks are retained in
`verification/supabase-release-20261023/store-draft-20261024/public-site-preview-v2/`.
