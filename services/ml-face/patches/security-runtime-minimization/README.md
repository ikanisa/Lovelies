# ML runtime minimization

The active `removal-plan.json` is preserved historical input for Python 3.13.15 /
Pillow 12.3.0. It is **not** a plan for the prepared Python 3.13.17 / Pillow 13.0.0
candidate. Its original preparer, plan and documentation are copied byte for byte
under `history/3.13.15-pillow12.3.0/`.

The v2 preparer accepts the exact first-pass image ID, observed Python/Pillow
versions and that image's raw Grype JSON. It derives the advisory set from the
actual scan; no fixed advisory count or guessed runtime hashes are accepted.
A generated plan remains a build proposal, with native and release acceptance
false. Preserve failed attempts and raw scan output.

## Two-pass candidate build

Use the canonical producer's qualified native executor, resource checks, exact
security artifacts and build arguments. These commands describe the stage
boundary; they do not waive the full native build's storage, architecture or
fixture requirements. Work from `services/ml-face` with a new owned run directory.

1. Build `--target security-runtime-unminimized` with `--platform linux/amd64`,
   `--load` and `--iidfile "$RUN_DIR/unminimized.iid"`. This named stage is after
   actual security-native and patched-pydantic installation, current app/vendor
   copy, NumPy runtime replacement and file permissions. It is before the finite
   minimizer. Retain the build log and immutable image ID.
2. Observe that exact ID with the current helper inside the image. Retain the
   host image-inspect/run receipt independently; the supplied ID is not container
   attestation. The output directory must start empty. For a local Docker host,
   a bounded read-only example is:

   ```sh
   ML_FIRST_PASS_ID=$(cat "$RUN_DIR/unminimized.iid")
   mkdir -m 700 "$RUN_DIR/observations"
   docker image inspect --format '{{.Id}} {{.Architecture}} {{.Os}}' \
     "$ML_FIRST_PASS_ID" > "$RUN_DIR/image-identity.txt"
   docker run --name "$OWNED_INSPECTION_CONTAINER" --pull never \
     --platform linux/amd64 --read-only --network none --cap-drop ALL \
     --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 \
     --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=256m \
     --mount "type=bind,source=$RUN_DIR/observations,target=/evidence" \
     --env OPENBLAS_NUM_THREADS=1 --env OMP_NUM_THREADS=1 \
     --entrypoint /app/.venv/bin/python "$ML_FIRST_PASS_ID" \
     /usr/local/share/doc/lovelies-minimization/prepare-plan.py observe \
     --image-id "$ML_FIRST_PASS_ID" --evidence /evidence \
     > "$RUN_DIR/observation-receipt.json" 2> "$RUN_DIR/observation.stderr"
   ```

   A remote executor must use its own owned paths and retain equivalent host
   image/run receipts. Do not assume a Mac path or local free-space check proves
   the remote filesystem state. The observer uses an ephemeral local-only auth
   secret in memory; no credential is written or printed, and the service's HTTPS
   authentication requirement stays enabled. It imports `lovelies_ml_face.app`,
   denies optional database/interactive/font imports, runs real-model bounded
   PNG/JPEG/WebP no-face cases, and records exact ELF closure, version, tool,
   collector, source-consumer and output hashes. Import denial is scoped to the
   service/observer process; worker behavior has separate actual-case/source/ELF
   evidence and is not described as a worker import-hook proof.
3. Produce an SBOM and raw Grype JSON for **this first-pass image ID**, using the
   normal scanner and database policy. Retain a failed threshold exit and its raw
   results. The preparer rejects a scan whose `source.target.imageID` differs.
   Then prepare a new output, using versions read from `observation.json`:

   ```sh
   python3 patches/security-runtime-minimization/prepare-plan.py prepare \
     --evidence "$RUN_DIR/observations" --advisories "$RUN_DIR/unminimized-grype.json" \
     --image-id "$ML_FIRST_PASS_ID" --python-version 3.13.17 --pillow-version 13.0.0 \
     --output "$RUN_DIR/removal-plan.candidate.json"
   ```

   The exact four optional extensions and six exclusively referenced font
   payloads, successful actual service import, all three no-face cases, complete
   retained dependency hashes and unchanged collector sources remain required.
   New payloads, consumers or missing observations fail closed. Review the new
   finite plan before the build owner replaces the active `removal-plan.json`;
   this helper never installs or overwrites it automatically.
4. Rebuild the final target with the same frozen native/application inputs and
   reviewed new plan. The final stage first runs `verify-runtime`, comparing the
   actual Python/Pillow/architecture and every retained preimage file hash, then
   runs the unchanged minimizer's all-candidate preflight before any unlink.
   An old plan or changed payload fails. There is no skip flag. Verify the new
   final artifact's omission receipt, complete ELF/codec closure, service/real
   model/TLS/Pillow tests, scanner results, source kit/notices and native execution
   requirements independently. The first-pass image is not a release image.

