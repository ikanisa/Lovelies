---
title: Lovelies private face and photo service
colorFrom: red
colorTo: pink
sdk: docker
app_port: 8080
pinned: false
---

# Lovelies private face and photo service

This directory contains Lovelies' private still-image consumer, the pinned
account-free `openface-still` wheel, model artifacts, and retained MEMORIES
pipeline/tests/notices for compatibility evidence. Supabase is the application
authority. Its `model-services.ts` adapter calls this service over authenticated
private HTTP; native apps never receive the inference credential.

## Active Lovelies adapter

`src/lovelies_ml_face` uses the isolated OpenFace still worker to load the real
OpenCV Zoo YuNet and SFace artifacts, identified by `models/manifest.json` and
the retained `models/model-manifest.json` (`opencv-yunet-sface-2021dec-v1`).
`POST /internal/face` compares the three initial registration selfies or one
fresh sign-in selfie against the account's existing private reference.
`POST /internal/photo` returns reduced private previews and matching proposals;
it never issues media grants. Account/session authorization, consent, challenge
consumption, reference ownership and recipient approval stay in Lovelies' custom
Supabase API and private PostgreSQL/Storage transactions. These are custom app
accounts, not Supabase managed Auth accounts.

Face comparison runs entirely in this backend service. The mobile apps capture
and send signed selfie bytes but do not compute face embeddings or decide an
identity match. There is no OTP, liveness/PAD, blink, movement challenge,
head-turn verification or camera-injection qualification in this flow.
Registration pose labels are capture guidance only.

The private adapter exposes authenticated `GET /ready` and the two
`/internal/*` routes. It disables OpenAPI and public face-directory routes.
Readiness probes the loaded resident worker and reports exact package/model and
consumer processing identities, permitted operations and limits. Every request
and result binds these identities plus a request UUID and canonical payload hash.
The original `pictured_ml_face` implementation remains preserved as the comparison
baseline and supplies the unchanged distance/margin matcher and strict vector
validation. No original account application, broker, registry, video or PAD engine
is initialized by the new consumer.

Templates use `lovelies-face-template-v2`, explicitly binding
`lovelies-sface-openface-still-v1`, the package hash and the complete processing
fingerprint. Legacy v1 or differently fingerprinted references return
`registered_reference_space_incompatible`; they are never relabelled or compared
across spaces. Existing account/profile rows and stored references are preserved.
The existing authenticated profile-removal/cleanup and re-enrollment path is the
explicit transition for this slice. Traffic must remain on the preserved old
engine until that transition and exact new runtime are qualified for rollout.

## Model provenance and status

The model manifest records OpenCV Zoo's YuNet MIT and SFace Apache-2.0 notices.
Both model files and their SHA-256 values are included in the manifest and are
verified by the still worker before loading. The private worker receives only
admitted still bytes and owns no account/storage/service credentials. Runtime
internet access remains disabled by the image recipe. No donor credential is used.

The preserved implementation's representative evaluation remains historical.
The new engine reports `not_evaluated` (or explicitly configured `monitored_pilot`)
and cannot reuse the old report as new-space production approval. Passing local
model tests proves that these artifacts load and run against the tested sample;
it does not qualify matching thresholds for general use, establish identity,
or authorize deployment. Hosted integration, purpose-specific evaluation,
completion of the exact target image build/scan and deployment remain separate
gates. See [the integration record](../../docs/openface-integration.md).

## Local checks

The canonical local Container producer uses the pinned source recipes and an
unminimized installation stage before it removes build/package tools and copies
the final runtime into `scratch`. Build from the repository root, using a new
evidence directory for each attempt:

```sh
python3 scripts/build-face-container.py --tag lovelies-face:local \
  --evidence verification/face-image-build-local
```

The exact libpng 1.6.48-1+deb13u5 source archives and signed descriptor are
retained in `sources/libpng1.6`. Debian's rotating security pool retired the
pinned patch archive; the vendored bytes match the original SHA-256 values and
the content-addressed Debian snapshot. The existing recipe still checks every
source/patch hash before extraction and verifies patch application, ABI,
hardening and upstream codec tests. See `sources/libpng1.6/README.md`.

The optional `ML_SECURITY_RUNTIME` input must be an unminimized runtime with
the shell and package tools needed for installation. A completed release image
has deliberately removed those tools and is rejected by an exec-form preflight.
`Dockerfile.local-cache` remains a separate local overlay check; it is not the
default Cloudflare image recipe.

