# Operator security review — 23 October 2026

**Re-review update:** the three original reproductions are closed against the corrected snapshot below. The separate lost-refresh-response extension is now reproduced and remains an open recovery gate. Original findings and hashes are retained as historical evidence.

The reviewed browser implementation needs two fixes before operator release: sign-out can be skipped during busy work, and a lost enrollment-renewal reply can leave the saved setup unable to capture. A third, medium-priority navigation race can reopen a stale account dialog. This review made no application or backend source changes. Root owns remediation and acceptance.

The source was assessed before reading its author's tests. Scope: `admin/operator-session.mjs`, `admin/live-app.mjs`, `admin/index.html`, `admin/sw.js`, their entry/configuration and shared face contracts, checked against the active Supabase authentication, enrollment, operator, privacy and session-management routes. Findings refer to this source snapshot:

| File | SHA-256 |
| --- | --- |
| `admin/operator-session.mjs` | `7553679232fbc865f1a2b15d579a34f24900c60f66f028892f875098dd26e4b3` |
| `admin/live-app.mjs` | `96eb2639a4c6fccc5ce6f16072e869657a44919a358d11ddd490ebbda9528012` |
| `admin/index.html` | `a2cde06a091c212c3afab31e1264bfc23c30ef93e957a1a6a57b8d78361ca965` |
| `admin/sw.js` | `29955d66480464638fa8ab231d6422cd0d04967e43fcd617d86919ae87be7148` |

## 1. P1 — Sign-out is skipped while another task is busy

**Location:** `admin/live-app.mjs:216`, with the busy gate at lines 111–115, private cleanup at line 65 and the sign-out button at line 76.

The button remains enabled whenever credentials exist, including during a pending list request or action. Its handler calls `clearPrivate()` and then schedules `session.logout()` through `task()`. When `busy` is true, `task()` returns without invoking its callback. `clearPrivate()` cancels captures and clears the data variable, but retains `session.credentials` and `session.operator`; it also does not immediately replace the main DOM. The actual session class would clear credentials and invalidate its epoch synchronously at `operator-session.mjs:225–227`, but this path never calls it. The server logout endpoint is never reached.

An independent minimal DOM/event harness loaded `startWorkspace()`, held `refresh()` pending, verified that sign-out remained enabled, and dispatched the actual click handler. Its assertions and output were:

```json
{"check":"busy_workspace_logout","logout_button_enabled":true,"logout_calls":0,"credentials_retained":true,"operator_retained":true}
```

This also applies to a pending detail/action task. Cancelling the old request epoch is useful, but does not terminate the operator session. The operator can remain authorized after a sign-out click, and stale task completion can render the protected workspace again.

**Smallest fix:** make sign-out a dedicated, unconditional cancellation path that invokes `session.logout()` immediately, independently of the ordinary busy gate. Clear the visible protected DOM and invalidate the outstanding task generation synchronously, then handle server logout and vault restore without letting an older task restore UI or busy state. Preserve any uncertain action journal for explicit reconciliation. Merely disabling the button while busy would leave the operator unable to terminate a stuck operation.

**Required regression:** click sign-out during a held list request and during a held action/signing operation; assert synchronous removal of local credentials/operator and private DOM, one server logout attempt, preservation of an uncertain journal, and no restoration after the old promise settles.

## 2. P1 — Enrollment-renewal replay revokes its own successor challenge

**Location:** `admin/operator-session.mjs:160–173`, especially the unconditional refresh at lines 166–167 before replaying `j.resume` at line 171.

The original resume key/generation/challenge are durably saved. After a successful server renewal whose reply is lost, the anonymous credentials used for that renewal are also already saved. Retrying `restartEnrollment()` nevertheless rotates those credentials again. Active backend refresh is single-use and revokes the previous session (`services/supabase-api/src/auth.ts:266–289`). The resume endpoint correctly replays the exact committed successor for the original resume key (`face-auth.ts:547–549`); that successor was created with the preceding session ID (`face-auth.ts:558–564`). Its session is now revoked. Capture admission checks that session and refuses the first photo.

An independent executable reproduction used the actual `OperatorSession`, actual encrypted `OperatorVault` with non-extractable WebCrypto keys and `fake-indexeddb`, plus the active Supabase handler and PostgreSQL engine through the existing isolated PGlite harness. It used fixture media and no provider/network dispatch:

