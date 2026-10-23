"""Actual codec-independent matching code; synthetic vectors, not face accuracy.

The two adapter checks extract declarations from production source. They do NOT
import/start the image pipeline, HEIF codec, FastAPI application or model weights.
"""

from __future__ import annotations

import ast
import copy
import itertools
import math
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
from pydantic import ValidationError
import pytest

from pictured_ml_face.models import CandidateEmbedding, MatchDecision, MatchRequest, MatchResult
from pictured_ml_face.vector_matching import (
    CosineVectorMatcher,
    ThresholdDecisionEngine,
    match_candidates,
    rank_face_candidates,
    normalize,
)


def vector(axis=0, sign=1.0):
    value = [0.0] * 128
    value[axis] = sign
    return value


def candidate(user="a", profile="a-1", embedding=None):
    return CandidateEmbedding(
        user_id=user,
        face_profile_id=profile,
        embedding=vector() if embedding is None else embedding,
    )


def request(candidates=None, **kwargs):
    return MatchRequest(
        event_id="synthetic-event",
        detected_face_id="synthetic-face",
        embedding=vector(),
        candidates=[candidate()] if candidates is None else candidates,
        **kwargs,
    )


def test_clear_single_candidate_remains_automatic_and_scoped():
    result = match_candidates(request())
    assert result.decision == MatchDecision.AUTO_MATCHED
    assert result.user_id == "a" and result.face_profile_id == "a-1"
    assert result.score == 1 and result.margin == 1
    assert result.event_scope == "synthetic-event"


def test_empty_candidates_reject_without_an_identity():
    result = match_candidates(request([]))
    assert result.decision == MatchDecision.REJECTED
    assert result.user_id is None and result.face_profile_id is None
    assert result.score == 0 and result.margin == 0


def test_opposite_vector_is_rejected_not_a_negative_score():
    result = match_candidates(request([candidate(embedding=vector(sign=-1))]))
    assert result.decision == MatchDecision.REJECTED
    assert result.user_id is None and result.score == 0


@pytest.mark.parametrize("review_margin", [0.0, 0.05])
@pytest.mark.parametrize("reverse", [False, True])
def test_cross_identity_ties_are_review_only_independent_of_order(review_margin, reverse):
    rows = [candidate("b", "b-1"), candidate("a", "a-1")]
    if reverse:
        rows.reverse()
    result = match_candidates(request(rows, review_margin=review_margin))
    assert result.decision == MatchDecision.NEEDS_REVIEW
    assert result.margin == 0 and result.user_id == "a"


def test_same_person_poses_are_not_competitors_and_choose_stable_profile():
    rows = [candidate("a", "a-2"), candidate("a", "a-1"), candidate("b", "b-1", vector(1))]
    for permutation in itertools.permutations(rows):
        result = match_candidates(request(list(permutation)))
        assert result.decision == MatchDecision.AUTO_MATCHED
        assert result.user_id == "a" and result.face_profile_id == "a-1" and result.margin == 1


def test_better_pose_is_selected_even_when_its_id_sorts_later():
    result = match_candidates(
        request([candidate("a", "a-1", vector(1)), candidate("a", "z", vector())])
    )
    assert result.face_profile_id == "z"


def test_equal_identity_distances_above_acceptance_threshold_are_rejected():
    result = match_candidates(
        request(
            [candidate("a", "a-1", vector(1)), candidate("b", "b-1", vector(1))], review_margin=0
        )
    )
    assert result.decision == MatchDecision.REJECTED and result.user_id is None


def test_no_evidence_of_positive_margin_requires_review_at_max_threshold():
    result = match_candidates(
        request([candidate(embedding=vector(1))], threshold=1.0, review_margin=0)
    )
    assert result.margin == 0 and result.decision == MatchDecision.NEEDS_REVIEW


@pytest.mark.parametrize(
    "values,expected",
    [
        ((0.42, 0.05, 0.42, 0.05), "auto_matched"),
        ((0.43, 0.9, 0.42, 0.05), "rejected"),
        ((0.1, 0.049, 0.42, 0.05), "needs_review"),
        ((0.1, 0, 0.42, 0), "needs_review"),
        ((0, 1, 0, 0), "auto_matched"),
        ((1, 0, 1, 0), "needs_review"),
    ],
)
def test_engine_preserves_threshold_boundaries_but_requires_separation(values, expected):
    assert ThresholdDecisionEngine().decide(*values) == expected


@pytest.mark.parametrize("field", ["threshold", "review_margin"])
@pytest.mark.parametrize("bad", [True, False, "0.42", math.nan, math.inf, -0.1, 1.1])
def test_manifest_defaults_cannot_bypass_finite_policy(field, bad):
    with pytest.raises(ValueError):
        match_candidates(request(), **{"default_" + field: bad})


def test_explicit_policy_overrides_unused_defaults():
    result = match_candidates(
        request(threshold=0.42, review_margin=0.05),
        default_threshold=None,
        default_review_margin=None,
    )
    assert result.decision == MatchDecision.AUTO_MATCHED


