"""Bounded YuNet image views; candidate modes are NOT approved for auto-delivery.

No model weights, thresholds or recognition inputs are changed. Alignment always
uses the original upright pixels. The default reference path is unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from typing import Callable

import cv2
import numpy as np

from pictured_ml_face.image_contract import (
    FaceDetection,
    MAX_DECODED_IMAGE_PIXELS,
    MAX_FACES_PER_IMAGE,
)

REFERENCE_PROFILE = "reference-v1"
PROFILES = (REFERENCE_PROFILE, "bounded-v1", "group-v1")
VIEW_EDGE = 1280
TILE_EDGE = 960
MERGE_IOU = 0.35
LANDMARKS = ("right_eye", "left_eye", "nose", "mouth_right", "mouth_left")


@dataclass(frozen=True)
class DetectionView:
    x: int
    y: int
    width: int
    height: int
    target_width: int
    target_height: int

    @property
    def pixels(self) -> int:
        return self.target_width * self.target_height


def validate_profile(value: object) -> str:
    if not isinstance(value, str) or value not in PROFILES:
        raise ValueError("Unsupported ML detection profile")
    return value


def profile_descriptor(profile: str) -> dict[str, object]:
    validate_profile(profile)
    return {
        "version": "bounded-original-coordinate-views-v1",
        "profile": profile,
        "overview_max_edge": None if profile == REFERENCE_PROFILE else VIEW_EDGE,
        "tile_max_edge": TILE_EDGE if profile == "group-v1" else None,
        "tile_layout": "2x2-overlap-60percent" if profile == "group-v1" else None,
        "merge_iou": MERGE_IOU if profile != REFERENCE_PROFILE else None,
        "maximum_views": 5 if profile == "group-v1" else 1,
        "maximum_output_faces": MAX_FACES_PER_IMAGE,
        "interpolation": "opencv-inter-area",
        "alignment_source": "original-upright-pixels",
    }


def profile_fingerprint(profile: str) -> str:
    encoded = json.dumps(profile_descriptor(profile), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("ascii")).hexdigest()


def _fit(width: int, height: int, edge: int) -> tuple[int, int]:
    scale = min(1.0, edge / max(width, height))
    return max(1, math.floor(width * scale)), max(1, math.floor(height * scale))


def plan_views(width: int, height: int, profile: str) -> tuple[DetectionView, ...]:
    validate_profile(profile)
    if type(width) is not int or type(height) is not int or min(width, height) <= 0:
        raise ValueError("Image dimensions must be positive integers")
    if width * height > MAX_DECODED_IMAGE_PIXELS:
        raise ValueError("Image dimensions exceed processing budget")
    tw, th = (width, height) if profile == REFERENCE_PROFILE else _fit(width, height, VIEW_EDGE)
    views = [DetectionView(0, 0, width, height, tw, th)]
    if profile == "group-v1" and max(width, height) > VIEW_EDGE:
        # Four overlapping complete-coverage tiles; no unbounded sliding window.
        cw, ch = max(1, math.ceil(width * 0.6)), max(1, math.ceil(height * 0.6))
        target = _fit(cw, ch, TILE_EDGE)
        for y in (0, height - ch):
            for x in (0, width - cw):
                view = DetectionView(x, y, cw, ch, *target)
                if view not in views:
                    views.append(view)
    return tuple(views)


def project_detection(
    face: FaceDetection, view: DetectionView, width: int, height: int
) -> FaceDetection | None:
    """Return a validated, clipped full-image box and full-image landmarks."""
    try:
        values = [face.bbox[k] for k in ("x", "y", "width", "height")]
        points = [face.landmarks[k] for k in LANDMARKS]
        all_values = values + [face.confidence] + [v for point in points for v in point]
        if (
            any(len(p) != 2 for p in points)
            or any(
                isinstance(v, (bool, np.bool_))
                or not isinstance(v, (int, float, np.number))
                or not math.isfinite(float(v))
                for v in all_values
            )
            or not 0 <= face.confidence <= 1
        ):
            return None
        x, y, w, h = map(float, values)
        if w <= 0 or h <= 0:
            return None
        sx, sy = view.width / view.target_width, view.height / view.target_height
        left = max(0, min(width, math.floor(view.x + x * sx)))
        top = max(0, min(height, math.floor(view.y + y * sy)))
        right = max(0, min(width, math.ceil(view.x + (x + w) * sx)))
        bottom = max(0, min(height, math.ceil(view.y + (y + h) * sy)))
        if right <= left or bottom <= top:
            return None
        mapped = {
            k: [view.x + p[0] * sx, view.y + p[1] * sy]
            for k, p in zip(LANDMARKS, points, strict=True)
        }
        if any(not (0 <= p[0] <= width and 0 <= p[1] <= height) for p in mapped.values()):
            return None
        return FaceDetection(
            {"x": left, "y": top, "width": right - left, "height": bottom - top},
            mapped,
            float(face.confidence),
        )
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        return None


def intersection_over_union(left: FaceDetection, right: FaceDetection) -> float:
    a, b = left.bbox, right.bbox
    iw = max(0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
    ih = max(0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    intersection = iw * ih
    union = a["width"] * a["height"] + b["width"] * b["height"] - intersection
    return intersection / union if union > 0 else 0.0


@dataclass(frozen=True)
class DetectionBatch:
    faces: list[FaceDetection]
    views_executed: int
    detector_input_pixels: int
    candidates_seen: int
    invalid_candidates: int
    duplicates_suppressed: int
    face_limit_reached: bool


def detect_views(
    image: np.ndarray, profile: str, detect_decoded: Callable[[np.ndarray], list[FaceDetection]]
) -> DetectionBatch:
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.ndim != 3
        or image.shape[2] != 3
    ):
        raise ValueError("Detector requires upright uint8 three-channel pixels")
    height, width = image.shape[:2]
    views = plan_views(width, height, profile)
    if profile == REFERENCE_PROFILE:
        faces = detect_decoded(image)
        return DetectionBatch(
            faces[:MAX_FACES_PER_IMAGE],
            1,
            width * height,
            len(faces),
            0,
            0,
            len(faces) >= MAX_FACES_PER_IMAGE,
        )
    candidates: list[FaceDetection] = []
    seen = invalid = pixels = 0
    saturated = False
    for view in views:
        crop = image[view.y : view.y + view.height, view.x : view.x + view.width]
        # Own only the bounded detector buffer, not a duplicate of full-size pixels.
        resized = (
            cv2.resize(crop, (view.target_width, view.target_height), interpolation=cv2.INTER_AREA)
            if (view.width, view.height) != (view.target_width, view.target_height)
            else np.ascontiguousarray(crop)
        )
        owned = not np.shares_memory(resized, image)
        try:
            rows = detect_decoded(resized)
            if not isinstance(rows, list) or len(rows) > MAX_FACES_PER_IMAGE:
                raise ValueError("Detector output exceeds bounded candidate contract")
            saturated |= len(rows) == MAX_FACES_PER_IMAGE
            seen += len(rows)
            for row in rows:
                projected = project_detection(row, view, width, height)
                if projected is None:
                    invalid += 1
                else:
                    candidates.append(projected)
            pixels += view.pixels
        finally:
            if owned:
                resized.fill(0)
    # Highest confidence wins. Exact ties are resolved by geometry then landmarks,
    # not SDK response order. No averaged/synthesized landmark coordinates.
    candidates.sort(
        key=lambda f: (
            -f.confidence,
            *(f.bbox[k] for k in ("x", "y", "width", "height")),
            *(v for k in LANDMARKS for v in f.landmarks[k]),
        )
    )
    accepted: list[FaceDetection] = []
    suppressed = dropped = 0
    for face in candidates:
        if any(intersection_over_union(face, old) > MERGE_IOU for old in accepted):
            suppressed += 1
        elif len(accepted) < MAX_FACES_PER_IMAGE:
            accepted.append(face)
        else:
            dropped += 1
    return DetectionBatch(
        accepted, len(views), pixels, seen, invalid, suppressed, saturated or dropped > 0
    )
