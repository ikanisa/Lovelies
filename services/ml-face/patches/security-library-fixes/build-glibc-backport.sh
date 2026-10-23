#!/bin/sh
set -eu
# Native AMD64 fixtures under emulation retain their standard timeout control.
export TIMEOUTFACTOR=${TIMEOUTFACTOR:-8}
ml_glibc_jobs=${LOVELIES_GLIBC_BUILD_JOBS:-2}
case "$ml_glibc_jobs" in
    1|2|3|4) ;;
    *) printf '%s\n' 'LOVELIES_GLIBC_BUILD_JOBS must be an integer from 1 to 4' >&2; exit 2 ;;
esac

ml_glibc_root=/glibc
ml_glibc_source="$ml_glibc_root/source/glibc-2.41"
ml_glibc_build="$ml_glibc_root/build"
ml_glibc_install="$ml_glibc_root/install"
ml_glibc_version=2.41-12+deb13u4+lovelies2
ml_glibc_arch=$(dpkg --print-architecture)
ml_glibc_triplet=$(dpkg-architecture --query DEB_HOST_MULTIARCH)
test "$ml_glibc_arch" = amd64
mkdir -p "$ml_glibc_root/out"
python3 - "$ml_glibc_jobs" "$TIMEOUTFACTOR" <<'PY'
import hashlib,json,sys
from pathlib import Path
recipe=Path('/fixes/build-glibc-backport.sh')
record={'schema':'lovelies-glibc-native-execution-input-v1',
        'build_jobs':int(sys.argv[1]),'test_timeout_factor':sys.argv[2],
        'recipe_sha256':hashlib.sha256(recipe.read_bytes()).hexdigest(),
        'scope':'Same bounded job count used for native build, vendor tests and install'}
Path('/glibc/out/execution-inputs.json').write_text(json.dumps(record,indent=2)+'\n')
PY
if [ ! -f "$ml_glibc_root/out/source-patch-application.json" ]; then
    python3 /fixes/prepare-glibc-backports.py
fi
python3 - "$ml_glibc_root/out/source-patch-application.json" /fixes/glibc-patch-downloads.json <<'PY'
import hashlib,json,sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
patches=json.loads(Path(sys.argv[2]).read_text())
patches+=json.loads(Path('/fixes/glibc-backport-manifest.json').read_text())['local_security_patches']
assert r['passed'] and len(r['patches']) == 80 + len(patches)
actual=r['patches'][80:]
assert [(p['filename'],p['sha256']) for p in actual] == [(p['filename'],p['sha256']) for p in patches]
for p in patches:
 assert hashlib.sha256((Path('/fixes')/p['filename']).read_bytes()).hexdigest()==p['sha256']
PY
if [ "${1:-}" = --unaccepted-diagnostic-build ]; then
    # This opt-in supplemental lane does not satisfy the canonical native gate.
    test -s "$ml_glibc_build/config.status"
    cd "$ml_glibc_build"
    make --jobs="$ml_glibc_jobs" > "$ml_glibc_root/out/diagnostic-build.log" 2>&1
    python3 /fixes/run-glibc-supplemental-diagnostic.py
    python3 /fixes/run-glibc-local-profile.py
    make --jobs="$ml_glibc_jobs" install install_root="$ml_glibc_install" > "$ml_glibc_root/out/diagnostic-install.log" 2>&1
    python3 /fixes/package-glibc-backport.py --unaccepted-diagnostic
    exit 0
fi
if [ "${1:-}" != --package-existing-build ]; then
    if [ "${1:-}" != --resume-build ]; then
    test ! -e "$ml_glibc_build/config.status"
    mkdir -p "$ml_glibc_build"
    mkdir -p "$ml_glibc_root/kernel-headers"
    cp -a /usr/include/linux /usr/include/asm-generic \
        "/usr/include/$ml_glibc_triplet/asm" "$ml_glibc_root/kernel-headers/"
    cd "$ml_glibc_build"
    printf '%s\n' "slibdir = /usr/lib/$ml_glibc_triplet" 'rtlddir = /usr/lib64' > configparms
    CC='gcc -U_FILE_OFFSET_BITS -U_TIME_BITS' CXX='g++ -U_FILE_OFFSET_BITS -U_TIME_BITS' \
        CFLAGS='-pipe -O2 -g -fdebug-prefix-map=/glibc=.' MAKEINFO=: \
        "$ml_glibc_source/configure" --host=x86_64-linux-gnu --build=x86_64-linux-gnu \
        --prefix=/usr --libdir="/usr/lib/$ml_glibc_triplet" --without-selinux --disable-crypt \
        --enable-bind-now --enable-fortify-source --enable-stackguard-randomization \
        --enable-stack-protector=strong --with-pkgversion='Lovelies modified Debian GLIBC2.41-12+deb13u4' \
        --with-headers="$ml_glibc_root/kernel-headers" --enable-kernel=3.17 --enable-multi-arch --disable-werror \
        > "$ml_glibc_root/out/configure.log" 2>&1
    else
        test -s "$ml_glibc_build/config.status"
        test -s "$ml_glibc_build/config.make"
        cd "$ml_glibc_build"
    fi
    make --jobs="$ml_glibc_jobs" > "$ml_glibc_root/out/build.log" 2>&1