1. Start a signed registration, then expire only that fixture challenge.
2. Run renewal; allow the refresh and resume transactions to commit, but deliberately discard the successful resume response.
3. Retry `restartEnrollment()` with its saved original resume key.
4. Confirm the returned challenge is the same generation-2 successor, inspect its bound session as revoked, then attempt a signed fixture capture.

```json
{"check":"lost_enrollment_resume_reply","replayed_generation":2,"successor_session_revoked":true,"capture":{"code":"session_invalid","status":401}}
```

This is a client/backend lifecycle incompatibility; no concurrency or distributed-lock claim is needed for the reproduction. Repeated renewal cannot repair that saved generation because every replay returns the same successor while rotating its authority again.

**Smallest fix:** reconcile a saved resume operation before rotating authority. Reuse the persisted anonymous session that created a committed successor while it remains eligible, or recover the authoritative current generation and then renew that generation only when genuinely necessary. Journal the refresh/resume phase so an uncertain resume response does not trigger another refresh automatically. Keep single-use refresh, signed metadata and exact-generation guards. Do not create another anonymous account or weaken challenge-session checks to escape the failure.

**Required regression:** discard the first committed resume response, reload the vault, recover/retry and successfully send a capture for the authoritative successor under its current session. Separately exercise a lost committed refresh response: the existing one-use refresh token cannot simply be retried, so the product must provide an explicit recoverable outcome for the original setup rather than implying retry will repair it.

## 3. P2 — An account detail response can reopen after route navigation

**Location:** `admin/live-app.mjs:162–181`, with route invalidation at line 225. `load()` already uses a generation/account fence at lines 118–124; `showDetail()` does not.

Open an account detail from Users, hold `/admin/users/:id`, then navigate to Overview. The hash-change handler closes the dialog and starts the new view, but the old response subsequently writes detail HTML and calls `showModal()`. An independent minimal DOM/event harness reproduced:

```json
{"check":"detail_after_route_change","route":"#overview","prior_route_detail_reopened":true}
```

This displays a prior route's account and its session-revocation controls over the new route. It did not demonstrate unauthorized data access: `OperatorSession.request()` fences session-epoch changes and backend action endpoints still authorize the exact account/session. It is an actionable record-context race.

**Smallest fix:** capture generation, operator account and route before the detail request, and recheck them plus foreground visibility before assigning dialog HTML or opening it. Test navigation, close/cancel, backgrounding and logout while the detail response is held.

## Controls observed in the reviewed source

- API requests are restricted to HTTPS or explicit HTTP loopback and the configured API prefix. Requests omit cookies, refuse redirects, use no-store and a 30-second cancellation deadline, and bound JSON to 2 MiB. Access credentials remain in memory. A 401 clears current operator authority.
- Enrollment uses a non-extractable signing key, signed challenge/capture/completion envelopes, an original-account journal saved before dispatch, exact capture digests and counts, bound profile/device/policy checks, and signed status recovery. Three registration captures do not grant an admin role. A completed face response is followed by `/me`; current backend routes independently enforce registered-face authority and the current admin role.
- The vault encrypts journal/anonymous/pending-action state with AES-GCM and API-base additional authenticated data. An IndexedDB read-write transaction compares the stored revision before committing. A stale tab cannot silently overwrite a newer journal or replace an existing device through `create()`. This is browser key storage, not hardware attestation; origin scripts able to run in this application can use its same-origin keys.
- Review intents name exact resource IDs, original operation keys and expected integer/UUID revisions appropriate to each backend route. Session revocation names both account and session. Privacy processing uses the backend's accepted empty body. Unknown outcomes retain the original pending action; conflicting operations and a different operator account fail the saved-operation comparison. Restore does not automatically replay a mutation. Backend authorization and resource eligibility remain authoritative at dispatch/replay.
- Server text is escaped before HTML insertion; the static index contains no private account/session content. The service worker's exact same-origin static allowlist excludes authorization-bearing, queried, API and media requests. It performs no runtime cache writes and requires an explicit message for a waiting update. No broad navigation fallback was found.

## Verification and acceptance boundary

The three reproductions above were independent probes run after reading the implementation and before using the author's tests to assess coverage. The existing suite command was then run:

```sh
node --experimental-transform-types --test --test-concurrency=1 \
  admin/live-app.test.mjs admin/operator-session.test.mjs \
  admin/operator-vault.test.mjs admin/sw.test.mjs
```

