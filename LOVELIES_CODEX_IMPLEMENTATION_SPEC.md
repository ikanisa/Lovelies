# Lovelies — Native Mobile Experience & Implementation Specification

**Document:** `LOVELIES_CODEX_IMPLEMENTATION_SPEC.md`  
**Version:** 1.0  
**Prepared:** 13 October 2026  
**Research baseline:** 13 October 2026  
**Product:** Lovelies — account-level face matching and controlled photo delivery  
**Primary repository reference:** `ikanisa/Memories`  
**Primary application reference:** `apps/user_flutter`  
**Status:** Implementation instructions and acceptance criteria; not evidence that the work is complete.

> **Owner amendment, 23 October 2026, Supabase and replacement:** Use Supabase
> project `ltqfplqevxztlswlzexn`, API URL
> `https://ltqfplqevxztlswlzexn.supabase.co`. This supersedes the earlier
> Cloudflare-only backend/database direction below. Implement the current
> anonymous-first, backend-verified three-selfie registration, later fresh-selfie
> authentication and recovery contracts on the selected architecture; no OTP or
> liveness. Required privacy, exact-subset sharing, independent approval and store
> entitlements remain. The owner confirms Memories is live on both stores but has
> no real users, photos or subscriptions to migrate. Replace it through the
> existing store identities and compatible signing; legacy customer-data imports
> are unnecessary. Preserve historical sources and qualify real in-place updates.
> A separate qualified private inference service may support the Supabase backend.
> Complete the authorized readiness backlog; report external configuration,
> physical-device, deployment and store acceptance separately.

> **Owner amendment, 13 October 2026:** The Lovelies backend and database run on
> Cloudflare. Default authentication creates an anonymous session. Verification
> of the user's enrollment selfies automatically creates the authenticated face
> session in the backend. There is no OTP flow. This replaces the earlier face
> authentication exclusion and Supabase architecture assumptions below. The
> account-level enrollment, photo consent, approval, access and entitlement
> requirements remain. See [the current implementation record](docs/cloudflare-transition.md).

> **Owner amendment, 13 October 2026, no liveness:** No liveness/PAD, blink,
> head-turn challenge, or camera-injection qualification is required anywhere in
> the active Lovelies app or backend. Enrollment uses the existing three profile
> selfies and automatically upgrades the anonymous session after backend face
> comparison. Later sign-in compares a fresh signed selfie with that registered
> reference. Single-use challenges, consent, device keys, current-session
> authorization, and sharing approval remain. No OTP.

> **Owner amendment, 16 October 2026, frontend scope:** Preserve the current
> Lovelies frontend design. Borrow MEMORIES implementation only for capabilities
> aligned with that design and the explicit app requirements. Do not introduce a
> product feature merely because the donor backend contains it. Photographer
> applications, professional contributor modes and extra payment-settings controls
> are outside this app. Necessary authentication, consent, private-media, sharing,
> privacy and store-entitlement protections remain. Historical donor records and
> database compatibility do not authorize restoring removed capabilities.

> **Instruction to Codex:** Implement this specification against the actual checkout. Begin with a focused repository and design-asset inspection, then implement and test the work in the sequence below. Do not stop at another analysis, mockup board, or list of recommendations. Preserve existing valid functionality and unrelated user changes. Report only changes and verification that actually occurred.

---

## 0. Read this first: execution contract

### 0.1 Product outcome

Lovelies helps people find the people in their photographs, see exactly which photographs matched which registered users, choose what each person receives, and deliver only the approved photographs.

The essential contributor journey is:

**Open the dark masonry gallery → inspect a photograph → see matched recipients → exclude photographs or people → review each recipient's actual subset → share → see the confirmed result.**

The essential recipient journey is:

**Sign in → establish one account-level face profile → receive approved matched photographs → browse → inspect → save or share where authorized.**

The app should combine the image-led browsing associated with Pinterest, the direct manipulation of Apple Photos, the person-based discovery of Google Photos, and the sharing clarity of messaging apps, while retaining Lovelies' own identity.

### 0.2 Source-of-truth hierarchy

When sources disagree, apply this order:

1. The user's explicit product requirements, consolidated in this document.
2. Required platform behavior and existing authoritative security, consent, access, and entitlement contracts.
3. The actual repository implementation and tests, reconciled against those requirements.
4. This document's proposed component, motion, and performance specifications.
5. The generated concept screens as visual references only.
6. Reference apps as inspiration, not specifications to copy wholesale.

Do not preserve a security defect merely because it is in the current code. Equally, do not silently remove an existing product entitlement or privacy boundary because a mockup omits it. Where requirements require an authorization change, implement the change deliberately with migrations, tests, and a rollout plan.

### 0.3 Non-negotiable requirements

- [ ] Keep **Lovelies** branding and reuse the supplied logo and photo-heart asset.
- [ ] Keep a **dark, tightly spaced masonry gallery** with mixed photograph proportions, consistent rounded corners, and imagery as the dominant content.
- [ ] Keep the interface **icon-first**, but preserve necessary names, explanations, permissions, consequences, and actionable errors.
- [ ] Provide separate **matched photographs** and **matched people** views.
- [ ] Provide both **photo → people** and **person → photos** navigation.
- [ ] Let the user exclude a photograph from the entire current share.
- [ ] Let the user exclude a recipient from the entire current share.
- [ ] Let the user exclude an individual photo–recipient pair without unnecessarily removing that photograph for everyone else.
- [ ] Make recipient subsets and counts correct everywhere.
- [ ] Enforce approval-before-share on the server, not just through UI checkboxes.
- [ ] Keep face enrollment account-level; no enrollment for each occasion.
- [ ] Keep full, limited/selected, and denied photo-access paths understandable and recoverable.
- [ ] Preserve selections, navigation context, and transfer state through supported interruptions.
- [ ] Build real interfaces and working state transitions, not screenshots presented as functional UI.

### 0.4 Do not introduce these features or claims

Do not add events, group membership, shared spaces, public social feeds, comments, mentions, streaks, generative photo editing, video recognition, a public face directory, or unrelated payment flows merely because they appear in reference apps or earlier generated screens.

Do not add liveness/PAD, blink/head-turn challenges, camera-injection qualification, identity-document verification, or an extra identity-verification journey. Backend face authentication follows the owner amendments above. Existing pose guidance for the one-time photo profile is enrollment guidance only.

Do not claim:

- That device-library discovery runs continuously while the app is closed.
- That all processing happens on-device unless the complete relevant path genuinely does.
- That matching confidence is proof of identity.
- That a request being accepted means recipient delivery or viewing has completed.
- That blocking or revocation erases downloaded, forwarded, or otherwise retained copies.
- That a source image without a usable face is an automatic face match.
- That generated screenshot text is approved privacy policy, operating-system copy, or verified product behavior.

### 0.5 Implementation authority and safe working rules

1. Read the repository's `AGENTS.md` and applicable nested instructions before editing.
2. Inspect the worktree and preserve unrelated changes. Do not reset, clean, or overwrite user work.
3. Use the existing architecture, routing, state, localization, and test conventions where they are suitable. Refactor specific weaknesses; do not create parallel application systems without a reason.
4. Reuse existing service APIs where they support the required contract. Extend them deliberately when they do not.
5. Do not fabricate repository paths, endpoints, database fields, passing tests, production state, or performance measurements.
6. Do not expose tokens, signed media URLs, biometric data, user photographs, recipient identities, or service credentials in logs or reports.
7. Draft and test migrations locally. Do not apply destructive production changes, delete production data, change external access, publish a release, or incur paid external work without explicit authorization.
8. Do not perform a blanket dependency upgrade. Inspect the lockfile, SDK constraints, platform integration, native compatibility, and test impact first.
9. Continue work that can be completed locally when an external dependency blocks another task. Identify the precise blocked task, evidence, and required next action.
10. A mocked provider or synthetic fixture is useful for development, but never report it as a verified live integration.

### 0.6 Definition of done

Completion means that the important journeys are clear, responsive, accessible, recoverable, and authorized correctly. A count of screens or a successful build is insufficient.

A completed phase requires:

- Implemented code and relevant tests.
- Verified functional state transitions and error handling.
- Visual comparison against the approved dark Lovelies direction.
- Evidence of the applicable accessibility and performance checks.
- Honest documentation of any environment-dependent checks not yet run.

---

## 1. Evidence, existing architecture, and preflight inspection

### 1.1 What the preceding research actually inspected

The preceding report read the repository's `ARCHITECTURE.md` and `apps/user_flutter/pubspec.yaml`. It did not establish that every architectural statement matches deployed behavior, and it did not constitute a full source-code, security, or runtime audit.

The reported architecture includes:

- A Flutter mobile application at `apps/user_flutter`.
- A Cloudflare Worker API, private R2 media storage, and queued processing.
- Supabase Postgres, row-level security, Realtime, and matching-related data.
- Local photo-profile preparation, with derived profile data synchronized to the backend.
- A separate authorized contribution-processing path.
- Existing native subscription/entitlement behavior governing certain download and sharing actions.

