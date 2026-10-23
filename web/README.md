# Lovelies public-information package — local review draft

Prepared 23 October 2026. This is a static HTML/CSS package for the next native
Lovelies release, built from `docs/release/policy-content-draft.md` and
`store-listing-en-US.md`. It has not changed the current published site or policies.

Serve this directory as the document root. Pages also work under a local `/web/`
mount because internal links and assets are relative. There is no JavaScript,
form submission, analytics, cookie banner, service worker, remote font or private
account data in this package. Support/deletion links open the visitor's email app
with the verified public address `info@ikanisa.com`; nothing is sent automatically.
The normal Apple standard-EULA link is an external reference, not legal adoption
or approval of these draft product terms.

| Path | File |
|---|---|
| `/` | `index.html` |
| `/privacy/` | `privacy/index.html` |
| `/terms/` | `terms/index.html` |
| `/account-deletion/` | `account-deletion/index.html` |
| `/support/` | `support/index.html` |

`site.config.json` describes intended routes and unresolved publication inputs.
It is a review manifest, not a host API or an executable deployment configuration.
`_headers` and `_redirects` use conventional static-host syntax; the deployment
owner must confirm that the selected existing host applies it. Do not assume
those files set headers on an arbitrary server. Directory index routing must
resolve the listed clean paths. Do not configure a broad SPA fallback or expose
the repository root, source files, verification evidence or secrets.

The package contains only copied authorized Lovelies wordmark/photo-heart artwork.
It contains no user photographs, source reference branding or invented store links.

## Publication gates

1. Reconfirm controller/contact details against the current operator and review
   complete legal terms and applicable privacy notices.
2. Record the actual private-inference hosting operator and location, actual
   enabled processors, active retention and deletion periods, backup expiry,
   justified holds, audience and launch territories. No missing value is invented.
3. Qualify the support mailbox, proportionate ownership check, controlled
   privacy-request handling and request-status/completion communications. The
   package does not automate deletion from unverified email or introduce OTP.
4. Compare the final notice with the exact deployed native/API/provider behavior
   and store disclosures. Verify all in-app privacy/terms/deletion URLs.
5. Approve publication to the existing chosen public domain and preserve the old
   published edition as history. The current domain reference is
   `https://lovelies.ikanisa.com`; `canonical_origin` remains unset until approved.
6. After approval, finalize the effective edition/date and draft status, approve
   the intended indexing policy, configure HTTPS/routes/headers, and verify the
   actual hosted pages and mail links. Current draft banners, robot directives
   and noindex headers must not be mistaken for a final public-policy edition.

Local link/HTML checks are documented in `docs/release/public-site.md`.
They cannot verify inbox delivery, support operations, hosted behavior, legal
review, deployment or store acceptance. No publishing command is included.
