# Remaining deployment inputs

Current integration evidence is in [audience-readiness-20261024.md](audience-readiness-20261024.md).
The exact additive v9–v11 transaction is staged and locally tested, including
unknown/test-account and hold preservation; it has not been applied hosted.

Official Supabase CLI2.84.2 now accesses the selected project and is linked
through supported tooling; no Supabase reconnection is required. Local browser
use remains disabled, affecting store consoles and interactive review. The
existing connector still lacks project access, but it is no longer the only
usable configuration path. The owner's authorization remains in effect, and
GitHub billing remains parked.

The last qualified approved Supabase baseline reads back at version8. All63 tables
have forced RLS/backend-only policies; the three private buckets have exact 20 MiB
limits/MIME restrictions and no client Storage policies. The existing RLS event
trigger's client execution grants were restricted, and the post-change Security
Advisor reports zero errors/warnings/suggestions. This is infrastructure proof,
not a deployed application or store release.

## Selected and observed public inputs

| Input | Current value/status |
|---|---|
| Supabase | `ltqfplqevxztlswlzexn`, EU West/Ireland, Free/Nano |
| API base | `https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api` |
| Existing Android/iOS ID | `com.lovelies.memories` |
| Apple app/team | `6786056510` / `63STJ5N27W` |
| Candidate versions | Android 2.0.0/code18; iOS 1.1.0/build18 |
| Inspected uploaded maxima | Play 16 / Apple 14; refresh immediately before upload |
| Play upload key | Existing matching key is held privately in `.release-secrets/android/`; certificate/highest-code build guards exist |
| Subscription product | Both stores verified `com.lovelies.memories.pro.monthly`: Google active auto-renewing monthlypro/175 regions; Apple approved one-month product6799678587/group22297275, available41/175 regions |
| Firebase client | Existing `easymoai`, app`1:423260854848:android:05e378657a0a819135dda5`, sender423260854848; registered/read back, client config prepared locally; private sender auth/device delivery remain |
| Public mailbox | `info@ikanisa.com` observed in current Play listing; actual operation/delivery remains untested |
| Current Apple callbacks | Earlier `https://lovelies.api.ikanisa.com/subscriptions/apple/notifications`; cutover must preserve and qualify callbacks |

## Server configuration

The original post-schema dashboard inventory had no custom secrets or Edge
Functions. The current CLI checkpoint applies exactly three independent initial
application secrets and verifies their server SHA256 digests. No previous secret
was overwritten; no Edge Function is deployed. Keys remain private and excluded
from client bundles and Git. The adapter already supports Supabase's reserved
`SUPABASE_DB_URL`, `SUPABASE_SECRET_KEYS.default` and legacy server-only Storage
fallback. Do not unnecessarily reveal/copy reserved keys or set blank override
secrets. Explicit `LOVELIES_DATABASE_URL`, optional verified CA and
`LOVELIES_STORAGE_SECRET` overrides are for a justified deployment configuration;
remote TLS certificate/hostname validation remains mandatory.

| Boundary | Required input/action |
|---|---|
| API credentials | Three independent256-bit initial appsecrets are applied to the selected Supabase project and all server digests match the prepared values. The ignored `.release-secrets/server/initial-api-secrets.env` remains in an owned0700 directory/0600 one-link file with no ACL. No previous credential was replaced; known UTF8/UTF16 representations are absent from current iOS bundles,370 decompressed Android APK members and tracked diff. Off-site custody/rotation operation remains unqualified. Refresh receipt encryption derives from the auth secret; future rotation needs an operated recovery/retention plan. |
| Policies/model | Final approved `FACE_AUTH_POLICY_VERSION`, `PHOTO_CONSENT_POLICY_VERSION` and accepted `PHOTO_MODEL_VERSION`; publish matching readable policies. |
| Inference | Approved operator/host/location/architecture, qualified immutable runtime/model and purpose-specific evaluation; private HTTPS `ML_INFERENCE_URL` plus independent `ML_INFERENCE_SECRET`. Pin `ML_INFERENCE_ARTIFACT_SHA256` to the actually loaded OpenFace still package and `ML_INFERENCE_PROCESSING_SHA256` to the complete Lovelies consumer fingerprint for that exact runtime. Authenticated readiness and every inference reply must match both values; configuration presence alone is insufficient. The prepared service requires matching service-side configuration. |
| Jobs | Authenticated maintenance scheduler with bounded intervals, observability and retry/dead-letter/retention ownership. A healthy web endpoint does not drain its jobs. |
| Purchases | Verified exact products/offers, Apple/Google validation and notification configuration, account ownership mapping and callback audiences. Store service-account/private keys enter secret stores only. |
| Push | Approved private gateway/ledger host, separate database/service credentials, APNs team/key/topic/environment and FCM project/service account; sends remain disabled until controlled qualification. |
| Web/operator | Approved HTTPS operator origin/CORS, public app/link host, independently provisioned face-authorized operators, support/moderation/privacy ownership, alarms and backups/restore. |