The reported manifest already includes dependencies for masonry, image caching, camera, photo-library access, permissions, secure storage, file selection, sharing, background work, notifications, app links, local inference, and integration tests. It also contains Inter typography assets.

**These are starting points to verify, not authority to assume live readiness.** [R01] [R02]

### 1.2 Known alignment issues to investigate

| Issue | Required investigation and response |
|---|---|
| Some generated screens imply one selfie; architecture describes three poses. | Inspect the current capture and model contract. Retain the existing one-time three-pose setup where that contract requires it; do not add challenge-based liveness or casually replace it without recognition-quality evidence. |
| Architecture describes high-confidence matches creating gallery records. | Determine when recipient access actually becomes available. For contributor-originated photos governed by review-before-share, proposed matches must not expose media before approval. |
| Some screens imply all photographs are visible to every selected person. | Implement authoritative photo–recipient subsets and consistent previews. |
| Some concepts include comments, mentions, videos, social metrics, and event-like constructs. | Treat these as concept artifacts, not approved scope. Do not add them. Preserve unrelated existing features outside this change unless separately authorized. |
| Some mockups contain invented platform permission options or privacy text. | Use real platform APIs and accurate app-owned explanations. Do not emulate an operating-system permission dialog. |
| Some concepts imply unlimited free saving/sharing. | Reconcile the existing entitlement contract before exposing those actions. Do not redesign commercial policy as a side effect. |
| Some concepts show recipient portraits in face-profile management. | Keep the user's own enrollment profile separate from their matched-recipient list. Do not turn enrollment into a multi-person identity registry UI. |

### 1.3 Required repository preflight

- [ ] Read `AGENTS.md`, actual architecture documents, package manifest, lockfile, and build configuration.
- [ ] Run `git status --short` and record the current base revision without including secrets.
- [ ] Locate the current gallery, viewer, match results, people review, share preview, upload, face setup, profile, and settings implementations.
- [ ] Trace routing, back navigation, tab-state retention, and deep-link handling.
- [ ] Trace image URLs, dimensions, rendition generation, decoding, cache keys, and authorization.
- [ ] Trace how match candidates become recipient-visible media and where approval is enforced.
- [ ] Trace transfer persistence, retries, permission changes, account changes, and app lifecycle events.
- [ ] Inspect accessibility semantics, localization, theme tokens, and existing tests.
- [ ] Verify actual Flutter/Dart versions, target SDKs, native build toolchains, and platform support.
- [ ] Check the official platform references before implementing version-dependent behavior. Do not assume that an API available in UIKit, SwiftUI, or Compose exists in the current Flutter stack.
- [ ] Record a focused gap map with actual file paths and test locations.

### 1.4 Visual assets and handoff references

The latest prior Canva handoff is **Lovelies — 48 Individual App Screens · Dark Masonry UI**:

- Design ID: `DAHX1q1Ibhc`.
- Previously returned edit link: <https://www.canva.com/d/k7Y8JxlASGFYz2n>.
- Previously returned view link: <https://www.canva.com/d/diDb4lFWneu4ob2>.
- Individual-screen archive: `Lovelies-48-Screen-PNGs.zip`.
- Screen deck: `Lovelies-48-Individual-Screens.pptx`.
- Supplied wordmark filename: `ChatGPT Image Oct 12, 2026, 11_43_45 PM.png`.
- Supplied photo-heart asset filename: `Screenshot 2026-10-12 at 23.42.13.png`.

These links and filenames are carried forward from the conversation; access and local availability must be checked in the implementation environment. Do not assume the chat sandbox is mounted in Codex.

The Canva pages contain individual screenshot images, not editable native UI component trees. Use them as visual references. Reuse the actual supplied logo rather than recreating it using an approximate script font. Do not silently replace the dark gallery with the earlier pastel/light concept.

---

## 2. Leading-app benchmark and what Lovelies will borrow

This is selective pattern transfer, not a proposal to clone every product. The prior research relied on official product guidance and engineering sources where available. Mobbin's paid screen library was inaccessible; no exhaustive screen-by-screen inspection of every current app is claimed.

| Reference app | Relevant pattern or published lesson | Lovelies implementation | Do not borrow |
|---|---|---|---|
| **Apple Photos** | Adjustable library density, direct photo manipulation, browsing context. [S01] [S02] | Pinch-adjustable density, full-image inspection, stable return to the originating asset and scroll context. | Unnecessary complexity or a second unrelated organization system. |
| **Google Photos** | Person-based collections, photo-group correction, account-private face labels. [S03] | Photo → eligible people, person → matched photos, incorrect-match correction. | Treating a private face label as an authoritative cross-account identity or public directory. |
| **Pinterest** | Image-led browsing direction; historical engineering work on caching, prioritization, progressive loading, and background decoding. [S04] | The requested tightly spaced masonry, stable thumbnail geometry, bounded prioritized prefetching. | An engagement feed, advertisements, or claims that the historical engineering article describes the exact 2026 implementation. |
| **Instagram / Meta** | Journey-specific performance measurement: startup, media rendering, scrolling, and navigation. [S05] | Measure gallery, viewer, selection, transfer, and return navigation separately. | Assuming native Android optimization results transfer directly to Flutter; likes/comments/social-feed scope. |
| **WhatsApp** | Understandable recipients, delivery distinctions, blocking/reporting, limitations of recalling shared copies. [S06] | Clear recipient subsets and access states, truthful revocation, explicit correction/reporting actions. | Equating submitted, delivered, downloaded, and viewed; messaging functionality not already in scope. |
| **Telegram** | 2026 material treatment with effects reduction controls for performance and energy use. [S07] | Restrained materials and a reduced-effects path on constrained devices. | Continuous expensive effects as a condition of using the app. |
| **Airbnb** | Coherent dimensionality and animation within a product design system. [S08] | Coordinated sheet hierarchy, short responsive transitions, occasional controlled brand moments. | Decorative card stacks and animations that compete with photographs. |
| **Spotify** | Compact persistent state that expands into detail. [S09] | A compact transfer/processing tray that expands without losing browsing context. | Playback features or an always-present tray when nothing is happening. |
| **Lightroom mobile** | Photography-focused direct manipulation and gesture-assisted navigation. [S10] | Zoom, pan, inspect, swipe, and dismiss with visible alternatives. | Adding an editing suite merely because Lightroom is a reference. |
| **Duolingo** | Deliberate investment in product animation. [S11] | Brief non-blocking celebration for the first meaningful completed share. | Streaks, coercive engagement, constant confetti, or interruptions after every action. |

The implementation must be judged as a coherent Lovelies experience, not by the number of borrowed patterns.

---

## 3. 2026 platform principles translated into implementation

### 3.1 Native behavior, not superficial imitation

Use current platform guidance for navigation, safe areas, keyboard behavior, camera interruptions, permissions, sharing, accessibility, lifecycle handling, and system settings. Preserve Lovelies identity while adopting appropriate platform behavior. Recheck release-specific guidance during preflight. [S12]

### 3.2 Materials are a control layer

Apple positions Liquid Glass as a functional layer for controls/navigation rather than the content itself. [S13]

Implement:

- Subtle material treatment for selected navigation, contextual docks, and occasional sheets.
- Solid or low-cost translucent fallback surfaces.
- Legible controls over changing photograph backgrounds.

Do not implement:

- Glass borders around every image.
- A continuously blurred masonry background.
- A pink tint or gradient wash over ordinary photo content.
- An expensive full-screen blur merely to display a small action menu.

### 3.3 Motion is interruptible

Use the relevant Material motion principles as behavior guidance, not a requirement to make every element bounce. Transitions should remain coherent when a gesture changes direction or a user quickly performs another action. [S14]

### 3.4 Layout is window-based

The preceding research identified Android 17/API 37 behavior affecting orientation, resizability, and aspect-ratio restrictions on large displays. Validate actual target-SDK requirements and applicable exceptions before release. [S15]

Implement responsive behavior around available constraints and insets rather than device model names or a fixed portrait canvas. Do not use a target-SDK setting as a substitute for a working adaptive layout.

---

## 4. Locked visual and interaction design system

### 4.1 Initial design tokens

The values below are proposed implementation tokens. Match the supplied branding, test contrast, and consolidate them with the existing theme instead of duplicating theme systems.