Result: **24 passed, 0 failed, 0 skipped**, exit 0, about 3.6 seconds. Those existing tests did not cover the three reproduced interleavings; a passing result therefore does not close these findings. The browser-key test uses `fake-indexeddb`; the enrollment probe uses PGlite and the active handler. These establish local implementation behavior, not deployed origin, physical camera or store acceptance. Root has accepted the findings for source remediation; any later correction is outside the snapshot above and requires its own affected regression evidence.

After fixes, qualify actual Chrome and Safari persistent key reloads and simultaneous tabs; permission-denied/cancel/background camera behavior; sign-out and held-response races; and service-worker install/update/offline behavior at the deployed origin. Verify that the deployed allowlisted shell remains public static content, API/private responses remain no-store and uncached, production CSP/connect/camera policies and CORS match the actual operator origin, and runtime configuration matches the hosted face policy/API. Hosted Supabase migration, operator provisioning, private inference and provider/device/store acceptance remain outside this browser source review. No hosted deployment or release approval is established by this report.

## Independent closure re-review — corrected snapshot

Root corrected the application sources; this reviewer changed only this report. The independent probes were rerun against the following source hashes, preserving the original findings above:

| File | Corrected SHA-256 |
| --- | --- |
| `admin/operator-session.mjs` | `57f5fda6410e61d66b6890b133afae0d1d405ed0343beff92333926bdeeb8cdf` |
| `admin/live-app.mjs` | `9b8ca33edd3d80858df06cec96247129319d3041dab49ad71eb29b712745f9a3` |
| `admin/index.html` | `a2cde06a091c212c3afab31e1264bfc23c30ef93e957a1a6a57b8d78361ca965` |
| `admin/sw.js` | `b96d74cc15ca32c141cd15e9f25d1fda2704cdbf82ce6b32e8c9eb6edf23c17f` |

**Finding 1 closed for the reported interleaving.** Sign-out now bypasses the busy gate (`live-app.mjs:218–223`), invokes the session's synchronous authority clearing immediately, renders the signed-out shell, and invalidates the ordinary task generation. Holding the original list request, clicking the actual sign-out handler and then releasing the response produced:

```json
{"check":"busy_workspace_logout","logout_calls":1,"authority_cleared_synchronously":true,"late_list_did_not_restore":true}
```

**Finding 2 closed for a lost committed resume reply.** The refreshed anonymous credentials and `resume.session_prepared` are persisted together before dispatch. A replay retains that prepared session. Only the three protocol resume fields enter the signed wire body (`operator-session.mjs:163–177`). The independent actual-handler/PGlite probe now additionally reconstructed `OperatorSession` and `OperatorVault` after the lost reply, then replayed and sent a signed capture:

```json
{"check":"lost_resume_reply_after_reload","generation":2,"refresh_calls":1,"resume_posts":2,"bound_session_revoked":false,"accepted_captures":1}
```

**Finding 3 closed for route navigation.** Detail rendering now checks captured generation, account, route and foreground visibility before writing/opening the dialog (`live-app.mjs:163,181`). Releasing a held account response after navigating to Overview produced:

```json
{"check":"detail_after_route_change","route":"#overview","prior_route_detail_reopened":false}
```

The same four-file test command above now passes **27/27**, zero failures/skips, exit 0, about 4.1 seconds. It includes the author's three new regressions, in addition to the separate independent probes. The root-reported broader 101-case combined result was not rerun by this reviewer and is not substituted for the direct evidence here.

### R1 — Remaining lost-refresh-response recovery gate

This is the separate extension explicitly requested under finding 2, rather than a failure of the corrected resume replay. `operator-session.mjs:169–171` receives the rotated credentials before persisting `session_prepared`. If the backend commits the refresh but its response is lost, the browser retains the consumed original refresh token. Reloading and retrying renewal cannot obtain the new credentials.

An independent actual-handler/PGlite + encrypted-vault probe expired its fixture registration challenge, deliberately discarded the first successful `/auth/session/refresh` response after the transaction committed, reloaded the vault, and retried:

```json
{"check":"lost_refresh_reply_after_reload","retry":{"code":"refresh_invalid","status":401},"session_prepared":false,"original_account_retained":true}
```

