from __future__ import annotations

import hashlib
import threading
from io import BytesIO
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from pictured_ml_face.vector_matching import (
    CosineVectorMatcher as CosineVectorMatcher,
    ThresholdDecisionEngine as ThresholdDecisionEngine,
    normalize as normalize,
)
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

from pictured_ml_face.image_contract import (
    MAX_DECODED_IMAGE_PIXELS as MAX_DECODED_IMAGE_PIXELS,
    MAX_FACES_PER_IMAGE as MAX_FACES_PER_IMAGE,
    IMAGE_FORMAT_CONTENT_TYPES as IMAGE_FORMAT_CONTENT_TYPES,
    ImageValidationError as ImageValidationError,
    ImageContentTypeMismatchError as ImageContentTypeMismatchError,
    FaceDetection as FaceDetection,
    AlignedFace as AlignedFace,
)

register_heif_opener()


class FaceDetector(Protocol):
    version: str

    def detect(self, image_bytes: bytes) -> list[FaceDetection]: ...


class FaceAligner(Protocol):
    version: str

    def align(self, image_bytes: bytes, detection: FaceDetection) -> AlignedFace: ...


class QualityScorer(Protocol):
    version: str

    def score(self, image_bytes: bytes, aligned: AlignedFace) -> float: ...


class EmbeddingModel(Protocol):
    version: str

    def embed(self, aligned: AlignedFace, event_id: str) -> np.ndarray: ...


class VectorMatcher(Protocol):
    version: str

    def distance(self, left: np.ndarray, right: np.ndarray) -> float: ...


class DecisionEngine(Protocol):
    version: str

    def decide(
        self, best_distance: float, margin: float, threshold: float, review_margin: float
    ) -> str: ...


class DeterministicFaceDetector:
    version = "detector.local-deterministic.v1"

    def detect(self, image_bytes: bytes) -> list[FaceDetection]:
        if not image_bytes:
            return []
        return [
            FaceDetection(
                bbox={"x": 120, "y": 80, "width": 320, "height": 320},
                landmarks={
                    "left_eye": [205.0, 188.0],
                    "right_eye": [356.0, 188.0],
                    "nose": [280.0, 258.0],
                    "mouth_left": [222.0, 330.0],
                    "mouth_right": [342.0, 330.0],
                },
                confidence=0.99,
            )
        ]


class LandmarkFaceAligner:
    version = "aligner.landmark-sim.v1"

    def align(self, image_bytes: bytes, detection: FaceDetection) -> AlignedFace:
        crop_seed = (
            jsonish(detection.bbox).encode()
            + b":"
            + jsonish(detection.landmarks).encode()
            + b":"
            + image_bytes
        )
        return AlignedFace(
            bbox=detection.bbox,
            landmarks=detection.landmarks,
            crop_bytes=hashlib.sha256(crop_seed).digest(),
        )


class HashQualityScorer:
    version = "quality.hash-v1"

    def score(self, image_bytes: bytes, _aligned: AlignedFace) -> float:
        digest = hashlib.sha256(image_bytes).digest()
        return round(0.72 + (digest[0] / 255.0) * 0.2, 4)


class DeterministicEmbeddingModel:
    version = "embedding.local-deterministic-128.v1"

    def embed(self, aligned: AlignedFace, event_id: str) -> np.ndarray:
        seed = hashlib.sha512(event_id.encode() + b":" + aligned.crop_bytes).digest()
        values = np.frombuffer(seed * 2, dtype=np.uint8)[:128].astype(np.float32)
        vector = (values / 255.0) - 0.5
        return normalize(vector)


