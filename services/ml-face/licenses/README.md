# ML service third-party notices and sources

Reviewed on 30 September 2026. This folder accompanies the service image at
`/app/licenses`. Complete Python dependency notices remain in the installed
distribution metadata; Debian notices remain under `/usr/share/doc` and
`/usr/share/common-licenses`. Model notices and complete licences are under
`/app/models`. Retain these files when copying or distributing the image.

## Scope and package differences

The deployment candidate uses the locked Python packages in `/app/uv.lock`.
Its final Linux runtime has 17 third-party Python distributions and uses
Uvicorn asyncio/h11 with WebSocket handling disabled. The standard extras
httptools, uvloop, watchfiles, websockets, PyYAML and python-dotenv are absent.
`scripts/validate-ml-runtime-licenses.py` checks the exact Linux installation,
the readable notices, source checksums and shared library linkage as UID 10001.
Its image-bound report gives the actual installed version and notice hashes.

- OpenCV Python build scripts are MIT. OpenCV itself is Apache-2.0. Preserve
  the source-built wheel's `LICENSE.txt` and complete `LICENSE-3RD-PARTY.txt`;
  the root Apache label does not replace embedded third-party notices.
- Upstream OpenCV Linux wheels include LGPL FFmpeg. The revised image builds
  OpenCV with FFmpeg disabled; the validator rejects FFmpeg shared libraries
  and its old bundled OpenSSL 1.1 libraries. An earlier wheel's notice is not
  evidence that those libraries are distributed in the revised image.
- The pillow-heif adapter is BSD-3-Clause. Its upstream wheel metadata also
  carries a GPLv2 classifier because its wheels include x265. This image builds
  the adapter from its locked source distribution against Debian shared
  decoders. Keep upstream `LICENSES_bundled.txt`; use measured linkage and the
  final payload inventory to identify which native libraries are actually
  distributed. The validator rejects x265 and a bundled pillow-heif library
  directory. Libheif can still include builtin uncompressed/mask encoders.
- Libheif and libde265 decoder libraries are LGPL-3.0-or-later. Debian source
  archives also include GPL build/helper files and other licences; the complete
  file-level Debian copyright records apply to those individual files.
- NumPy and Pillow wheels contain native libraries with additional licences.
  Preserve their complete packaged licence files, including NumPy's compiler
  runtime exceptions and Pillow's bundled codec notices. Do not replace these
  records with the Python package's headline BSD/MIT expression.
- SciPy is an optional development comparison, absent from the production
  dependency set. Its skipped comparison test is not a licence or accuracy
  acceptance result.
- CPython's complete licence remains in its installed standard library.
  Debian base packages retain their publisher copyright files. An SBOM
  `licenseDeclared` field is a declaration, not a legal conclusion for a binary.
- Rust-based Pydantic-core has supplemental original dependency notices in
  `rust-source-notices`. Previously reviewed watchfiles and uvloop/httptools
  original source notices are retained there as historical evidence; those
  three distributions and their vendor libraries are absent from this runtime.
  Its manifest binds the exact PyPI source archive hashes, source locks and
  original crate/vendor notices. The Cargo candidate list is a conservative
  superset containing build, test, uninstalled and alternative-platform entries;
  it is not
  an assertion that every listed crate is compiled into the Linux wheel.
- The Lovelies `pictured-ml-face` package is company-owned code. This notice
  does not assign it an open-source licence or grant redistribution rights.

Primary publisher references:

- [OpenCV Python licensing](https://github.com/opencv/opencv-python#licensing)
- [Libheif licence](https://github.com/strukturag/libheif/blob/v1.23.4/COPYING)
- [Libde265 licence](https://github.com/strukturag/libde265/blob/v1.0.15/COPYING)
- [FFmpeg licence and build-dependent terms](https://www.ffmpeg.org/legal.html)
- [Pillow-heif package/source metadata](https://pypi.org/project/pillow-heif/1.5.0/)

## Provided corresponding source

`corresponding-source-manifest.json` binds the exact libheif original archive,
Debian packaging archive and source descriptor in `sources/`. These archives
provide the library source, original notices and build/installation packaging.
Their SHA-256 values match the Debian descriptor downloaded over HTTPS. The
descriptor OpenPGP signature was not independently verified.

The modified libde265 library's complete original archive, Debian patches,
upstream fix, applied patch and build script are supplied inside the image at
`/usr/share/doc/libde265-0/source`. Its modification notice and exported decoder
API records are in the enclosing directory. The custom version is a Lovelies
build and is not an official Debian release.

OpenSSL 3.5.9 uses Apache-2.0. Its complete licence and retained Debian
attribution records are supplied; its build configuration, script, symbol
inventories and tests are under `/usr/share/doc/libssl3t64`. Its source release
and retained Debian patches are named in `NOTICE-openssl-runtime.txt`.

For replacement/build instructions and distribution handling, see
[RELINKING.md](RELINKING.md). Providing sources inside a local image does not
prove that a recipient-facing image/source download has been published.
