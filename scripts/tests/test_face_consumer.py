"""Offline same-product consumer-delta admission; no Docker/native execution."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('face_consumer', Path(__file__).resolve().parents[1]/'build-face-consumer.py')
consumer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consumer)


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.canonical = (consumer.CONTEXT/'Dockerfile').read_text()
        self.reference = 'registry.example/private/lovelies-inference-native@'+consumer.BASE_DIGEST
        self.config = 'sha256:'+'a'*64
        self.layers = ['sha256:'+'b'*64,'sha256:'+'c'*64]
        self.descriptor = {'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':consumer.BASE_DIGEST,'size':234}
        self.proof = {'schema':'lovelies-native-image-id-binding-v2','status':'IDENTITY_BINDING_VERIFIED',
                      'canonical_config_id':self.config,'config_descriptor':{'digest':self.config},
                      'platform':{'os':'linux','architecture':'amd64'},'docker_platform_manifest_descriptor':self.descriptor,
                      'rootfs_diff_ids':list(self.layers)}
        _, env = consumer.canonical_tail(self.canonical)
        self.original = [{'Id':self.config,'Os':'linux','Architecture':'amd64','RootFS':{'Type':'layers','Layers':list(self.layers)},
                          'Config':{'User':'lovelies','WorkingDir':'/app','Cmd':consumer.CMD,'Env':env,'Entrypoint':None}}]

    def validate(self, image=None, proof=None, reference=None):
        return consumer.validate_base(image or deepcopy(self.original),self.original,proof or self.proof,
                                      reference or self.reference,self.canonical)

    def sources(self):
        names = ['/app/src/lovelies_ml_face/engine.py','/app/models/model-manifest.json','/app/uv.lock',
                 '/app/src/lovelies_ml_face/__main__.py']
        names += ['/app/src/fixtures/file_'+str(i)+'.py' for i in range(consumer.BASE_SOURCE_COUNT-len(names))]
        base = [{'source':'/owned/source/'+str(i),'image':name,'bytes':1,'sha256':'a'*64} for i,name in enumerate(names)]
        base[-1]['bytes']=0
        current=deepcopy(base);current[0].update(bytes=2,sha256='b'*64)
        current.append({'source':'/owned/native_identity.py','image':consumer.NEW_MODULE,'bytes':20,'sha256':'c'*64})
        return base,current

    def test_exact_minimized_base_admits_config_or_bound_platform_identity(self):
        value=self.validate()
        self.assertEqual(value['canonical_config_id'],self.config)
        self.assertNotIn('SSL_CERT_FILE=',json.dumps(value),'environment values are not emitted')
        image=deepcopy(self.original);image[0].update(Id=consumer.BASE_DIGEST,Descriptor=self.descriptor)
        self.assertEqual(self.validate(image)['rootfs_diff_ids'],self.layers)

    def test_generic_base_tampered_rootfs_and_execution_authority_are_denied(self):
        for reference in ['registry.example/private/openface@'+consumer.BASE_DIGEST,
                          self.reference.replace(consumer.BASE_DIGEST,'sha256:'+'d'*64),
                          'registry.example/private/lovelies-inference-native:latest']:
            with self.subTest(reference=reference):
                with self.assertRaises(ValueError):self.validate(reference=reference)
        for mutate in [lambda i:i.update(Architecture='arm64'),lambda i:i['RootFS']['Layers'].reverse(),
                       lambda i:i['Config'].update(User='root'),lambda i:i['Config'].update(Cmd=['other']),
                       lambda i:i['Config'].update(Env=['OTHER=value']),lambda i:i['Config'].update(Entrypoint=['sh'])]:
            image=deepcopy(self.original);mutate(image[0])
            with self.assertRaises(ValueError):self.validate(image)
        proof=deepcopy(self.proof);proof['canonical_config_id']='sha256:'+'f'*64
        with self.assertRaises(ValueError):self.validate(proof=proof)

    def test_only_the_new_identity_module_and_modified_engine_are_admitted(self):
        base,current=self.sources()
        self.assertEqual({r['image'] for r in consumer.source_delta(base,current)},consumer.ALLOWED)
        for target in ['/app/models/model-manifest.json','/app/uv.lock','/app/src/lovelies_ml_face/__main__.py']:
            changed=deepcopy(current);next(r for r in changed if r['image']==target)['sha256']='d'*64
            with self.subTest(target=target):
                with self.assertRaises(ValueError):consumer.source_delta(base,changed)
        for changed in [current[:-1],current+[dict(current[-1])],current+[{'source':'/owned/extra','image':'/app/src/other.py','bytes':1,'sha256':'e'*64}]]:
            with self.assertRaises(ValueError):consumer.source_delta(base,changed)
        unchanged=deepcopy(current);unchanged[0]=deepcopy(base[0])
        with self.assertRaises(ValueError):consumer.source_delta(base,unchanged)

    def test_tail_flattens_again_with_only_three_explicit_root_owned_copies(self):
        result=consumer.delta_dockerfile(self.canonical,self.reference)
        self.assertTrue(result.startswith('FROM '+self.reference+' AS consumer\n'))
        self.assertEqual(result.count('COPY --chown=0:0'),3)
        self.assertIn('FROM scratch AS final\nCOPY --from=consumer / /\n',result)
        self.assertNotIn('\nRUN ',result)
        self.assertEqual(result.split('COPY --from=consumer / /\n',1)[1],consumer.canonical_tail(self.canonical)[0])
        for source in [self.canonical+'\nRUN sh -c true\n',self.canonical+'\nCOPY extra /app/\n',
                       self.canonical.replace('USER lovelies\nCMD','USER root\nCMD')]:
            with self.assertRaises(ValueError):consumer.delta_dockerfile(source,self.reference)

    def test_source_race_and_original_eight_gib_storage_floor_remain_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'engine.py';path.write_bytes(b'first')
            rows=[{'source':str(path),'bytes':5,'sha256':consumer.sha(path)}]
            consumer.FINALIZER.verify_sources(rows)
            path.write_bytes(b'later')
            with self.assertRaises(ValueError):consumer.FINALIZER.verify_sources(rows)
            path.unlink();path.symlink_to('missing')
            with self.assertRaises(ValueError):consumer.FINALIZER.verify_sources(rows)
        with self.assertRaises(ValueError):consumer.FINALIZER.check_storage(Path('/'),8*1024**3-1)
        self.assertEqual(consumer.FINALIZER.MINIMUM_FREE_BYTES,8*1024**3)

    def test_provenance_copy_reuses_the_existing_build_notice_directory(self):
        existing_notice = str(Path(consumer.DOC).parent / 'Dockerfile')
        self.assertIn('COPY Dockerfile ' + existing_notice + '\n', self.canonical)
        self.assertEqual(Path(consumer.DOC).name, 'consumer-delta-provenance.json')
        result = consumer.delta_dockerfile(self.canonical, self.reference)
        self.assertIn('COPY --chown=0:0 --chmod=0444 consumer-provenance.json ' + consumer.DOC + '\n', result)
        self.assertNotIn('/lovelies-consumer-delta/', result)

    def test_original_finite_minimization_counts_cannot_be_replaced_by_a_delta_pass(self):
        value={'schema':'lovelies-ml-runtime-minimization-verification-v1','status':'PASS',
               'removed_paths_verified':1347,'retained_paths_verified':161}
        self.assertEqual(consumer.minimization_result(json.dumps(value)),value)
        for changed in [{**value,'status':'SKIP'},{**value,'removed_paths_verified':1346},{**value,'retained_paths_verified':160}]:
            with self.assertRaises(ValueError):consumer.minimization_result(json.dumps(changed))
        source=Path(SPEC.origin).read_text()
        for fragment in ["'--pull=false'","'--network=none'","'native_linux_amd64_host_required'",'FINALIZER.SOURCE_CHECK']:
            self.assertIn(fragment,source)
        self.assertNotIn("add_argument('--skip",source)
        self.assertNotIn("add_argument('--minimum-free",source)

    def test_only_one_payload_and_optional_last_canonical_empty_layer_are_admitted(self):
        payload = 'sha256:' + 'd' * 64
        image = {'Id': self.config, 'Os': 'linux', 'Architecture': 'amd64',
                 'RootFS': {'Type': 'layers', 'Layers': [payload]}}
        self.assertEqual(consumer.validate_flattened_consumer([image], self.config), [payload])
        image['RootFS']['Layers'] = [payload, consumer.EMPTY_LAYER]
        self.assertEqual(consumer.validate_flattened_consumer([image], self.config), [payload, consumer.EMPTY_LAYER])
        for layers in [[], [consumer.EMPTY_LAYER], [consumer.EMPTY_LAYER, payload],
                       [payload, 'sha256:' + 'e' * 64], [payload, consumer.EMPTY_LAYER, consumer.EMPTY_LAYER],
                       ['not-a-diff-id'], [payload, None]]:
            with self.subTest(layers=layers):
                image['RootFS']['Layers'] = layers
                with self.assertRaises(ValueError):consumer.validate_flattened_consumer([image], self.config)
        image['RootFS']['Layers'] = [payload]
        image['Id'] = 'sha256:' + 'f' * 64
        with self.assertRaises(ValueError):consumer.validate_flattened_consumer([image], self.config)

    def test_cleanup_tracks_unique_clients_before_launch_and_accepts_only_exact_absence(self):
        owned = []
        first, second = consumer.register_client(owned), consumer.register_client(owned)
        self.assertEqual(owned, [first, second])
        self.assertNotEqual(first, second)
        calls = []
        def run(command, stage, **options):
            calls.append((command, stage, options))
            name = command[-1]
            return subprocess.CompletedProcess(command, 0 if name == first else 1, stdout=b'',
                stderr=b'' if name == first else ('Error response from daemon: No such container: ' + name + '\n').encode())
        writes = []
        receipt = {'status': 'built_pending_qualification'}
        consumer.finish_cleanup(owned, receipt, run, lambda:writes.append(deepcopy(receipt)), False)
        self.assertEqual(receipt['cleanup_status'], 'passed')
        self.assertEqual(receipt['cleanup_failures'], [])
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(writes), 1)
        for command, stage, options in calls:
            self.assertEqual(command, ['docker', 'container', 'rm', '--force', command[-1]])
            self.assertEqual(options, {'timeout': 30, 'allow_failure': True})
        for code, stderr in [(125, b'404'), (1, b'HTTP 404'), (1, b'permission denied'),
                             (1, ('No such container: ' + first + '-other').encode()),
                             (1, ('daemon unreachable\nNo such container: ' + first).encode())]:
            self.assertFalse(consumer.cleanup_absent(subprocess.CompletedProcess([], code, stderr=stderr), first))

    def test_cleanup_timeout_and_daemon_failure_do_not_replace_the_primary_failure(self):
        owned = [consumer.register_client([]), consumer.register_client([])]
        def run(command, stage, **options):
            if command[-1] == owned[0]:raise subprocess.TimeoutExpired(command, options['timeout'])
            return subprocess.CompletedProcess(command, 1, stdout=b'', stderr=b'permission denied')
        receipt = {'status': 'failed', 'error_type': 'ValueError', 'error': 'original_source_failure'}
        consumer.finish_cleanup(owned, receipt, run, lambda:None, True)
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['error'], 'original_source_failure')
        self.assertEqual(receipt['cleanup_status'], 'failed')
        self.assertEqual([row['error_type'] for row in receipt['cleanup_failures']], ['TimeoutExpired', 'ValueError'])
        receipt = {'status': 'built_pending_qualification'}
        with self.assertRaisesRegex(RuntimeError, 'owned_container_cleanup_failed'):
            consumer.finish_cleanup(owned, receipt, run, lambda:None, False)
        self.assertEqual(receipt['status'], 'cleanup_failed')

    def test_protected_source_inventory_alone_uses_root_with_unchanged_readonly_bounds(self):
        owned = []
        command = consumer.source_inventory_command(owned, self.config)
        self.assertEqual(len(owned), 1)
        self.assertEqual(command[command.index('--name') + 1], owned[0])
        self.assertEqual(command[-4:], [self.config, '-B', '-c', consumer.SOURCE_CHECK])
        self.assertEqual([arg for arg in command if arg.startswith('--user=')], ['--user=0:0'])
        for flag in ['--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                     '--memory=768m', '--cpus=1', '--pids-limit=128',
                     '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777']:
            self.assertIn(flag, command)
        source = Path(SPEC.origin).read_text()
        self.assertEqual(source.count('run(source_inventory_command(owned,'), 2)
        self.assertIn("'--user=10001:10001'", source)
        self.assertIn("actual.get('User') == 'lovelies'", source)


if __name__=='__main__':
    unittest.main()
