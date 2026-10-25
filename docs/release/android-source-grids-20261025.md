# Android source-photo grid qualification — 25 October 2026

The repaired reference grids pass the affected Debug checks. Lovelies remains
unaccepted for hosted deployment and store submission.

The supplied tower fragment on screen26 previously enlarged its generated people
badge with the image. Enlarged-text upload21 also exposed three latent filenames
whose bytes already contained selection markers. The repair uses the largest
marker-free rectangle of the same supplied image, with two source pixels of
padding, and fits it within the reflowed tile. Reflow markers stay at25dp for
people and27dp for selection. Exact-byte aliases share only marker geometry;
photo identities, selection state, callbacks and approved recipient subsets stay
unchanged. Already usable measured layouts retain their original geometry.

No supplied image bytes were edited or replaced. These reference fragments
remain their original resolution. This does not change uploaded private-media
processing or claim full-resolution source photographs.

## Qualified scope

| Check | Observed result |
|---|---|
| Non-incremental main/test/instrumentation compilation |197 JVM tests passed, zero failures/errors/skips;256 source, asset and build inputs unchanged. |
| Current Debug app |`6603feadedb9307d7cde916d9af0bc3869332eb5207ee02dd171524bf88397a5`. |
| Native journey test APK |`aa74ebd5b1e2d7623b7444030f6fa06cdc0b51122ccdc31362895b89cdda91d3`. |
| Accessibility test APK |`0a26bf2820057034a899da1666388ce9acf3e9ee512bc3afcb66ec9d069c8fc3`; the existing runner was selected through the documented Gradle property. |
| Grid consumers |Screens11,14,15,21,26,28,29,30,33 at1× and2× text: all18 cases passed the strict reachability/navigation checks, with no scroll cap or custom failure. Required actions were observed at48dp; preferences were restored. |
| Visual review |All29 original PNGs were inspected. Screen26 has a bounded people marker;21 aliases16–18 show one bounded selection marker. At2×,29/30 continuation is reached through the existing outer scroll. Measured33 keeps its seven original source fragments representing six logical photo IDs. |
| Native packaging |All eight JNI payloads match the previously inspected libraries; fresh APK ZIP offsets and `zipalign -P16` pass. Prior GNU_RELRO formula flags remain recorded. |
| Anonymous-deletion HTTP consumers |All12 checks pass with the current app/native-test pair against the actual Supabase handler and embedded PostgreSQL. Two pending fixture requests were archived and read back at schema11. |

The runtime used only the owned API36 ARM64 emulator with an actual16KB kernel
and both compatibility settings disabled. Its existing data was copied before
and after; there was no reset or uninstall. Full file-byte equality is not
claimed. The emulator was stopped and preserved. Other devices were untouched.
The combined Android/API runtime freeze retained342 unchanged inputs.

The deletion checks cover lost replies before dispatch and after commit,
production repository/Keystore rehydration in one instrumentation process and
protected-access fences. They do not establish recovery after process death or
the final independently operated erasure/rejection workflow. Historical test
strings mention Cloudflare/workerd; this run used the actual Supabase handler
over HTTP with embedded PostgreSQL, with no workerd/SQLite backend.

## Preserved evidence and limits

Receipts are under
`/Volumes/PRO-G40/Projects/Lovelies/verification/android-source-grid-reflow-20261025/`:

- `build-attempt2/result.json`:
  `38c8d583f27bd1024777ff4744abd74c34ad30bf0fc31a2dc829099e7bd6e8fa`.
- `native-packaging-readback.json`:
  `fed17cf12815c15a44cdfce8f8a52b963b78a95d0a24f95fad8b99823711b26e`.
- `runtime-attempt1/native-deletion-reconciliation.json`:
  `43ebb10d73520797c8dfb8c54d866379e9b0e199460a4cce0f0ae303be6bc632`.
- `runtime-attempt2/reconciliation.json`:
  `4a4bc26928d718cde7b76795af50b92a54ca9d85a5e8f8c8d861d1dc74425f71`.

The first build's source freeze changed during execution; its successful compile
is not current-source proof. The first runtime wrapper passed the12 native
checks, then failed because its accessibility component was not registered. That
wrapper remains failed; no UI credit is taken from it. The separately configured
runner and second runtime supply the18 current UI results.

These are Debug reference-screen and controlled HTTP checks. Spoken TalkBack,
connected age/guardian/private-media journeys, representative camera/model
behavior, signed AAB/generated APK sets, other ABI runtime and actual store
updates remain separate gates. Existing whole-workspace and hosted/store
acceptance remain false. GitHub billing is parked; no remote CI pass is implied.
