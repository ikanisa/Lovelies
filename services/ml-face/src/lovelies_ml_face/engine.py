"""Lovelies policy over the pinned account-free OpenFace still-image runtime.

The child owns decoding/native inference only. Supabase owns accounts, signed
capture verification, consent, eligibility and grants. This is a new reference
space: an old model name alone never establishes template compatibility.
"""
from __future__ import annotations

import atexit
import hashlib
import json
import math
import os
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
from openface_still import PlatformError, StillImagePolicy, StillImageRuntime

from pictured_ml_face.image_contract import ImageValidationError
from pictured_ml_face.model_integrity import load_manifest_object, select_active_model
from pictured_ml_face.vector_matching import rank_face_candidates

MODEL = "opencv-yunet-sface-2021dec-v1"
ENGINE_SPACE = "lovelies-sface-openface-still-v1"
POLICY = StillImagePolicy(
    max_encoded_bytes=20 * 1024 * 1024,
    max_decoded_pixels=40_000_000,
    max_faces=100,
    detector_score=0.80,
    detector_top_k=100,
    decode_max_edge=None,
    analysis_max_edge=None,
    min_face_pixels=0,
    min_image_edge=1,
    clamp_boxes_before_alignment=True,
)


def aligned_quality(pixels: np.ndarray) -> float:
    """Preserve Lovelies' aligned-pixel formula, independently of engine quality."""
    gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
    sharpness = min(1.0, float(cv2.Laplacian(gray, cv2.CV_64F).var()) / 500.0)
    mean_brightness = float(gray.mean()) / 255.0
    exposure = max(0.0, 1.0 - abs(mean_brightness - 0.52) / 0.52)
    return round(max(0.0, min(1.0, sharpness * 0.65 + exposure * 0.35)), 4)


class OpenFacePipeline:
    def __init__(self, manifest_path: str | Path):
        if os.environ.get("ML_USE_DETERMINISTIC_SIMULATOR", "").lower() == "true":
            raise RuntimeError("Lovelies requires real still-image inference")
        self.manifest_path = Path(manifest_path).resolve()
        manifest = load_manifest_object(self.manifest_path)
        self.active_model = select_active_model(manifest)
        self.manifest = SimpleNamespace(active_model_version=manifest["active_model_version"])
        if self.active_model["version"] != MODEL:
            raise RuntimeError("Unsupported Lovelies model")
        # A report for the preserved implementation cannot approve this new
        # reference space. Local engineering remains available without approval.
        self.deployment_mode = os.environ.get("ML_DEPLOYMENT_MODE", "development")
        production = (os.environ.get("APP_ENV") == "production" or
                      os.environ.get("CLOUDFLARE_ENV") == "production" or
                      os.environ.get("ML_REQUIRE_MODEL_ARTIFACTS") == "true" or
                      self.deployment_mode == "fully_evaluated")
        if production and self.deployment_mode != "monitored_pilot":
            raise RuntimeError("New inference space requires its own recognition evaluation")
        self.evaluation_status = "monitored_pilot" if self.deployment_mode == "monitored_pilot" else "not_evaluated"
        self.using_deterministic_simulator = False
        self.runtime = StillImageRuntime(
            self.manifest_path.parent,
            policy=POLICY,
            threads=1,
            deadline_seconds=40,
            boot_deadline_seconds=60,
            max_workers=1,
        )
        self.identity = dict(self.runtime.identity)
        auth_distance = float(os.environ.get("FACE_AUTH_MAX_COSINE_DISTANCE", "0.35"))
        if not math.isfinite(auth_distance) or not 0 < auth_distance <= 0.42:
            self.close()
            raise RuntimeError("Invalid registered-face comparison threshold")
        package_root = Path(__file__).parents[1]
        # Bind the consumer policy and numerical/validation implementation too;
        # OpenFace's own identity alone cannot describe Lovelies' decisions.
        consumer_files = (
            "lovelies_ml_face/engine.py", "lovelies_ml_face/app.py",
            "pictured_ml_face/vector_matching.py", "pictured_ml_face/embedding_contract.py",
            "pictured_ml_face/models.py",
        )
        contract = {
            "contract": ENGINE_SPACE,
            "core_processing_fingerprint": self.identity["processing_fingerprint"],
            "auth_distance": auth_distance,
            "photo_distance": 0.42,
            "photo_distinct_identity_margin": 0.05,
            "quality": "opencv-laplacian-brightness-quality-v1",
            "quality_minimum": 0.25,
            "source_sha256": {name: hashlib.sha256((package_root / name).read_bytes()).hexdigest()
                              for name in consumer_files},
        }
        self.identity["core_processing_fingerprint"] = self.identity["processing_fingerprint"]
        self.identity["processing_fingerprint"] = hashlib.sha256(json.dumps(
            contract, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode()).hexdigest()
        self.artifact_integrity = "verified"
        atexit.register(self.close)

    def close(self):
        self.runtime.close()

    def ready(self) -> bool:
        return self.runtime.probe() is True

    def process_photo_bytes(self, request, raw: bytes):
        try:
            result = self.runtime.analyze(raw, content_type=request.content_type)
        except PlatformError as error:
            # Only bounded decoder/format errors become a capture retry. A
            # crashed, timed-out or unavailable engine remains a service failure.
            if error.code in {"invalid_image", "image_too_large", "image_content_type_mismatch"}:
                raise ImageValidationError("Image bytes do not meet the still-image contract") from None
            raise
        faces = []
        try:
            for face in result.faces:
                faces.append(SimpleNamespace(
                    bbox=face.bbox, landmarks=face.landmarks,
                    detection_confidence=face.confidence,
                    quality_score=aligned_quality(face.aligned_pixels),
                    embedding=face.embedding,
                ))
            return SimpleNamespace(faces=faces, width=result.width, height=result.height)
        finally:
            for face in result.faces:
                face.aligned_pixels.fill(0)

    def match_face(self, request):
        return rank_face_candidates(request, default_threshold=0.42, default_review_margin=0.05)
