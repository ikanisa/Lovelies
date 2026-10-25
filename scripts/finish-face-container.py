#!/usr/bin/env python3
"""Finalize one admitted unminimized native image; never rebuild native components."""
import argparse
import hashlib
import json
import platform
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = ROOT / 'services/ml-face'
MINIMUM_FREE_BYTES = 8 * 1024 ** 3
IMAGE = re.compile(r'sha256:[0-9a-f]{64}')
REFERENCE = re.compile(r'[a-z0-9][a-z0-9.:-]*(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}')
MARKER = 'FROM security-runtime-unminimized AS security-runtime\n'
PLAN_DESTINATION = '/usr/local/share/doc/lovelies-minimization/removal-plan.json'


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'duplicate_json_key')
        value[key] = item
    return value


def read_json(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 32 * 1024 ** 2,
            'bounded_ordinary_json_required')
    return json.loads(path.read_text(), object_pairs_hook=unique)


def validate_plan(path, expected_sha, config_id):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_sha) and sha(path) == expected_sha, 'reviewed_plan_hash_changed')
    plan = read_json(path)
    require(plan.get('schema') == 'lovelies-ml-runtime-minimization-plan-v1'
            and plan.get('preparer_schema') == 'lovelies-runtime-minimization-preparer-v2'
            and plan.get('baseline_image') == config_id
            and plan.get('observed_runtime', {}).get('image_id') == config_id
            and plan.get('observed_runtime', {}).get('architecture') == 'x86_64'
            and plan.get('service_entrypoint') == ['/app/.venv/bin/python', '-m', 'lovelies_ml_face'],
            'reviewed_plan_preimage_identity_changed')
    return plan