Focused source-only guard checks (no container build):

```sh
python3 patches/security-runtime-minimization/test-prepare-plan.py
python3 patches/security-runtime-minimization/test-minimize-runtime.py
```

## Historical removal evidence

This is a finite, hash-bound build change derived from actual read-only inspection
of image `sha256:6b58ceaf1a710bf28cdc9b837c40535b2ea1e32db382b1a78dbb1357f69f7b6c`.
It is proposed remediation; the resulting immutable image must pass the affected
runtime, native linkage and advisory applicability gates.

## Removal boundary

The plan removes the unused Dash entrypoint shell, account/login, package installation, coreutils,
GNU tar, Perl, diffutils, terminal/PAM/systemd/ACL and other build utility code.
It preserves `dpkg-query`, the `openssl` CLI and their observed dependencies.
Debian `libuuid` remains; util-linux advisories require affected-program checks,
not a blanket conclusion about the source package.

Four CPython shared extensions (`_sqlite3`, `readline`, `_curses`, `_curses_panel`)
are omitted together with their now-unneeded SQLite/readline/ncurses libraries.
The actual service imported successfully with these modules denied and the
652 inspected production Python files contained no literal consumers.

The Pillow font extension and its five exclusively referenced bundled DSOs
(FreeType, HarfBuzz, PNG, Brotli decoder/common) are omitted. The observed native
dependency graph has no non-font consumer of these six files. With font imports
denied, actual service processing of generated PNG/JPEG/WebP images returned
`no_faces`. These are decoder/model consumer checks, not recognition accuracy.
All non-font Pillow, OpenCV and HEIF codecs remain.

The plan records 40 identifiers from the existing remaining 62: 39 OS source
family conditions plus the separate Pillow bundled-PNG scope. It does not
declare those identifiers fixed before actual final-artifact verification.
For CVE-2007-5686, `/var/log/btmp` was empty and root-owned with mode0660;
that permission condition must be checked again, rather than inferred from
login-program removal. Glibc, shared PNG, zlib, protobuf and GCC compiled-template
applicability remain separately owned vendor/source reviews.

## Build and verification

Run last as root, after native dependency installation, account creation and
file permissions, with the new direct Python module entrypoint installed:

```sh
/app/.venv/bin/python /usr/local/share/doc/lovelies-minimization/minimize-runtime.py \
  --manifest=/usr/local/share/doc/lovelies-minimization/removal-plan.json \
  --receipt=/usr/local/share/doc/lovelies-minimization/receipt.json
```

The same command with `--verify` reads the receipt as UID10001, prints JSON and
does not write. It verifies helper/plan identity, every absent path, retained
build-time file hashes, configuration and package metadata, and native aliases.
Final ELF dependency checks use the actual ELF loader on hash-bound packaged
files. The plan also removes `/usr/bin/ldd` after native package installation,
which otherwise restores this utility. Bash and other retained operator tools
are not service entrypoints; their presence does not establish libc regex
exposure through the ML API. Uploaded image bytes are never executed as ELF.

No recursive deletion or package-manager operation occurs. All candidates are
preflighted before any unlink, including exact hashes or leaf symlink targets.
Sixteen removal controls and eight post-omission controls exercise malformed
plans, retained-file deletion, drift, traversal, aliasing and receipt substitution.

## Licence and provenance retention

This alters the installed distribution by omitting optional runtime code.
Retain this notice prominently beside the build receipt. Preserve all original
copyrights, complete licences, wheel notices/SBOMs, Debian copyright files,
common licence texts, original publisher RECORD/metadata, historical build
receipts and corresponding-source/relinking materials. Original metadata
describes the source installation; the exact removal receipt and final native
inventory identify the bytes actually shipped. An original SBOM/RECORD entry
does not establish that an omitted binary remains installed.

Preserve passwd/group, NSS, glibc/gconv, CA trust and OpenSSL configuration.
Do not erase dpkg status or rebrand removed packages as a vendor update. A
scanner may continue matching historical source-package identities; disposition
must show the affected code absent or correctly patched, with retained `libuuid`
and other partial-source-family components considered explicitly.

The paired source kit must retain the minimizer, manifest, build receipt,
original source/licence material and any separately supplied native/Rust patches.
Existing Pillow source/relinking documents remain original distribution history;
the final artifact inventory must explicitly record the font extension absent.

## Scope

No providers, advisory scanners or old test corpora were run. Generated image
observations do not establish human recognition accuracy, capacity, legal
clearance or production readiness. This helper does not accept the remaining
vendor review or compiled Rust provenance findings.