The active app uses **custom anonymous-first application sessions**. Supabase
managed Auth settings were inspected only: managed anonymous sign-in is disabled,
phone/social providers disabled, and default email/managed signup settings remain
unused by Lovelies. No managed Auth provider or user was changed. The app's own
signed face/session authority does not accept managed email/phone credentials or
introduce OTP. The Data API still exposes only public/graphql_public schemas;
`lovelies_private` is not selected, with0/63 application tables and0/11 functions
exposed at inspection. No client schema grants were added.

## Release configuration and acceptance

- Native policy/terms/support/deletion URLs must point to the approved published
  edition. Draft pages and association files are prepared locally. Final inference
  operator/location, retention/backup, audiences/territories and mailbox operation
  affect those notices and both store disclosures.
- Supply verified Android Firebase/product/link properties and the observed upload
  certificate/highest-code inputs. Apple Push Notifications and Associated Domains were saved on the existing
  identifier; matching App Store profile `Lovelies_AppStore_20261024` was generated,
  independently decoded and matched to the existing distribution certificate.
  This does not establish a signed archive, actual APNs delivery or live links.
- The owner completed the Apple Program License review. After explicit review/approval of v127 and owner-completed two-factor verification, the updated Paid Apps Agreement was accepted and read back Active for24 October2026–21 June2027. The retained agreement receipt is in `verification/supabase-release-20261023/store-draft-20261024/`. Territory/trader declarations and actual purchase/provider behavior still require qualification.
- The owner approved `easymoai`; Lovelies is registered and its matching client config is prepared in ignored `.release-secrets/android/firebase-public-client.properties`. Load its four values explicitly as `ORG_GRADLE_PROJECT_<property-name>` environment variables for the reviewed candidate build; do not source an unvalidated shell file or print values. Gradle already consumes those project properties, and the source template records the three public identifiers. The shared key has25 API restrictions/no Generative Language API, with application restrictions None; review that baseline without breaking existing Cool. FCM HTTP v1 is enabled. Private sender authentication, actual device delivery and APNs remain unqualified. No private key, billing/Analytics/IAM/restriction change or notification was created/sent.
- Produce and inspect exact signed candidates, qualify store-installed in-place
  upgrades without uninstall/reset, run two-account hosted journeys and physical
  camera/storage/media/accessibility/performance/provider acceptance, and complete
  Play testing/TestFlight and reviewer access. No actual store upload occurred.
- Earlier authenticated Codex sessions read back the Play product/base plan/notification topic and the Apple monthly product/group/availability. Current local browser access is disabled; refresh those sessions before actual console actions. On25 October the private `ikanisa/Lovelies` repository was created and verified as local `origin`, preserving `ikanisa/Memories`. Bounded backend/operator source and release docs were pushed and read back at768e3ad. Both CI runs failed before jobs; authenticated GitHub readback identifies the existing organization billing hold. The owner has explicitly parked GitHub billing; do not retry those runs or change payments/limits. Local verification continues, with remote CI still unqualified. Qualified private inference/push operating inputs and
  provider acceptance remain unresolved technical inputs. Earlier requests are
  historical and do not revoke the owner’s authorization to complete readiness.
  Temporary native-image build qualification is separate from an accepted release
  host; no production service, provider send or store publication is established.
- The two manually applied baseline versions are now reconciled/read back through
  supported CLI history repair. Keep the pending9–11 grant condition and quality
  gates; never blindly replay baseline DDL or directly edit Supabase-managed
  migration/Storage tables.

Secrets must not be pasted into chat, committed, bundled in native clients or
shown in submission evidence. This file requests configuration facts and secure
setup, not a new authorization to repeat implementation work.

The actual cached/authenticated CLI is **2.84.2**;2.122.0 was an advertised
available update, not the installed version. Current help confirms the named
function deployment flags `--project-ref`, `--use-api` and `--no-verify-jwt`.
Only `lovelies-api` is prepared, with no `--prune`; deployment has not run.
Supported linking and Management-API SQL readback confirm schema8/63 forced-RLS
tables, zero client/public ACLs/backend membership, zero appaccounts and the three
private20MiB buckets. The security advisor reports zero items after history repair.

The CLI migration-history repair records only the already-approved/applied
`20261023162016` and `20261023210000`. Their source hashes match the original
review bundle; all63 application-table row fingerprints match before/after.
The v9/v10/v11 files remain local/pending, and no application SQL was reexecuted.
Their existing named-grant confirmation remains pending; the supported CLI path
is ready once that condition is resolved. No `db push` or blind replay occurred.
Receipts: `/Volumes/PRO-G40/Projects/Lovelies/verification/supabase-cli-session-20261025/`.

[Android public input template](android-public.properties.example) records the verified product/API/signing/version values without loading them automatically or inventing missing policy/Firebase/link inputs. The observed Google topic is `projects/easymoai/topics/lovelies-google-play-rtdn`; its receiver/OIDC/IAM and delivery still require qualification.

The existing Google project also lists `lovelies-play-billing-verifier@easymoai.iam.gserviceaccount.com` as Lovelies Play Billing Verifier. This is identity existence only; Play permissions, workload/private credential configuration and purchase/restore verification are not established by its name. Do not substitute the separate RTDN OIDC identity for purchase validation.
