# Actual native backend consumer journey

This custom `android.app.Instrumentation` runner invokes the production
`CloudflareRepository`, Android Keystore, ContentResolver and FileProvider on an
Android runtime. Every API result comes from the declared local authority; there
is no successful mock transport, seed endpoint or client face matcher.

The current target is the Supabase application API with the authenticated private
OpenFace still consumer. Root's `createOpenFaceRuntime` fixture generator supplies
the existing portraits as `a0..a5.jpg`, `b0..b5.jpg` and `P1..P4.jpg`. Bind them for
both Android and Swift HTTP runners with:

```sh
node android/app/src/androidTest/prepare-openface-manifest.mjs \
  /absolute/path/to/fixture-directory http://127.0.0.1:18887
```

This writes `openface-native-journey.json` once, with inline hashes/byte sizes,
three byte-distinct enrollment encodings and a separate returning-login encoding
for each supplied portrait. Reusing a manifest requires the same checked bytes;
the generator never replaces an existing manifest. The files are packaged only
through the explicit `loveliesJourneyFixturesDir` test-assets property. These
inputs establish protocol/model consumer behavior. They are not three optical
captures, representative recognition, physical camera/device or release evidence.

The preserved historical Cloudflare fixture graph remains usable with an explicit
`expected_database=cloudflare_durable_object_sqlite` argument. Its test-owned
`native-journey-hashes.json` binds the old manifest when it lacks inline file
identities. The current default requires `supabase_postgresql`, a ready schema,
the expected API service and actual private inference readiness from `/ready`.

Root owns PostgreSQL/Storage/jobs/private inference, emulator startup, shared
builds and execution. With the isolated API on host port 18887:

```sh
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest \
  -PloveliesDebugApiUrl=http://10.0.2.2:18887 \
  -PloveliesJourneyFixturesDir=/absolute/path/to/fixture-directory
adb -s OBSERVED_SERIAL install -r app/build/outputs/apk/debug/app-debug.apk
adb -s OBSERVED_SERIAL install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s OBSERVED_SERIAL shell am instrument -w -r \
  -e lovelies_api http://10.0.2.2:18887 \
  -e fixture_manifest openface-native-journey.json \
  -e expected_database supabase_postgresql \
  com.lovelies.memories.test/com.lovelies.frontend.preview.NativeCloudflareJourney
```

The build/install/instrumentation commands run from `android/`, using one observed
root-selected emulator and an isolated disposable API state. Inspect installed
package signing/version before `install -r`; never uninstall/reset to obtain a
pass. The runner uses a fresh UUID directory and separate vault/key for each
synthetic actor. The default does not replace the app's normal endpoint vault or
touch any unknown journal. A custom fixture manifest can use the same schema and
different images/expected graph. The current graph is P1→Aline, P2→Aline+Eric,
P3→Eric, P4→Aline+Eric. Excluding P3 globally and P4→Eric individually approves
Aline[P1,P2,P4] and Eric[P2]: three distinct photos, two people, four pairs.

Success ends with `INSTRUMENTATION_CODE: -1` and a JSON
`native_cloudflare_journey` result containing the actual passed stages, approved
subsets, declared input hashes and scope. Any assertion/HTTP failure ends with
code 0 and an explicit failure result. No credentials, opaque face handles,
private keys or face templates are written to the trace.
Use `-r` to retain the raw structured result; the default shell formatter may
display only the human-readable stream. On a physical device, use an owned
`adb reverse tcp:18887 tcp:18887` mapping and pass
`-e lovelies_api http://127.0.0.1:18887`, preserving any existing mappings.

Each actor uses an isolated encrypted vault. `keep_owner=true` retains the
verified owner for actual native UI readback only when the debug APK's origin
exactly matches the test origin and no existing endpoint vault would be
overwritten. Successful retained-owner mode keeps recipient matching consent in
the isolated local fixture state so the actual graph remains reviewable, while
logging out recipients and removing their local vaults/signing keys. The result
explicitly records this retained consent. Failure or omitted keep-owner mode
disables test matching consent and clears credentials, signing keys and local
upload files. Source defaults and the screenshot UI remain unchanged.

The journey checks same-account automatic enrollment upgrade, old-session
denial, OTP unavailability, real queued source processing, actual sparse matches,
global/per-pair exclusions and zero selection, immutable preview/commit/original
key reconciliation, no access before acceptance, exact accepted preview subsets,
subscription-gated original download denial, logout fences, fresh registered-face
sign-in and one-use challenge replay denial. Returning login first sends a
header-only malformed JPEG, a plain-colour JPEG, a declared two-person photo and
the other supplied person's fresh encoding. It requires the distinct bounded
invalid-image/no-face/multiple-face/wrong-reference responses, the original
account/device/key and journal, zero credentials/private gallery access, and an
explicit new challenge before the eventual correct single-still comparison.

