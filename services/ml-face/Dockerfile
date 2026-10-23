# syntax=docker/dockerfile:1
# Default builds compile pinned security artifacts. The local producer can reuse
# verified component artifacts and an immutable runtime without recompiling them.
ARG ML_SECURITY_ARTIFACTS=security-artifacts-built
ARG ML_SECURITY_RUNTIME=runtime

# Verified official multiarchitecture index; keep platform selection portable.
FROM python:3.13-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS python-base

ARG LIBHEIF_DEBIAN_VERSION=1.23.4-1~deb13u1
ARG LIBDE265_DEBIAN_VERSION=1.0.15-1+deb13u2

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_MANIFEST_PATH=/app/models/model-manifest.json \
    PYTHONPATH=/app/src \
    PORT=8080

WORKDIR /app

FROM python-base AS libde265-builder
# Corresponding Debian source hashes verified against its source descriptor.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
       build-essential cmake pkg-config patch \
       "libde265-0=${LIBDE265_DEBIAN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:00251986c29d34d3af7117ed05874950c875dd9292d016be29d3b3762666511d \
    https://deb.debian.org/debian-security/pool/updates/main/libd/libde265/libde265_1.0.15.orig.tar.gz /native/libde265_1.0.15.orig.tar.gz
ADD --checksum=sha256:108b5d4d71243554110e2899e20d3f409c8368573bfddc98473eb1637b902ba9 \
    https://deb.debian.org/debian-security/pool/updates/main/libd/libde265/libde265_1.0.15-1+deb13u2.debian.tar.xz /native/libde265_1.0.15-1+deb13u2.debian.tar.xz
COPY patches/libde265-CVE-2026-88373.patch patches/libde265-CVE-2026-88373-upstream.patch patches/build-libde265-backport.sh /native/
RUN echo "e3fa200afb43cd3e793bf13d83204c3aff5221ea89db996c55ed1268376ff252  /native/libde265-CVE-2026-88373-upstream.patch" | sha256sum --check \
    && echo "a388c99b08d3cae114c8ab57613a6dda123532b1ce0ea69092170f0329c05da8  /native/libde265-CVE-2026-88373.patch" | sha256sum --check \
    && sh /native/build-libde265-backport.sh

FROM python-base AS openssl-builder
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
       build-essential patch perl libzstd-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a \
    https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz /openssl/openssl-3.5.9.tar.gz
ADD --checksum=sha256:593a47654ead460a3b609503733f80bef552ff0802799d3b47784faacc50809f \
    https://deb.debian.org/debian-security/pool/updates/main/o/openssl/openssl_3.5.7-1~deb13u2.debian.tar.xz /openssl/openssl_3.5.7-1~deb13u2.debian.tar.xz
COPY patches/build-openssl-patch.sh /openssl/build-openssl-patch.sh
RUN sh /openssl/build-openssl-patch.sh

FROM scratch AS openssl-verified-artifacts
COPY --from=openssl-builder /openssl/out/ /openssl/out/
COPY --from=openssl-builder /openssl/openssl-3.5.9.tar.gz /openssl/openssl_3.5.7-1~deb13u2.debian.tar.xz /openssl/
COPY --from=openssl-builder /openssl/packages/libssl3t64/usr/share/doc/libssl3t64/ /openssl/packages/libssl3t64/usr/share/doc/libssl3t64/
COPY --from=openssl-builder /openssl/packages/openssl/usr/share/doc/openssl/ /openssl/packages/openssl/usr/share/doc/openssl/
COPY --from=openssl-builder /openssl/packages/openssl-provider-legacy/usr/share/doc/openssl-provider-legacy/ /openssl/packages/openssl-provider-legacy/usr/share/doc/openssl-provider-legacy/
COPY --from=openssl-builder /openssl/source/openssl-3.5.9/debian/copyright /openssl/source/openssl-3.5.9/debian/copyright

