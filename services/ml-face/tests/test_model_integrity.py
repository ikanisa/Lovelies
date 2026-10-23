"""Real filesystem/JSON integrity tests; synthetic artifacts are NOT ONNX models.

Adapter checks execute extracted production class/health declarations with
controlled runtime constructors. They do not import codecs, start FastAPI, or
validate OpenCV inference. All remaining tests import the real integrity module.
"""

from __future__ import annotations

import ast
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from pydantic import ValidationError
import pytest

from pictured_ml_face import model_integrity as integrity
from pictured_ml_face.models import ModelManifest
from pictured_ml_face.detection_strategy import REFERENCE_PROFILE, validate_profile
from pictured_ml_face.evaluation_policy import validate_evaluation_report
from pictured_ml_face.evaluation_contract import REPORT_LIMIT, sha256
from evaluation_test_fixtures import approved_evaluation_report
from pictured_ml_face.vector_matching import CosineVectorMatcher, ThresholdDecisionEngine

ROOT = Path(__file__).parents[1]
SOURCE = ROOT / "src/pictured_ml_face"


def registry():
    return {
        "active_model_version": "synthetic-v1",
        "models": [
            {
                "version": "synthetic-v1",
                "runtime": "opencv-dnn",
                "license_metadata": {"spdx": "MIT"},
                "checksum_sha256": "a" * 64,
            }
        ],
        "blocked_models": [],
    }


def artifacts(tmp_path):
    result = {}
    for name in ("detector", "recognizer"):
        path = tmp_path / f"{name}.synthetic"
        data = f"not a real recognition model: {name}".encode()
        path.write_bytes(data)
        result[f"{name}_path"] = path.name
        result[f"{name}_sha256"] = hashlib.sha256(data).hexdigest()
    return result


def report_file(tmp_path, data=b'{"approval":{"status":"pending"}}', suffix=""):
    path = tmp_path / "report.json"
    path.write_bytes(data)
    Path(f"{path}.sha256").write_text(hashlib.sha256(data).hexdigest() + suffix + "\n")
    return path


def adapter_class(source=SOURCE):
    """Original complete class declaration; no fake import of the image pipeline."""
    tree = ast.parse((source / "pipeline.py").read_text())
    declaration = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "FacePipeline"
    )
    imports = ast.parse("from __future__ import annotations").body
    calls = []

    def component(path):
        calls.append(str(path))
        return SimpleNamespace(version="synthetic-runtime-constructor")

    namespace = {
        "REPORT_LIMIT": REPORT_LIMIT,
        "REFERENCE_PROFILE": REFERENCE_PROFILE,
        "validate_profile": validate_profile,
        "validate_evaluation_report": validate_evaluation_report,
        "sha256": sha256,
        "load_verified_evaluation_bytes": integrity.load_verified_evaluation_bytes,
        "Path": Path,
        "os": os,
        "json": json,
        "math": math,
        "hashlib": hashlib,
        "ModelManifest": ModelManifest,
        "ValidationError": ValidationError,
        "ModelPolicyError": integrity.ModelPolicyError,
        "load_manifest_object": integrity.load_manifest_object,
        "select_active_model": integrity.select_active_model,
        "verified_model_paths": integrity.verified_model_paths,
        "load_verified_evaluation": integrity.load_verified_evaluation,
        "parse_json_object": integrity.parse_json_object,
        "read_bounded_file": integrity.read_bounded_file,
        "MAX_EVALUATION_BYTES": integrity.MAX_EVALUATION_BYTES,
        "PROHIBITED_CATEGORIES": ["emotion", "age", "gender", "ethnicity", "demographic"],
        "PROCESSING_CONTRACT_VERSION": "canonical-upright-aligned-pixels-v2",
        "CosineVectorMatcher": CosineVectorMatcher,
        "ThresholdDecisionEngine": ThresholdDecisionEngine,
        "OpenCvYuNetDetector": component,
        "OpenCvSFaceAligner": component,
        "OpenCvSFaceEmbeddingModel": component,
        "OpenCvQualityScorer": lambda: SimpleNamespace(version="synthetic-quality"),
    }
    exec(
        compile(
            ast.Module(body=imports + [declaration], type_ignores=[]),
            "<extracted FacePipeline declaration>",
            "exec",
        ),
        namespace,
    )
    return namespace["FacePipeline"], calls


