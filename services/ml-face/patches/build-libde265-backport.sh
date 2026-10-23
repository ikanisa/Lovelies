#!/bin/sh
set -eu

# Rebuild the exact Debian source with its existing security patches and the
# immutable upstream CVE-2026-88373 fix. This is a Lovelies custom build.
ml_native_version=1.0.15-1+deb13u2+lovelies1
ml_native_arch=$(dpkg --print-architecture)
ml_native_triplet=$(dpkg-architecture --query DEB_HOST_MULTIARCH)
ml_native_source=/native/source/libde265-1.0.15
ml_native_package=/native/package
mkdir -p /native/source /native/out "$ml_native_package/DEBIAN"
tar -xzf /native/libde265_1.0.15.orig.tar.gz -C /native/source
tar -xJf /native/libde265_1.0.15-1+deb13u2.debian.tar.xz -C "$ml_native_source"
cd "$ml_native_source"
while IFS= read -r ml_native_patch; do
  case "$ml_native_patch" in ''|'#'*) continue ;; esac
  patch --batch --fuzz=0 -p1 < "debian/patches/$ml_native_patch"
done < debian/patches/series
patch --batch --fuzz=0 -p1 < /native/libde265-CVE-2026-88373.patch
# Upstream's CMake path omits the SONAME that Debian's autotools build uses.
# Retain the installed ABI0 and library filename; no API or struct is changed.
printf '%s\n' 'set_target_properties(de265 PROPERTIES SOVERSION 0 VERSION 0.1.8)' >> libde265/CMakeLists.txt
export DEB_BUILD_MAINT_OPTIONS='hardening=+all future=+lfs'
eval "$(dpkg-buildflags --export=sh)"
cmake -S . -B /native/build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
  "-DCMAKE_C_FLAGS=$CFLAGS $CPPFLAGS" \
  "-DCMAKE_CXX_FLAGS=$CXXFLAGS $CPPFLAGS" \
  "-DCMAKE_SHARED_LINKER_FLAGS=$LDFLAGS" \
  -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SDL=OFF \
  -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR="lib/$ml_native_triplet"
cmake --build /native/build --parallel 2
DESTDIR="$ml_native_package" cmake --install /native/build

# The runtime package includes the shared decoder, not development headers,
# pkg-config metadata or encoder/decoder command-line programs.
rm -rf "$ml_native_package/usr/include" "$ml_native_package/usr/lib/$ml_native_triplet/pkgconfig" "$ml_native_package/usr/lib/$ml_native_triplet/cmake"
ml_native_library="$ml_native_package/usr/lib/$ml_native_triplet/libde265.so.0"
nm -D --defined-only "/usr/lib/$ml_native_triplet/libde265.so.0" \
  | awk '{print $3}' | sed -n '/^de265_/p' | sort > /native/out/original-decoder-api.txt
nm -D --defined-only "$ml_native_library" \
  | awk '{print $3}' | sed -n '/^de265_/p' | sort > /native/out/patched-decoder-api.txt
test -s /native/out/original-decoder-api.txt
test -s /native/out/patched-decoder-api.txt
cmp /native/out/original-decoder-api.txt /native/out/patched-decoder-api.txt
readelf -d "$ml_native_library" | grep 'SONAME.*\[libde265.so.0\]' > /native/out/patched-soname.txt
readelf -lW "$ml_native_library" | grep GNU_RELRO > /native/out/elf-hardening.txt
readelf -dW "$ml_native_library" | grep BIND_NOW >> /native/out/elf-hardening.txt
nm -D "$ml_native_library" | grep __stack_chk_fail >> /native/out/elf-hardening.txt

cat > "$ml_native_package/DEBIAN/control" <<EOF
Package: libde265-0
Version: $ml_native_version
Architecture: $ml_native_arch
Multi-Arch: same
Source: libde265
Maintainer: Lovelies local readiness build
Section: libs
Priority: optional
Depends: libc6 (>= 2.38), libgcc-s1 (>= 3.0), libstdc++6 (>= 13.1)
Description: HEVC decoder with verified upstream NAL length fix
 Exact Debian 1.0.15-1+deb13u2 source and security patches, plus upstream
 f8d324914e43d92af23614f22959cf9eee7bf9ea. Locally rebuilt by Lovelies;
 this is not an official Debian security release or independent approval.
EOF
ml_native_doc="$ml_native_package/usr/share/doc/libde265-0"
mkdir -p "$ml_native_doc/source"
cp debian/copyright "$ml_native_doc/copyright"
cp /usr/share/common-licenses/LGPL-3 "$ml_native_doc/LGPL-3"
cp /usr/share/common-licenses/GPL-3 "$ml_native_doc/GPL-3"
cp /native/libde265_1.0.15.orig.tar.gz \
   /native/libde265_1.0.15-1+deb13u2.debian.tar.xz \
   /native/libde265-CVE-2026-88373.patch \
   /native/libde265-CVE-2026-88373-upstream.patch \
   /native/build-libde265-backport.sh "$ml_native_doc/source/"
cp /native/out/*-decoder-api.txt "$ml_native_doc/"
cp /native/out/elf-hardening.txt "$ml_native_doc/"
printf '%s\n' \
  'Lovelies modified build, 30 September 2026.' \
  'Debian source 1.0.15-1+deb13u2 plus immutable upstream fix f8d324914e43d92af23614f22959cf9eee7bf9ea.' \
  'Changed: NAL lengths below two bytes are rejected; zero-byte memcpy is skipped.' \
  'Packaging: CMake shared output retains Debian SONAME libde265.so.0 and filename libde265.so.0.1.8.' \
  'Complete corresponding source archives, patches and build script are in source/.' \
  'The library is shared and replaceable. Distribution/relinking obligations and legal review remain applicable.' \
  'No upstream, Debian, independent security or legal approval is implied.' > "$ml_native_doc/LOVELIES-MODIFICATION-NOTICE.txt"
# BuildKit remote ADD defaults to owner-only source archives. Corresponding
# source and notices must also be readable by the unprivileged runtime user.
chmod -R a+rX "$ml_native_doc"
dpkg-deb --root-owner-group --build "$ml_native_package" /native/out/libde265-0.deb