The original account/key/journal survive, but normal renewal is stranded. A refresh retry consumes no second token because the server correctly enforces single use. Signed status recovery alone does not issue anonymous credentials. Repeated ordinary retry or the prepared-session flag does not resolve this path.

**Existing protocol boundary:** there is no safe client-only recovery for a committed refresh whose credentials were not received. The refresh route accepts only `refresh_token` and rejects it after consumption (`auth.ts:266–289`); session storage retains the successor token's hash, not its recoverable value. Signed enrollment status supplies metadata only, resume requires a current anonymous bearer, and an incomplete enrollment has no registered reference for face login. The face-device key must not independently grant authentication. The backend does accept a still-current original anonymous bearer directly for resume (`face-auth.ts:536–564`), so avoiding an unnecessary pre-resume refresh reduces exposure. It does not solve a lost committed refresh or an expired retained bearer.

**Smallest safe protocol change proposed, not implemented:** add credential-delivery reconciliation to a versioned refresh exchange. Before its first request, the client durably stores a rotation operation key and independent, cryptographically random delivery secret. In one database transaction the server consumes the original refresh exactly once, inserts exactly one successor and saves an encrypted exact-result receipt bound to the original session/account, operation key and delivery-secret hash. A matching delivery retry returns that same credential result rather than generating another session. Check the original rotation link and current successor/account authority on every retrieval; deny a different key/secret, account disablement or epoch change, successor revocation/rotation, and any changed registered profile/device/consent authority. Bound receipt retention to the authorized refresh lifetime and encrypt/redact credentials and delivery secrets. The client's successful credential write must precede clearing its original delivery journal.

This requires a versioned request contract, durable private receipt storage, browser/Android/iOS journal adaptation, and regressions for pre-commit/committed reply loss, reload, concurrent exact delivery, conflicting operations, revocation, rotation and expiry. It preserves one-use refresh: a consumed token never authorizes a second rotation. Delivery recovery is authorized by the original refresh exchange and its precommitted delivery secret, never by a face-device key alone. Do not silently create a replacement anonymous account. Until such a supported outcome is implemented and verified, R1 remains open. No backend change was made during this review.

### Native consumer comparison — read only

No equivalent unconditional refresh-before-every-resume replay was found in the current native enrollment paths:

- Android `CloudflareRepository.kt:709–724` performs signed reconciliation before deciding to renew. `originalAnonymous()` at lines 534–557 refreshes only when the retained credentials approach expiry, and `resumeEnrollment()` at lines 586–595 uses those credentials. `EnrollmentJournal.kt:103–142` accepts only the saved same-device next generation and clears the predecessor resume when that successor is reconciled. A lost committed resume response therefore does not itself force a second refresh.
- iOS `BackendRepository.swift:567–585` likewise reconciles before resuming and reconciles again if readiness rotated the session. `readyScope()` at lines 115–125 refreshes only expired credentials. Signed status at lines 467–525 adopts the saved successor generation and clears its old resume, and lines 533–541 retain the original resume intent for an unresolved dispatch.

This is source evidence, not a native execution or physical-device result. Both native credential-rotation paths still depend on receiving the single-use refresh response before persisting its successor; R1 merits corresponding native transport-loss qualification. No new native source defect equivalent to finding 2's unconditional replay rotation was established.

Native snapshot hashes:

| File | SHA-256 |
| --- | --- |
| `android/app/src/main/java/com/lovelies/frontend/preview/CloudflareRepository.kt` | `d20679700bb1c0885075aa1c6a1c93f94ed25991bfea241501a83a1a1b1a6c8f` |
| `android/app/src/main/java/com/lovelies/frontend/preview/EnrollmentJournal.kt` | `5e4754849d2fa24c201533492b0713648ad37143234fb3841e374a20643d75cc` |
| `ios/Lovelies/Native/BackendRepository.swift` | `870fa9f33975e9edcdc14048230eeb9def800d4c0aa074af7ae09362cce7a841` |

The original three local interleavings are closed. R1 and the browser/device/hosting acceptance limits above remain explicit; this closure does not establish deployment or release readiness.

### R1 implementation review — durable credential delivery and cancellation

The preceding R1 proposal and native comparison describe their historical snapshots. The backend subsequently implemented `lovelies-refresh-delivery-v1` with an additive version-8 receipt migration, and the operator client adopted an encrypted durable delivery journal. This review did not change application or backend source. Backend source, strict-role PostgreSQL and Deno results are separately bound in `verification/supabase-release-20261023/backend-refresh-delivery/result.json`; those results do not establish hosted or browser acceptance.

