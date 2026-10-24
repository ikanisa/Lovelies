# Lovelies × OpenFace local integration

24 October 2026. This implements the proposed first slice, LOF01–05, with the
necessary LOF06 admission/body corrections. Nothing has been deployed or submitted.
The original release register remains authoritative; these LOF IDs add no new
blanket release requirements.

The native API, custom Lovelies accounts/sessions, signed still protocol, consents,
exact recipient snapshots, immutable review, independent recipient acceptance,
media eligibility and entitlement checks are retained. Supabase remains the only
application authority. The worker receives only admitted still bytes, has no
account/storage credentials and cannot issue sessions or grants. No generic
OpenFace auth application/mobile SDK, PAD/video, cross-app index or new user role
is installed.

## Sources and artifacts

- Lovelies starts at `9b9fda2ae918b73881fe7d1b318f570f0a97d2d8`, branch
  `codex/openface-integration-20261024`. The pre-existing iOS view edit is preserved
  and excluded from this integration's validation scope.
- OpenFace starts at `af25134370c94d577a825e1a8632171b17f13bd6`, additive branch
  `work/lovelies-still-consumer-20261024`; the extracted source is committed at
  `bf898c4425247be287530c670cef041c6dc6b289`. Earlier releases/runtime evidence are
  preserved. The new package reuses the canonical vision/worker/evidence closure.
- `services/ml-face/vendor/openface-still.json` pins the independently built
  `openface-still==0.1.0` wheel and source-closure identity. Its wheel transport
  SHA-256 is `6d1c65ce23679009b8f7531f8d1ca94e33e96167179724c3bae841c628799a50`;
  engine source/contract SHA-256 is
  `173b43d8f5d259f022f4fd83b7c658fc7ade3070e36321965436cd59f2da909f`.
  The wheel contains first-party and third-party notices, no models, account
  application, PAD or video graph. It does not install a stock OpenCV wheel.
- Lovelies retains its NumPy 2.4.6/Pillow 12.3.0 lock and native security recipes;
  no generic runtime replaces its image-only build. The selected Python range is
  3.12–3.13, matching the extracted dependency. The updated lock only adds the
  still wheel and prunes unsupported Python-version artifacts.

## Compatibility and transition

The worker policy explicitly selects 20 MiB, 40 MP, 100 faces, detector confidence
0.80/top-k100, original-resolution upright decoding/detection, clamped integer
boxes and no minimum-face filter. Lovelies computes its existing quality formula
from owned aligned pixels. Photo distance ≤0.42, positive distinct-identity margin
≥0.05, and registered-reference authentication distance ≤0.35 are retained.
These remain existing operating defaults, not new recognition acceptance.

References use `lovelies-face-template-v2`, binding model ID, the new
`lovelies-sface-openface-still-v1` space, package SHA and complete processing
fingerprint. That fingerprint includes actual OpenCV/NumPy/Pillow versions, exact
model hashes, immutable core policy, consumer source/validation/math and selected
thresholds. A different runtime or consumer implementation requires a deliberate
compatibility decision; changing configuration cannot relabel stored vectors.

Legacy v1 or different-space templates fail closed with private
`registered_reference_space_incompatible`. No stored data is deleted, rewritten,
imported or silently accepted. The explicit transition is the existing authorized
profile-removal, durable cleanup and re-enrollment path. Keep old serving traffic
on the preserved compatible engine until transition/connected qualification is
complete; this slice does not establish a seamless old-profile cutover. No schema
migration is needed for this slice: the existing template digest binds the opaque
v2 content through profiles, challenges, replacement and processing snapshots.

Every private request and result binds `engine_space`, `engine_artifact_sha256`,
`processing_fingerprint`, fresh `request_id` and `request_sha256`. The latter is
SHA-256 of recursively key-sorted UTF-8 JSON excluding only itself; arrays retain
order. Existing private payloads contain only strings/integers/arrays/objects.
The consumer verifies actual loaded identities before inference; the API verifies
all binding fields before using a result. Native challenge/envelope/model/policy
formats remain unchanged.

## Transport, readiness and input contract

The active consumer requires `https_service` and an independent service secret;
missing credentials or `private_binding` cannot start an unauthenticated service.
The credential is removed before parsing/inference and is absent from the child
environment. Local tests use an ephemeral test credential and loopback listener.
TLS termination, network isolation and host resource limits require the selected
hosting environment.

Authenticated `/ready` probes the loaded resident worker and reports actual
package/processing/model identities, exact capabilities and limits. The API's
readiness invokes that probe and exposes only a sanitized boolean. Pin
`ML_INFERENCE_ARTIFACT_SHA256` and `ML_INFERENCE_PROCESSING_SHA256` to the selected
exact artifact/runtime; environment presence cannot make readiness pass.
The unchanged worker source-image identity guard is not bypassed.

Only JPEG/PNG/WebP are admitted. Unsupported GIF now fails before creation of an
asset, transfer, attempt or job. Native HEIC-to-JPEG import behavior is unchanged.
Signed authentication bytes are hashed before inference and are never rewritten.
The existing 8 MiB aggregate capture bound, 12 MiB face body, 40 MiB photo body,
6 MiB reply, 1,000-profile cap, redirect denial and bounded deadlines are enforced.
Photo templates count toward the serialized body budget before the complete
snapshot is retained. Oversized snapshots fail truthfully; profile count alone
never establishes a safe payload.

