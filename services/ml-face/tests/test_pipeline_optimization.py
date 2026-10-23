"""Wired pipeline checks with controlled detectors/embedders, not face accuracy."""

import io
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image
import pytest
from pictured_ml_face.components import (
    AlignedFace,
    FaceDetection,
    OpenCvYuNetDetector,
    OpenCvSFaceAligner,
)
from pictured_ml_face.detection_strategy import LANDMARKS
from pictured_ml_face.models import PhotoProcessRequest
from pictured_ml_face.pipeline import FacePipeline, ModelPolicyError


def image_bytes():
    out = io.BytesIO()
    Image.new("RGB", (1600, 1200), (90, 110, 130)).save(out, format="PNG")
    return out.getvalue()


def request():
    return PhotoProcessRequest(
        event_id="synthetic-event",
        asset_id="synthetic-asset",
        object_key="",
        content_type="image/png",
    )


def fake_pipeline(monkeypatch, profile="reference-v1"):
    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "true")
    p = FacePipeline("models/model-manifest.json", detection_profile=profile)
    p.using_deterministic_simulator = False

    class Detector(OpenCvYuNetDetector):
        def __init__(self):
            self.calls = []

        def detect_decoded(self, pixels):
            self.calls.append(pixels.shape)
            return [
                FaceDetection(
                    {"x": 10, "y": 10, "width": 60, "height": 60},
                    {k: [30.0, 30.0] for k in LANDMARKS},
                    0.99,
                )
            ]

    class Aligner(OpenCvSFaceAligner):
        def __init__(self):
            self.original_shapes = []
            self.outputs = []

        def align_decoded(self, pixels, face):
            self.original_shapes.append(pixels.shape)
            aligned = AlignedFace(
                face.bbox, face.landmarks, b"", np.full((112, 112, 3), 42, dtype=np.uint8)
            )
            self.outputs.append(aligned)
            return aligned

    class Embedder:
        version = "controlled-test-v1"

        def embed(self, aligned, _):
            assert np.all(aligned.pixels == 42)
            v = np.zeros(128)
            v[0] = 1
            return v

    class Quality:
        version = "controlled-quality-v1"

        def score(self, _, aligned):
            assert np.all(aligned.pixels == 42)
            return 0.9

    p.detector = Detector()
    p.aligner = Aligner()
    p.embedding_model = Embedder()
    p.quality_scorer = Quality()
    return p


@pytest.mark.parametrize("profile", ["reference-v1", "bounded-v1", "group-v1"])
def test_profile_is_wired_and_alignment_uses_original_pixels(monkeypatch, profile):
    p = fake_pipeline(monkeypatch, profile)
    result = p.process_photo_bytes(request(), image_bytes())
    assert result.faces
    assert all(shape == (1200, 1600, 3) for shape in p.aligner.original_shapes)
    assert all(np.count_nonzero(a.pixels) == 0 for a in p.aligner.outputs)
    metrics = result.image_metadata["processing_diagnostics"]
    assert metrics["detection_profile"] == profile
    assert metrics["counts"]["faces_emitted"] == len(result.faces)
    assert metrics["counts"]["views_executed"] == (5 if profile == "group-v1" else 1)
    if profile != "reference-v1":
        assert all(max(shape[:2]) <= 1280 for shape in p.detector.calls)
        assert result.image_metadata["evaluation_status"] == "optimization_candidate"
        assert all(
            f.module_versions["evaluation_status"] == "optimization_candidate" for f in result.faces
        )
        assert all("approved_decision_policy" not in f.module_versions for f in result.faces)
    else:
        assert p.detector.calls == [(1200, 1600, 3)]


def test_invalid_profile_fails_configuration(monkeypatch):
    monkeypatch.setenv("ML_DETECTION_PROFILE", "unknown")
    with pytest.raises(ModelPolicyError, match="configuration"):
        FacePipeline("models/model-manifest.json")


def test_candidate_profile_cannot_reuse_approved_report(monkeypatch):
    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "false")
    monkeypatch.setattr(
        FacePipeline,
        "_enforce_production_evidence",
        lambda p: setattr(p, "evaluation_status", "approved"),
    )
    with pytest.raises(ModelPolicyError, match="cannot reuse"):
        FacePipeline("models/model-manifest.json", detection_profile="group-v1")


def test_bad_face_embedding_does_not_erase_other_faces(monkeypatch):
    p = fake_pipeline(monkeypatch)
    original = p.detector.detect_decoded

    def two(pixels):
        first = original(pixels)[0]
        second = deepcopy(first)
        second.bbox["x"] = 200
        return [first, second]

    p.detector.detect_decoded = two
    embed = p.embedding_model.embed

    def sometimes(aligned, event):
        if aligned.bbox["x"] == 10:
            raise ValueError("unusable embedding")
        return embed(aligned, event)

    p.embedding_model.embed = sometimes
    result = p.process_photo_bytes(request(), image_bytes())
    assert len(result.faces) == 1
    assert result.image_metadata["processing_diagnostics"]["counts"]["embedding_rejections"] == 1
    assert all(np.count_nonzero(a.pixels) == 0 for a in p.aligner.outputs)


def test_no_usable_face_does_not_masquerade_as_no_detection(monkeypatch):
    p = fake_pipeline(monkeypatch)

    def failed(*_):
        raise ValueError("bad alignment")

    p.aligner.align_decoded = failed
    result = p.process_photo_bytes(request(), image_bytes())
    assert not result.faces
    assert result.image_metadata["processing_diagnostics"]["outcome"] == "no_usable_faces"
    assert result.image_metadata["processing_diagnostics"]["counts"]["alignment_rejections"] == 1


def test_fatal_inference_error_is_not_swallowed(monkeypatch):
    p = fake_pipeline(monkeypatch)

    def failed(*_):
        raise RuntimeError("engine failed")

    p.embedding_model.embed = failed
    with pytest.raises(RuntimeError):
        p.process_photo_bytes(request(), image_bytes())
    assert all(np.count_nonzero(a.pixels) == 0 for a in p.aligner.outputs)


def test_concurrent_metrics_do_not_accumulate_between_requests(monkeypatch):
    p = fake_pipeline(monkeypatch)
    data = image_bytes()
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: p.process_photo_bytes(request(), data), range(6)))
    assert all(
        r.image_metadata["processing_diagnostics"]["counts"]["faces_emitted"] == 1 for r in results
    )
    assert all(
        r.image_metadata["processing_diagnostics"]["counts"]["views_executed"] == 1 for r in results
    )


def test_native_detector_rejects_nonfinite_rows_before_integer_cast(monkeypatch):
    p = OpenCvYuNetDetector.__new__(OpenCvYuNetDetector)
    import threading

    p._lock = threading.Lock()

    class Detector:
        def setInputSize(self, _):
            pass

        def detect(self, _):
            good = np.array([10, 10, 20, 20, *([15.0, 15.0] * 5), 0.9], dtype=np.float32)
            bad = good.copy()
            bad[0] = np.nan
            return None, np.stack([bad, good])

    p.detector = Detector()
    result = p.detect_decoded(np.zeros((100, 100, 3), dtype=np.uint8))
    assert len(result) == 1 and result[0].bbox["x"] == 10