@pytest.mark.parametrize(
    "raw",
    [
        b'{"x":1,"x":2}',
        b'{"x":{"a":1,"a":2}}',
        b'{"x":NaN}',
        b'{"x":Infinity}',
        b'{"x":-Infinity}',
        b'{"x":1e9999}',
        b"{invalid",
        b"\xff",
        b"[]",
        b"null",
        b"1",
        b'"secret"',
    ],
)
def test_json_rejects_ambiguous_nonfinite_invalid_and_scalar_input(raw):
    with pytest.raises(integrity.ModelPolicyError):
        integrity.parse_json_object(raw, "Test policy")


def test_valid_json_preserves_finite_types():
    assert integrity.parse_json_object(b'{"a":1,"b":0.5,"c":true}', "Test policy") == {
        "a": 1,
        "b": 0.5,
        "c": True,
    }


def test_deep_json_reports_controlled_error_not_parser_text():
    raw = b'{"private-value":' + b"[" * 2000 + b"0" + b"]" * 2000 + b"}"
    with pytest.raises(integrity.ModelPolicyError) as error:
        integrity.parse_json_object(raw, "Test policy")
    assert "private-value" not in str(error.value)
    assert error.value.__suppress_context__


def test_manifest_is_read_with_real_byte_bound(tmp_path, monkeypatch):
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(registry()))
    assert integrity.load_manifest_object(path) == registry()
    monkeypatch.setattr(integrity, "MAX_MANIFEST_BYTES", 3)
    with pytest.raises(integrity.ModelPolicyError):
        integrity.load_manifest_object(path)


@pytest.mark.parametrize("kind", ["absent", "empty", "directory", "symlink", "fifo"])
def test_policy_file_must_be_nonempty_regular_and_not_symlink(tmp_path, kind):
    path = tmp_path / "policy.json"
    if kind == "empty":
        path.touch()
    if kind == "directory":
        path.mkdir()
    if kind == "symlink":
        target = tmp_path / "real"
        target.write_bytes(b"{}")
        path.symlink_to(target)
    if kind == "fifo":
        if not hasattr(os, "mkfifo"):
            pytest.skip("FIFO unsupported")
        os.mkfifo(path)
    with pytest.raises(integrity.ModelPolicyError):
        integrity.load_manifest_object(path)


@pytest.mark.parametrize("change", ["replace", "rewrite", "unlink"])
def test_file_change_during_verification_is_rejected(tmp_path, change):
    path = tmp_path / "data"
    path.write_bytes(b"abc")
    with pytest.raises(integrity.ModelPolicyError):
        with integrity._regular_file(path, 10, "Test file") as stream:
            assert stream.read() == b"abc"
            if change == "replace":
                other = tmp_path / "other"
                other.write_bytes(b"abc")
                other.replace(path)
            elif change == "rewrite":
                path.write_bytes(b"abcdef")
            else:
                path.unlink()


def test_checked_in_registry_remains_selectable():
    manifest = integrity.load_manifest_object(ROOT / "models/model-manifest.json")
    assert integrity.select_active_model(manifest)["version"] == "opencv-yunet-sface-2021dec-v1"


@pytest.mark.parametrize(
    "field,value",
    [
        ("active_model_version", ""),
        ("active_model_version", None),
        ("active_model_version", " synthetic-v1"),
        ("active_model_version", "x" * 129),
        ("models", []),
        ("models", {}),
        ("models", [None]),
        ("blocked_models", None),
        ("blocked_models", [{}]),
        ("blocked_models", [{"version": False}]),
    ],
)
def test_malformed_registry_rejected(field, value):
    manifest = registry()
    manifest[field] = value
    with pytest.raises(integrity.ModelPolicyError):
        integrity.select_active_model(manifest)


@pytest.mark.parametrize("active_duplicate", [True, False])
def test_duplicate_model_versions_do_not_choose_by_order(active_duplicate):
    manifest = registry()
    duplicate = deepcopy(manifest["models"][0])
    if not active_duplicate:
        duplicate["version"] = "inactive"
        manifest["models"].append(deepcopy(duplicate))
    manifest["models"].append(duplicate)
    with pytest.raises(integrity.ModelPolicyError, match="duplicate"):
        integrity.select_active_model(manifest)


