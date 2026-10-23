# Remaining deployment inputs

The approved Supabase schema is applied and read back at version 8. All63 tables
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
| Product candidate | `com.lovelies.memories.pro.monthly` remains source provenance until actual product/pricing/offer records are verified |
| Public mailbox | `info@ikanisa.com` observed in current Play listing; actual operation/delivery remains untested |
| Current Apple callbacks | Earlier `https://lovelies.api.ikanisa.com/subscriptions/apple/notifications`; cutover must preserve and qualify callbacks |

## Server configuration

No custom Edge Function secrets and no Edge Functions were present in the
post-schema dashboard inventory. The adapter already supports Supabase's reserved
`SUPABASE_DB_URL`, `SUPABASE_SECRET_KEYS.default` and legacy server-only Storage
fallback. Do not unnecessarily reveal/copy reserved keys or set blank override
secrets. Explicit `LOVELIES_DATABASE_URL`, optional verified CA and
`LOVELIES_STORAGE_SECRET` overrides are for a justified deployment configuration;
remote TLS certificate/hostname validation remains mandatory.

| Boundary | Required input/action |
|---|---|
| API credentials | Independent strong `AUTH_SIGNING_SECRET`, `MEDIA_SIGNING_SECRET`, `INTERNAL_MAINTENANCE_SECRET` in the secret store. Refresh receipt encryption derives from the auth secret; rotation requires an operated recovery/retention plan. |
| Policies/model | Final approved `FACE_AUTH_POLICY_VERSION`, `PHOTO_CONSENT_POLICY_VERSION` and accepted `PHOTO_MODEL_VERSION`; publish matching readable policies. |
| Inference | Approved operator/host/location, qualified immutable runtime/model and representative evaluation; private HTTPS `ML_INFERENCE_URL` plus independent `ML_INFERENCE_SECRET`. The prepared service requires matching service-side configuration. |
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
  certificate/highest-code inputs. Apple needs production APNs/Associated Domains
  capabilities and a matching distribution profile. Current inspected profiles do
  not establish those production capabilities.
- Produce and inspect exact signed candidates, qualify store-installed in-place
  upgrades without uninstall/reset, run two-account hosted journeys and physical
  camera/storage/media/accessibility/performance/provider acceptance, and complete
  Play testing/TestFlight and reviewer access. No actual store upload occurred.
- The intended canonical Git remote and approved private inference/push host/operator
  have been requested from the owner. Source and historical evidence remain local;
  no new repository, paid host, provider send or public release was created.
- Reconcile the two manually applied migration versions through supported Supabase
  CLI history repair/readback before future `db push`; never blindly replay the
  fresh-schema DDL or directly edit Supabase-managed migration/Storage tables.

Secrets must not be pasted into chat, committed, bundled in native clients or
shown in submission evidence. This file requests configuration facts and secure
setup, not a new authorization to repeat implementation work.
