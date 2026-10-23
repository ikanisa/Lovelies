#!/usr/bin/env python3
"""Preserve native failures; run unchanged malloc fixtures in a separate bounded lane."""
import hashlib
import json
import re
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path('/glibc')
BUILD = ROOT / 'build'
OUT = ROOT / 'out'
FIXES = Path('/fixes')
CORE = {
    'stdlib': ['tst-strfmon-bug34510', 'tst-strfmon_l'], 'misc': ['tst-tsearch'],
    'posix': ['tst-wordexp-append', 'tst-wordexp-tilde'], 'libio': ['tst-fopen-ccs-empty'],
    'iconvdata': ['tst-jisx0213-progress'],
    'resolv': ['tst-ns_sprintrr', 'tst-resolv-res_init', 'tst-resolv-res_init-multi', 'tst-resolv-res_init-thread'],
    'nptl': ['tst-stack2', 'tst-stack3', 'tst-attr3', 'tst-minstack-cancel', 'tst-minstack-exit', 'tst-minstack-throw', 'tst-stackguard1', 'tst-tls3', 'tst-tls5'],
    'malloc': ['tst-mallocalign1', 'tst-malloc-thread-exit', 'tst-malloc-thread-fail', 'tst-malloc-fork-deadlock', 'tst-malloc-alternate-path', 'tst-malloc_info', 'tst-mallinfo2'],
}
MALLOC = [n + suffix for n in CORE['malloc'] for suffix in ['', '-malloc-check', '-malloc-hugetlb1', '-malloc-hugetlb2']]
MALLOC += [n + '-mcheck' for n in ['tst-mallocalign1', 'tst-malloc-alternate-path', 'tst-mallinfo2']]
MALLOC += ['tst-dynarray-at-fail', 'tst-dynarray-fail', 'tst-dynarray', 'tst-scratch_buffer']
FAILURES = {'malloc/' + n + s for n in ['tst-malloc-thread-fail', 'tst-malloc-fork-deadlock'] for s in ['', '-malloc-check', '-malloc-hugetlb1', '-malloc-hugetlb2']}
QEMU_HASH = '9af86352fd463ad9ec25bdd6a4b891ac6b6a7f3d46a7db3da6f23e2c09094a59'
PRLIMIT_HASH = '06275e616ca2b721482aeb564260489be3fdc6d5f86836b4a78e96485845f060'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def source_name(name):
    for suffix in ['-malloc-check', '-malloc-hugetlb1', '-malloc-hugetlb2', '-mcheck']:
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name

def row(subdir, name, destination):
    result, output = [BUILD / subdir / (name + s) for s in ['.test-result', '.out']]
    source = ROOT / 'source/glibc-2.41' / subdir / (source_name(name) + '.c')
    if not source.is_file():
        source = source.with_suffix('.cc')
    binary = BUILD / subdir / name
    # Hugetlb/check variants use the identical parent executable, selected by vendor environment.
    if not binary.is_file():
        binary = BUILD / subdir / source_name(name)
    record = {'test': subdir + '/' + name, 'result': result.read_text().strip(),
              'sha256': sha(result), 'output_sha256': sha(output),
              'source_sha256': sha(source), 'binary_sha256': sha(binary), 'execution_binary_path': str(binary)}
    for field, path, filename in [('result_path', result, name + '.test-result'),
                                  ('output_path', output, name + '.out'),
                                  ('source_path', source, source.name),
                                  ('binary_path', binary, binary.name + '.binary')]:
        target = destination / subdir / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and sha(target) != sha(path):
            raise RuntimeError('Conflicting fixture bytes')
        if not target.exists():
            shutil.copy2(path, target)
        record[field] = str(target.relative_to(OUT))
    return record

def bound(root, relative):
    rel = Path(relative)
    root = root.resolve()
    if rel.is_absolute() or '..' in rel.parts or not rel.parts:
        raise RuntimeError('Unsafe diagnostic evidence path')
    path = root / rel
    if not path.resolve().is_relative_to(root) or not path.is_file() or any(parent.is_symlink() for parent in [path, *path.parents] if parent != root and parent.is_relative_to(root)):
        raise RuntimeError('Ordinary confined diagnostic evidence required')
    return path

