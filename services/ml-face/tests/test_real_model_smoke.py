from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import pytest

from pictured_ml_face.components import AlignedFace, OpenCvSFaceEmbeddingModel
from pictured_ml_face.pipeline import FacePipeline, ModelPolicyError


def test_real_opencv_models_load_and_emit_normalized_embedding(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "false")
    pipeline = FacePipeline("models/model-manifest.json")

    image = np.zeros((112, 112, 3), dtype=np.uint8)
    for row in range(112):
        image[row, :, 0] = row * 2
    encoded, crop = cv2.imencode(".jpg", image)
    assert encoded

    embedding = pipeline.embedding_model.embed(
        AlignedFace(
            bbox={"x": 0, "y": 0, "width": 112, "height": 112},
            landmarks={},
            crop_bytes=crop.tobytes(),
        ),
        "real-model-smoke",
    )

    assert pipeline.module_versions["detector"] == "opencv-yunet-2023mar-v1"
    assert pipeline.module_versions["embedding_model"] == "opencv-sface-2021dec-128-v1"
    assert embedding.shape == (128,)
    assert np.isfinite(embedding).all()
    assert np.linalg.norm(embedding) == pytest.approx(1.0, abs=1e-6)


def test_deterministic_simulator_is_rejected_in_production(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "true")
    monkeypatch.setenv("APP_ENV", "production")

    with pytest.raises(ModelPolicyError, match="forbidden in production"):
        FacePipeline("models/model-manifest.json")


def test_concurrent_embedding_requests_keep_their_own_input_and_output(monkeypatch):
    class SharedNetwork:
        def __init__(self):
            self.current_input = 0
            self.output = np.zeros((1, 128), dtype=np.float32)

        def feature(self, image):
            self.current_input = int(image[0, 0, 0])
            time.sleep(0.01)  # Native inference releases the GIL.
            self.output.fill(0)
            self.output[0, self.current_input] = 1
            return self.output

    network = SharedNetwork()
    monkeypatch.setattr(cv2.FaceRecognizerSF, "create", lambda *_: network)
    monkeypatch.setattr(
        "pictured_ml_face.components.decode_image",
        lambda data: np.full((2, 2, 3), data[0], dtype=np.uint8),
    )
    model = OpenCvSFaceEmbeddingModel("unused.onnx")
    inputs = [AlignedFace(bbox={}, landmarks={}, crop_bytes=bytes([i])) for i in range(12)]
    with ThreadPoolExecutor(max_workers=4) as executor:
        vectors = list(executor.map(lambda aligned: model.embed(aligned, "qa"), inputs))
    for index, vector in enumerate(vectors):
        assert np.argmax(vector) == index
        assert np.linalg.norm(vector) == pytest.approx(1)
