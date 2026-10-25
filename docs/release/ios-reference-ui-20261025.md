# iOS reference UI checkpoint — 25 October 2026

The current round6 Simulator app, exact revision7 UI runner and unsigned device
Release compile with205 unchanged inputs. Strict ad-hoc Simulator signing passes;
181 app files and13 runner products are staged. Dylib `6ec5cd2f…bb1e2d` includes the
two confirmed visual corrections below and the native English/Kinyarwanda
availability message. Both translations were read back from the Simulator and
unsigned Release bundles. Independent source/app/runner qualification and one
in-place install now pass: all nine data payloads138,795bytes are retained and25
common selected nodes are exact. An identical2,172byte OSsnapshot was renamed;
native identity/timestamp/dataUUID changes remain recorded. Full pathname/native
metadata equality is false. No reset, uninstall, Keychain clear or retry occurred.
Affected runtime qualification is ongoing;
this checkpoint does not accept the replacement release.

The Favorites14 caller now retains its heart glyph when fixture metadata says
check. Only its explicit heart context changes; all default/checkbox metadata
cases retain the old result, with the same actions, geometry and image assets.
The complete caller inventory identifies14 as the sole explicit heart caller.
Check consumers11/21/29 have a separate unchanged-consumer source readback.

The other correction raises read-notification opacity from0.6 to0.8. Actual
normal12pt timestamp ink109/109/110 against9/9/11 measured3.849:1, below4.5:1;
the unread state measured9.181:1. The coordinator independently viewed the original
read image and recomputed the ratio. Read/unread distinction and all row/filter/
navigation bindings remain. The new rendered colour still needs runtime readback.

Current build receipts/source archive are in
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-grouped-ui-round6-20261025/`.
`build-result.json` SHA256 is
`4c393ca6712bd850238eefc8612f3996f3ca0d3803fa4379c9a94122fb0fe853`;
`runtime-handoff.json` is
`42e3b70ea122f473cbdfb380525987f9c281ba7956841e157667a6e69c835975`.
The single QA source is `c9-candidate/revision7-bounded-followup/LoveliesFrontendAudit.swift`,
SHA256 `fd37ced7289a03e2ba99dcd1f69972cc5397e451cb5c1d8005ab83253bd1da87`.

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
the same. Normal/largest12 and the actual people action to27 and Back now qualify
that correction. Both automated variants report zero native/custom findings;
normal has a44×44pt target and maximum67.67×50.67pt. Actual native actions12→27→12
retain Photo1 and the whole `+3`. The iOS owner reviewed all five original PNGs;
the coordinator independently reviewed all three manual transition images.
This accepts the count correction within reference mode.

| Evidence | Qualified scope |
|---|---|
| Round5 build |205 unchanged inputs,20 app Swift files plus GeneratedAssetSymbols,181 staged app files,13 runner products; strict deep ad-hoc Simulator signature passes. Simulator dylib `4dede123…b436d`; unsigned Release executable `d145183e…82bee`. |
| Round5 install/runtime |One app-only update; all nine current regular-file payloads138,795bytes retained and25 common selected nodes exact. An identical OSsnapshot was renamed and two empty OSsnapshot directory nodes disappeared, with their preimages retained. Full pathname/native-metadata equality is false. Smoke and both count12 variants pass; the actual people/Back actions are verified. |
| Earlier round4 upload runtime |Maximum-text21/22/23 native/custom checks pass. All18 exact photo targets on21 were reached at44pt with no unsampled target interval; the two prior23 clipping findings are absent. Normal21/22 pass; normal23 retains two raw Dynamic Type warnings. |
| Earlier round4 keyboard runtime |15/22/45 pass; each focused field is above the keyboard. These retain their exact round4 artifact bindings. |
| Earlier round4 install preservation |One app-only update; all13 regular-file payloads3,905,137bytes retained and31 common selected nodes exact. One identical OSsnapshot was renamed. Full pathname/backup-native-metadata equality is false and explicitly reconciled. |

The earlier source-bound70 switch-position probes and20 translated-control
checks retain their unchanged-consumer evidence. The iOS owner keeps the raw
onboarding/gallery contrast, clipping and Dynamic Type findings unwaived while
examining paired source/raster evidence. Fresh and reused results are not a
passing full48-screen matrix. Spoken VoiceOver and connected/device/provider
journeys remain separate requirements.

The preserved round5 evidence now covers48/48 normal and48/48 largest screens:
25/26 fresh cases and23/22 qualified reuse respectively. Custom findings are zero,
while11 normal and10 largest raw native failed rows remain. This is coverage,
not a passing aggregate. Actual maximum31 recipient toggles/restore and33/Back31,
normal39 block/prune/unblock without automatic reselection, and18→24→18 have
separate checkpointed/manual evidence.

The first bounded QA run failed because a semantic container was selected instead
of the outer recipient button. Revision6 completed the main phases but failed its
last reselection because an artificial1pt viewport inset excluded the top edge.
Both complete runs remain failed. Original captures/checkpoints and direct manual
completion retain only their stated scope. Revision7 corrects those test selectors
and the artificial inset, retaining actual44pt frame/intersection assertions;
its current-app runtime is pending. No audit category or raw finding is waived.

The exact frozen Swift QA source is retained at
`verification/accessibility-navigation-20261023/ios-isolated-simulator/c9-candidate/revision4/LoveliesFrontendAudit.swift`
(SHA256 `cef012a6a4a9d373ec6e91e27dfc50c8c8dcf967de437eb9dc4ec64c6e3979da`).
Its strict target/scroll assertions and audit findings are preserved.

`scripts/build-ios-ui-audit.py` now generates the runner project from tracked
templates and compiles one archived, SHA256-pinned Swift source. The canonical
command passed an actual runner-only compile with four unchanged inputs and13
products. Black-box CLI probes reject an existing output directory and a wrong
source pin without overwriting the preserved marker or creating the refused
output. Receipts are in
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-ui-runner-canonical-20261025/`.
See the [runner command](../../ios/README.md). This closes the local project-source
dependency; runtime/device and independent CI qualification remain separate.

Round5 compile/staging receipts and recoverable source archive are under
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-grouped-ui-round5-20261025/`.
`build-result.json` SHA256:
`b911b5d0c13adb92db0c8f9c8ad84c9ecb0a923f8217b5e4240f5339519773ba`.
The five-View freeze and round4 runtime/preservation receipts remain in
`verification/accessibility-navigation-20261023/ios-isolated-simulator/grouped-ui-fix-20261025/`.
The round5 count result is `round5/4dede-count12-reviewed.json`, SHA256
`9c283a863747c27d4aceb6b667c06da1e0a2091d407df4624cd93914a568ceb2`.

The release preflight still reports six gates: the approved published link host,
four public policy/support/deletion URLs and a valid distribution signature.
The uploaded-build maximum14 is a23October observation requiring refresh before
upload. No store upload, review submission or live replacement is established.
