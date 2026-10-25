# iOS reference UI checkpoint — 25 October 2026

The current round8 Simulator app, unchanged revision7 UI runner and unsigned
device Release compile with 205 unchanged inputs. Strict ad-hoc Simulator signing
passes; 181 app files and 13 runner products are staged. Dylib `b7621c52…050d9e`
contains stable custom-action names and explicit primary photo-action semantics.
Independent qualification, one preserved app-only update and bounded normal/
largest named-action checks pass. A separate revision8 runner-only test now
qualifies one maximum-text filtered-photo coordinate-touch journey. No
distribution, hosted, physical-device, spoken or store acceptance follows.

Photo browsing and nonempty/filtered search now announce “Open photo”, including
selected results. Three upload/sharing fallback callers explicitly select
“Change photo selection”; the other nine Masonry callers keep opening semantics,
with separate favorite/check badge callbacks retaining their stable action names.
The mismatch was observed on round7: the selected Photo2 search result announced
selection but actually opened viewer12, with four favorites unchanged after Back.
The approved three-file correction preserves callbacks, images, geometry,
selection values/traits, badge labels and view identity. SourcePhotoGrid is byte
identical to round7. Absent-reference-layout branches are source-scoped only;
they have no manufactured runtime acceptance.

Current build/source archive:
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-grouped-ui-round8-20261025/`.
`build-result.json` SHA256:
`4a48f5685f480a249cfc88cdd5830a93438ccae799e97af1a2372e2d50773dd0`;
`runtime-handoff.json`:
`d7be8fd44b0129f53179c29be50333d0898177c1585500ea89e3ebfb0e940449`.
The five-View freeze is `round8/next-grouped-ui-freeze.json`, SHA256
`461779cf7ce8b4861af72ada7d5745da8ed2d919d9b6ef86ff330eb8b78ea2f4`.
The exact QA remains `c9-candidate/revision7-bounded-followup/LoveliesFrontendAudit.swift`,
SHA256 `fd37ced7289a03e2ba99dcd1f69972cc5397e451cb5c1d8005ab83253bd1da87`.
Only Components, SharingViews and UploadViews differ from round7; 199 app-relative
inputs, the QA source and all locale bytes are unchanged. Exact current 16 Swift
host, 87 API, 49 Swift HTTP and 257 Android input maps qualify reuse of their
existing results. `unchanged-source-reuse.json` SHA256:
`c3ca9faedcac76c49f91d07dcbcf0616374bdbc5f7a89d129efac29e1914d856`.
`primary-action-consumer-readback.json` independently classifies all 12 callers,
SHA256 `bf627be5396c9a9c4e772b7f2f270c814d462246662a9831e0f6cbdec07b7da2`.
English/Kinyarwanda stable-action and availability strings remain packaged in
both bundles, matching round7 exactly.

Round7 independently qualified its app/runner and one in-place update. All nine
regular data payloads (138,795 bytes) were retained and 25 common selected nodes
matched exactly; an identical OS snapshot was renamed. Full pathname/native
metadata equality is false, with no reset, uninstall, Keychain clear or retry.
Its terminal bounded proof passes four actual normal/largest favorite/checkbox
physical and custom-action toggle/restore probes, plus photo5→viewer12→Back at
both sizes. All 15 original PNGs were reviewed. A visible maximum-text notification
was opened and returned to as read, measuring 6.078:1 timestamp contrast; no new
native audit or waiver of the earlier offscreen warning is inferred. Receipt:
`round7/3c75-bounded-action-runtime-reviewed.json`, SHA256
`b50b8d1b22555e0bb6df851b3c711a851b5480504ae743d4da3d40c5e2847357`.
These unchanged SourcePhotoGrid/geometry/notification results retain their scope.

Round6 likewise preserved all nine regular payloads and 25 common nodes. Its
focused normal14/largest14/normal18 and six-probe functional follow-up pass;
all 26 original PNGs were reviewed. Largest18 retains its raw native offscreen
contrast warning and failed run status, with zero custom findings. The earlier
48/48 normal/largest coverage remains coverage rather than an all-pass matrix.

The separate maximum-text test09 passed on its first execution in58.214seconds.
Eight bounded40pt/s drags moved Photo2 from offscreen into the actual viewport,
with a fully visible114.67×152.33pt enabled/hittable target at
[19,676.33,133.67,828.67] inside [0,0,390,844]. A coordinate center tap opened
viewer12; a44pt Back tap returned to15 with all four Selected values preserved.
All five original PNGs were reviewed. The earlier manual action probe had not
established visibility; this native touch test closes that specific uncertainty.
The app is restored to normal English/portrait/Home10 with keyboard off.

The additional runner compiles one archived source with four unchanged inputs
and13 products. Revision8 SHA256:
`0d6af26b623f72b5fa70d6fda76e7552e46312a3f5a60d85eab354879cb60a6c`.
Its124 added lines introduce only test09 inside the existing class; every prior
line/method remains unchanged. It overlays the independently qualified b762 app
without another app build/install. Compile receipt:
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-ui-filtered-search-runner-20261025/result.json`
SHA256 `d035e39cde34a5b924665d154cb5ce6749ce75b8dcc7a1830b3393c61d157800`.
Physical-case review: `round8/b762-filtered-physical-runtime-reviewed.json`,
SHA256 `24bebf04663a06db43b322f9e8498634b3eb2b474a6e09e97cab6f6c84d1ca8a`.
The separate seven-original named-action review is
`round8/b762-bounded-action-runtime-reviewed.json`, SHA256
`31ab9e17b91821c73e8b0e714992bdce540f78c8ab2a6ac8c2c137a509c3fa7e`.
No full matrix or native audit was replayed and no raw adverse finding is waived.