Existing `-e scenario enrollment-recovery`, `account-recovery`, `lifecycle`,
`camera-recovery` and `resumable-upload` run the corresponding real reply-loss
and encrypted-journal paths before this same sharing journey. Enrollment recovery
holds the original account/key across lost challenge/proof/completion replies;
lifecycle replacement binds the exact old profile and requires fresh comparison
after a lost committed reply; camera recovery checks actual no-face rejection
and a lost returning-login reply. Its wait uses the real signed challenge expiry.
Neither quality/error transport unit cases nor these static-image journeys
establish optical capture or recognition acceptance. Root records which scenarios
actually ran, exact service/artifact identities and their separately scoped result.

## Actual isolated Supabase Edge recipe

Run the following from the repository root. The owner first starts a new labelled
PostgreSQL/Storage fixture with
`node scripts/test-openface-local-services.mjs start /absolute/new-owned-services`,
or selects that tool's existing owned services and private bucket receipt.
The external real ML service must already be running with the exact image,
artifact and processing fingerprint pinned by `test-isolated-supabase-edge.mjs`.
Its independent service credential and loopback URL belong in an owned mode-0600
ML environment file; never put credentials in examples, app configuration or logs.

```sh
node --experimental-transform-types scripts/test-isolated-supabase-edge.mjs \
  --services-dir /absolute/owned-services \
  --output /absolute/new-api-attempt \
  --ml-env /absolute/private/ml.env \
  --fixtures-dir /absolute/frozen-native-fixtures \
  --port 18887
```

This runs the unchanged production entrypoint in pinned Edge Runtime v1.77.8
(`sha256:178c041398a33ded8219344382d0672a90051d1babbf0af03425cafe20039a75`),
using actual owned private Storage, authenticated real ML HTTP and a **new
PostgreSQL database**. It applies all five production migrations through schema
11: private core, refresh delivery, audience/retention, inference generation and
retention scan cursors. `--fixtures-dir` reuses and verifies the existing 19 JPEGs
and `openface-native-journey.json` without rewriting them. Wait for `runtime.json`
to report `status=ready`, schema 11 and actual inference readiness. The worker
uses **`per_request`, 256 MiB and 2,000 ms CPU**, with at most three workers
inside a bounded 1 GiB/one-CPU local container. Its configured 150-second worker
timeout is not an absolute HTTP deadline: this runtime resets it while requests
remain active.

Only the separate owner-qualified physical-iPhone HTTPS fixture needs
`--public-api-origin https://isolated-qa.example.com`; replace that reserved example
with the exact owned isolated host. This controls issued API URLs; it does not
create or deploy an HTTPS endpoint. Omit it for the loopback Android/Swift host
recipe. No hosted production Supabase mutation is performed by this runner.

Build both APKs with the same frozen fixture directory after source ownership is
released. For a physical Android device, compile
`-PloveliesDebugApiUrl=http://127.0.0.1:18887`. Root separately verifies application
ID, version and installed/new signing certificates, installs the selected frozen
APKs **in place** with `adb -s OBSERVED_SERIAL install -r -t ABSOLUTE_APK`, and
establishes/verifies its own `adb reverse tcp:18887 tcp:18887` mapping. Preserve
unknown app state and existing reverse mappings; never uninstall or clear data.
The checker performs none of those setup mutations:

```sh
python3 scripts/test-android-openface.py \
  --serial OBSERVED_SERIAL --api http://127.0.0.1:18887 \
  --config /absolute/frozen-native-fixtures/openface-native-journey.json \
  --app-apk /absolute/frozen-artifacts/app-debug.apk \
  --test-apk /absolute/frozen-artifacts/app-debug-androidTest.apk \
  --scenario main --output /absolute/new-android-attempt
```

Other supported scenarios are `camera-recovery`, `enrollment-recovery`,
`account-recovery` and `lifecycle`. Start a fresh API/database for each scenario,
keeping it alive across that scenario's process checkpoints. Fresh synthetic
actors declare `18_plus` through the production audience API/journal before
enrollment; returning/recovery authority is not replaced by a declaration.

The existing Swift host checker uses the same frozen config, for example
`python3 scripts/test-ios-openface.py --suite live --config ABSOLUTE_CONFIG --output NEW_OUTPUT`;
its other HTTP suites are `enrollment`, `profile` and `account`. Each gets its own
fresh API/database. These are macOS-host executions of Swift repository/HTTP
code. They do not establish iPhone app-hosted Keychain/Secure Enclave execution.
The separate opt-in physical iPhone XCTest passed on the selected iPhone 12 Pro,
using its own Keychain namespace and Secure Enclave key. It used declared still
fixtures through the actual HTTP boundary; optical capture remains separate.
Its receipt and completed post-test app-data comparison are recorded in the
integration checkpoint. The existing encrypted profile is byte-identical;
StoreKit timestamp and iOS scene/snapshot differences are retained separately.
The earlier locked preflight remains a cancelled attempt.

After each suite, root sends SIGTERM only to its owned API driver, then requires
`runtime.json` to report `status=stopped`, empty `changed_inputs` and
`changed_fixtures`, both owned containers absent, only the new database dropped
and the ownership lock released. Storage objects/volumes and failed evidence
remain preserved. Android receipts bind installed APK hashes, actual Keystore
operations and engineering stills; optical camera and recognition acceptance
remain separate. Consult the [integration checkpoint](../../../../docs/openface-integration-continuation.md)
for exact source/artifact-bound results rather than treating this recipe as
execution evidence.
