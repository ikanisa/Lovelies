# Lovelies operator panel — current implementation

Updated 1 November 2026. This document describes the integrated live panel. Earlier design-preview screenshots and counts remain historical evidence in Git and `verification/`; they do not certify this source or a hosted release.

## Runtime and authority

`admin/entry.mjs` opens the live panel. The sample panel is available only through an explicit loopback preview. The public runtime configuration uses the deployed HTTPS origin and `/functions/v1/lovelies-api`; an explicit public override must pass the same URL checks. Browser code receives no Supabase service-role, database, managed Auth, provider or custody credential.

The browser retains its registered signing key and encrypted operation journal. Lovelies performs anonymous-first enrollment with three signed selfies, current eligibility and separate purpose consent, then registered-face authentication. Supabase managed Auth supplies the server-owned session substrate. Camera access, a local face result, a cached audience projection and browser storage never confer operator authority.

An independently provisioned operator must have current server-validated capabilities. The Complete package's fifteen delegated capabilities remain authoritative; audience decision-v2 does not infer permission from a null historical age band. Every read and mutation rechecks authority. A privacy-only operator can review authorized privacy records but cannot inspect administrator-only work recovery. Loss of authority removes private DOM and invalidates pending reads.

Annual eligibility renewal is an explicit decision. It does not open a session or grant a role. Original uncertain operations retain their exact key and request. An exact server `operation_recovered_without_result` (409) or `operation_retired_by_recovery` (410) replaces the pending action only after a durable tombstone saves the original account, operation key, request digest and terminal code. This means that the original operation ended without a confirmed renewal. Current eligibility is read separately and a replacement requires a new explicit choice. A failed durable write preserves the pending action.

## Queues and detail views

The primary support, privacy, safety and upload collections retain the Complete backend's canonical status filters and priority/oldest ordering. The panel never sorts or filters a bounded server page as if it represented the whole collection. Photo reports and flagged matches have separate selected collections and independent cursor histories. Changes to filters or search reset only the relevant cursor.

Account sessions, case relationships, history, upload attempts and privacy decisions have bounded continuation controls. A detail response is published only while its original account, session, request generation and selected record remain current. Closing a record, signing out, switching account, changing the target or losing authority prevents delayed results from reopening it.

Administrator-only Work recovery inspects stopped jobs without dispatching them. Resuming original work requires a fresh exact-state fingerprint, reason, confirmation and current administrator/face authority. The backend preserves original episodes and history. A notification can resume only when its independent complete roster proves all intents remain unstarted; uncertainty is held for reconciliation. Repair cannot invent a new notification, ignore a legal hold or bypass restore fencing.

## Drafts, sessions and offline behavior

Unsent notes and submitted operations are separate. Up to eight unsent drafts are sealed with a non-extractable AES-GCM key in IndexedDB for at most thirty minutes. Explicit restoration requires a current authorized record, matching operator/target/revision and a fresh confirmation checkbox. Storage failure produces an explicit tab-memory fallback.

Sign-out and account switch synchronously invalidate draft generations before asynchronous deletion. The save/restore path captures the original epoch before hydration; a late write cannot resurrect a discarded account's notes or delete the new account's state. Submitted uncertain operations retain their exact encrypted request until the server outcome is reconciled.

The service worker caches only the allowlisted public shell. It never caches API replies, authorization-bearing requests, private media, query-bearing paths or operation journals. Private content is removed when offline or hidden. Reopening a cached shell requires fresh server authority before any private workspace appears.

## Narrow screens and accessibility

The existing layout and design are preserved. Narrow navigation exposes Sign out and Workspace help; Install app appears only while the browser offers its installation prompt. Escape and dialog closure restore focus to a valid control or the main landmark. Tables have named keyboard-focusable scroll regions; repeated review actions name their exact record. UUIDv8 deletion requests are accepted throughout review and draft scopes.

Local browser checks cover 320px, 760px and desktop layouts, dialog/focus behavior, IndexedDB cleanup, delayed reads and the real service-worker shell/offline boundary. Physical touch, assistive technology, camera permissions, installed-PWA updates and actual operator accounts on the final host remain separate acceptance gates.

## Serving and verification

`scripts/serve-preview.py` and the production Caddy configuration expose an exact public file allowlist, including shared audience and operator-capability modules. Test files, directory listings, backend source and private configuration are unavailable. A shell change requires a service-worker cache version change.

Run `pnpm admin:test`, `pnpm backend:client:test` and `pnpm preview:test`. The opt-in browser checks are `admin/check-browser-navigation.mjs` and `admin/check-browser-offline.mjs`; each requires an explicitly started loopback preview and a new report path. They use synthetic sessions and cannot certify hosted authorization. See [the operator README](../admin/README.md) for commands and evidence boundaries, [browser recovery](operator-browser-recovery.md), [queue repair](queue-repair.md), and [the local Supabase architecture](local-supabase-architecture.md).