The unchanged glibc resolver fixtures create UTS/network namespaces and chroots.
Ordinary BuildKit sandboxes do not have the required capabilities. The producer
builds the exact `glibc-compile-inputs` stage, then runs the full canonical recipe
in an owned container with network `none`, root UID and only `SYS_ADMIN` and
`NET_ADMIN` added to the normal build-container capabilities. Its seccomp change
applies only to this fixture. All 27 vendor tests, four resolver PASS results,
local runtime checks, patch hashes, ABI checks and hardening remain required.
The accepted package supplies the named `glibc-security-builder` context; every
other source recipe and final minimization still runs on the existing builder.

Direct Dockerfile builds require a BuildKit builder and request allowing the
scoped `security.insecure` entitlement for the glibc RUN, with that RUN's network
disabled. The producer avoids changing a shared builder. A recovery attempt may
explicitly reuse a completed, hash-bound compiled tree; it verifies the cloned
bytes, preserves previous verdicts and reruns the full canonical test recipe.
This is a local image build. Wrangler's Worker dry run and hosted image/deployment
acceptance remain separate.

OpenCV's source builder verifies its wheel ZIP, all RECORD hashes/sizes and
AMD64 native module before removing generated C++ source/build temporaries in
that same successful RUN. The retained output includes configuration, build
log, recipe, licenses, notices, wheel validation and the exact publisher source
archives. A storage recovery may explicitly supply those outputs with
`--opencv-artifacts` and a hash-bound `--opencv-manifest`; the producer rechecks
the complete file set, source archives, configuration and wheel integrity.
Cached/export success alone is insufficient: a disk-full event yielded a
zero-filled copied wheel, which was rejected while the valid original `dist`
wheel and matching installed native module were recovered and retained.

The 13 October source-build attempt passed the repaired libpng builder, with
the original hashes and controls intact. It later stopped while building native
libraries because `/Volumes/PRO-G40/Development/Docker/Docker.raw` exhausted its
backing volume and Docker's filesystem became read-only. No completed image or
Docker-backed journey is claimed from that attempt. Separate Android and Swift
client HTTP journeys passed against this actual adapter on the host and the
Cloudflare local runtime. See
`verification/docker-native-journey-20261013/README.md` from the repository root.

Run the imported pipeline tests in their deterministic fixture mode:

```sh
./.venv/bin/pytest -q --ignore=tests/lovelies
```

Run the Lovelies adapter tests against the real ONNX models and bundled sample
image:

```sh
APP_ENV=local ML_USE_DETERMINISTIC_SIMULATOR=false \
  ./.venv/bin/pytest -q tests/lovelies/test_private_adapters.py
```

From the repository root, typecheck and build the private Worker binding:

```sh
pnpm --filter @lovelies/ml-container-worker typecheck
pnpm --filter @lovelies/ml-container-worker test
pnpm backend:ml:build
```

The Wrangler build is a dry run. It verifies Worker bindings and Container
configuration without building or deploying the image.

## 14 October recovery status

The six owner-approved generated Gradle caches were deleted. Docker recovered
without pruning unrelated objects. The namespace-capable canonical glibc run
compiled and passed 25 of 27 required vendor fixtures, including all four
resolver cases. `tst-malloc-thread-fail` and `tst-malloc-fork-deadlock`, including
their malloc-check/hugetlb variants, failed under Rosetta. Guest user-mode QEMU
ignores the address-space limits exercised by the first fixture and cannot
substitute for this acceptance. The exact input image and completed compiled
tree are hash-bound for an unchanged rerun under an x86 Linux kernel.

The producer checks the actual Docker backing volume before expanding phases,
records post-run failures and clears every generated verdict in selected test
subdirectories of an owned resume clone. `--inputs-image` accepts only an
explicit immutable image ID. `--docker-storage-path` identifies local daemon
storage when automatic discovery is unavailable; the default minimum free-space
guard is 8 GiB and is recorded with each check.

OpenSSL's pinned source recipe passed its complete upstream suite (347 test
files, 4,932 checks). All three exported packages, retained source/licenses,
public ABI and RELRO/BIND_NOW/stack-canary readbacks passed. These component
results do not establish a finished image or deployment. Current records are
in `verification/docker-native-journey-20261014` at the repository root.
