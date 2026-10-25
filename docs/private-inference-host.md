# Lovelies private inference host

25 October 2026 checkpoint. Implementation and qualification are in progress. The deployed
HTTPS gateway is authenticated and deliberately denies inference until an
accepted immutable native image is bound to its release receipt. A completed
native AMD64 minimized V1 is privately preserved with scoped runtime evidence.
The corrected consumer now passed its native 55-case suite, separate 35 fixtures,
worker lifecycle, six runtime modes and minimization scopes. Its fresh raw scan
still denies the High threshold; exact technical dispositions permit scoped local
engineering use. The earlier PostgreSQL/Storage/native-model HTTP journey passed
7/7. Later qualification uses the actual Supabase Edge handler, isolated schema
11 and private Storage with this same pinned image, including physical Android
and iPhone execution. See the [continuation checkpoint](openface-integration-continuation.md)
for source-bound results and remaining readback. **No image is accepted and
production serving remains disabled.**

## Selected deployment

Use Cloudflare Containers in the existing Ikanisa account
`2209b915a85b1c11cee79b7806c6e73b`, with EU jurisdiction, WEUR placement and
`linux/amd64`. This fits the existing service adapter's 12 MiB face and 40 MiB
photo body limits without adding an application account authority. The observed
Supabase project database region is AWS `eu-west-1` (Ireland). WEUR is a region,
not a promise of a particular city; the temporary native builder was observed
in `lis01`. Worker HTTPS ingress is Cloudflare's edge network and must not be
represented as exclusively Ireland-resident processing.

The inference gateway is
`https://lovelies-supabase-inference.ikanisa.workers.dev`. Its deployed disabled
version is `223c6f07-079e-4364-9de1-67c8b5a99bc4`. Missing/wrong credentials
return 401; authenticated readiness/face requests return 503 with
`inference_release_not_accepted`. Readback is retained in
[`disabled-inference-host-attempt2`](../verification/openface-integration-20261024/continuation/disabled-inference-host-attempt2/).
No inference Container application was created by that bootstrap deployment.

Supabase remains responsible for custom accounts, sessions, consent, profile
revisions, jobs, Storage, review, recipient acceptance and grants. This host has
one independent service credential. It receives neither Supabase database or
Storage credentials nor an application session issuer. It cannot discover or
invent recipient profiles. The historical `lovelies-ml-gateway` Worker,
Cloudflare application backend and other account applications are separate and
were not replaced.

## Source and runtime boundary

- [`supabase-inference.ts`](../services/ml-container-worker/src/supabase-inference.ts)
  admits authenticated `GET /ready`, `POST /internal/face` and
  `POST /internal/photo` only. Bodies and replies are bounded streams; redirect
  following and inference replay are disabled. The outer deadline is 55 seconds.
- [`wrangler.supabase.jsonc`](../services/ml-container-worker/wrangler.supabase.jsonc)
  prepares one Container, 1 vCPU, 3 GiB memory, 8 GB disk, maximum one instance,
  five-minute idle shutdown, no Internet egress and no SSH for serving.
- [`prepare-inference-host.mjs`](../scripts/prepare-inference-host.mjs) creates a
  new **disabled** configuration and a source-bound preparation receipt. It
  does not deploy, push an image, write a secret or enable inference.
- Recognition uses the separately pinned account-free `openface_still` wheel
  through Lovelies' existing still-image HTTP contracts. No PAD/video route,
  generic OpenFace authentication account or global index is enabled.

Private operator configuration stays in mode-0600 task files. Do not paste
credentials into chat, source, client configurations, telemetry or release
receipts. The Supabase API owner owns the eventual server-only binding/cutover;
the inference owner owns the service secret, immutable image, loaded capability
identity and authenticated service evidence.

## Native artifact qualification