class OpenCvYuNetDetector:
    version = "opencv-yunet-2023mar-v1"

    def __init__(self, model_path: str | Path) -> None:
        self.model_path = str(model_path)
        self.detector = cv2.FaceDetectorYN.create(
            self.model_path,
            "",
            (320, 320),
            score_threshold=0.80,
            nms_threshold=0.30,
            top_k=MAX_FACES_PER_IMAGE,
        )
        self._lock = threading.Lock()

    def detect(self, image_bytes: bytes) -> list[FaceDetection]:
        return self.detect_decoded(decode_image(image_bytes))

    def detect_decoded(self, image: np.ndarray) -> list[FaceDetection]:
        height, width = image.shape[:2]
        with self._lock:
            self.detector.setInputSize((width, height))
            _, faces = self.detector.detect(image)
            if faces is not None:
                faces = faces.copy()
        if faces is None:
            return []
        detections: list[FaceDetection] = []
        for face in faces:
            if (
                len(face) != 15
                or not np.isfinite(face).all()
                or face[2] <= 0
                or face[3] <= 0
                or not 0 <= face[14] <= 1
            ):
                continue
            x, y, width_value, height_value = face[:4]
            left = max(0, min(width, int(np.floor(x))))
            top = max(0, min(height, int(np.floor(y))))
            right = max(0, min(width, int(np.ceil(x + width_value))))
            bottom = max(0, min(height, int(np.ceil(y + height_value))))
            if right <= left or bottom <= top:
                continue
            landmarks = {
                "right_eye": [float(face[4]), float(face[5])],
                "left_eye": [float(face[6]), float(face[7])],
                "nose": [float(face[8]), float(face[9])],
                "mouth_right": [float(face[10]), float(face[11])],
                "mouth_left": [float(face[12]), float(face[13])],
            }
            detections.append(
                FaceDetection(
                    bbox={
                        "x": left,
                        "y": top,
                        "width": right - left,
                        "height": bottom - top,
                    },
                    landmarks=landmarks,
                    confidence=float(face[14]),
                )
            )
        return detections


class OpenCvSFaceAligner:
    version = "opencv-sface-align-crop-2021dec-v1"

    def __init__(self, model_path: str | Path) -> None:
        self.recognizer = cv2.FaceRecognizerSF.create(str(model_path), "")
        self._lock = threading.Lock()

    def align(self, image_bytes: bytes, detection: FaceDetection) -> AlignedFace:
        return self.align_decoded(decode_image(image_bytes), detection)

    def align_decoded(self, image: np.ndarray, detection: FaceDetection) -> AlignedFace:
        face_row = detection_row(detection)
        if not np.isfinite(face_row).all():
            raise ValueError("Face landmarks are invalid")
        try:
            with self._lock:
                aligned = self.recognizer.alignCrop(image, face_row).copy()
        except cv2.error as error:
            # A bounding-box crop is not the approved five-point alignment.
            raise ValueError("Face alignment failed") from error
        if aligned.shape != (112, 112, 3):
            raise ValueError("Face alignment returned an invalid shape")
        return AlignedFace(
            bbox=detection.bbox,
            landmarks=detection.landmarks,
            crop_bytes=b"",
            pixels=aligned,
        )


class OpenCvSFaceEmbeddingModel:
    version = "opencv-sface-2021dec-128-v1"

    def __init__(self, model_path: str | Path) -> None:
        self.recognizer = cv2.FaceRecognizerSF.create(str(model_path), "")
        self._lock = threading.Lock()

    def embed(self, aligned: AlignedFace, _event_id: str) -> np.ndarray:
        image = aligned.pixels if aligned.pixels is not None else decode_image(aligned.crop_bytes)
        # OpenCV DNN inference mutates the shared network and may reuse its
        # output buffer. Keep inference and the owned copy in one critical section.
        with self._lock:
            feature = self.recognizer.feature(image)
            vector = np.array(feature, dtype=np.float32, copy=True).reshape(-1)
        if vector.size != 128 or not np.isfinite(vector).all():
            raise ValueError("OpenCV SFace returned an invalid embedding")
        return normalize(vector)


class OpenCvQualityScorer:
    version = "opencv-laplacian-brightness-quality-v1"

    def score(self, _image_bytes: bytes, aligned: AlignedFace) -> float:
        image = aligned.pixels if aligned.pixels is not None else decode_image(aligned.crop_bytes)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        sharpness = min(1.0, float(cv2.Laplacian(gray, cv2.CV_64F).var()) / 500.0)
        mean_brightness = float(gray.mean()) / 255.0
        exposure = max(0.0, 1.0 - abs(mean_brightness - 0.52) / 0.52)
        return round(max(0.0, min(1.0, sharpness * 0.65 + exposure * 0.35)), 4)


def validate_image_bytes(image_bytes: bytes, declared_content_type: str) -> dict[str, object]:
    _image, metadata = decode_validated_image(image_bytes, declared_content_type)
    return metadata


