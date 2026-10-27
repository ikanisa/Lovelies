# Existing-app website associations

These files use the existing package/bundle identity. The Android fingerprint
comes from the current Play **app signing** certificate, verified23 October2026;
it intentionally does not use the upload or Debug key. The Apple app identifier
matches the inspected existing team/profile. No extra app, web credentials or
activity-continuation permission is declared.

The existing Play listing's Digital Asset Links snippet was read again on
27 October 2026 and matches the local Android JSON semantically. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/play-association-readback-20261027/attempt-01/result.json`.

On 28 October 2026 both files were published on `https://lovelies.ikanisa.com`
using exact Cloudflare Worker routes. Public GET and HEAD returned HTTPS 200
with `Content-Type: application/json` and no redirect; both GET bodies matched
these documents. Google Digital Asset Links returned the expected package and
Play signing fingerprint, and Apple's CDN returned the expected AASA. The
sampled site and admin/photo roots retained their pre-publication responses.
Query-string variants are not intercepted by these exact routes. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/link-association-publish-20261028/attempt-01/`.

iOS `LOVELIES_LINK_HOST` in `ios/Configuration/Release.xcconfig` supplies both
the runtime's trusted host and the source `applinks:` entitlement. The Release
project configuration no longer shadows that input with an empty value. Release
now selects `lovelies.ikanisa.com`; the artifact preflight rejects missing or
malformed hosts and a signed entitlement
that differs from the single configured host, including wildcard or alternate
mode entries. Source wiring alone does not establish the Apple portal capability,
provisioning profile or hosted/CDN delivery.

Current route contracts differ by platform: Android accepts
`/requests/<UUID>` and `/notifications/<UUID>`; iOS accepts
`/match/<UUID>`, `/support/<UUID>` and `/payment/<UUID>`. The Apple file preserves
the ordinary `/support` and `/support/` web pages. Association selects an app;
all content still requires current server authorization. Do not fabricate a
cross-platform marketing link that only one current parser understands.

Qualify the signed iOS Associated Domains entitlement and matching provisioning
profile, Play-installed signing identity and physical authenticated taps. Supply
the same host explicitly as the Android release `loveliesLinkHost` property.
Test sign-in return, expired/deleted/blocked content,
wrong host/path and current recipient/entitlement denial. The QA-only signed
iPhone reference artifact omits Associated Domains and cannot close this gate.

Primary references: [Android website associations](https://developer.android.com/training/app-links/configure-assetlinks)
and [Apple associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains).