| Token / role | Initial specification |
|---|---|
| `color.canvas` | Near-black `#0B0B0F`. |
| `color.surface` | Charcoal `#17171E`. |
| `color.surfaceRaised` | Charcoal `#24242D`. |
| `color.accentPrimary` | Lovelies pink, approximately `#FF8FB1`. |
| `color.accentSecondary` | Lavender, approximately `#B69AF6`. |
| Supporting colors | Soft blush and cream for restrained branding; not gallery backgrounds. |
| Primary text | Near-white with verified contrast. |
| Secondary text | A deliberate, tested neutral; not arbitrary low-opacity white. |
| Primary action foreground | Dark foreground on pink where contrast testing confirms it. |
| Semantic success/warning/error | Distinct status treatments using icons and text where needed; do not make pink mean every state. |
| Typography | Supplied script wordmark for branding; existing Inter family for interface copy. |
| Gallery gap | Approximately 4 logical pixels. |
| Gallery side inset | Approximately 8 logical pixels, adjusted for safe areas. |
| Tile corner radius | Approximately 10–12 logical pixels. |
| Primary touch target | Aim for at least 48 × 48 logical units with non-overlapping hit areas. |
| Motion variants | Normal, reduced motion, reduced transparency/effects. |

Use a small shared spacing scale and explicit component variants. Avoid one-off padding, color, or radius values scattered throughout feature screens.

### 4.2 Gallery contract

- [ ] Use masonry with portrait, landscape, and square proportions.
- [ ] Read dimensions before laying out thumbnails.
- [ ] Bound extreme panorama/tall-preview geometry without hiding access to the full image.
- [ ] Keep ordinary browsing free of permanent captions and recipient rows under every photo.
- [ ] Show recipient avatars and match counts when they are relevant to matching/review.
- [ ] Use consistent photo corners and tight gutters.
- [ ] Do not wrap every photograph in another card.
- [ ] Preserve a stable order and anchor while the user is interacting.
- [ ] Offer a quiet new-content control rather than reshuffling visible content on every match arrival.
- [ ] Keep existing images visible during pagination or refresh failures.
- [ ] Keep selection controls from obscuring important photo content unnecessarily.

### 4.3 Icon-first, not icon-only

Icon-only controls are suitable for familiar actions such as back, close, search, favorite, and overflow, with accessible names.

Keep concise visible text for:

- Recipient identity and per-recipient photo counts.
- Permission requests and processing consent.
- Final sharing totals and consequential confirmation.
- Deletion, revocation, blocking, and other materially different actions.
- Failures and recovery actions.
- Unfamiliar settings where an icon alone is ambiguous.

Use real labels rather than the gray placeholder bars present in some generated concepts. Do not replace proper icons with arbitrary Unicode symbols or emoji.

Suggested concise copy:

- `8 photos · 3 people`
- `Share`
- `Retry 2`
- `Stop sharing`
- `No photos selected`
- `Review new matches`

A paper-plane icon alone must not silently send photographs to an unclear audience.

### 4.4 Photograph fidelity

Do not tint photos to make them conform to branding. Preserve orientation, useful detail, and appropriate color handling. Keep frame decoration subordinate to media.

For the viewer, make the complete image accessible. Distinguish preview cropping from modification of the stored original.

---

## 5. Information architecture and navigation

### 5.1 Four persistent destinations

| Destination | Responsibility |
|---|---|
| **Photos** | Personal library, saved/favorite views, search, viewer, and available media actions. |
| **Matches** | Photos received through matching and outgoing match-review work, clearly distinguished; photo ↔ people exploration. |
| **Activity** | Transfer, processing, approval, and sharing updates with actionable outcomes. |
| **You** | Profile, own face profile, privacy, permissions, notifications, account, storage, and help. |

Use `Add photos` as a contextual action, not a fifth unrelated destination. Expose upload history/progress through the relevant action and Activity. Preserve existing routing where possible while converging on one consistent navigation model.

### 5.2 Distinguish incoming and outgoing matches

`Received` means media the current user is authorized to access as a recipient.

`To review` means media under the contributor's control with proposed recipients that may not yet have access.

Do not mix these into an ambiguous `New matches` feed. A count must identify its meaning: photos, people, proposed pairs, or completed deliveries.

### 5.3 Back, deep links, and state restoration

- [ ] Use platform-appropriate back behavior and route transitions.
- [ ] Preserve independent tab context where appropriate.
- [ ] Restore the correct gallery asset and position after viewing.
- [ ] Handle a deep link through sign-in and return to the intended authorized content.
- [ ] Revalidate entitlement and access after resuming or opening a deep link.
- [ ] Provide clear fallback behavior when a referenced photo or recipient no longer exists or is unavailable.
- [ ] Avoid intercepting system-edge back gestures with gallery or viewer gestures.
- [ ] Integrate Android predictive back using APIs supported by the actual Flutter/navigation version. [S17]

---

## 6. End-to-end journey and state requirements

### 6.1 Authentication

Implement initial sign-in, provider cancellation, invalid/expired code, resend cooldown, recoverable network failure, session expiry, and return to an interrupted task.

Preserve the actual repository authentication contract. Do not add unused identity providers merely because a concept screen displays their logos.

### 6.2 One-time face setup

The app must clearly distinguish profile-avatar editing from matching-profile enrollment.

Required states:

- Introductory explanation and explicit biometric/face-profile choice.
- Camera permission not yet requested, granted, denied, or revoked.
- Camera initialization and interruption recovery.
- No face, multiple faces, unusable lighting/blur, and valid capture.
- Review and retake.
- Local profile preparation.
- Derived-data synchronization pending, failed/retryable, and confirmed active.
- Existing active/pending profile reuse where supported.
- Replace, pause, resume, remove, and deletion-status views.

Do not display `Ready` solely because local capture completed if activation still depends on successful synchronization. Do not offer `Use this anyway` for a capture rejected by a mandatory quality/model requirement.

Inspect the current three-pose enrollment contract. Keep it one-time and user-initiated where required. Do not add liveness, identity-document checks, or event-specific enrollment. [R01]

### 6.3 Device photo access and contribution processing

Keep these four decisions separate:

1. **Device permission** to read selected or all eligible photographs.
2. **Face-profile consent** for the user's own matching profile.
3. **Processing authorization** for selected contributor photographs, including a clear explanation if they leave the device.
4. **Recipient sharing approval** for the proposed photo–recipient relationships.

A grant of full photo-library access does not authorize upload of the entire library or distribution to everyone detected.

Implement a useful selected-photo path using real platform capabilities. Do not present `Selected Albums` as an operating-system permission category unless the actual platform supplies it. An app-owned album filter is different from an OS permission grant. [S18] [S19] [S20]

Handle cloud-only assets, permission changes, limited-library additions/removals, revoked access, unavailable assets, and return from Settings. Recheck access on resume and before relevant operations.

Optional automatic/incremental discovery must be separately enabled and accurately described. Never imply uninterrupted background scanning.

### 6.4 Contributor review and sharing

The workflow must remain usable in either direction:

- Start with a photo and inspect its proposed recipients.
- Start with a person and inspect the photos proposed for that recipient.

Selections and exclusions must remain synchronized. Moving between views, changing sort/filter, rotating, suspending, or recovering from a network interruption must not silently alter the draft.

A contributor must be able to leave an unshared draft. New matches arriving later must not silently expand a previously approved audience or retroactively modify a confirmed share manifest.

### 6.5 Recipient use

Show received photographs only under current authorization. Provide inspect, favorite, save, report incorrect match, and share actions according to the applicable access/entitlement contract.

A received photo may contain other people. Do not expose all detected identities to a recipient simply because the contributor can review proposed recipients. Every identity disclosure needs an authorized product path.

### 6.6 Privacy, account, and entitlements

Keep these actions distinct:

| Action | Intended meaning |
|---|---|
| Hide from my library | Remove from the current user's view according to the established product policy. |
| Exclude this photo | Do not send this photo in the current draft. |
| Exclude this recipient | Do not send to this person in the current draft. |
| Exclude this pair | Do not send this specific photo to this specific person in the current draft. |
| Block this person/source | Apply the defined durable policy; explain scope and effect. |
| Stop sharing | Revoke future application access where enforceable; do not promise to recall retained copies. |
| Delete my upload/original | A separate destructive operation with explicit scope and confirmation. |
| Remove face profile | Stop future matching and perform the defined deletion process. |
| Delete account | A separate account-level deletion workflow with authorization and truthful status. |

Where existing paid entitlements remain in scope, implement entitlement loading, purchase pending, cancellation, verification failure, restore, expiration, and interrupted-action recovery. Do not add an external digital checkout or change commercial policy as part of visual polish.

---

## 7. Authoritative many-to-many sharing contract

### 7.1 Required data meaning

The following names are conceptual. Map them onto the actual schema and service conventions; do not create duplicate tables or endpoints because these names appear here.

- **Asset:** a contributor-controlled photograph with identity, version, and authorization.
- **Match candidate:** a proposed relationship between an asset and an eligible registered profile.
- **Draft:** the user's current selections and exclusions.
- **Pair decision:** inclusion/exclusion of one asset–recipient relationship.
- **Manifest:** a versioned, reviewable set of requested asset–recipient deliveries.
- **Grant/delivery record:** authoritative access created after successful validation and the required approval.

A match candidate is not an access grant.

### 7.2 Effective delivery rule

For every proposed pair `(asset, recipient)`:

```text
include_pair =
    asset_is_selected
    AND recipient_is_selected
    AND pair_is_included
    AND match_is_eligible
    AND contributor_can_share_asset
    AND recipient_is_currently_eligible
    AND no_applicable_block_or_revocation
    AND required_consent_is_current
    AND required_entitlement_is_current
```

The server recomputes the authoritative conditions. It must not trust client-supplied object keys, recipient authority, or match scores.

Never construct a Cartesian product of selected photos and selected people.

### 7.3 Worked acceptance fixture

Initial proposed matches:

| Photo | Proposed recipients |
|---|---|
| `P1` | Aline |
| `P2` | Aline, Eric |
| `P3` | Eric |
| `P4` | Aline, Eric |

The contributor excludes `P3` globally and excludes the pair `P4 → Eric`.

Expected result:

- Aline receives `P1`, `P2`, `P4`.
- Eric receives `P2` only.
- Unique photo count: **3**.
- Recipient count: **2**.
- Delivery-pair count: **4**.

If Eric is then excluded globally, Aline's three selected eligible photos are unchanged; recipient count becomes **1** and delivery-pair count becomes **3**.

If Aline is subsequently excluded as well, there are no deliveries. The Share action is unavailable, and the interface explains that nothing is selected for delivery.

### 7.4 Preview invariants

- [ ] Global photo deselection suppresses every delivery for that photo.
- [ ] Global recipient deselection suppresses every delivery to that recipient.
- [ ] Pair exclusion affects that pair only.
- [ ] Re-enabling a global selection does not silently erase a previous pair exclusion.
- [ ] A recipient with zero effective photos is not counted as receiving media.
- [ ] A photo with zero effective recipients is not counted as being shared.
- [ ] Every displayed count is derived from the same effective-pair calculation.
- [ ] Filtering hides items; it does not silently deselect them.
- [ ] `Select all` states its scope: visible results, filtered set, current page, or entire batch.
- [ ] Excluding a person as a recipient does not remove that person's appearance from photos sent to others.
- [ ] New matches do not silently expand an approved manifest.

### 7.5 Submission, versioning, and idempotency

1. Build a local draft and persist its meaningful decisions under the current account and batch.
2. Request or construct a server-validatable preview tied to the relevant asset/match versions.
3. Display unique photos, actual recipients, and each recipient's actual subset.
4. On explicit Share, submit the precise manifest with an idempotency key tied to the draft version.
5. Revalidate ownership, eligibility, consent, blocks, entitlement, and asset state on the server at grant time.
6. If the request materially differs from the reviewed preview, return a structured result. Newly added recipients/photos require renewed review; removals or failures must be reported accurately.
7. Persist authoritative outcome records before showing completion.
8. A retry of the same request returns the same logical outcome rather than creating duplicate grants.
9. Partial outcomes identify the succeeded and failed pairs; retry unfinished work only.
10. Revalidate authorization for subsequent access to originals and renditions.

For ambiguous timeouts, reconcile by operation identity before resubmitting. Do not assume that the server did nothing just because the client did not receive a response.

### 7.6 Enforcement review

Inspect the full path from processing to match creation to recipient-gallery access. For contributor media governed by this brief, fix any path that exposes thumbnails, originals, notifications containing private media, or downloadable URLs before approval.

This requirement is motivated by the architecture's described matching/gallery flow; it is not a claim that an exploitable production defect has already been demonstrated. [R01]

Preserve any valid, separately authorized legacy/import workflow and document the distinction. Do not retroactively delete historical grants or alter existing users' access through an unreviewed migration.

---

## 8. Motion and transition specification

### 8.1 Shared motion tokens

These values are Lovelies starting targets, not measured timings from reference apps. Tune springs by responsiveness and settling behavior. Do not add fixed delays to make fast operations last as long as an animation.

| Interaction | Proposed behavior | Initial duration / settling |
|---|---|---|
| Button press | Immediate state response; approximately 98% scale where appropriate. | 80–120ms |
| Photo selection | Checkmark/border resolve, count updates immediately. | 120–180ms |
| Favorite | Restrained fill/scale response. | 150–220ms |
| Ordinary route change | Short, directionally coherent transition. | 200–280ms |
| Gallery → viewer | The selected thumbnail expands from its actual bounds. | Approximately 280–360ms settling |
| Viewer → gallery | Reverse to the correct asset; finger-driven when dismissing. | Gesture-driven, then short settling |
| Bottom sheet | Controlled, reversible spring. | Approximately 250–350ms settling |
| Image refinement | Existing preview resolves to a sharper rendition without layout changes. | 100–150ms; immediate for cached assets |
| New-content control | Small badge/notice transition. | 150–220ms |
| First confirmed share | Brief, non-blocking checkmark/brand-heart response. | 350–500ms |

### 8.2 Context-preserving photo transitions

- [ ] Start with the actual displayed thumbnail rather than a blank viewer.
- [ ] Keep image identity and aspect-ratio treatment coherent through the transition.
- [ ] Closing after swiping in the viewer targets the currently viewed asset, not the initially opened one.
- [ ] Preserve the gallery anchor and sensible scroll position.
- [ ] Use a quiet fallback dissolve when the return tile is absent or unavailable.
- [ ] Interactive dismissal follows the finger and reverses cleanly if canceled.
- [ ] Avoid queuing repeated animations behind rapid taps.
- [ ] Prevent a duplicate action from creating duplicate operations while still providing immediate feedback.

### 8.3 Restraint rules

Do not implement mandatory multi-second splashes, perpetual hearts behind the gallery, entrance cascades on every scroll, full-screen favorite animations, or confetti after each checkbox.

During review, deselected photos remain in position with a clear subdued state. Do not immediately remove them and cause the masonry to move beneath the user's finger.

Use fewer strong motion motifs across the whole app rather than a different animation style on every screen.

### 8.4 Reduced motion and effects

Observe platform reduced-motion, animation, transparency, and related settings where available. Provide a deterministic low-effects behavior when the integration cannot expose every native preference. [S16]

With reduced motion:

- Replace large spatial zoom/depth effects with a short dissolve or immediate change.
- Remove spinning, parallax, and decorative particle motion that is not required to understand state.
- Preserve understandable loading, selection, success, and failure feedback.
- Do not disable the underlying functionality.

Stop decorative animation when off-screen, backgrounded, or otherwise not useful. Offer solid-surface alternatives to expensive blur.

---

## 9. Touch, gestures, haptics, and feedback

### 9.1 Gesture contract

| Gesture | Action |
|---|---|
| Tap gallery thumbnail | Open photograph. |
| Tap fitted photograph in viewer | Toggle chrome visibility. |
| Horizontal viewer swipe | Previous/next photograph when not being panned at inspection zoom. |
| Pinch viewer | Zoom around the gesture focal point. |
| Double tap viewer | Toggle fitted/inspection zoom. |
| Drag while zoomed | Pan the photograph. |
| Downward drag at fitted scale | Dismiss where compatible with platform navigation and gesture arbitration. |
| Long press | Contextual actions, also available through overflow. |
| Pinch gallery | Change density while preserving the anchor photograph. |

Double tap means **zoom**, not like. A photo-inspection app should not sacrifice an important inspection gesture for a social-feed convention. [S01] [S02] [S10]

Define gesture arbitration explicitly. Camera, viewer, masonry, bottom sheets, and system back must not compete unpredictably. Essential actions always have an accessible visible alternative.

### 9.2 Haptics

Use a small action-oriented vocabulary, following device capabilities and user settings. [S21]

- Light selection response for meaningful selection changes.
- Distinct success response for an important confirmed completion.
- Restrained warning/error response when appropriate.

No haptics for every scrolling item, progress tick, or background match. Coalesce repeated multi-selection feedback rather than generating a stream of vibration.

### 9.3 Feedback and truthfulness

| Operation | Required feedback |
|---|---|
| Upload | Real per-file/byte progress where known; separate upload from subsequent processing. |
| Matching | Actual completed-photo counts or an honest indeterminate state. |
| Sharing | Distinguish validation/request acceptance from actual recipient access. |
| Saving | Confirm only after the relevant device write succeeds. |
| Viewing | Display viewed status only if an authorized, real receipt exists. |
| Retryable failure | Keep selection/context and show a targeted retry action. |
| Partial completion | State what succeeded, what failed, and what retry will do. |
| Permission loss | Explain the unavailable operation and recovery without deleting the draft. |

Favourites may update optimistically with rollback. Access grants, deletion completion, and successful downloads need authoritative confirmation.

Do not hide important sharing failures in a disappearing toast. Use inline persistent feedback, a transfer row, or a recoverable sheet appropriate to the action.

### 9.4 Sound and distraction

Do not add sound feedback by default. Premium responsiveness should primarily come from precise visuals, useful haptics, and correct state. Do not interrupt browsing with celebration or repeated notification prompts.

---

## 10. Media pipeline and gallery performance

### 10.1 Virtualization and stable geometry

