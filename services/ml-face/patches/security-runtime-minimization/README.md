# ML runtime minimization

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
