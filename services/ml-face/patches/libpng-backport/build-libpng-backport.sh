#!/bin/sh
set -eu

ml_png_root=/png
ml_png_source="$ml_png_root/source/libpng-1.6.48"
ml_png_package="$ml_png_root/package"
ml_png_version=1.6.48-1+deb13u5+lovelies1
ml_png_arch=$(dpkg --print-architecture)
ml_png_triplet=$(dpkg-architecture --query DEB_HOST_MULTIARCH)
mkdir -p "$ml_png_root/source" "$ml_png_root/out" "$ml_png_package/DEBIAN"
cd "$ml_png_root"
echo 'b17e99026055727e8cba99160c3a9a7f9af788e9f786daeadded5a42243f1dd0  libpng1.6_1.6.48.orig.tar.gz' | sha256sum --check
echo 'b38d5929b9a6139f2ce02a0e831d0f3f5365410b050dc429ea079a73253fe97a  libpng1.6_1.6.48-1+deb13u5.debian.tar.xz' | sha256sum --check
echo '746ec351ac044becb16725b903aee2c53815da9f89630767b6edbb317a50f98e  libpng1.6_1.6.48-1+deb13u5.dsc' | sha256sum --check
echo 'dded9c3cd0106f078a73559abaa713dd8712c9c12c0335d92fcf6ce9258ad7a4  libpng-CVE-2026-46675-upstream.patch' | sha256sum --check
tar -xzf libpng1.6_1.6.48.orig.tar.gz -C source
tar -xJf libpng1.6_1.6.48-1+deb13u5.debian.tar.xz -C "$ml_png_source"
cd "$ml_png_source"
while IFS= read -r ml_png_patch; do
    case "$ml_png_patch" in ''|'#'*) continue ;; esac
    patch --batch --fuzz=0 -p1 < "debian/patches/$ml_png_patch"
done < debian/patches/series
echo '3b42bc9881042ecd853cefae8e756888f0ccddf4df096a289a64dcde28f3a135  pngrutil.c' | sha256sum --check
patch --batch --fuzz=0 -p1 < "$ml_png_root/libpng-CVE-2026-46675-upstream.patch"
echo 'd776c2fb7eb9290c5a346c7ad27f48ef6dadeb5d5186f90e2213eae1ca015bc4  pngrutil.c' | sha256sum --check

export DEB_BUILD_MAINT_OPTIONS='hardening=+all future=+lfs'
eval "$(dpkg-buildflags --export=sh)"
cmake -S "$ml_png_source" -B "$ml_png_root/build" -DCMAKE_BUILD_TYPE=Release \
    -DPNG_SHARED=ON -DPNG_STATIC=OFF -DPNG_TESTS=ON -DPNG_TOOLS=OFF \
    "-DCMAKE_C_FLAGS=$CFLAGS $CPPFLAGS" "-DCMAKE_SHARED_LINKER_FLAGS=$LDFLAGS" \
    -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR="lib/$ml_png_triplet"
cmake --build "$ml_png_root/build" --parallel 2
ctest --test-dir "$ml_png_root/build" --output-on-failure > "$ml_png_root/out/upstream-tests.log"
DESTDIR="$ml_png_package" cmake --install "$ml_png_root/build"
rm -rf "$ml_png_package/usr/include" "$ml_png_package/usr/bin" "$ml_png_package/usr/share/man" \
    "$ml_png_package/usr/lib/$ml_png_triplet/pkgconfig" "$ml_png_package/usr/lib/$ml_png_triplet/cmake"
