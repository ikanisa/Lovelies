#!/usr/bin/env python3
"""Compile and run actual store engine, repository and PlayPurchases wrapper against controlled host boundaries."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def run_step(command, env, timeout):
    """Bound a whole compiler process group and preserve every failed attempt."""
    try:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=(os.name == 'posix'))
    except OSError as error:
        return 127, str(error).encode(), False
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        stdout, stderr = process.communicate()
    return (124 if timed_out else process.returncode), stdout + stderr, timed_out

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kotlinc', default=os.environ.get('KOTLINC') or shutil.which('kotlinc'))
    parser.add_argument('--java', default=os.environ.get('JAVA') or shutil.which('java'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--compile-timeout-seconds', type=int, default=300)
    args = parser.parse_args()
    if not 1 <= args.compile_timeout_seconds <= 1800:
        parser.error('Compile timeout must be between 1 and 1800 seconds.')
    if not args.kotlinc or not args.java:
        parser.error('Supply existing Kotlin/JVM compiler and Java executable paths; this runner never downloads tools.')
    output = args.output.resolve()
    if output.exists():
        parser.error('Select a new evidence directory; earlier attempts are preserved.')
    output.mkdir(parents=True)
    compiler, java = Path(args.kotlinc).resolve(), Path(args.java).resolve()
    coroutines = compiler.parent.parent / 'lib/kotlinx-coroutines-core-jvm.jar'
    sources = [ROOT / 'android/app/src/main/java/com/lovelies/frontend/preview' / name for name in ('NativeProtocol.kt', 'PushOperationRecovery.kt', 'PrivacyExportDelivery.kt', 'ChunkedPrivacyExport.kt', 'SessionAuthority.kt', 'AccountCollectionPage.kt', 'CloudflareRepository.kt', 'RepositoryBoundary.kt', 'DeviceIdentity.kt', 'EnrollmentJournal.kt', 'GuestDeletion.kt', 'AccountRecovery.kt', 'FaceLifecycle.kt', 'CameraRecovery.kt', 'CaptureOwnership.kt', 'RefreshDelivery.kt', 'PhotoUploadJournal.kt', 'StorePurchaseRecovery.kt', 'LibraryState.kt', 'PlayPurchases.kt')]
    sources += [ROOT / 'android/host-tests/StorePurchaseRecoveryTests.kt']
    fixtures = sorted((ROOT / 'scripts/test-fixtures/android-repository-readiness').glob('*.kt')) + sorted((ROOT / 'scripts/test-fixtures/android-store-recovery').glob('*.kt'))
    sources += fixtures
    inputs = [Path(__file__).resolve(), compiler, java, coroutines, *sources]
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    jar = output / 'store-recovery.jar'
    commands = [('compile', [str(compiler), '-jvm-target', '17', '-cp', str(coroutines), '-include-runtime', '-d', str(jar), *map(str, sources)]),
                ('tests', [str(java), '-cp', str(jar) + os.pathsep + str(coroutines), 'com.lovelies.frontend.preview.StorePurchaseRecoveryTestsKt'])]
    rows = []
    report = {'scope': 'actual store engine, repository and PlayPurchases caller; injected vault/network, controlled Billing SDK, and compile-only Android/Compose/JSON/Keystore stubs; no Android SDK app, provider, payment, encryption or device validation', 'inputs': hashes, 'steps': rows, 'passed': False}
    env = dict(os.environ)
    env['JAVA_HOME'] = str(java.parent.parent)
    report['status'] = 'running'
    (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    for label, command in commands:
        timeout = args.compile_timeout_seconds if label == 'compile' else 60
        code, log, timed_out = run_step(command, env, timeout)
        (output / (label + '.log')).write_bytes(log)
        row = {'label': label, 'exit': code, 'command': command, 'timeout_seconds': timeout, 'timed_out': timed_out}
        rows.append(row)
        (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        if code:
            print(log.decode(errors='replace')[-10000:])
            break
        if label == 'tests':
            match = re.search(rb'RESULT total=(\d+) passed=(\d+) failed=(\d+)', log)
            if match:
                report['tests'] = dict(zip(('total', 'passed', 'failed'), map(int, match.groups())))
    report['inputs_unchanged'] = all(hashlib.sha256(p.read_bytes()).hexdigest() == hashes[str(p)] for p in inputs)
    report['passed'] = len(rows) == 2 and all(r['exit'] == 0 for r in rows) and report.get('tests', {}).get('total', 0) > 0 and report['tests']['failed'] == 0 and report['inputs_unchanged']
    report['status'] = 'passed' if report['passed'] else ('timed_out' if any(row['timed_out'] for row in rows) else 'failed')
    (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'tests': report.get('tests'), 'evidence': str(output)}))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