The minimized native V1 has AMD64 registry manifest
`sha256:185bb04257150bc9f831f638dfe60fec60d185df903d487a2df4be7dfca476ef`,
config `sha256:ed47ab9a07dc48c942d2aedd11b11dfb8f355cc902e174f6e9d3592a5e4d3423`
and source OCI index
`sha256:e77d001aaee0aa7069cd41625a299805bd33009804ac3d65930751118f483dc3`.
Its [actual qualification](../verification/openface-integration-20261024/continuation/native-final-preserved1/native-artifacts/evidence/native-final-qualification2/receipt.json)
passed the existing 55-case suite, actual worker lifecycle, six runtime modes
and exact verification of 1,347 absent/161 unchanged retained paths. Its
[image graph proof](../verification/openface-integration-20261024/continuation/native-final-preserved1/native-artifacts/evidence/native-final-image-binding1/proof.json)
and [private publication receipt](../verification/openface-integration-20261024/continuation/native-final-preserved1/native-artifacts/evidence/native-final-publication1/receipt.json)
retain distinct manifest/config/index identities and `final_image_accepted=false`.
The native glibc/OpenSSL results below remain component evidence. The earlier
24-case comparison is included in 55; it is not 79 distinct cases.

The corrected consumer has source OCI index
`sha256:761c0861c4fe901d1eb437c8289093c2c5f749df42f5c7270cba9ee372774b95`,
config `sha256:3e2baafacee7ccfe306f9c76a9c29fae738542b68742a34f91903ba899d8a4b0`
and AMD64 manifest
`sha256:982e2ed7bb66b17db17979495495892579f1b734c55d93516a2aeedbf70e1c6c`.
Its [actual native qualification](../verification/openface-integration-20261024/continuation/native-consumer-preserved-20261025-snapshot1/native-artifacts/evidence/native-consumer-final-qualification2/receipt.json)
passed the original 55 cases, separate 35 fixtures, worker, six modes and
1,347/161 verification.
Its consumer fingerprint is
`e5366532fe94660257f2228e59e5d6032fd35d45ee41733d82c84aee440a26fa`;
the native inventory contains 441 ELF objects/492,179,269 bytes.

V1's `28fb0d72…` fingerprint does not hash native payload bytes. The 25 October
two-file consumer repair adds exact native ELF/OS/CPU/ABI identity and strict
mapped-library validation, denies missing Linux mappings and closes an owned
runtime on later initialization failures. The helper also normalizes only the
exact four-source-hash-bound OpenCV loader bootstrap; foreign overrides remain
denied. Root passed 35 native identity/cleanup/bootstrap fixtures and 11 producer
fixtures; the 35 also passed inside this native image. The intermediate pinned
OpenCV loader collection failure is preserved in the continuation record.
The [new raw scan](../verification/openface-integration-20261024/continuation/native-consumer-grype-20261025-attempt1/receipt.json)
records 171 rows/75 IDs, zero Critical, 60 High rows/15 High IDs, zero ignored
matches and exit 2/DENY. Its engineering disposition, immutable preservation and
current integration evidence are recorded below.
The [exact security disposition](../verification/openface-integration-20261024/continuation/native-security-disposition-20261025/README.md)
permits **ALLOW_SCOPED_LOCAL_ENGINEERING_CANDIDATE**: all 60 High rows/15 IDs
are mapped to 40 omitted affected payloads, four unaffected retained UUID rows
and 16 exact fixes/component-specific N/A cases. Zero unreviewed Critical/High
rows remain. The other 111 rows, including Unknown, remain outside that policy.
The raw High threshold is still DENY/exit2; no suppression or package/scan rewrite
was used, and final image/production serving remains unaccepted.

The [actual publication/readback](../verification/openface-integration-20261024/continuation/native-consumer-builder-20261025-attempt1/publication.stdout)
preserves the unaccepted immutable image at:

```text
registry.cloudflare.com/2209b915a85b1c11cee79b7806c6e73b/lovelies-inference-native@sha256:982e2ed7bb66b17db17979495495892579f1b734c55d93516a2aeedbf70e1c6c
```

