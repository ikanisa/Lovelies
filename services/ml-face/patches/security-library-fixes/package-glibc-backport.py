#!/usr/bin/env python3
"""Package only the runtime paths owned by the existing Debian libc6."""
import argparse
import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path('/glibc')
SOURCE = ROOT / 'source/glibc-2.41'
INSTALL = ROOT / 'install'
PACKAGE = ROOT / 'package'
OUT = ROOT / 'out'
FIXES = Path('/fixes')
PACKAGE_VERSION = '2.41-12+deb13u4+lovelies2'
LOCAL_PROFILE_CHECKS = {
    'allocator-normal': 'glibc-allocation-entropy-check.c',
    'allocator-overrides': 'glibc-allocation-entropy-check.c',
    'tls-normal': 'glibc-tls-layout-check.c',
    'tls-overrides': 'glibc-tls-layout-check.c',
}
RETAINED_ADVISORY_IDS = {
    'CVE-2010-4756', 'CVE-2018-20796', 'CVE-2019-1010022',
    'CVE-2019-1010023', 'CVE-2019-1010024', 'CVE-2019-1010025', 'CVE-2019-9192',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(argv, timeout=60):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=timeout).stdout


def public_symbols(path):
    text = run(['nm', '-D', '--defined-only', str(path)])
    return sorted(line.split()[-1] for line in text.splitlines() if line.split() and '@GLIBC_PRIVATE' not in line)


