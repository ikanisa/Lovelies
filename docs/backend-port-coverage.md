# Cloudflare native backend port coverage

The active native app backend is `services/cloudflare-api/src/index.ts`, with one authoritative Cloudflare SQLite Durable Object, private R2 buckets, a durable Queue and explicitly configured private service bindings. It does not execute the historical Supabase router or impersonate PostgreSQL RPCs. The retired donor source and SQL migrations are preserved in a recovery archive; earlier seals remain historical provenance. See [frontend alignment](frontend-alignment.md).

The owner requires anonymous bootstrap and camera-derived registration/login against the registered Lovelies reference. No OTP, PAD/liveness, blink/head-turn verification or camera-injection qualification is active. Ordinary enrollment pose guidance, signed single-use capture challenges, private bytes, distinct purpose consent and current-account/session/device checks remain. Public social feeds, comments, events, group membership and unrelated payment products are excluded.

## This remaining-capability slice

`entitlements.ts` implements actual SQLite subscription/transaction/event records, qualified Apple and Google verification, provider-event replay, production-only current download entitlement and source-bound original download tickets. `operators.ts` implements owned support requests, independent current admin review, bilateral block removal/listing, exact Not-Me reports and revision-bound moderation/holds. `notifications.ts` implements preference-preserving settings, a private inbox, current-device push registration, durable Queue outbox and provider-operation reconciliation. `retention.ts` implements bounded metadata-driven expiry, same-DB access retirement, purpose-aware template cleanup and exact R2 DELETE plus absent HEAD verification. These are concrete handlers, not successful empty placeholders.

All mutation intents use the canonical account/source/payload-hash operation engine. An identical durable key replays its saved result; another payload cannot reuse the key. Current actor/role authority is rechecked in the same transaction. Grant changes use only actual source-bound candidate/approval/request tuples. A block, Not-Me decision or moderation release never creates/restores a grant; unaffected approvals in an immutable multi-photo request remain attached to their original manifest.

## Store/provider boundaries

Apple requires explicit `APPLE_BUNDLE_ID`, positive `APPLE_APP_ID` and `APPLE_SUBSCRIPTION_PRODUCT_ID`; Google requires explicit `GOOGLE_PLAY_PACKAGE_NAME` and `GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID`, plus either a qualified `STORE_VERIFIER` binding or actual service-account verification configuration. No donor app identity is a silent active default. SQLite binds Apple subscriptions to configured bundle plus app-ID and Google subscriptions to package, as well as product, original transaction/purchase lineage, owner and billing environment. Missing configuration returns 503; sandbox receipts are financially ineligible and cannot authorize protected originals.

