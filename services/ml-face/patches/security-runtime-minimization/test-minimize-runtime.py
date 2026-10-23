"""Focused deletion-boundary controls; synthetic temporary trees only."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("minimizer", Path(__file__).with_name("minimize-runtime.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.add("/app/src/pictured_ml_face/__main__.py", b"# test entrypoint")
        for name in ("/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ssl/certs/ca-certificates.crt", "/var/lib/dpkg/status"):
            self.add(name, b"synthetic-protected")
        self.add("/usr/lib/librequired.so", b"synthetic-required")
        self.add("/usr/bin/unneeded", b"synthetic-candidate")
        self.plan = {"schema": module.SCHEMA,
                     "entrypoint_requirement": ["/app/.venv/bin/python", "-m", "pictured_ml_face"],
                     "required_runtime_paths": ["/usr/lib/librequired.so"], "protected_prefixes": [],
                     "removals": [module.record(self.root / "usr/bin/unneeded", "/usr/bin/unneeded")]}

    def tearDown(self):
        self.temp.cleanup()

    def add(self, name, data):
        path = self.root / name.lstrip("/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def rejects(self, plan=None):
        with self.assertRaises((ValueError, FileNotFoundError)):
            module.apply(plan or self.plan, self.root)
        self.assertTrue((self.root / "usr/bin/unneeded").is_file())

    def test_apply_removes_exact_file_preserves_required_and_metadata(self):
        receipt = module.apply(self.plan, self.root)
        self.assertEqual(receipt["status"], "APPLIED")
        self.assertEqual(receipt["removed_file_count"], 1)
        self.assertFalse((self.root / "usr/bin/unneeded").exists())
        self.assertEqual((self.root / "var/lib/dpkg/status").read_bytes(), b"synthetic-protected")
        self.assertTrue((self.root / "usr/lib/librequired.so").is_file())

    def test_dry_run_does_not_remove(self):
        receipt = module.apply(self.plan, self.root, dry_run=True)
        self.assertEqual(receipt["status"], "DRY_RUN")
        self.assertTrue((self.root / "usr/bin/unneeded").is_file())

    def test_payload_hash_drift_rejected(self):
        self.plan["removals"][0]["sha256"] = "0" * 64
        self.rejects()

    def test_payload_size_drift_rejected(self):
        self.plan["removals"][0]["bytes"] += 1
        self.rejects()

    def test_all_candidates_preflight_before_any_deletion(self):
        self.plan["removals"].append({"path": "/usr/bin/missing", "kind": "file", "bytes": 0, "sha256": "0" * 64})
        self.rejects()

    def test_required_library_deletion_rejected(self):
        self.plan["removals"].append(module.record(self.root / "usr/lib/librequired.so", "/usr/lib/librequired.so"))
        self.rejects()

    def test_duplicate_candidate_rejected(self):
        self.plan["removals"].append(copy.deepcopy(self.plan["removals"][0]))
        self.rejects()

    def test_traversal_rejected(self):
        self.plan["removals"][0]["path"] = "/usr/bin/../bin/unneeded"
        self.rejects()

    def test_symbolic_ancestor_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "usr/foreign").symlink_to(outside, target_is_directory=True)
        self.plan["removals"][0]["path"] = "/usr/foreign/unneeded"
        self.rejects()

    def test_leaf_symlink_unlinked_without_target_deletion(self):
        alias = self.root / "usr/bin/alias"
        alias.symlink_to("../lib/librequired.so")
        self.plan["removals"].append(module.record(alias, "/usr/bin/alias"))
        receipt = module.apply(self.plan, self.root)
        self.assertEqual(receipt["removed_file_count"], 2)
        self.assertFalse(alias.is_symlink())
        self.assertEqual((self.root / "usr/lib/librequired.so").read_bytes(), b"synthetic-required")

    def test_symlink_target_drift_rejected(self):
        alias = self.root / "usr/bin/alias"
        alias.symlink_to("../lib/librequired.so")
        rec = module.record(alias, "/usr/bin/alias")
        rec["target"] = "different"
        self.plan["removals"].append(rec)
        self.rejects()

    def test_licence_document_deletion_rejected(self):
        p = self.add("/usr/share/doc/perl/copyright", b"copyright")
        self.plan["removals"].append(module.record(p, "/usr/share/doc/perl/copyright"))
        self.rejects()

    def test_account_file_deletion_rejected(self):
        self.plan["removals"].append(module.record(self.root / "etc/passwd", "/etc/passwd"))
        self.rejects()

    def test_missing_direct_entrypoint_rejected(self):
        (self.root / "app/src/pictured_ml_face/__main__.py").unlink()
        self.rejects()

    def test_missing_required_library_rejected(self):
        (self.root / "usr/lib/librequired.so").unlink()
        self.rejects()

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(ValueError):
            json.loads('{"schema":"one","schema":"two"}', object_pairs_hook=module.duplicate_safe)

    def applied(self):
        receipt = module.apply(self.plan, self.root)
        receipt["manifest_sha256"] = "a" * 64
        receipt["producer_sha256"] = "b" * 64
        return receipt

    def test_verify_exact_positive_readonly(self):
        receipt = self.applied()
        result = module.verify(self.plan, receipt, self.root, "a" * 64, "b" * 64)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["removed_paths_verified"], 1)

    def test_verify_rejects_reintroduced_payload(self):
        receipt = self.applied()
        self.add("/usr/bin/unneeded", b"synthetic-candidate")
        with self.assertRaises(ValueError):
            module.verify(self.plan, receipt, self.root, "a" * 64, "b" * 64)

    def test_verify_rejects_retained_runtime_drift(self):
        receipt = self.applied()
        self.add("/usr/lib/librequired.so", b"changed")
        with self.assertRaises(ValueError):
            module.verify(self.plan, receipt, self.root, "a" * 64, "b" * 64)

    def test_verify_rejects_dangling_native_alias(self):
        receipt = self.applied()
        (self.root / "usr/lib/x86_64-linux-gnu").mkdir()
        (self.root / "usr/lib/x86_64-linux-gnu/libbad.so.1").symlink_to("absent")
        with self.assertRaises(ValueError):
            module.verify(self.plan, receipt, self.root, "a" * 64, "b" * 64)

    def test_verify_rejects_plan_substitution(self):
        receipt = self.applied()
        with self.assertRaises(ValueError):
            module.verify(self.plan, receipt, self.root, "c" * 64, "b" * 64)

    def test_verify_rejects_helper_substitution(self):
        receipt = self.applied()
        with self.assertRaises(ValueError):
            module.verify(self.plan, receipt, self.root, "a" * 64, "c" * 64)

    def test_verify_rejects_missing_required_binding(self):
        receipt = self.applied()
        receipt["retained_runtime_files"] = []
        with self.assertRaises(ValueError):
            module.verify(self.plan, receipt, self.root, "a" * 64, "b" * 64)

    def test_verify_rejects_fabricated_candidate_evidence(self):
        receipt = self.applied()
        receipt["checked_candidates"][0]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            module.verify(self.plan, receipt, self.root, "a" * 64, "b" * 64)


if __name__ == "__main__":
    unittest.main(verbosity=2)
