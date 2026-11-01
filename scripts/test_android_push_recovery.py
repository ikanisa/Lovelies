#!/usr/bin/env python3
"""Compile and run actual push recovery logic with synthetic provider/vault boundaries."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kotlinc', default=os.environ.get('KOTLINC') or shutil.which('kotlinc'))
    parser.add_argument('--java', default=os.environ.get('JAVA') or shutil.which('java'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.kotlinc or not args.java:
        parser.error('Supply existing Kotlin/JVM compiler and Java executable paths; this runner never downloads tools.')
    output = args.output.resolve()
    if output.exists():
        parser.error('Select a new evidence directory; earlier attempts are preserved.')
    output.mkdir(parents=True)
    compiler, java = Path(args.kotlinc).resolve(), Path(args.java).resolve()
    coroutines = compiler.parent.parent / 'lib/kotlinx-coroutines-core-jvm.jar'
    sources = [ROOT / 'android/app/src/main/java/com/lovelies/frontend/preview' / name for name in ('NativeProtocol.kt', 'PushOperationRecovery.kt')]
    sources += [ROOT / 'android/host-tests/PushOperationRecoveryTests.kt']
    inputs = [Path(__file__).resolve(), compiler, java, coroutines, *sources]
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    jar = output / 'push-recovery.jar'
    commands = [('compile', [str(compiler), '-jvm-target', '17', '-cp', str(coroutines), '-include-runtime', '-d', str(jar), *map(str, sources)]),
                ('tests', [str(java), '-cp', str(jar) + os.pathsep + str(coroutines), 'com.lovelies.frontend.preview.PushOperationRecoveryTestsKt'])]
    rows = []
    report = {'scope': 'actual Kotlin journal/protocol/recovery code; controlled vault, network and authority; no Android SDK, Firebase delivery or device validation', 'inputs': hashes, 'steps': rows, 'passed': False}
    env = dict(os.environ)
    env['JAVA_HOME'] = str(java.parent.parent)
    for label, command in commands:
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, timeout=180)
        log = result.stdout + result.stderr
        (output / (label + '.log')).write_bytes(log)
        row = {'label': label, 'exit': result.returncode, 'command': command}
        rows.append(row)
        if result.returncode:
            print(log.decode(errors='replace')[-10000:])
            break
        if label == 'tests':
            match = re.search(rb'RESULT total=(\d+) passed=(\d+) failed=(\d+)', log)
            if match:
                report['tests'] = dict(zip(('total', 'passed', 'failed'), map(int, match.groups())))
    report['inputs_unchanged'] = all(hashlib.sha256(p.read_bytes()).hexdigest() == hashes[str(p)] for p in inputs)
    report['passed'] = len(rows) == 2 and all(r['exit'] == 0 for r in rows) and report.get('tests', {}).get('total', 0) > 0 and report['tests']['failed'] == 0 and report['inputs_unchanged']
    (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'tests': report.get('tests'), 'evidence': str(output)}))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
