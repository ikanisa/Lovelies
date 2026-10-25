# Android 16 KB debug-artifact qualification — 25 October 2026

The selected native operations pass on an actual API 36 ARM64 emulator with a
16,384-byte kernel page size. This closes the selected Debug-library runtime
question. Final signed AAB/generated APK inspection and release-device behavior
remain open.

The exact installed APK was pulled back and matched SHA-256
`8afcc86047f955fb781e04c6bb47c553ef80506c5b0da6b531d904636629d6e5`.
The probe used the target application's class loader and existing Debug signing
identity. It exercised the packaged `androidx.graphics.path` native conic
conversion (18 calculated segments, 22 iteration results) and DataStore's native
shared counter (fresh value 0, increments/readback through 3). It deleted its own
temporary counter. No app dependency, Gradle input or product source changed.

The owned `lovelies-16k-20261025` AVD reported both
`bionic.linker.16kb.app_compat.enabled=false` and
`pm.16kb.app_compat.disabled=true`. Raw instrumentation completed with
`INSTRUMENTATION_CODE: -1` and a passing JSON result. The AVD was stopped and
preserved; no physical device, other AVD or ADB server was reset.

## Static flag and actual mappings

Earlier inspection of all eight packaged native libraries passes `PT_LOAD`
alignment/congruence and stored-ZIP 16 KB alignment; Build Tools 37.0.0
`zipalign -c -P 16 -v 4` also passes. The simple GNU_RELRO-end modulo formula
from [Android's page-size guidance](https://developer.android.com/guide/practices/page-sizes)
still flags the four 64-bit library payloads. That observation is preserved.

For the two ARM64 payloads actually executed, the loaded process maps confirm
separate 16 KB executable, read-only RELRO and writable data mappings directly
from the exact APK offsets. The writable bytes outside GNU_RELRO begin beyond
the rounded protection range; none overlap it. This matches the rounding behavior
in the inspected [Android 16 Bionic linker source](https://android.googlesource.com/platform/bionic/+/android16-release/linker/linker_phdr.cpp)
(blob `5967e2d48a29cbbaca8f87a2be42361ab43decd5`).

| Packaged ARM64 library | Stored ZIP offset | Rounded RELRO virtual range | First separate writable bytes |
|---|---:|---:|---:|
| `libandroidx.graphics.path.so` | `0xb58000` | `0x4000–0x8000` | `0x9fd0` |
| `libdatastore_shared_counter.so` | `0xb5c000` | `0x4000–0x8000` | `0x9428` |

This reconciles the selected ARM64 static flag with actual operations and memory
protection. It does not waive the final artifact's checks, qualify x86 execution,
or establish a Play submission verdict. An upstream version change is not made
solely to remove this formula flag.

## Preserved receipts and remaining gate

External evidence root:
`/Volumes/PRO-G40/Projects/Lovelies/verification/`.

- `android-16k-runtime-20261025-attempt1/result.json`: positive native operation
  output; cooked reporter omitted the expected completion marker, so the original
  `failed_or_unknown_native_probe` status remains.
- `android-16k-runtime-20261025-attempt2/result.json`: app-path precondition
  failed before the native probe. It remains `failed_or_unknown`.
- `android-16k-runtime-20261025-attempt3/result.json`: raw completion, exact APK
  readback, page-size/property readbacks and selected native operations pass.
  This run waited for full boot/package-service readiness and installed the
  immutable exact APK in the owned AVD when no persisted installation was found.
- `android-16k-runtime-20261025-attempt3/mapping-reconciliation.json`: exact
  ELF/ZIP offsets correlated with observed RELRO/data mappings, SHA-256
  `8b6805942c61f5a3cc5879a104dfba8153950fb0cc16f7357352a29849168821`.
- `android-16k-upstream-20261025/`: preserved official Maven candidates and
  Bionic source. Candidate download/inspection does not change the app graph.

Before upload, inspect the final signed AAB and its actual generated APK set,
preserve signature/version/package/SDK readbacks, run applicable 16 KB native and
app journeys on those artifacts, and retain the store's validation outcome.