fi
test -s "$ml_glibc_build/libc.so"
test -s "$ml_glibc_build/config.make"
cd "$ml_glibc_build"
# Only the affected vendor regressions and their normal API consumers are run.
# The wordexp vendor test is executed unchanged against its exact NSS fixtures
# inside this owned Linux builder. This avoids nested namespace prerequisites.
make --jobs="$ml_glibc_jobs" check subdirs=stdlib tests='tst-strfmon-bug34510 tst-strfmon_l' \
    tests-special= tests-container= > "$ml_glibc_root/out/stdlib-tests.log" 2>&1
make --jobs="$ml_glibc_jobs" check subdirs=misc tests='tst-tsearch' \
    tests-special= tests-container= > "$ml_glibc_root/out/misc-tests.log" 2>&1
mkdir -p "$ml_glibc_root/nss-baseline"
for ml_glibc_fixture in passwd group nsswitch.conf; do
    cp -a "/etc/$ml_glibc_fixture" "$ml_glibc_root/nss-baseline/$ml_glibc_fixture"
done
ml_glibc_restore_nss() {
    for ml_glibc_fixture in passwd group nsswitch.conf; do
        cp -a "$ml_glibc_root/nss-baseline/$ml_glibc_fixture" "/etc/$ml_glibc_fixture"
    done
}
trap ml_glibc_restore_nss EXIT INT TERM
for ml_glibc_fixture in passwd group nsswitch.conf; do
    cp "$ml_glibc_source/posix/tst-wordexp-tilde.root/etc/$ml_glibc_fixture" "/etc/$ml_glibc_fixture"
done
python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
fixtures=[]
for name in ['passwd','group','nsswitch.conf']:
 p=Path('/glibc/source/glibc-2.41/posix/tst-wordexp-tilde.root/etc')/name
 current=Path('/etc')/name
 assert current.read_bytes()==p.read_bytes()
 fixtures.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
assert os.environ.get('HOME') == '/root'
r={'schema':'lovelies-glibc-vendor-wordexp-fixture-context-v1',
   'execution':'Unmodified upstream test binary run as a regular vendor test in the owned builder against its exact NSS fixture bytes',
   'nested_test_container_wrapper_used':False,'home':'/root','fixtures':fixtures}
Path('/glibc/out/wordexp-fixture-context.json').write_text(json.dumps(r,indent=2)+'\n')
PY
make --jobs="$ml_glibc_jobs" check subdirs=posix tests='tst-wordexp-append tst-wordexp-tilde' \
    tests-special= tests-container= > "$ml_glibc_root/out/posix-tests.log" 2>&1
ml_glibc_restore_nss
trap - EXIT INT TERM
make --jobs="$ml_glibc_jobs" check subdirs=libio tests='tst-fopen-ccs-empty' \
    tests-special= tests-container= > "$ml_glibc_root/out/libio-tests.log" 2>&1
make --jobs="$ml_glibc_jobs" check subdirs=iconvdata tests='tst-jisx0213-progress' \
    tests-special= tests-container= > "$ml_glibc_root/out/iconvdata-tests.log" 2>&1
# The unchanged resolver fixtures create their own UTS/network namespaces and
# chroots. Their owned network-none Linux test container must permit unshare,
# SYS_ADMIN, NET_ADMIN, SYS_CHROOT and NET_BIND_SERVICE. Root UID/GID mapping
# also needs SETUID, SETGID and SETFCAP in the parent namespace. A restricted
# builder's UNSUPPORTED result is a failed required gate. The completed tree
# may be reused in an isolated
# namespace-capable fixture container; never edit or skip the vendor tests.
make --jobs="$ml_glibc_jobs" check subdirs=resolv tests='tst-ns_sprintrr tst-resolv-res_init tst-resolv-res_init-multi tst-resolv-res_init-thread' \
    tests-special= tests-container= > "$ml_glibc_root/out/resolv-tests.log" 2>&1
python3 - <<'PY'
from pathlib import Path
for name in ['tst-ns_sprintrr', 'tst-resolv-res_init',
             'tst-resolv-res_init-multi', 'tst-resolv-res_init-thread']:
    result = Path('/glibc/build/resolv') / (name + '.test-result')
    if not result.is_file() or not result.read_text().startswith('PASS:'):
        raise RuntimeError('Required unchanged resolver fixture did not pass; '
                           'use a namespace-capable owned Linux test container: ' + name)
PY
make --jobs="$ml_glibc_jobs" check subdirs=nptl tests='tst-stack2 tst-stack3 tst-attr3 tst-minstack-cancel tst-minstack-exit tst-minstack-throw tst-stackguard1 tst-tls3 tst-tls5' \
    tests-special= tests-container= > "$ml_glibc_root/out/nptl-tests.log" 2>&1
make --jobs="$ml_glibc_jobs" check subdirs=malloc tests='tst-mallocalign1 tst-malloc-thread-exit tst-malloc-thread-fail tst-malloc-fork-deadlock tst-malloc-alternate-path tst-malloc_info tst-mallinfo2' \
    tests-special= tests-container= > "$ml_glibc_root/out/malloc-tests.log" 2>&1
python3 /fixes/run-glibc-local-profile.py
make --jobs="$ml_glibc_jobs" install install_root="$ml_glibc_install" > "$ml_glibc_root/out/install.log" 2>&1
python3 /fixes/package-glibc-backport.py
