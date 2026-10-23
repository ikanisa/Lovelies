#!/usr/bin/env python3
"""Execute normal allocation/pthread checks with the newly built libc/loader."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path('/glibc')
FIXES = Path('/fixes')
BUILD = ROOT / 'build'
OUT = ROOT / 'out'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    libraries = ':'.join(str(BUILD / p) for p in ['', 'math', 'nptl', 'dlfcn',
                                                'resolv', 'support', 'elf'])
    checks = []
    for kind, source_name in [('allocator', 'glibc-allocation-entropy-check.c'),
                              ('tls', 'glibc-tls-layout-check.c')]:
        source = FIXES / source_name
        binary = OUT / (kind + '-profile-check')
        compile_command = ['gcc', '-O2', '-g', '-Wall', '-Wextra', '-Werror',
                           '-pthread', str(source), '-o', str(binary)]
        compiled = subprocess.run(compile_command, text=True, capture_output=True)
        (OUT / (kind + '-fixture-compile.log')).write_text(compiled.stdout + compiled.stderr)
        if compiled.returncode:
            raise RuntimeError('Local fixture compile failed: ' + kind + '\n' + compiled.stderr)
        for mode in ['normal', 'overrides']:
            environment = dict(os.environ)
            environment['GLIBC_TUNABLES'] = (
                'glibc.malloc.arena_max=1:glibc.malloc.tcache_count=0:'
                'glibc.pthread.stack_cache_size=0' if mode == 'normal' else
                'glibc.malloc.arena_max=64:glibc.malloc.tcache_count=32767:'
                'glibc.pthread.stack_cache_size=67108864')
            command = [str(BUILD / 'elf/ld.so'), '--library-path', libraries, str(binary)]
            if kind == 'allocator':
                command.append('--require-stack-variation')
            result = subprocess.run(command, env=environment, text=True,
                                    capture_output=True, timeout=180)
            name = kind + '-' + mode
            stdout = OUT / (name + '.stdout.txt')
            stdout.write_text(result.stdout + result.stderr)
            checks.append({'name': name, 'passed': result.returncode == 0,
                           'returncode': result.returncode,
                           'fixture_source': {'path': str(source), 'sha256': sha(source)},
                           'fixture_binary': {'path': str(binary), 'sha256': sha(binary)},
                           'command': command,
                           'environment': {'GLIBC_TUNABLES': environment['GLIBC_TUNABLES']},
                           'compile_command': compile_command,
                           'stdout': {'path': str(stdout), 'sha256': sha(stdout),
                                      'bytes': stdout.stat().st_size}})
            print(name, result.returncode, flush=True)
    report = {'schema': 'lovelies-glibc-local-runtime-profile-tests-v1',
              'passed': len(checks) == 4 and all(c['passed'] for c in checks),
              'runtime_libc_sha256': sha(BUILD / 'libc.so'),
              'runtime_loader_sha256': sha(BUILD / 'elf/ld.so'), 'checks': checks}
    (OUT / 'local-runtime-profile-tests.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['passed']:
        raise RuntimeError('Local runtime profile fixture failed; preserve its output')


if __name__ == '__main__':
    main()
