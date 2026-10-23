"""Codec-independent numerical matching, not authorization or biometric approval.

Keep float32 SFace distance arithmetic and existing threshold values. Explicitly
reject invalid policy/results and require a positive distinct-identity margin.
No image decoder, model asset, network call, logging, or gallery write is used.
"""

from __future__ import annotations

import math
import numpy as np
from pydantic import ValidationError

from pictured_ml_face.embedding_contract import EMBEDDING_DIMENSIONS
from pictured_ml_face.models import CandidateEmbedding, MatchDecision, MatchRequest, MatchResult

MAX_MATCH_CANDIDATES = 4096


def normalize(vector: np.ndarray) -> np.ndarray:
    values = np.asarray(vector, dtype=np.float64)
    norm = np.linalg.norm(values)
    if not np.isfinite(values).all() or not np.isfinite(norm) or norm <= 1e-12:
        raise ValueError("Embedding must be finite and nonzero")
    return (values / norm).astype(np.float32)


def _bounded_number(value: object, maximum: float, label: str) -> float:
    # Reject bool/string coercion and nonfinite defaults as well as request values.
    if type(value) not in (int, float):
        raise ValueError(f"Invalid {label}")
    try:
        number = float(value)
    except (ValueError, OverflowError) as error:
        raise ValueError(f"Invalid {label}") from error
    if not math.isfinite(number) or not 0 <= number <= maximum:
        raise ValueError(f"Invalid {label}")
    return number


class CosineVectorMatcher:
    version = "matcher.cosine-bounded-v2"

    def distance(self, left: np.ndarray, right: np.ndarray) -> float:
        left = np.asarray(left)
        right = np.asarray(right)
        if left.shape != (EMBEDDING_DIMENSIONS,) or right.shape != (EMBEDDING_DIMENSIONS,):
            raise ValueError("Expected two 128-dimensional embeddings")
        similarity = float(np.dot(normalize(left), normalize(right)))
        if not math.isfinite(similarity):
            raise ValueError("Invalid cosine similarity")
        # Unit float32 vectors can produce a dot product marginally outside [-1,1].
        # Clamp only this mathematical roundoff; do not change acceptance thresholds.
        return 1.0 - min(1.0, max(-1.0, similarity))


class ThresholdDecisionEngine:
    version = "decision.positive-identity-margin-v2"

    def decide(
        self, best_distance: float, margin: float, threshold: float, review_margin: float
    ) -> str:
        best_distance = _bounded_number(best_distance, 2.0, "match distance")
        margin = _bounded_number(margin, 2.0, "identity margin")
        threshold = _bounded_number(threshold, 1.0, "match threshold")
        review_margin = _bounded_number(review_margin, 1.0, "review margin")
        if best_distance > threshold:
            return "rejected"
        # Zero is ambiguous even when review_margin has deliberately been set to zero.
        if margin <= 0 or margin < review_margin:
            return "needs_review"
        return "auto_matched"


def _snapshot_request(request: MatchRequest) -> MatchRequest:
    if not isinstance(request, MatchRequest):
        raise ValueError("Expected a match request")
    if not isinstance(request.embedding, list) or len(request.embedding) != EMBEDDING_DIMENSIONS:
        raise ValueError("Invalid query embedding shape")
    if not isinstance(request.candidates, list) or len(request.candidates) > MAX_MATCH_CANDIDATES:
        raise ValueError("Invalid candidate collection")
    candidates = []
    for candidate in request.candidates:
        if not isinstance(candidate, CandidateEmbedding):
            raise ValueError("Invalid candidate record")
        if (
            not isinstance(candidate.embedding, list)
            or len(candidate.embedding) != EMBEDDING_DIMENSIONS
        ):
            raise ValueError("Invalid candidate embedding shape")
        candidates.append(
            {
                "user_id": candidate.user_id,
                "face_profile_id": candidate.face_profile_id,
                "embedding": candidate.embedding,
            }
        )
    # model_copy and validating an already-created model can bypass validation.
    # A field-limited dictionary revalidates nested vectors and creates owned lists;
    # do not serialize arbitrary extra fields or copy unbounded mutated collections.
    try:
        return MatchRequest.model_validate(
            {
                "event_id": request.event_id,
                "detected_face_id": request.detected_face_id,
                "embedding": request.embedding,
                "candidates": candidates,
                "threshold": request.threshold,
                "review_margin": request.review_margin,
            },
            strict=True,
        )
    except ValidationError:
        # An internal Pydantic traceback can otherwise include submitted vectors.
        raise ValueError("Invalid match request") from None


