#!/usr/bin/env python3
"""Prepare the checksum-bound Debian source in a Linux build filesystem."""
import hashlib
import json
import subprocess
import tarfile
from pathlib import Path


ROOT = Path('/glibc')
FIXES = Path('/fixes')
EXPECTED = {
    'glibc_2.41.orig.tar.xz': 'f24aa441021121a79266f0d75242706cab8843a47901fefe74527491807f1998',
    'glibc_2.41-12+deb13u4.debian.tar.xz': 'dda4153511bfd543502d18e5bc9323110996fe9c531f14ae3fad6eb17f027c7d',
    'glibc_2.41-12+deb13u4.dsc': '0915324aa646bb99abfaa9aa6ecb734b30babd28454a3e51f3152912370fbd3e',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    source = ROOT / 'source' / 'glibc-2.41'
    if source.exists():
        raise RuntimeError('Refuse to overwrite an existing source or build attempt')
    for filename, expected in EXPECTED.items():
        if sha(ROOT / filename) != expected:
            raise RuntimeError('Source archive checksum mismatch: ' + filename)
    with tarfile.open(ROOT / 'glibc_2.41.orig.tar.xz') as archive:
        archive.extractall(ROOT / 'source', filter='data')
    with tarfile.open(ROOT / 'glibc_2.41-12+deb13u4.debian.tar.xz') as archive:
        archive.extractall(source, filter='data')
    patches = []
    for line in (source / 'debian/patches/series').read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            patches.append({'scope': 'Debian baseline', 'filename': line,
                            'path': source / 'debian/patches' / line})
    for row in json.loads((FIXES / 'glibc-patch-downloads.json').read_text()):
        patch = FIXES / row['filename']
        if row['status'] != 'downloaded' or sha(patch) != row['sha256']:
            raise RuntimeError('Upstream patch missing or changed: ' + row['filename'])
        patches.append(row | {'scope': 'Upstream 2.41 maintenance branch', 'path': patch})
    for row in json.loads((FIXES / 'glibc-backport-manifest.json').read_text())['local_security_patches']:
        patch = FIXES / row['filename']
        if sha(patch) != row['sha256']:
            raise RuntimeError('Local runtime patch missing or changed: ' + row['filename'])
        patches.append(row | {'path': patch})
    applied = []
    try:
        for row in patches:
            patch = row['path']
            result = subprocess.run(
                ['patch', '--batch', '--fuzz=0', '-p1', '-i', str(patch)],
                cwd=source, text=True, capture_output=True, timeout=30,
            )
            applied.append({k: v for k, v in row.items() if k != 'path'} |
                           {'sha256': sha(patch), 'exit_code': result.returncode,
                            'stdout': result.stdout, 'stderr': result.stderr})
            print(row['filename'], result.returncode, flush=True)
            if result.returncode:
                print(result.stdout, result.stderr, flush=True)
                raise RuntimeError('Patch rejected: ' + row['filename'])
    finally:
        (ROOT / 'out/source-patch-application.json').write_text(json.dumps({
            'schema': 'lovelies-glibc-source-patch-application-v1',
            'source_archives': EXPECTED,
            'source_version': '2.41-12+deb13u4',
            'patches': applied,
            'passed': len(applied) == len(patches) and all(p['exit_code'] == 0 for p in applied),
            'build_executed': False,
        }, indent=2) + '\n')


if __name__ == '__main__':
    main()