One resident still-only child owns model execution. It uses private leased
spooled evidence, bounded pipe messages, deadlines and retire/reap before
replacement. Failures do not silently replay inference. Worker/model faults are
service failures; only bounded decode/no-face/multi-face/quality cases become
capture retry reasons. Reduced previews strip orientation/private metadata;
matching still returns only proposals from the supplied profile snapshot.

## Evidence and remaining work

Current Lovelies checks pass: **215 backend tests**, with seven explicitly
skipped optional environment scopes; **55 private ML tests** (including the
24-case real-model compatibility suite); **719 preserved pipeline tests and
10 subtests**, with one existing skip; **51 client tests**; and the
TypeScript/Deno backend build. The optional real OpenFace HTTP journey is run
separately and passes; it is not counted as a pass in the skipped aggregate row.
Independent source review identified the unauthenticated startup default,
verified its repair and rechecked the identity/authorization guards. This is
engineering review, not product recognition or release approval.

OpenFace's complete required `tools/check.sh` passes, including the independently
built 23-case still-package suite, shared core tests, portable Swift/Kotlin,
C++ math and gateway checks. Initial host-toolchain failures are preserved:
Command Line Tools lacked XCTest, the Kotlin command was absent from PATH, and
an old Gradle-based wrapper could not package its standard library. The complete
passing run uses installed Xcode, the existing full Kotlin 2.1.20 distribution,
JDK, CMake and isolated Python. No dependency was installed to hide a failure;
portable checks do not establish native camera or device acceptance.

The source-bound baseline, every intermediate attempt, final parity report, raw
check output and final input hashes are retained under
`verification/openface-integration-20261024/`. Reports contain scalar distances,
geometry and decisions, not raw images/vectors/templates/secrets. The tracked
fixtures derive from existing supplied portraits and their declared transforms;
three encodings do not represent three new optical captures.

The real HTTP journey uses the actual authenticated private service, actual
YuNet/SFace, signed API capture/completion and the existing Supabase application
engine. Its database is PGlite and Storage is the existing memory test adapter.
It proves local integration and authorization behavior, not hosted Storage,
multi-connection PostgreSQL, camera, threshold accuracy or distribution acceptance.

| ID | Implemented local scope / remaining evidence |
|---|---|
| LOF01 | Source/model/protocol baselines, additive branches and canonical engineering fixtures frozen. Store IDs and unknown/test data preserved; no customer import. |
| LOF02 | Separately built account-free wheel, shared versioned primitives and isolated still worker; generic default behavior retained. Exact source/wheel/model inventories and notices included. |
| LOF03 | Active consumer uses the pinned wheel for registration, returning comparison, replacement and photo candidates; superseded authority documentation corrected. |
| LOF04 | Seventeen permitted engineering inputs compare vectors/geometry/quality/task decisions. Explicit v2 reference boundary; no representative accuracy or universal legacy-compatibility approval. |
| LOF05 | Authenticated loaded readiness and exact identity/request binding in Supabase transport/Edge wiring. Wrong engine/model/reply/timeout denied; existing post-await guards retained. |
| LOF06 | Necessary MIME/size/profile/serialized-body alignment implemented. Maximum-payload Edge memory/CPU qualification remains on the actual target. |
| LOF07 | No forward schema change needed for this opaque-template slice. Hosted migration-history reconciliation remains required before any future db push. |
| LOF08 | Image recipe consumes the exact wheel while retaining patched native components. No new final container/scan is claimed. Choose host architecture; qualify a new native image, actual ABI/codec inventory and scan. Existing x86/Rosetta allocator failures remain unresolved in their original scope. |
| LOF09 | Local real-service signed enrollment/login and upload→candidate→review→accept→grant proof added to the existing harness. Actual PostgreSQL/Storage HTTP and hosted stale-state/retention/restore qualification remain. |
| LOF10–11 | Native source/contracts/UI unchanged by this slice. Existing client suite reused/refreshed as applicable; connected Android/iOS and affected physical-device evidence remain. |
| LOF12 | No hosted mutation. Private host/operator/region/architecture, secure Edge/scheduler/TLS configuration and operated restore remain inputs to a concrete later deployment. |
| LOF13 | Purpose-specific permissioned representative data and recorded threshold decisions remain. No PAD or extra committee requirement is added. |
| LOF14 | Physical devices, signed clean/in-place updates preserving com.lovelies.memories, enabled billing/push and authorized release remain separate. |

Repeat the local checks using the existing suites:

```sh
cd services/ml-face
uv sync --frozen --no-install-project
APP_ENV=local ML_USE_DETERMINISTIC_SIMULATOR=false .venv/bin/pytest -q tests/lovelies
cd ../..
RUN_OPENFACE_HTTP_TESTS=1 node --experimental-transform-types --test --test-concurrency=1 services/supabase-api/test/openface-http.test.mjs
pnpm backend:test
pnpm backend:client:test
pnpm backend:build
```

`RUN_OPENFACE_HTTP_TESTS=1` starts/stops its own loopback service and uses only
tracked engineering images. The ordinary backend aggregate marks this optional
real-native-model check skipped unless explicitly enabled; its separate execution
is recorded. Source-bound unit/contract fixtures do not substitute for that run.
OpenFace's required `tools/check.sh` includes its separately built package suite;
select its reviewed isolated Python and a permitted face fixture for model smoke.

No hosted runtime, function, database migration, provider action, remote/CI
destination or store release was changed by this local work. Local tests create
disposable synthetic accounts only.
