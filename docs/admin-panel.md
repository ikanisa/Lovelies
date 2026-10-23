# Lovelies admin design preview

The interactive design preview is intended for local review at
`http://127.0.0.1:8765/admin/`, using the existing restricted preview server.
It is a static, responsive operator workspace with six destinations: Overview,
Users, Match reports, Privacy, Support and Uploads. The design is implemented locally. Verified results and remaining integration
boundaries are recorded below.

## Scope and data

All people, records, counts and timestamps shown by the preview are explicit
sample-data snapshots from its demo store. Notes and decisions are simulated
local review interactions. They do not authenticate an administrator, contact a
user, change Cloudflare data, grant photo access or execute a privacy request.
The preview is not a deployed or integrated administration application.

The intended review interactions are navigation, search, status filtering,
sorting, contextual record details, draft notes and clearly labelled simulated
decisions. The sidebar retains meaningful labels and large familiar icons;
compact layouts use a navigation dialog and readable record lists. Detail
drawers retain request identity, status and consequences beside any action.
User management was explicitly requested by the owner on 16 October 2026.
Its scope is account metadata, related cases and individual session revocation.
Revenue, professional contributor roles and unrelated social features remain outside this design.

## Why each page exists and how it is presented

| Page | Product reason | Presentation reason |
| --- | --- | --- |
| Overview | Direct operators to unresolved cases and failed work. | One attention queue, a next-case action, useful totals and recent activity. The repeated upload total was replaced with an active-account count; processing is summarized once. |
| Users | Explicit owner request, plus existing anonymous/registered accounts and session lifecycle. | Searchable table with identity filters, then one drawer for account status, sessions, related cases and audit. Revocation asks for a reason and confirmation; user deletion stays within Privacy. |
| Match reports | The frontend lets recipients report incorrect photo matches. | Task-specific open/in-review/resolved/rejected filters and case context. This replaces the vague Safety label without changing the underlying report workflow. |
| Privacy | Existing data-export and account-deletion journeys need review and execution tracking. | Decision and execution are separate fields. Queued/running/failed/completed filters expose the real distinction; approval is never presented as deletion or delivery. |
| Support | The Help journey requires operators to investigate and record outcomes. | Open/in-review/resolved/rejected/closed filters, user links, contextual details and complete decision history. |
| Uploads | Existing ordinary uploads require processing visibility and failure diagnosis. | Processing/processing-complete/failed filters, metadata and recovery context. No private-photo viewer or unsupported retry command. Completion still leaves sharing approval to the owner. |

This preserves the existing Lovelies admin composition and the designed consumer
frontend. It adds no donor-only business role or workflow. The technical API
identifier `safety` is retained behind the narrower Match reports label; old
`#safety` bookmarks resolve to that page.

## Current critical integration gap

The browser UI remains an explicitly labelled **sample workspace**. Its local
session revocation, request decisions and execution examples are simulations.
The active Cloudflare user-management handlers and SDK methods are real local
implementation, but the preview does not call them.

A production admin access journey still needs a browser camera/capture adapter,
a retained browser device key and reference, supported new-device recovery,
registered-face login and fresh verification, access-denied/session-expired/
sign-out states, and authoritative API loading/error/conflict handling. An
already registered native device does not give a browser its private key or
session. New anonymous accounts receive no administrator authority. No token
paste, password or OTP substitute was added.

Privacy execution and upload failure details shown here are synthetic design
examples. Upload attempts/error fields are not currently returned by the live
`GET /admin/uploads` projection. Backend evidence and live UI integration must
precede a claim that these panels monitor real work. Hosted deployment and
administrator provisioning have not been performed.

## Visual source and target adaptation

The sole visual skill is Revolut Design from Jean Bosco Skills,
`revolut-design@jean-bosco-skills`, selected through installed discovery. The
review applied its `DESIGN.md`, web patterns, typography, brand adaptation,
discovery/outcomes, asset/motion and PWA/accessibility references.

Two actual source images were opened and visually inspected:

| Comparator | Useful visible evidence |
| --- | --- |
| `/Volumes/PRO-G40/Projects/ChatGPT/Revolut/private/qa/source-mac-20260906/analytics-desktop-photo.png` | Dark Business sidebar, broad working canvas and quiet tonal panels. Perspective and occlusion prevent exact geometry measurements. |
| `/Volumes/PRO-G40/Projects/ChatGPT/Revolut/private/qa/source-mac-20260906/receipt-processing.png` | Rounded grouped rows, subdued processing text and an amber attention state. |