def validate_inspection(inspected, original, proof, reference, config_id):
    require(REFERENCE.fullmatch(reference) and IMAGE.fullmatch(config_id), 'immutable_platform_reference_required')
    require(proof.get('schema') == 'lovelies-native-image-id-binding-v1'
            and proof.get('status') == 'IDENTITY_BINDING_VERIFIED'
            and proof.get('canonical_config_id') == config_id
            and proof.get('config_descriptor', {}).get('digest') == config_id
            and proof.get('platform') == {'os': 'linux', 'architecture': 'amd64'}, 'preimage_proof_changed')
    descriptor = proof.get('docker_platform_manifest_descriptor', {})
    require(reference.rsplit('@', 1)[1] == descriptor.get('digest')
            and descriptor.get('mediaType') == 'application/vnd.oci.image.manifest.v1+json',
            'platform_manifest_reference_changed')
    require(isinstance(inspected, list) and len(inspected) == 1
            and isinstance(original, list) and len(original) == 1, 'one_image_inspection_required')
    for image in (original[0], inspected[0]):
        allowed = [config_id, descriptor['digest'], proof.get('docker_target_descriptor', {}).get('digest')]
        require(image.get('Id') in allowed and image.get('Os') == 'linux'
                and image.get('Architecture') == 'amd64' and image.get('Variant') in (None, ''), 'image_identity_or_platform_changed')
        require(image.get('RootFS') == {'Type': 'layers', 'Layers': proof['rootfs_diff_ids']}, 'ordered_rootfs_changed')
        if image.get('Id') != config_id:
            expected = descriptor if image['Id'] == descriptor['digest'] else proof['docker_target_descriptor']
            require({k: (image.get('Descriptor') or {}).get(k) for k in ('mediaType', 'digest', 'size')} == expected,
                    'inspection_descriptor_changed')
    expected, actual = original[0].get('Config'), inspected[0].get('Config')
    require(isinstance(expected, dict) and isinstance(actual, dict), 'execution_config_missing')
    require(all(actual.get(k) == v for k, v in expected.items())
            and all(v in (None, '', False, 0, [], {}) for k, v in actual.items() if k not in expected),
            'execution_config_changed')
    require(actual.get('User', '') in ('', 'root', '0', '0:0', 'root:root'), 'unminimized_root_stage_required')
    return {'canonical_config_id': config_id, 'platform_manifest': descriptor,
            'rootfs_diff_ids': proof['rootfs_diff_ids'], 'execution_config_fields': sorted(actual),
            'execution_config_sha256': hashlib.sha256(json.dumps(actual, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def final_dockerfile(original, reference):
    require(REFERENCE.fullmatch(reference), 'immutable_platform_reference_required')
    require(original.count(MARKER) == 1, 'canonical_security_tail_not_unique')
    tail = original.split(MARKER, 1)[1]
    require(re.findall(r'^FROM .*$', tail, re.MULTILINE) == ['FROM scratch AS final'], 'canonical_final_stage_changed')
    require(re.findall(r'^COPY .*$', tail, re.MULTILINE) == ['COPY --from=security-runtime / /'], 'unexpected_tail_overlay')
    require(tail.count('verify-runtime --manifest=' + PLAN_DESTINATION) == 1
            and tail.count('minimize-runtime.py') == 1 and 'USER lovelies\n' in tail,
            'canonical_verification_or_minimizer_missing')
    return ('FROM ' + reference + ' AS security-runtime\n'
            + 'COPY reviewed-removal-plan.json ' + PLAN_DESTINATION + '\n' + tail)


def source_bindings(context):
    bindings = []
    groups = [('src', '/app/src'), ('models', '/app/models'), ('vendor', '/app/vendor'), ('licenses', '/app/licenses'),
              ('patches/security-runtime-minimization', '/usr/local/share/doc/lovelies-minimization')]
    for local, destination in groups:
        for path in sorted((context / local).rglob('*')):
            if path.is_dir() or '__pycache__' in path.parts or path.suffix == '.pyc':
                continue
            require(path.is_file() and not path.is_symlink(), 'ordinary_source_binding_required')
            relative = path.relative_to(context / local).as_posix()
            if local.endswith('security-runtime-minimization') and relative == 'removal-plan.json':
                continue
            bindings.append({'source': str(path.resolve()), 'image': destination + '/' + relative,
                             'bytes': path.stat().st_size, 'sha256': sha(path)})
    for local, image in [('Dockerfile', '/usr/local/share/doc/lovelies-build/Dockerfile'),
                         ('pyproject.toml', '/app/pyproject.toml'), ('uv.lock', '/app/uv.lock')]:
        path = context / local
        require(path.is_file() and not path.is_symlink(), 'ordinary_source_binding_required')
        bindings.append({'source': str(path.resolve()), 'image': image, 'bytes': path.stat().st_size, 'sha256': sha(path)})
    require(any(row['image'].endswith('/prepare-plan.py') for row in bindings)
            and any(row['image'].endswith('/minimize-runtime.py') for row in bindings), 'original_minimization_recipes_required')
    return bindings


def verify_sources(bindings):
    for row in bindings:
        path = Path(row['source'])
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == row['bytes']
                and sha(path) == row['sha256'], 'source_changed_before_build')


SOURCE_CHECK = r'''
import hashlib,json,pathlib,sys
rows=json.load(sys.stdin)
for row in rows:
 p=pathlib.Path(row['image'])
 if not p.is_file() or p.is_symlink() or p.stat().st_size!=row['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest()!=row['sha256']:
  raise SystemExit('preimage_source_binding_changed: '+row['image'])
for directory in ('src','models','vendor','licenses'):
 root=pathlib.Path('/app')/directory
 expected={r['image'] for r in rows if r['image'].startswith(str(root)+'/')}
 actual={str(p) for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc'}
 if actual!=expected:raise SystemExit('unexpected_preimage_source_file_set: '+directory)
print(json.dumps({'status':'SOURCE_MATCH','files':len(rows),'native_acceptance':False}))
'''


def check_storage(path, free=None):
    available = shutil.disk_usage(path).free if free is None else free
    require(available >= MINIMUM_FREE_BYTES, 'eight_gib_docker_backing_filesystem_required')
    return {'path': str(path), 'free_bytes': available, 'minimum_free_bytes': MINIMUM_FREE_BYTES}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-image', required=True)
    parser.add_argument('--expected-config-id', required=True)
    parser.add_argument('--image-proof', required=True, type=Path)
    parser.add_argument('--bound-inspection', required=True, type=Path)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--expected-plan-sha256', required=True)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--pull-runtime', action='store_true', help='Explicitly pull only the immutable admitted platform reference')
    args = parser.parse_args()
    require(REFERENCE.fullmatch(args.runtime_image) and IMAGE.fullmatch(args.expected_config_id), 'immutable_image_identity_required')
    require(re.fullmatch(r'[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}', args.tag), 'explicit_new_local_tag_required')
    require(platform.system() == 'Linux' and platform.machine() in ('x86_64', 'AMD64'), 'native_linux_amd64_host_required')
    evidence = args.evidence.expanduser().resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    receipt = {'schema': 'lovelies-private-face-finalization-v1', 'status': 'running', 'commands': [],
               'native_acceptance': False, 'final_image_accepted': False, 'deployment_performed': False}
    owned = []
    primary_failure = False

    def write():
        (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def run(command, name, *, input=None, capture=False, timeout=300, allow_failure=False):
        began = time.monotonic()
        row = {'stage': name, 'command': command, 'timeout_seconds': timeout}
        receipt['commands'].append(row);write()
        try:
            result = subprocess.run(command, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            row.update(status='timed_out', wall_seconds=time.monotonic()-began)
            for stream, value in [('stdout', error.stdout), ('stderr', error.stderr)]:
                if value and not capture:(evidence / (name + '.' + stream)).write_bytes(value)
            write();raise
        row.update(exit_code=result.returncode, wall_seconds=time.monotonic()-began)
        if not capture:
            for stream in ('stdout', 'stderr'):(evidence / (name + '.' + stream)).write_bytes(getattr(result, stream))
        write()
        require(allow_failure or result.returncode == 0, 'command_failed: ' + name)
        return result

    try:
        plan = args.plan.resolve(strict=True)
        validate_plan(plan, args.expected_plan_sha256, args.expected_config_id)
        proof = read_json(args.image_proof)
        binding = proof.get('evidence', {}).get('docker_inspect', {})
        require(args.bound_inspection.stat().st_size == binding.get('bytes')
                and sha(args.bound_inspection) == binding.get('sha256'), 'original_inspection_proof_binding_changed')
        original = read_json(args.bound_inspection)
        info = json.loads(run(['docker', 'info', '--format', '{{json .}}'], 'daemon', capture=True).stdout)
        require(info.get('OSType') == 'linux' and info.get('Architecture') in ('amd64', 'x86_64'), 'native_amd64_daemon_required')
        backing = Path(info['DockerRootDir']).resolve(strict=True)
        receipt['storage_preflight'] = check_storage(backing)
        existing = run(['docker', 'image', 'inspect', args.tag], 'new_tag_check', capture=True, allow_failure=True)
        require(existing.returncode != 0 and re.search(rb'no such (?:image|object)', existing.stderr, re.I), 'tag_exists_or_inspection_failed')
        if args.pull_runtime:
            run(['docker', 'pull', '--platform=linux/amd64', args.runtime_image], 'immutable_runtime_pull', timeout=900)
        image = json.loads(run(['docker', 'image', 'inspect', args.runtime_image], 'preimage', capture=True).stdout)
        receipt['preimage'] = validate_inspection(image, original, proof, args.runtime_image, args.expected_config_id)
        sources = source_bindings(CONTEXT)
        (evidence / 'source-bindings.json').write_text(json.dumps(sources, indent=2)+'\n')
        receipt['plan'] = {'sha256': args.expected_plan_sha256, 'bytes': plan.stat().st_size, 'baseline_image': plan_identity(plan)}
        context = evidence / 'context';context.mkdir()
        shutil.copyfile(plan, context / 'reviewed-removal-plan.json')
        original_dockerfile = (CONTEXT / 'Dockerfile').read_text()
        (context / 'Dockerfile').write_text(final_dockerfile(original_dockerfile, args.runtime_image))
        receipt['canonical_dockerfile_sha256'] = sha(CONTEXT / 'Dockerfile')
        receipt['derived_dockerfile_sha256'] = sha(context / 'Dockerfile')
        common = ['docker', 'run', '--rm', '--read-only', '--network=none', '--user=0:0', '--cap-drop=ALL',
                  '--security-opt=no-new-privileges', '--memory=768m', '--cpus=1', '--pids-limit=128',
                  '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777', '--entrypoint=/app/.venv/bin/python']
        for stage, extra, code, stdin in [
            ('source_preflight', [], ['-B', '-c', SOURCE_CHECK], json.dumps(sources).encode()),
            ('plan_preflight', ['--mount', 'type=bind,src='+str(context/'reviewed-removal-plan.json')+',dst=/reviewed-plan.json,readonly'],
             ['-B', '/usr/local/share/doc/lovelies-minimization/prepare-plan.py', 'verify-runtime', '--manifest=/reviewed-plan.json'], None),
        ]:
            name = 'lovelies-finalize-' + uuid.uuid4().hex;owned.append(name)
            run(common + ['--name', name, '-i'] + extra + [args.runtime_image] + code, stage, input=stdin)
        verify_sources(sources)
        validate_plan(context/'reviewed-removal-plan.json', args.expected_plan_sha256, args.expected_config_id)
        receipt['storage_before_build'] = check_storage(backing)
        run(['docker', 'build', '--pull=false', '--network=none', '--platform=linux/amd64', '--progress=plain',
             '--tag', args.tag, '--iidfile', str(evidence/'final-image-id.txt'), '--file', str(context/'Dockerfile'), str(context)],
            'canonical_tail_build', timeout=1800)
        verify_sources(sources)
        receipt.update(status='built_pending_qualification', image_id=(evidence/'final-image-id.txt').read_text().strip())
        require(IMAGE.fullmatch(receipt['image_id']), 'final_immutable_identity_missing')
    except Exception as error:
        primary_failure = True
        receipt.update(status='failed', error_type=type(error).__name__, error=str(error));raise
    finally:
        cleanup = []
        for name in owned:
            try:
                result = run(['docker', 'container', 'rm', '--force', name], 'cleanup_'+name, timeout=30, allow_failure=True)
                require(result.returncode == 0 or re.search(rb'no such (?:container|object)', result.stderr, re.I), 'owned_container_cleanup_failed')
            except Exception as error:
                cleanup.append({'name': name, 'error_type': type(error).__name__})
        receipt['cleanup_failures'] = cleanup
        if cleanup:receipt['status'] = 'cleanup_failed'
        write()
        if cleanup and not primary_failure:
            raise RuntimeError('owned_container_cleanup_failed')


def plan_identity(path):
    return read_json(path)['baseline_image']


if __name__ == '__main__':
    main()
