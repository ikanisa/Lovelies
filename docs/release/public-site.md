# Lovelies public-information site — updated 24 October 2026

The 24 October review edition applies the owner-selected 13+ audience, supported
independent guardian review for ages 13–17, and the numerical retention decisions
in `retention-and-young-users.md`. Enforcement and provider/operating
qualification remain separate. The earlier preview was deployed only to
`https://native-public-info-20261024.lovelies-web.pages.dev`; production and the
shared admin/photo hosts were preserved. Terminal readback later returned
Cloudflare 403/error1010, so that later attempt does not refresh hosted acceptance.
Use `scripts/prepare-public-site.py` to stage the explicit 13-file allow-list;
never upload review manifests or the repository root. The local-check section
below records the prior edition and must not be treated as new-byte proof.

The new `web/` directory is a **local review draft** for the next native release.
It has not replaced the current published website, policy edition or store URLs.
Its source content is the coordinator's `policy-content-draft.md` and
`store-listing-en-US.md`. Product UI follows the consolidated Jean Bosco Skills
Revolut Design reference while retaining the authorized Lovelies wordmark and
photo-heart assets.

## Prepared package

| Intended public path | Local source |
|---|---|
| `/` | `web/index.html` |
| `/privacy/` | `web/privacy/index.html` |
| `/terms/` | `web/terms/index.html` |
| `/account-deletion/` | `web/account-deletion/index.html` |
| `/support/` | `web/support/index.html` |

The site uses static HTML, relative links, local CSS and the two copied Lovelies
brand assets. There are no scripts, tracking requests, remote fonts, cookies,
service workers, web forms or private account records. Normal `mailto:` links
open the verified public address **info@ikanisa.com**; the visitor reviews and
sends any message themselves. No message or email draft was sent/opened by this
work. IKANISA LTD is identified from the supplied current public Play evidence.

The deletion page works without app installation or sign-in. It explains the
in-app route, minimal email identifiers, proportional ownership checks, pending
versus verified cleanup, retained justified records, external copies and separate
store-subscription cancellation. It explicitly excludes selfies/biometric material,
device keys, recovery secrets and payment-card information from email. It does not
introduce OTP or automate deletion from an unverified message.

All pages visibly say Review draft, give a preparation date rather than an
effective policy date, and retain the unresolved inference operator/location,
retention/backup, audience/territory, controller/legal and support-operation gates.
Supabase Ireland and the private inference architecture are described from the
provided implementation draft; no unverified inference operator/location is named.

## Local checks completed

`web/local-checks.json` records:

- Five HTML pages and **95 local/fragment/asset/mail links checked**, with no
  broken or out-of-package path.
- Unique IDs, one main/H1/title/header/footer per page, English language,
  viewport/draft indexing metadata, named navigation and meaningful image alt text.
- Eleven mail links checked for the correct recipient; the prepared deletion
  subject/body use percent-encoded spaces and contain no private account material.
- Both copied brand assets match their authorized source SHA-256 hashes.
- Eight local HTTP responses passed on the root-owned preview server: five pages,
  CSS and two assets, all returning content with HTTP 200.
- A separate Chrome tab visibly rendered the desktop homepage and deletion page.
  The deletion contact section and ownership/sensitive-information instructions
  were inspected through screenshots and accessibility text. The email link's
  resolved address/subject/body were observed without activating it.

Root's local review route is
`http://127.0.0.1:8768/web/`. This is a loopback preview, not deployment evidence.
These bounded checks do not establish full accessibility conformance, a mobile/
zoom/assistive-technology device matrix, inbox delivery, support operation,
hosting security, legal review or store acceptance.

## Hosting and publication remain open

`web/README.md`, `_headers`, `_redirects`, `robots.txt` and `site.config.json`
provide the review package and intended static-host route/security configuration.
The files do not configure a server by themselves. The selected actual host must
support and apply their syntax; verify clean directory-index paths and HTTPS.
Keep the repository, verification results, README/config sources and secrets out
of the public file allow-list. Private APIs must not receive a broad site fallback.

Before publishing, the controller must finalize the inference provider/location,
active retention and completion periods, backup expiry, audience/territories,
legal/contact details and support/privacy operations. Reconcile final notices
with the exact deployed app, API, providers and store disclosures. Approve the
public domain/routes, edition/effective date and indexing changes; preserve the
old published edition as history. Then publish under existing authorization and
verify the actual hosted pages, headers and mailbox/request workflow. No publish,
deployment, live policy replacement or legal approval occurred in this slice.