def decode_validated_image(
    image_bytes: bytes, declared_content_type: str
) -> tuple[np.ndarray, dict[str, object]]:
    """Validate the format and return one upright decode plus actual geometry."""
    declared_content_type = declared_content_type.strip().lower()
    try:
        with Image.open(BytesIO(image_bytes), formats=list(IMAGE_FORMAT_CONTENT_TYPES)) as encoded_image:
            width, height = encoded_image.size
            if width <= 0 or height <= 0 or width * height > MAX_DECODED_IMAGE_PIXELS:
                raise ImageValidationError(
                    f"Decoded image exceeds {MAX_DECODED_IMAGE_PIXELS} pixels"
                )
            image_format = str(encoded_image.format or "").upper()
            allowed_content_types = IMAGE_FORMAT_CONTENT_TYPES.get(image_format)
            if not allowed_content_types:
                raise ImageValidationError("Image format is not supported")
            if declared_content_type not in allowed_content_types:
                raise ImageContentTypeMismatchError(
                    "Declared content type does not match decoded image format"
                )
            encoded_image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        if isinstance(error, ImageValidationError):
            raise
        raise ImageValidationError("Image bytes could not be decoded") from error
    if width <= 0 or height <= 0 or width * height > MAX_DECODED_IMAGE_PIXELS:
        raise ImageValidationError(f"Decoded image exceeds {MAX_DECODED_IMAGE_PIXELS} pixels")
    decoded = decode_image(image_bytes)
    height, width = decoded.shape[:2]
    return decoded, {
        "content_type": declared_content_type,
        "format": image_format,
        "height": height,
        "width": width,
    }


def decode_image(image_bytes: bytes) -> np.ndarray:
    try:
        with Image.open(BytesIO(image_bytes), formats=list(IMAGE_FORMAT_CONTENT_TYPES)) as encoded_image:
            width, height = encoded_image.size
            if width <= 0 or height <= 0 or width * height > MAX_DECODED_IMAGE_PIXELS:
                raise ImageValidationError(
                    f"Decoded image exceeds {MAX_DECODED_IMAGE_PIXELS} pixels"
                )
            # Canonicalize EXIF orientation before any detector/alignment stage so
            # server geometry matches the upright image users see on mobile.
            upright_image = ImageOps.exif_transpose(encoded_image)
            width, height = upright_image.size
            if width <= 0 or height <= 0 or width * height > MAX_DECODED_IMAGE_PIXELS:
                raise ImageValidationError(
                    f"Decoded image exceeds {MAX_DECODED_IMAGE_PIXELS} pixels"
                )
            rgb_image = np.asarray(upright_image.convert("RGB"), dtype=np.uint8)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        if isinstance(error, ImageValidationError):
            raise
        raise ImageValidationError("Image bytes could not be decoded") from error
    if rgb_image.size == 0:
        raise ImageValidationError("Image bytes could not be decoded")
    return cv2.cvtColor(rgb_image, cv2.COLOR_RGB2BGR)


def detection_row(detection: FaceDetection) -> np.ndarray:
    bbox = detection.bbox
    landmarks = detection.landmarks
    values = [
        float(bbox["x"]),
        float(bbox["y"]),
        float(bbox["width"]),
        float(bbox["height"]),
        *landmarks["right_eye"],
        *landmarks["left_eye"],
        *landmarks["nose"],
        *landmarks["mouth_right"],
        *landmarks["mouth_left"],
        float(detection.confidence),
    ]
    return np.asarray(values, dtype=np.float32)


def fallback_face_crop(image: np.ndarray, detection: FaceDetection) -> np.ndarray:
    image_height, image_width = image.shape[:2]
    x = detection.bbox["x"]
    y = detection.bbox["y"]
    width = detection.bbox["width"]
    height = detection.bbox["height"]
    padding = int(round(max(width, height) * 0.18))
    left = max(0, x - padding)
    top = max(0, y - padding)
    right = min(image_width, x + width + padding)
    bottom = min(image_height, y + height + padding)
    crop = image[top:bottom, left:right]
    if crop.size == 0:
        raise ValueError("Detected face crop was empty")
    return cv2.resize(crop, (112, 112), interpolation=cv2.INTER_CUBIC)


def jsonish(value: object) -> str:
    return str(value).replace("'", '"')