@pytest.mark.parametrize(
    "field,index", [("best_distance", 0), ("margin", 1), ("threshold", 2), ("review_margin", 3)]
)
def test_engine_rejects_nonfinite_numbers_in_every_position(field, index):
    args = [0.1, 0.5, 0.42, 0.05]
    args[index] = math.nan
    with pytest.raises(ValueError):
        ThresholdDecisionEngine().decide(*args)


@pytest.mark.parametrize("bad", [True, "0.42", math.nan, math.inf, -1, 2])
def test_mutated_request_policy_is_revalidated(bad):
    value = request()
    value.threshold = bad
    with pytest.raises(ValueError):
        match_candidates(value)


@pytest.mark.parametrize("bad", [True, "1.0", math.nan, math.inf, None])
def test_mutated_candidate_components_are_not_silently_coerced(bad):
    value = request()
    value.candidates[0].embedding[1] = bad
    with pytest.raises(ValueError):
        match_candidates(value)


def test_mutated_candidate_bound_is_checked_before_copying():
    value = request()
    value.candidates = [candidate()] * 4097
    with pytest.raises(ValueError, match="candidate collection"):
        match_candidates(value)


def test_wrong_query_shape_is_rejected_before_scoring():
    value = request()
    value.embedding = [1.0]
    with pytest.raises(ValueError):
        match_candidates(value)


def test_conflicting_profile_owners_are_rejected_before_scoring():
    class NeverScore(CosineVectorMatcher):
        def distance(self, *_):
            pytest.fail("invalid identity set reached scoring")

    with pytest.raises(ValueError, match="Conflicting candidate profile identity"):
        match_candidates(
            request([candidate("a", "shared"), candidate("b", "shared")]), matcher=NeverScore()
        )


def test_exact_same_profile_duplicates_do_not_create_ambiguity():
    assert (
        match_candidates(request([candidate(), candidate()])).decision == MatchDecision.AUTO_MATCHED
    )


def test_snapshots_protect_caller_reuse_during_scoring():
    value = request([candidate("a", "a-1"), candidate("b", "b-1", vector(1))])

    class ReusingMatcher(CosineVectorMatcher):
        def distance(self, left, right):
            value.event_id = "other-event"
            value.candidates.clear()
            value.embedding[0] = -1
            return super().distance(left, right)

    result = match_candidates(value, matcher=ReusingMatcher())
    assert result.user_id == "a" and result.event_scope == "synthetic-event" and result.margin == 1


def test_normal_call_leaves_request_untouched():
    value = request()
    before = copy.deepcopy(value.model_dump())
    match_candidates(value)
    assert value.model_dump() == before


@pytest.mark.parametrize("bad", [math.nan, math.inf, -0.1, 2.1, True, "0.1"])
def test_invalid_matcher_results_fail_closed(bad):
    class BrokenMatcher(CosineVectorMatcher):
        def distance(self, *_):
            return bad

    with pytest.raises(ValueError):
        match_candidates(request(), matcher=BrokenMatcher())


def test_custom_decision_adapter_cannot_promote_a_tie():
    class UnsafeDecision(ThresholdDecisionEngine):
        def decide(self, **_):
            return "auto_matched"

    result = match_candidates(
        request([candidate("a", "a-1"), candidate("b", "b-1")], review_margin=0),
        decision_engine=UnsafeDecision(),
    )
    assert result.decision == MatchDecision.NEEDS_REVIEW


@pytest.mark.parametrize("dot,expected", [(1.0000001192092896, 0.0), (-1.0000001192092896, 2.0)])
def test_float32_roundoff_stays_inside_cosine_range(monkeypatch, dot, expected):
    monkeypatch.setattr(np, "dot", lambda *_: dot)
    assert CosineVectorMatcher().distance(np.array(vector()), np.array(vector())) == expected


def test_numerical_cosines_are_bounded_with_real_numpy():
    rng = np.random.default_rng(812)
    matcher = CosineVectorMatcher()
    for _ in range(256):
        value = rng.normal(size=128)
        assert 0 <= matcher.distance(value, value) <= 2
        assert 0 <= matcher.distance(value, -value) <= 2


def test_matching_requires_flat_128_dimensional_vectors():
    with pytest.raises(ValueError):
        CosineVectorMatcher().distance(np.ones((1, 128)), np.ones((128, 1)))


def test_image_embedding_normalization_preserves_previous_float32_arithmetic():
    rng = np.random.default_rng(100)
    for _ in range(32):
        value = rng.normal(size=128)
        prior = (value.astype(np.float64) / np.linalg.norm(value.astype(np.float64))).astype(
            np.float32
        )
        assert np.array_equal(normalize(value), prior)


@pytest.mark.parametrize(
    "field,bad",
    [
        ("score", math.nan),
        ("score", 1.00001),
        ("score", -0.1),
        ("margin", math.inf),
        ("margin", 2.1),
        ("threshold", 1.1),
    ],
)
def test_match_result_cannot_serialize_invalid_numeric_values(field, bad):
    values = dict(
        user_id="a",
        face_profile_id="a-1",
        score=1.0,
        margin=0.5,
        threshold=0.42,
        decision=MatchDecision.AUTO_MATCHED,
        event_scope="synthetic",
    )
    values[field] = bad
    with pytest.raises(ValidationError):
        MatchResult(**values)