FROM python-base AS cpython-builder
COPY patches/cpython-backports /cpython
RUN python /cpython/cpython-apply-backports.py --output /cpython-out/stdlib

FROM python-base AS opencv-toolchain
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
       build-essential cmake ninja-build pkg-config \
       libjpeg62-turbo-dev libpng-dev libwebp-dev zlib1g-dev \
       libprotobuf-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir \
       "numpy==2.4.6" "setuptools==69.5.1" "wheel==0.46.3" \
       "scikit-build==0.18.1" "packaging==26.2"

FROM opencv-toolchain AS opencv-builder
ADD --checksum=sha256:ecc18f96559493a7968da6a0fa8fff2094a0d8a41f9cc03c8333139da0644171 \
    https://codeload.github.com/opencv/opencv-python/tar.gz/4ddfc013fd1f13d9b9e379dbebf2cdbeb052e7f8 /opencv/wrapper.tar.gz
ADD --checksum=sha256:4f2a381ce3377e6f22d0718fe7101e97a21968a21c81f0356f2787bb21024dc4 \
    https://codeload.github.com/opencv/opencv/tar.gz/b4c5ec4042f097e2a5b386b9d413ec7333d0a184 /opencv/opencv.tar.gz
COPY patches/build-opencv-image-only.sh /opencv/build-opencv-image-only.sh
COPY patches/verify-opencv-wheel.py /opencv/verify-opencv-wheel.py
RUN sh /opencv/build-opencv-image-only.sh \
    && python /opencv/verify-opencv-wheel.py \
       /opencv/out/opencv_python_headless-4.13.0.92-cp313-cp313-linux_x86_64.whl \
       /opencv/out/wheel-validation.json \
    && rm -rf /opencv/source

# Compact export for a storage-constrained local build. The exact wheel,
# configuration, recipe, notices and publisher source archives are retained;
# generated C++ objects do not enter the final service image.
FROM scratch AS opencv-verified-artifacts
COPY --from=opencv-builder /opencv/out/ /opencv/out/
COPY --from=opencv-builder /opencv/wrapper.tar.gz /opencv/opencv.tar.gz /opencv/