These belong to the **official Business static promotional reference cohort
retrieved 6 September 2026**, from the public Analytics and Expense Management
pages. Artwork publication date, depicted app build and authenticated runtime
are unknown. The images are references only and are not runtime artwork.

The target adapts their dark composition to Lovelies' own operator tasks. It
uses the supplied Lovelies wordmark, readable product
typography, restrained neutral surfaces, purposeful status colour and few
competing actions. The supplied pink artwork remains Lovelies branding. The
labelled sidebar, overview priorities, exact radii, spacing, responsive rules,
table/list geometry and drawer interactions are target adaptations, not
recovered Revolut specifications or a claim of pixel fidelity.

## Relationship to current Cloudflare APIs

The current frontend journeys determine the scope: incorrect-match reporting (36),
privacy/sharing (40), export (44), help (45), account deletion and ordinary uploads
(19–24). Backend existence alone does not authorize a design area.

This mapping explains the real workflow behind each retained design area. **No API
integration is claimed.** Current handlers in
`services/cloudflare-api/src/operators.ts` and `privacy.ts` are the source for
these routes; legacy copied routers and earlier receipt schemas are not the
integration contract.

| Preview destination | Current backend capability | Important outcome distinction |
| --- | --- | --- |
| Users | `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/sessions/revoke`. | Metadata only; revocation requires a reason, fresh registered-face administrator verification, a current target session and audit. No role editor, biometric viewer, direct account deletion or temporary suspension. |
| Overview | `GET /admin/metrics` returns accounts, uploads, active grants, open support and open reports. | Counts do not establish trend history, revenue or account-management capability. |
| Match reports | `GET /admin/safety/reports`; `POST /admin/safety/reports/:id/resolve` with hold/release/resolve/reject; match detail/review also exists. | Releasing a hold does not restore grants or create photo access. Reviews require the actual authorization, reason and revision controls. |
| Privacy | `GET /admin/privacy-requests`; `POST /privacy-requests/:id/approve`, `/reject`, `/process`; request-status retrieval. | Approval queues work and returns `delivery_confirmed: false`; it is not completed erasure or delivered export. |
| Support | `GET /admin/support-requests`; `POST /admin/support-requests/:id/start`, `/approve`, `/reject`, `/close`. | Real review uses expected revision and operation keys; a simulated UI result is not a backend acknowledgement. |
| Uploads | `GET /admin/uploads` returns upload metadata. | Listing metadata does not authorize arbitrary private-media access or provide a retry/delete endpoint. |

Any later integration must preserve Cloudflare authority, no OTP/no liveness,
registered-reference comparison, current-session authorization, separate
purpose consent, private media, exact recipient subsets, approval before
access and store entitlement boundaries.

## PWA and access behaviour

The scoped PWA design caches the public admin shell only, with no API-response
caching. Consequential production actions would still require real online
authorization and authoritative outcome checks. Demo persistence is not an
offline production workflow. Installation, real standalone navigation,
platform storage recovery, update behaviour and browser/device support remain
unverified until exercised on the relevant installed surface.

Keyboard focus, labelled controls, drawer/dialog focus containment and return,
Escape dismissal, readable status text, touch targets, compact reflow and
reduced motion belong to this review. None is claimed passed by the existence
of this handoff.

## Coordinator verification

Verified locally on 16 October 2026. Use the existing server where available;
do not start a competing process on port 8765.

```sh
python3 -m unittest discover -s scripts -p test_serve_preview.py
curl --fail --head http://127.0.0.1:8765/admin/
```

If the task-owned server is not running, its launch command is:

```sh
python3 scripts/serve-preview.py --port 8765
```

Coordinator checks:

- Inspect all six destinations and their actual screenshot output at desktop
  and phone widths; check enlarged text and unnecessary horizontal overflow.
- Exercise search, status filters, sort, record selection, notes, simulated
  decisions, reset, and browser back/forward; confirm empty and no-result states.
- Use keyboard navigation for sidebar, mobile menu and detail drawer; inspect
  accessible names, focus trapping/restoration, Escape and status announcements.
