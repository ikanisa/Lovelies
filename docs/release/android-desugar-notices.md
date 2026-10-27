# Android NIO desugaring notices — 26 October 2026

Status: **local notice preparation; release verification remains open**. This
record covers the two NIO desugaring components below. It is not a complete app
dependency inventory, a legal compliance determination, a corresponding-source
delivery record, a signed release-package check or evidence of publication.

## Observed components

The exact cached Maven artifacts were read without resolving or installing new
dependencies. Their SHA-256 hashes match the current compatibility-work inventory.
The runtime POM declares GPL version 2 with the Classpath Exception and depends on
the configuration component at version 2.1.5. The runtime JAR contains no
`LICENSE` or `NOTICE` entry. The configuration JAR contains executable adapters
as well as configuration material; its BSD notice must not be dismissed as a
build-configuration-only notice.

| Maven component | Artifact | SHA-256 |
| --- | --- | --- |
| `com.android.tools:desugar_jdk_libs_nio:2.1.5` | JAR | `d8044befae095781b9a80bf1faa92edc30382d75d437476784c1bf991598a976` |
| Same runtime component | POM | `1ba5db067a494d09f5c4a94f4cb4d58fc6fd33e0a55417e0e46d3b288328f3bc` |
| `com.android.tools:desugar_jdk_libs_configuration_nio:2.1.5` | JAR | `7db51661cd07d1fd5cf12769a75ba201910624bb3801c09363dd3cb28e31c51b` |
| Same configuration component | POM | `6e5e9ec6db8093d26c469c18b9231b033e670333a770852debda90c222fa4835` |

