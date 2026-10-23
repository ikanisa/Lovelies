"""Real transport/decoding with synthetic pixels and controlled face components."""

import hashlib
import io
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import pictured_ml_face.main as service
from pictured_ml_face.components import FaceDetection
from pictured_ml_face.processing_observation import STAGES, COUNTERS, PHOTO_RESULT_CONTRACT
from pictured_ml_face.validation_pipeline import process_validation_image
from pictured_ml_face.models import PhotoProcessRequest


def pixels(format="PNG", orientation=None):
    img = Image.new("RGB", (64, 48), (90, 120, 150))
    stream = io.BytesIO()
    kwargs = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[274] = orientation
        kwargs["exif"] = exif
    img.save(stream, format=format, **kwargs)
    return stream.getvalue()


def assert_trace(trace, face_count=0):
    assert trace["contract_version"] == "aggregate-processing-stages-v2"
    assert set(trace["stage_ms"]) == set(STAGES)
    assert set(trace["counts"]) == set(COUNTERS)
    assert all(np.isfinite(v) and v >= 0 for v in trace["stage_ms"].values())
    assert trace["counts"]["faces_emitted"] == face_count


@pytest.mark.parametrize(
    "format,content_type", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")]
)
def test_validation_has_real_quality_and_input_binding(format, content_type):
    raw = pixels(format)
    result = process_validation_image(raw, content_type, "scope", "asset")
    assert result["result_contract_version"] == PHOTO_RESULT_CONTRACT
    assert result["processing_mode"] == "validation"
    assert result["status"] == "validated" and result["faces"] == []
    assert result["event_id"] == "scope" and result["asset_id"] == "asset"
    assert result["image_metadata"]["sha256"] == hashlib.sha256(raw).hexdigest()
    assert result["image_metadata"]["byte_size"] == len(raw)
    assert result["image_quality"]["estimated_width"] == 64
    assert result["image_quality"]["calibration_status"] == "heuristic_not_calibrated"
    assert_trace(result["processing_trace"])
    assert all(v == 0 for v in result["processing_trace"]["counts"].values())


def test_validation_never_invokes_face_pipeline(monkeypatch):
    def forbidden(*a, **k):
        pytest.fail("validation-only request invoked face processing")

    monkeypatch.setattr(service.pipeline, "process_photo_bytes", forbidden)
    monkeypatch.setattr(service.pipeline.detector, "detect", forbidden)
    raw = pixels()
    result = TestClient(service.app).post(
        "/v1/validate-image",
        content=raw,
        headers={
            "x-lovelies-declared-content-type": "image/png",
            "x-lovelies-event-id": "scope",
            "x-lovelies-asset-id": "asset",
            "x-request-id": "aaf34178-1409-4c1a-8a78-9e9a3aa20f77",
        },
    )
    assert result.status_code == 200
    assert result.json()["asset_id"] == "asset"
    assert result.headers["x-request-id"] == "aaf34178-1409-4c1a-8a78-9e9a3aa20f77"


@pytest.mark.parametrize("orientation", [5, 6, 7, 8])
def test_validation_geometry_is_upright(orientation):
    result = process_validation_image(pixels("JPEG", orientation), "image/jpeg")
    assert result["width"] == 48 and result["height"] == 64
    assert result["image_metadata"]["geometry"]["orientation"] == "upright"
    assert result["image_quality"]["estimated_height"] == 64


def test_recognition_no_faces_keeps_binding_and_zero_counts(monkeypatch):
    monkeypatch.setattr(service.pipeline.detector, "detect", lambda b: [])
    raw = pixels()
    result = service.pipeline.process_photo_bytes(
        PhotoProcessRequest(
            event_id="scope", asset_id="asset", object_key="", content_type="image/png"
        ),
        raw,
    ).model_dump()
    assert result["processing_mode"] == "recognition" and result["status"] == "no_faces"
    assert result["image_metadata"]["sha256"] == hashlib.sha256(raw).hexdigest()
    assert result["image_quality"]["estimated_width"] == 64
    assert_trace(result["processing_trace"])


def test_alignment_failures_are_counted_without_dropping_valid_face(monkeypatch):
    def detection(x):
        return FaceDetection(
            bbox={"x": x, "y": 1, "width": 10, "height": 10},
            landmarks={
                "right_eye": [2.0, 2.0],
                "left_eye": [8.0, 2.0],
                "nose": [5.0, 5.0],
                "mouth_right": [3.0, 8.0],
                "mouth_left": [7.0, 8.0],
            },
            confidence=0.99,
        )

    monkeypatch.setattr(
        service.pipeline.detector, "detect", lambda b: [detection(1), detection(20)]
    )
    original = service.pipeline.aligner.align

    def align(b, d):
        if d.bbox["x"] == 1:
            raise ValueError("unusable_landmarks")
        return original(b, d)

    monkeypatch.setattr(service.pipeline.aligner, "align", align)
    result = service.pipeline.process_photo_bytes(
        PhotoProcessRequest(
            event_id="scope", asset_id="asset", object_key="", content_type="image/png"
        ),
        pixels(),
    ).model_dump()
    assert_trace(result["processing_trace"], 1)
    assert result["processing_trace"]["counts"] == {
        "faces_considered": 2,
        "alignment_failures": 1,
        "embedding_failures": 0,
        "faces_aligned": 1,
        "embeddings_created": 1,
        "faces_emitted": 1,
    }


def test_metrics_do_not_change_recognition_vector(monkeypatch):
    raw = pixels("JPEG")
    request = PhotoProcessRequest(
        event_id="scope", asset_id="asset", object_key="", content_type="image/jpeg"
    )
    before = service.pipeline._process_faces(raw, request)
    after = service.pipeline.process_photo_bytes(request, raw)
    assert [f.embedding for f in before] == [f.embedding for f in after.faces]


def test_no_image_or_subject_identifiers_in_trace(monkeypatch):
    monkeypatch.setattr(service.pipeline.detector, "detect", lambda b: [])
    response = service.pipeline.process_photo_bytes(
        PhotoProcessRequest(
            event_id="PRIVATE-SCOPE",
            asset_id="PRIVATE-ASSET",
            object_key="",
            content_type="image/png",
        ),
        pixels(),
    )
    assert "PRIVATE" not in json.dumps(response.processing_trace)
    assert "embedding" not in json.dumps(response.processing_trace).replace(
        "embeddings_created", ""
    ).replace("embedding_failures", "")