- [ ] Construct only visible tiles and a bounded adjacent region.
- [ ] Avoid eagerly building thousands of widgets or nested unbounded scroll regions.
- [ ] Obtain dimensions and orientation metadata before thumbnail layout.
- [ ] Key tiles by stable asset identity/version, not list index.
- [ ] Preserve visual geometry when a higher-quality rendition replaces a placeholder.
- [ ] Localize selection updates; one checkbox must not rebuild the whole gallery.
- [ ] Avoid unnecessary intrinsic layout, save layers, large opacity layers, and repeated blur.
- [ ] Cancel or deprioritize obsolete prefetches when scroll direction or destination changes.
- [ ] Start with approximately one to two nearby viewports of prefetching and tune from physical-device traces.

Use Flutter's performance guidance and the historical Pinterest image-pipeline lessons as engineering references. [S04] [S22]

### 10.2 Rendition strategy

Begin with suitable image renditions around **256, 512, 1024, and 2048 pixels on the long edge**, adjusted to the existing service pipeline and actual media requirements.

Select based on:

- Displayed logical size and device pixel ratio.
- Aspect ratio and crop strategy.
- Whether the view is a tile, preview, fitted viewer, or inspection zoom.
- Network, memory, and current task priority.

The gallery does not fetch full originals by default. The viewer begins with a usable rendition; authorized originals are fetched for saving or deeper inspection where necessary.

A 12-megapixel image decoded at four bytes per pixel requires roughly **48MB before additional overhead**. Compressed file size is not the decoded-memory cost. Set decode bounds deliberately.

### 10.3 Cache contract

- [ ] Separate bounded memory caching from disk caching.
- [ ] Include account/authorization scope, asset identity/version, and rendition in cache identity.
- [ ] Do not use the full expiring signed URL as the sole stable asset identity.
- [ ] Avoid duplicate cached copies caused solely by token rotation.
- [ ] Do not allow cache reuse to bypass access changes or account isolation.
- [ ] Reconcile cache retention/expiry with the approved privacy and offline policy.
- [ ] Clear appropriate account-scoped state on sign-out or account change.
- [ ] Respond to memory pressure by reducing speculative work and nonessential decoded images.

### 10.4 Image correctness

Test:

- EXIF orientation, mirrored images, and rotations.
- HEIC/HEIF and supported JPEG/PNG paths.
- Very large photographs and extreme aspect ratios.
- Cloud-only source retrieval and unavailable originals.
- Color profiles and mixed SDR/HDR media.
- Thumbnail-to-viewer-to-save consistency.

Apple's HDR guidance notes the visual imbalance that unrestricted HDR thumbnails can create in a mixed gallery. Keep gallery brightness coherent, preserve source quality, and enable richer viewer rendering only through a verified pipeline with a correct fallback. Do not claim full HDR preservation simply because the device has an HDR screen. [S23]

### 10.5 Background computation

Hashing, large decoding/resizing, and applicable local inference must not block the UI isolate. Use the existing architecture's appropriate isolates/native execution and measure the result.

Respect plugin threading constraints. Moving a function to an isolate is not evidence that an underlying native plugin supports that call pattern.

---

## 11. Adaptive layout, accessibility, and localization

### 11.1 Window-based layouts

| Available space | Required behavior |
|---|---|
| Compact phone | Two or three columns according to usable width, minimum tile size, and accessibility preferences. |
| Typical phone | Three columns by default with user-adjustable density. |
| Wide phone / landscape | More usable columns; safe-area-aware controls and no fixed portrait assumptions. |
| Tablet / unfolded device | Wider masonry and, where helpful, a side-by-side viewer or recipient inspector. |
| Split-window | Recompute from actual window constraints while preserving state. |
| Large text / display scaling | Reflow essential labels and simplify crowded arrangements; never shrink everything to fit. |

Use constraint-based layout and actual insets. Do not hardcode design-board dimensions as runtime screen dimensions. Test camera preview geometry after rotation/resizing. [S15]

### 11.2 Accessible icon-first UI

- [ ] Meaningful VoiceOver/TalkBack descriptions for every control.
- [ ] Clear selected/unselected, enabled/disabled, progress, and error semantics.
- [ ] Approximately 48 × 48 logical-unit targets for primary controls; no overlapping enlarged hit areas.
- [ ] Adequate contrast for text, icons, selected states, and disabled explanations.
- [ ] Selection is indicated by more than color.
- [ ] Essential gestures have visible alternatives.
- [ ] Focus order remains sensible in masonry and two-pane layouts.
- [ ] Screen-reader users can inspect recipients and alter pair decisions.
- [ ] New batch results do not cause an announcement storm or repeatedly steal focus.
- [ ] Closing a sheet/viewer restores focus sensibly.
- [ ] Large text does not truncate consequential names, actions, errors, or confirmations.
- [ ] Reduced motion/transparency preserve functionality.

A photograph's semantic description should use useful available metadata and state, for example: `Selected photo, matched to two people`. Do not claim to identify an unverified person in a generated accessibility description. [S24]

### 11.3 Localization and input

Use the repository's localization system with correct pluralization. Remove hardcoded English from modified screens. Validate English, Kinyarwanda, and other configured locales; use longer-string and bidirectional tests where applicable to the supported locale set.

Names, dates, counts, filenames, errors, and transfer units must not depend on fixed English widths. Keep the UI usable with a hardware keyboard/pointer on supported larger devices without compromising touch behavior.

---

## 12. Transfers, background work, offline behavior, and energy

### 12.1 Separate device discovery from server matching

Server-side processing may continue after an authorized upload has reached the service. Reading new photographs from the phone while the app is not active is subject to operating-system permission, lifecycle, scheduling, and force-quit constraints.

Do not describe these as one continuous background guarantee. Android distinguishes deferrable work from user-initiated transfers; Apple background URLSession behavior has important lifecycle limitations. Verify integration against the actual supported OS and plugins. [S25] [S26]

### 12.2 Durable transfer queue

Persist the minimum necessary operation metadata under the correct account. Model at least:

```text
queued
→ preparing
→ transferring
→ transfer_complete
→ processing / awaiting_review / completed   (depending on operation type)
```

Supported branches include:

```text
paused_by_user
waiting_for_network
permission_required
retryable_failure
non_retryable_failure
cancellation_requested
cancelled
```

The names are illustrative; map them to the actual system. Do not conflate uploading, matching, and sharing.

Required behavior:

- [ ] Durable operation identity and per-file state.
- [ ] Actual progress where measurable.
- [ ] Safe retry with backoff and explicit permanent failures.
- [ ] Reconciliation after timeout or process restart.
- [ ] Cancellation semantics that explain what has already completed.
- [ ] Retry unfinished files/pairs only.
- [ ] No duplicate upload/grant caused by repeated taps or callbacks.
- [ ] Native background integration appropriate to the transfer type.
- [ ] Pending operations cannot execute under a different signed-in account.

### 12.3 Compact progress tray

Use a small persistent tray only while there is meaningful transfer/processing work. It expands into detailed progress and recovery without resetting the gallery. The Spotify reference is the compact-to-expanded interaction pattern, not a requirement to copy its appearance. [S09]

### 12.4 Offline behavior

- Keep eligible already-cached media useful under the approved local-cache policy.
- Persist draft choices, current asset context, filters, and recoverable form data.
- Show authoritative operations as pending/unavailable, never falsely completed.
- On reconnection, revalidate access, blocks, consent, and entitlement before sending.
- Reconcile operation identity before retrying ambiguous submissions.
- Never let a stale offline draft override a later block or revocation.
- Distinguish previously loaded preview availability from an original actually saved to the device.

### 12.5 Energy and constrained-device behavior

- Stop decorative motion and nonessential timers when backgrounded.
- Prefer incremental discovery/change tracking over full-library rescans on every launch.
- Avoid heavy inference/decoding competing unnecessarily with active browsing.
- Reduce speculative prefetching, blur, and nonessential effects under constrained conditions.
- Keep queue controls available; do not strand the user behind a spinner.
- Degrade decoration and speculative work before touch responsiveness or sharing correctness.

Expose user-initiated retry/pause controls and accurately describe any Wi-Fi/mobile-data policy. Do not force every transfer to wait for charging merely because some optional background work can be deferred.

---

## 13. Application architecture and component ownership

### 13.1 Keep Flutter, strengthen platform integration

Retain the current Flutter application unless an independently demonstrated issue justifies a different decision. Do not rewrite the entire app in separate SwiftUI and Kotlin applications solely to obtain the approved design.

Impeller can improve rendering predictability, but it does not solve expensive decoding, excessive rebuilds, authorization, or lifecycle problems. [S27]

A Flutter package's presence does not demonstrate that its integration is correct. Current UIKit/SwiftUI/Compose features must be evaluated against the actual Flutter stack before adoption.

### 13.2 Logical boundaries

Map these responsibilities onto existing modules. Names below are suggested ownership boundaries, not mandatory directories or new dependencies.

