"""Actual pipeline/API integration checks; requires genuine codecs and model setup.

These cases were moved from test_evaluation_contract.py without weakening their
assertions. They belong in the full ML suite, not a codec-independent pass claim.
"""

import json
import pytest
from pictured_ml_face.evaluation_contract import sha256
from pictured_ml_face.evaluation_policy import ModelPolicyError
from test_evaluation_contract import POLICY, binding


def test_validated_exact_bytes_are_used_without_second_file_read(tmp_path):
    from pictured_ml_face.pipeline import FacePipeline
    from evaluation_test_fixtures import approved_evaluation_report

    report = approved_evaluation_report()
    report["decision_binding"] = binding()
    raw = json.dumps(report).encode()
    pipeline = FacePipeline.__new__(FacePipeline)
    pipeline.active_model = {"version": "test-model", "checksum_sha256": "a" * 64}

    class Manifest:
        production_evidence = {}

    pipeline.manifest = Manifest()
    # The on-disk path is deliberately absent: validated bytes are authoritative.
    pipeline._enforce_evaluation_report(tmp_path / "absent.json", raw_bytes=raw)
    assert pipeline.evaluation_report_digest == sha256(raw)
    assert pipeline.approved_decision_policy == POLICY


def test_simulator_cannot_emit_approved_output(monkeypatch):
    from pictured_ml_face.pipeline import FacePipeline

    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "true")

    def fake_evidence(self):
        self.evaluation_status = "approved"

    monkeypatch.setattr(FacePipeline, "_enforce_production_evidence", fake_evidence)
    with pytest.raises(ModelPolicyError, match="simulator"):
        FacePipeline("models/model-manifest.json")


def test_direct_match_api_is_explicitly_non_authorizing():
    from fastapi.testclient import TestClient
    from pictured_ml_face.main import app

    vector = [1.0] + [0.0] * 127
    response = TestClient(app).post(
        "/v1/match-face",
        json={
            "event_id": "unit",
            "detected_face_id": "unit",
            "embedding": vector,
            "candidates": [
                {"user_id": "synthetic-1", "face_profile_id": "synthetic-1", "embedding": vector}
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["numeric_decision"] == "auto_matched"
    assert body["decision"] == "needs_review"
    assert body["authorization_effect"] == "none"