- Inspect network activity: review actions must not send production requests;
  displayed data and outcomes must remain explicitly synthetic.
- Inspect the manifest and service-worker scope/cache allowlist; verify API
  routes and private data are not cached. Report shell, offline and installed
  platform evidence separately.
- Record the submitted files, commands, observed results and remaining limits
  before replacing any pending result with a pass.

Local implementation and preview checks cannot establish hosted integration,
professional review, deployment, release or installed-device acceptance.

### Earlier preview verification (before scope correction)

- `node --check admin/app.js` and `node --check admin/sw.js`: passed.
- `node --test admin/demo-store.test.mjs`: 8 passed.
- `node --test admin/sw.test.mjs`: 3 passed.
- `python3 -m unittest discover -s scripts -p test_serve_preview.py`: 8 passed;
  original mobile preview routing and private-file denial retained.
- Codex in-app browser: all six routes, request search, no-results recovery,
  status filter, oldest-first sort and focus retention, request drawer, saved
  draft across reload, simulated privacy approval to queued, support rejection
  displayed distinctly, focus restoration after a filtered item disappears,
  skip link preserving its route, explicit preview update, and sample reset.
- Desktop overview and detail inspected; 390px mobile and 320px reflow inspected.
  At 320px, document width was 320px, with no horizontal overflow. Mobile menu
  includes all destinations and install/about/reset utilities.
- Initial offline hash reload failed. The service-worker exact allowlist was
  corrected to ignore only URL fragments; queries/private paths remain excluded.
  The updated `20261016-3` shell reloaded `#photographers` successfully with
  browser networking offline. Network and viewport overrides were then reset.
- Screenshot artifacts: `verification/admin-design-20261016/overview-desktop.jpg`
  and `overview-mobile.jpg`. Input hashes for that earlier version are in `source-sha256.json`; these are historical snapshots, not the corrected current preview.

Installed app/device behavior, real screen-reader speech, 200% browser text zoom,
cross-window persistence conflict handling, live face-authenticated operator
handoff/API integration and deployment remain unverified or outside this design
slice. No paid services, production migrations or backend changes occurred.
The workspace has no `.git` metadata, so no commit/diff publication is claimed.

### Frontend scope correction — 16 October 2026

Photographer navigation, access decisions, sample accounts/activity and professional
upload labels were removed. Persisted old sample state is reset so those items
cannot reappear. The five retained destinations preserve the existing composition,
typography, colours and responsive layout. The current service-worker version is
`20261016-4`. See [frontend alignment](frontend-alignment.md) for the backend/client
cleanup and [current verification](../verification/frontend-alignment-20261016/README.md).
Earlier screenshots remain historical evidence.


## User-management correction verification (16 October 2026)

This continuation adds the owner-requested Users page and corrects the retained
pages without changing the consumer frontend. User metadata includes matching
state separately from authentication: enabled, paused, not enrolled, or not
enabled when an authentication-only profile has no current matching consent.
History is available in each contextual drawer; long event trails expand in place.

Local coordinator results:

- TypeScript source/test checks and Cloudflare dry-run bundle passed.
- 73 backend unit tests and 174 workerd runtime tests passed (7 new user-management cases).
- 49 client tests passed (15 new admin-client cases), plus 21 admin store/view-model/service-worker tests.
- 8 restricted-preview-server tests passed. The new presentation module is an explicitly public shell asset.
- Browser checks covered account filters, account/case links, required revocation reason, single-session revocation, audit, reload persistence, deleted account boundaries, support rejection/search, domain filters, failure detail, and Overview/View all consistency.
- 320px Users and Privacy reflow stayed within the viewport. Desktop and mobile captures are in `verification/admin-management-20261016/`.
- Explicit service-worker update and offline hash-route reload were checked. The final public-shell version is `20261016-9`; private API/session/media data is excluded.

## Desktop reference refinement (17 October 2026)

The owner supplied `/Users/jeanbosco/Desktop/Lovelies-Admin-Desktop` as a visual
reference. Its overview, users, user-detail and privacy-detail images were
inspected alongside the current panel. Revolut Design remains the sole design
skill; this folder supplies visual examples, not new product requirements.

