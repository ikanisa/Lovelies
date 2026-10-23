"""Strict JSON embedding contract, independent of ML models and image codecs.

Reject non-numeric/coerced/zero vectors before they reach float32 inference or
matching. Normalize with max-component scaling to avoid overflow/underflow.
"""

from __future__ import annotations

import math

EMBEDDING_DIMENSIONS = 128


def normalize_embedding_input(value: object) -> list[float]:
    if not isinstance(value, list) or len(value) != EMBEDDING_DIMENSIONS:
        raise ValueError(f"Embedding must contain exactly {EMBEDDING_DIMENSIONS} numbers")
    values: list[float] = []
    for component in value:
        # bool is a Python int subclass; neither booleans nor numeric strings qualify.
        if type(component) not in (int, float):
            raise ValueError("Embedding components must be JSON numbers")
        try:
            number = float(component)
        except (OverflowError, ValueError) as error:
            raise ValueError("Embedding components must be finite") from error
        if not math.isfinite(number):
            raise ValueError("Embedding components must be finite")
        values.append(number)
    scale = max(abs(component) for component in values)
    if scale == 0:
        raise ValueError("Embedding must be nonzero")
    scaled = [component / scale for component in values]
    norm = math.sqrt(math.fsum(component * component for component in scaled))
    return [component / norm for component in scaled]