def match_candidates(
    request: MatchRequest,
    *,
    default_threshold: object = 0.42,
    default_review_margin: object = 0.05,
    matcher: CosineVectorMatcher | None = None,
    decision_engine: ThresholdDecisionEngine | None = None,
) -> MatchResult:
    """Rank only supplied candidates; a result never grants access or proves identity.

    The absent-runner-up bound remains 1.0 for source compatibility. Exact ties
    within one person choose a stable profile, but cross-person ties require review.
    Snapshotting protects cooperative caller reuse, not arbitrary concurrent threads.
    """
    request = _snapshot_request(request)
    threshold = _bounded_number(
        request.threshold if request.threshold is not None else default_threshold,
        1.0,
        "match threshold",
    )
    review_margin = _bounded_number(
        request.review_margin if request.review_margin is not None else default_review_margin,
        1.0,
        "review margin",
    )
    owners: dict[str, str] = {}
    for candidate in request.candidates:
        owner = owners.setdefault(candidate.face_profile_id, candidate.user_id)
        if owner != candidate.user_id:
            raise ValueError("Conflicting candidate profile identity")
    matcher = matcher if matcher is not None else CosineVectorMatcher()
    decision_engine = decision_engine if decision_engine is not None else ThresholdDecisionEngine()
    query = normalize(np.array(request.embedding, dtype=np.float32))
    best_per_user: dict[str, tuple[float, CandidateEmbedding]] = {}
    for candidate in request.candidates:
        candidate_vector = normalize(np.array(candidate.embedding, dtype=np.float32))
        distance = _bounded_number(matcher.distance(query, candidate_vector), 2.0, "match distance")
        previous = best_per_user.get(candidate.user_id)
        if previous is None or (distance, candidate.face_profile_id) < (
            previous[0],
            previous[1].face_profile_id,
        ):
            best_per_user[candidate.user_id] = (distance, candidate)
    if not best_per_user:
        return MatchResult(
            user_id=None,
            face_profile_id=None,
            score=0,
            margin=0,
            threshold=threshold,
            decision=MatchDecision.REJECTED,
            event_scope=request.event_id,
        )
    scored = sorted(
        best_per_user.values(), key=lambda item: (item[0], item[1].user_id, item[1].face_profile_id)
    )
    best_distance, best = scored[0]
    second_distance = scored[1][0] if len(scored) > 1 else 1.0
    score = min(1.0, max(0.0, 1.0 - best_distance))
    margin = max(0.0, second_distance - best_distance)
    decision = MatchDecision(
        decision_engine.decide(
            best_distance=best_distance,
            margin=margin,
            threshold=threshold,
            review_margin=review_margin,
        )
    )
    # Do not allow a custom numerical decision adapter to promote an identity tie.
    if margin == 0 and decision == MatchDecision.AUTO_MATCHED:
        decision = MatchDecision.NEEDS_REVIEW
    return MatchResult(
        user_id=best.user_id if decision != MatchDecision.REJECTED else None,
        face_profile_id=best.face_profile_id if decision != MatchDecision.REJECTED else None,
        score=score,
        margin=margin,
        threshold=threshold,
        decision=decision,
        event_scope=request.event_id,
    )


def rank_face_candidates(
    request: MatchRequest,
    *,
    default_threshold: object = 0.42,
    default_review_margin: object = 0.05,
    matcher: CosineVectorMatcher | None = None,
    decision_engine: ThresholdDecisionEngine | None = None,
) -> MatchResult:
    """Transport-facing ranking only; never promote numerical similarity to access.

    Reuse the validated snapshot and bounded numerical core. The API preserves the
    numerical decision separately while requiring the Worker's current evaluated
    policy and consent/gallery controls before automatic delivery.
    """
    result = match_candidates(
        request,
        default_threshold=default_threshold,
        default_review_margin=default_review_margin,
        matcher=matcher,
        decision_engine=decision_engine,
    )
    return result.model_copy(
        update={
            "numeric_decision": result.decision,
            "decision": (
                MatchDecision.NEEDS_REVIEW
                if result.decision == MatchDecision.AUTO_MATCHED
                else result.decision
            ),
            "reason_codes": ["ranking_only_requires_delivery_policy"],
        }
    )
