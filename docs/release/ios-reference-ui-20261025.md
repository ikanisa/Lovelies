# iOS reference UI checkpoint — 25 October 2026

The five frozen View files compile in the round5 Simulator app, exact one-file
UI test runner and unsigned device Release build. Current runtime qualification
is still in progress; this checkpoint does not accept the replacement release.

The changes retain Lovelies imagery, branding, existing actions and source-photo
identities. Reflow uses an unobscured rectangle of the same supplied image,
bounded markers and numeric photo labels. Larger text receives full-width upload
details, readable selection headers, scrolling sharing/review content and
separate preference labels above the native switch. Switch padding preserves
UIKit semantics and the existing preference binding.

Visual review found the fixed44pt viewer count rendering `+3` as an ellipsis at
maximum text, despite a passing automated audit. Round5 gives that text intrinsic
space,8pt horizontal padding and44pt minimum dimensions. Its capsule retains the
normal44pt circle and can grow with the text. The label, action and colours stay
the same. Fresh normal/largest12 captures and the actual44pt people action to27
and Back remain required before closing that correction.

| Evidence | Qualified scope |
|---|---|
| Round5 build |205 unchanged inputs,20 app Swift files plus GeneratedAssetSymbols,181 staged app files,13 runner products; strict deep ad-hoc Simulator signature passes. Simulator dylib `4dede123…b436d`; unsigned Release executable `d145183e…82bee`. |
| Earlier round4 upload runtime |Maximum-text21/22/23 native/custom checks pass. All18 exact photo targets on21 were reached at44pt with no unsampled target interval; the two prior23 clipping findings are absent. Normal21/22 pass; normal23 retains two raw Dynamic Type warnings. |
| Earlier round4 keyboard runtime |15/22/45 pass; each focused field is above the keyboard. These retain their exact round4 artifact bindings. |
| Earlier round4 install preservation |One app-only update; all13 regular-file payloads3,905,137bytes retained and31 common selected nodes exact. One identical OSsnapshot was renamed. Full pathname/backup-native-metadata equality is false and explicitly reconciled. |

The earlier source-bound70 switch-position probes and20 translated-control
checks retain their unchanged-consumer evidence. The iOS owner keeps the raw
onboarding/gallery contrast, clipping and Dynamic Type findings unwaived while
examining paired source/raster evidence. Fresh and reused results are not a
passing full48-screen matrix. Spoken VoiceOver and connected/device/provider
journeys remain separate requirements.

The exact frozen Swift QA source is retained at
`verification/accessibility-navigation-20261023/ios-isolated-simulator/c9-candidate/revision4/LoveliesFrontendAudit.swift`
(SHA256 `cef012a6a4a9d373ec6e91e27dfc50c8c8dcf967de437eb9dc4ec64c6e3979da`).
Its strict target/scroll assertions and audit findings are preserved.

Round5 compile/staging receipts and recoverable source archive are under
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-grouped-ui-round5-20261025/`.
`build-result.json` SHA256:
`b911b5d0c13adb92db0c8f9c8ad84c9ecb0a923f8217b5e4240f5339519773ba`.
The five-View freeze and round4 runtime/preservation receipts remain in
`verification/accessibility-navigation-20261023/ios-isolated-simulator/grouped-ui-fix-20261025/`.

The release preflight still reports six gates: the approved published link host,
four public policy/support/deletion URLs and a valid distribution signature.
The uploaded-build maximum14 is a23October observation requiring refresh before
upload. No store upload, review submission or live replacement is established.
