# Backend reuse client seam

The reusable Fetch client is [client.mjs](../clients/backend/client.mjs), with
[wire validators](../clients/backend/contracts.mjs) and
[Node tests](../clients/backend/client.test.mjs). It uses built-in ES modules,
Fetch, streams, AbortController and UTF-8 codecs; no dependency installation is
needed. It calls the MEMORIES Cloudflare Worker routes using real credentials.
It contains no mocked authentication, media, recipients or delivery outcomes.

**Integration boundary:** the existing Android, SwiftUI and browser applications
still use their demo stores. This module does not connect those applications,
change the 48 screenshot designs, supply a native JavaScript runtime, or convert
the donor Flutter UI into either native application. The sole product design
authority remains `revolut-design@jean-bosco-skills`.

## Configure and import

Serve this workspace through the existing local HTTP review server, then import
the module from a separate caller. Both origins below are explicit public
configuration, supplied by the integration owner:

```js
import { LoveliesBackendClient } from '../clients/backend/client.mjs';

const client = new LoveliesBackendClient({
  baseUrl: backendOrigin,
  mediaOrigin: previewOrigin, // Worker PUBLIC_APP_BASE_URL origin for /previews/.
  // fetch: customFetch,       // Optional transport with the Fetch contract.
  // onOperationPrepared: async (intent) => saveTokenFreeIntent(intent),
});

await client.startOtp({ phone: userEnteredPhone });
await client.verifyOtp({ phone: userEnteredPhone, code: userEnteredCode });
const current = await client.current(); // GET /me validates the current account.
const photos = await client.photos({ source: 'contributions', limit: 30 });
const image = await client.preview(photos.items[0].id);
```

Use a configured HTTPS origin, or loopback HTTP for local development. URL
credentials, query strings, fragments and path prefixes are refused. This seam
targets Worker routes; it does not implement the donor Flutter adapter's
Supabase Edge function-slug translation. Browser origins must be allowed by the
Worker's CORS configuration. No origin or environment automatically authenticates
a caller. A phone requesting a photographer/admin role does not obtain that role
unless the verified server response grants it.

Keep only the public API origin and preview origin in browser/native configuration.
Supabase service-role/anonymous keys, JWT/upload signing secrets, Cloudflare
credentials, WhatsApp tokens, MoMo secrets and model-provider credentials belong
in the server's ignored environment or its secret bindings. Do not put them in
this module, Gradle BuildConfig, Xcode resources, `shared/`, screenshots or logs.
This client never logs or persists bearer/refresh tokens. Session credentials
exist only in private memory and are not returned by `client.session`.

The donor's supported authentication contract is phone OTP. The email, Google
and Apple choices on reference screen 03 remain demo controls until a real
provider integration exists; navigating to screen 04 is not authentication.
Camera/photo permissions, three live selfies, on-device derivation, consent,
upload queues and entitlement-aware original export also need native adapters.
This seam does not claim to implement those platform functions.

## Reviewed sharing and protected media

```js
const snapshot = await client.snapshot({
  assetIds: actualOwnedPhotoIds,
  operationKey: snapshotOperationKey,
  // source: 'professional', uploadBatchId: actualOwnedBatchId,
});
const draft = {
  version: 1,
  selectedAssetIds: selectedPhotoIds,
  selectedRecipientIds: selectedPersonIds,
  excludedPairs: [{ asset_id: excludedPhotoId, recipient_id: excludedPersonId }],
};
const preview = await client.preparePreview(snapshot, draft, {
  operationKey: previewOperationKey,
});
// Display preview.recipients and their actual asset_ids; require explicit Share.
const result = await client.commit(preview, { draft, operationKey: shareOperationKey });
```

Each operation key must be a caller-owned stable 16–128-character string. The
optional async `onOperationPrepared` receives a token-free account/source/action/
payload/key intent and completes before dispatch. The client itself performs no
disk or browser-storage writes. Pending intents remain in memory; restoring an
application after process loss requires a caller-owned durable adapter. This
module has no automatic queue executor or automatic write retry.