Independent probes use the actual `OperatorSession`, `OperatorVault`, non-extractable WebCrypto keys, `fake-indexeddb`, current request handlers and a disposable PGlite database. The reviewer deliberately holds actual AES encryption or transport replies; these are not assertions against mocked session methods. Fixture captures and credentials remain local. The source snapshot was read before running the probes.

The first v2 operator snapshot (`operator-session.mjs` SHA-256 `d14d8d4a85b79ccad06ad7654f80595493d4a46cc8f71b0cea15cb736492fb52`) recovered the original lost-refresh reply, but the following independent interleavings exposed additional defects. Root owns and supplied the source corrections:

- **Successor publication before its encrypted write completed.** Holding the candidate AES write allowed logout to see no pending delivery. No cancellation was sent, and the late write retained a valid anonymous successor without a retired marker. The pre-fix probe observed `pending_seen_at_logout:false`, `cancel_posts:0`, `durable_retired_marker:false`, `reloaded_anonymous_authority_valid:true`. Root now saves a staged candidate and checks the session epoch before publishing it; the original intent remains visible to logout throughout the write.
- **Same-vault overlapping saves captured the revision too late.** Holding the older encryption let a newer retirement commit, then the older save used the advanced instance revision and overwrote it. The pre-fix result was `newer_retirement_overwritten:true`, `stored_retired:false`. Root now captures the keys, revision and existing-record state before encryption and uses those captured values for the transaction.
- **Same-vault simultaneous first creation mixed identity keys.** Holding the first public-key export let two creations finish with a stored public/private key mismatch. The pre-fix result was `fulfilled:2`, `stored_public_key_matches_private_key:false`. Root now serializes first creation and commits locally held key material with explicit insert-only semantics.

At corrected snapshot `dfc294017706893018e58d06c09dbfc79d0ec5450089f82f252a1461b990a4f4`, those three independent cases passed. A further cross-tab probe found that stale logout A accepted its old settled successor metadata even when the latest record contained a different pending rotation B, overwriting B's delivery secret while B's server successor remained active. Its pre-fix result was:

```json
{"check":"stale_logout_vs_newer_tab_rotation","newer_delivery_intent_overwritten":true,"stored_attempt_is_older":true,"current_successor_sessions":1}
```

Root corrected retirement reconciliation to load and validate the current durable record before every retirement/acknowledgement save. Matching an original attempt requires the exact protocol, account, operation key, delivery secret and original token; matching its settled successor also requires no newer pending journal.

At snapshot `634d8b185f9e1b4f37239983bb7ae7f98c2d12441b8153231c2aa2fe3e3a76ce`, independently rerun probes produced:

```json
{"check":"original_lost_refresh_after_reload","refresh_posts":2,"sessions":2,"accepted_captures":1,"journal_cleared":true,"absolute_expiry_used":false}
{"check":"expired_recovered_access","refresh_posts":3,"sessions":3,"accepted_captures":1,"journal_cleared":true,"absolute_expiry_used":true}
{"check":"cancel_before_delayed_first_refresh","retired":true,"cancelled":true,"sessions":1}
{"check":"stale_logout_vs_newer_tab_rotation","newer_delivery_intent_preserved":true,"newer_successor_recovered":true,"old_tab_adopted":false}
{"check":"logout_during_successor_write","first_commit":"retirement","active_sessions":0,"retired_and_cancelled":true,"cancel_posts":1,"late_adoption":false}
{"check":"logout_during_successor_write","first_commit":"candidate","active_sessions":0,"retired_and_cancelled":true,"cancel_posts":1,"late_adoption":false}
{"check":"overlapping_saves_same_vault","stale_rejected":true,"retirement_retained":true}
{"check":"same_vault_concurrent_create","identities_committed":1,"stored_key_binding_valid":true}
```

The expired-access case discards a committed reply, advances the fixture clock 16 minutes, reloads the encrypted journal and recovers the exact first successor. Its absolute access expiry triggers a new operation using that successor refresh token before signed enrollment resumes; it does not extend the access lifetime from `expires_in`. The delayed-first-dispatch cancellation consumes/retires the original exchange before the held first refresh reaches the server. Releasing it cannot create a successor. The cross-tab case also replays B's retained journal successfully after A's rejected stale logout.