def test_active_blocklist_is_enforced_and_other_blocked_version_allowed():
    manifest = registry()
    manifest["blocked_models"] = [{"version": "inactive", "reason": "synthetic"}]
    assert integrity.select_active_model(manifest)["version"] == "synthetic-v1"
    manifest["blocked_models"][0]["version"] = "synthetic-v1"
    with pytest.raises(integrity.ModelPolicyError, match="blocked"):
        integrity.select_active_model(manifest)


def test_absent_active_version_rejected():
    manifest = registry()
    manifest["active_model_version"] = "missing"
    with pytest.raises(integrity.ModelPolicyError, match="not present"):
        integrity.select_active_model(manifest)


@pytest.mark.parametrize("collection", ["models", "blocked_models"])
def test_registry_count_is_bounded(collection):
    manifest = registry()
    manifest[collection] = [{"version": str(i)} for i in range(129)]
    with pytest.raises(integrity.ModelPolicyError):
        integrity.select_active_model(manifest)


def test_both_artifact_paths_return_after_actual_sha256_check(tmp_path):
    settings = artifacts(tmp_path)
    assert integrity.verified_model_paths(settings, lambda p: tmp_path / p) == {
        name: tmp_path / settings[name] for name in ("detector_path", "recognizer_path")
    }


@pytest.mark.parametrize("name", ["detector", "recognizer"])
@pytest.mark.parametrize("suffix", ["path", "sha256"])
def test_missing_artifact_field_is_not_optional(tmp_path, name, suffix):
    settings = artifacts(tmp_path)
    settings.pop(f"{name}_{suffix}")
    calls = []
    with pytest.raises(integrity.ModelPolicyError):
        integrity.verified_model_paths(settings, lambda p: calls.append(p))
    assert calls == []  # Validate the complete pair before opening either artifact.


@pytest.mark.parametrize("value", [None, "", True, "a" * 63, "g" * 64, " a" * 32, ["a" * 64]])
def test_invalid_checksum_rejected(tmp_path, value):
    settings = artifacts(tmp_path)
    settings["recognizer_sha256"] = value
    with pytest.raises(integrity.ModelPolicyError):
        integrity.verified_model_paths(settings, lambda p: tmp_path / p)


def test_uppercase_hash_and_explicit_absolute_paths_supported(tmp_path):
    settings = artifacts(tmp_path)
    for key in ("detector", "recognizer"):
        settings[key + "_path"] = str(tmp_path / settings[key + "_path"])
        settings[key + "_sha256"] = settings[key + "_sha256"].upper()
    assert len(integrity.verified_model_paths(settings, Path)) == 2


@pytest.mark.parametrize("name", ["detector", "recognizer"])
def test_each_artifact_mismatch_blocks_result(tmp_path, name):
    settings = artifacts(tmp_path)
    (tmp_path / settings[name + "_path"]).write_bytes(b"changed")
    with pytest.raises(integrity.ModelPolicyError, match="hash mismatch"):
        integrity.verified_model_paths(settings, lambda p: tmp_path / p)


@pytest.mark.parametrize("kind", ["empty", "directory", "absent", "symlink", "oversize"])
def test_invalid_model_file_is_not_verified(tmp_path, monkeypatch, kind):
    settings = artifacts(tmp_path)
    path = tmp_path / settings["recognizer_path"]
    path.unlink()
    if kind == "empty":
        path.touch()
    if kind == "directory":
        path.mkdir()
    if kind == "symlink":
        path.symlink_to(tmp_path / settings["detector_path"])
    if kind == "oversize":
        path.write_bytes(b"large")
        monkeypatch.setattr(integrity, "MAX_ARTIFACT_BYTES", 2)
    with pytest.raises(integrity.ModelPolicyError):
        integrity.verified_model_paths(settings, lambda p: tmp_path / p)


@pytest.mark.parametrize("suffix", ["", "  report.json", " *report.json"])
def test_evaluation_digest_formats_and_exact_bytes(tmp_path, suffix):
    path = report_file(tmp_path, suffix=suffix)
    assert integrity.load_verified_evaluation(path) == {"approval": {"status": "pending"}}


def test_changed_evaluation_bytes_rejected(tmp_path):
    path = report_file(tmp_path)
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(integrity.ModelPolicyError, match="hash mismatch"):
        integrity.load_verified_evaluation(path)


@pytest.mark.parametrize("digest", ["", "a" * 63, "g" * 64, "a" * 64 + "\n" + "b" * 64, "x" * 513])
def test_malformed_sidecar_is_rejected(tmp_path, digest):
    path = report_file(tmp_path)
    Path(f"{path}.sha256").write_text(digest)
    with pytest.raises(integrity.ModelPolicyError):
        integrity.load_verified_evaluation(path)