Its config matches the qualified artifact; temporary registry authentication
files were absent. The [current integration receipt](../verification/openface-integration-20261024/continuation/native-consumer-builder-20261025-attempt1/api-real-native-http-receipt.json)
records 7/7 passing, zero skips and unchanged inputs through actual private
Storage/PostgreSQL and faithful native model HTTP over authenticated SSH.
The production handler's Node loopback bridge does not establish actual Deno
Edge, production TLS, physical capture or recognition-accuracy acceptance.
The [final evidence copy](../verification/openface-integration-20261024/continuation/native-consumer-preserved-20261025-snapshot2/receipt.json)
verifies 239 manifest rows. The temporary builder is
[inactive](../verification/openface-integration-20261024/continuation/native-consumer-builder-20261025-attempt1/provider-after-stop.json)
and its authenticated start/input window expired. The native HTTP container and
relay stopped with absence/child cleanup confirmed; generated HTTP/registry
credentials were removed. Labelled local PostgreSQL/Storage volumes remain
preserved. Fresh current-generation Edge exact-40-MiB and cap-plus-one cases
also passed under the actual 256 MiB / 2,000 ms supervisor, with unchanged inputs
and completed cleanup. Those synthetic resource checks do not extend the
seven-case journey to production TLS or aggregate full-API resource acceptance.

