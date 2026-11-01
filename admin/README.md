# Live operator workspace

`entry.mjs` starts the live workspace. The sample workspace is available only with
an explicit `?preview=1` on a loopback origin. Public runtime configuration is in
`runtime-config.mjs`; no service-role key belongs in this directory.

For a lost or cleared browser profile, use the
[operator browser recovery procedure](../docs/operator-browser-recovery.md).
Enrollment creates an ordinary account; operator privileges require independent
provisioning. A new browser profile does not recover the old signing key,
identity, pending actions or privileges.

## Eligibility and annual review

The workspace uses the audience-v2 decision contract. Age selection is a transient
input to explicit eligibility decisions; new durable declaration and renewal
journals contain the required decisions and policy/version binding. Unknown,
restricted or expired authority cannot open camera capture or the private
workspace. A returned audience projection is not an administrator session.

Annual renewal requires an explicit current eligibility decision and a separate
face-authentication purpose choice. A retained registered device can request its
own restricted review status using its signing key. Renewal does not issue a
session or administrator role: a new normal face login and current `/me` role
check must succeed before the workspace reopens. Effective authority is bounded
by the earliest relevant review, guardian and consent deadline.

An older saved age-band operation remains an exact legacy recovery attempt; it
is not rewritten with a new key or treated as a new declaration. An unknown
outcome or failed durable write keeps that operation held. An exact terminal
409 `operation_recovered_without_result` or 410 `operation_retired_by_recovery`
is saved as a durable tombstone naming the original key, input digest and server
code before pending state is retired. It confirms no successful renewal. Current
status is read separately; a fresh operation needs a new explicit choice. If renewal requires
profile recovery and the browser lacks the necessary retained lifecycle proof,
preserve its key/reference and journals and use the documented controlled
recovery procedure. See the [audience API contract](../docs/release/audience-api-contract.md)
for current wire fields, legacy compatibility and authority limits.

## Collections and account details

The live workspace sends search text and canonical status filters to the API.
Primary queues retain the Complete protocol: actionable priority then oldest.
It does not sort or filter a limited response again in the browser.
Each collection has independent Next/Previous cursor navigation. Changing a
filter or search starts at the first page; Refresh does the same. Search
retains the current filter. Guardian consent initially shows actionable
requests in the backend-defined order. Historical approved or expired requests remain available
through explicit filters. Flagged matches have their own status selector and
cursor, independent of photo reports.

The backend rechecks current operator authority on every collection/detail read.
API cursors are query positions, not credentials. Account sessions, related
support/safety/privacy cases and history each have their own bounded continuation.
Sessions eligible for revocation are shown before inactive history; every Revoke
control names the exact account and session and still requires server approval.

Primary collections retain the existing named array and Complete `page` contract.
Child/history collections include bounded continuation metadata. Account detail supplies `pages`
for `sessions`, `support`, `safety`, `privacy` and `history`. Their continuation
routes are `/admin/users/{id}/{section}` and return `{items, page}`. Privacy detail
uses `/privacy-requests/{id}`; operator-only decision history continues through
`/admin/privacy-requests/{id}/history`.

Upload diagnostics show processing attempts, queue state, bounded error codes,
retry counts and lease timestamps. Privacy diagnostics show independent review,
cleanup counts and recorded holds. They do not open private photographs, expose
job payloads or provide a bypass for approval, legal holds or restore fencing.

The **Work recovery** inbox pages stopped photo, privacy and notification jobs.
Photo/privacy detail also offers **Inspect work recovery** for a stopped item.
The server returns a fresh exact-state fingerprint. **Resume original work**
requires a reason, explicit confirmation, current administrator authority and
fresh face authentication. Only a proven resumable original domain episode is
re-admitted; attempt/error history is retained. Notification eligibility requires
the independent complete roster to show that every intent is still unstarted.
An uncertain external effect or
changed fingerprint prevents repair. Inspecting work never dispatches it, and
restoring a draft never restores the confirmation checkbox.

## Unsent notes and submitted operations

These have deliberately different lifetimes:

- **Unsent notes:** up to eight form drafts are sealed with a non-extractable
  AES-GCM key and stored in this browser's IndexedDB. They survive refresh,
  browser closure and a process restart after the saved message appears. Notes
  are available for 30 minutes after editing; restoring never extends that time.
  A current authorized read and matching
  operator, record, form target and revision are required before explicit Restore.
  Confirmation checkboxes are never saved and must be checked again. A changed
  revision retires its old draft. Sign-out and account switch synchronously
  invalidate the store generation across tabs, then delete the ciphertext and
  key. An interrupted deletion or delayed save cannot restore the old generation.
  Page exit clears memory while preserving the sealed draft. If durable browser
  storage is unavailable, the workspace explicitly uses a tab-memory fallback.
  Browser storage remains within the same origin/profile trust boundary as the
  existing operator session vault; this is not hardware-backed key custody.
