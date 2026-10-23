# Current frontend scope and donor cleanup

The owner's 16 October 2026 correction makes the current Lovelies frontend and
explicit app requirements the product scope. MEMORIES supplies reusable
implementation only where it serves those journeys. A copied endpoint, role,
table, fixture or historical feature list does not authorize a new capability.

## Retained journeys

| Current design / requirement | Retained implementation |
| --- | --- |
| Screens 1–9, 38, 46 and owner authentication amendments | Anonymous sessions, registered-reference face enrollment/login/recovery, separate consents, profile lifecycle, device/session controls. No OTP or liveness. |
| Screens 10–16 and 19–35 | Ordinary photo uploads, processing, private gallery/search/favorites, matched photos/people, exact recipient subsets, approvals, acceptance and history. |
| Screens 36, 39–40 | Incorrect-match reports, blocks, moderation holds and access revocation. Resolving a report does not restore grants. |
| Screens 37–46 | Profile/preferences, notifications, support, storage, export and account deletion. |
| Save/download and explicit entitlement requirement | Apple/Google verification and current store entitlement before protected originals. |
| Owner request: user management (16 October 2026) | Account metadata, search, related cases, and guarded individual session revocation. No new contributor role, biometric viewer or direct deletion bypass. |
| Infrastructure supporting those journeys | Private storage, queues, retention/erasure, provider reconciliation and restricted operational controls. These do not add product screens. |

## Removed from the active application

- Photographer applications, access review/activation and active photographer role.
- Professional upload/sharing mode in the backend, JavaScript client and native
  Android/iOS protocol adapters. Retired
  modes fail closed; historical professional media is not recast as personal.
- The admin photographer destination, decisions, sample records, metrics, activity,
  professional-upload copy and unused icon styling. Old sample state cannot revive
  those records. The retained admin preview has Overview, Users, Match reports, Privacy, Support
  and Uploads; Users follows the later explicit owner request as synthetic data only in the explicit local preview. The normal operator entry now uses actual signed face authentication/current admin authority; hosted acceptance remains pending.
- The copied Payments preference in native Notification Settings. Notification
  layout and the existing match/support controls remain; entitlement enforcement
  and its necessary status notifications remain.
- Inactive donor Worker, Supabase migrations/helpers, 36 legacy-only scripts,
  legacy package commands/workspace membership and exclusive SQL test dependencies.
  Required Google provider types are now local to the Cloudflare service.
- The obsolete release-backlog instruction to add professional/photographer
  consumers. U09 now follows the existing Help center support journey.
- Named legacy MoMo/creator-revenue route aliases; no corresponding payment or
  payout product is part of the current app.

## Preservation and existing-data compatibility

The supplied 48-screen reference assets, preview, layouts, typography and branding
are retained. The only native presentation edits remove the extra payment toggle.
The initial cleanup removed the unused photographer icon rule. The later owner-requested
admin corrections preserve its composition while adding User management and clearer
case status/context. Consumer frontend references and native screens are unchanged
by that later admin work.

`verification/frontend-alignment-20261016/frontend-before-sha256.json` records 556
frontend inputs. `frontend-changes.json` identifies the two native settings files,
the unused admin style rule and the native protocol/controller/repository sources
changed to reject retired modes. Supplied references, shared assets and the original
browser frontend remain unchanged.

The schema still recognizes old stored source values and the retired request table
so an existing SQLite database can open without a destructive migration. These
values cannot activate the removed workflows. Existing records remain subject to
privacy export/deletion, and legacy role values confer no photographer authority.
Old role-bearing credentials fail; ordinary user/admin authority is reconstructed
consistently for retained personal journeys.

The inactive donor code was removed from active paths only after verifying a
recovery archive containing all 400 source/preimage files. Of those, 399 were removed;
the workspace configuration preimage is retained while its current file was edited.
The archive, hashes and removal receipt are in
`verification/frontend-alignment-20261016/inactive-donor-source-20261016T014154Z/`.
Old local runtime state was preserved separately there. The external MEMORIES donor
was untouched. Previous verification records and client preimages are historical
provenance and cannot authorize restoring removed features.

## Verification

Current checks and their exact limits are recorded in
`verification/frontend-alignment-20261016/README.md`. This cleanup is local; it does
not establish deployment, hosted acceptance or an iOS/device release. The admin
remains a design preview with no live authenticated API integration.

## Owner frontend annotations, 23 October 2026

The owner's browser review adds these requirements to the retained consumer
journeys:

- Upload sources include Google Photos, Google Drive, Dropbox and OneDrive,
  plus iCloud Photos on iOS. Existing device, album, file and camera choices
  remain. Native imports use the existing system pickers; the source guidance
  explains installed-provider requirements and the iOS Google Photos save-first
  handoff. These choices do not imply a direct cloud account connection.
- Allowed people are the current matched people minus blocked people. There is
  no separate manual whitelist. Blocking removes the person from the current
  share; unblocking makes future sharing possible without restoring old media
  grants or selecting the person in the current review.
- The reference frontend's "Who can find you" setting defaults to Anyone.
  Discoverability does not grant photo access or supply matching consent. The
  connected backend already searches consenting registered references without
  a manual whitelist and excludes blocked pairs. It has no separate persisted
  discoverability-scope preference; the reference's other scope choices remain
  local review state.

Current verification and platform/provider limits are recorded in
`verification/frontend-comments-20261023/README.md`. The original supplied
screens and prior verification records remain unchanged.


## Owner accessibility/navigation corrections, 23 October 2026

The owner requested screen-by-screen accessibility, navigation, responsive layout,
feedback and motion corrections. These explicitly authorize adapting interactive
layout: larger hit regions, readable scalable labels, visible secondary exits,
wrapping/stacked rows and controls, scroll recovery and reduced-motion support.
Original supplied screenshots remain unchanged in Compare. A screenshot crop does
not justify clipping controls or shrinking the whole interface.

The browser fixes cover all 48 renderers. Android/iOS shared controls and reference/
connected UI have corresponding navigation, semantic and adaptive-layout changes,
while authenticated lifecycle, capture ownership, consent, sharing and recovery
state machines remain authoritative. Reference-only gallery exits do not bypass
connected deletion or recovery holds. Evidence and remaining runtime gates are in
`verification/accessibility-navigation-20261023/README.md`.
