"""Offline OCI handoff identity checks; no Docker/build/native execution."""
from copy import deepcopy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("face_container_producer", Path(__file__).resolve().parents[1] / "build-face-container.py")
producer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(producer)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


class InputArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.archive = self.root / "inputs.tar.gz"
        self.manifest = self.root / "inputs-manifest.json"

    def fixture(self, *, architecture="amd64", wrong_diff=False, media="application/vnd.oci.image.layer.v1.tar",
                bad_config=False, bad_size=False, corrupt_blob=False, legacy_mismatch=False,
                multiple=False, extra_members=()):
        layers = [b"first synthetic uncompressed layer", b"second synthetic uncompressed layer"]
        ids = [digest(value) for value in layers]
        config = {"os": "linux", "architecture": architecture,
                  "rootfs": {"type": "layers", "diff_ids": list(reversed(ids)) if wrong_diff else ids},
                  "config": {"Env": ["MODE=engineering-fixture"], "Cmd": ["python3"], "WorkingDir": "/app"}}
        config_bytes = encoded(config)
        self.config_id = digest(config_bytes)
        manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                               "digest": "sha256:" + "f" * 64 if bad_config else self.config_id,
                               "size": len(config_bytes)},
                    "layers": [{"mediaType": media, "digest": d, "size": len(value)} for d, value in zip(ids, layers)]}
        manifest_bytes = encoded(manifest)
        self.descriptor = {"mediaType": manifest["mediaType"], "digest": digest(manifest_bytes),
                           "size": len(manifest_bytes) + int(bad_size)}
        index = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
                 "manifests": [self.descriptor] * (2 if multiple else 1)}
        layer_paths = ["blobs/sha256/" + d[7:] for d in ids]
        members = [("oci-layout", encoded({"imageLayoutVersion": "1.0.0"})), ("index.json", encoded(index)),
                   ("blobs/sha256/" + self.descriptor["digest"][7:], manifest_bytes),
                   ("blobs/sha256/" + self.config_id[7:], config_bytes),
                   ("manifest.json", encoded([{"Config": "blobs/sha256/" + self.config_id[7:],
                                                "Layers": list(reversed(layer_paths)) if legacy_mismatch else layer_paths}]))]
        members += list(zip(layer_paths, [layers[0] + b"changed" if corrupt_blob else layers[0], layers[1]]))
        members += list(extra_members)
        with gzip.GzipFile(filename=str(self.archive), mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as archive:
                for name, value in members:
                    member = tarfile.TarInfo(name)
                    member.size = len(value)
                    archive.addfile(member, io.BytesIO(value))
        receipt = {"image_id": self.config_id, "archive": producer.fingerprint(self.archive), "native_acceptance": False}
        self.manifest.write_text(json.dumps(receipt))
        return receipt

    def proof(self):
        return producer.verify_inputs_archive(self.archive, self.manifest, self.config_id)

    def inspection(self, proof, classic=False):
        value = {"Id": proof["canonical_config_id"] if classic else proof["manifest_descriptor"]["digest"],
                 "Architecture": "amd64", "Os": "linux", "Config": deepcopy(proof["config"]),
                 "RootFS": {"Type": "layers", "Layers": list(proof["rootfs_diff_ids"])}}
        if not classic:
            value["Descriptor"] = dict(proof["manifest_descriptor"])
        return [value]

    def test_archive_proves_distinct_config_manifest_and_ordered_layers(self):
        receipt = self.fixture()
        proof = self.proof()
        self.assertEqual(proof["archive"]["sha256"], receipt["archive"]["sha256"])
        self.assertEqual(proof["config_descriptor"]["digest"], self.config_id)
        self.assertEqual(proof["manifest_descriptor"], self.descriptor)
        self.assertNotEqual(self.config_id, proof["manifest_descriptor"]["digest"])
        self.assertEqual(proof["rootfs_diff_ids"], [r["digest"] for r in proof["layer_descriptors"]])
        self.assertFalse((self.root / "blobs").exists(), "proof never extracts archive members")

    def test_original_archive_size_checksum_and_canonical_identity_are_required(self):
        for field, wrong in [("bytes", 1), ("sha256", "0" * 64)]:
            with self.subTest(field=field):
                receipt = self.fixture()
                receipt["archive"][field] = wrong
                self.manifest.write_text(json.dumps(receipt))
                with self.assertRaises(ValueError):
                    self.proof()
        self.fixture()
        with self.assertRaises(ValueError):
            producer.verify_inputs_archive(self.archive, self.manifest, "sha256:" + "0" * 64)

    def test_content_descriptor_rootfs_and_legacy_graph_mutations_are_denied(self):
        for change in [dict(bad_config=True), dict(bad_size=True), dict(corrupt_blob=True), dict(wrong_diff=True),
                       dict(legacy_mismatch=True), dict(multiple=True), dict(architecture="arm64"),
                       dict(media="application/vnd.oci.image.layer.v1.tar+gzip")]:
            with self.subTest(change=change):
                self.fixture(**change)
                with self.assertRaises(ValueError):
                    self.proof()

    def test_duplicate_and_escaping_members_are_denied(self):
        for name in ["index.json", "../escape", "/absolute", "nested/../escape"]:
            with self.subTest(name=name):
                self.fixture(extra_members=[(name, b"untrusted")])
                with self.assertRaises(ValueError):
                    self.proof()

    def test_actual_inspection_accepts_only_proven_classic_or_manifest_identity(self):
        self.fixture()
        proof = self.proof()
        for classic in [True, False]:
            actual = self.inspection(proof, classic)
            if classic:
                actual[0]["Config"].update(User="", Entrypoint=None, Labels={})
            self.assertEqual(producer.verify_inputs_inspection(actual, proof), actual[0]["Id"])
        for change in [lambda x: x.update(Id="sha256:" + "0" * 64), lambda x: x.pop("Descriptor"),
                       lambda x: x["Descriptor"].update(size=1), lambda x: x.update(Architecture="arm64"),
                       lambda x: x["RootFS"]["Layers"].reverse(), lambda x: x["Config"].update(Cmd=["other"]),
                       lambda x: x["Config"].update(Entrypoint=["unexpected"]), lambda x: x.update(Variant="v2")]:
            with self.subTest(change=change):
                actual = self.inspection(proof)
                change(actual[0])
                with self.assertRaises(ValueError):
                    producer.verify_inputs_inspection(actual, proof)

    def test_missing_config_address_uses_only_exact_manifest_reference(self):
        self.fixture()
        proof = self.proof()
        calls = []

        def run(arguments, name, capture=False, allow_failure=False):
            calls.append((arguments, allow_failure))
            return None if allow_failure else json.dumps(self.inspection(proof))

        self.assertEqual(producer.resolve_inputs_archive(run, proof), self.descriptor["digest"])
        self.assertEqual(calls, [(["image", "inspect", self.config_id], True),
                                 (["image", "inspect", self.descriptor["digest"]], False)])

    def test_successful_but_wrong_config_inspection_cannot_trigger_fallback(self):
        self.fixture()
        proof, calls = self.proof(), []

        def run(arguments, name, capture=False, allow_failure=False):
            calls.append(arguments)
            actual = self.inspection(proof)
            actual[0]["Config"]["WorkingDir"] = "/wrong"
            return json.dumps(actual)

        with self.assertRaises(ValueError):
            producer.resolve_inputs_archive(run, proof)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
