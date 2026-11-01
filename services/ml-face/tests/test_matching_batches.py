"""Bounded matching over synthetic vectors; no recognition-quality claim."""
from __future__ import annotations

import math
import numpy as np
import pytest

from pictured_ml_face.models import CandidateEmbedding, MatchDecision, MatchRequest
from pictured_ml_face.vector_matching import match_candidates, rank_candidate_distances


def vector(distance):
    similarity = 1 - distance
    return [similarity, math.sqrt(1 - similarity * similarity)] + [0.0] * 126


def request(candidates):
    return MatchRequest(event_id='synthetic', detected_face_id='face', embedding=[1.0] + [0.0] * 127, candidates=candidates)


def identity(index, distance):
    return CandidateEmbedding(user_id=f'user-{index:06}', face_profile_id=f'profile-{index:06}', embedding=vector(distance))


@pytest.mark.parametrize('count', [999, 1000, 1001, 4096])
def test_every_candidate_contributes_to_same_global_distinct_top_two(count):
    candidates = [identity(i, .1 if i == count - 1 else .12 if i == 0 else .8) for i in range(count)]
    complete = rank_candidate_distances(request(candidates))
    retained = []
    for offset in range(0, count, 128):
        retained = sorted(retained + rank_candidate_distances(request(candidates[offset:offset + 128])),
                          key=lambda item: (item[0], item[1].user_id, item[1].face_profile_id))[:2]
    assert [(d, c.user_id) for d, c in retained] == [(d, c.user_id) for d, c in complete]
    assert retained[0][1].user_id == f'user-{count - 1:06}'
    assert match_candidates(request(candidates)).decision == MatchDecision.NEEDS_REVIEW
    assert match_candidates(request(candidates[:128])).decision == MatchDecision.AUTO_MATCHED


def test_three_reference_poses_are_one_identity_not_three_runner_ups():
    candidates = [identity(1, .1), identity(1, .11), identity(1, .12), identity(2, .4)]
    ranked = rank_candidate_distances(request(candidates))
    assert [c.user_id for _, c in ranked] == ['user-000001', 'user-000002']
    assert ranked[0][0] == pytest.approx(.1, abs=1e-6)


def test_cross_page_exact_tie_stays_ambiguous_in_both_orders():
    a, b = identity(1, .1), identity(2, .1)
    for rows in [[a, b], [b, a]]:
        result = match_candidates(request(rows))
        assert result.margin == 0 and result.decision == MatchDecision.NEEDS_REVIEW
        assert [c.user_id for _, c in rank_candidate_distances(request(rows))] == ['user-000001', 'user-000002']


def test_page_distance_output_remains_finite_and_bounded():
    for distance in [0, 1, 2]:
        ranked = rank_candidate_distances(request([identity(1, distance)]))
        assert np.isfinite(ranked[0][0]) and 0 <= ranked[0][0] <= 2
    assert rank_candidate_distances(request([])) == []
