#!/usr/bin/env python3
"""Run the existing Swift host suites against an explicitly started local API.

The integration owner starts one fresh API/runtime per HTTP suite, then keeps it
running across that suite's separate recovery phases. This runner never deploys,
resets a database, selects test images or substitutes a server/model verdict.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse


ROOT = Path(__file__).resolve().parents[1]
PRODUCTION = [
    'ios/Lovelies/Native/CoreWire.swift',
    'ios/Lovelies/Native/DeviceIdentity.swift',
    'ios/Lovelies/Native/CameraRecovery.swift',
    'ios/Lovelies/Native/UploadRecovery.swift',
    'ios/Lovelies/Native/UploadFileTransport.swift',
    'ios/Lovelies/Native/BackendRepository.swift',
]
CONTROLLED = [
    'NativeProtocolTests', 'NativeConnectionTests', 'NativeOrdinaryLoginTests', 'NativeCameraRecoveryTests',
    'NativeEnrollmentRecoveryTests', 'NativeFaceProfileLifecycleTests',
    'NativeAccountRecoveryTests', 'NativeRefreshDeliveryTests',
]
HTTP = {
    'live': ('NativeLiveHTTPJourney', [None]),
    'enrollment': ('NativeEnrollmentRecoveryHTTPJourney', ['start', 'capture', 'complete', 'finish']),
    'profile': ('NativeFaceProfileLifecycleHTTPJourney', ['owner', 'replace', 'capture', 'complete', 'finish']),
    'account': ('NativeAccountRecoveryHTTPJourney', ['owner', 'start', 'capture', 'complete', 'finish']),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['wire', 'controlled', *HTTP], required=True)
    parser.add_argument('--config', type=Path, help='Frozen shared native fixture config; required for HTTP suites')
    parser.add_argument('--output', type=Path, required=True, help='A new private evidence directory; existing attempts are preserved')
    args = parser.parse_args()
    if args.suite in HTTP and args.config is None:
        parser.error('--config is required for an HTTP suite')
    output = args.output.resolve()
    if output.exists():
        parser.error('--output already exists; preserve it and select a new attempt directory')
    env = dict(os.environ)
    env.setdefault('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer')
    if not Path(env['DEVELOPER_DIR']).is_dir():
        parser.error('Select the installed full Xcode using DEVELOPER_DIR')
    names = ['NativeProtocolTests'] if args.suite == 'wire' else CONTROLLED if args.suite == 'controlled' else [HTTP[args.suite][0]]
    source_paths = [ROOT / name for name in PRODUCTION]
    source_paths += [ROOT / 'ios/Tests' / (name + '.swift') for name in names]
    source_paths.append(Path(__file__).resolve())
    config = None
    if args.config:
        args.config = args.config.resolve()
        config = json.loads(args.config.read_text())
        parsed = urllib.parse.urlsplit(config['api_origin'])
        if parsed.scheme != 'http' or parsed.hostname not in ['127.0.0.1', 'localhost'] or parsed.username or parsed.password or parsed.path not in ['', '/'] or parsed.query or parsed.fragment:
            parser.error('HTTP suites require an explicit credential-free loopback API origin')
        source_paths.append(args.config)
        for item in config['files']:
            path = Path(item['path'])
            if not path.is_absolute():
                path = ROOT / path
            data = path.read_bytes()
            if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                parser.error('A declared engineering input changed: ' + item['path'])
            source_paths.append(path)

    def path_name(path):
        try:
            return str(path.relative_to(ROOT))
        except ValueError:
            return str(path)

    frozen = []
    for path in dict.fromkeys(source_paths):
        data = path.read_bytes()
        frozen.append({'path': path_name(path), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    output.mkdir(mode=0o700, parents=True)
    (output / 'private').mkdir(mode=0o700)
    report_path = output / 'result.json'
    report = {
        'schema': 1, 'status': 'running', 'suite': args.suite,
        'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'source': frozen, 'developer_dir': env['DEVELOPER_DIR'], 'checks': [],
        'scope': 'Existing native Swift production repository/wire and test suites, running sequentially on the macOS host',
        'api_origin': config['api_origin'] if config else None,
        'fixture_scope': config['scope'] if config else None,
        'does_not_establish': ['iOS application or SwiftUI execution', 'Physical camera, Keychain or Secure Enclave acceptance', 'Representative recognition accuracy', 'Hosted deployment, provider, signing or store release acceptance'],
    }

    def save():
        report_path.write_text(json.dumps(report, indent=2) + '\n')

    def verify():
        for item in frozen:
            path = Path(item['path'])
            if not path.is_absolute():
                path = ROOT / path
            data = path.read_bytes()
            if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise RuntimeError('Frozen input changed: ' + item['path'])

    def run(label, command, timeout):
        verify()
        log = output / (label + '.log')
        row = {'label': label, 'command': command, 'log': path_name(log), 'status': 'running'}
        report['checks'].append(row)
        save()
        with log.open('x') as stream:
            try:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
                row['returncode'] = result.returncode
            except subprocess.TimeoutExpired:
                row.update(status='failed', failure='timeout')
                save()
                raise
        verify()
        row['status'] = 'passed' if result.returncode == 0 else 'failed'
        save()
        if result.returncode != 0:
            raise RuntimeError(label + ' failed; preserved log: ' + path_name(log))
        return row

    save()
    try:
        toolchain = run('swift-toolchain', ['xcrun', 'swiftc', '--version'], 30)
        report['toolchain'] = (output / 'swift-toolchain.log').read_text().strip()
        for name in names:
            binary = output / name
            run(name + '-compile', ['xcrun', 'swiftc', *PRODUCTION, 'ios/Tests/' + name + '.swift', '-o', str(binary)], 300)
            if args.suite in ['wire', 'controlled']:
                row = run(name + '-tests', [str(binary)], 180)
                match = re.search(r'checks passed: (\d+)', (output / (name + '-tests.log')).read_text())
                if not match:
                    row['status'] = 'failed'
                    raise RuntimeError('Missing completed native check count: ' + name)
                row['assertions_passed'] = int(match.group(1))
                save()
                print(json.dumps({'suite': name, 'status': row['status'], 'checks': row['assertions_passed']}), flush=True)
                continue
            for phase in HTTP[args.suite][1]:
                label = name + ('-' + phase if phase else '')
                result_path = output / (label + '-result.json')
                command = [str(binary), str(args.config)]
                if phase:
                    command += [str(output / 'private' / 'process-vault'), phase]
                command.append(str(result_path))
                row = run(label, command, 600)
                value = json.loads(result_path.read_text())
                row['result'] = path_name(result_path)
                row['assertions_passed'] = value.get('assertions_passed')
                row['stages'] = len(value.get('checks', []))
                if value.get('status') != 'passed':
                    row['status'] = 'failed'
                    raise RuntimeError('Native journey did not report completion: ' + label)
                save()
                print(json.dumps({'suite': args.suite, 'phase': phase, 'status': 'passed', 'assertions': row['assertions_passed']}), flush=True)
        verify()
        report['status'] = 'passed'
        report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
        return 0
    except Exception as error:
        report['status'] = 'failed'
        report['failure'] = type(error).__name__ + ': ' + str(error)
        report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
        print(report['failure'], file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
