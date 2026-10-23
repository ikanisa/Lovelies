#!/bin/sh
set -eu

# Official 3.5.9 release, retaining Debian's seven packaging/configuration
# patches. Earlier security fixes are included upstream, not removed or waived.
ml_ssl_arch=$(dpkg --print-architecture)
ml_ssl_triplet=$(dpkg-architecture -qDEB_HOST_MULTIARCH)
ml_ssl_version=3.5.9-0+lovelies1
ml_ssl_source=/openssl/source/openssl-3.5.9
mkdir -p /openssl/source /openssl/out /openssl/stage
tar -xzf /openssl/openssl-3.5.9.tar.gz -C /openssl/source
tar -xJf /openssl/openssl_3.5.7-1~deb13u2.debian.tar.xz -C "$ml_ssl_source"
cd "$ml_ssl_source"
for ml_ssl_patch in debian-targets.patch man-section.patch no-symbolic.patch \
    pic.patch c_rehash-compat.patch \
    Configure-allow-to-enable-ktls-if-target-does-not-start-w.patch \
    conf-Serialize-allocation-free-of-ssl_names.patch; do
    patch --batch --fuzz=0 -p1 -i "debian/patches/$ml_ssl_patch"
done

# Match Debian's build hardening, feature selection and trust/provider paths.
export DEB_BUILD_MAINT_OPTIONS='hardening=+all future=+lfs'
eval "$(dpkg-buildflags --export=sh)"
ml_ssl_cpu_flags=
case "$ml_ssl_arch" in
    amd64|arm64|ppc64el|riscv64) ml_ssl_cpu_flags=enable-ec_nistp_64_gcc_128 ;;
esac
ml_ssl_padlock=no-padlockeng
case "$ml_ssl_arch" in amd64|i386) ml_ssl_padlock= ;; esac
# Empty feature variables intentionally expand to no argument.
# shellcheck disable=SC2086
HASHBANGPERL=/usr/bin/perl ./Configure shared \
    --prefix=/usr --openssldir=/usr/lib/ssl \
    "--libdir=lib/$ml_ssl_triplet" \
    no-idea no-mdc2 no-rc5 no-ssl3 enable-unit-test no-ssl3-method \
    enable-rfc3779 enable-cms no-capieng no-rdrand \
    enable-tfo enable-zstd enable-zlib enable-fips \
    $ml_ssl_cpu_flags $ml_ssl_padlock "debian-$ml_ssl_arch"
perl configdata.pm --dump > /openssl/out/build-configuration.txt
make -j2
# Run the actual upstream suite; a failure stops image construction.
make -j2 test > /openssl/out/upstream-tests.log 2>&1
cat /openssl/out/upstream-tests.log
make install_sw DESTDIR=/openssl/stage

# Require every original exported symbol, including its version namespace.
for ml_ssl_library in libcrypto.so.3 libssl.so.3; do
    nm -D --defined-only "/usr/lib/$ml_ssl_triplet/$ml_ssl_library" \
        | awk '{print $3}' | sort > "/openssl/out/original-$ml_ssl_library-api.txt"
    nm -D --defined-only "/openssl/stage/usr/lib/$ml_ssl_triplet/$ml_ssl_library" \
        | awk '{print $3}' | sort > "/openssl/out/patched-$ml_ssl_library-api.txt"
    test -s "/openssl/out/original-$ml_ssl_library-api.txt"
    test -s "/openssl/out/patched-$ml_ssl_library-api.txt"
    comm -23 "/openssl/out/original-$ml_ssl_library-api.txt" \
        "/openssl/out/patched-$ml_ssl_library-api.txt" > /openssl/out/missing-api.txt
    test ! -s /openssl/out/missing-api.txt
    readelf -d "/openssl/stage/usr/lib/$ml_ssl_triplet/$ml_ssl_library" \
        | grep -F "Library soname: [$ml_ssl_library]"
done