| Module responsibility | Owns |
|---|---|
| **Design system** | Theme tokens, shared controls, icons, surfaces, motion, semantics, accessibility variants. |
| **App shell/navigation** | Four destinations, nested routing, back gestures, deep links, tab/context restoration. |
| **Media presentation** | Masonry, image-rendition selection, caching coordination, viewer, zoom, image state. |
| **Match review** | Candidate relationships, selections, exclusions, counts, draft restoration. |
| **Sharing authority** | Versioned manifests, server validation, access grants, idempotency, revocation, history. |
| **Transfer engine** | Persistent queue, native background integration, progress, retry, cancellation. |
| **Platform adapters** | Camera, photo access, file picker, share sheet, haptics, notifications, lifecycle, secure storage. |
| **Observability** | Privacy-safe timings, outcomes, crash diagnostics, benchmark artifacts. |

### 13.3 Shared component inventory

Build or consolidate reusable components for:

- Gallery tile: loading, loaded, selected, deselected, unavailable, retryable failure.
- Masonry viewport: paging, anchor retention, density changes, refresh/new-content affordance.
- Photo viewer: fitted/zoomed state, chrome, gesture handling, return transition.
- Recipient avatar/chip: identity, availability, selected/excluded state, count.
- Recipient row: real name, effective-photo count, inclusion control.
- Pair-review surface: photos proposed for one recipient, per-pair decisions.
- Selection dock: scope-aware count, clear/review action, primary transition.
- Final share review: effective pairs, per-person subsets, changed-preview warning.
- Transfer tray and transfer item: actual progress, pause/retry, partial state.
- Empty/error/permission surface: concise explanation and relevant recovery.
- Consequential-action sheet: accurate action scope, consequence, confirm/cancel.

Keep feature screens composed from these primitives. Avoid a monolithic screen switch with duplicated styles and inline authorization logic.

### 13.4 Native compatibility gate

Audit Android 16KB page-size compatibility across all relevant native artifacts and transitive libraries, including the engine, inference runtime, image/camera integrations, and other native SDKs. Test rather than assuming a manifest declaration is sufficient. [S28]

---

## 14. Security, consent, identity visibility, and telemetry

### 14.1 Access boundaries

Authorize thumbnails and originals consistently. No client-side service credentials. Resolve storage keys from trusted server records. Prevent cross-account media/cache/draft leakage.

Handle deletion/revocation as real state transitions with auditable outcomes. Do not display completed deletion when the request is merely queued.

### 14.2 Explain the real processing path

The repository distinguishes local face-profile preparation from separate authorized contribution processing. UI explanations must follow the actual implemented path. Do not retain generated mockup language implying universal on-device processing if authorized cloud matching is involved. [R01]

### 14.3 Identity and recipient visibility

A face match is a candidate relationship, not proof of identity or a reason to expose a person's entire profile. Show only identities and details the current actor is authorized to see. Private face labels in a reference app do not define cross-account identity authority. [S03]

Uncertain matches must not be silently auto-delivered. Correction should update the relevant relationship and prevent unintended repeat delivery according to the established product policy.

### 14.4 Revocation and retained copies

Stop future authorized application access where enforceable. Be clear that a recipient may retain a previously downloaded or forwarded copy. Excluding a recipient from a draft is not the same as recalling earlier deliveries. [S06]

### 14.5 Observability without private content

Record useful technical events such as:

- Gallery first usable content and pagination timing.
- Viewer transition/frame timing.
- Decode/rendition requests and cache outcomes without private URLs.
- Selection-reducer timing and draft restoration outcome.
- Transfer lifecycle and retry outcomes.
- Share preview/submit/reconcile status.
- Permission/lifecycle recovery categories.

Do not include photos, face templates, recipient names, original filenames containing personal data, raw signed URLs, access tokens, or private sharing contents. Avoid session replay on photo, recipient-review, and face-setup screens.

Use consented or synthetic test fixtures. Do not repurpose production users' photos for benchmarks or public demo assets.

---

## 15. Screen and state coverage matrix

The prior 48 screenshots are a visual reference set. Implement missing states as screens, sheets, banners, or inline components where appropriate; do not inflate the app into dozens of unnecessary full-page steps.

| Journey | Required coverage | Principal acceptance condition |
|---|---|---|
| Authentication | Initial, provider cancel, invalid/expired code, resend cooldown, connection failure, session expiry. | Return to the intended task without leaking or losing account-scoped work. |
| Photo access | Full, limited/selected, denied, revoked, changed selection, return from Settings, cloud-only retrieval. | No unauthorized reads/uploads and no false state after resume. |
| Face setup | Camera load, no/multiple faces, quality retry, review, interruption, local preparation, sync pending/failed/active. | One account-level profile and truthful activation state. |
| Gallery | First load, cached data, empty library, pagination failure, refresh, new content, unavailable photo. | Images remain dominant; no unnecessary content jumps. |
| Search/filter | Results, none, clear, changed filter, preserved selection scope. | Results and selected totals are not confused. |
| Viewer | Fitted/zoomed, next/previous, chrome hidden, download/loading failure, unavailable return target. | Correct gestures, complete-image access, and context-preserving dismissal. |
| Matching | Queued, processing, completed, no eligible/uncertain match, correction, revoked profile. | Candidates are not automatic recipient access. |
| Photo review | None/some/all selected, explicit select-all scope, excluded state, restored draft. | Exclusions affect effective delivery consistently. |
| People review | Include/exclude, zero-photo recipient, per-person subsets, changed eligibility. | No Cartesian-product delivery. |
| Upload/download | Queued, transferring, paused, partial, failed, retry, permission loss, cancellation. | Persistent state, truthful progress, no duplicate work. |
| Share approval | Preview, empty result, changed manifest, validation failure, confirmed/partial outcome, retry. | Only the approved currently authorized pairs receive access. |
| History | Request accepted, access available, downloaded/viewed only where genuinely supported. | Status labels have distinct documented meaning. |
| Privacy | Hide, block, unblock, stop sharing, removal requested/pending/failed/completed. | Consequences and scope are explicit. |
| Data export | Request, processing, ready, expired/failed access. | Authorized access without indiscriminate biometric-template exposure. |
| Account | Profile edit, session devices, sign-out, account deletion and status. | Correct cleanup and no misleading completion. |
| Entitlements | Loading, pending purchase, cancelled, failed verification, restore, expired. | Preserve current business and native-store authority. |
| Environment | Offline, low memory, lifecycle return, rotation, resized window, large text/reduced motion. | Important state and functionality remain usable. |

---

## 16. Performance targets and measurement protocol

### 16.1 Status of these targets

These are provisional acceptance targets from the research report, not achieved measurements. Define the supported-device matrix and benchmark conditions before treating them as release gates. Changes to a target must be justified with evidence, not hidden by redefining the metric.

Profile physical devices in profile/release configurations. Debug timing and desktop-browser behavior are not proof of native performance. Flutter's guidance discusses 60fps and 120fps paths; corresponding display intervals are approximately 16.7ms and 8.3ms. [S29]

### 16.2 Initial targets

| Measure | Target / acceptance |
|---|---|
| Local touch feedback | p95 ≤ 50ms from input to visible response under the defined test. |
| Cold start to usable cached gallery | p95 ≤ 2 seconds with a valid existing session and suitable cached content. |
| Warm resume | p95 ≤ 500ms with restored task context under the defined scenario. |
| Sustained gallery scroll | <1% missed frames in the agreed scripted benchmark on each supported test tier. |
| High-refresh path | Verify on eligible physical hardware; do not promise universal 120fps. |
| Gallery during transfer | No UI blocking caused by transfer updates or background decoding. |
| Viewer memory behavior | No progressive retained-memory growth across repeated open/zoom/swipe/close cycles after normal cache stabilization. |
| Routine library scale | Test 10,000 assets, plus a larger stress dataset. |
| Draft integrity | No lost/silently changed meaningful selections after supported recoverable interruptions. |
| Sharing correctness | Zero unauthorized or excluded photo–recipient grants in the automated acceptance suite. |
| Reliability | Proposed 99.9% crash-free-session objective over a disclosed representative observation window. |

`p95` means 95% of measured observations are at or below the reported value. Report sample sizes and conditions. Never infer production crash-free rates from a handful of local sessions.

### 16.3 Measurement definitions

- Define cold/warm startup separately and identify whether data was cached or network-dependent.
- Measure perceived feedback separately from completion of the underlying operation.
- Collect build/raster and native timing evidence appropriate to the rendering pipeline; do not blindly add overlapping pipeline timings into a misleading frame budget.
- Identify the active refresh rate and power/thermal state during scroll tests.
- Report network conditions for all media/processing measurements.
- Track memory before, during, and after repeated journeys, distinguishing bounded cache growth from leaks.
- Separate upload duration, server queue delay, processing duration, and share-grant completion.

### 16.4 Device and environment matrix

