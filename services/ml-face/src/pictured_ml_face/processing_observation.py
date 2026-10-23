"""Request-local aggregate wall timings. Never records image bytes or identities.

Times include waiting for shared inference locks, not just CPU execution. They do
not include HTTP parsing, response serialization or network transit. They are
operational measurements, never recognition scores or release approval.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from time import perf_counter_ns

PHOTO_RESULT_CONTRACT = "lovelies-photo-result-v2"
TRACE_CONTRACT = "aggregate-processing-stages-v2"
STAGES = ("decode", "detect", "align", "embed", "face_quality", "image_quality", "metadata")
COUNTERS = (
    "faces_considered",
    "alignment_failures",
    "embedding_failures",
    "faces_aligned",
    "embeddings_created",
    "faces_emitted",
)


class ProcessingObservation:
    def __init__(self, clock: Callable[[], int] = perf_counter_ns) -> None:
        self._clock = clock
        self._started = clock()
        self._durations = dict.fromkeys(STAGES, 0)
        self._counts = dict.fromkeys(COUNTERS, 0)

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        if name not in self._durations:
            raise ValueError("unknown_processing_stage")
        start = self._clock()
        try:
            yield
        finally:
            self._durations[name] += max(0, self._clock() - start)

    def increment(self, name: str, amount: int = 1) -> None:
        if name not in self._counts or type(amount) is not int or amount < 0:
            raise ValueError("invalid_processing_counter")
        if self._counts[name] + amount > 100:
            raise ValueError("processing_counter_limit")
        self._counts[name] += amount

    def snapshot(self) -> dict[str, object]:
        return {
            "contract_version": TRACE_CONTRACT,
            "total_ms": round(max(0, self._clock() - self._started) / 1_000_000, 3),
            "stage_ms": {
                name: round(value / 1_000_000, 3) for name, value in self._durations.items()
            },
            "counts": dict(self._counts),
        }


def trace_from_diagnostics(diagnostics: dict[str, object]) -> dict[str, object]:
    """Project the reference and candidate pipeline's single measurement source.

    No second timer/counter set is incremented. Embedding rejection is distinct
    from alignment rejection, so an unusable face cannot hide a valid neighbour.
    This is for internally produced diagnostics, not untrusted HTTP input.
    """
    counts = diagnostics["counts"]
    considered = counts["detections"]
    alignment_failures = counts["alignment_rejections"]
    embedding_failures = counts["embedding_rejections"]
    aligned = considered - alignment_failures
    emitted = counts["faces_emitted"]
    if (
        any(
            type(v) is not int or not 0 <= v <= 100
            for v in (considered, alignment_failures, embedding_failures, aligned, emitted)
        )
        or aligned != emitted + embedding_failures
    ):
        raise ValueError("inconsistent_processing_diagnostics")
    return {
        "contract_version": TRACE_CONTRACT,
        "total_ms": diagnostics["total_ms"],
        "stage_ms": dict(diagnostics["stage_ms"]),
        "counts": {
            "faces_considered": considered,
            "alignment_failures": alignment_failures,
            "embedding_failures": embedding_failures,
            "faces_aligned": aligned,
            "embeddings_created": emitted,
            "faces_emitted": emitted,
        },
    }
