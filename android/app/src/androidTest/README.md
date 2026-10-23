# Actual native Cloudflare consumer journey

This custom `android.app.Instrumentation` runner invokes the production
`CloudflareRepository`, Android Keystore, ContentResolver and FileProvider on an
Android runtime. Every API result comes from the declared local authority; there
is no successful mock transport, seed endpoint or client face matcher.

The fixtures are the frozen JPEG inputs and `fixtures/android-journey.json` from
`verification/docker-native-journey-20261013`. They are packaged only through the
explicit `loveliesJourneyFixturesDir` test-assets property. The test-owned
`native-journey-hashes.json` binds that graph manifest and each referenced image.
SHA256 and byte sizes are checked before any image request. These inputs establish protocol/model consumer
behavior; they establish no camera-sensor or physical-person evidence.

Root owns the actual SQLite/R2/Queue/Worker/private Docker service lifecycle,
emulator startup, builds and execution. With the real isolated API on host port
18887 and the real model Docker adapter on 18888:

```sh
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest \
  -PloveliesDebugApiUrl=http://10.0.2.2:18887 \
  -PloveliesJourneyFixturesDir=/Users/jeanbosco/Documents/Lovelies/verification/docker-native-journey-20261013/fixtures
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w \
  -e lovelies_api http://10.0.2.2:18887 \
  -e fixture_manifest android-journey.json \
  -e keep_owner true \
  com.lovelies.frontend.preview.test/com.lovelies.frontend.preview.NativeCloudflareJourney
```

The example assumes commands run from `android/`, one root-selected emulator,
and a fresh API state. A custom fixture manifest can use the same schema and
different images/expected graph. The current graph is P1→Aline, P2→Aline+Eric,
P3→Eric, P4→Aline+Eric. Excluding P3 globally and P4→Eric individually approves
Aline[P1,P2,P4] and Eric[P2]: three distinct photos, two people, four pairs.

Success ends with `INSTRUMENTATION_CODE: -1` and a JSON
`native_cloudflare_journey` result containing the actual passed stages, approved
subsets, declared input hashes and scope. Any assertion/HTTP failure ends with
code 0 and an explicit failure result. No credentials, opaque face handles,
private keys or face templates are written to the trace.

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
sign-in and one-use challenge replay denial.
