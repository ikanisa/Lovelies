#!/usr/bin/env python3
"""Build the admitted two-file Lovelies consumer delta on its minimized base.

No native rebuild, dependency install, model replacement or generic OpenFace
runtime overlay. The resulting distinct image remains pending qualification.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import time
import uuid

SPEC = importlib.util.spec_from_file_location('face_consumer_finalizer', Path(__file__).with_name('finish-face-container.py'))
FINALIZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FINALIZER)
ROOT, CONTEXT = FINALIZER.ROOT, FINALIZER.CONTEXT
require, sha, read_json = FINALIZER.require, FINALIZER.sha, FINALIZER.read_json
BASE_DIGEST = 'sha256:185bb04257150bc9f831f638dfe60fec60d185df903d487a2df4be7dfca476ef'
ALLOWED = {'/app/src/lovelies_ml_face/engine.py', '/app/src/lovelies_ml_face/native_identity.py'}
NEW_MODULE = '/app/src/lovelies_ml_face/native_identity.py'
BASE_SOURCE_COUNT = 476
# Docker 29 may materialize the canonical WORKDIR after the flattened COPY as
# the standard empty tar layer. It adds no payload and must only occur last.
EMPTY_LAYER = 'sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef'
# Reuse the already verified, traversable technical-notice directory rather
# than create a new parent through a COPY that specifies file-only permissions.
DOC = '/usr/local/share/doc/lovelies-build/consumer-delta-provenance.json'
MIN_ROOT = '/usr/local/share/doc/lovelies-minimization/'
CMD = ['/app/.venv/bin/python', '-m', 'lovelies_ml_face']
SOURCE_CHECK = FINALIZER.SOURCE_CHECK + r'''
for directory in ('src','models','vendor','licenses'):
 for path in (pathlib.Path('/app')/directory).rglob('*'):
  if path.is_symlink():raise SystemExit('unexpected_preimage_source_symlink: '+str(path))
'''


def admitted_reference(reference):
    require(FINALIZER.REFERENCE.fullmatch(reference) and reference.endswith('/lovelies-inference-native@' + BASE_DIGEST),
            'exact_same_product_minimized_base_required')


def canonical_tail(dockerfile):
    marker = 'FROM scratch AS final\nCOPY --from=security-runtime / /\n'
    require(dockerfile.count(marker) == 1, 'canonical_scratch_tail_required')
    tail = dockerfile.split(marker, 1)[1]
    instructions, pending = [], ''
    for line in tail.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        pending += line.strip()
        if pending.endswith('\\'):
            pending = pending[:-1] + ' '
            continue
        instructions.append(pending);pending = ''
    require(not pending and [line.split(' ', 1)[0] for line in instructions] == ['ENV', 'WORKDIR', 'EXPOSE', 'USER', 'CMD'],
            'unexpected_final_tail_instruction')
    require(instructions[1:4] == ['WORKDIR /app', 'EXPOSE 8080', 'USER lovelies']
            and json.loads(instructions[4][4:]) == CMD, 'canonical_service_execution_changed')
    env = shlex.split(instructions[0][4:])
    keys = [item.split('=', 1)[0] for item in env]
    require(len(keys) == len(set(keys)) and set(keys) == {'PATH', 'LANG', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED',
            'MODEL_MANIFEST_PATH', 'PYTHONPATH', 'PORT', 'SSL_CERT_FILE', 'SSL_CERT_DIR'}, 'canonical_environment_changed')
    require(dict(item.split('=', 1) for item in env) == {
        'PATH': '/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8',
        'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1', 'MODEL_MANIFEST_PATH': '/app/models/model-manifest.json',
        'PYTHONPATH': '/app/src', 'PORT': '8080', 'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt',
        'SSL_CERT_DIR': '/etc/ssl/certs'}, 'canonical_environment_changed')
    return tail, env


def delta_dockerfile(canonical, reference):
    admitted_reference(reference)
    tail, _ = canonical_tail(canonical)
    return ('FROM ' + reference + ' AS consumer\n'
            'COPY --chown=0:0 --chmod=0644 engine.py /app/src/lovelies_ml_face/engine.py\n'
            'COPY --chown=0:0 --chmod=0644 native_identity.py /app/src/lovelies_ml_face/native_identity.py\n'
            'COPY --chown=0:0 --chmod=0444 consumer-provenance.json ' + DOC + '\n'
            'FROM scratch AS final\nCOPY --from=consumer / /\n' + tail)


def source_delta(base, current):
    require(isinstance(base, list) and len(base) == BASE_SOURCE_COUNT and isinstance(current, list), 'saved_base_source_bindings_required')
    def indexed(rows):
        result = {}
        for row in rows:
            require(isinstance(row, dict) and set(row) == {'source', 'image', 'bytes', 'sha256'}
                    and isinstance(row['image'], str) and row['image'].startswith('/')
                    and isinstance(row['source'], str) and isinstance(row['bytes'], int) and row['bytes'] >= 0
                    and re.fullmatch(r'[0-9a-f]{64}', row['sha256']) and row['image'] not in result,
                    'invalid_or_duplicate_source_binding')
            result[row['image']] = row
        return result
    before, after = indexed(base), indexed(current)
    require(NEW_MODULE not in before and NEW_MODULE in after and set(after) == set(before) | {NEW_MODULE}, 'unexpected_consumer_file_set')
    changed = {name for name, row in after.items() if name not in before or
               (row['bytes'], row['sha256']) != (before[name]['bytes'], before[name]['sha256'])}
    require(changed == ALLOWED, 'only_engine_and_new_native_identity_delta_admitted')
    require(all(after[name]['bytes'] > 0 for name in changed), 'nonempty_consumer_delta_required')
    return [after[name] for name in sorted(changed)]


def validate_base(inspected, original, proof, reference, canonical):
    admitted_reference(reference)
    _, env = canonical_tail(canonical)
    config_id = proof.get('canonical_config_id')
    require(proof.get('schema') in {'lovelies-native-image-id-binding-v1', 'lovelies-native-image-id-binding-v2', 'lovelies-image-id-binding-v1'}
            and proof.get('status') == 'IDENTITY_BINDING_VERIFIED' and isinstance(config_id, str)
            and FINALIZER.IMAGE.fullmatch(config_id) and proof.get('config_descriptor', {}).get('digest') == config_id
            and proof.get('platform') == {'os': 'linux', 'architecture': 'amd64'}, 'minimized_base_proof_changed')
    descriptor = proof.get('docker_platform_manifest_descriptor', {})
    require(descriptor.get('digest') == BASE_DIGEST and descriptor.get('mediaType') == 'application/vnd.oci.image.manifest.v1+json',
            'reviewed_base_platform_manifest_changed')
    layers = proof.get('rootfs_diff_ids')
    require(isinstance(layers, list) and layers and all(isinstance(row, str) and FINALIZER.IMAGE.fullmatch(row) for row in layers),
            'base_rootfs_proof_missing')
    require(isinstance(inspected, list) and len(inspected) == 1 and isinstance(original, list) and len(original) == 1,
            'one_base_inspection_required')
    for image in (original[0], inspected[0]):
        ids = {config_id, BASE_DIGEST, proof.get('docker_target_descriptor', {}).get('digest')}
        require(image.get('Id') in ids and image.get('Os') == 'linux' and image.get('Architecture') == 'amd64'
                and image.get('Variant') in (None, '') and image.get('RootFS') == {'Type': 'layers', 'Layers': layers}, 'base_identity_or_ordered_rootfs_changed')
        if image.get('Id') != config_id:
            selected = descriptor if image['Id'] == BASE_DIGEST else proof.get('docker_target_descriptor', {})
            require({k: (image.get('Descriptor') or {}).get(k) for k in ('mediaType', 'digest', 'size')} == selected, 'base_descriptor_changed')
    expected, actual = original[0].get('Config'), inspected[0].get('Config')
    require(isinstance(expected, dict) and isinstance(actual, dict)
            and all(actual.get(k) == v for k, v in expected.items())
            and all(v in (None, '', False, 0, [], {}) for k, v in actual.items() if k not in expected), 'base_execution_configuration_changed')
    require(actual.get('User') == 'lovelies' and actual.get('WorkingDir') == '/app' and actual.get('Cmd') == CMD
            and actual.get('Entrypoint') in (None, []) and actual.get('Env') == env, 'minimized_lovelies_service_required')
    return {'canonical_config_id': config_id, 'platform_manifest': descriptor, 'rootfs_diff_ids': layers,
            'execution_config_sha256': hashlib.sha256(json.dumps(actual, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def minimization_result(raw):
    result = json.loads(raw, object_pairs_hook=FINALIZER.unique)
    require(result.get('schema') == 'lovelies-ml-runtime-minimization-verification-v1' and result.get('status') == 'PASS'
            and result.get('removed_paths_verified') == 1347 and result.get('retained_paths_verified') == 161,
            'original_minimization_proof_required')
    return result


def validate_flattened_consumer(output, identity):
    require(isinstance(output, list) and len(output) == 1, 'one_consumer_inspection_required')
    image = output[0]
    require(isinstance(image, dict) and image.get('Id') == identity
            and image.get('Os') == 'linux' and image.get('Architecture') == 'amd64'
            and image.get('RootFS', {}).get('Type') == 'layers', 'flattened_consumer_required')
    layers = image['RootFS'].get('Layers')
    require(isinstance(layers, list) and len(layers) in (1, 2)
            and isinstance(layers[0], str) and FINALIZER.IMAGE.fullmatch(layers[0])
            and layers[0] != EMPTY_LAYER and (len(layers) == 1 or layers[1] == EMPTY_LAYER),
            'one_payload_with_optional_trailing_empty_layer_required')
    return layers


def register_client(owned):
    name = 'lovelies-consumer-' + uuid.uuid4().hex
    owned.append(name)
    return name


def source_inventory_command(owned, image):
    # Protected build notices are intentionally readable only by root. This
    # fixed, read-only provenance program does not start the inference service.
    return ['docker', 'run', '--rm', '--read-only', '--network=none', '--user=0:0', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--memory=768m', '--cpus=1', '--pids-limit=128',
            '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777', '--entrypoint=/app/.venv/bin/python',
            '--name', register_client(owned), '-i', image, '-B', '-c', SOURCE_CHECK]


def cleanup_absent(result, name):
    # A connection failure, denied operation or arbitrary text mentioning 404
    # must never stand in for the daemon's exact missing-container response.
    pattern = rb'(?:Error response from daemon: )?No such container: /?' + re.escape(name.encode()) + rb'\s*'
    return result.returncode == 1 and re.fullmatch(pattern, result.stderr, re.I) is not None


def finish_cleanup(owned, receipt, run, write, primary_failure):
    failures = []
    for name in owned:
        try:
            result = run(['docker', 'container', 'rm', '--force', name], 'cleanup_' + name,
                         timeout=30, allow_failure=True)
            require(result.returncode == 0 or cleanup_absent(result, name), 'owned_container_cleanup_failed')
        except Exception as error:
            failures.append({'name': name, 'error_type': type(error).__name__, 'error': str(error)})
    receipt['cleanup_failures'] = failures
    receipt['cleanup_status'] = 'failed' if failures else 'passed'
    if failures and not primary_failure:
        receipt['status'] = 'cleanup_failed'
    write()
    if failures and not primary_failure:
        raise RuntimeError('owned_container_cleanup_failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-image', required=True)
    parser.add_argument('--base-proof', type=Path, required=True)
    parser.add_argument('--bound-inspection', type=Path, required=True)
    parser.add_argument('--base-source-bindings', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--pull-base', action='store_true')
    args = parser.parse_args()
    admitted_reference(args.base_image)
    require(re.fullmatch(r'[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}', args.tag), 'explicit_new_consumer_tag_required')
    require(platform.system() == 'Linux' and platform.machine() in ('x86_64', 'AMD64'), 'native_linux_amd64_host_required')
    evidence = args.evidence.expanduser().resolve();evidence.mkdir(parents=True, exist_ok=False)
    receipt = {'schema': 'lovelies-private-face-consumer-delta-build-v1', 'status': 'running', 'commands': [],
               'native_components_changed': False, 'native_acceptance': False, 'final_image_accepted': False, 'deployment_performed': False}
    owned = []
    primary_failure = False
    def write():
        (evidence/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    def run(command, name, *, input=None, private=False, timeout=300, allow_failure=False):
        row = {'stage': name, 'command': command, 'timeout_seconds': timeout};receipt['commands'].append(row);write()
        start = time.monotonic()
        try:
            value = subprocess.run(command, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            row.update(status='timed_out', wall_seconds=time.monotonic()-start)
            if not private:
                for stream, value in [('stdout',error.stdout),('stderr',error.stderr)]:
                    if value:(evidence/(name+'.'+stream)).write_bytes(value)
            write();raise
        except OSError as error:
            row.update(status='spawn_failed', error_type=type(error).__name__, wall_seconds=time.monotonic()-start)
            write();raise
        row.update(exit_code=value.returncode, wall_seconds=time.monotonic()-start)
        if not private:
            for stream in ('stdout', 'stderr'):(evidence/(name+'.'+stream)).write_bytes(getattr(value, stream))
        write();require(allow_failure or value.returncode == 0, 'command_failed: '+name)
        return value
    try:
        input_rows = [{'source':str(path),'bytes':path.stat().st_size,'sha256':sha(path)} for path in
                      (args.base_proof,args.bound_inspection,args.base_source_bindings)]
        canonical = (CONTEXT/'Dockerfile').read_text();derived = delta_dockerfile(canonical, args.base_image)
        base = read_json(args.base_source_bindings);current = FINALIZER.source_bindings(CONTEXT);delta = source_delta(base, current)
        FINALIZER.verify_sources(current)
        proof, original = read_json(args.base_proof), read_json(args.bound_inspection)
        FINALIZER.verify_sources(input_rows)
        bound = proof.get('evidence', {}).get('docker_inspect', {})
        require(args.bound_inspection.stat().st_size == bound.get('bytes') and sha(args.bound_inspection) == bound.get('sha256'), 'bound_base_inspection_hash_changed')
        info = json.loads(run(['docker','info','--format','{{json .}}'], 'daemon', private=True).stdout)
        require(info.get('OSType') == 'linux' and info.get('Architecture') in ('amd64','x86_64'), 'native_amd64_daemon_required')
        backing = Path(info['DockerRootDir']).resolve(strict=True);receipt['storage_preflight'] = FINALIZER.check_storage(backing)
        tag = run(['docker','image','inspect',args.tag], 'new_tag', private=True, allow_failure=True)
        require(tag.returncode != 0 and re.search(rb'no such (?:image|object)', tag.stderr, re.I), 'tag_exists_or_inspection_failed')
        if args.pull_base:run(['docker','pull','--platform=linux/amd64',args.base_image], 'base_pull', timeout=900)
        inspected = json.loads(run(['docker','image','inspect',args.base_image], 'base_inspect', private=True).stdout)
        receipt['base'] = validate_base(inspected, original, proof, args.base_image, canonical)
        receipt['input_bindings'] = {name: {'bytes': path.stat().st_size, 'sha256': sha(path)} for name,path in [
            ('base_proof',args.base_proof),('bound_inspection',args.bound_inspection),('base_source_bindings',args.base_source_bindings)]}
        common = ['docker','run','--rm','--read-only','--network=none','--user=10001:10001','--cap-drop=ALL',
                  '--security-opt=no-new-privileges','--memory=768m','--cpus=1','--pids-limit=128',
                  '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777','--entrypoint=/app/.venv/bin/python']
        verify = ['-B',MIN_ROOT+'minimize-runtime.py','--verify','--manifest='+MIN_ROOT+'removal-plan.json','--receipt='+MIN_ROOT+'receipt.json']
        receipt['base_minimization'] = minimization_result(run(common+['--name',register_client(owned),args.base_image]+verify, 'base_minimization').stdout)
        run(source_inventory_command(owned, args.base_image),
            'base_sources', input=json.dumps(base).encode())
        context = evidence/'context';context.mkdir()
        provenance = {'schema':'lovelies-same-product-consumer-delta-v1','base':receipt['base'],
                      'base_source_bindings_sha256':sha(args.base_source_bindings),'canonical_dockerfile_sha256':sha(CONTEXT/'Dockerfile'),
                      'base_source_count':len(base),'current_source_count':len(current),
                      'admitted_delta':[{k:r[k] for k in ('image','bytes','sha256')} for r in delta],
                      'native_components_changed':False,'final_image_accepted':False}
        (context/'consumer-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
        (context/'Dockerfile').write_text(derived)
        for row in delta:shutil.copyfile(row['source'],context/Path(row['image']).name)
        require({p.name for p in context.iterdir()} == {'Dockerfile','consumer-provenance.json','engine.py','native_identity.py'}, 'unexpected_delta_context_file')
        context_rows = [{'source':str(p),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(context.iterdir())]
        FINALIZER.verify_sources(current);FINALIZER.verify_sources(context_rows);FINALIZER.verify_sources(input_rows)
        source_delta(base,FINALIZER.source_bindings(CONTEXT))
        receipt['storage_before_build'] = FINALIZER.check_storage(backing)
        run(['docker','build','--pull=false','--network=none','--platform=linux/amd64','--progress=plain','--tag',args.tag,
             '--iidfile',str(evidence/'consumer-image-id.txt'),'--file',str(context/'Dockerfile'),str(context)], 'consumer_delta_build',timeout=1800)
        FINALIZER.verify_sources(current);FINALIZER.verify_sources(context_rows);FINALIZER.verify_sources(input_rows)
        source_delta(base,FINALIZER.source_bindings(CONTEXT))
        identity = (evidence/'consumer-image-id.txt').read_text().strip()
        require(FINALIZER.IMAGE.fullmatch(identity) and identity not in {BASE_DIGEST,proof['canonical_config_id'],proof.get('producer_iid')}, 'distinct_consumer_identity_required')
        output = json.loads(run(['docker','image','inspect',args.tag], 'consumer_inspect',private=True).stdout)
        receipt['consumer_rootfs_diff_ids'] = validate_flattened_consumer(output, identity)
        receipt['consumer_minimization'] = minimization_result(run(common+['--name',register_client(owned),identity]+verify,'consumer_minimization').stdout)
        desired = current+[{'source':str(context/'consumer-provenance.json'),'image':DOC,
                           'bytes':(context/'consumer-provenance.json').stat().st_size,'sha256':sha(context/'consumer-provenance.json')}]
        run(source_inventory_command(owned, identity),
            'consumer_sources',input=json.dumps(desired).encode())
        FINALIZER.verify_sources(current);FINALIZER.verify_sources(context_rows);FINALIZER.verify_sources(input_rows)
        receipt.update(status='built_pending_qualification',image_id=identity,provenance=provenance,
                       derived_dockerfile_sha256=sha(context/'Dockerfile'),source_bindings=current)
    except Exception as error:
        primary_failure = True
        receipt.update(status='failed',error_type=type(error).__name__,error=str(error));raise
    finally:
        finish_cleanup(owned, receipt, run, write, primary_failure)


if __name__=='__main__':
    main()
