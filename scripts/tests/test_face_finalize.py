"""Offline finalizer admission/tail checks; no Docker, model or native build execution."""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('face_finalizer', Path(__file__).resolve().parents[1] / 'finish-face-container.py')
finalizer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(finalizer)


class FinalizerTests(unittest.TestCase):
    def setUp(self):
        self.config = 'sha256:' + 'a' * 64
        self.manifest = {'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': 'sha256:' + 'b' * 64, 'size': 234}
        self.reference = 'registry.example/private/consumer@' + self.manifest['digest']
        self.layers = ['sha256:' + 'c' * 64, 'sha256:' + 'd' * 64]
        self.proof = {'schema': 'lovelies-native-image-id-binding-v1', 'status': 'IDENTITY_BINDING_VERIFIED',
                      'canonical_config_id': self.config, 'config_descriptor': {'digest': self.config},
                      'platform': {'os': 'linux', 'architecture': 'amd64'},
                      'docker_platform_manifest_descriptor': self.manifest, 'rootfs_diff_ids': self.layers}
        self.inspection = [{'Id': self.config, 'Os': 'linux', 'Architecture': 'amd64',
                            'Config': {'User': 'root', 'Cmd': ['python'], 'Env': ['MODE=synthetic']},
                            'RootFS': {'Type': 'layers', 'Layers': list(self.layers)}}]
        self.original = deepcopy(self.inspection)

    def validate(self, value=None, proof=None, reference=None):
        return finalizer.validate_inspection(value or self.inspection, self.original,
                                            proof or self.proof, reference or self.reference, self.config)

    def test_config_and_manifest_inspection_admit_same_ordered_preimage(self):
        self.assertEqual(self.validate()['canonical_config_id'], self.config)
        self.inspection[0]['Id'] = self.manifest['digest']
        self.inspection[0]['Descriptor'] = dict(self.manifest)
        self.assertEqual(self.validate()['rootfs_diff_ids'], self.layers)
        self.assertNotIn('MODE=synthetic', json.dumps(self.validate()), 'receipt records config digest, not environment values')

    def test_wrong_image_execution_configuration_and_ordered_layers_are_denied(self):
        for change in [lambda x: x.update(Id='sha256:'+'e'*64), lambda x: x.update(Architecture='arm64'),
                       lambda x: x['RootFS']['Layers'].reverse(), lambda x: x['Config'].update(User='lovelies'),
                       lambda x: x['Config'].update(Cmd=['other']), lambda x: x['Config'].update(Env=['OTHER=setting']),
                       lambda x: x['Config'].update(Entrypoint=['unbound'])]:
            value = deepcopy(self.inspection);change(value[0])
            with self.subTest(value=value):
                with self.assertRaises(ValueError):self.validate(value)
        for ref in ['registry.example/private/consumer:latest', self.reference.replace('b'*64, 'e'*64)]:
            with self.assertRaises(ValueError):self.validate(reference=ref)
        proof = deepcopy(self.proof);proof['canonical_config_id'] = 'sha256:'+'e'*64
        with self.assertRaises(ValueError):self.validate(proof=proof)

    def test_tail_is_exact_canonical_suffix_with_only_reviewed_plan_overlay(self):
        source = (finalizer.CONTEXT/'Dockerfile').read_text()
        expected = source.split(finalizer.MARKER, 1)[1]
        result = finalizer.final_dockerfile(source, self.reference)
        prefix = 'FROM '+self.reference+' AS security-runtime\nCOPY reviewed-removal-plan.json '+finalizer.PLAN_DESTINATION+'\n'
        self.assertEqual(result, prefix+expected)
        self.assertEqual(result.count('\nFROM '), 1)
        self.assertNotIn('security-artifacts-built', result)
        self.assertEqual(result.split('FROM scratch AS final', 1)[1], source.split('FROM scratch AS final', 1)[1])
        for changed in [source.replace('verify-runtime --manifest=', 'skip-runtime --manifest='),
                        source.replace('minimize-runtime.py', 'different-minimizer.py'),
                        source+'\nFROM unrelated AS extra\n', source+'\nCOPY src /app/src\n', source+finalizer.MARKER]:
            with self.assertRaises(ValueError):finalizer.final_dockerfile(changed, self.reference)

    def test_reviewed_plan_bytes_and_baseline_cannot_be_substituted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'plan.json'
            plan = {'schema':'lovelies-ml-runtime-minimization-plan-v1', 'preparer_schema':'lovelies-runtime-minimization-preparer-v2',
                    'baseline_image':self.config, 'observed_runtime':{'image_id':self.config,'architecture':'x86_64'},
                    'service_entrypoint':['/app/.venv/bin/python','-m','lovelies_ml_face']}
            path.write_text(json.dumps(plan));expected = finalizer.sha(path)
            self.assertEqual(finalizer.validate_plan(path, expected, self.config), plan)
            path.write_text(json.dumps(plan)+' ')
            with self.assertRaises(ValueError):finalizer.validate_plan(path, expected, self.config)
            plan['baseline_image'] = 'sha256:'+'f'*64;path.write_text(json.dumps(plan))
            with self.assertRaises(ValueError):finalizer.validate_plan(path, finalizer.sha(path), self.config)
            path.write_text('{"schema":1,"schema":2}')
            with self.assertRaises(ValueError):finalizer.validate_plan(path, finalizer.sha(path), self.config)

    def test_source_change_after_preflight_is_detected_before_build(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'source.py';path.write_bytes(b'original source')
            rows = [{'source':str(path), 'bytes':path.stat().st_size,'sha256':finalizer.sha(path)}]
            finalizer.verify_sources(rows)
            path.write_bytes(b'changed source!')
            with self.assertRaises(ValueError):finalizer.verify_sources(rows)
            path.unlink();path.symlink_to('missing')
            with self.assertRaises(ValueError):finalizer.verify_sources(rows)

    def test_eight_gib_floor_has_no_cli_override(self):
        self.assertEqual(finalizer.MINIMUM_FREE_BYTES, 8*1024**3)
        with self.assertRaises(ValueError):finalizer.check_storage(Path('/'), 8*1024**3-1)
        self.assertEqual(finalizer.check_storage(Path('/'), 8*1024**3)['minimum_free_bytes'], 8*1024**3)
        source = Path(SPEC.origin).read_text()
        self.assertIn("'--network=none'", source)
        self.assertIn("'--pull=false'", source)
        self.assertIn("'native_linux_amd64_host_required'", source)
        self.assertNotIn("add_argument('--skip", source)
        self.assertNotIn("add_argument('--minimum-free", source)


if __name__ == '__main__':
    unittest.main()