On timeout, connection failure, malformed write response or 5xx, inspect
`client.pendingOperations` and call `client.reconcile(originalKey)`. An explicit
`client.retry(originalKey)` queries the original operation first and replays its
exact original payload/key only if it remains unknown. Confirmed partial,
accepted or unavailable operations are re-queried without creating another
request. Definitive 4xx denials end the intent, except ambiguous 408/429.

Snapshots require current scope metadata, unique real UUIDs, versions, expiry
and an actual sparse candidate graph. The current server bounds are 100 photos,
100 recipients and 1,000 pairs. Missing scope, out-of-scope edges, wrong source,
wrong professional batch and inconsistent recipient subsets/counts are refused.
Personal source is absent on the wire. Only `sharing.snapshot` sends
`source: 'professional'`; preview/commit inherit server snapshot authority.
Professional assets remain professional and are never recast as community
contributions. Local selections and matches confer no access.

`gallery()` reads `/me/gallery`. `galleryPreview(id)` signs `/previews/sign`,
verifies the configured preview origin, then reads the bounded signed preview
without forwarding a bearer to that media origin. `photos()` reads the existing
`photos` community action. `preview(id, {professional:true})` uses owner-only
`sharing.photos.validate`; the default uses `photos.validate`. Both read
`/community/media/{id}/preview`, with source/permissions inferred by the server.
No original-download shortcut exists here. The donor's entitled professional
original download route remains a separate capability.

`receipt(requestId, {source})` and `decideRequest(requestId, decision,
{source, operationKey})` use the existing participant-authorized receipt and
Accept/Decline/Withdraw/Revoke contracts. Submission is pending acceptance with
zero grants. A receipt's current accepted subset and availability determine what
can be displayed; the client never calls submitted photos delivered or viewed.

Responses have a 20-second header/body deadline, a 2 MiB JSON ceiling and a
4 MiB preview ceiling, with no-store reads and refused redirects. Session,
account and token changes fence late responses. `logout()` clears local state
before awaiting server revocation; offline revocation failure remains visible.
Callers must also retire previously returned image bytes/object URLs on logout,
account changes, expiry or access failure. The client does not control images
already displayed by another component.

## Future native and browser file boundaries

| Client | Existing seam and smallest future integration boundary |
|---|---|
| Android | `android/app/src/main/java/com/lovelies/frontend/preview/MainActivity.kt`: `PreviewState` and its construction. Add native repository/session/media adapters and feed existing controls; `Components.kt` currently decodes bundled assets only. Normal action wiring lives in `OnboardingScreens.kt`, `GalleryScreens.kt`, `UploadScreens.kt` and `SharingScreens.kt`. Add network permission/configuration in the existing manifest/Gradle target; keep screenshot/reference seeding isolated from live UUIDs. |
| SwiftUI | `ios/Lovelies/App/LoveliesApp.swift`: `@StateObject DemoStore`; `Models/DemoStore.swift`: local models/state/timers. A native URLSession repository and Keychain session adapter can feed these views without replacing the screen layouts. `Views/Components.swift` currently loads bundle images. Native capture/photo permission declarations belong in `Info.plist` only when those adapters exist. Full iOS SDK verification remains separate. |
| Browser | `preview/app.js`: `initialState`, action dispatch and upload/share timers are local. A future explicit live-mode caller can import this module, replace normal action results and use actual IDs/media. Keep `shared/catalog.json`, reference grids and comparison captures as demo/reference evidence; they are never upload/share inputs or authority. |

Use the server's pending/changed/partial/access outcomes in live flows. The
prototype's timed progress and fixed “Delivered”/“Viewed” history labels are
sample states and must not be reused as real receipts. Native Kotlin/Swift clients
need native implementations of this wire contract; importing this ES module is
not native integration.

## Verification

The integration owner runs `node --test clients/backend/client.test.mjs` from
the workspace root. Tests cover the actual request shapes, sparse subsets,
professional source/batch scope, account fences, bounded streaming, uncertain
write reconciliation, definite denial, pending acceptance and protected media.
The loopback HTTP case uses real Fetch against a synthetic HTTP fixture; it is
not an actual Worker-handler, SQL, hosted OTP, real-media or deployment test.
No tests or builds were executed by this client's author. The integration
owner records the concrete QA result separately.