@pytest.mark.parametrize(
    "raw", [b'{"approval":{"status":"pending","status":"approved"}}', b'{"x":1e9999}', b"[]"]
)
def test_matching_digest_does_not_legitimize_ambiguous_json(tmp_path, raw):
    path = report_file(tmp_path, raw)
    with pytest.raises(integrity.ModelPolicyError):
        integrity.load_verified_evaluation(path)


def test_evaluation_parser_uses_the_hashed_snapshot(tmp_path, monkeypatch):
    path = report_file(tmp_path)
    original = integrity.parse_json_object

    def after_read(data, label):
        path.write_bytes(b'{"approval":{"status":"approved"}}')
        return original(data, label)

    monkeypatch.setattr(integrity, "parse_json_object", after_read)
    assert integrity.load_verified_evaluation(path)["approval"]["status"] == "pending"


def test_policy_errors_do_not_contain_private_path_or_submitted_data(tmp_path):
    path = tmp_path / "private-person-secret.json"
    path.write_bytes(b'{"private-vector":NaN}')
    with pytest.raises(integrity.ModelPolicyError) as caught:
        integrity.load_manifest_object(path)
    assert "private" not in str(caught.value)


def test_integrity_module_does_not_import_decoder_or_model_runtime():
    script = 'import sys; import pictured_ml_face.model_integrity; assert not any(x in sys.modules for x in ("cv2","pillow_heif","pictured_ml_face.pipeline"))'
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, result.stderr


def setup_adapter(tmp_path, monkeypatch):
    for key in (
        "APP_ENV",
        "CLOUDFLARE_ENV",
        "ML_REQUIRE_MODEL_ARTIFACTS",
        "ML_USE_DETERMINISTIC_SIMULATOR",
        "ML_EVALUATION_REPORT_PATH",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ML_DEPLOYMENT_MODE", "monitored_pilot")
    manifest = registry()
    manifest["models"][0].update(artifacts(tmp_path))
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    cls, calls = adapter_class()
    return manifest, path, cls, calls


def test_extracted_adapter_pilot_requires_both_real_file_hashes(tmp_path, monkeypatch):
    manifest, path, cls, calls = setup_adapter(tmp_path, monkeypatch)
    pipeline = cls(path)
    assert pipeline.artifact_integrity == "verified"
    assert pipeline.evaluation_status == "monitored_pilot"  # NOT approved.
    assert calls == [
        str(tmp_path / manifest["models"][0][name])
        for name in ("detector_path", "recognizer_path", "recognizer_path")
    ]


@pytest.mark.parametrize("mutation", ["missing_hash", "blocked", "duplicate", "missing_path"])
def test_extracted_adapter_rejects_before_runtime_constructor(tmp_path, monkeypatch, mutation):
    manifest, path, cls, calls = setup_adapter(tmp_path, monkeypatch)
    if mutation == "missing_hash":
        manifest["models"][0].pop("recognizer_sha256")
    if mutation == "blocked":
        manifest["blocked_models"] = [{"version": "synthetic-v1"}]
    if mutation == "duplicate":
        manifest["models"].append(deepcopy(manifest["models"][0]))
    if mutation == "missing_path":
        manifest["models"][0].pop("detector_path")
    path.write_text(json.dumps(manifest))
    with pytest.raises(integrity.ModelPolicyError):
        cls(path)
    assert calls == []


def test_extracted_adapter_required_artifacts_cannot_label_simulator_verified(
    tmp_path, monkeypatch
):
    manifest, path, cls, calls = setup_adapter(tmp_path, monkeypatch)
    monkeypatch.delenv("APP_ENV")
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")
    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "true")
    with pytest.raises(integrity.ModelPolicyError, match="forbidden"):
        cls(path)
    assert calls == []


def test_extracted_adapter_missing_report_approval_stays_blocked(tmp_path, monkeypatch):
    manifest, path, cls, calls = setup_adapter(tmp_path, monkeypatch)
    monkeypatch.setenv("ML_DEPLOYMENT_MODE", "production")
    report = {
        key: {}
        for key in (
            "approval",
            "dataset",
            "results",
            "thresholds",
            "bias_review",
            "policy_checks",
            "operations",
        )
    }
    report["approval"] = {"status": "pending"}
    report_path = report_file(tmp_path, json.dumps(report).encode())
    manifest["production_evidence"] = {"evaluation_report_path": str(report_path)}
    path.write_text(json.dumps(manifest))
    with pytest.raises(integrity.ModelPolicyError, match="not approved"):
        cls(path)
    assert calls == []