for ml_ssl_package in libssl3t64 openssl openssl-provider-legacy; do
    ml_ssl_root="/openssl/packages/$ml_ssl_package"
    ml_ssl_doc="$ml_ssl_root/usr/share/doc/$ml_ssl_package"
    mkdir -p "$ml_ssl_root/DEBIAN" "$ml_ssl_doc"
    case "$ml_ssl_package" in
        libssl3t64)
            mkdir -p "$ml_ssl_root/usr/lib/$ml_ssl_triplet"
            cp /openssl/stage/usr/lib/"$ml_ssl_triplet"/libcrypto.so.3 \
                /openssl/stage/usr/lib/"$ml_ssl_triplet"/libssl.so.3 \
                "$ml_ssl_root/usr/lib/$ml_ssl_triplet/"
            cp -R /openssl/stage/usr/lib/"$ml_ssl_triplet"/engines-3 \
                "$ml_ssl_root/usr/lib/$ml_ssl_triplet/"
            ml_ssl_dependencies='libc6 (>= 2.38), libzstd1 (>= 1.5.5), zlib1g (>= 1:1.2.2), openssl-provider-legacy'
            cp /openssl/out/*-api.txt "$ml_ssl_doc/"
            printf '%s\n' 'activate-noawait ldconfig' > "$ml_ssl_root/DEBIAN/triggers"
            printf '%s\n' 'Replaces: libssl3' \
                "Provides: libssl3 (= $ml_ssl_version)" \
                "Breaks: libssl3 (<< $ml_ssl_version), openssh-client (<< 1:9.4p1), openssh-server (<< 1:9.4p1), python3-m2crypto (<< 0.38.0-4), freeradius (<< 3.2.7+dfsg-1+deb13u1)" \
                > "$ml_ssl_root/DEBIAN/compatibility-fields"
            ;;
        openssl)
            mkdir -p "$ml_ssl_root/usr/bin" "$ml_ssl_root/usr/lib" "$ml_ssl_root/etc/ssl/private"
            cp /openssl/stage/usr/bin/openssl /openssl/stage/usr/bin/c_rehash "$ml_ssl_root/usr/bin/"
            cp -a /usr/lib/ssl "$ml_ssl_root/usr/lib/ssl"
            cp /etc/ssl/openssl.cnf "$ml_ssl_root/etc/ssl/openssl.cnf"
            chmod 700 "$ml_ssl_root/etc/ssl/private"
            printf '%s\n' '/etc/ssl/openssl.cnf' > "$ml_ssl_root/DEBIAN/conffiles"
            printf '%s\n' 'Suggests: ca-certificates' > "$ml_ssl_root/DEBIAN/compatibility-fields"
            ml_ssl_dependencies="libc6 (>= 2.38), libssl3t64 (>= $ml_ssl_version)"
            # Retain existing Debian /etc/ssl config, certs and helper paths.
            ;;
        openssl-provider-legacy)
            mkdir -p "$ml_ssl_root/usr/lib/$ml_ssl_triplet/ossl-modules"
            cp /openssl/stage/usr/lib/"$ml_ssl_triplet"/ossl-modules/legacy.so \
                "$ml_ssl_root/usr/lib/$ml_ssl_triplet/ossl-modules/"
            ml_ssl_dependencies="libc6 (>= 2.38), libssl3t64 (>= $ml_ssl_version)"
            printf '%s\n' 'Replaces: libssl3 (<< 3.3.1-5), libssl3t64 (<< 3.3.1-5)' \
                'Breaks: libssl3 (<< 3.3.1-5), libssl3t64 (<< 3.3.1-5)' \
                > "$ml_ssl_root/DEBIAN/compatibility-fields"
            ;;
    esac
    cat > "$ml_ssl_root/DEBIAN/control" <<EOF
Package: $ml_ssl_package
Version: $ml_ssl_version
Architecture: $ml_ssl_arch
Multi-Arch: $([ "$ml_ssl_package" = libssl3t64 ] && printf same || printf foreign)
Source: openssl
Maintainer: Lovelies local readiness build
Section: libs
Priority: optional
Depends: $ml_ssl_dependencies
Description: OpenSSL 3.5.9 security patch built for the existing Debian ABI
 Official publisher source with retained Debian configuration patches.
 Locally rebuilt by Lovelies; not an official Debian package or approval.
EOF
    cat "$ml_ssl_root/DEBIAN/compatibility-fields" >> "$ml_ssl_root/DEBIAN/control"
    rm "$ml_ssl_root/DEBIAN/compatibility-fields"
    cp LICENSE.txt "$ml_ssl_doc/copyright"
    cp /openssl/build-openssl-patch.sh "$ml_ssl_doc/"
    cp /openssl/out/build-configuration.txt /openssl/out/upstream-tests.log "$ml_ssl_doc/"
    printf '%s\n' \
        'Lovelies modified distribution, 30 September 2026.' \
        'Upstream OpenSSL 3.5.9 source SHA256: 603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a.' \
        'Debian configuration patches: 3.5.7-1~deb13u2, archive SHA256 593a47654ead460a3b609503733f80bef552ff0802799d3b47784faacc50809f.' \
        'Preserves shared SONAME 3, exported ABI, existing certificate/config paths and provider locations.' \
        'The upstream source is https://github.com/openssl/openssl/releases/tag/openssl-3.5.9.' \
        'Complete Apache-2.0 license is retained; upstream tests passing is not independent security or legal approval.' \
        'No FIPS certification is asserted; no new FIPS provider is distributed.' \
        > "$ml_ssl_doc/LOVELIES-MODIFICATION-NOTICE.txt"
    chmod -R a+rX "$ml_ssl_doc"
    dpkg-deb --root-owner-group --build "$ml_ssl_root" "/openssl/out/$ml_ssl_package.deb"
done
