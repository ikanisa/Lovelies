import base64
import hashlib
import io
import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from evaluation_test_fixtures import approved_evaluation_report
from pictured_ml_face.main import app
from pictured_ml_face.components import (
    MAX_DECODED_IMAGE_PIXELS,
    AlignedFace,
    FaceDetection,
    OpenCvYuNetDetector,
    decode_image,
)
from pictured_ml_face.models import (
    CandidateEmbedding,
    MatchDecision,
    MatchRequest,
    PhotoProcessRequest,
)
from pictured_ml_face.pipeline import (
    PHOTO_SIMILARITY_THRESHOLD,
    FacePipeline,
    ModelPolicyError,
    is_similar_photo,
    perceptual_hash_similarity,
    strongest_duplicate_candidate,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_decode_rejects_compressed_images_above_pixel_budget():
    image = Image.new("1", (7_000, 6_000), color=1)
    payload = io.BytesIO()
    image.save(payload, format="PNG")

    assert 7_000 * 6_000 > MAX_DECODED_IMAGE_PIXELS
    assert len(payload.getvalue()) < 100_000
    with pytest.raises(ValueError, match="Decoded image exceeds"):
        decode_image(payload.getvalue())


def test_validate_image_endpoint_rejects_malformed_bytes():
    response = TestClient(app).post(
        "/v1/validate-image",
        content=b"not-an-image",
        headers={"x-lovelies-declared-content-type": "image/jpeg"},
    )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "invalid_image_content"


def test_validate_image_endpoint_accepts_matching_jpeg():
    payload = io.BytesIO()
    Image.new("RGB", (4, 3), color=(120, 80, 40)).save(payload, format="JPEG")

    response = TestClient(app).post(
        "/v1/validate-image",
        content=payload.getvalue(),
        headers={"x-lovelies-declared-content-type": "image/jpeg"},
    )

    assert response.status_code == 200
    assert {key: response.json()[key] for key in ("content_type", "format", "height", "width")} == {
        "content_type": "image/jpeg",
        "format": "JPEG",
        "height": 3,
        "width": 4,
    }


def test_process_photo_binary_endpoint_preserves_raw_transport_integrity():
    payload = io.BytesIO()
    Image.new("RGB", (32, 24), color=(120, 80, 40)).save(payload, format="JPEG")
    image_bytes = payload.getvalue()

    response = TestClient(app).post(
        "/v1/process-photo-binary",
        content=image_bytes,
        headers={
            "content-type": "image/jpeg",
            "x-lovelies-declared-content-type": "image/jpeg",
            "x-lovelies-event-id": "open-profile",
            "x-lovelies-asset-id": "8f1cb933-42c5-4a35-b13d-5f974e241f22",
            "x-lovelies-transport-version": "binary-v1",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["asset_id"] == "8f1cb933-42c5-4a35-b13d-5f974e241f22"
    assert body["event_id"] == "open-profile"
    assert body["image_metadata"]["byte_size"] == len(image_bytes)
    assert body["image_metadata"]["sha256"] == hashlib.sha256(image_bytes).hexdigest()


def test_validate_image_endpoint_preserves_heif_support():
    # The service decodes contributed originals; HEIF encoding is not required.
    payload = (Path(__file__).parent / "fixtures" / "synthetic-color-4x3.heic").read_bytes()

    response = TestClient(app).post(
        "/v1/validate-image",
        content=payload,
        headers={"x-lovelies-declared-content-type": "image/heif"},
    )

    assert response.status_code == 200
    assert {key: response.json()[key] for key in ("content_type", "format", "height", "width")} == {
        "content_type": "image/heif",
        "format": "HEIF",
        "height": 3,
        "width": 4,
    }


def test_validate_image_endpoint_rejects_declared_type_mismatch():
    payload = io.BytesIO()
    Image.new("RGB", (4, 3), color=(120, 80, 40)).save(payload, format="PNG")

    response = TestClient(app).post(
        "/v1/validate-image",
        content=payload.getvalue(),
        headers={"x-lovelies-declared-content-type": "image/jpeg"},
    )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "image_content_type_mismatch"


def test_yunet_serializes_mutable_detector_input_size(monkeypatch, tmp_path):
    calls = []
    active = 0
    overlap = False
    state_lock = threading.Lock()

    class FakeDetector:
        def setInputSize(self, size):
            calls.append(("size", size))

        def detect(self, _image):
            nonlocal active, overlap
            calls.append(("detect", None))
            with state_lock:
                active += 1
                overlap = overlap or active > 1
            time.sleep(0.02)
            with state_lock:
                active -= 1
            return None, None

    fake = FakeDetector()
    monkeypatch.setattr(
        "pictured_ml_face.components.cv2.FaceDetectorYN.create",
        lambda *_args, **_kwargs: fake,
    )
    monkeypatch.setattr(
        "pictured_ml_face.components.decode_image",
        lambda _bytes: __import__("numpy").zeros((12, 24, 3), dtype="uint8"),
    )
    detector = OpenCvYuNetDetector(tmp_path / "model.onnx")

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(detector.detect, [b"one", b"two"]))

    assert results == [[], []]
    assert overlap is False
    assert calls.count(("size", (24, 12))) == 2


def test_process_faces_decodes_source_once_for_many_faces(monkeypatch):
    import numpy as np
    import pictured_ml_face.pipeline as pipeline_module

    detection = FaceDetection(
        bbox={"x": 1, "y": 1, "width": 4, "height": 4},
        landmarks={
            "left_eye": [2.0, 2.0],
            "right_eye": [4.0, 2.0],
            "nose": [3.0, 3.0],
            "mouth_left": [2.0, 4.0],
            "mouth_right": [4.0, 4.0],
        },
        confidence=0.99,
    )

    class FakeDetector:
        version = "fake"

        def detect(self, _bytes):
            return [detection, detection, detection]

    class FakeAligner:
        version = "fake"

        def align_decoded(self, image, face):
            assert image.shape == (10, 10, 3)
            return AlignedFace(face.bbox, face.landmarks, b"aligned")

    pipeline = FacePipeline("models/model-manifest.json")
    pipeline.using_deterministic_simulator = False
    pipeline.detector = FakeDetector()
    pipeline.aligner = FakeAligner()
    decode_calls = 0

    def fake_decode(_bytes):
        nonlocal decode_calls
        decode_calls += 1
        return np.zeros((10, 10, 3), dtype=np.uint8)

    monkeypatch.setattr(pipeline_module, "OpenCvSFaceAligner", FakeAligner)
    monkeypatch.setattr(pipeline_module, "decode_image", fake_decode)
    faces = pipeline._process_faces(
        b"source",
        PhotoProcessRequest(event_id="event", asset_id="asset", object_key=""),
    )

    assert len(faces) == 3
    assert decode_calls == 1


def test_process_photo_returns_embedding_without_prohibited_categories():
    client = TestClient(app)
    image = io.BytesIO()
    Image.new("RGB", (32, 24), color=(120, 80, 40)).save(image, format="JPEG")
    response = client.post(
        "/v1/process-photo",
        json={
            "event_id": "event-1",
            "asset_id": "asset-1",
            "object_key": "events/event-1/raw/asset-1/photo.jpg",
            "image_b64": base64.b64encode(image.getvalue()).decode(),
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "processed"
    assert body["prohibited_categories"] == []
    assert len(body["faces"][0]["embedding"]) == 128
    assert body["faces"][0]["module_versions"]["detector"] == "detector.local-deterministic.v1"
    assert body["faces"][0]["module_versions"]["recognition_provider"] == "local_opencv_yunet_sface"
    assert body["faces"][0]["module_versions"]["external_recognition_api"] == "disabled"
    assert body["image_metadata"]["duplicate_check"]["status"] == "perceptual_hash_ready"
    assert body["image_metadata"]["duplicate_check"]["similarity_threshold"] == 0.8
    assert 0.0 <= body["image_quality"]["aggregate_score"] <= 1.0
    assert len(body["image_quality"]["perceptual_hash"]) == 16


@pytest.mark.parametrize(
    ("encoded", "status", "code"),
    [
        ("not_valid_base64%%%", 415, "invalid_image_encoding"),
        (base64.b64encode(b"not-an-image").decode(), 415, "invalid_image_content"),
        ("", 400, "empty_image"),
        (None, 400, "empty_image"),
    ],
)
def test_json_processing_rejects_invalid_input_as_client_error(encoded, status, code):
    response = TestClient(app).post(
        "/v1/process-photo",
        json={"event_id": "qa", "asset_id": "qa", "object_key": "", "image_b64": encoded},
    )
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code


@pytest.mark.parametrize("size", [33, 60])
def test_json_processing_bounds_encoded_and_decoded_bytes(monkeypatch, size):
    monkeypatch.setattr("pictured_ml_face.main.MAX_UPLOAD_BYTES", 32)
    response = TestClient(app).post(
        "/v1/process-photo",
        json={
            "event_id": "qa",
            "asset_id": "qa",
            "object_key": "",
            "image_b64": base64.b64encode(b"x" * size).decode(),
        },
    )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "image_too_large"


def test_json_processing_rejects_declared_image_type_mismatch():
    image = io.BytesIO()
    Image.new("RGB", (8, 6), color=(120, 80, 40)).save(image, format="PNG")
    response = TestClient(app).post(
        "/v1/process-photo",
        json={
            "event_id": "qa",
            "asset_id": "qa",
            "object_key": "",
            "content_type": "image/jpeg",
            "image_b64": base64.b64encode(image.getvalue()).decode(),
        },
    )
    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "image_content_type_mismatch"


def test_process_photo_exposes_only_capture_time_from_exif():
    image = Image.new("RGB", (24, 24), color="white")
    exif = Image.Exif()
    exif[36867] = "2026:06:06 10:30:00"
    exif[36881] = "+02:00"
    exif[271] = "Private camera maker"
    payload = io.BytesIO()
    image.save(payload, format="JPEG", exif=exif)

    pipeline = FacePipeline("models/model-manifest.json")
    metadata = pipeline._image_metadata(
        payload.getvalue(),
        PhotoProcessRequest(
            event_id="event-calendar",
            asset_id="asset-calendar",
            object_key="events/event-calendar/raw/photo.jpg",
        ),
    )

    assert metadata["exif"] == {
        "status": "capture_time_extracted",
        "captured_at": "2026-06-06T10:30:00+02:00",
        "source": "DateTimeOriginal",
        "timezone_source": "exif_offset",
    }


def test_match_face_is_event_scoped_and_routes_uncertain_matches():
    pipeline = FacePipeline("models/model-manifest.json")
    image = io.BytesIO()
    Image.new("RGB", (120, 80), color=(120, 80, 40)).save(image, format="JPEG")
    processed = pipeline.process_photo(
        PhotoProcessRequest(
            event_id="event-1",
            asset_id="asset-1",
            object_key="events/event-1/raw/asset-1/photo.jpg",
            image_b64=base64.b64encode(image.getvalue()).decode(),
        )
    )
    embedding = processed.faces[0].embedding
    result = pipeline.match_face(
        MatchRequest(
            event_id="event-1",
            detected_face_id="face-1",
            embedding=embedding,
            threshold=0.42,
            review_margin=0.01,
            candidates=[
                CandidateEmbedding(
                    user_id="user-1",
                    face_profile_id="profile-1",
                    embedding=embedding,
                )
            ],
        )
    )

    assert result.event_scope == "event-1"
    assert result.decision == "needs_review"
    assert result.numeric_decision == "auto_matched"
    assert result.authorization_effect == "none"
    assert result.user_id == "user-1"


def test_match_face_api_rejects_unsafe_thresholds_and_malformed_embeddings():
    client = TestClient(app)

    invalid_threshold = client.post(
        "/v1/match-face",
        json={
            "event_id": "event-1",
            "detected_face_id": "face-1",
            "embedding": [0.0] * 128,
            "threshold": 1.5,
            "review_margin": 0.01,
            "candidates": [
                {
                    "user_id": "user-1",
                    "face_profile_id": "profile-1",
                    "embedding": [0.0] * 128,
                }
            ],
        },
    )

    assert invalid_threshold.status_code == 422

    malformed_embedding = client.post(
        "/v1/match-face",
        json={
            "event_id": "event-1",
            "detected_face_id": "face-1",
            "embedding": ([0.0] * 128) + [None],
            "threshold": 0.42,
            "review_margin": 0.01,
            "candidates": [
                {
                    "user_id": "user-1",
                    "face_profile_id": "profile-1",
                    "embedding": [0.0] * 128,
                }
            ],
        },
    )

    assert malformed_embedding.status_code == 422


def test_face_enrollment_endpoint_is_permanently_retired():
    client = TestClient(app)
    response = client.post("/v1/enroll-face", json={})

    assert response.status_code == 410
    assert response.json()["detail"]["code"] == "face_enrollment_retired"


def test_image_quality_fixtures_are_stable():
    pipeline = FacePipeline("models/model-manifest.json")
    fixtures = json.loads((FIXTURES / "image_quality.json").read_text())

    for fixture in fixtures:
        processed = pipeline.process_photo(
            PhotoProcessRequest(
                event_id=f"event-{fixture['name']}",
                asset_id=f"asset-{fixture['name']}",
                object_key=f"events/{fixture['name']}/raw/photo.jpg",
                image_b64=fixture["image_b64"],
                content_type=fixture["content_type"],
            )
        )

        assert processed.image_quality.estimated_width == fixture["expected_width"]
        assert processed.image_quality.estimated_height == fixture["expected_height"]
        assert processed.image_quality.calibration_status == "heuristic_not_calibrated"
        assert 0.0 <= processed.faces[0].quality_score <= 1.0
        assert 0.0 <= processed.image_quality.aggregate_score <= 1.0
        assert processed.image_quality.estimated_width > 0
        assert processed.image_quality.estimated_height > 0


def test_perceptual_hash_similarity_selects_candidates_at_policy_threshold():
    assert perceptual_hash_similarity("0000000000000000", "0000000000000000") == 1.0
    assert is_similar_photo("0000000000000000", "000000000000000f")
    assert (
        perceptual_hash_similarity("0000000000000000", "000000000fffffff")
        < PHOTO_SIMILARITY_THRESHOLD
    )
    assert not is_similar_photo("0000000000000000", "ffffffffffffffff")


def test_strongest_duplicate_candidate_returns_advisory_disposition():
    candidate = strongest_duplicate_candidate(
        "0000000000000000",
        [
            {"asset_id": "asset-low", "perceptual_hash": "ffffffffffffffff"},
            {"asset_id": "asset-similar", "perceptual_hash": "000000000000000f"},
            {"asset_id": "asset-exact", "perceptual_hash": "0000000000000000"},
        ],
    )

    assert candidate is not None
    assert candidate["asset_id"] == "asset-exact"
    assert candidate["similarity"] == 1.0
    assert candidate["threshold"] == 0.8
    assert candidate["disposition"] == "review_similarity"
    assert candidate["exact_duplicate_proven"] is False


def test_threshold_decision_fixtures_are_stable():
    pipeline = FacePipeline("models/model-manifest.json")
    fixtures = json.loads((FIXTURES / "threshold_decisions.json").read_text())

    for fixture in fixtures:
        result = pipeline.match_face(
            MatchRequest(
                event_id=f"event-{fixture['name']}",
                detected_face_id=f"face-{fixture['name']}",
                embedding=fixture_vector(fixture["query"]),
                threshold=fixture["threshold"],
                review_margin=fixture["review_margin"],
                candidates=[
                    CandidateEmbedding(
                        user_id=candidate["user_id"],
                        face_profile_id=candidate["face_profile_id"],
                        embedding=fixture_vector(candidate["embedding"]),
                    )
                    for candidate in fixture["candidates"]
                ],
            )
        )

        assert (result.numeric_decision or result.decision) == MatchDecision(
            fixture["expected_decision"]
        )
        assert result.decision != MatchDecision.AUTO_MATCHED
        assert result.authorization_effect == "none"
        assert result.user_id == fixture["expected_user_id"]
        assert result.threshold == fixture["threshold"]
        assert result.event_scope == f"event-{fixture['name']}"


def test_insightface_is_not_part_of_the_lovelies_runtime(tmp_path: Path):
    manifest = {
        "active_model_version": "insightface-buffalo-l",
        "models": [
            {
                "version": "insightface-buffalo-l",
                "detector": "InsightFace",
                "recognizer": "buffalo_l",
                "embedding_dimensions": 512,
            }
        ],
        "blocked_models": [],
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ModelPolicyError, match="not part of the Lovelies runtime"):
        FacePipeline(manifest_path)


def test_production_requires_model_artifacts_and_evaluation(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")

    with pytest.raises(ModelPolicyError, match="evaluation report is not approved"):
        FacePipeline("models/model-manifest.json")


def test_monitored_pilot_activates_real_artifacts_without_fake_evaluation(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("ML_USE_DETERMINISTIC_SIMULATOR", raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")
    monkeypatch.setenv("ML_DEPLOYMENT_MODE", "monitored_pilot")

    pipeline = FacePipeline("models/model-manifest.json")

    assert pipeline.using_deterministic_simulator is False
    assert pipeline.deployment_mode == "monitored_pilot"
    assert pipeline.evaluation_status == "monitored_pilot"


def test_production_requires_dataset_split_and_consent_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    report_path = tmp_path / "evaluation.json"
    report = approved_evaluation_report()
    report["dataset"]["holdout_split_verified"] = False
    report_path.write_text(json.dumps(report))
    manifest_path = write_manifest_for_report(tmp_path, report_path)
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")

    with pytest.raises(ModelPolicyError, match="dataset evidence is not complete"):
        FacePipeline(manifest_path)


def test_production_rejects_evaluation_report_hash_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    report_path = tmp_path / "evaluation.json"
    report_path.write_text(json.dumps(approved_evaluation_report()))
    manifest_path = write_manifest_for_report(tmp_path, report_path)
    report_path.write_text(f"{report_path.read_text()}\n")
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")

    with pytest.raises(ModelPolicyError, match="evaluation report hash mismatch"):
        FacePipeline(manifest_path)


def test_production_requires_threshold_change_control_and_drift_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    report_path = tmp_path / "evaluation.json"
    report = approved_evaluation_report()
    report["thresholds"]["threshold_change_control_approved"] = False
    report_path.write_text(json.dumps(report))
    manifest_path = write_manifest_for_report(tmp_path, report_path)
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")

    with pytest.raises(ModelPolicyError, match="threshold evidence is not complete"):
        FacePipeline(manifest_path)

    report["thresholds"]["threshold_change_control_approved"] = True
    report["operations"]["drift_monitoring_configured"] = False
    report_path.write_text(json.dumps(report))
    write_report_digest(report_path)
    with pytest.raises(ModelPolicyError, match="operations evidence is not complete"):
        FacePipeline(manifest_path)


def write_manifest_for_report(tmp_path: Path, report_path: Path) -> Path:
    write_report_digest(report_path)
    artifacts = {}
    for name in ("detector", "recognizer"):
        path = tmp_path / f"{name}.synthetic"
        path.write_bytes(f"synthetic integrity fixture, not an ONNX model: {name}".encode())
        artifacts[f"{name}_path"] = str(path)
        artifacts[f"{name}_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "active_model_version": "test-model",
                "models": [
                    {
                        **artifacts,
                        "version": "test-model",
                        "detector": "custom",
                        "recognizer": "custom",
                        "embedding_dimensions": 128,
                        "checksum_sha256": "a" * 64,
                        "license_metadata": {"spdx": "MIT"},
                    }
                ],
                "blocked_models": [],
                "production_evidence": {
                    "evaluation_report_path": str(report_path),
                    "minimum_dataset_events": 1,
                    "minimum_dataset_identities": 1,
                    "minimum_dataset_images": 1,
                    "maximum_false_positive_rate": 0.001,
                    "maximum_false_negative_rate": 0.05,
                },
            }
        )
    )
    return manifest_path


def write_report_digest(report_path: Path) -> None:
    report_path.with_name(f"{report_path.name}.sha256").write_text(
        f"{hashlib.sha256(report_path.read_bytes()).hexdigest()}\n"
    )


def fixture_vector(name: str) -> list[float]:
    vector = [0.0] * 128
    if name == "unit_x":
        vector[0] = 1.0
    elif name == "unit_y":
        vector[1] = 1.0
    elif name == "near_x":
        vector[0] = 0.99
        vector[1] = math.sqrt(1 - 0.99**2)
    else:
        raise AssertionError(f"Unknown vector fixture: {name}")
    return vector


@pytest.mark.parametrize(
    "section,field",
    [
        ("results", "false_positive_rate"),
        ("results", "false_negative_rate"),
        ("thresholds", "auto_match_threshold"),
        ("thresholds", "review_threshold"),
        ("thresholds", "minimum_margin"),
        ("thresholds", "minimum_quality_score"),
    ],
)
@pytest.mark.parametrize(
    "invalid", [float("nan"), float("-inf"), -0.1, True, "0", float("inf"), 2, None]
)
def test_approved_evaluation_rejects_invalid_quality_numbers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    section: str,
    field: str,
    invalid,
):
    report = approved_evaluation_report()
    report[section][field] = invalid
    report_path = tmp_path / "evaluation.json"
    report_path.write_text(json.dumps(report))
    manifest_path = write_manifest_for_report(tmp_path, report_path)
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")
    with pytest.raises(ModelPolicyError):
        FacePipeline(manifest_path)


@pytest.mark.parametrize("field", ["event_count", "identity_count", "image_count"])
@pytest.mark.parametrize("invalid", [True, "50", 1.5, None, -1, float("nan")])
def test_approved_evaluation_rejects_non_integer_sample_counts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    invalid,
):
    report = approved_evaluation_report()
    report["dataset"][field] = invalid
    report_path = tmp_path / "evaluation.json"
    report_path.write_text(json.dumps(report))
    manifest_path = write_manifest_for_report(tmp_path, report_path)
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")
    with pytest.raises(ModelPolicyError):
        FacePipeline(manifest_path)


def test_image_quality_is_pixel_derived_and_metadata_invariant():
    pipeline = FacePipeline("models/model-manifest.json")
    image = Image.new("RGB", (320, 240), color=(90, 140, 190))
    first = io.BytesIO()
    second = io.BytesIO()
    image.save(first, format="PNG", pnginfo=None)
    from PIL.PngImagePlugin import PngInfo

    metadata = PngInfo()
    metadata.add_text("audit-note", "metadata-only-change")
    image.save(second, format="PNG", pnginfo=metadata)

    first_quality = pipeline._image_quality_profile(first.getvalue(), [])
    second_quality = pipeline._image_quality_profile(second.getvalue(), [])

    assert first.getvalue() != second.getvalue()
    assert first_quality.perceptual_hash == second_quality.perceptual_hash
    assert first_quality.aggregate_score == second_quality.aggregate_score
    assert first_quality.estimated_width == second_quality.estimated_width == 320
    assert first_quality.estimated_height == second_quality.estimated_height == 240


def test_decode_image_applies_exif_orientation_before_geometry():
    image = Image.new("RGB", (320, 240), color=(40, 80, 120))
    exif = Image.Exif()
    exif[274] = 6  # Rotate 90 degrees clockwise for display.
    payload = io.BytesIO()
    image.save(payload, format="JPEG", exif=exif)

    decoded = decode_image(payload.getvalue())

    assert decoded.shape[:2] == (320, 240)  # height, width after transpose