The current install retained all seven pre-install regular payloads135,123bytes
and22 common selected nodes; one identical2,172byte OSsnapshot was renamed.
Full pathname/native-metadata equality is false. The earlier9→7 transition
occurred before this install: two scene-session files were absent and
KnownSceneSessions changed1,248→42bytes. Other selected nodes matched and all
old payloads remain verified in preimages. The actor/exact time is not attributed.
`round8/install/prior-runtime-saved-state-transition.json` SHA256:
`1a46724069b4cb73bd3b78dcc090fc5b3534b0c944baf9815ad59e65f18e2929`.
No reset, uninstall, Keychain clear or app-install retry occurred.

The Favorites14 caller now retains its heart glyph when fixture metadata says
check. Only its explicit heart context changes; all default/checkbox metadata
cases retain the old result, with the same actions, geometry and image assets.
The complete caller inventory identifies14 as the sole explicit heart caller.
Check consumers11/21/29 have a separate unchanged-consumer source readback.

The other correction raises read-notification opacity from0.6 to0.8. Actual
normal12pt timestamp ink109/109/110 against9/9/11 measured3.849:1, below4.5:1;
the unread state measured9.181:1. The coordinator independently viewed the original
read image and recomputed the ratio. Read/unread distinction and all row/filter/
navigation bindings remain. The actual new read timestamp is142/142/143 against
9/9/11, measuring6.078:1 across549 ink pixels; the unread timestamp remains9.181:1.
The coordinator independently viewed the original read capture and recalculated
the ratio. This confirms that normal12pt repair without waiving the separately
retained largest18 offscreen native warning.

Preserved round6 build receipts/source archive are in
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
separate checkpointed/manual evidence and the later passing round6 six-probe run.

The first bounded QA run failed because a semantic container was selected instead
of the outer recipient button. Revision6 completed the main phases but failed its
last reselection because an artificial1pt viewport inset excluded the top edge.
Both complete runs remain failed. Original captures/checkpoints and direct manual
completion retain only their stated scope. Revision7 corrects those test selectors
and the artificial inset, retaining actual44pt frame/intersection assertions;
its round6 runtime passes154.68s with six functional probes and native read-audit
zero. Maximum31 person selection/restore/Continue→33→Back, normal39 block/prune/
unblock without automatic reselection, and normal18→24→18 unread-to-read were
observed. No audit category or raw finding is waived.

The historical matrix base Swift QA source is retained at
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
