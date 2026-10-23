"""Numerical input regressions; no real identities or image data."""

import math

import pytest
from pydantic import ValidationError

from pictured_ml_face.embedding_contract import normalize_embedding_input
from pictured_ml_face.models import CandidateEmbedding, MatchRequest


@pytest.mark.parametrize(
    "value", [None, True, False, "1", {}, [], float("nan"), float("inf"), -float("inf")]
)
def test_non_numeric_components_are_rejected_before_coercion(value):
    vector = [1.0] + [0.0] * 127
    vector[1] = value
    with pytest.raises(ValidationError):
        MatchRequest(event_id="test", detected_face_id="test", embedding=vector, candidates=[])


@pytest.mark.parametrize("value", [[0] * 128, [1] * 127, [1] * 129, {}, None, True])
def test_zero_or_wrong_shape_is_rejected(value):
    with pytest.raises(ValidationError):
        CandidateEmbedding(user_id="synthetic", face_profile_id="synthetic", embedding=value)


@pytest.mark.parametrize("scale", [1, 1e300, 1e-300, -1e300, -1e-300])
def test_extreme_finite_scales_normalize_without_overflow(scale):
    vector = [scale] * 128
    snapshot = vector.copy()
    normalized = normalize_embedding_input(vector)
    assert vector == snapshot
    assert all(math.isfinite(component) for component in normalized)
    assert math.hypot(*normalized) == pytest.approx(1, abs=1e-12)


@pytest.mark.parametrize("value", [True, False, "0.42", float("nan"), float("inf"), -1, 2])
def test_thresholds_are_strict_finite_numbers(value):
    with pytest.raises(ValidationError):
        MatchRequest(
            event_id="test",
            detected_face_id="test",
            embedding=[1.0] + [0.0] * 127,
            candidates=[],
            threshold=value,
        )


def test_candidate_vector_validation_is_the_same_as_query_validation():
    with pytest.raises(ValidationError):
        MatchRequest(
            event_id="test",
            detected_face_id="test",
            embedding=[1.0] + [0.0] * 127,
            candidates=[
                {"user_id": "synthetic", "face_profile_id": "synthetic", "embedding": [True] * 128}
            ],
        )


def test_integers_and_floats_remain_supported():
    candidate = CandidateEmbedding(
        user_id="synthetic", face_profile_id="synthetic", embedding=[1] + [0.0] * 127
    )
    assert candidate.embedding == [1.0] + [0.0] * 127