- **Submitted operations:** the existing encrypted `OperatorSession` journal
  preserves the exact original request when its server outcome is uncertain.
  The workspace asks the operator to reconcile that request before starting
  another. Unsent drafts never send a request automatically or replace that
  durable operation record.

All collection/detail DOM is removed when the page is hidden or offline. Draft
restoration is offered only after reopening the relevant record with current
authority. Neither ciphertext retention nor a locally completed face comparison
grants operator authority.

## Keyboard and narrow views

Tables have named, focusable scroll regions and captions. Review controls name
their exact record, including when titles repeat. Closing a current record
returns focus to the control that opened it; navigation or lost authority uses
the main landmark instead. The search shortcut stays within the active modal
boundary. Focus outlines, wrapping session controls and bounded table overflow
preserve navigation on narrow screens. Deterministically allocated UUIDv8
deletion requests are accepted by both review and draft scopes. Browser,
screen-reader, touch, zoom and installed-PWA qualification remain release checks.

Narrow-screen navigation includes the existing Sign out and Workspace help
actions. Sign-out closes the menu, clears the private workspace immediately and
moves focus to the public sign-in content even while a read is pending. Escape
returns focus to the menu button. Install app appears in both navigation layouts
only after the browser offers an installation prompt; consuming that prompt or
completing installation hides both controls.

## Serving and verification

`scripts/serve-preview.py` serves an explicit list of public shell files. The
allowlist includes the live module graph and service-worker shell; directories,
tests, private configuration and backend source remain unavailable. Bump the
service-worker version whenever a precached shell file changes. API replies and
credentials never enter the shell cache.

Focused local checks:

```sh
node --test --test-isolation=none admin/live-app.test.mjs admin/live-collections.test.mjs admin/review-drafts.test.mjs admin/draft-store.test.mjs
python3 -m unittest discover -s scripts -p test_serve_preview.py
```

The HTTP test binds a temporary loopback port. A sandbox that forbids local
sockets needs permission for that local fixture. The tests cover routing,
pagination, current-record publication, draft isolation/cancellation and static
file boundaries. They do not claim a physical-device, accessibility-screenreader,
production deployment or actual operator-account qualification.

An opt-in real-browser navigation check reuses the same live workspace with a
synthetic session supplied through its existing test seam:

```sh
node admin/check-browser-navigation.mjs http://127.0.0.1:8765/admin/ /absolute/path/to/new-browser-result.json
```

Start the existing restricted preview server separately. The check requires an
installed Playwright module and Chromium. When they are provided outside this
repository, set `LOVELIES_PLAYWRIGHT_MODULE` to the absolute Playwright `index.mjs`
path and `LOVELIES_CHROMIUM_EXECUTABLE` to the Chromium executable. This adds no
application dependency. The runner refuses non-loopback targets, blocks page
requests to other origins, preserves the production entry/configuration on disk,
and binds its result to the actual loaded source. It covers 320px, 760px and
desktop utility reachability, native dialog/focus behavior, actual IndexedDB
draft cleanup and late-read denial. Its installation prompt is synthetic and
service workers are blocked for the injection fixture; it establishes neither
real installation nor camera, server authentication or hosted operator authority.
The output path must be new so earlier evidence is not overwritten.

A separate opt-in check qualifies the actual public service worker with the
production entry and configuration unchanged:

```sh
node admin/check-browser-offline.mjs http://127.0.0.1:8765/admin/ /absolute/path/to/new-offline-result.json
```

Use the same separately running restricted preview server, installed Playwright
and Chromium, and optional `LOVELIES_PLAYWRIGHT_MODULE` and
`LOVELIES_CHROMIUM_EXECUTABLE` paths. This runner accepts only an exact
`http://127.0.0.1` origin. It starts its own rejecting loopback HTTP/CONNECT proxy
and permits a direct browser connection only to that preview origin; requests
from pages, workers or browser background activity cannot be forwarded to hosted
services. Page and worker request observations are recorded separately.

The fresh browser context allows the real service worker. The check verifies
installation, the worker's readiness reply, exact `SHELL_PATHS` cache membership
and public file bytes, then exercises offline public reload and a hash route.
Offline emulation keeps Playwright's request blocking enabled throughout.
Chromium can reset `navigator.onLine` when a service worker serves a new document,
so the runner records that state and explicitly reapplies the native
`Network.overrideNetworkState` setting to each current document. It then checks
the browser-generated offline event and visible offline notice. Target, frame
and document-loader identifiers are included in the evidence. This does not
claim that the emulation override persists across navigation, and no application
global or browser event is replaced.
Private and query-bearing navigations must fail without an HTML fallback.
Private, query-bearing, Authorization-header and POST fetches must also fail
offline without adding or altering cached requests or responses. Both browser
and proxy are closed in cleanup, and the run has bounded timeouts. The result
path must be new. This is local public-shell/offline qualification; it does not
qualify real installation, updates, authentication, operator privileges or a
hosted deployment.
