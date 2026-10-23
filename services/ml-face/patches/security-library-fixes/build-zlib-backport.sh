#!/bin/sh
set -eu

ml_zlib_root=/zlib
ml_zlib_version='1:1.3.dfsg+really1.3.1-1+lovelies1'
ml_zlib_arch=$(dpkg --print-architecture)
ml_zlib_triplet=$(dpkg-architecture --query DEB_HOST_MULTIARCH)
ml_zlib_package="$ml_zlib_root/package"
mkdir -p "$ml_zlib_root/source" "$ml_zlib_root/out" "$ml_zlib_package/DEBIAN"
cd "$ml_zlib_root"
echo '60dd315c07f616887caa029408308a018ace66e3d142726a97db164b3b8f69fb  zlib_1.3.dfsg+really1.3.1.orig.tar.gz' | sha256sum --check
echo '9ed525955ce9fb0c1b39be8ff98f73450dbfc6305a9a27e6149c8972d38a0a9e  zlib_1.3.dfsg+really1.3.1-1.debian.tar.xz' | sha256sum --check
echo 'ede2791e29c1d3b422f9208bdd7edf040c20445ea1e7453a72037576e64fa197  zlib_1.3.dfsg+really1.3.1-1.dsc' | sha256sum --check
echo '4c4a40b7329015fd89070667dd32e9307819e699d3ec4118af0a959f5fe1608c  zlib-CVE-2026-27171-upstream.patch' | sha256sum --check
tar -xzf zlib_1.3.dfsg+really1.3.1.orig.tar.gz -C source
ml_zlib_source="$ml_zlib_root/source/zlib-1.3.1"
tar -xJf zlib_1.3.dfsg+really1.3.1-1.debian.tar.xz -C "$ml_zlib_source"
cd "$ml_zlib_source"
# This exact Debian source descriptor has an empty quilt series.
test ! -s debian/patches/series
echo '8fd16f0a7714d51c89c2eb37eb98ec15e8a4dc57ba343e7b7398b19144039fda  crc32.c' | sha256sum --check
echo '8a5579af72ea4f427ff00a4150f0ccb3fc5c1e4379f726e101133b1ab9fc600c  zlib.h' | sha256sum --check
patch --batch --fuzz=0 -p1 < "$ml_zlib_root/zlib-CVE-2026-27171-upstream.patch"
echo 'c22779085fe88efe499c67a95bd6d5e752ffb62149b4d24e715178285a9247ab  crc32.c' | sha256sum --check
echo '55190843e28bfeb23d0fc1afb7d067f4443462b42ad81515cc80872da71c95bf  zlib.h' | sha256sum --check

export DEB_BUILD_MAINT_OPTIONS='hardening=+all future=+lfs'
eval "$(dpkg-buildflags --export=sh)"
export CFLAGS="$CFLAGS $CPPFLAGS"
./configure --prefix=/usr --libdir="/usr/lib/$ml_zlib_triplet" --shared > "$ml_zlib_root/out/configure.log"
make --jobs=2 > "$ml_zlib_root/out/build.log" 2>&1
make test > "$ml_zlib_root/out/upstream-tests.log" 2>&1
cc $CFLAGS -I. "$ml_zlib_root/zlib-negative-length-check.c" -L. -Wl,-rpath,"$ml_zlib_source" -lz -o "$ml_zlib_root/out/api-check"
timeout --kill-after=2 5 "$ml_zlib_root/out/api-check" > "$ml_zlib_root/out/api-check.log" 2>&1
make DESTDIR="$ml_zlib_package" install > "$ml_zlib_root/out/install.log"
rm -rf "$ml_zlib_package/usr/include" "$ml_zlib_package/usr/share" \
    "$ml_zlib_package/usr/lib/$ml_zlib_triplet/pkgconfig"
