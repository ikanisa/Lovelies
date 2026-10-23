# Existing-app website associations — prepared, unpublished

These files use the existing package/bundle identity. The Android fingerprint
comes from the current Play **app signing** certificate, verified23 October2026;
it intentionally does not use the upload or Debug key. The Apple app identifier
matches the inspected existing team/profile. No extra app, web credentials or
activity-continuation permission is declared.

After the existing public domain and release capabilities are qualified, publish
these files as `/.well-known/assetlinks.json` and
`/.well-known/apple-app-site-association`, both HTTPS200 with
`Content-Type: application/json`, no authentication and no redirects. Merge with
any existing associations rather than overwriting unknown applications. The
selected domain must match both release configurations exactly. The current
public Lovelies site is `https://lovelies.ikanisa.com`; final association there
has not been inspected or changed by this package.

Current route contracts differ by platform: Android accepts
`/requests/<UUID>` and `/notifications/<UUID>`; iOS accepts
`/match/<UUID>`, `/support/<UUID>` and `/payment/<UUID>`. The Apple file preserves
the ordinary `/support` and `/support/` web pages. Association selects an app;
all content still requires current server authorization. Do not fabricate a
cross-platform marketing link that only one current parser understands.

Qualify the signed iOS Associated Domains entitlement and matching provisioning
profile, Play-installed signing identity, hosted association/CDN readback and
physical authenticated taps. Test sign-in return, expired/deleted/blocked content,
wrong host/path and current recipient/entitlement denial. The QA-only signed
iPhone reference artifact omits Associated Domains and cannot close this gate.

Primary references: [Android website associations](https://developer.android.com/training/app-links/configure-assetlinks)
and [Apple associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains).
No association or public domain setting was deployed.
