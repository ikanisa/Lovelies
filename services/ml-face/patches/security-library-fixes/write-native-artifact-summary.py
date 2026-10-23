#!/usr/bin/env python3
"""Bind completed native artifacts and reused component results for integration."""
import argparse
import importlib.util
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
FIXES = Path(__file__).resolve().parent
OUTPUT = REPO / 'outputs/local-programme-20260930/ml-retained-library-patches'


def ref(path):
    return {'path': str(path.relative_to(REPO)), 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--glibc-artifacts', type=Path, default=OUTPUT / 'glibc-artifacts')
    parser.add_argument('--output', type=Path, default=OUTPUT / 'native-security-component-summary.json')
    parser.add_argument('--unaccepted-diagnostic', action='store_true')
    args = parser.parse_args()
    glibc_receipt = args.glibc_artifacts / 'glibc-backport-build-receipt.json' 
    zlib_receipt = OUTPUT / 'zlib-artifacts/lovelies-zlib-backport-receipt.json'
    libc = json.loads(glibc_receipt.read_text())
    zlib = json.loads(zlib_receipt.read_text())
    if not args.unaccepted_diagnostic and (libc.get('classification') == 'UNACCEPTED_DIAGNOSTIC' or len(libc['vendor_regression_results']) != 27 or any(
            not result['result'].startswith('PASS:')
            for result in libc['vendor_regression_results'])):
        raise RuntimeError('Required actual glibc vendor results are incomplete')
    if args.unaccepted_diagnostic:
        if libc.get('classification') != 'UNACCEPTED_DIAGNOSTIC' or libc.get('native_acceptance') is not False or libc.get('production_release_authorized') is not False:
            raise RuntimeError('Explicit unaccepted diagnostic receipt required')
        core = libc['vendor_regression_results']
        if len(core) != 27 or sum(row['result'].startswith('PASS:') for row in core) != 25:
            raise RuntimeError('Canonical native failure evidence is incomplete')
        diagnostic = libc['supplemental_diagnostic']
        spec = importlib.util.spec_from_file_location('diagnostic', FIXES / 'run-glibc-supplemental-diagnostic.py')
        validator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validator)
        validator.validate(diagnostic, args.glibc_artifacts)
        if libc['supplemental_diagnostic_sha256'] != ref(args.glibc_artifacts / 'supplemental-diagnostic.json')['sha256']:
            raise RuntimeError('Diagnostic receipt bytes changed')
        if not diagnostic['passed'] or len(diagnostic['checks']) != 35 or any(not row['result'].startswith('PASS:') for row in diagnostic['checks']):
            raise RuntimeError('Supplemental diagnostic assertions are incomplete')
    if len(libc['public_abi']) != 14 or any(
            result['missing_symbols'] for result in libc['public_abi']):
        raise RuntimeError('Required glibc public ABI evidence is incomplete')
    if not (zlib['upstream_tests_passed'] and
            zlib['negative_length_and_normal_api_check_passed'] and
            zlib['unchanged_exported_zlib_api']):
        raise RuntimeError('Required zlib component evidence is incomplete')
    for component, receipt in [('glibc', libc), ('zlib', zlib)]:
        if receipt['manifest_sha256'] != ref(FIXES / (component + '-backport-manifest.json'))['sha256']:
            raise RuntimeError('Component manifest changed after measured build')
    profile = libc['local_runtime_profile_tests']
    assert profile['passed'] and len(profile['checks']) == 4
    assert all(check['passed'] and check['returncode'] == 0 for check in profile['checks'])
    assert libc['package_version'] == '2.41-12+deb13u4+lovelies2'
    sources = [ref(path) for path in sorted(FIXES.iterdir()) if path.is_file()]
    archive_root = REPO / 'outputs/ml-license-distribution-kit-20260930/debian-sources'
    for directory in ['glibc_2.41-12+deb13u4', 'zlib_1_1.3.dfsg+really1.3.1-1']:
        sources.extend(ref(path) for path in sorted((archive_root / directory).iterdir())
                       if path.is_file() and (path.name.endswith('.dsc') or '.tar.' in path.name))
    record = {
        'schema': 'lovelies-native-security-artifact-summary-v1',
        'status': 'UNACCEPTED_DIAGNOSTIC' if args.unaccepted_diagnostic else 'PASS_NATIVE_PATCH_ARTIFACTS',
        'artifacts': {
            'libc6': ref(args.glibc_artifacts / 'libc6.deb'),
            'zlib1g': ref(OUTPUT / 'zlib-artifacts/zlib1g.deb'),
        },
        'source_files': sources,
        'component_receipts': {'libc6': ref(glibc_receipt), 'zlib1g': ref(zlib_receipt)},
        'vendor_unfixed_advisory_ids': libc['remaining_upstream_unfixed_ids'],
        'locally_profiled_advisory_ids': ['CVE-2019-1010022', 'CVE-2019-1010024', 'CVE-2019-1010025'],
        'local_runtime_profile_tests': profile,
        'remaining_open_advisory_ids': ['CVE-2010-4756', 'CVE-2018-20796', 'CVE-2019-1010023', 'CVE-2019-9192'],
        'applicability_evidence': [ref(OUTPUT / name) for name in [
            'opencv-retained-library-source-scope.json',
            'retained-cpp-header-template-source-scope.json',
            'gcc14-binary-heap-erase_fn_imps.hpp',
            'protobuf-artifacts/protobuf-runtime-applicability-receipt.json',
            'protobuf-artifacts/result.log',
            'protobuf-artifacts/protobuf-oversize-serialization-check.cpp',
            'protobuf-artifacts/primary-issue760.json',
        ]],
        'limitations': [
            'Seven vendor affected-version IDs remain preserved; three locally measured thread-storage mechanisms are profiled separately; prior service exclusions require exact final-image binding',
            'Protobuf checked-entrypoint scope is conditional on the final exact library hash; cache-only methods are excluded',
            'GCC header-template source review covers the recorded exact retained C++ sources; other compiled consumer bindings are owned by final integration',
            'Public glibc symbol preservation does not assert full private ABI compatibility',
            'No whole ML image, full scanner, independent review or production release is certified by these component results',
        ],
    }
    if args.unaccepted_diagnostic:
        record.update(classification='UNACCEPTED_DIAGNOSTIC', native_acceptance=False,
                      production_release_authorized=False, supplemental_diagnostic=libc['supplemental_diagnostic'],
                      canonical_vendor_results=libc['vendor_regression_results'],
                      canonical_vendor_failures=libc['canonical_vendor_failures'])
        record['remaining_open_advisory_ids'] = libc['remaining_upstream_unfixed_ids']
        record['limitations'].insert(0, 'Eight canonical native failures remain unaccepted; supplemental QEMU results are mechanical local diagnostics only.')
    destination = args.output.resolve()
    assert destination.is_relative_to(REPO / 'outputs') and not destination.exists()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(ref(destination), indent=2))


if __name__ == '__main__':
    main()