rm -f "$ml_zlib_package/usr/lib/$ml_zlib_triplet/libz.a" "$ml_zlib_package/usr/lib/$ml_zlib_triplet/libz.so"
ml_zlib_library="$ml_zlib_package/usr/lib/$ml_zlib_triplet/libz.so.1.3.1"
nm -D --defined-only "/usr/lib/$ml_zlib_triplet/libz.so.1" | awk '{print $3}' | sort > "$ml_zlib_root/out/original-zlib-api.txt"
nm -D --defined-only "$ml_zlib_library" | awk '{print $3}' | sort > "$ml_zlib_root/out/patched-zlib-api.txt"
test -s "$ml_zlib_root/out/original-zlib-api.txt"
cmp "$ml_zlib_root/out/original-zlib-api.txt" "$ml_zlib_root/out/patched-zlib-api.txt"
readelf -d "$ml_zlib_library" | grep 'SONAME.*\[libz.so.1\]' > "$ml_zlib_root/out/patched-soname.txt"
readelf -lW "$ml_zlib_library" | grep GNU_RELRO > "$ml_zlib_root/out/elf-hardening.txt"
readelf -dW "$ml_zlib_library" | grep BIND_NOW >> "$ml_zlib_root/out/elf-hardening.txt"
nm -D "$ml_zlib_library" | grep __stack_chk_fail >> "$ml_zlib_root/out/elf-hardening.txt"
cat > "$ml_zlib_package/DEBIAN/control" <<EOF
Package: zlib1g
Version: $ml_zlib_version
Architecture: $ml_zlib_arch
Multi-Arch: same
Source: zlib (1:1.3.dfsg+really1.3.1-1)
Maintainer: Lovelies local readiness build
Section: libs
Priority: required
Depends: libc6 (>= 2.4)
Description: Shared zlib with upstream negative CRC length validation
 Exact Debian 1.3.1 source plus upstream ba829a458576d1ff0f26fc7230c6de816d1f6a77.
 This local build is not an official Debian release or independent approval.
EOF
ml_zlib_doc="$ml_zlib_package/usr/share/doc/zlib1g"
mkdir -p "$ml_zlib_doc/source"
cp "$ml_zlib_source/debian/copyright" "$ml_zlib_doc/copyright"
cp "$ml_zlib_source/LICENSE" "$ml_zlib_doc/LICENSE-zlib.txt"
cp "$ml_zlib_root/zlib_1.3.dfsg+really1.3.1.orig.tar.gz" \
   "$ml_zlib_root/zlib_1.3.dfsg+really1.3.1-1.debian.tar.xz" \
   "$ml_zlib_root/zlib_1.3.dfsg+really1.3.1-1.dsc" \
   "$ml_zlib_root/zlib-CVE-2026-27171-upstream.patch" \
   "$ml_zlib_root/zlib-backport-manifest.json" \
   "$ml_zlib_root/build-zlib-backport.sh" \
   "$ml_zlib_root/zlib-negative-length-check.c" "$ml_zlib_doc/source/"
cp "$ml_zlib_root/zlib-NOTICE.txt" "$ml_zlib_doc/LOVELIES-MODIFICATION-NOTICE.txt"
cp "$ml_zlib_root/out/"*.txt "$ml_zlib_root/out/"*.log "$ml_zlib_doc/"
python - "$ml_zlib_doc" "$ml_zlib_library" "$ml_zlib_arch" <<'PY'
import hashlib,json,sys
from pathlib import Path
doc,library,arch=Path(sys.argv[1]),Path(sys.argv[2]).resolve(),sys.argv[3]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
receipt={"schema":"lovelies-zlib-backport-build-receipt-v1","architecture":arch,
 "debian_base_version":"1:1.3.dfsg+really1.3.1-1","package_version":"1:1.3.dfsg+really1.3.1-1+lovelies1",
 "upstream_fix_commit":"ba829a458576d1ff0f26fc7230c6de816d1f6a77","zero_context_fuzz":True,
 "manifest_sha256":sha(doc/'source/zlib-backport-manifest.json'),
 "runtime_library":{"filename":library.name,"sha256":sha(library),"bytes":library.stat().st_size},
 "unchanged_exported_zlib_api":True,"soname":"libz.so.1","upstream_tests_passed":True,
 "negative_length_and_normal_api_check_passed":True,
 "evidence_files":[{"path":p.name,"sha256":sha(p),"bytes":p.stat().st_size} for p in sorted(doc.glob('*')) if p.is_file()]}
(doc/'lovelies-zlib-backport-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
PY
chmod -R a+rX "$ml_zlib_doc"
dpkg-deb --root-owner-group --build "$ml_zlib_package" "$ml_zlib_root/out/zlib1g.deb"
