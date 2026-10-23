"""Combined integrity/evaluated-policy regression tests, synthetic evidence only.

Uses the complete extracted FacePipeline class with controlled runtime constructors.
This does not start FastAPI/HEIF or establish human accuracy or reviewer approval.
"""

import hashlib
import json
from pathlib import Path

import pytest
from pictured_ml_face import model_integrity as integrity
from pictured_ml_face.evaluation_policy import ModelPolicyError
from pictured_ml_face.evaluation_contract import approval_metadata
from evaluation_test_fixtures import approved_evaluation_report
from test_model_integrity import setup_adapter, report_file


def approved_adapter(tmp_path, monkeypatch):
    manifest, path, cls, calls = setup_adapter(tmp_path, monkeypatch)
    monkeypatch.setenv("ML_DEPLOYMENT_MODE", "production")
    report = approved_evaluation_report()
    report["model_version"] = manifest["models"][0]["version"]
    raw = json.dumps(report, separators=(",", ":")).encode()
    report_path = report_file(tmp_path, raw)
    manifest["production_evidence"] = {"evaluation_report_path": str(report_path)}
    path.write_text(json.dumps(manifest))
    return manifest, path, cls, calls, report_path, report, raw


def test_policy_and_integrity_share_one_error_type():
    assert ModelPolicyError is integrity.ModelPolicyError


def test_verified_report_bytes_are_returned_without_reserialization(tmp_path):
    raw = b'{ "approval" : {"status":"pending"}, "n":1.00 }\n'
    path = report_file(tmp_path, raw)
    assert integrity.load_verified_evaluation_bytes(path) == raw
    assert integrity.load_verified_evaluation(path) == json.loads(raw)


def test_report_is_read_once_for_byte_verification(tmp_path, monkeypatch):
    raw = b'{"approval":{"status":"pending"}}'
    path = report_file(tmp_path, raw)
    original = integrity.read_bounded_file
    reads = []

    def read(file, limit, label):
        reads.append(Path(file))
        return original(file, limit, label)

    monkeypatch.setattr(integrity, "read_bounded_file", read)
    assert integrity.load_verified_evaluation_bytes(path) == raw
    assert reads.count(path) == 1


def test_verified_bytes_retained_if_report_replaced_after_read(tmp_path):
    raw = b'{"approval":{"status":"pending"}}'
    path = report_file(tmp_path, raw)
    verified = integrity.load_verified_evaluation_bytes(path)
    path.write_bytes(b'{"approval":{"status":"approved"}}')
    assert verified == raw
    with pytest.raises(ModelPolicyError, match="hash mismatch"):
        integrity.load_verified_evaluation_bytes(path)


def test_exact_report_digest_and_policy_survive_startup(tmp_path, monkeypatch):
    manifest, path, cls, calls, report_path, report, raw = approved_adapter(tmp_path, monkeypatch)
    pipeline = cls(path)
    assert pipeline.artifact_integrity == "verified"
    assert pipeline.evaluation_status == "approved"
    assert pipeline.evaluation_report_digest == hashlib.sha256(raw).hexdigest()
    assert pipeline.approved_decision_policy == report["decision_binding"]["policy"]
    metadata = approval_metadata(
        pipeline.active_model,
        pipeline.approved_decision_policy,
        pipeline.evaluation_report_digest,
        pipeline.evaluation_status,
    )
    assert metadata["evaluation_report_sha256"] == hashlib.sha256(raw).hexdigest()
    assert json.loads(metadata["approved_decision_policy"]) == report["decision_binding"]["policy"]
    assert len(calls) == 3


