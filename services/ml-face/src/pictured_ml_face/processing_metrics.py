"""Per-request aggregate timings. No global mutable counters, images or identities."""

from __future__ import annotations
from contextlib import contextmanager
import math
import time
from typing import Callable, Iterator

STAGES = ("decode", "detect", "align", "embed", "face_quality", "image_quality", "metadata")
COUNTERS = (
    "detections",
    "alignment_rejections",
    "embedding_rejections",
    "faces_emitted",
    "views_executed",
    "detector_input_pixels",
    "candidates_seen",
    "invalid_candidates",
    "duplicates_suppressed",
)


class ProcessingMetrics:
    def __init__(self, clock: Callable[[], int] = time.perf_counter_ns):
        self._clock = clock
        self._started = clock()
        self._elapsed = {key: 0 for key in STAGES}
        self._counts = {key: 0 for key in COUNTERS}
        self.face_limit_reached = False

    @contextmanager
    def stage(self, key: str) -> Iterator[None]:
        if key not in STAGES:
            raise ValueError("Unknown processing stage")
        started = self._clock()
        try:
            yield
        finally:
            self._elapsed[key] += max(0, self._clock() - started)

    def count(self, key: str, value: int = 1) -> None:
        if key not in COUNTERS or type(value) is not int or value < 0:
            raise ValueError("Invalid processing count")
        self._counts[key] += value

    def report(self, profile: str, *, synthetic: bool) -> dict[str, object]:
        from pictured_ml_face.detection_strategy import validate_profile, profile_fingerprint

        validate_profile(profile)
        if type(synthetic) is not bool:
            raise ValueError("Synthetic marker must be boolean")

        def millis(value: int) -> float:
            result = value / 1_000_000
            if not math.isfinite(result):
                raise ValueError("Invalid timing")
            return round(max(0.0, result), 3)

        outcome = (
            "faces_processed"
            if self._counts["faces_emitted"]
            else "no_usable_faces"
            if self._counts["detections"]
            else "no_detections"
        )
        return {
            "schema_version": "photo-processing-diagnostics-v1",
            "detection_profile": profile,
            "detection_profile_sha256": profile_fingerprint(profile),
            "synthetic": synthetic,
            "stage_ms": {k: millis(v) for k, v in self._elapsed.items()},
            "total_ms": millis(max(0, self._clock() - self._started)),
            "counts": dict(self._counts),
            "face_limit_reached": self.face_limit_reached,
            "outcome": outcome,
            "quality_gate_applied": False,
            "timing_scope": "local_decode_to_response_construction_not_queue_or_network",
        }