At minimum, plan physical coverage for:

- Lower-memory Android device.
- Mainstream Android device.
- High-refresh Android device.
- Older supported iPhone.
- High-refresh iPhone.
- Tablet or foldable, including a resized/split-window mode.

Run representative journeys under constrained network, offline/reconnect, low-storage conditions, selected-photo access, large text, reduced motion, and lifecycle interruptions.

Use Flutter DevTools/profile traces and suitable native tools for platform tasks, memory, and lifecycle behavior. Record unavailable devices as outstanding verification rather than substituting an emulator and claiming equivalent evidence.

---

## 17. Required automated and manual tests

### 17.1 Pure logic and state tests

- [ ] Effective photo–recipient pair calculation and count derivation.
- [ ] Global photo exclusion, global recipient exclusion, and pair-only exclusion.
- [ ] Re-enabling global choices retains explicit pair exclusions.
- [ ] Filter changes do not accidentally clear selections.
- [ ] Select-all scope is correct and explicit.
- [ ] Draft persistence is account-scoped and version-aware.
- [ ] New candidate results do not expand an approved manifest.
- [ ] Transfer state transitions, retry classification, cancellation, and ambiguous-timeout reconciliation.
- [ ] Permission-state reconciliation and safe handling of inaccessible assets.

Use property-based or randomized tests where the existing stack supports them to exercise many combinations of match relationships and exclusions.

### 17.2 Server and authorization tests

- [ ] Match creation alone cannot expose contributor media that still needs approval.
- [ ] No unauthorized thumbnail or original access before the grant.
- [ ] A client cannot forge ownership, a recipient, eligibility, or a storage key.
- [ ] Changed consent, block state, recipient eligibility, asset availability, and entitlement are revalidated.
- [ ] Repeated submission is idempotent.
- [ ] Concurrent submissions do not create unintended duplicate grants.
- [ ] Partial failures preserve truthful per-pair outcomes.
- [ ] Recipient access is limited to the approved eligible subset.
- [ ] Revocation and account boundaries are respected by media signing and cache policy.
- [ ] Historical data is not destructively reinterpreted by an unreviewed migration.

### 17.3 Widget/component and visual tests

- [ ] Gallery tile variants and loading/error dimensions.
- [ ] Dark Lovelies theme, pink selection, lavender restraint, and accurate branding.
- [ ] Recipient identity/count rows and pair-review states.
- [ ] Disabled/empty share preview and changed-preview warning.
- [ ] Transfer tray, persistent failure, partial completion, and retry states.
- [ ] Large-text, long-name, localized-copy, reduced-motion, and high-contrast arrangements.
- [ ] Accessible semantics and focus restoration.

Use deterministic fixtures for golden/snapshot tests. Compare real screenshots at the intended size; passing golden tests alone is not proof of usability.

### 17.4 End-to-end acceptance scenarios

**E2E-01 — Recipient setup and receipt**  
Sign in, complete the actual one-time enrollment contract, handle a failed derived-data sync, retry successfully, receive an approved match, inspect it, and return to the same library context.

**E2E-02 — Contributor review**  
Grant selected-photo access, choose a batch, authorize processing, view candidate matches, exclude a photo, exclude a recipient, exclude one pair, inspect the final per-recipient subsets, submit, and confirm exact grants.

**E2E-03 — Interrupted draft**  
Create meaningful exclusions, navigate between photo/people views, rotate/resize where supported, suspend/resume, and restore the same effective draft.

**E2E-04 — Changed eligibility**  
Change a recipient block/consent/eligibility state between preview and submission. Verify revalidation, accurate feedback, and no unauthorized grant.

**E2E-05 — Ambiguous share timeout**  
Accept a share server-side but interrupt the response. Reconcile/retry using the operation identity and verify no duplicate or expanded deliveries.

**E2E-06 — Partial transfer**  
Upload a batch, fail selected files, pause/resume, and retry unfinished files only. Verify local and authoritative progress agree.

**E2E-07 — Permission revoked**  
Revoke or limit photo access outside the app, resume, and ensure inaccessible photos are handled safely without unauthorized reads or silent loss of draft decisions.

**E2E-08 — Viewer and performance**  
Scroll a large mixed-proportion library, open a photo, zoom, pan, swipe to another, dismiss, and confirm the correct return target without blank frames or progressive memory retention.

**E2E-09 — Account isolation**  
Create cached media and a pending draft, sign out, sign in as a different test account, and verify no cross-account media, draft, or transfer leakage.

**E2E-10 — Accessibility**  
Complete the main review/share journey using a screen reader, large text, and reduced motion. Verify all important actions have understandable controls and feedback.

**E2E-11 — Entitlement preservation**  
Where applicable, attempt a restricted action, complete or cancel its existing entitlement flow, restore a purchase, and return to the original media task without modifying sharing authority.

**E2E-12 — Revocation and deletion truthfulness**  
Stop sharing or remove a profile; distinguish immediate exclusion/access changes from eventual deletion completion and do not claim retained copies have been recalled.

---

## 18. Ordered implementation plan

### Phase 0 — Inspect and establish a baseline

- [ ] Complete the focused preflight in Section 1.
- [ ] Identify actual files and service contracts for each core journey.
- [ ] Record baseline screenshots and available functional/performance evidence.
- [ ] Record gaps and source/mockup conflicts without making unsupported production claims.
- [ ] Choose the first end-to-end vertical slice and begin implementation.

**Gate:** A verified implementation map exists, unrelated changes are preserved, and the work is tied to actual source rather than invented modules.

### Phase 1 — Consolidate foundations and navigation

- [ ] Implement/consolidate dark Lovelies tokens and supplied branding.
- [ ] Standardize icons, primary controls, surfaces, touch targets, and typography.
- [ ] Establish the four-destination navigation model and incoming/outgoing match distinction.
- [ ] Establish motion/reduced-motion tokens and accessibility semantics.
- [ ] Prepare the authoritative state inventory.

**Gate:** Core screens no longer use conflicting visual or navigation systems. No light-gallery substitution or decorative content cards replace the requested masonry.

### Phase 2 — Implement gallery and viewer quality

- [ ] Build the lazy mixed-proportion masonry around stable metadata.
- [ ] Implement rendition-aware loading, bounded caches, and prioritized/cancellable prefetching.
- [ ] Add photo inspection, zoom/pan/swipe/dismiss, density control, and context restoration.
- [ ] Add selection states without destabilizing tile positions.
- [ ] Test image correctness and profile available physical devices.

**Gate:** The gallery/viewer journey is functional, visually aligned, and supported by relevant tests and available device evidence.

### Phase 3 — Implement match review and sharing authority

- [ ] Implement photo → people and person → photos.
- [ ] Implement global and pair-level exclusions with one effective-pair calculation.
- [ ] Persist drafts and present accurate final recipient subsets.
- [ ] Inspect/fix candidate-to-access gating where required.
- [ ] Implement versioned submission, server revalidation, idempotency, and partial-result recovery.
- [ ] Add correct history and incorrect-match correction states.

**Gate:** Every recipient receives only the approved currently authorized subset. UI checks are backed by server tests.

### Phase 4 — Complete platform integration and recovery

- [ ] Complete permissions, camera lifecycle, and actual enrollment states.
- [ ] Implement durable transfers and suitable native background integration.
- [ ] Add offline/reconnect reconciliation and account-scoped cleanup.
- [ ] Complete deep-link/notification return paths and native back behavior.
- [ ] Implement meaningful error/empty/partial states from the coverage matrix.
- [ ] Preserve existing entitlement and privacy flows.

**Gate:** Core tasks survive denial, interruption, timeout, retry, and account changes without lost meaningful choices or false completion states.

### Phase 5 — Polish, accessibility, and release qualification

- [ ] Tune motion and haptics from real interaction evidence.
- [ ] Validate reduced-motion/transparency paths and lower-cost rendering.
- [ ] Complete responsive, large-text, localization, and screen-reader testing.
- [ ] Validate native dependency compatibility, including relevant 16KB page-size checks.
- [ ] Run the performance matrix, security checks, and E2E suite.
- [ ] Prepare staged rollout/rollback notes without publishing unless authorized.

**Gate:** Functional, visual, accessibility, authorization, and available performance evidence pass. Outstanding external checks are explicitly identified.

### Sequence rule

Do not spend the first implementation cycle building another splash animation or another large screenshot board. Deliver the gallery → photo → recipients → exclusions → preview → approved share vertical slice first, while preserving existing behavior.

---

## 19. Verification workflow and required handoff

### 19.1 Use actual repository commands

Discover the project-specific commands and pinned toolchain first. Typical Flutter checks may include the following, but do not claim they succeeded without executing them in the correct application directory:

```sh
# First: inspect repository instructions, worktree, and pinned toolchain.
git status --short
flutter --version
dart --version

# Then, using the project's documented workflow and scope:
flutter analyze
flutter test
# Execute named integration tests and platform builds according to the repository.
```