Selected adaptations reduce header/sidebar spacing, remove the repeated page
eyebrow, give search and sorting clearer boundaries, tighten table rows and use
neutral initials for user identification. Detail facts align in quiet separated
rows, with more readable secondary text and a persistent Close header. Open
dialogs prevent background scrolling. The six destinations, workflow meanings,
sample state, Lovelies wordmark and pink accent remain intact.

The reference's additional modules, private-photo views, tiny text, commercial
account controls and bulk actions were not adopted. No assets or source files
were copied into runtime, and the reference folder was not modified.

All 21 admin checks passed. Desktop, 760px and 320px layouts, filters/search/sort,
drawer scrolling and Escape focus return were checked in the browser. The
explicit update to shell `20261017-2` and an offline Users reload passed.
Screenshots, source hashes and scope are recorded in
[`verification/admin-desktop-refinement-20261017/README.md`](../verification/admin-desktop-refinement-20261017/README.md).
The live authentication/API integration gap above remains unchanged.

## Detailed reference review and implementation (17 October 2026)

The owner's follow-up required a page, section and element review. The expanded
audit accounts for all 204 supplied reference PNGs, with inspection methods,
source-file coverage and adoption/rejection reasons recorded in the
[reference review](../verification/admin-reference-deep-review-20261017/reference-review.md).
This is coverage of the supplied material, not a claim that every image was
examined at native pixel resolution. All 211 snapshotted reference files remain
unchanged.

The resulting design retains the six existing destinations and Lovelies' identity:

| Page | Additional reference elements adapted | Why this presentation helps |
| --- | --- | --- |
| Overview | Compact category shortcuts, count-to-filter links, a bounded attention queue, actual processing counts and linked recent activity. | Operators can choose a queue or open the next case. Four short desktop tiles preserve room for actionable records; no invented trend chart is shown. |
| Users | Identity and matching state, active sessions, related-case counts, joined date, grouped account detail and exact session confirmation. | Account context is visible before an access decision. Wider details keep sessions and cases beside a summary; small screens put account facts first. |
| Match reports | Access-impact column, report context, visible hold state, decision history and an adjacent reason/action panel. | The operator can assess the reported match and its access consequences together. Resolving a report still does not grant photo access. |
| Privacy | Separate decision/execution columns and paired detail states; scope, attempts, times, failure and recovery facts. | Approval, processing and completion are visibly different. Failed work remains discoverable without a fabricated retry command. |
| Support | Issue category, expected/observed comparison, affected item, internal review note and outcome history. | The reported problem and evidence remain beside the decision. These are internal notes, not outbound replies. |
| Uploads | Photo/attempt counts, processing state, recorded failure context and processing history. | Failures can be investigated from metadata while private photos and sharing authority remain protected. |

Shared refinements include All/Needs attention tabs with detailed status selection,
clear-search control, per-page filter restoration, previous/next record navigation,
account/case return paths, copyable references, disclosed older history, exact
confirmation scope and readable opaque dialogs. Unknown bookmarks have an honest
recovery view. No reference-only product area was added.

The browser review also corrected concrete integration issues: narrow account
badges splitting words, confirmation identity spacing and scroll reset, modal
keyboard cycling, global-search filter leakage, cancelled revocation reasons,
and hidden retained notes after a concurrent terminal decision. Stale actions
require reviewing current state; they are never replayed automatically. Unsent
terminal notes/reasons remain visible and cannot repeat the completed action.

Current local evidence: **26 admin tests and eight restricted-server tests pass**;
all six desktop and 320px pages were inspected, with 760px overview/privacy/detail
checks, keyboard/focus, navigation, filtering/search, two-tab conflicts, sample
reset, explicit update and offline Users reload. The public-shell version is
`20261017-6`. See the [verification record](../verification/admin-reference-deep-review-20261017/README.md)
for screenshots and precise limitations. The earlier entries above are historical.

The important missing production surfaces remain administrator entry, fresh
verification and session recovery, plus authoritative loading/error/outcome states
for the existing Cloudflare workflows. They are not replaced by sample sign-in
screens. Live API integration, installed-device behavior, screen-reader speech,
200% browser zoom and deployment are not established by this local design pass.

No deployment, live browser authentication, real account mutation, provider work
or native-device acceptance is claimed. Browser runtime results apply to this
local preview only. Evidence and remaining integration tasks are recorded in
`verification/admin-management-20261016/REPORT.md`.