def test_vector_core_import_does_not_load_image_models_codecs_or_server():
    script = """import sys
import pictured_ml_face.vector_matching
assert not {'pillow_heif','cv2','pictured_ml_face.components','pictured_ml_face.pipeline','pictured_ml_face.main'} & sys.modules.keys()
"""
    subprocess.run([sys.executable, "-c", script], check=True, timeout=15)


def test_actual_pipeline_method_delegates_to_the_checked_core():
    source = Path(__file__).parents[1] / "src/pictured_ml_face/pipeline.py"
    node = next(
        n
        for n in ast.parse(source.read_text()).body
        if isinstance(n, ast.ClassDef) and n.name == "FacePipeline"
    )
    method = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "match_face")
    namespace = dict(
        MatchRequest=MatchRequest,
        MatchResult=MatchResult,
        rank_face_candidates=rank_face_candidates,
    )
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), namespace)
    owner = SimpleNamespace(
        active_model={"default_threshold": 0.42, "review_margin": 0},
        vector_matcher=CosineVectorMatcher(),
        decision_engine=ThresholdDecisionEngine(),
    )
    result = namespace["match_face"](owner, request([candidate("a", "a-1"), candidate("b", "b-1")]))
    assert result.decision == MatchDecision.NEEDS_REVIEW


def test_components_reexport_the_same_classes_and_normalizer():
    source = Path(__file__).parents[1] / "src/pictured_ml_face/components.py"
    module = ast.parse(source.read_text())
    imports = [
        n
        for n in module.body
        if isinstance(n, ast.ImportFrom) and n.module == "pictured_ml_face.vector_matching"
    ]
    namespace = {}
    exec(compile(ast.Module(body=imports, type_ignores=[]), str(source), "exec"), namespace)
    assert namespace["CosineVectorMatcher"] is CosineVectorMatcher
    assert namespace["ThresholdDecisionEngine"] is ThresholdDecisionEngine
    assert namespace["normalize"] is normalize
    assert not any(
        isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in namespace for n in module.body
    )


def test_internal_validation_failure_does_not_echo_candidate_payload():
    value = request()
    value.candidates[0].embedding[1] = "PRIVATE-SYNTHETIC-MARKER"
    with pytest.raises(ValueError) as caught:
        match_candidates(value)
    import traceback

    detail = "".join(traceback.format_exception(caught.value))
    assert str(caught.value) == "Invalid match request"
    assert "PRIVATE-SYNTHETIC-MARKER" not in detail


def test_checked_in_manifest_describes_the_executed_matching_modules():
    import json

    manifest = json.loads((Path(__file__).parents[1] / "models/model-manifest.json").read_text())
    active = next(
        row for row in manifest["models"] if row["version"] == manifest["active_model_version"]
    )
    assert active["modules"]["vector_matcher"] == CosineVectorMatcher.version
    assert active["modules"]["decision_engine"] == ThresholdDecisionEngine.version
    result = match_candidates(
        request(),
        default_threshold=active["default_threshold"],
        default_review_margin=active["review_margin"],
    )
    assert result.threshold == active["default_threshold"]


@pytest.mark.parametrize(
    "candidates,threshold,margin,numeric,effective",
    [
        ([candidate()], 0.42, 0.05, MatchDecision.AUTO_MATCHED, MatchDecision.NEEDS_REVIEW),
        (
            [candidate("a", "a1"), candidate("b", "b1")],
            0.42,
            0,
            MatchDecision.NEEDS_REVIEW,
            MatchDecision.NEEDS_REVIEW,
        ),
        ([], 0.42, 0.05, MatchDecision.REJECTED, MatchDecision.REJECTED),
        (
            [candidate(embedding=vector(sign=-1))],
            0.42,
            0.05,
            MatchDecision.REJECTED,
            MatchDecision.REJECTED,
        ),
    ],
)
def test_transport_ranking_preserves_bounded_numerics_without_access_authority(
    candidates, threshold, margin, numeric, effective
):
    value = request(candidates, threshold=threshold, review_margin=margin)
    scored = match_candidates(value)
    ranked = rank_face_candidates(value)
    assert ranked.numeric_decision == numeric
    assert ranked.decision == effective
    assert ranked.authorization_effect == "none"
    assert ranked.reason_codes == ["ranking_only_requires_delivery_policy"]
    for field in ("score", "margin", "threshold", "event_scope", "user_id", "face_profile_id"):
        assert getattr(ranked, field) == getattr(scored, field)
    assert 0 <= ranked.score <= 1 and 0 <= ranked.margin <= 2


def test_transport_ranking_revalidates_a_mutated_model():
    value = request()
    value.embedding[0] = float("nan")
    with pytest.raises(ValueError):
        rank_face_candidates(value)


def test_transport_contract_matches_worker_approval_version():
    from pictured_ml_face.evaluation_contract import DECISION_CONTRACT

    assert rank_face_candidates(request()).decision_contract_version == DECISION_CONTRACT