Do not use an unsupported command such as a broad integration run as a substitute for the repository's device-specific test setup. Record exact commands, exit status, relevant artifacts, and any execution limitations.

Formatting or tests must not rewrite unrelated work. Do not commit, push, deploy, publish, or modify production services without the relevant authorization.

### 19.2 Keep a factual implementation record

Use existing repository conventions for reports. If none exist, a suggested set is:

- `docs/lovelies/implementation-status.md`
- `docs/lovelies/screen-state-coverage.md`
- `docs/lovelies/performance-evidence.md`
- `docs/lovelies/visual-fidelity-ledger.md`

These are proposed output paths, not claims that the files already exist.

### 19.3 Final Codex handoff must include

1. What was implemented, with actual changed file paths.
2. Which core journeys are now working and how they were tested.
3. Sharing-authorization changes, schema/API impact, and migration/rollback considerations.
4. Screen/state coverage completed and genuinely outstanding.
5. Exact tests/builds run and their results.
6. Physical devices and conditions measured, or the precise reason that a check remains outstanding.
7. Real performance results separated from provisional targets.
8. Screenshots demonstrating the dark masonry direction and key review/share states.
9. Accessibility/localization findings and fixes.
10. Intentional deviations, external dependencies, and remaining risks.

Never finish with an unsupported statement such as `production ready`, `fully native`, `120fps`, `all tests pass`, or `all screens complete` when the evidence does not establish it.

---

## 20. Corrections to concept artifacts

The screenshots are useful for visual direction but contain generated details that must not become accidental product requirements.

| Concept artifact | Required production treatment |
|---|---|
| Light/pastel full gallery background | Keep the approved near-black masonry gallery. |
| Repeated large logo on functional screens | Reserve brand emphasis for suitable entry/brand moments; let photographs lead. |
| Grey bars instead of settings labels | Use concise real text and accessible names. |
| Generic “all set” after local capture | Show active only after the actual required synchronization/activation succeeds. |
| Low-quality capture with “Use this anyway” | Respect mandatory recognition/capture-quality requirements. |
| Landscape/object photo marked as an automatic face match | Use fixtures and outcomes consistent with actual eligible face matching. |
| Photos × people treated as universal sharing | Use the effective approved photo–recipient set. |
| Excluding a recipient depicted as deleting them from a group photo | Explain delivery exclusion; no image editing is implied. |
| Comments, mentions, social likes, videos, public feed | Not part of this implementation scope solely due to appearing in generated boards. |
| Invented iOS/Android permission UI | Invoke actual platform UI and use an accurate in-app explanation. |
| Multiple recipients shown as enrollment profiles | Separate the user's own face setup from recipient review. |
| “Viewed” used for an accepted share request | Use only genuine, authorized delivery/receipt states. |
| Delete/block shown as recall of all retained copies | Describe enforceable future access changes truthfully. |
| Unqualified “on-device” processing claim | Explain the actual local/cloud path for the operation. |
| One screenshot per Canva page interpreted as editable app code | Rebuild real components and interactions in the application. |

---

## 21. Source register

### 21.1 Provenance and use

This file reformats and operationalizes the preceding research report. The source register carries forward its references and adds official implementation entry points for Android Photo Picker and Apple background downloads. Those two documentation links were checked while preparing this file; this document does not claim a new independent verification of every other webpage, live API, or deployed service.

External platform requirements and version-dependent APIs can change. Codex must check the relevant official source and the actual toolchain before relying on a release-specific behavior. Proposed Lovelies tokens, timings, module boundaries, acceptance fixtures, and targets are implementation decisions, not claims copied from a reference app.

Private repository links may require authentication. Do not include access tokens in any generated documentation.

### 21.2 Repository references

- **[R01] Lovelies architecture.** `ikanisa/Memories/ARCHITECTURE.md`. Prior read SHA: `2adfd7ff1728ca6c4df5730c9aabab868976be51`. <https://github.com/ikanisa/Memories/blob/main/ARCHITECTURE.md>
- **[R02] Flutter manifest.** `ikanisa/Memories/apps/user_flutter/pubspec.yaml`. Prior read SHA: `42f07107110e81b46607d25e5d9df8bd6864c777`. <https://github.com/ikanisa/Memories/blob/main/apps/user_flutter/pubspec.yaml>

### 21.3 Product, design, and platform references

- **[S01] Apple Photos — library browsing and display.** <https://support.apple.com/en-euro/guide/iphone/iph7d24753a5/ios>
- **[S02] Apple Photos — viewing photographs.** <https://support.apple.com/en-gb/guide/iphone/iph3d267610/27/ios/27>
- **[S03] Google Photos — people, pets, and face groups.** <https://support.google.com/photos/answer/6128838?co=GENIE.Platform%3DAndroid&hl=en>
- **[S04] Pinterest Engineering — open-sourcing PINRemoteImage.** Historical engineering reference. <https://medium.com/pinterest-engineering/open-sourcing-pinremoteimage-ae83ee0f3e8a>
- **[S05] Meta Engineering — Android baseline profiles and journey performance.** <https://engineering.fb.com/2025/10/01/android/accelerating-our-android-apps-with-baseline-profiles/>
- **[S06] WhatsApp Help Center — privacy and sharing considerations.** <https://faq.whatsapp.com/1313491802751163>
- **[S07] Telegram — 2026 design update and effects controls.** <https://telegram.org/blog/new-design-ai-summaries>
- **[S08] Airbnb — 2025 Summer Release and redesigned experience.** <https://news.airbnb.com/airbnb-2025-summer-release>
- **[S09] Spotify — Now Playing.** <https://support.spotify.com/us/article/now-playing/>
- **[S10] Adobe Lightroom mobile — gesture controls.** <https://helpx.adobe.com/lightroom/mobile/get-started/gesture-controls-in-lightroom-for-mobile.html>
- **[S11] Duolingo — design/animation investment and Hobbes acquisition announcement.** Company announcement distributed through GlobeNewswire. <https://www.globenewswire.com/news-release/2024/07/09/2910223/0/en/Duolingo-Doubles-Down-on-Design-and-Animation-With-Acquisition-of-Hobbes.html>
- **[S12] Apple Developer — What's new in iOS.** Version-sensitive; verify before implementation. <https://developer.apple.com/ios/whats-new/>
- **[S13] Apple Human Interface Guidelines — Materials.** <https://developer.apple.com/design/human-interface-guidelines/materials>
- **[S14] Material 3 — Motion.** <https://m3.material.io/styles/motion/overview/how-it-works>
- **[S15] Android 17 — orientation, resizability, and aspect-ratio restrictions.** Version-sensitive; verify applicable behavior and exceptions. <https://developer.android.com/about/versions/17/changes/ff-restrictions-ignored>
- **[S16] Apple — Reduced Motion evaluation criteria.** <https://developer.apple.com/help/app-store-connect/manage-app-accessibility/reduced-motion-evaluation-criteria/>
- **[S17] Android — Predictive back gesture.** <https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture>
- **[S18] Apple WWDC — selected/limited photo-library access.** <https://developer.apple.com/videos/play/wwdc2020/10641/>
- **[S19] Android — Photo Picker.** <https://developer.android.com/training/data-storage/shared/photo-picker>
- **[S20] Android — selected photo/video access changes.** <https://developer.android.com/about/versions/14/changes/partial-photo-video-access>
- **[S21] Android — Haptics principles.** <https://developer.android.com/develop/ui/views/haptics/haptics-principles>
- **[S22] Flutter — Performance best practices.** <https://docs.flutter.dev/perf/best-practices>
- **[S23] Apple WWDC — HDR image rendering.** <https://developer.apple.com/videos/play/wwdc2023/10181/>
- **[S24] Flutter — Accessibility.** <https://docs.flutter.dev/ui/accessibility>
- **[S25] Android — Background data-transfer options.** <https://developer.android.com/develop/background-work/background-tasks/data-transfer-options>
- **[S26] Apple — Background URLSession transfers.** Official implementation reference for the lifecycle limitations discussed in the report. <https://developer.apple.com/documentation/foundation/downloading-files-in-the-background>
- **[S27] Flutter — Impeller.** <https://docs.flutter.dev/perf/impeller>
- **[S28] Android — 16KB page-size support.** <https://developer.android.com/guide/practices/page-sizes>
- **[S29] Flutter — UI performance and profiling.** <https://docs.flutter.dev/perf/ui-performance>

---

## 22. Final directive to Codex

Implement a **dark, image-dominant, tightly arranged, responsive Lovelies application** whose premium quality comes from precise touch response, preserved context, sharp photographs, coherent motion, useful haptics, and correct sharing authority.

Prioritize the complete real journey over another collection of isolated mockups. Automatic matching must not become automatic sharing. The user must always be able to understand and control who receives each photograph.

**Begin with the actual checkout, implement the first vertical slice, run the relevant tests, and continue through the ordered phases. Document evidence and unresolved external checks truthfully.**
