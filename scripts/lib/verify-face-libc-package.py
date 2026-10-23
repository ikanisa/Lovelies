#!/usr/bin/env python3
"""Bind the canonical fixture receipt to the actual exported runtime package."""
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

OUT = Path('/glibc/out')
LIBRARIES = {'libc.so.6', 'libm.so.6', 'libresolv.so.2', 'libpthread.so.0',
             'libdl.so.2', 'librt.so.1', 'libutil.so.1', 'libanl.so.1',
             'libnss_compat.so.2', 'libnss_dns.so.2', 'libnss_files.so.2',
             'libnss_hesiod.so.2', 'libthread_db.so.1', 'libmvec.so.1'}


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def main():
    package = OUT / 'libc6.deb'
    exported = json.loads((OUT / 'glibc-backport-build-receipt.json').read_text())
    assert exported['schema'] == 'lovelies-glibc-backport-build-receipt-v1'
    assert exported['source_version'] == '2.41-12+deb13u4'
    assert exported['package_version'] == '2.41-12+deb13u4+lovelies2'
    assert exported['manifest_sha256'] == sha(Path('/fixes/glibc-backport-manifest.json'))
    assert exported.get('native_acceptance') is not False
    assert exported.get('classification') != 'UNACCEPTED_DIAGNOSTIC'
    assert len(exported['runtime_files']) == 279
    assert len(exported['public_abi']) == 14
    assert {r['library'] for r in exported['public_abi']} == LIBRARIES
    assert len(exported['vendor_regression_results']) == 27
    with tempfile.TemporaryDirectory(prefix='lovelies-libc-verify-') as folder:
        root = Path(folder)
        subprocess.run(['dpkg-deb', '--extract', str(package), str(root)], check=True)
        doc = root / 'usr/share/doc/libc6/lovelies-native-backports'
        embedded = json.loads((doc / 'lovelies-glibc-backport-receipt.json').read_text())
        assert embedded == exported, 'Package embeds another acceptance receipt'
        for row in exported['runtime_files']:
            relative = row['path'].lstrip('/')
            assert '..' not in Path(relative).parts
            p = root / relative
            if row['symlink']:
                assert p.is_symlink() and os.readlink(p) == row['target']
            else:
                assert p.is_file() and not p.is_symlink()
                assert p.stat().st_size == row['bytes'] and sha(p) == row['sha256']
        for row in exported['public_abi']:
            assert not row['missing_symbols']
            assert sha(root / 'usr/lib/x86_64-linux-gnu' / row['library']) == row['new_sha256']
        for row in exported['vendor_regression_results']:
            assert row['result'].startswith('PASS:')
            result = doc / row['result_path']
            output = doc / row['output_path']
            assert sha(result) == row['sha256'] and sha(output) == row['output_sha256']
            assert result.read_text().strip() == row['result']
        assert sha(doc / 'source-patch-application.json') == exported['source_patch_application_sha256']
        assert sha(doc / 'local-runtime-profile-tests.json') == exported['local_runtime_profile_tests_sha256']
    result = {'schema': 'lovelies-face-libc-package-validation-v1', 'status': 'passed',
              'package': {'bytes': package.stat().st_size, 'sha256': sha(package)},
              'receipt_sha256': sha(OUT / 'glibc-backport-build-receipt.json'),
              'manifest_sha256': exported['manifest_sha256'],
              'embedded_receipt_matches_export': True, 'runtime_files_verified': 279,
              'public_abi_libraries_verified': 14, 'vendor_results_verified': 27}
    (OUT / 'package-validation.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