def local_runtime_profile(loader, libc):
    path = OUT / 'local-runtime-profile-tests.json'
    profile = json.loads(path.read_text())
    if (profile.get('schema') != 'lovelies-glibc-local-runtime-profile-tests-v1'
            or profile.get('passed') is not True
            or profile.get('runtime_loader_sha256') != sha(loader)
            or profile.get('runtime_libc_sha256') != sha(libc)):
        raise RuntimeError('Local runtime profile is missing, failed, or bound to another libc/loader')
    checks = profile.get('checks', [])
    names = [row.get('name') for row in checks]
    if len(names) != len(LOCAL_PROFILE_CHECKS) or set(names) != set(LOCAL_PROFILE_CHECKS):
        raise RuntimeError('Local runtime profile must contain all four unique required fixture runs')
    for row in checks:
        if row.get('passed') is not True or row.get('returncode') != 0:
            raise RuntimeError('Local runtime fixture did not pass: ' + row['name'])
        source = row['fixture_source']
        binary = row['fixture_binary']
        stdout = row['stdout']
        expected_tunables = (
            'glibc.malloc.arena_max=64:glibc.malloc.tcache_count=32767:glibc.pthread.stack_cache_size=67108864'
            if row['name'].endswith('-overrides') else
            'glibc.malloc.arena_max=1:glibc.malloc.tcache_count=0:glibc.pthread.stack_cache_size=0')
        if row.get('environment', {}).get('GLIBC_TUNABLES') != expected_tunables:
            raise RuntimeError('Local fixture normal/override environment was not measured')
        source_path, binary_path, output_path = (Path(item['path']) for item in (source, binary, stdout))
        if (source_path.resolve().parent != FIXES.resolve()
                or source_path.name != LOCAL_PROFILE_CHECKS[row['name']]
                or source_path.is_symlink()
                or sha(source_path) != source['sha256']):
            raise RuntimeError('Local fixture source does not match the copied recipe')
        if (not binary_path.resolve().is_relative_to(OUT.resolve())
                or binary_path.is_symlink() or sha(binary_path) != binary['sha256']):
            raise RuntimeError('Local fixture executable is missing or changed')
        if (output_path.resolve().parent != OUT.resolve()
                or output_path.suffix not in {'.txt', '.log'} or output_path.is_symlink()
                or output_path.name != row['name'] + '.stdout.txt'
                or sha(output_path) != stdout['sha256']
                or output_path.stat().st_size != stdout['bytes'] or stdout['bytes'] <= 0):
            raise RuntimeError('Local fixture stdout is missing, changed, or cannot be packaged')
        command = row.get('command', [])
        if (not command or not all(isinstance(arg, str) for arg in command)
                or sha(Path(command[0])) != profile['runtime_loader_sha256']
                or str(binary_path) not in command):
            raise RuntimeError('Local fixture invocation is not bound to the measured loader/executable')
        if row['name'].startswith('allocator-') and '--require-stack-variation' not in command:
            raise RuntimeError('Allocator fixture did not enforce observed managed-stack variation')
    return profile, sha(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unaccepted-diagnostic', action='store_true')
    args = parser.parse_args()
    diagnostic = None
    if args.unaccepted_diagnostic:
        spec = importlib.util.spec_from_file_location('supplemental', FIXES / 'run-glibc-supplemental-diagnostic.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        diagnostic = module.validate(json.loads((OUT / 'supplemental-diagnostic.json').read_text()), OUT)
    manifest = json.loads((FIXES / 'glibc-backport-manifest.json').read_text())
    if (manifest['package_version'] != PACKAGE_VERSION
            or len(manifest['upstream_patches']) != 17
            or len(manifest['local_security_patches']) != 2
            or set(manifest['retained_unfixed_advisory_ids']) != RETAINED_ADVISORY_IDS):
        raise RuntimeError('Unexpected local glibc source/patch/advisory profile')
    application_path = OUT / 'source-patch-application.json'
    application = json.loads(application_path.read_text())
    if (application.get('schema') != 'lovelies-glibc-source-patch-application-v1'
            or application.get('passed') is not True
            or len(application['patches']) != 99
            or any(row['exit_code'] != 0 for row in application['patches'])
            or sum(row.get('scope') == 'Debian baseline' for row in application['patches']) != 80):
        raise RuntimeError('The complete 99-patch source application did not pass')
    applied = {row['filename']: row['sha256'] for row in application['patches']}
    for row in manifest['upstream_patches'] + manifest['local_security_patches']:
        if sha(FIXES / row['filename']) != row['sha256'] or applied.get(row['filename']) != row['sha256']:
            raise RuntimeError('Applied patch/source manifest mismatch: ' + row['filename'])
    arch = run(['dpkg', '--print-architecture']).strip()
    triplet = run(['dpkg-architecture', '--query', 'DEB_HOST_MULTIARCH']).strip()
    if arch != 'amd64':
        raise RuntimeError('Only the measured amd64 target is currently supported')
    loader = 'ld-linux-x86-64.so.2'
    installed_loader = INSTALL / 'usr/lib64' / loader
    real_loader = INSTALL / 'usr/lib' / triplet / loader
    if installed_loader.is_file() and not installed_loader.is_symlink():
        real_loader.parent.mkdir(parents=True, exist_ok=True)
        installed_loader.rename(real_loader)
        installed_loader.symlink_to('/usr/lib/' + triplet + '/' + loader)
    # Upstream installation leaves this Debian-owned cache to packaging.
    # Generate it with the newly compiled tool and its matching loader/libraries.
    gconv_dir = '/usr/lib/' + triplet + '/gconv'
    cache = INSTALL / gconv_dir.lstrip('/') / 'gconv-modules.cache'
    cache_command = [str(real_loader), '--library-path', str(ROOT / 'build'),
                     str(ROOT / 'build/iconv/iconvconfig'), '--nostdlib',
                     '--prefix=' + str(INSTALL), '--output=' + str(cache), gconv_dir]
    run(cache_command)
    if not cache.is_file() or not cache.stat().st_size:
        raise RuntimeError('Generated charset module cache is missing')
    (OUT / 'gconv-cache-generation.json').write_text(json.dumps({
        'command': cache_command, 'sha256': sha(cache), 'bytes': cache.stat().st_size,
        'generated_by_matching_compiled_iconvconfig': True,
    }, indent=2) + '\n')
    owned = run(['dpkg-query', '-L', 'libc6']).splitlines()
    files = []
    for name in owned:
        current = Path(name)
        if not (current.is_file() or current.is_symlink()):
            continue
        relative = name.lstrip('/')
        new = INSTALL / relative
        destination = PACKAGE / relative
        if name.startswith(('/usr/share/', '/etc/')):
            new = current
        if not (new.is_file() or new.is_symlink()):
            raise RuntimeError('Missing replacement for current libc6 path: ' + name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink():
            destination.unlink()
        shutil.copy2(new, destination, follow_symlinks=False)
        files.append({'path': name, 'symlink': destination.is_symlink(),
                      'target': os.readlink(destination) if destination.is_symlink() else None,
                      'sha256': None if destination.is_symlink() else sha(destination),
                      'bytes': None if destination.is_symlink() else destination.stat().st_size})
    if len(files) != 279:
        raise RuntimeError('Expected the measured 279 Debian-owned runtime files')
    abi = []
    for name in ['libc.so.6', 'libm.so.6', 'libresolv.so.2', 'libpthread.so.0',
                 'libdl.so.2', 'librt.so.1', 'libutil.so.1', 'libanl.so.1',
                 'libnss_compat.so.2', 'libnss_dns.so.2', 'libnss_files.so.2',
                 'libnss_hesiod.so.2', 'libthread_db.so.1', 'libmvec.so.1']:
        old = Path('/usr/lib') / triplet / name
        new = PACKAGE / 'usr/lib' / triplet / name
        old_api, new_api = public_symbols(old), public_symbols(new)
        missing = sorted(set(old_api) - set(new_api))
        if missing:
            raise RuntimeError('Public ABI symbols lost from ' + name + ': ' + repr(missing))
        (OUT / (name + '-original-public-api.txt')).write_text('\n'.join(old_api) + '\n')
        (OUT / (name + '-modified-public-api.txt')).write_text('\n'.join(new_api) + '\n')
        abi.append({'library': name, 'original_public_symbol_count': len(old_api),
                    'modified_public_symbol_count': len(new_api), 'missing_symbols': missing,
                    'new_sha256': sha(new), 'private_abi_scope': 'not compared by this public ABI check'})
    new_libc = PACKAGE / 'usr/lib' / triplet / 'libc.so.6'
    profile, profile_sha256 = local_runtime_profile(real_loader, new_libc)
    dynamic = run(['readelf', '-dW', str(new_libc)])
    program_headers = run(['readelf', '-lW', str(new_libc)])
    symbols = run(['nm', '-D', str(new_libc)])
    if 'GNU_RELRO' not in program_headers or 'BIND_NOW' not in dynamic or '__stack_chk_fail' not in symbols:
        raise RuntimeError('Expected libc hardening missing')
    (OUT / 'libc-elf-hardening.txt').write_text(program_headers + dynamic + symbols)
    results = []
    for subdir, names in {
        'stdlib': ['tst-strfmon-bug34510', 'tst-strfmon_l'],
        'misc': ['tst-tsearch'],
        'posix': ['tst-wordexp-append', 'tst-wordexp-tilde'],
        'libio': ['tst-fopen-ccs-empty'],
        'iconvdata': ['tst-jisx0213-progress'],
        'resolv': ['tst-ns_sprintrr', 'tst-resolv-res_init',
                   'tst-resolv-res_init-multi', 'tst-resolv-res_init-thread'],
        'nptl': ['tst-stack2', 'tst-stack3', 'tst-attr3', 'tst-minstack-cancel',
                 'tst-minstack-exit', 'tst-minstack-throw', 'tst-stackguard1', 'tst-tls3', 'tst-tls5'],
        'malloc': ['tst-mallocalign1', 'tst-malloc-thread-exit', 'tst-malloc-thread-fail',
                   'tst-malloc-fork-deadlock', 'tst-malloc-alternate-path', 'tst-malloc_info', 'tst-mallinfo2'],
    }.items():
        for name in names:
            result_path = ROOT / 'build' / subdir / (name + '.test-result')
            if not result_path.is_file():
                raise RuntimeError('Missing measured test result: ' + str(result_path))
            result = result_path.read_text()
            if not result.startswith('PASS:') and not args.unaccepted_diagnostic:
                raise RuntimeError('Vendor regression did not pass: ' + result.strip())
            output_path = ROOT / 'build' / subdir / (name + '.out')
            if name == 'tst-wordexp-tilde' and 'SKIP:' in output_path.read_text():
                raise RuntimeError('Required wordexp fixture case was skipped')
            results.append({'test': subdir + '/' + name, 'result': result.strip(),
                            'sha256': sha(result_path), 'output_sha256': sha(output_path),
                            'result_path': 'vendor-tests/' + subdir + '/' + name + '.test-result',
                            'output_path': 'vendor-tests/' + subdir + '/' + name + '.out'})
    if diagnostic is not None:
        canonical = {row['test']: row for row in diagnostic['canonical_vendor_results']}
        if any(row['sha256'] != canonical[row['test']]['sha256'] or row['output_sha256'] != canonical[row['test']]['output_sha256'] for row in results):
            raise RuntimeError('Original native verdict bytes changed after supplemental execution')
        results = diagnostic['canonical_vendor_results']
    doc = PACKAGE / 'usr/share/doc/libc6/lovelies-native-backports'
    source_doc = doc / 'source'
    source_doc.mkdir(parents=True, exist_ok=True)
    if diagnostic is not None:
        shutil.copytree(OUT / 'supplemental', doc / 'supplemental', dirs_exist_ok=True)
        shutil.copy2(OUT / 'supplemental-diagnostic.json', doc / 'supplemental-diagnostic.json')
    for row in results:
        if diagnostic is not None:
            continue  # The exact canonical files, sources and binaries are in supplemental/canonical.
        subdir, name = row['test'].split('/')
        for field, suffix in [('result_path', '.test-result'), ('output_path', '.out')]:
            destination = doc / row[field]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / 'build' / subdir / (name + suffix), destination)
    for name in ['glibc_2.41.orig.tar.xz', 'glibc_2.41-12+deb13u4.debian.tar.xz',
                 'glibc_2.41-12+deb13u4.dsc']:
        shutil.copy2(ROOT / name, source_doc / name)
    for p in FIXES.glob('glibc*'):
        if p.is_file():
            shutil.copy2(p, source_doc / p.name)
    for name in ['prepare-glibc-backports.py', 'build-glibc-backport.sh',
                 'package-glibc-backport.py', 'run-resolver-namespace-fixtures.py', 'run-glibc-local-profile.py',
                 'run-glibc-supplemental-diagnostic.py', 'glibc-supplemental-wrapper.py']:
        shutil.copy2(FIXES / name, source_doc / name)
    for name in ['COPYING', 'COPYING.LIB', 'LICENSES']:
        p = SOURCE / name
        if p.is_file():
            shutil.copy2(p, doc / name)
    shutil.copy2(FIXES / 'glibc-NOTICE.txt', doc / 'LOVELIES-MODIFICATION-NOTICE.txt')
    for p in OUT.iterdir():
        if p.is_file() and p.suffix in {'.txt', '.log', '.json'}:
            shutil.copy2(p, doc / p.name)
    receipt = {
        'schema': 'lovelies-glibc-backport-build-receipt-v1',
        'architecture': arch, 'source_version': '2.41-12+deb13u4',
        'package_version': PACKAGE_VERSION,
        'manifest_sha256': sha(FIXES / 'glibc-backport-manifest.json'),
        'scope': 'Exact upstream maintenance backports, local guarded TLS and thread-allocation path exclusions',
        'runtime_files': files, 'public_abi': abi, 'vendor_regression_results': results,
        'vendor_wordexp_fixture_context': json.loads((OUT / 'wordexp-fixture-context.json').read_text()),
        'source_patch_count': 99,
        'source_patch_application_sha256': sha(application_path),
        'local_runtime_profile_tests': profile,
        'local_runtime_profile_tests_sha256': profile_sha256,
        'code_and_data_from_current_package_only': True,
        'relro': True, 'bind_now': True, 'stack_canary': True,
        'remaining_upstream_unfixed_ids': manifest['retained_unfixed_advisory_ids'],
    }
    if diagnostic is not None:
        if diagnostic['runtime_libc_sha256'] != sha(new_libc) or diagnostic['runtime_loader_sha256'] != sha(real_loader):
            raise RuntimeError('Diagnostic binding differs from actual package runtime')
        receipt.update(classification='UNACCEPTED_DIAGNOSTIC', native_acceptance=False,
                       production_release_authorized=False, canonical_vendor_failures=diagnostic['canonical_vendor_failures'],
                       supplemental_diagnostic=diagnostic,
                       supplemental_diagnostic_sha256=sha(OUT / 'supplemental-diagnostic.json'))
    (doc / 'lovelies-glibc-backport-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (OUT / 'glibc-backport-build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    control = PACKAGE / 'DEBIAN'
    control.mkdir(parents=True, exist_ok=True)
    (control / 'control').write_text(
        'Package: libc6\nVersion: ' + PACKAGE_VERSION + '\nArchitecture: ' + arch + '\n'
        'Multi-Arch: same\nSource: glibc (2.41-12+deb13u4)\nMaintainer: Lovelies local readiness build\n'
        'Section: libs\nPriority: optional\nDepends: libgcc-s1\n'
        'Description: Debian 2.41 runtime with upstream backports and local thread hardening\n'
        ' Modified local build. This is not an official Debian release or independent approval.\n'
    )
    run(['dpkg-deb', '--root-owner-group', '--build', str(PACKAGE), str(OUT / 'libc6.deb')], timeout=300)


if __name__ == '__main__':
    main()