def validate(record, root):
    if (record.get('schema') != 'lovelies-glibc-supplemental-diagnostic-v1'
            or record.get('classification') != 'UNACCEPTED_DIAGNOSTIC'
            or record.get('native_acceptance') is not False
            or record.get('production_release_authorized') is not False
            or record.get('passed') is not True
            or record.get('runtime_mode') != 'qemu-user-host-prlimit-data'
            or record.get('host_rlimit_data_bytes') != 1073741824
            or record.get('guest_rlimit_as_ignored') is not True):
        raise RuntimeError('Invalid unaccepted supplemental classification/context')
    for key, digest in [('qemu', QEMU_HASH), ('prlimit', PRLIMIT_HASH)]:
        item = record[key]
        if item['sha256'] != digest or sha(bound(root, item['path'])) != digest:
            raise RuntimeError('Wrong supplemental tool bytes')
    core = record['canonical_vendor_results']
    expected = {d + '/' + n for d, names in CORE.items() for n in names}
    if len(core) != 27 or {r['test'] for r in core} != expected or sum(r['result'].startswith('PASS:') for r in core) != 25:
        raise RuntimeError('Canonical native failures must be retained')
    if {r['test'] for r in core if not r['result'].startswith('PASS:')} != {'malloc/tst-malloc-thread-fail', 'malloc/tst-malloc-fork-deadlock'} or any(not r['result'].startswith(('PASS:', 'FAIL:')) for r in core):
        raise RuntimeError('Canonical native verdicts were relabelled')
    failed = record['canonical_vendor_failures']
    if len(failed) != 8 or {r['test'] for r in failed} != FAILURES or any(not r['result'].startswith('FAIL:') for r in failed):
        raise RuntimeError('All eight original native failures must be retained')
    checks = record['checks']
    if len(checks) != 35 or {r['test'] for r in checks} != {'malloc/' + n for n in MALLOC} or any(not r['result'].startswith('PASS:') for r in checks):
        raise RuntimeError('All unchanged supplemental fixtures must actually pass')
    for r in core + failed + checks:
        if bound(root, r['result_path']).read_text().strip() != r['result']:
            raise RuntimeError('Recorded verdict differs from original result bytes')
        for path_key, hash_key in [('result_path', 'sha256'), ('output_path', 'output_sha256'), ('source_path', 'source_sha256'), ('binary_path', 'binary_sha256')]:
            path = bound(root, r[path_key])
            if sha(path) != r[hash_key]:
                raise RuntimeError('Fixture binding mismatch: ' + r['test'])
    for r in checks:
        p = bound(root, r['host_limits_path'])
        if sha(p) != r['host_limits_sha256']:
            raise RuntimeError('Host limit readback mismatch')
        limits = json.loads(p.read_text())
        if (limits['host_rlimit_data_bytes'] != 1073741824 or limits['runtime_mode'] != record['runtime_mode']
                or not re.search(r'^Max data size\s+1073741824\s+1073741824\s+bytes$', limits['kernel_limits'], re.M)):
            raise RuntimeError('Actual kernel DATA limit missing')
        if (limits['argv'][:4] != [record['qemu']['execution_path'], '-tb-size', '32', record['runtime_loader_execution_path']]
                or limits['argv'][-1] != r['execution_binary_path']):
            raise RuntimeError('Host limit readback belongs to another invocation')
    by_check = {r['test']: r for r in checks}
    for r in failed:
        if any(r[k] != by_check[r['test']][k] for k in ['source_sha256', 'binary_sha256']):
            raise RuntimeError('Canonical and supplemental assertions differ')
    sources = record['source_files']
    if len({item['path'] for item in sources}) != len(sources) or not {'supplemental/source/glibc-supplemental-wrapper.py', 'supplemental/source/run-glibc-supplemental-diagnostic.py', 'supplemental/source/glibc-backport-manifest.json'}.issubset({item['path'] for item in sources}):
        raise RuntimeError('Diagnostic source closure is incomplete')
    for item in record['source_files']:
        path = bound(root, item['path'])
        if sha(path) != item['sha256']:
            raise RuntimeError('Supplemental source binding mismatch')
    return record