@pytest.mark.parametrize("mutation", ["report_hash", "binding", "consent", "model_artifact"])
def test_failed_recheck_cannot_reuse_earlier_policy(tmp_path, monkeypatch, mutation):
    manifest, path, cls, calls, report_path, report, raw = approved_adapter(tmp_path, monkeypatch)
    pipeline = cls(path)
    if mutation == "report_hash":
        report_path.write_bytes(raw + b" ")
    elif mutation == "model_artifact":
        (tmp_path / manifest["models"][0]["detector_path"]).write_bytes(b"changed")
    else:
        if mutation == "binding":
            report["decision_binding"]["policy"].pop("review_margin")
        if mutation == "consent":
            report["dataset"]["consent_evidence_verified"] = False
        report_path.write_text(json.dumps(report))
        Path(f"{report_path}.sha256").write_text(
            hashlib.sha256(report_path.read_bytes()).hexdigest()
        )
    with pytest.raises(ModelPolicyError):
        pipeline._enforce_production_evidence()
    assert pipeline.evaluation_status == "not_required"
    assert pipeline.approved_decision_policy is None
    assert pipeline.evaluation_report_digest is None
    assert (
        approval_metadata(
            pipeline.active_model,
            pipeline.approved_decision_policy,
            pipeline.evaluation_report_digest,
            pipeline.evaluation_status,
        )
        == {}
    )
    assert len(calls) == 3  # recheck does not start replacement runtime constructors


@pytest.mark.parametrize("profile", ["bounded-v1", "group-v1"])
def test_verified_artifacts_do_not_authorize_unevaluated_detection_profile(
    tmp_path, monkeypatch, profile
):
    _, path, cls, calls, _, _, _ = approved_adapter(tmp_path, monkeypatch)
    with pytest.raises(ModelPolicyError, match="cannot reuse reference"):
        cls(path, detection_profile=profile)
    assert not calls


def test_monitored_pilot_does_not_emit_automatic_approval(tmp_path, monkeypatch):
    _, path, cls, _, _, _, _ = approved_adapter(tmp_path, monkeypatch)
    monkeypatch.setenv("ML_DEPLOYMENT_MODE", "monitored_pilot")
    pipeline = cls(path)
    assert pipeline.artifact_integrity == "verified"
    assert pipeline.evaluation_status == "monitored_pilot"
    assert pipeline.approved_decision_policy is None
    assert pipeline.evaluation_report_digest is None
    assert approval_metadata(pipeline.active_model, None, None, pipeline.evaluation_status) == {}


@pytest.mark.parametrize("raw", [b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e9999}'])
def test_even_correct_digest_does_not_authorize_ambiguous_report(tmp_path, raw):
    path = report_file(tmp_path, raw)
    with pytest.raises(ModelPolicyError):
        integrity.load_verified_evaluation_bytes(path)


@pytest.mark.parametrize("maximum", [0, True, integrity.MAX_EVALUATION_BYTES + 1])
def test_verified_bytes_reject_invalid_limit_before_read(tmp_path, maximum):
    with pytest.raises(ModelPolicyError, match="Invalid evaluation byte limit"):
        integrity.load_verified_evaluation_bytes(tmp_path / "absent", maximum=maximum)


def test_verified_bytes_can_preserve_a_stricter_caller_limit(tmp_path):
    raw = b'{"approval":{"status":"pending"}}'
    path = report_file(tmp_path, raw)
    assert integrity.load_verified_evaluation_bytes(path, maximum=len(raw)) == raw
    with pytest.raises(ModelPolicyError):
        integrity.load_verified_evaluation_bytes(path, maximum=len(raw) - 1)


def test_pipeline_preserves_integrated_one_mib_report_limit(tmp_path, monkeypatch):
    _, path, cls, calls, report_path, _, raw = approved_adapter(tmp_path, monkeypatch)
    # Correctly hashed valid JSON above the integrated limit must still fail.
    oversized = raw + b" " * (1_048_577 - len(raw))
    report_path.write_bytes(oversized)
    Path(f"{report_path}.sha256").write_text(hashlib.sha256(oversized).hexdigest())
    with pytest.raises(ModelPolicyError):
        cls(path)
    assert not calls