ml_png_library="$ml_png_package/usr/lib/$ml_png_triplet/libpng16.so.16"
nm -D --defined-only "/usr/lib/$ml_png_triplet/libpng16.so.16" | awk '{print $3}' | sed -n '/^png_/p' | sort > "$ml_png_root/out/original-png-api.txt"
nm -D --defined-only "$ml_png_library" | awk '{print $3}' | sed -n '/^png_/p' | sort > "$ml_png_root/out/patched-png-api.txt"
test -s "$ml_png_root/out/original-png-api.txt"
test -s "$ml_png_root/out/patched-png-api.txt"
cmp "$ml_png_root/out/original-png-api.txt" "$ml_png_root/out/patched-png-api.txt"
readelf -d "$ml_png_library" | grep 'SONAME.*\[libpng16.so.16\]' > "$ml_png_root/out/patched-soname.txt"
readelf -lW "$ml_png_library" | grep GNU_RELRO > "$ml_png_root/out/elf-hardening.txt"
readelf -dW "$ml_png_library" | grep BIND_NOW >> "$ml_png_root/out/elf-hardening.txt"
nm -D "$ml_png_library" | grep __stack_chk_fail >> "$ml_png_root/out/elf-hardening.txt"

cat > "$ml_png_package/DEBIAN/control" <<EOF
Package: libpng16-16t64
Version: $ml_png_version
Architecture: $ml_png_arch
Multi-Arch: same
Source: libpng1.6
Maintainer: Lovelies local readiness build
Section: libs
Priority: optional
Depends: libc6 (>= 2.38), zlib1g (>= 1:1.1.4)
Description: Shared PNG library with verified stale inflate buffer fix
 Exact Debian 1.6.48-1+deb13u5 source and patches, plus upstream
 aa77ef38c17ab2fc1b41bec09fb973c6a386641d for CVE-2026-46675.
 This local build is not an official Debian release or independent approval.
EOF
ml_png_doc="$ml_png_package/usr/share/doc/libpng16-16t64"
mkdir -p "$ml_png_doc/source"
cp "$ml_png_source/debian/copyright" "$ml_png_doc/copyright"
cp "$ml_png_source/LICENSE" "$ml_png_doc/LICENSE-libpng.txt"
cp "$ml_png_root/libpng1.6_1.6.48.orig.tar.gz" "$ml_png_root/libpng1.6_1.6.48-1+deb13u5.debian.tar.xz" \
    "$ml_png_root/libpng1.6_1.6.48-1+deb13u5.dsc" "$ml_png_root/libpng-CVE-2026-46675-upstream.patch" \
    "$ml_png_root/libpng-backport-manifest.json" "$ml_png_root/build-libpng-backport.sh" "$ml_png_doc/source/"
cp "$ml_png_root/libpng-NOTICE.txt" "$ml_png_doc/LOVELIES-MODIFICATION-NOTICE.txt"
cp "$ml_png_root/out/"*.txt "$ml_png_root/out/"*.log "$ml_png_doc/"
python - "$ml_png_doc" "$ml_png_library" "$ml_png_arch" <<'PY'
import hashlib,json,sys
from pathlib import Path
doc,library,arch=Path(sys.argv[1]),Path(sys.argv[2]).resolve(),sys.argv[3]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
receipt={"schema":"lovelies-libpng-backport-build-receipt-v1","architecture":arch,
 "debian_base_version":"1.6.48-1+deb13u5","package_version":"1.6.48-1+deb13u5+lovelies1",
 "upstream_fix_commit":"aa77ef38c17ab2fc1b41bec09fb973c6a386641d","zero_context_fuzz":True,
 "manifest_sha256":sha(doc/'source/libpng-backport-manifest.json'),
 "runtime_library":{"filename":library.name,"sha256":sha(library),"bytes":library.stat().st_size},
 "unchanged_exported_png_api":True,"soname":"libpng16.so.16",
 "security_reproduction_status":"not_run",
 "security_reproduction_reason":"Validation narrowed to patch/source/hash/ABI review and normal upstream valid-codec tests.",
 "upstream_ctest_passed":True,
 "evidence_files":[{"path":p.name,"sha256":sha(p),"bytes":p.stat().st_size} for p in sorted(doc.glob('*')) if p.is_file()]}
(doc/'lovelies-libpng-backport-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
PY
chmod -R a+rX "$ml_png_doc"
dpkg-deb --root-owner-group --build "$ml_png_package" "$ml_png_root/out/libpng16-16t64.deb"