**R1 follow-on finding: stale state after failed retirement reconciliation — open at the 634d snapshot.** At `operator-session.mjs:266–270`, `vault.load()` advances that vault instance's revision and key metadata before rejecting a different durable scope. The session still holds its old state. A later ordinary save can therefore write that old state with the newer revision. This is reachable through the existing signed enrollment status action (`recoverEnrollment`, lines 147–165).

Reproduction: hold A's successor candidate encryption; B reloads and replays A's delivery, then renews/resumes the enrollment to generation 2 with its newer session. A's logout correctly returns `private_state_changed`, and its server cancellation targets only A's original capability. Release A's candidate, then invoke A's `recoverEnrollment()`. Signed status returns the valid generation-2 challenge, but A saves its old anonymous credentials and retired A journal over B's current durable credentials. The actual result is:

```json
{"check":"stale_logout_then_signed_status","status_error":null,"newer_credentials_preserved":false,"newer_generation":2,"stored_generation":2,"retired":true}
```

The smallest correction must prevent any later write from stale session state after a failed reconciliation read advances the vault revision: invalidate/fence that session until a full matching restore, or adopt validated durable state and revision together. Preserve B's record and delivery capability; cancellation remains bound only to A. This defect was sent to the source owner immediately. No closure is claimed for this follow-on path at this snapshot.

For this review slice, the other current source hashes are unchanged: `live-app.mjs` `9b8ca33edd3d80858df06cec96247129319d3041dab49ad71eb29b712745f9a3`, `index.html` `a2cde06a091c212c3afab31e1264bfc23c30ef93e957a1a6a57b8d78361ca965`, and `sw.js` `948480571a37f7bdb6309de93fa5cbae0bde3679f1d31679b35e330c262664c5`. Native refresh-delivery changes have separate owners; this append does not qualify their latest implementation. Real-browser IndexedDB/key persistence and cross-tab behavior, hosting/CSP/service-worker acceptance, physical-device recovery and release acceptance remain separate checks.

### R1 final local closure — corrected state/revision pairing

Root corrected the follow-on defect. The final independently reviewed `admin/operator-session.mjs` SHA-256 is **`b683c0675194bfea1f913feda2609a53fa4fbd4c25ba94531be777803566c429`**. The other three source hashes remain as recorded immediately above. This reviewer appended only this report.

Retirement reconciliation now adopts the complete freshly decrypted durable state immediately after its checked load and before any scope test can fail. This keeps the session state paired with the vault's advanced revision even when a different tab owns the current attempt. The closed-over original capability remains the sole target of remote cancellation. Separately, vault load parses decrypted JSON before publishing keys or revision, so malformed plaintext cannot advance only the storage metadata.

The final independent inline fixture command (`node --experimental-transform-types --input-type=module`, actual WebCrypto/IndexedDB factory/PGlite handlers as described above) exited **0**. All eight earlier outcomes were rerun against this final hash with their recorded results unchanged. The formerly failing follow-on case and the affected malformed-state path now produce:

```json
{"check":"stale_logout_then_signed_status","status_error":null,"newer_credentials_preserved":true,"newer_generation":2,"stored_generation":2,"retired":false}
{"check":"malformed_decrypted_state","rejected":true,"revision_and_keys_unchanged":true}
```

The ten independently checked outcomes are: lost committed refresh after encrypted-vault reload; recovery after the successor access token's absolute expiry; cancellation before a delayed first dispatch; preserving and replaying another tab's newer pending journal; preserving another tab's settled credentials through a later signed status save; retirement-first and candidate-first encryption races; same-instance overlapping saves; simultaneous first device creation; and malformed decrypted-state rejection. Every reported race in this R1 operator slice is locally closed at the final hash. The original lost reply obtains the same single successor, resumes the same account and accepts a signed capture; no replacement anonymous identity is created.

This closes **R1 for the reviewed operator-client implementation and these local interleavings**. The historical open findings and pre-fix outcomes above remain preserved. Root owns the broader integrated suite and latest native changes; its reported aggregate results are not represented here as independent reruns. This local closure does not establish real-browser persistence/tab behavior, hosted Supabase or service-worker/CSP acceptance, physical-device behavior, provider delivery, store submission or deployment readiness.