def main():
    execution = json.loads((OUT / 'execution-inputs.json').read_text())
    jobs = execution['build_jobs']
    if jobs not in [1, 2, 3, 4]:
        raise RuntimeError('Invalid bounded job count')
    lane = OUT / 'supplemental'
    lane.mkdir(exist_ok=False)
    original = [row(d, n, lane / 'canonical') for d, names in CORE.items() for n in names]
    all_malloc = [row('malloc', n, lane / 'canonical') for n in MALLOC]
    failed = [r for r in all_malloc if r['test'] in FAILURES]
    inputs = [(p, sha(p)) for p in FIXES.iterdir() if p.is_file()]
    library_hash, loader_hash = sha(BUILD / 'libc.so'), sha(BUILD / 'elf/ld.so')
    for key, src, digest in [('qemu', ROOT / 'qemu/usr/bin/qemu-x86_64', QEMU_HASH), ('prlimit', Path('/usr/bin/prlimit'), PRLIMIT_HASH)]:
        if sha(src) != digest:
            raise RuntimeError('Pinned diagnostic tool mismatch')
        (lane / 'tools').mkdir(exist_ok=True)
        shutil.copy2(src, lane / 'tools' / src.name)
    start = time.monotonic()
    command = ['make', '--jobs=' + str(jobs), 'check', 'subdirs=malloc', 'tests=' + ' '.join(CORE['malloc']),
               'tests-special=', 'tests-container=', 'test-wrapper=python3 /fixes/glibc-supplemental-wrapper.py']
    record = {'schema': 'lovelies-glibc-supplemental-diagnostic-v1', 'classification': 'UNACCEPTED_DIAGNOSTIC',
              'native_acceptance': False, 'production_release_authorized': False, 'passed': False,
              'runtime_mode': 'qemu-user-host-prlimit-data', 'host_rlimit_data_bytes': 1073741824,
              'guest_rlimit_as_ignored': True, 'qemu_tb_cache_megabytes': 32,
              'qemu': {'path': 'supplemental/tools/qemu-x86_64', 'sha256': QEMU_HASH, 'execution_path': '/glibc/qemu/usr/bin/qemu-x86_64'},
              'prlimit': {'path': 'supplemental/tools/prlimit', 'sha256': PRLIMIT_HASH},
              'runtime_libc_sha256': library_hash, 'runtime_loader_sha256': loader_hash,
              'runtime_loader_execution_path': '/glibc/build/elf/ld-linux-x86-64.so.2',
              'canonical_vendor_results': original, 'canonical_vendor_failures': failed,
              'command': command, 'vendor_source_or_assertions_modified': False,
              'original_baseline_comparison': json.loads((OUT / 'host-data-vendor-comparison/report.json').read_text()),
              'limitations': ['Guest address-space limits are ignored by this QEMU version; host DATA is a separate diagnostic control.',
                             'Eight mandatory native failures remain unaccepted; supplemental pass cannot establish native/CVE equivalence.']}
    try:
        for n in MALLOC:
            for suffix in ['.out', '.test-result']:
                (BUILD / 'malloc' / (n + suffix)).unlink()
        with (lane / 'make.log').open('wb') as log:
            result = subprocess.run(command, cwd=BUILD, stdout=log, stderr=subprocess.STDOUT, timeout=2400)
        record['exit_code'] = result.returncode
        checks = [row('malloc', n, lane / 'vendor-tests') for n in MALLOC]
        limits = [(p, json.loads(p.read_text())) for p in (lane / 'host-limits').glob('*.json')]
        for r in checks:
            binary_name = source_name(r['test'].split('/')[1])
            matching = [(p, value) for p, value in limits if value['argv'][-1] == r['execution_binary_path']]
            if not matching:
                raise RuntimeError('Missing actual host DATA readback: ' + r['test'])
            # Shared variants use the same binary; match vendor tunable/check environment when names differ.
            suffix = r['test'].split('/')[1][len(binary_name):]
            def matches(v):
                env = v['vendor_environment']
                if suffix == '-malloc-check': return env.get('MALLOC_CHECK_') == '3'
                if suffix == '-malloc-hugetlb1': return 'glibc.malloc.hugetlb=1' in env.get('GLIBC_TUNABLES', '')
                if suffix == '-malloc-hugetlb2': return 'glibc.malloc.hugetlb=2' in env.get('GLIBC_TUNABLES', '')
                return not any(k in env for k in ['MALLOC_CHECK_', 'GLIBC_TUNABLES'])
            matching = [(p, v) for p, v in matching if matches(v)]
            if len(matching) != 1:
                raise RuntimeError('Missing/ambiguous exact fixture environment: ' + r['test'])
            p, value = matching[0]
            r.update(runtime_mode=record['runtime_mode'], host_rlimit_data_bytes=1073741824,
                     host_limits_path=str(p.relative_to(OUT)), host_limits_sha256=sha(p), vendor_environment=value['vendor_environment'])
        record['checks'] = checks
        (lane / 'source').mkdir()
        record['source_files'] = []
        for p, digest in inputs:
            if sha(p) != digest:
                raise RuntimeError('Source changed during diagnostic execution')
            shutil.copy2(p, lane / 'source' / p.name)
            record['source_files'].append({'path': 'supplemental/source/' + p.name, 'sha256': digest})
        if sha(BUILD / 'libc.so') != library_hash or sha(BUILD / 'elf/ld.so') != loader_hash:
            raise RuntimeError('Native artifacts changed during supplemental lane')
        record['passed'] = result.returncode == 0
        validate(record, OUT)
    finally:
        # Restore exact original verdict bytes. Diagnostic results live only in their distinct namespace.
        for n in MALLOC:
            for suffix in ['.out', '.test-result']:
                shutil.copy2(lane / 'canonical/malloc' / (n + suffix), BUILD / 'malloc' / (n + suffix))
        record['elapsed_seconds'] = round(time.monotonic() - start, 3)
        (OUT / 'supplemental-diagnostic.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'classification': record['classification'], 'passed': record['passed'], 'elapsed_seconds': record['elapsed_seconds']}))

if __name__ == '__main__':
    main()
