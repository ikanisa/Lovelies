"""Pixel-derived image diagnostics. Heuristics, never identity probabilities.

No raw-image or biometric logging. The dHash is a *candidate retrieval* signal,
not proof that two photos are duplicates. Exact byte identity uses SHA-256.
"""

from __future__ import annotations

import cv2
import numpy as np

PROCESSING_CONTRACT_VERSION = "canonical-upright-aligned-pixels-v2"
IMAGE_ANALYSIS_VERSION = "upright-pixel-metrics-v2"
PERCEPTUAL_HASH_ALGORITHM = "dhash-luma-upright-v1"


def _validate_image(image: np.ndarray) -> None:
    if (
        image.dtype != np.uint8
        or image.ndim != 3
        or image.shape[2] != 3
        or image.shape[0] < 1
        or image.shape[1] < 1
    ):
        raise ValueError("Expected a nonempty upright uint8 BGR image")


def difference_hash(image: np.ndarray) -> str:
    """64-bit dHash on upright luminance. Encoded metadata has no influence."""
    _validate_image(image)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    bits = small[:, 1:] > small[:, :-1]
    return f"{int.from_bytes(np.packbits(bits, bitorder='big').tobytes(), 'big'):016x}"


def image_diagnostics(image: np.ndarray, face_scores: list[float]) -> dict[str, object]:
    _validate_image(image)
    if any(not np.isfinite(score) or not 0 <= score <= 1 for score in face_scores):
        raise ValueError("Face quality scores must be finite and between zero and one")
    height, width = image.shape[:2]
    # Bound diagnostic work without changing detection or recognition pixels.
    scale = min(1.0, 1024 / max(width, height))
    sample = (
        image
        if scale == 1
        else cv2.resize(
            image,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    )
    gray = cv2.cvtColor(sample, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean = float(gray.mean()) / 255
    clipping = float(((gray <= 5) | (gray >= 250)).mean())
    # These are image diagnostics; they must not reject identities by complexion.
    blur = sharpness / (sharpness + 180)
    exposure = max(0.0, min(1.0, (1 - abs(mean - 0.5) * 1.6) * (1 - clipping)))
    residual = cv2.absdiff(gray, cv2.medianBlur(gray, 3))
    noise = max(0.0, 1 - float(residual.mean()) / 255 * 8)
    means = sample.reshape(-1, 3).mean(axis=0) / 255
    color = max(0.0, 1 - float(means.max() - means.min()) * 2)
    resolution = min(1.0, width * height / 8_000_000)
    face_quality = sum(face_scores) / len(face_scores) if face_scores else 0.0
    metrics = [blur, exposure, noise, color, resolution]
    if face_scores:
        metrics.append(face_quality)
    flags = [
        label
        for value, label in [
            (blur, "blur_risk"),
            (exposure, "exposure_risk"),
            (noise, "noise_risk"),
            (color, "color_balance_risk"),
        ]
        if value < 0.72
    ]
    if face_scores and face_quality < 0.78:
        flags.append("face_quality_risk")
    if resolution < 0.8:
        flags.append("print_resolution_risk")
    return {
        "aggregate_score": round(sum(metrics) / len(metrics), 4),
        "blur_score": round(blur, 4),
        "exposure_score": round(exposure, 4),
        "noise_score": round(noise, 4),
        "color_balance_score": round(color, 4),
        "face_quality_score": round(face_quality, 4),
        "printability_score": round(resolution, 4),
        "flags": flags,
        "perceptual_hash": difference_hash(image),
        "perceptual_hash_algorithm": PERCEPTUAL_HASH_ALGORITHM,
        "estimated_width": width,
        "estimated_height": height,
        "measurement_version": IMAGE_ANALYSIS_VERSION,
        "calibration_status": "heuristic_not_calibrated",
    }
