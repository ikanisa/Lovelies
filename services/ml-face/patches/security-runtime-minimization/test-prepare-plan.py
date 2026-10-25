"""Exact preimage/observation guards; synthetic JSON/temp files, no containers."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("candidate_preparer", BASE / "prepare-plan.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
IMAGE = "sha256:" + "a" * 64


def record(name, **extra):
    return dict(path=name, kind="file", bytes=4, sha256="b" * 64, **extra)


class CandidatePlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        self.advisories = self.root / "grype.json"
        self.identity = dict(image_id=IMAGE, python_version="3.13.17", pillow_version="13.0.0", architecture="x86_64")
        self.optional_paths = ["/usr/local/lib/python3.13/lib-dynload/" + name + ".cpython-313-x86_64-linux-gnu.so"
                               for name in ["_sqlite3", "readline", "_curses", "_curses_panel"]]
        self.font_paths = ["/app/.venv/lib/python3.13/site-packages/" + name for name in
                           ["PIL/_imagingft.cpython-313-x86_64-linux-gnu.so", "pillow.libs/libfreetype-x.so",
                            "pillow.libs/libharfbuzz-x.so", "pillow.libs/libpng16-x.so",
                            "pillow.libs/libbrotlidec-x.so", "pillow.libs/libbrotlicommon-x.so"]]
        libc = record("/usr/lib/x86_64-linux-gnu/libc.so.6")
        self.libmd = record("/usr/lib/x86_64-linux-gnu/libmd.so.0.1.0")
        roots = [record(path, resolved_dependencies=[]) for path in self.optional_paths + self.font_paths]
        roots += [record("/usr/local/bin/python3.13", resolved_dependencies=[libc["path"]]),
                  record("/usr/bin/dash", resolved_dependencies=[libc["path"]])]
        self.closure = dict(schema="lovelies-readonly-native-runtime-closure-v1", python="3.13.17 (synthetic)",
                            native_roots=roots, required_resolved_files=[libc, self.libmd], missing_dependencies=[],
                            packages=[dict(package="dash", version="1", source_package="dash", source_version="1",
                                           files=[record("/usr/bin/dash")])])
        self.optional = dict(schema="lovelies-targeted-optional-module-consumers-v2", service_module="lovelies_ml_face.app",
                             source_consumer_hits=[], service_import_with_optional_modules_denied=True,
                             optional_modules_loaded=[], optional_native_modules=[record(path) for path in self.optional_paths],
                             symlink_native_roots=[], login_log_metadata=[])
        self.font = dict(schema="lovelies-targeted-service-font-exclusion-v2", service_module="lovelies_ml_face.app",
                         service_font_consumer_hits=[], font_and_four_optional_modules_loaded=False,
                         actual_model_cases=[dict(format=fmt, status="no_faces", faces=0) for fmt in ["PNG", "JPEG", "WEBP"]])
        self.tools = [record(name, resolved_dependencies=[libc["path"], self.libmd["path"]])
                      for name in ["/usr/bin/dpkg-query", "/usr/bin/openssl"]]
        self.entrypoint = dict(module="lovelies_ml_face", file=record("/app/src/lovelies_ml_face/__main__.py"))
        self.scan = dict(source=dict(target=dict(imageID=IMAGE)), matches=[
            dict(vulnerability=dict(id="CVE-SYNTHETIC-ONE"), artifact=dict(name="dash", metadata=dict(sourceName="dash")))])
        self.commit()

    def commit(self):
        values = {"runtime-closure.json": self.closure, "optional-consumers.json": self.optional,
                  "retained-tools.json": self.tools, "retained-libmd.json": self.libmd,
                  "font-consumers.json": self.font, "service-entrypoint.json": self.entrypoint}
        for name, value in values.items():
            (self.evidence / name).write_text(json.dumps(value))
        for source, output in [("prepare-plan.py", "prepare-plan.executed.py"),
                               ("inspect-runtime.py", "inspect-runtime.executed.py")]:
            shutil.copyfile(BASE / source, self.evidence / output)
        bindings = {path.name: module.fingerprint(path) for path in self.evidence.iterdir()
                    if path.name != "observation.json"}
        (self.evidence / "observation.json").write_text(json.dumps(
            dict(schema=module.OBSERVATION_SCHEMA, runtime=self.identity, evidence=bindings)))
        self.advisories.write_text(json.dumps(self.scan))

    def prepare(self, **overrides):
        inputs = dict(image_id=IMAGE, python_version="3.13.17", pillow_version="13.0.0")
        inputs.update(overrides)
        return module.prepare(self.evidence, self.advisories, **inputs)

    def test_actual_advisory_set_no_constant_count_and_current_versions(self):
        plan = self.prepare()
        self.assertEqual(plan["observed_advisory_ids"], ["CVE-SYNTHETIC-ONE"])
        self.assertEqual(plan["baseline_image"], IMAGE)
        self.assertEqual({r["source_version"] for r in plan["removals"] if r["source_package"] == "cpython"}, {"3.13.17"})
        self.assertEqual({r["package_version"] for r in plan["removals"] if r["source_package"] == "pillow-font-closure"}, {"13.0.0"})
        self.assertFalse(plan["qualification"]["final_image_accepted"])

    def test_wrong_image_or_version_denied(self):
        for overrides in [dict(image_id="sha256:" + "c" * 64), dict(python_version="3.13.15"), dict(pillow_version="12.3.0")]:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.prepare(**overrides)

    def test_scan_for_other_image_denied(self):
        self.scan["source"]["target"]["imageID"] = "sha256:" + "d" * 64
        self.commit()
        with self.assertRaisesRegex(ValueError, "Advisory scan"):
            self.prepare()

    def test_stale_legacy_service_observation_denied(self):
        self.optional["service_module"] = "pictured_ml_face.main"
        self.commit()
        with self.assertRaisesRegex(ValueError, "Current Lovelies"):
            self.prepare()

    def test_missing_import_or_font_observation_denied(self):
        for component, key, value in [(self.optional, "service_import_with_optional_modules_denied", False),
                                       (self.optional, "optional_modules_loaded", ["sqlite3"]),
                                       (self.font, "font_and_four_optional_modules_loaded", True)]:
            original = copy.deepcopy(component[key])
            component[key] = value
            self.commit()
            with self.assertRaises(ValueError):
                self.prepare()
            component[key] = original

    def test_missing_or_changed_decoder_case_denied(self):
        self.font["actual_model_cases"][0]["faces"] = 1
        self.commit()
        with self.assertRaisesRegex(ValueError, "no-face"):
            self.prepare()

    def test_non_font_native_consumer_denied(self):
        self.closure["native_roots"].append(record("/usr/lib/unexpected.so", resolved_dependencies=[self.font_paths[1]]))
        self.commit()
        with self.assertRaisesRegex(ValueError, "Non-font"):
            self.prepare()

    def test_no_guessed_missing_native_hashes(self):
        del self.closure["native_roots"][0]["sha256"]
        self.commit()
        with self.assertRaisesRegex(ValueError, "size/hash"):
            self.prepare()

    def test_exact_four_optional_kinds_and_six_font_kinds_required(self):
        self.optional["optional_native_modules"][0]["path"] = self.optional_paths[1] + ".duplicate"
        self.commit()
        with self.assertRaisesRegex(ValueError, "Exact four"):
            self.prepare()

    def test_observation_payload_or_collector_drift_denied(self):
        for name in ["runtime-closure.json", "prepare-plan.executed.py"]:
            self.commit()
            path = self.evidence / name
            path.write_bytes(path.read_bytes() + b" ")
            with self.assertRaisesRegex(ValueError, "evidence drift"):
                self.prepare()

    def test_symlink_evidence_and_duplicate_keys_denied(self):
        path = self.evidence / "font-consumers.json"
        path.unlink()
        path.symlink_to(self.evidence / "optional-consumers.json")
        with self.assertRaises(ValueError):
            self.prepare()
        with self.assertRaises(ValueError):
            json.loads('{"x":1,"x":2}', object_pairs_hook=module.duplicate_safe)

    def test_output_never_overwrites_preserved_attempt(self):
        path = self.root / "new-plan.json"
        module.write_new(path, {"original": True})
        with self.assertRaises(FileExistsError):
            module.write_new(path, {"replacement": True})
        self.assertEqual(json.loads(path.read_text()), {"original": True})

    def test_verify_runtime_requires_actual_retained_hashes_before_removal(self):
        plan = self.prepare()
        runtime = self.root / "runtime"
        for row in plan["baseline_retained_native_files"]:
            path = runtime / row["path"].lstrip("/")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"actual-synthetic-runtime")
            row.update(module.observed_file(path), path=row["path"])
        manifest = self.root / "candidate.json"
        manifest.write_text(json.dumps(plan))
        with (mock.patch.object(module.platform, "python_version", return_value="3.13.17"),
              mock.patch.object(module.platform, "machine", return_value="x86_64"),
              mock.patch("importlib.metadata.version", return_value="13.0.0")):
            self.assertEqual(module.verify_runtime(manifest, root=runtime)["status"], "PREIMAGE_MATCH")
            path.write_bytes(b"drift")
            with self.assertRaisesRegex(ValueError, "payload changed"):
                module.verify_runtime(manifest, root=runtime)

    def test_prior_plan_and_helper_history_preserved(self):
        history = BASE / "history/3.13.15-pillow12.3.0"
        self.assertEqual((history / "removal-plan.json").read_bytes(), (BASE / "removal-plan.json").read_bytes())
        self.assertIn('len(open_ids) != 62', (history / "prepare-plan.py").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
