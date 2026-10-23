"""Shared image limits and value types, independent of codec/model initialization.

These definitions are reexported by components.py for existing callers. Moving
value types here does not replace HEIF decoding or relax service startup checks.
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np

MAX_DECODED_IMAGE_PIXELS = 40_000_000
MAX_FACES_PER_IMAGE = 100
IMAGE_FORMAT_CONTENT_TYPES = {
    "JPEG": {"image/jpeg"},
    "PNG": {"image/png"},
    "WEBP": {"image/webp"},
    "HEIF": {"image/heic", "image/heif"},
}


class ImageValidationError(ValueError):
    code = "invalid_image_content"


class ImageContentTypeMismatchError(ImageValidationError):
    code = "image_content_type_mismatch"


@dataclass(frozen=True)
class FaceDetection:
    bbox: dict[str, int]
    landmarks: dict[str, list[float]]
    confidence: float


@dataclass(frozen=True)
class AlignedFace:
    bbox: dict[str, int]
    landmarks: dict[str, list[float]]
    crop_bytes: bytes
    # Owned upright aligned pixels avoid lossy encode/decode between stages.
    pixels: np.ndarray | None = None
