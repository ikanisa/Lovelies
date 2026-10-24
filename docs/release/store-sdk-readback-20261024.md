# Store SDK artifact readback — 24 October 2026

The current local artifacts satisfy the inspected SDK/version thresholds within the scope below. Final signed store packages, device behavior and console validation remain open.

| Artifact | Observed result | Scope |
|---|---|---|
| Android Debug APK `fcd89930…97ab0` | `com.lovelies.memories`, 2.0.0/code 18, minimum API 26, target/compile API 36; merged Billing metadata 9.1.0 | Actual packaged manifest |
| Same APK | All eight native libraries have every `PT_LOAD` alignment at least 16384; `zipalign -c -P 16 -v 4` passes | Debug APK ELF/ZIP inspection. This does not qualify the final AAB/generated APK set or a 16 KiB runtime |
| Unsigned iPhoneOS Release `2472f065…859e` | Xcode 27.1/build 27A9275, SDK iphoneos27.1/build 24A94232, minimum iOS 17 | Actual packaged `Info.plist` after banner/progress compilation; distribution signature, archive validation and device support remain separate |

Google requires API 36 for ordinary phone/tablet app updates from 31 August 2026. [Google target API requirements](https://developer.android.com/google/play/requirements/target-sdk).

Google's Billing support table ends version 7 update eligibility on 31 August 2026; versions 8 and 9 remain within their listed support periods. The APK's 9.1.0 metadata is therefore within that version threshold. [Billing deprecation timeline](https://developer.android.com/google/play/billing/deprecation-faq).

Apple requires Xcode 26 or later with the iOS 26 SDK or later from 28 April 2026 and a deployment target of iOS 13 or later from 9 September 2026. The inspected Release exceeds these minimums. [Apple upcoming requirements](https://developer.apple.com/news/upcoming-requirements/).

The native-library and ZIP checks follow [Google's 16 KiB guidance](https://developer.android.com/guide/practices/page-sizes). They do not waive the final candidate's own inspection or runtime checks. Existing live Android API 24 versus candidate 26 coverage remains an explicit replacement gate.

The raw badging, manifest, ZIP-alignment output and per-library hashes are preserved in `verification/supabase-release-20261023/store-sdk-readback-20261024/`. The latest iOS binary and SDK binding is `post-localization-ui/banner-progress-build/release-readback.json` under the same verification root. No SDK upgrade, dependency change, store upload or console setting was made by this readback.
