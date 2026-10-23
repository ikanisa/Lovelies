#!/usr/bin/env python3
"""Opt-in, hash-pinned QEMU wrapper; never substitutes a canonical native verdict."""
import hashlib
import json
import os
from pathlib import Path
import resource
import sys
import subprocess

QEMU = Path('/glibc/qemu/usr/bin/qemu-x86_64')
PRLIMIT = Path('/usr/bin/prlimit')
PINS = {QEMU: '9af86352fd463ad9ec25bdd6a4b891ac6b6a7f3d46a7db3da6f23e2c09094a59',
        PRLIMIT: '06275e616ca2b721482aeb564260489be3fdc6d5f86836b4a78e96485845f060'}
DATA = 1073741824

def main():
    for path, digest in PINS.items():
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Supplemental tool hash mismatch: ' + str(path))
    args = sys.argv[1:]
    environment = dict(os.environ)
    if args and args[0] == 'env':
        args = args[1:]
        while args and '=' in args[0] and not args[0].startswith('/'):
            key, value = args.pop(0).split('=', 1)
            if key not in {'GCONV_PATH', 'LOCPATH', 'LC_ALL', 'MALLOC_CHECK_', 'GLIBC_TUNABLES', 'LD_PRELOAD', 'MALLOC_TRACE'}:
                raise RuntimeError('Unexpected vendor environment key: ' + key)
            environment[key] = value
    if not args or Path(args[0]).resolve() != Path('/glibc/build/elf/ld.so').resolve():
        raise RuntimeError('Supplemental lane only runs the current build loader')
    if not any(arg.startswith('/glibc/build/malloc/tst-') for arg in args):
        raise RuntimeError('Supplemental lane requires the unchanged malloc fixture')
    # Apply the documented host limit to this already running interpreter.
    # No second interpreter may load a vendor LD_PRELOAD with a different libc.
    subprocess.run([str(PRLIMIT), '--pid=' + str(os.getpid()), '--data=' + str(DATA) + ':' + str(DATA)], check=True)
    limits = Path('/proc/self/limits').read_text()
    if resource.getrlimit(resource.RLIMIT_DATA) != (DATA, DATA):
        raise RuntimeError('Kernel host DATA limit was not applied')
    out = Path('/glibc/out/supplemental/host-limits')
    out.mkdir(parents=True, exist_ok=True)
    record = {'schema': 'lovelies-supplemental-host-limits-v1', 'pid': os.getpid(),
              'host_rlimit_data_bytes': DATA, 'kernel_limits': limits,
              'argv': [str(QEMU), '-tb-size', '32', *args],
              'vendor_environment': {k: environment[k] for k in ['GCONV_PATH', 'LOCPATH', 'LC_ALL', 'TIMEOUTFACTOR', 'GLIBC_TUNABLES', 'MALLOC_CHECK_', 'LD_PRELOAD', 'MALLOC_TRACE'] if k in environment},
              'runtime_mode': 'qemu-user-host-prlimit-data'}
    (out / (str(os.getpid()) + '.json')).write_text(json.dumps(record, indent=2) + '\n')
    os.execve(str(QEMU), [str(QEMU), '-tb-size', '32', *args], environment)

if __name__ == '__main__':
    main()
