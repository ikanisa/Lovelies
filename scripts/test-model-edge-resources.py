#!/usr/bin/env python3
"""Run the bounded adapter fixture in fresh, offline Supabase Edge workers.

Uses only cached images. This is synthetic transport/resource evidence, separate
from real recognition, actual Storage overhead and hosted full-API acceptance.
"""
import argparse
import hashlib
import json
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = 'public.ecr.aws/supabase/edge-runtime:v1.74.3'
CLIENT = 'public.ecr.aws/supabase/storage-api:v1.68.10'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model', choices=['current', 'before'], required=True)
    parser.add_argument('--case', choices=['max', 'over'], required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    token = uuid.uuid4().hex[:12]
    container = 'lovelies-edge-resource-' + token
    commands = []
    sources = []
    clients = []
    for folder in ['services/supabase-api/src', 'services/supabase-api/test/model-resource-edge',
                   'services/supabase-api/test/fixtures/model-resource-before']:
        for path in sorted((ROOT / folder).rglob('*')):
            if path.is_file():
                data = path.read_bytes()
                sources.append({'path': str(path.relative_to(ROOT)), 'bytes': len(data),
                                'sha256': hashlib.sha256(data).hexdigest()})
    for name in ['scripts/test-model-edge-resources.py', 'services/supabase-api/test/model-resource-probe.ts',
                 'services/supabase-api/test/model-resource-edge-main.ts']:
        data = (ROOT / name).read_bytes()
        sources.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    report = {'schema': 1, 'status': 'running', 'model': args.model, 'case': args.case,
              'container': container, 'source': sources, 'commands': commands,
              'worker_limits': {'memoryLimitMb': 256, 'cpuTimeSoftLimitMs': 2000,
                                'cpuTimeHardLimitMs': 2000, 'workerTimeoutMs': 150000},
              'scope': 'Synthetic adapter transport only; actual cached Supabase Edge worker supervisor',
              'recognition': False, 'hosted': False}

    def save():
        try:
            (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
            return True
        except OSError as error:
            report.setdefault('file_io_errors', []).append({'path': 'receipt.json', 'error': str(error)})
            return False

    def run(label, command, timeout=60, require=True):
        timed_out = False
        try:
            p = subprocess.run(command, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            timed_out = True
            p = subprocess.CompletedProcess(command, 124, error.stdout or b'', error.stderr or b'')
        except OSError as error:
            p = subprocess.CompletedProcess(command, 127, b'', str(error).encode())
        for suffix, data in [('stdout', p.stdout), ('stderr', p.stderr)]:
            try:
                (output / (label + '.' + suffix)).write_bytes(data)
            except OSError as error:
                report.setdefault('file_io_errors', []).append({'path': label + '.' + suffix, 'error': str(error)})
        commands.append({'label': label, 'command': command, 'exit_code': p.returncode, 'timed_out': timed_out})
        save()
        if require and p.returncode:
            raise RuntimeError(label + ' failed; diagnostics preserved')
        return p

    def client(label, path, timeout=30, require=True):
        script = "const r=await fetch('http://127.0.0.1:9000" + path + "');const value=await r.json();console.log(JSON.stringify({http_status:r.status,body:value}));"
        client_name = container + '-client-' + label
        clients.append(client_name)
        return run(label, ['docker', 'run', '--rm', '--name', client_name,
                          '--label', 'lovelies.edge-resource=' + token, '--pull=never', '--network', 'container:' + container,
                          '--memory', '128m', '--cpus', '0.5', '--read-only', '--cap-drop', 'ALL',
                          '--pids-limit', '64', '--entrypoint', 'node', CLIENT,
                          '--input-type=module', '-e', script], timeout, require)

    if not save():
        raise OSError('Cannot preserve initial receipt; no containers started')
    try:
        for label, image in [('edge-image', EDGE), ('client-image', CLIENT)]:
            p = run(label, ['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
            report[label] = p.stdout.decode().strip()
        run('start', ['docker', 'run', '-d', '--pull=never', '--name', container,
                      '--label', 'lovelies.edge-resource=' + token, '--network', 'none',
                      '--memory', '768m', '--cpus', '1', '--read-only', '--cap-drop', 'ALL',
                      '--security-opt', 'no-new-privileges', '--pids-limit', '128',
                      '--tmpfs', '/tmp:rw,nosuid,nodev,size=134217728',
                      '-e', 'DENO_DIR=/tmp/deno',
                      '-e', 'LOVELIES_RESOURCE_WORKER_PATH=/workspace/services/supabase-api/test/model-resource-edge/worker',
                      '-e', 'LOVELIES_RESOURCE_MODEL_MODULE=' + args.model,
                      '-v', str(ROOT / 'services/supabase-api/src') + ':/workspace/services/supabase-api/src:ro',
                      '-v', str(ROOT / 'services/supabase-api/test') + ':/workspace/services/supabase-api/test:ro',
                      EDGE, 'start', '--main-service', '/workspace/services/supabase-api/test/model-resource-edge/main',
                      '--max-parallelism', '1'])
        healthy = False
        for attempt in range(20):
            p = client('health-' + str(attempt), '/health', require=False)
            if p.returncode == 0:
                healthy = json.loads(p.stdout).get('body', {}).get('fixture') is True
                if healthy:
                    break
            time.sleep(0.25)
        if not healthy:
            raise RuntimeError('Fixture main service did not become ready')
        p = client('probe', '/resource?case=' + args.case, timeout=180, require=False)
        report['client_exit_code'] = p.returncode
        if p.returncode:
            raise RuntimeError('Resource request did not complete; inspect supervisor logs')
        result = json.loads(p.stdout)
        report['result'] = result
        report['probe_status'] = 'passed' if result['http_status'] == 200 and result['body'].get('status') == 'passed' else 'failed'
        report['status'] = 'cleanup_pending'
    except Exception as error:
        report['status'] = 'failed'
        report['failure'] = type(error).__name__ + ': ' + str(error)
    finally:
        # Docker may have created a container even if its launching CLI timed
        # out. Inspect every exact owned identity, including anonymous-client
        # replacements, rather than relying on the CLI's successful return.
        cleanup_failures = []
        for index, name in enumerate([*clients, container]):
            present = run('cleanup-inspect-' + str(index),
                          ['docker', 'inspect', '--format', '{{.Id}}', name], require=False)
            absent = ('no such object: ' + name).encode() in present.stderr.lower()
            if present.returncode == 1 and absent:
                continue
            if present.returncode:
                cleanup_failures.append(name + ':inspect')
                continue
            if name == container:
                run('stop', ['docker', 'stop', '--time', '5', container], require=False)
                run('runtime', ['docker', 'logs', container], require=False)
            removed = run('cleanup-remove-' + str(index), ['docker', 'rm', '-f', name], require=False)
            if removed.returncode:
                cleanup_failures.append(name + ':remove')
        report['cleanup_failures'] = cleanup_failures
        if report['status'] == 'cleanup_pending':
            report['status'] = report['probe_status']
        if cleanup_failures:
            report['status'] = 'cleanup_failed'
        report['changed_inputs'] = []
        for row in sources:
            try:
                unchanged = hashlib.sha256((ROOT / row['path']).read_bytes()).hexdigest() == row['sha256']
            except OSError:
                unchanged = False
            if not unchanged:
                report['changed_inputs'].append(row['path'])
        if report['changed_inputs']:
            report['status'] = 'source_changed'
        if report.get('file_io_errors'):
            report['status'] = 'evidence_write_failed'
        if not save():
            report['status'] = 'evidence_write_failed'
    print(json.dumps({'status': report['status'], 'model': args.model, 'case': args.case,
                      'receipt': str(output / 'receipt.json')}), flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