The Apple adapter lazily instantiates the pinned official `@apple/app-store-server-library` 3.1.0 verifier with exact donor-published Apple root bytes and configured identities. It verifies signed transaction/notification/renewal payloads. Google borrows the existing RS256 service-account assertion and OIDC/JWKS/account protocols, with a local HTTPS-origin, manual-redirect, 15s/128KiB HTTP adapter. Provider helpers and their required types are self-contained in the active Cloudflare service; no global fetch monkey patch is used. Provider notification flags alone do not grant access: Google RTDN triggers a current Publisher lookup, and signed Apple facts remain bound to account, app, product, period and original ownership. Apple publishes the [server-notification workflow](https://developer.apple.com/documentation/appstoreservernotifications/receiving-app-store-server-notifications); Google documents [SubscriptionPurchaseV2 states and account identifiers](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2) and the [RTDN event protocol](https://developer.android.com/google/play/billing/rtdn-reference).

The optional private verifier uses `{protocol:'lovelies-store-verifier-v1',input_hash,input}` and must return the same protocol/hash with `verified:true` and qualified `payload`. Its service binding is trusted configuration, never a client-selected URL. Service and direct HTTP responses reject redirects and non-OK/unbound receipts. Configuration, real App Store/Play products, provider credentials, notifications, live receipts and hosted acceptance still need owner-controlled provider setup. Local fixture proofs do not establish those results.

Protected originals use POST `/downloads/sign` then GET `/downloads/{ticket}`. Both native consumers use this canonical flow; the old community-original alias is unnecessary. The ticket captures the current session, asset source/checksum and subscription version, expires within two minutes/session/store period, and exposes no storage key. Actual source bytes live in QUARANTINE. Access, original metadata, SHA256 and current R2 object identity are checked before/after awaits; refunds, revoked credentials, changed sources, expired grants/consent or moderation holds deny release. High-resolution access is not inferred from a face match or client Pro flag. Private replies remain `no-store, private`.

## Notification and retention boundaries

Push sends only a generic private notification reference; photo bytes, counterpart names, credentials and private media URLs are not notification content. Provider status `accepted` records its exact operation receipt and does not mean delivered. An ambiguous send first reconciles that saved key; an unknown outcome is never resent under a new key. No active device is a real `inbox_only` terminal state, not a fake delivery. Account epoch, opt-in and authenticated device/token status are checked again after provider awaits. Physical APNs/FCM acceptance remains unverified unless a qualified configured `PUSH_SERVICE` supplies real receipts.

Default raw/preview expiry is 60 days, with inherited policy values 14 days for face crops, 2 days for free caches and at least 2555 days for audit retention. This native core does not persist face-crop or free-device-cache tables, so it does not invent deletion evidence for them. Financial/minimal-audit records remain retained; this slice does not purge them or allocate/create unqualified payments. Global day defaults apply when an asset-specific deadline is first captured; explicit asset deadlines/holds are separately versioned. Cleanup has a bounded pass size, exact persisted keys, source/purpose/hold guards, a lease and unresolved-writer guard. Profile templates are removed only when neither separate authentication nor matching purpose remains current; valid independent-purpose templates remain.

Expiry retires candidates/grants/previews before external deletion. DELETE requires an absent HEAD under the same current authority before a job is verified. Storage uncertainty remains durable failed work. Source drift becomes blocked work requiring review rather than deleting changed bytes. Current cleanup leases prevent administrative hold/deadline changes while a physical deletion is in progress; a later policy hold cannot undo an already authorized deletion. Asset tombstones preserve original immutable sharing/financial references. Root schedules maintenance using the persisted next deadline; no cron execution is claimed merely from this function existing.

## Privacy/schema integration contract

Each new module exports its `...SchemaStatements` array and `init...Schema(db)`. Root integrates these into the non-destructive versioned SQLite schema and rejects incompatible older definitions. An IF NOT EXISTS statement is not evidence that an existing store has been upgraded.

Export hooks `entitlementPrivacyRows`, `operatorPrivacyRows`, `notificationPrivacyRows`, `retentionPrivacyRows` project only owned necessary metadata. They exclude raw purchase/push tokens, signed proofs, session/device secrets, private media keys, foreign profile tuples and foreign graph names. The canonical export aggregates the total scope; oversized rows fail closed rather than silently exporting a truncated history.

Erasure captures `retentionPrivateKeys` into independently request-authorized cleanup before deleting job metadata. `eraseNotificationSubject` runs before session/auth-device deletion; `eraseOperatorSubject` clears candidate/asset report FKs and specific-asset holds before candidate/asset removal; `eraseEntitlementSubject` clears tickets/asset-linked download references and disables subscriptions; `eraseRetentionSubject` removes its job/rule references before asset/profile deletion. Provider transaction IDs/periods are retained as minimal verified financial facts, with no raw provider credentials. Existing unaffected per-recipient approvals remain unchanged. Root's privacy module performs the actual atomic disable/revoke/redaction plus writer-aware R2 cleanup.

## Route-family map

This table describes the historical donor catalogue, now archived with retired source. It is not a feature requirement list. The catalogue has 79 families, not a blanket statement that every legacy route remains active. “Root” refers to the current Cloudflare handlers, not the historical router. Changed protocols and unmapped administrative/album aliases are explicit consumer/integration boundaries; excluded owner scope is not marked as ported.

| Donor methods/path | Active boundary | Concrete behavior / remaining difference |
| --- | --- | --- |
| GET `/health` | Root core | SQLite schema/binding readiness; no hosted acceptance claim. |
| GET `/ready` | Root core | SQLite schema/binding readiness; no hosted acceptance claim. |
| POST `/admin/readiness/deep` | Not routed | Historical operator infrastructure endpoints; trusted alarm/queue recovery replaces public replay. No provider smoke action inferred. |
| POST `/admin/storage-smoke-test` | Not routed | Historical operator infrastructure endpoints; trusted alarm/queue recovery replaces public replay. No provider smoke action inferred. |
| GET `/admin/metrics` | operators.ts | Actual bounded SQL operational metadata; current admin guard, no fabricated analytics. |
| GET `/admin/privacy-requests` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/admin/queues/replay` | Not routed | Historical operator infrastructure endpoints; trusted alarm/queue recovery replaces public replay. No provider smoke action inferred. |
| POST `/auth/otp/start` | Retired by owner | No active OTP; use /auth/anonymous then verified /auth/face registration/login. |
| POST `/auth/otp/verify` | Retired by owner | No active OTP; use /auth/anonymous then verified /auth/face registration/login. |
| POST `/auth/session/refresh` | Root/auth owner | Current session refresh and logout; current registered reference/device/consent fencing. |
| POST `/auth/logout` | Root/auth owner | Current session refresh and logout; current registered reference/device/consent fencing. |
| GET,PATCH `/me` | Root/auth + profile | GET /me; editable name at GET/PATCH /me/profile. Identity, roles, entitlement cannot be client-edited. |
| GET,POST `/me/photographer-request` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/me/photographer-access/activate` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| GET,PATCH `/me/notification-settings` | notifications.ts | Private partial preference updates retain existing mutes; inbox/device routes added separately. |
| GET,POST `/me/albums` | Not routed | Private album persistence is outside this selected core slice; no blanket empty response. |
| POST `/support/requests` | operators.ts | Owner-only reads/create; current admin review with exact expected revision and stored outcome. |
| GET `/support/requests/{requestId}` | operators.ts | Owner-only reads/create; current admin review with exact expected revision and stored outcome. |
| POST,DELETE `/face/consent` | Changed protocol | Photo purposes: /me/photo-preferences. Auth purpose: signed /auth/face registration/login. No raw client vector/profile-authority backfill. |
| GET,PATCH,DELETE `/me/face-profile` | Changed protocol | Photo purposes: /me/photo-preferences. Auth purpose: signed /auth/face registration/login. No raw client vector/profile-authority backfill. |
| GET `/me/face-profile/auto-policy` | Retired protocol | Legacy on-device automatic-identity/scan routes are not used by the server-authoritative registered-reference flow. |
| POST `/me/face-profile/auto-sync` | Retired protocol | Legacy on-device automatic-identity/scan routes are not used by the server-authoritative registered-reference flow. |
| POST `/me/face-profile/scan-event` | Retired protocol | Legacy on-device automatic-identity/scan routes are not used by the server-authoritative registered-reference flow. |
| POST `/face/enrollment-sessions` | Retired by owner | Legacy enrollment/PAD routes remain absent; no liveness, blink/head-turn verification or injection qualification. |
| POST `/face/liveness-session` | Retired by owner | Legacy enrollment/PAD routes remain absent; no liveness, blink/head-turn verification or injection qualification. |
| POST `/face/liveness-result` | Retired by owner | Legacy enrollment/PAD routes remain absent; no liveness, blink/head-turn verification or injection qualification. |
| POST `/face/enroll` | Retired by owner | Legacy enrollment/PAD routes remain absent; no liveness, blink/head-turn verification or injection qualification. |
| GET `/me/gallery` | Root gallery | Current-grant private gallery; filtering via the canonical photos action/metadata. Historical search alias must be consumer-mapped. |
| POST `/me/gallery/search` | Root gallery | Current-grant private gallery; filtering via the canonical photos action/metadata. Historical search alias must be consumer-mapped. |
| GET `/public/photos` | Excluded by owner | No public social feed/publication/comments added to the native private app. |
| POST,DELETE `/photos/{assetId}/share-public` | Excluded by owner | No public social feed/publication/comments added to the native private app. |
| POST `/public/photos/{publicationId}/report` | Excluded by owner | No public social feed/publication/comments added to the native private app. |
| POST `/photos/{assetId}/proofing-comments` | Excluded by owner | No public social feed/publication/comments added to the native private app. |
| POST `/matches/{matchId}/not-me` | operators.ts | Not-Me/revision-bound moderation; only complete verified origin chains may be approved. No reassignment to an invented person/template. |
| POST `/matches/{matchId}/review` | operators.ts | Not-Me/revision-bound moderation; only complete verified origin chains may be approved. No reassignment to an invented person/template. |
| POST `/downloads/sign` | entitlements.ts | Canonical sign/retrieve flow; current production entitlement + exact owner/accepted-grant access + source/session/digest checks. |
| GET `/downloads/{token}` | entitlements.ts | Canonical sign/retrieve flow; current production entitlement + exact owner/accepted-grant access + source/session/digest checks. |
| POST `/previews/sign` | Root gallery | Current source/rendition/session/consent/approval-gated private preview; moderation holds apply. |
| GET `/previews/{token}` | Root gallery | Current source/rendition/session/consent/approval-gated private preview; moderation holds apply. |
| GET `/photographer/dashboard` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| GET,POST `/photographer/upload-batches` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/photographer/upload-batches/{batch_id}/close` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/photographer/upload-sessions` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| GET `/photographer/uploads` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| PUT `/uploads/{token}` | Root/processing owner | Canonical source-aware /uploads/session -> PUT /uploads/{id} -> complete/status, plus shared reviewed protocol. Historical dashboard/batch aliases are not all retained. |
| POST `/uploads/{assetId}/complete` | Root/processing owner | Canonical source-aware /uploads/session -> PUT /uploads/{id} -> complete/status, plus shared reviewed protocol. Historical dashboard/batch aliases are not all retained. |
| GET `/admin/uploads` | operators.ts | Actual bounded SQL operational metadata; current admin guard, no fabricated analytics. |
| GET `/admin/support-requests` | operators.ts | Owner-only reads/create; current admin review with exact expected revision and stored outcome. |
| POST `/admin/support-requests/{requestId}/{action}` | operators.ts | Owner-only reads/create; current admin review with exact expected revision and stored outcome. |
| GET `/admin/photographer-requests` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/admin/photographer-requests/{requestId}/{action}` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| GET `/admin/momo-providers` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST,PATCH `/admin/momo-providers/{provider}` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| GET `/admin/matches/review` | operators.ts | Not-Me/revision-bound moderation; only complete verified origin chains may be approved. No reassignment to an invented person/template. |
| GET `/admin/matches/{matchId}` | operators.ts | Not-Me/revision-bound moderation; only complete verified origin chains may be approved. No reassignment to an invented person/template. |
| POST `/admin/matches/{matchId}/resolve` | operators.ts | Not-Me/revision-bound moderation; only complete verified origin chains may be approved. No reassignment to an invented person/template. |
| POST `/subscriptions/momo-ussd-requests` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| GET `/subscriptions/momo-ussd-requests/{requestId}` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/admin/subscriptions/momo-ussd-requests/{requestId}/{decision}` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/subscriptions/apple/transactions` | entitlements.ts | Signed Apple / authenticated Publisher-backed Google verification; explicit deployed app/product/provider configuration required. |
| POST `/subscriptions/apple/notifications` | entitlements.ts | Signed Apple / authenticated Publisher-backed Google verification; explicit deployed app/product/provider configuration required. |
| POST `/subscriptions/google/transactions` | entitlements.ts | Signed Apple / authenticated Publisher-backed Google verification; explicit deployed app/product/provider configuration required. |
| POST `/subscriptions/google/notifications` | entitlements.ts | Signed Apple / authenticated Publisher-backed Google verification; explicit deployed app/product/provider configuration required. |
| POST `/creator-revenue/subscription-periods/{periodId}/allocate` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/creator-revenue/payout-batches` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| POST `/creator-revenue/payout-batches/{batchId}/approve` | Removed / not routed | Outside the current Lovelies frontend; no corresponding product capability. |
| GET `/privacy/center` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/privacy/export` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/gdpr/export` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/privacy/account-deletion` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/gdpr/delete` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/privacy-exports/{requestId}/grant` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| GET `/privacy-exports/retrieve` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/privacy-requests/{requestId}/{decision}` | Root privacy | Independent request review, private export/one-time grant, same-DB disable/revoke/metadata erasure + verified durable cleanup; new-table hooks integrated. |
| POST `/community/action` | Root/sharing owner | Actual candidate edges, immutable snapshot/preview, exact recipient subsets, acceptance before grants and durable replay. |
| GET `/community/media/{asset_id}/{access}` | Root gallery / canonical downloads | Preview retained. Original consumer uses /downloads/sign and /downloads/{ticket}; old original alias is deliberately not needed. |
| POST `/community/upload-session` | Root/processing owner | Upload-session alias/canonical complete/status; batch-close client mapping must use current documented protocol. |
| POST `/community/upload-close` | Root/processing owner | Upload-session alias/canonical complete/status; batch-close client mapping must use current documented protocol. |
| POST `/admin/community/actions` | Not routed | Historical contributor-programme ledger/admin surface is not invented by this native core port. |

Added canonical native routes include `/auth/anonymous`, `/auth/face/registration/challenge`, signed capture-proof and completion endpoints, `/auth/face/challenge`, `/auth/face/complete`, `/me/profile`, `/me/sessions`, `/me/devices`, `/auth/session/revoke`, `/auth/device/revoke`, `/me/photo-preferences`, `/uploads/session`, `/uploads/{id}/status`, `/me/entitlements`, `/me/blocks`, `/me/blocks/{id}`, `/safety/reports`, `/admin/safety/reports/{id}/resolve`, `/me/notifications`, `/me/notifications/{id}/read`, `/me/push-devices`, `/me/push-devices/{id}`, `/admin/retention`, `/admin/retention/run` and `/admin/assets/{id}/retention`. Root owns any additional gallery/person/batch consumer mappings and infrastructure probes.

## Verification status

The integration owner is the sole runner. `test/remaining-backend.test.ts` contains 34 meaningful actual Node SQLite authority tests. `test/remaining-runtime.test.mjs` contains 9 actual workerd SQLite/R2/Queue/public-flow tests with test-only qualified private bindings. They cover replay/refunds/ownership, sandbox/configuration, session changes during provider/R2 awaits, exact original release, independent approval, blocks/no restoration, support revisions, current private push receipts, retention/legal holds/absent HEAD and new-table erasure foreign keys.

The first remaining-unit attempt is preserved at `verification/cloudflare-native-port/logs/core-unit-second.log`: 54 of 56 total tests passed; the new device-erasure fixture violated the strong registered-session CHECK, and profile retirement used an unsupported status. The owned fixture now deletes the dependent session first, and purpose retirement uses canonical revoked status. These corrections retain the schema constraints.

Root's completed current logs `verification/cloudflare-native-port/logs/core-unit-third.log` and `verification/cloudflare-native-port/logs/core-runtime-second.log` record **56/56 unit PASS** and **46/46 actual workerd runtime PASS**, respectively. All 34 new unit and all 9 new remaining runtime cases are included in those actual runs; counts are not added across overlapping suites. Root binds the final submitted source/transitive inputs and remaining type/build/provider evidence in its integrated manifest. Earlier 22 unit/38 runtime passes apply only to the preceding core slice. No deployment, real store receipt, physical camera/model qualification, production schema migration, paid push or store-release acceptance is claimed here.