def test_extracted_health_does_not_infer_integrity_from_approval_label():
    tree = ast.parse((SOURCE / "main.py").read_text())
    declaration = deepcopy(
        next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "health"
        )
    )
    declaration.decorator_list = []
    pipeline = SimpleNamespace(
        manifest=SimpleNamespace(active_model_version="synthetic"),
        active_model={},
        deployment_mode="production",
        evaluation_status="approved",
        artifact_integrity="not_verified",
        module_versions={},
    )
    namespace = {"pipeline": pipeline, "PROHIBITED_CATEGORIES": []}
    exec(
        compile(
            ast.Module(body=[declaration], type_ignores=[]),
            "<extracted health declaration>",
            "exec",
        ),
        namespace,
    )
    assert namespace["health"]()["production_evidence"]["artifact_integrity"] == "not_verified"


def test_json_depth_limit_ignores_quoted_and_escaped_brackets():
    value = {"text": '[{\\"}]' * 2000}
    assert integrity.parse_json_object(json.dumps(value).encode(), "Test policy") == value


def test_json_depth_boundary():
    allowed = b'{"x":' + b"[" * 63 + b"0" + b"]" * 63 + b"}"
    integrity.parse_json_object(allowed, "Test policy")
    with pytest.raises(integrity.ModelPolicyError):
        integrity.parse_json_object(allowed.replace(b"0", b"[0]"), "Test policy")


def test_extracted_adapter_failed_recheck_clears_previous_integrity(tmp_path, monkeypatch):
    manifest, path, cls, calls = setup_adapter(tmp_path, monkeypatch)
    pipeline = cls(path)
    (tmp_path / manifest["models"][0]["recognizer_path"]).write_bytes(b"changed")
    with pytest.raises(integrity.ModelPolicyError):
        pipeline._enforce_production_evidence()
    assert pipeline.artifact_integrity == "not_verified"
    assert pipeline.evaluation_status == "not_required"
    assert pipeline._verified_artifact_paths == {}


def test_existing_negative_evaluation_fixture_reaches_semantic_checks(tmp_path, monkeypatch):
    # Execute these existing test helpers without importing the codec-dependent
    # test module. Synthetic artifacts meet integrity, not recognition approval.
    tree = ast.parse((ROOT / "tests/test_pipeline.py").read_text())
    names = {"approved_evaluation_report", "write_manifest_for_report", "write_report_digest"}
    declarations = [
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    namespace = {
        "Path": Path,
        "json": json,
        "hashlib": hashlib,
        "approved_evaluation_report": approved_evaluation_report,
    }
    exec(
        compile(
            ast.Module(body=declarations, type_ignores=[]),
            "<existing evaluation fixture helpers>",
            "exec",
        ),
        namespace,
    )
    report = namespace["approved_evaluation_report"]()
    report["dataset"]["holdout_split_verified"] = False
    report_path = tmp_path / "report.json"
    report_path.write_text(json.dumps(report))
    manifest_path = namespace["write_manifest_for_report"](tmp_path, report_path)
    for key in (
        "APP_ENV",
        "CLOUDFLARE_ENV",
        "ML_USE_DETERMINISTIC_SIMULATOR",
        "ML_EVALUATION_REPORT_PATH",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")
    monkeypatch.setenv("ML_DEPLOYMENT_MODE", "development")
    cls, calls = adapter_class()
    with pytest.raises(integrity.ModelPolicyError, match="dataset evidence is not complete"):
        cls(manifest_path)
    assert calls == []


def test_extracted_adapter_unapproved_report_preserves_first_failure(tmp_path, monkeypatch):
    manifest, path, cls, calls = setup_adapter(tmp_path, monkeypatch)
    monkeypatch.setenv("ML_DEPLOYMENT_MODE", "production")
    report_path = report_file(tmp_path)
    manifest["production_evidence"] = {"evaluation_report_path": str(report_path)}
    path.write_text(json.dumps(manifest))
    with pytest.raises(integrity.ModelPolicyError, match="not approved"):
        cls(path)
    assert calls == []
