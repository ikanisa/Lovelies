"""Integration of response-binding and detector-optimization branches; synthetic only."""

from copy import deepcopy
import pytest
from pictured_ml_face.processing_observation import trace_from_diagnostics
from pictured_ml_face.detection_strategy import profile_fingerprint
from test_pipeline_optimization import fake_pipeline, request, image_bytes


@pytest.mark.parametrize("profile", ["reference-v1", "bounded-v1", "group-v1"])
def test_profile_preserves_bound_response_and_single_source_measurements(monkeypatch, profile):
    p = fake_pipeline(monkeypatch, profile)
    body = p.process_photo_bytes(request(), image_bytes()).model_dump()
    assert body["result_contract_version"] == "lovelies-photo-result-v2"
    assert body["event_id"] == "synthetic-event" and body["asset_id"] == "synthetic-asset"
    diag = body["image_metadata"]["processing_diagnostics"]
    trace = body["processing_trace"]
    assert trace["stage_ms"] == diag["stage_ms"]
    assert trace["total_ms"] == diag["total_ms"]
    assert trace["counts"]["faces_emitted"] == len(body["faces"])
    assert diag["detection_profile_sha256"] == profile_fingerprint(profile)
    if profile != "reference-v1":
        assert body["image_metadata"]["evaluation_status"] == "optimization_candidate"
        assert all("approved_decision_policy" not in f["module_versions"] for f in body["faces"])


@pytest.mark.parametrize("count_failed", [1, 2])
def test_embedding_failures_conserve_counts(monkeypatch, count_failed):
    p = fake_pipeline(monkeypatch)
    original = p.detector.detect_decoded

    def detector(pixels):
        first = original(pixels)[0]
        second = deepcopy(first)
        second.bbox["x"] = 200
        return [first, second]

    p.detector.detect_decoded = detector
    embed = p.embedding_model.embed

    def rejected(aligned, event):
        if count_failed == 2 or aligned.bbox["x"] == 10:
            raise ValueError("synthetic_rejection")
        return embed(aligned, event)

    p.embedding_model.embed = rejected
    body = p.process_photo_bytes(request(), image_bytes())
    c = body.processing_trace["counts"]
    assert c["faces_considered"] == c["faces_aligned"] == 2
    assert c["embedding_failures"] == count_failed
    assert c["faces_emitted"] == c["embeddings_created"] == 2 - count_failed
    assert (
        body.image_metadata["processing_diagnostics"]["counts"]["embedding_rejections"]
        == count_failed
    )


@pytest.mark.parametrize("bad", [-1, True, 101, 1.5, "1"])
def test_trace_projection_rejects_impossible_diagnostics(monkeypatch, bad):
    p = fake_pipeline(monkeypatch)
    d = p.process_photo_bytes(request(), image_bytes()).image_metadata["processing_diagnostics"]
    d["counts"]["embedding_rejections"] = bad
    with pytest.raises((ValueError, TypeError)):
        trace_from_diagnostics(d)


def test_validation_clears_owned_decode_on_quality_failure(monkeypatch):
    import numpy as np
    import pictured_ml_face.validation_pipeline as v

    decoded = np.full((10, 10, 3), 77, dtype=np.uint8)
    monkeypatch.setattr(
        v, "decode_validated_image", lambda *_: (decoded, {"width": 10, "height": 10})
    )

    def bad(*_):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(v, "image_diagnostics", bad)
    with pytest.raises(RuntimeError):
        v.process_validation_image(b"synthetic", "image/png")
    assert not decoded.any()