FROM opencv-toolchain AS numpy-runtime-builder
RUN apt-get update \
    && apt-get install --no-install-recommends --yes "libgfortran5=14.2.0-19" "libquadmath0=14.2.0-19" \
    && rm -rf /var/lib/apt/lists/*
COPY patches/replace-numpy-compiler-runtimes.py /numpy/replace-numpy-compiler-runtimes.py
RUN python /numpy/replace-numpy-compiler-runtimes.py --prepare --output /numpy/out \
       --numpy-libs /usr/local/lib/python3.13/site-packages/numpy.libs

FROM opencv-toolchain AS libpng-builder
# Debian's rotating security pool can retire a pinned revision. Keep the exact
# signed descriptor/source bytes in the build context; the existing backport
# recipe verifies all original SHA-256 values before extraction or execution.
COPY sources/libpng1.6/libpng1.6_1.6.48.orig.tar.gz \
     sources/libpng1.6/libpng1.6_1.6.48-1+deb13u5.debian.tar.xz \
     sources/libpng1.6/libpng1.6_1.6.48-1+deb13u5.dsc /png/
COPY patches/libpng-backport/build-libpng-backport.sh \
     patches/libpng-backport/libpng-CVE-2026-46675-upstream.patch \
     patches/libpng-backport/libpng-backport-manifest.json \
     patches/libpng-backport/libpng-NOTICE.txt /png/
RUN sh /png/build-libpng-backport.sh

FROM opencv-toolchain AS glibc-compile-inputs
RUN apt-get update \
    && apt-get install --no-install-recommends --yes gawk bison gettext \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:f24aa441021121a79266f0d75242706cab8843a47901fefe74527491807f1998 \
    https://deb.debian.org/debian/pool/main/g/glibc/glibc_2.41.orig.tar.xz /glibc/glibc_2.41.orig.tar.xz
ADD --checksum=sha256:dda4153511bfd543502d18e5bc9323110996fe9c531f14ae3fad6eb17f027c7d \
    https://deb.debian.org/debian/pool/main/g/glibc/glibc_2.41-12+deb13u4.debian.tar.xz /glibc/glibc_2.41-12+deb13u4.debian.tar.xz
ADD --checksum=sha256:0915324aa646bb99abfaa9aa6ecb734b30babd28454a3e51f3152912370fbd3e \
    https://deb.debian.org/debian/pool/main/g/glibc/glibc_2.41-12+deb13u4.dsc /glibc/glibc_2.41-12+deb13u4.dsc
COPY patches/security-library-fixes /fixes

FROM glibc-compile-inputs AS glibc-security-builder
# Unchanged resolver fixtures need UTS/network namespaces and chroots. Direct
# builds need the scoped security.insecure entitlement. The canonical local
# producer runs this same recipe in an owned network-none fixture container,
# then supplies only its accepted package as the named stage context.
RUN --security=insecure --network=none mkdir -p /glibc/out \
    && python /fixes/prepare-glibc-backports.py \
    && sh /fixes/build-glibc-backport.sh

FROM opencv-toolchain AS zlib-security-builder
ADD --checksum=sha256:60dd315c07f616887caa029408308a018ace66e3d142726a97db164b3b8f69fb \
    https://deb.debian.org/debian/pool/main/z/zlib/zlib_1.3.dfsg+really1.3.1.orig.tar.gz /zlib/zlib_1.3.dfsg+really1.3.1.orig.tar.gz
ADD --checksum=sha256:9ed525955ce9fb0c1b39be8ff98f73450dbfc6305a9a27e6149c8972d38a0a9e \
    https://deb.debian.org/debian/pool/main/z/zlib/zlib_1.3.dfsg+really1.3.1-1.debian.tar.xz /zlib/zlib_1.3.dfsg+really1.3.1-1.debian.tar.xz
ADD --checksum=sha256:ede2791e29c1d3b422f9208bdd7edf040c20445ea1e7453a72037576e64fa197 \
    https://deb.debian.org/debian/pool/main/z/zlib/zlib_1.3.dfsg+really1.3.1-1.dsc /zlib/zlib_1.3.dfsg+really1.3.1-1.dsc
COPY patches/security-library-fixes /zlib
RUN sh /zlib/build-zlib-backport.sh

FROM rust@sha256:a6cab604fa016ac022e78c24038497eb7617ab59150ca4c3dd2ede0fbd514d4b AS pinned-rust-security-toolchain

FROM opencv-toolchain AS pydantic-source-builder
COPY --from=pinned-rust-security-toolchain /usr/local/rustup /out/official-rustup
COPY patches/pydantic-source-build /recipes
COPY licenses/rust-source-build/pydantic-core-2.46.4-offline-source.tar.gz /bundle.tar.gz
ADD --checksum=sha256:efcd496a3202ffe0d0489df1f83d08b91399782fb2dd545d5a1e7bf6fd81af39 \
    https://files.pythonhosted.org/packages/46/8d/753148c0d0472acd31a297f6d11c3263cd2668d38278ed29d523625f7290/maturin-1.10.2-py3-none-manylinux_2_12_x86_64.manylinux2010_x86_64.musllinux_1_1_x86_64.whl /inputs/maturin-1.10.2-py3-none-manylinux_2_12_x86_64.manylinux2010_x86_64.musllinux_1_1_x86_64.whl
RUN echo "323a9a858f144698364bf4e91e6fbab4913188ab13921dd6614b9d45fb33a19f  /bundle.tar.gz" | sha256sum --check \
    && mkdir -p /bundle \
    && tar -xzf /bundle.tar.gz -C /bundle \
    && chmod 755 /recipes/compiler-wrapper.py \
    && python /recipes/build-inside.py

FROM scratch AS security-artifacts-built
COPY --from=glibc-security-builder /glibc/out/libc6.deb /debs/libc6.deb
COPY --from=zlib-security-builder /zlib/out/zlib1g.deb /debs/zlib1g.deb
COPY --from=pydantic-source-builder /out/build/wheels/ /wheels/
COPY --from=pydantic-source-builder /out/build-provenance.json /pydantic-doc/build-provenance.json
COPY --from=pydantic-source-builder /out/cargo-build-messages.jsonl /out/cargo-invocations.jsonl /out/rustc-invocations.jsonl /pydantic-doc/
COPY --from=pydantic-source-builder /out/extension-dynamic-linkage.txt /out/extension-elf.txt /pydantic-doc/
COPY --from=pydantic-source-builder /out/build/cargo-metadata.json /out/build/cargo-feature-tree.txt /out/build/build.log /out/build/rustc.txt /out/build/cargo.txt /out/build/maturin.txt /out/build/cc.txt /out/build/python.json /pydantic-doc/
COPY --from=pydantic-source-builder /out/build/effective-cargo-config.toml /out/build/rebuild-linux-amd64.sh /out/build/source-Cargo.lock /out/build/source-Cargo.toml /out/build/wheel-sha256.txt /pydantic-doc/
COPY --from=pydantic-source-builder /out/rust-toolchain-original-notices/ /pydantic-doc/rust-toolchain-original-notices/

FROM python-base AS builder
ARG UV_VERSION=0.11.29

# Build the locked Python adapter against Debian's shared decoder libraries.
# Prebuilt pillow-heif wheels also bundle an unused GPL x265 encoder.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
       build-essential pkg-config \
       "libheif-dev=${LIBHEIF_DEBIAN_VERSION}" \
       "libheif-plugin-libde265=${LIBHEIF_DEBIAN_VERSION}" \
       "libde265-0=${LIBDE265_DEBIAN_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "uv==${UV_VERSION}"
COPY --from=libde265-builder /native/out/libde265-0.deb /tmp/libde265-0.deb
RUN dpkg -i /tmp/libde265-0.deb && rm /tmp/libde265-0.deb
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-dev --no-install-project \
    --no-install-package opencv-python-headless --no-binary-package pillow-heif

COPY src ./src
COPY models ./models
COPY licenses ./licenses
RUN uv sync --frozen --no-dev --no-editable \
    --no-install-package opencv-python-headless --no-binary-package pillow-heif
COPY --from=opencv-builder /opencv/out/opencv_python_headless-4.13.0.92-*.whl /tmp/
# The lock's publisher wheels are deliberately excluded. This exact source-built
# replacement retains the declared package/version and separately hashed inputs.
RUN uv pip install --python /app/.venv/bin/python --no-deps \
       /tmp/opencv_python_headless-4.13.0.92-*.whl \
    && rm /tmp/opencv_python_headless-4.13.0.92-*.whl

FROM python-base AS runtime
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/certs
# --no-install-recommends excludes encoder plugins while retaining HEIC decoding.
RUN python -m pip uninstall --yes pip \
    && rm -rf /usr/local/lib/python3.13/ensurepip \
    && apt-get update \
    && apt-get upgrade --yes \
    && apt-get install --no-install-recommends --yes \
       "libheif1=${LIBHEIF_DEBIAN_VERSION}" \
       "libheif-plugin-libde265=${LIBHEIF_DEBIAN_VERSION}" \
       "libde265-0=${LIBDE265_DEBIAN_VERSION}" \
       ca-certificates libjpeg62-turbo libpng16-16t64 libwebp7 libwebpmux3 libwebpdemux2 libprotobuf32t64 \
       "libgfortran5=14.2.0-19" "libquadmath0=14.2.0-19" \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 lovelies \
    && useradd --system --uid 10001 --gid lovelies --home-dir /nonexistent lovelies
COPY --from=libde265-builder /native/out/libde265-0.deb /tmp/libde265-0.deb
RUN dpkg -i /tmp/libde265-0.deb && rm /tmp/libde265-0.deb
COPY --from=libde265-builder /native/package/usr/share/doc/libde265-0 /usr/share/doc/libde265-0
COPY --from=libpng-builder /png/out/libpng16-16t64.deb /tmp/libpng16-16t64.deb
RUN dpkg -i /tmp/libpng16-16t64.deb && ldconfig && rm /tmp/libpng16-16t64.deb
COPY --from=libpng-builder /png/package/usr/share/doc/libpng16-16t64 /usr/share/doc/libpng16-16t64
COPY --from=openssl-builder /openssl/out/libssl3t64.deb /openssl/out/openssl.deb /openssl/out/openssl-provider-legacy.deb /tmp/
RUN dpkg -i /tmp/libssl3t64.deb /tmp/openssl.deb /tmp/openssl-provider-legacy.deb \
    && ldconfig \
    && rm /tmp/libssl3t64.deb /tmp/openssl.deb /tmp/openssl-provider-legacy.deb
COPY --from=openssl-builder /openssl/packages/libssl3t64/usr/share/doc/libssl3t64 /usr/share/doc/libssl3t64
COPY --from=openssl-builder /openssl/out/original-libcrypto.so.3-api.txt /openssl/out/patched-libcrypto.so.3-api.txt /openssl/out/original-libssl.so.3-api.txt /openssl/out/patched-libssl.so.3-api.txt /usr/share/doc/libssl3t64/
COPY --from=openssl-builder /openssl/source/openssl-3.5.9/debian/copyright /usr/share/doc/libssl3t64/copyright-debian-patches
COPY --from=openssl-builder /openssl/packages/openssl/usr/share/doc/openssl /usr/share/doc/openssl
COPY --from=openssl-builder /openssl/packages/openssl-provider-legacy/usr/share/doc/openssl-provider-legacy /usr/share/doc/openssl-provider-legacy
COPY --from=cpython-builder /cpython-out/stdlib/ /usr/local/lib/python3.13/
COPY --from=cpython-builder /cpython /usr/local/share/doc/lovelies-cpython
COPY --from=cpython-builder /cpython-out/cpython-backport-receipt.json /usr/local/share/doc/lovelies-cpython/
COPY --from=opencv-builder /opencv/out/ /usr/local/share/doc/lovelies-opencv/
COPY --from=numpy-runtime-builder /numpy/out/ /usr/local/share/doc/lovelies-numpy/
COPY Dockerfile /usr/local/share/doc/lovelies-build/Dockerfile
COPY patches/pillow-distribution-NOTICE.txt /usr/local/share/doc/lovelies-pillow/NOTICE.txt
COPY patches/remove-unused-tk-module.py /usr/local/share/doc/lovelies-build/remove-unused-tk-module.py
COPY --from=builder /app /app
RUN /app/.venv/bin/python /usr/local/share/doc/lovelies-numpy/replace-numpy-compiler-runtimes.py \
       --replace --output /usr/local/share/doc/lovelies-numpy \
       --numpy-libs /app/.venv/lib/python3.13/site-packages/numpy.libs
RUN python /usr/local/share/doc/lovelies-build/remove-unused-tk-module.py
# Integrity verification assumes code and models cannot be replaced by the
# unprivileged application process, even on a writable container filesystem.
RUN chmod -R a+rX,go-w /app /usr/local/share/doc/lovelies-cpython /usr/local/share/doc/lovelies-opencv /usr/local/share/doc/lovelies-build /usr/local/share/doc/lovelies-numpy /usr/local/share/doc/lovelies-pillow \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

EXPOSE 8080
USER lovelies
CMD ["/app/.venv/bin/python", "-m", "lovelies_ml_face"]

# Component artifacts and runtime inputs can be supplied by the local producer
# after their identities are verified; defaults reproduce all source builders.
FROM ${ML_SECURITY_ARTIFACTS} AS security-artifacts
FROM ${ML_SECURITY_RUNTIME} AS security-runtime
USER 0
# An optional reused runtime must precede minimization. A finished release image
# deliberately lacks a shell/package tools and cannot be an installation stage.
RUN ["/app/.venv/bin/python", "-c", "from pathlib import Path; assert all(Path(p).exists() for p in ('/bin/sh', '/usr/bin/dpkg', '/sbin/ldconfig')), 'ML_SECURITY_RUNTIME must be an unminimized runtime with sh, dpkg and ldconfig; use the default runtime stage rather than a final release image'"]
COPY --from=security-artifacts /debs/ /tmp/security-native-debs/
RUN dpkg --path-include='/usr/share/doc/libc6' --path-include='/usr/share/doc/libc6/*' \
         --path-include='/usr/share/doc/zlib1g' --path-include='/usr/share/doc/zlib1g/*' \
         -i /tmp/security-native-debs/zlib1g.deb /tmp/security-native-debs/libc6.deb \
    && ldconfig \
    && rm -rf /tmp/security-native-debs
COPY --from=security-artifacts /pydantic-doc/ /usr/local/share/doc/lovelies-pydantic/
COPY --from=security-artifacts /wheels/ /tmp/security-wheels/
COPY patches/pydantic-source-build /usr/local/share/doc/lovelies-pydantic/recipes
COPY patches/security-library-fixes /usr/local/share/doc/lovelies-security-native/recipes
COPY patches/security-runtime-minimization /usr/local/share/doc/lovelies-minimization
RUN /app/.venv/bin/python - <<'PYINSTALL'
import json
from pathlib import Path
import subprocess
provenance = json.loads(Path('/usr/local/share/doc/lovelies-pydantic/build-provenance.json').read_text())
wheels = list(Path('/tmp/security-wheels').glob('*.whl'))
assert len(wheels) == 1
subprocess.run([
    '/app/.venv/bin/python', '/usr/local/share/doc/lovelies-pydantic/recipes/install-wheel.py',
    '--wheel', str(wheels[0]), '--expected-sha256', provenance['wheel']['sha256'],
    '--site-packages', '/app/.venv/lib/python3.13/site-packages',
    '--receipt', '/usr/local/share/doc/lovelies-pydantic/install-receipt.json',
], check=True)
wheels[0].unlink()
wheels[0].parent.rmdir()
PYINSTALL
COPY src /app/src
COPY models /app/models
COPY licenses /app/licenses
COPY pyproject.toml uv.lock /app/
COPY Dockerfile /usr/local/share/doc/lovelies-build/Dockerfile
RUN chmod -R a+rX,go-w /app /usr/local/share/doc/lovelies-pydantic /usr/local/share/doc/lovelies-security-native /usr/local/share/doc/lovelies-minimization \
    && /app/.venv/bin/python /usr/local/share/doc/lovelies-minimization/minimize-runtime.py \
       --manifest=/usr/local/share/doc/lovelies-minimization/removal-plan.json \
       --receipt=/usr/local/share/doc/lovelies-minimization/receipt.json
USER lovelies
CMD ["/app/.venv/bin/python", "-m", "lovelies_ml_face"]

# Publish the merged runtime filesystem in one layer. Removed installers and
# replaced publisher compiler libraries must not survive in exported old layers.
FROM scratch AS final
COPY --from=security-runtime / /
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_MANIFEST_PATH=/app/models/model-manifest.json \
    PYTHONPATH=/app/src \
    PORT=8080 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/certs
WORKDIR /app
EXPOSE 8080
USER lovelies
CMD ["/app/.venv/bin/python", "-m", "lovelies_ml_face"]
