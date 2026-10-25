#!/usr/bin/env python3
"""Run existing installed Android journeys against one root-owned loopback API.

Start a fresh disposable API externally for each invocation and install the exact
app/test APKs in place beforehand. This script verifies their installed hashes;
it never installs, clears app data, uninstalls, changes adb reverse mappings, or
exports device journals. Recovery phases share a new isolated run UUID and use
separate instrumentation processes with a force-stop between completed phases.

Example (the integration owner supplies the serial and starts the API):
  python3 scripts/test-android-openface.py --serial OBSERVED_SERIAL \
    --api http://127.0.0.1:18887 --scenario account-recovery \
    --config /absolute/fresh-runtime/openface-native-journey.json \
    --output /absolute/new-private-attempt
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import uuid
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'com.lovelies.memories'
TEST_PACKAGE = PACKAGE + '.test'
COMPONENT = TEST_PACKAGE + '/com.lovelies.frontend.preview.NativeCloudflareJourney'
MANIFEST = 'openface-native-journey.json'
INPUTS = ({f'{slot}{index}.jpg' for slot in ('a', 'b') for index in range(6)}
          | {f'P{index}.jpg' for index in range(1, 5)}
          | {f'no-face-{index}.jpg' for index in range(3)})
SCENARIOS = ('main', 'account-recovery', 'camera-recovery', 'enrollment-recovery', 'lifecycle')
PHASED = {'account-recovery', 'enrollment-recovery', 'lifecycle'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(data)
    return result.hexdigest()


def identity(path):
    return {'path': str(path), 'sha256': digest(path), 'bytes': path.stat().st_size}


def loopback(value):
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost')
            and not parsed.username and not parsed.password and parsed.path in ('', '/')
            and not parsed.query and not parsed.fragment and parsed.port is not None
            and 1024 <= parsed.port <= 65535,
            'Pass an explicit credential-free HTTP loopback origin with port')
    return f'http://{parsed.hostname}:{parsed.port}', parsed.port


def fixture_manifest(data):
    require(0 < len(data) <= 65536, 'Fixture manifest exceeds the native contract')
    value = json.loads(data)
    files = value.get('files')
    require(isinstance(files, list) and len(files) == 19, 'Exactly 19 declared engineering inputs are required')
    by_name = {}
    for item in files:
        require(isinstance(item, dict) and set(item) == {'path', 'sha256', 'bytes'}, 'Invalid fixture identity fields')
        require(isinstance(item['path'], str), 'Invalid fixture path')
        name = Path(item['path']).name
        require(name in INPUTS and name not in by_name, 'Missing, duplicate or unexpected engineering input')
        require(type(item['bytes']) is int and 0 < item['bytes'] <= 8 * 1024 * 1024
                and isinstance(item['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', item['sha256']),
                'Invalid fixture length or SHA-256')
        by_name[name] = item
    require(set(by_name) == INPUTS, 'The 19-input fixture set changed')
    return value, by_name


def normalized_manifest(value):
    # Only declared input path prefixes can differ between fresh runtime folders.
    paths = {item['path']: Path(item['path']).name for item in value['files']}

    def normalize(item):
        if isinstance(item, dict):
            return {key: normalize(child) for key, child in item.items()}
        if isinstance(item, list):
            return [normalize(child) for child in item]
        return paths.get(item, item) if isinstance(item, str) else item

    return normalize(value)


def check_fixtures(config_path, test_apk, api):
    runtime_bytes = config_path.read_bytes()
    runtime, runtime_files = fixture_manifest(runtime_bytes)
    require(runtime.get('api_origin') == api, 'Runtime fixture API differs from the explicit loopback API')
    with zipfile.ZipFile(test_apk) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'Test APK has duplicate ZIP paths')
        manifest_name = 'assets/' + MANIFEST
        require(archive.getinfo(manifest_name).file_size <= 65536, 'Packaged fixture manifest is too large')
        packaged_bytes = archive.read(manifest_name)
        packaged, packaged_files = fixture_manifest(packaged_bytes)
        require(normalized_manifest(runtime) == normalized_manifest(packaged),
                'Runtime and packaged graph/metadata differ beyond declared input path prefixes')
        frozen_inputs, packaged_inputs = [], []
        for name in sorted(INPUTS):
            expected = packaged_files[name]
            info = archive.getinfo('assets/' + name)
            require(info.file_size == expected['bytes'], 'Packaged fixture size changed: ' + name)
            data = archive.read(info)
            require(hashlib.sha256(data).hexdigest() == expected['sha256'], 'Packaged fixture SHA changed: ' + name)
            path = Path(runtime_files[name]['path'])
            if not path.is_absolute():
                path = config_path.parent / path
            require(not path.is_symlink() and path.is_file(), 'Runtime input is absent or a symlink: ' + name)
            path = path.resolve()
            row = identity(path)
            require(row['bytes'] == expected['bytes'] and row['sha256'] == expected['sha256'],
                    'Runtime input differs from the packaged bytes: ' + name)
            frozen_inputs.append(row)
            packaged_inputs.append({'asset': 'assets/' + name, 'sha256': expected['sha256'], 'bytes': expected['bytes']})
    return runtime, packaged, frozen_inputs, {
        'asset': manifest_name, 'sha256': hashlib.sha256(packaged_bytes).hexdigest(),
        'bytes': len(packaged_bytes), 'inputs': packaged_inputs,
        'comparison': 'Exact graph and metadata; only declared input path prefixes normalized; all 19 image bytes identical',
    }


def parse_instrumentation(data, result_path=None):
    prefix = b'INSTRUMENTATION_RESULT: native_cloudflare_journey='
    results = [line[len(prefix):] for line in data.splitlines() if line.startswith(prefix)]
    codes = re.findall(rb'^INSTRUMENTATION_CODE:\s*(-?\d+)\s*$', data, re.MULTILINE)
    require(len(results) == 1, 'Expected one native_cloudflare_journey result; inspect the preserved raw log')
    if result_path is not None:
        # Retain the payload even if JSON/completion-code validation then fails.
        with result_path.open('xb') as stream:
            stream.write(results[0] + b'\n')
    require(len(codes) == 1, 'Expected one completed instrumentation code; outcome may be unknown')
    return results[0], json.loads(results[0]), int(codes[0])


def check_journey(value, code, scenario, phase, run_id, api, packaged):
    require(code == -1, 'Android instrumentation did not return INSTRUMENTATION_CODE: -1')
    require(value.get('status') == 'passed' and value.get('failure') is None, 'Native journey reported failure')
    checks = value.get('checks')
    require(isinstance(checks, list) and len(checks) > 0 and type(value.get('passed')) is int and value['passed'] == len(checks)
            and all(isinstance(item, dict) and item.get('status') == 'passed' for item in checks),
            'Native journey check completion is inconsistent')
    require(value.get('api_origin') == api and value.get('scenario') == ('sharing' if scenario == 'main' else scenario),
            'Native journey executed a different API or scenario')
    require(value.get('fixture_files') == packaged['files'], 'Native result does not bind the packaged fixture identities')
    require(value.get('input_scope') == packaged['scope'], 'Native input scope differs from the packaged fixture declaration')
    require(value.get('camera_sensor_evidence') is False and value.get('hosted') is False
            and value.get('fake_backend_success') is False and value.get('retained_owner') is False,
            'Native result scope or owner-vault preservation differs from this run')
    require(value.get('recovery_checkpoint') == phase and value.get('recovery_run_id') == run_id,
            'Recovery phase or isolated run UUID changed')
    if phase:
        require(value.get('retained_isolated_recovery_journal') is (phase != 'finish'),
                'Recovery checkpoint retention differs from the requested phase')


def adb_default():
    found = shutil.which('adb')
    if found:
        return found
    for variable in ('ANDROID_SDK_ROOT', 'ANDROID_HOME'):
        candidate = Path(os.environ.get(variable, '/nonexistent')) / 'platform-tools/adb'
        if candidate.is_file():
            return str(candidate)
    return 'adb'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--serial', required=True, help='Exact already-connected Android serial; no implicit device selection')
    parser.add_argument('--api', required=True, help='Explicit loopback API with an already-owned matching adb reverse mapping')
    parser.add_argument('--config', type=Path, required=True, help='Fresh runtime openface-native-journey.json')
    parser.add_argument('--output', type=Path, required=True, help='New private attempt directory; existing evidence is never replaced')
    parser.add_argument('--scenario', choices=SCENARIOS, default='main')
    parser.add_argument('--adb', default=adb_default())
    parser.add_argument('--app-apk', type=Path, default=ROOT / 'android/app/build/outputs/apk/debug/app-debug.apk')
    parser.add_argument('--test-apk', type=Path, default=ROOT / 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')
    parser.add_argument('--recovery-port', type=int, default=18989, help='Same isolated device-local reply-loss relay port across phases')
    args = parser.parse_args(argv)
    try:
        require(re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', args.serial), 'Invalid explicit Android serial')
        api, api_port = loopback(args.api)
        require(1024 <= args.recovery_port <= 65535 and args.recovery_port != api_port, 'Invalid isolated recovery relay port')
        output = args.output.absolute()
        require(not output.exists() and not output.is_symlink(), 'Output already exists; select a new attempt and preserve the old one')
        adb = shutil.which(args.adb)
        require(adb is not None, 'adb is unavailable; pass the existing SDK adb using --adb')
        adb = str(Path(adb).resolve())
        config_path = args.config.resolve(strict=True)
        app_apk = args.app_apk.resolve(strict=True)
        test_apk = args.test_apk.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        parser.error(str(error))

    os.umask(0o077)
    output.mkdir(mode=0o700, parents=True)
    report_path = output / 'result.json'
    run_id = str(uuid.uuid4()) if args.scenario in PHASED else None
    report = {
        'schema': 1, 'status': 'running', 'started_at': now(), 'scenario': args.scenario,
        'serial': args.serial, 'api_origin': api, 'expected_database': 'supabase_postgresql',
        'recovery_run_id': run_id, 'recovery_port': args.recovery_port if run_id else None,
        'checks': [], 'source': [],
        'scope': 'Existing installed Android production repository/Keystore/HTTP journeys using declared engineering stills',
        'preservation': 'No install, uninstall, app-data clear, journal export, reverse-map change, or automatic retry; force-stop only between passed recovery phases',
        'does_not_establish': ['Optical camera or representative recognition acceptance', 'Hosted deployment, provider, signing or store release acceptance', 'Independent proof that the observed APKs were compiled from the frozen source'],
    }
    frozen = []

    def save():
        report_path.write_text(json.dumps(report, indent=2) + '\n')

    def verify():
        for item in frozen:
            path = Path(item['path'])
            require(path.is_file() and path.stat().st_size == item['bytes'] and digest(path) == item['sha256'],
                    'Frozen input changed: ' + item['path'])

    def run(label, command, timeout=30, allowed=(0,)):
        verify()
        log = output / (label + '.log')
        row = {'label': label, 'command': command, 'log': str(log), 'status': 'running', 'started_at': now()}
        report['checks'].append(row)
        save()
        with log.open('xb') as stream:
            try:
                completed = subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
            except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                row.update(status='failed', failure=type(error).__name__, finished_at=now())
                if 'instrument' in command:
                    row['device_instrumentation_outcome'] = 'unknown; may still be running; reconcile before another attempt'
                save()
                raise
        row.update(returncode=completed.returncode, finished_at=now(), status='passed' if allowed is None or completed.returncode in allowed else 'failed')
        save()
        verify()
        require(allowed is None or completed.returncode in allowed, label + ' failed; inspect ' + str(log))
        return row, log.read_bytes()

    def device(label, *command, timeout=30, allowed=(0,)):
        return run(label, [adb, '-s', args.serial, *command], timeout, allowed)

    def installed(label, package, apk):
        _, raw = device(label + '-path', 'shell', 'pm', 'path', package)
        paths = re.findall(rb'^package:([^\r\n]+)$', raw, re.MULTILINE)
        require(len(paths) == 1, 'Expected one installed APK for ' + package + '; install the exact selected APK in place externally')
        path = paths[0].decode('utf-8')
        require(re.fullmatch(r'/(?:data|mnt/expand)/[A-Za-z0-9._~+!%/=-]+\.apk', path), 'Unexpected installed APK path')
        _, raw = device(label + '-sha256', 'shell', 'sha256sum', path)
        matches = re.findall(rb'^([0-9a-f]{64})\s+\S+\s*$', raw, re.MULTILINE)
        require(len(matches) == 1 and matches[0].decode() == digest(apk),
                'Installed ' + package + ' differs from the selected APK; root must install it in place before this runner')

    save()
    try:
        runtime, packaged, fixture_paths, packaged_manifest = check_fixtures(config_path, test_apk, api)
        sources = [Path(__file__).resolve(), config_path, app_apk, test_apk, Path(adb)]
        for tree in ('main', 'androidTest', 'test'):
            sources.extend(sorted((ROOT / 'android/app/src' / tree / 'java/com/lovelies/frontend/preview').glob('*.kt')))
        sources.extend(ROOT / name for name in (
            'android/app/build.gradle.kts', 'android/build.gradle.kts', 'android/settings.gradle.kts',
            'android/gradle/wrapper/gradle-wrapper.properties', 'android/app/src/main/AndroidManifest.xml',
            'android/app/src/main/res/xml/camera_paths.xml', 'android/app/src/androidTest/prepare-openface-manifest.mjs'))
        frozen = [identity(path) for path in dict.fromkeys(sources)] + fixture_paths
        report.update(source=frozen, packaged_fixture_manifest=packaged_manifest, fixture_scope=runtime['scope'])
        save()
        run('adb-version', [adb, 'version'])
        _, raw = device('device-state', 'get-state')
        require(raw.strip() == b'device', 'The exact selected Android device is not ready')
        report['device'] = {}
        for key in ('ro.build.fingerprint', 'ro.build.version.sdk', 'ro.product.cpu.abi', 'ro.kernel.qemu'):
            _, raw = device('device-' + key, 'shell', 'getprop', key)
            report['device'][key] = raw.decode('utf-8').strip()
        _, raw = device('reverse-map', 'reverse', '--list')
        mapping = f'tcp:{api_port}'
        require(any(line.split()[-2:] == [mapping, mapping] for line in raw.decode('utf-8').splitlines()),
                'The existing owned adb reverse mapping is absent; root must establish it externally')
        _, raw = device('instrumentation-registration', 'shell', 'pm', 'list', 'instrumentation', PACKAGE)
        require(('instrumentation:' + COMPONENT + ' (target=' + PACKAGE + ')') in raw.decode('utf-8').splitlines(),
                'The expected installed instrumentation component/target is absent')
        installed('installed-app', PACKAGE, app_apk)
        installed('installed-test', TEST_PACKAGE, test_apk)
        report['installed_apks_match'] = True
        save()
        phases = ('start', 'capture', 'completion', 'finish') if run_id else (None,)
        for phase in phases:
            label = phase or args.scenario
            command = ['shell', 'am', 'instrument', '-w', '-r', '-e', 'lovelies_api', api,
                       '-e', 'fixture_manifest', MANIFEST, '-e', 'expected_database', 'supabase_postgresql',
                       '-e', 'scenario', 'sharing' if args.scenario == 'main' else args.scenario]
            if phase:
                command += ['-e', 'recovery_checkpoint', phase, '-e', 'recovery_run_id', run_id,
                            '-e', 'recovery_port', str(args.recovery_port)]
            row, raw = device(label, *command, COMPONENT, timeout=600, allowed=None)
            result_path = output / (label + '-result.json')
            try:
                _, value, code = parse_instrumentation(raw, result_path)
                row.update(result=str(result_path), instrumentation_code=code, assertions_passed=value.get('passed'))
                require(row['returncode'] == 0, 'adb instrumentation process failed')
                check_journey(value, code, args.scenario, phase, run_id, api, packaged)
            except Exception as error:
                if result_path.is_file():
                    row['result'] = str(result_path)
                row.update(status='failed', failure=type(error).__name__ + ': ' + str(error))
                save()
                raise
            row['status'] = 'passed'
            save()
            print(json.dumps({'scenario': args.scenario, 'phase': phase, 'status': 'passed', 'checks': value['passed']}), flush=True)
            if phase and phase != 'finish':
                device(label + '-force-stop', 'shell', 'am', 'force-stop', PACKAGE)
                _, raw = device(label + '-stopped-process', 'shell', 'pidof', PACKAGE, allowed=(0, 1))
                require(not raw.strip(), 'The app process remained after the between-phase force-stop')
        installed('final-installed-app', PACKAGE, app_apk)
        installed('final-installed-test', TEST_PACKAGE, test_apk)
        verify()
        report.update(status='passed', finished_at=now())
        save()
        return 0
    except (Exception, KeyboardInterrupt) as error:
        report.update(status='failed', failure=type(error).__name__ + ': ' + str(error), finished_at=now())
        save()
        print(report['failure'], file=sys.stderr)
        return 130 if isinstance(error, KeyboardInterrupt) else 1


if __name__ == '__main__':
    sys.exit(main())