Templates from earlier fingerprints
must be denied, never relabelled. Exact frozen source hashes and prepared
qualification inputs are in the [continuation checkpoint](openface-integration-continuation.md#25-october-checkpoint).

The earlier tested supplemental image
`sha256:1cd0babb79c7ab27b25e3fc6a30bd28cd06d10fc1661ca254c7ac9315850ede5`
proved real model and private HTTP integration. Its fresh artifact-specific scan
fails the High threshold (218 rows, 122 advisory IDs, including five Critical
and forty High IDs). Its earlier Rosetta glibc record also retains two failing
allocator fixtures. It is **not accepted for serving**.

The preserved 24 October native first pass uses pinned CPython 3.13.17, Pillow 13.0.0, current
Debian HEIF 1.23.6 security packaging, retained native backports and the
source-built image-only OpenCV artifact. The canonical producer completed its
`security-runtime-unminimized` stage at approximately **12:46 UTC** with the
frozen source context and explicitly validated resumed/recovered inputs. Source
preparation, dependency selection and notices do not qualify the final image. The changed Pillow
version also changes the processing fingerprint: existing templates must not
be relabelled to that identity.

The [producer result](../verification/openface-integration-20261024/continuation/native-firstpass-image-attempt1/native-artifacts/evidence/native-run-oci/result.json)
and [locally retained 16-file evidence set](../verification/openface-integration-20261024/continuation/native-firstpass-image-attempt1/native-artifacts/evidence/firstpass-scan1/files.json)
bind the native build. The first pass is **1,779,183,938 bytes / 49 layers** and
has image-configured **UID 0**; nonroot runtime qualification is separately run
with explicit UID 10001. Its identities remain distinct:

| Identity | Value |
| --- | --- |
| Source OCI index | `sha256:17816cfa79b09b6ed202d3a24e783dd99451967416720fe171c7274980ada4d9` |
| Selected AMD64 manifest | `sha256:4627246d3bb32668ebecb385f0bee237060ac0c330ab660322aebe16b6a3a93e` |
| Config / Syft-Grype image ID | `sha256:16f85adceda62de0dd0db015e369d11994ae028d8845d2916df0eca055c15fee` |
| Loaded Pillow 13 processing fingerprint | `28fb0d7272abd8c9806cf82a04e349c5d83cca5d69388de0d9731f8c09fd4479` |

The [verified registry receipt](../verification/openface-integration-20261024/continuation/native-image-publication-unminimized2/receipt.json)
preserves this **unaccepted technical preimage** at:

```text
registry.cloudflare.com/2209b915a85b1c11cee79b7806c6e73b/lovelies-inference-native-unminimized@sha256:4627246d3bb32668ebecb385f0bee237060ac0c330ab660322aebe16b6a3a93e
```

Publication/readback succeeded and the temporary registry configuration was
removed. Neither the serving configuration nor Supabase traffic changed. The
[independent index/manifest/config/rootfs proof](../verification/openface-integration-20261024/continuation/native-builder-execution/image-binding1/stdout)
links this URI to the original image and unchanged SBOM identity; a config ID
was not substituted as a registry manifest digest.

Fresh native glibc **27/27 fixtures**, allocator/TLS profiles, **279 runtime files
and 14 public ABI libraries** are bound by the
[component receipt](../verification/openface-integration-20261024/continuation/native-builder-artifact-attempt2/verified-native-receipt.json).
The [fresh full OpenSSL 3.5.9 log](../verification/openface-integration-20261024/continuation/native-session-preserved-1310/native-artifacts/evidence/session-preserved-1310/upstream-tests.log)
reports **347 files / 4,932 checks passing**. The earlier Rosetta failures remain
retained and are not overwritten by these new native results.

The new [first-pass raw Grype scan](../verification/openface-integration-20261024/continuation/native-firstpass-grype-attempt1/consumer-grype.json)
reports **171 rows / 75 advisory IDs, zero Critical, 60 High rows / 15 High IDs**,
zero ignored matches and **exit 2 / DENY**. Its
[High applicability review](../verification/openface-integration-20261024/continuation/native-firstpass-high-applicability.md)
separates proposed implementation removal from retained-payload evidence. It does
not suppress findings or waive GCC header-template/compiled-consumer scope.

The [locally verified 230-file runtime archive](../verification/openface-integration-20261024/continuation/native-session-preserved-1316/receipt.json)
is **6,368,030 bytes**, SHA-256
`80384e9bb158ca5d6e9425004768095b7042428b8808cb5b8d0f40448701e147`.
Its [engineering-engine receipt](../verification/openface-integration-20261024/continuation/native-session-preserved-1316/native-artifacts/evidence/engineering-engine3/receipt.json)
records **24 existing cases passing**. The
[private-service receipt](../verification/openface-integration-20261024/continuation/native-session-preserved-1316/native-artifacts/evidence/private-service55-evidence1/receipt.json)
records **55 cases and the separate actual resident-worker lifecycle passing**
under UID 10001, read-only root, one CPU and **3 GiB**, consistent with the
selected serving-memory budget. The 24 cases overlap the 55-case suite.

The [corrected native probe receipt](../verification/openface-integration-20261024/continuation/native-session-preserved-1316/native-artifacts/evidence/native-runtime-probes-unminimized4/receipt.json)
is **`PASS_EXECUTED_SCOPES_ONLY`**, with no failed/missing jobs: six security
checks with zero skips, NAL/CRC, Pydantic, codecs and GCC allocation controls
(36 oversized refusals / 60 normal-zero controls). The earlier 768 MiB child
SIGKILL, bootstrap/setup failures and false codec probe failure remain retained.
The codec checker had consumed the following line after a blank GUI field; its
corrected horizontal-whitespace check and explicit GUI/module/build-flag checks
passed on the unchanged image. The lost SSH255 observation was reconciled to
the completed remote private-service run, without replaying that operation.

The loaded first-pass fingerprint above differs from the old Pillow 12
fingerprint and grants no old-template compatibility. Both are superseded
by the new native-byte identity above. The
[component/package proof](../verification/openface-integration-20261024/continuation/native-final-preserved1/native-artifacts/evidence/native-component-layer-binding1/receipt.json)
subsequently bound the retained OpenSSL/libde265/zlib producer packages to
installed runtime bytes. The finite **1,347-path removal plan** was then applied
and verified in minimized V1. These scoped results do not accept the image.
The [25 October PBDS review](../verification/openface-integration-20261024/continuation/native-pbds-closure-20261025/README.md)
adds seven source archives/12,753 members with no marker hits and 40 matching
retained native wheel members. That source review's under-investigation state is
preserved. Its later [bounded decision](../verification/openface-integration-20261024/continuation/native-pbds-closure-20261025/bounded-applicability-decision/README.md)
uses matched publisher source/native identities and actual codec/source mappings
to infer that the advisory's PBDS prerequisite is absent. That exact component
reasoning supports scoped engineering use; it is not a claim of a fixed GCC
package, universal compiler provenance or production security acceptance.

Use the canonical [`build-face-container.py`](../scripts/build-face-container.py)
on the actual native AMD64 builder. Its eight-GiB free-space guard and all
27 unchanged glibc fixtures remain required; the latest first-pass invocation
has passed them. Its completed unminimized observation and exact-image scan
provided the preimages for the applied finite V1 minimization plan. The new
two-file consumer build uses the independently verified minimized V1 base;
it still requires its own exact runtime/model/identity qualification, final scan,
dispositions and release-policy outcome.
See the [two-pass instructions](../services/ml-face/patches/security-runtime-minimization/README.md).

The separate 24 October temporary `lovelies-native-build-20261024` Container was EU/WEUR,
4 vCPU, 12 GiB memory, 20 GB disk, maximum one instance, with a one-hour process
ceiling and a bounded authenticated control window. Its Docker daemon has a
Unix socket only. Provider SSH uses a task-owned key; it has no application
credentials or user photographs. It is build infrastructure, not a serving
model host. Preserve diagnostics before stopping it.

Large technical inputs use the new private EU R2 bucket
`lovelies-inference-build-inputs-20261024`. Public `r2.dev` access is disabled and
no custom domain is configured. The builder Worker admits only expiring,
authenticated opaque reads of exact SHA-256 keys in a finite length-bound
manifest. It exposes no shell or arbitrary R2 route. Every object must pass
actual byte-length and SHA-256 verification on the native host before use.
Source archives contain no service/account credentials or customer images.
Failed SSH transfers and local preflight attempts remain labelled as failures.

The original indexed Grype database is losslessly preserved on the verified T7
volume, with its original cache file path explicitly referencing the preserved
file. The 24 October DB readback was valid under the scanner's default age policy;
no freshness threshold is bypassed. Exact metadata/hash/readback are in the
[database-preservation receipt](../verification/openface-integration-20261024/continuation/scanner-database-preservation/receipt.json).

At the resumed readback T7 was unmounted. The preserved reference remains
unchanged. The identical retained publisher archive was verified and imported
into a new cache on the verified internal Data volume; default freshness
validation reports `valid:true`. No new database download or age override was
used. See the [recovered-archive import receipt](../verification/openface-integration-20261024/continuation/scanner-recovered-archive-import-attempt1/receipt.json).

## Serving activation and rollback

Only an accepted image with an exact registry **manifest** URI may be selected.
A local Docker configuration/image ID is not a registry manifest digest. The
configuration additionally requires `INFERENCE_SERVING_ENABLED=true`, a reviewed
64-hex release-receipt hash and the immutable Cloudflare registry image URI.
Record actual loaded engine, model, preprocessing/fingerprint and permitted
operations through authenticated `/ready`, then exercise exact face/photo
requests and failure cases over the deployed HTTPS boundary.

Image acceptance requires actual native fixture/ABI/codec/model checks, a fresh
image-bound SBOM/scan and exact dispositions under the release policy. Reuse
prior evidence only where the component and runtime scope match. Device,
recognition accuracy, hosted Supabase cutover and store distribution remain
separate observed scopes.

The local API generation foundation is schema **10**: its
[forward migration](../supabase/migrations/20261024180000_inference_generation.sql)
adds nullable private identities to challenges and processing attempts without
backfilling existing rows. The selected canonical engine-space/artifact/
processing-fingerprint tuple must be stored for new operations and checked
through private request/verdict and post-await boundaries; NULL or stale
operations fail closed. This does not change public native capture envelopes or
establish hosted migration/cutover. The separate Supabase owner is preparing
schema **11** retention work. Hosted schema **8** was last observed on 24 October
and remains unchanged by this integration. Earlier API passes/failures are
preserved in the continuation record; they are not relabelled as current
schema-11 or new-image qualification. No new returning-authentication product
decision has been applied here.

The present deployment does not change Supabase functions/secrets/schema,
scheduler, native API URL, accounts, grants, billing/push callbacks or store
releases. After acceptance, coordinate the exact server-only binding with the
Supabase owner. Recheck current consent/session/profile/source/lease fences
through the real deployed boundary before traffic cutover.

Rollback may use only a preserved engine compatible with the selected profile
space. Disable serving first if identity or authority is uncertain. Preserve
failed receipts and unknown outcomes. Never restore a database backup merely
to undo an inference image: it could revive revoked consent, grants or deleted
references. Stop only the owned temporary builder and retained local fixture
services when they are no longer needed; do not prune unrelated containers,
images, volumes or workstation data.