The artifact cache inspected was
`/Volumes/PRO-G40/Development/Gradle/UserHome/caches/modules-2/files-2.1/com.android.tools/`.
The versioned primary Maven metadata is available from Google's
[runtime POM](https://dl.google.com/dl/android/maven2/com/android/tools/desugar_jdk_libs_nio/2.1.5/desugar_jdk_libs_nio-2.1.5.pom)
and [configuration POM](https://dl.google.com/dl/android/maven2/com/android/tools/desugar_jdk_libs_configuration_nio/2.1.5/desugar_jdk_libs_configuration_nio-2.1.5.pom).

## Prepared notices

Three unmodified UTF-8 notice files were added only under
`android/app/src/release/assets/third-party/desugar-nio-2.1.5/`. No Debug or main
source-set asset was changed by this notice work. Whether the final signed AAB
and its generated APKs actually include these bytes remains a release check.

| Release asset filename | Exact source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `LICENSE-desugar-jdk-libs.txt` | Pinned Google `LICENSE`, including the Classpath Exception | 19,274 | `4b9abebc4338048a7c2dc184e9f800deb349366bdf28eb23c2677a77b4c87726` |
| `ADDITIONAL-LICENSE-INFO-desugar-jdk-libs.txt` | Pinned Google `ADDITIONAL_LICENSE_INFO` | 2,114 | `a69bce275ba7a3570af6579cb0f55682cd75fedfcd49e0e8e9022270c447c916` |
| `LICENSE-desugar-configuration.txt` | Verbatim `LICENSE` entry in the configuration JAR above | 1,491 | `68834f116f8ff545f05d14753357b620748156d60ee36b26beab4cb3f317efe4` |

The existing `web/terms/index.html` review draft now contains one Android
third-party section, component versions, pinned primary-source links and the
three full notice texts in expandable disclosures. The text content of each
notice was checked against its corresponding asset byte-for-byte after UTF-8
decoding and HTML entity decoding. It uses the existing Lovelies layout,
typography and styles; no new route, menu, script, inline style or public-file
allow-list entry was added. The existing native Terms consumer can use this
same page once the intended production edition is actually published and
verified.

All previous Terms content remains verbatim, including the review-draft status
and unresolved publication conditions. This work does not change the existing
policy edition, audience, consent, retention, subscription or support promises.
The draft's preparation date remains its original date; it is not an effective
date for the new notices.

## Source-preparation provenance

The runtime license texts were downloaded from the immutable Google source
revision `73170c345e6a762fc6a1f0301bb15218850023ef`:

- [Full runtime license](https://raw.githubusercontent.com/google/desugar_jdk_libs/73170c345e6a762fc6a1f0301bb15218850023ef/LICENSE).
- [Additional licensing information](https://raw.githubusercontent.com/google/desugar_jdk_libs/73170c345e6a762fc6a1f0301bb15218850023ef/ADDITIONAL_LICENSE_INFO).
- [Google 2.1.5 preparation revision](https://github.com/google/desugar_jdk_libs/commit/73170c345e6a762fc6a1f0301bb15218850023ef), which sets `VERSION_JDK11_NIO.txt` to 2.1.5 and associates `desugar_jdk_libs_configuration_nio:2.1.5`.

The companion [R8 preparation revision
`c331a820ddae7dea41f41a04375b784486d0f705`](https://r8.googlesource.com/r8.git/+/c331a820ddae7dea41f41a04375b784486d0f705%5E!/)
prepares configuration version 2.1.5 and records an input-archive SHA-1 pointer
`e4c206c7bdfe1415cd2716a1d59d699a80bc63dd` at
`third_party/openjdk/desugar_jdk_libs_11.tar.gz.sha1`. The archive contents have
not been retrieved or established here as complete source. The build script
reads a separate `desugar_jdk_libs_hash` inside the expanded input directory to
select Google sources, removes `DesugarDateTimeFormatterBuilder.java`, and
applies an R8 Undesugar transform. The historical SHA-1 is upstream provenance,
not a new security-hash choice or a completed source/build verification. The configuration notice copied here is the actual
JAR's BSD 3-Clause text, copyright 2016 the R8 project authors.

These references establish the upstream version association. They do **not**
establish binary/source equivalence, reproduce the delivered transformed library,
collect every applicable file-specific notice, or by themselves provide the
complete corresponding source and build material for Lovelies' delivered binary.

## Bounded checks completed

- Verified the four cached artifact hashes above; extracted the configuration
  notice directly from the identified JAR.
- Copied the pinned runtime license texts without editing their wording or line
  endings, and recorded their lengths and SHA-256 hashes above.
- Parsed the Terms HTML and confirmed all three inline notice texts exactly
  equal their asset texts; confirmed unique IDs and no script or inline-style
  addition. HTML character references preserve upstream trailing spaces without
  adding trailing source whitespace to the page.
- Removed just the added OSS section in memory and confirmed that the rest of
  the Terms file exactly equals the pre-change `HEAD` file.
- Read back HTTP 200 for the four primary-source links used in the Terms
  disclosure. This checks those upstream links, not Lovelies public hosting.
- `git diff --check` passes for the Terms edit. Original trailing spaces in the
  unmodified additional-license asset are intentionally retained for exact
  upstream identity; do not whitespace-normalize that vendored text.
- Frozen Terms handoff SHA-256:
  `db1dfaff27919c6ca724703326330490dacf5106929a7a5d83888628f4ac1fc1`
  (31,019 bytes). Re-freeze after any later edit.

No Android build, package extraction, device run, website staging/deployment,
store upload or legal approval was performed in this notice slice. Earlier
website manifests, hosted previews and Debug APK evidence do not validate these
new notice bytes.

## Source-material checkpoint, 26 October

The external preparation at
`/Volumes/PRO-G40/Projects/Lovelies/verification/android-desugar-source-20261026/`
retains the pinned Google runtime archive and all 9,124 regular files match its
Git tree. Its 31-file manifest SHA-256 is
`b89ac43d365e767d6569d025eedfca2c08939655307c34795aa651b3dcc14c22`.
The separate `companion-followup/` traces configuration 101→200 conversion,
API 33/API 34 generation controls, all 17 pinned source candidates associated with
the configuration JAR's 29 classes, and the JDK8/ASM conversion producer. Its
45-file manifest SHA-256 is
`7256e87c8fe805ce03c387e41d938500f5174883c1989e415a9ade5602794760`.
Both manifests were read back against their files; the original 31-file set is
unchanged. These are partial source/build candidates, not binary correspondence
or an operated source distribution. Complete inputs/toolchains, generated-output
comparison and recipient access remain below. The upstream JUnit conversion
check can upload artifacts on failure; it was not executed as an offline check.

On 27 October the two R8 input archives were retrieved without extraction or
running their scripts. Both match their recorded upstream SHA-1 pointers. The
implementation archive contains `desugar_jdk_libs_hash` equal to the pinned
Google source revision `73170c345e6a762fc6a1f0301bb15218850023ef`; its JAR has
SHA-256 `1e8cfabbfdef6d25b711ad298b6a808c6343d4bd3bf31c33d05b36764e4ed501`.
Compared by ZIP member with the selected Gradle runtime JAR, 1,431 members are
byte-identical, 28 common members differ and three entries occur only in the
archive JAR. The archives also contain the conversion inputs. This is useful
provenance, not proof that the archive JAR corresponds exactly to the delivered
transformed runtime or that the complete source-distribution gate is met.
The [pinned R8 undesugarer](https://r8.googlesource.com/r8/+/c331a820ddae7dea41f41a04375b784486d0f705/src/test/testbase/java/com/android/tools/r8/desugar/desugaredlibrary/jdk11/DesugaredLibraryJDK11Undesugarer.java)
describes an additional transformation and removal of two provider classes. A
local disassembly of one differing NIO class showed
identical displayed instructions but different class-attribute ordering; that
single-class observation does not establish equivalence for the other entries.
An independent local ASM implementation of the inspected transformation then
produced 1,459 class entries whose uncompressed bytes all match the cached Gradle
runtime; independent ZIP inspection found no duplicate names or CRC failures.
Its ZIP layout differs, and the locally selected JDK and ASM are not established
as the historical official toolchain. This strengthens class-member provenance
but does not establish an official build, complete corresponding source,
licence compliance or the contents of a final signed AAB.
Receipts and archive SHA-256 values are in
`/Volumes/PRO-G40/Projects/Lovelies/verification/android-desugar-source-20261026/archive-inputs-20261027/`.

## Remaining release gates

1. **Complete corresponding source and build material:** identify and verify the
   complete corresponding source for the actual delivered desugared runtime,
   including applicable upstream files, file-specific notices, interfaces,
   patches/generated adaptations and compilation/installation controls. Check
   the selected archive and build inputs against the actual artifacts. Retain
   the provenance, exact archive hashes and review result. The upstream links
   above alone do not close this gate.
2. **Distribution method:** establish and verify an appropriate, operated source
   distribution mechanism for the delivered release and applicable license
   requirements. Confirm actual recipient access to complete source/build
   material. No company written source offer or three-year fulfillment promise
   has been created by this work; quoting the upstream license does not create
   such an offer on IKANISA LTD's behalf.
3. **Final signed packaging:** on the exact release-signed AAB and generated APK
   set, verify dependency versions, any transformed/shrunk code and applicable
   notices; extract `base/assets/third-party/desugar-nio-2.1.5/` from the AAB and
   the corresponding assets from delivered APKs and compare the three notice
   hashes above. Reconcile the wider app SDK/license inventory separately.
4. **Public availability and access:** qualify the final public Terms edition,
   preserving historical policies; stage through the existing public-site
   allow-list, then verify HTTPS page content, headers, links, narrow-screen
   reflow, keyboard/assistive-technology access and the actual native Terms
   journey on the release candidate. Confirm notice/source access under the
   chosen distribution method. This local draft has not been published.
5. **Release readback:** include these results and outstanding source/legal
   review in N07/final release evidence. Do not mark the store replacement or
   SDK-notice gate complete from local text checks alone.
