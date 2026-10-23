"""Offline, scoped 1:N reference evaluation of already-produced embeddings.

No HTTP, model download, image retention, identity lookup, gallery write or release
approval occurs. Exact float64 reference search is NOT hosted pgvector/ANN parity.
Input identifiers must be pseudonyms. Output contains aggregate counts only.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import math
import re
from statistics import NormalDist
from typing import Any

import numpy as np

from pictured_ml_face.embedding_contract import normalize_embedding_input
from pictured_ml_face.evaluation_contract import (
    DECISION_CONTRACT,
    PROCESSING_CONTRACT,
    SEARCH_CONTRACT,
    EvaluationContractError,
    compact_policy,
    decision_policy,
    sha256,
    unit_score,
    valid_sha256,
)

INPUT_LIMIT = 32 * 1024 * 1024
MAX_COMPARISONS = 2_000_000
MAX_ROWS = 10_000
MAX_POLICIES = 100
SCHEMA = "lovelies-scoped-1n-input-v2"


def require(condition: bool, code: str) -> None:
    if not condition:
        raise EvaluationContractError(code)


def keys(value: Any, required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    require(isinstance(value, dict), "object_required")
    require(
        set(value).issuperset(required) and set(value).issubset(required | optional),
        "unexpected_or_missing_fields",
    )
    return value


def token(value: Any) -> str:
    require(
        isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value) is not None,
        "pseudonymous_identifier_required",
    )
    return value


def vector(value: Any) -> list[float]:
    try:
        return normalize_embedding_input(value)
    except (ValueError, TypeError, OverflowError):
        raise EvaluationContractError("invalid_evaluation_embedding") from None


@dataclass(frozen=True)
class PreparedDataset:
    raw: dict[str, Any]
    galleries: dict[str, list[dict[str, Any]]]
    probes: list[dict[str, Any]]
    subjects: frozenset[str]
    captures: frozenset[str]
    events: frozenset[str]
    comparisons: int


def prepare_dataset(value: dict[str, Any]) -> PreparedDataset:
    keys(
        value,
        {
            "schema_version",
            "dataset_kind",
            "partition",
            "dataset_id",
            "model_version",
            "model_checksum_sha256",
            "processing_contract_version",
            "consent_reviewed",
            "policy",
            "galleries",
            "probes",
        },
    )
    require(value["schema_version"] == SCHEMA, "unsupported_evaluation_schema")
    require(value["dataset_kind"] in ("synthetic", "consented_study"), "dataset_kind_invalid")
    require(value["partition"] in ("calibration", "holdout"), "partition_invalid")
    token(value["dataset_id"])
    token(value["model_version"])
    require(valid_sha256(value["model_checksum_sha256"]), "model_checksum_invalid")
    require(
        value["processing_contract_version"] == PROCESSING_CONTRACT, "processing_contract_mismatch"
    )
    require(type(value["consent_reviewed"]) is bool, "consent_evidence_invalid")
    require(
        value["dataset_kind"] == "synthetic" or value["consent_reviewed"] is True,
        "consented_study_requires_review",
    )
    decision_policy(value["policy"])
    require(
        isinstance(value["galleries"], list) and 1 <= len(value["galleries"]) <= 1000,
        "gallery_count_invalid",
    )
    require(
        isinstance(value["probes"], list) and 1 <= len(value["probes"]) <= MAX_ROWS,
        "probe_count_invalid",
    )
    galleries: dict[str, list[dict[str, Any]]] = {}
    gallery_events: dict[str, str] = {}
    templates_seen: set[str] = set()
    probe_ids: set[str] = set()
    captures: set[str] = set()
    template_captures: set[str] = set()
    probe_captures: set[str] = set()
    subjects: set[str] = set()
    events: set[str] = set()
    confidence_by_subject: dict[str, str] = {}
    templates_total = 0
    for gallery in value["galleries"]:
        keys(gallery, {"scope_id", "event_id", "templates"})
        scope = token(gallery["scope_id"])
        event = token(gallery["event_id"])
        require(scope not in galleries, "duplicate_gallery_scope")
        gallery_events[scope] = event
        events.add(event)
        rows = gallery["templates"]
        require(isinstance(rows, list) and 1 <= len(rows) <= MAX_ROWS, "template_count_invalid")
        templates_total += len(rows)
        require(templates_total <= MAX_ROWS, "template_count_invalid")
        prepared: list[dict[str, Any]] = []
        for row in rows:
            keys(row, {"subject_id", "template_id", "capture_id", "confidence", "embedding"})
            subject = token(row["subject_id"])
            template = token(row["template_id"])
            capture = token(row["capture_id"])
            require(template not in templates_seen, "duplicate_template_id")
            templates_seen.add(template)
            require(row["confidence"] in ("high", "medium"), "profile_confidence_invalid")
            require(
                subject not in confidence_by_subject
                or confidence_by_subject[subject] == row["confidence"],
                "profile_confidence_inconsistent",
            )
            confidence_by_subject[subject] = row["confidence"]
            prepared.append({**row, "embedding": vector(row["embedding"])})
            subjects.add(subject)
            template_captures.add(capture)
            captures.add(capture)
        galleries[scope] = prepared
    comparisons = 0
    probes: list[dict[str, Any]] = []
    seen_capture_subject: set[tuple[str, str]] = set()
    probe_capture_events: dict[str, str] = {}
    for row in value["probes"]:
        keys(
            row,
            {
                "probe_id",
                "scope_id",
                "event_id",
                "subject_id",
                "capture_id",
                "embedding",
                "quality",
                "detection_confidence",
                "face_area_ratio",
                "failure",
            },
        )
        probe = token(row["probe_id"])
        scope = token(row["scope_id"])
        event = token(row["event_id"])
        subject = token(row["subject_id"])
        capture = token(row["capture_id"])
        require(probe not in probe_ids, "duplicate_probe_id")
        require((capture, subject) not in seen_capture_subject, "duplicate_capture_subject_probe")
        seen_capture_subject.add((capture, subject))
        probe_ids.add(probe)
        require(scope in galleries, "unknown_gallery_scope")
        require(event == gallery_events[scope], "probe_gallery_event_mismatch")
        require(
            capture not in probe_capture_events or probe_capture_events[capture] == event,
            "probe_capture_event_inconsistent",
        )
        probe_capture_events[capture] = event
        events.add(event)
        require(
            all(
                unit_score(row[key])
                for key in ("quality", "detection_confidence", "face_area_ratio")
            ),
            "probe_quality_invalid",
        )
        if row["embedding"] is None:
            require(
                row["failure"]
                in ("no_face", "alignment_failed", "embedding_failed", "quality_rejected"),
                "missing_embedding_requires_failure_reason",
            )
            embedding = None
        else:
            require(row["failure"] is None, "unexpected_extraction_failure")
            embedding = vector(row["embedding"])
            comparisons += len(galleries[scope])
        require(comparisons <= MAX_COMPARISONS, "comparison_budget_exceeded")
        probes.append({**row, "embedding": embedding})
        probe_captures.add(capture)
        captures.add(capture)
        subjects.add(subject)
    require(not (template_captures & probe_captures), "enrollment_probe_capture_overlap")
    return PreparedDataset(
        value,
        galleries,
        probes,
        frozenset(subjects),
        frozenset(captures),
        frozenset(events),
        comparisons,
    )


def check_holdout(calibration: PreparedDataset, holdout: PreparedDataset) -> None:
    require(
        calibration.raw["partition"] == "calibration" and holdout.raw["partition"] == "holdout",
        "split_roles_invalid",
    )
    require(calibration.raw["dataset_id"] != holdout.raw["dataset_id"], "split_id_reused")
    require(calibration.raw["dataset_kind"] == holdout.raw["dataset_kind"], "split_kind_mismatch")
    for field in ("model_version", "model_checksum_sha256", "processing_contract_version"):
        require(calibration.raw[field] == holdout.raw[field], "split_model_contract_mismatch")
    require(not (calibration.subjects & holdout.subjects), "calibration_holdout_subject_overlap")
    require(not (calibration.captures & holdout.captures), "calibration_holdout_capture_overlap")
    require(not (calibration.events & holdout.events), "calibration_holdout_event_overlap")
    # Label/provenance assertions are supplied by the data custodian, not independently
    # authenticated by this tool. Reusing pixels under different IDs is not detected.
    require(
        decision_policy(calibration.raw["policy"]) == decision_policy(holdout.raw["policy"]),
        "holdout_policy_not_frozen",
    )


def rate(successes: int, total: int) -> dict[str, Any]:
    """Two-sided Wilson 95%, uncorrected; assumes independent Bernoulli probes."""
    require(
        type(successes) is int and type(total) is int and 0 <= successes <= total,
        "metric_count_invalid",
    )
    if total == 0:
        return {"numerator": 0, "denominator": 0, "rate": None, "wilson95": None}
    p = successes / total
    z = NormalDist().inv_cdf(0.975)
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return {
        "numerator": successes,
        "denominator": total,
        "rate": p,
        "wilson95": [max(0.0, centre - half), min(1.0, centre + half)],
    }


def rank_probes(dataset: PreparedDataset) -> list[dict[str, Any]]:
    """Complete authorized scope, best template per identity, then distance<=1/top20."""
    matrices = {
        scope: np.asarray([row["embedding"] for row in rows], dtype=np.float64)
        for scope, rows in dataset.galleries.items()
    }
    result = []
    for probe in dataset.probes:
        rows = dataset.galleries[probe["scope_id"]]
        known = any(row["subject_id"] == probe["subject_id"] for row in rows)
        best_by_person: dict[str, dict[str, Any]] = {}
        if probe["embedding"] is not None:
            distances = np.clip(
                1 - matrices[probe["scope_id"]] @ np.asarray(probe["embedding"]), 0, 2
            )
            for row, raw_distance in zip(rows, distances, strict=True):
                distance = float(raw_distance)
                previous = best_by_person.get(row["subject_id"])
                if distance <= 1 and (previous is None or distance < previous["distance"]):
                    best_by_person[row["subject_id"]] = {
                        "subject_id": row["subject_id"],
                        "confidence": row["confidence"],
                        "distance": distance,
                    }
        candidates = sorted(
            best_by_person.values(), key=lambda row: (row["distance"], row["subject_id"])
        )[:20]
        result.append({"probe": probe, "known": known, "candidates": candidates})
    return result


def reference_decision(
    probe: dict[str, Any], candidates: list[dict[str, Any]], policy: dict[str, float]
) -> str:
    """Numerical mirror of valid, complete, approved Worker candidate input only."""
    if probe["embedding"] is None or not candidates:
        return "skipped"
    area = probe["face_area_ratio"]
    if area <= 0 or area < policy["featured_face_min_area_ratio"]:
        return "skipped"
    best = candidates[0]
    if best["distance"] > policy["distance_threshold"]:
        return "skipped"
    second = candidates[1]["distance"] if len(candidates) > 1 else 1.0
    margin = max(0.0, second - best["distance"])
    required = policy[best["confidence"] + "_match_acceptance"]
    if (
        margin <= 1e-12
        or margin < policy["review_margin"]
        or probe["quality"] < policy["minimum_quality"]
        or probe["detection_confidence"] < policy["minimum_detection_confidence"]
        or 1 - best["distance"] < required
    ):
        return "needs_review"
    return "automatic_candidate"


def evaluate_policy(ranked: list[dict[str, Any]], policy: dict[str, float]) -> dict[str, Any]:
    policy = decision_policy(policy)
    counts: Counter[str] = Counter()
    for item in ranked:
        probe, candidates, known = item["probe"], item["candidates"], item["known"]
        counts["probes"] += 1
        counts["mated" if known else "nonmated"] += 1
        if probe["embedding"] is None:
            counts["extraction_failed"] += 1
        best = candidates[0] if candidates else None
        threshold_hit = best is not None and best["distance"] <= policy["distance_threshold"]
        threshold_correct = threshold_hit and best["subject_id"] == probe["subject_id"]
        if not known and threshold_hit:
            counts["threshold_false_identifications"] += 1
        if known and not threshold_correct:
            counts["threshold_rank1_misses"] += 1
        state = reference_decision(probe, candidates, policy)
        counts[state] += 1
        automatic = state == "automatic_candidate"
        correct = automatic and best is not None and best["subject_id"] == probe["subject_id"]
        if correct:
            counts["correct_automatic"] += 1
        if automatic and not correct:
            counts["wrong_automatic"] += 1
        if automatic and not known:
            counts["nonmated_automatic"] += 1
        if automatic and known and not correct:
            counts["mated_wrong_automatic"] += 1
        if known and not correct:
            counts["mated_not_correct_automatic"] += 1
    return {
        "policy": policy,
        "policy_sha256": sha256(compact_policy(policy).encode()),
        "counts": dict(counts),
        "metrics": {
            "threshold_fpir": rate(counts["threshold_false_identifications"], counts["nonmated"]),
            "threshold_rank1_fnir": rate(counts["threshold_rank1_misses"], counts["mated"]),
            "policy_fpir": rate(counts["nonmated_automatic"], counts["nonmated"]),
            "policy_fnir": rate(counts["mated_not_correct_automatic"], counts["mated"]),
            "mated_wrong_identity_rate": rate(counts["mated_wrong_automatic"], counts["mated"]),
            "automatic_candidate_error_rate": rate(
                counts["wrong_automatic"], counts["automatic_candidate"]
            ),
            "review_rate": rate(counts["needs_review"], counts["probes"]),
            "extraction_failure_rate": rate(counts["extraction_failed"], counts["probes"]),
        },
    }


def evaluate(
    dataset: PreparedDataset,
    calibration: PreparedDataset | None = None,
    policies: list[dict[str, float]] | None = None,
) -> dict[str, Any]:
    if calibration is not None:
        check_holdout(calibration, dataset)
    if dataset.raw["partition"] == "holdout":
        require(calibration is not None, "holdout_requires_calibration_reference")
    selected = policies if policies is not None else [dataset.raw["policy"]]
    require(
        isinstance(selected, list) and 1 <= len(selected) <= MAX_POLICIES, "policy_count_invalid"
    )
    if policies is not None:
        require(dataset.raw["partition"] == "calibration", "holdout_sweep_forbidden")
    selected = [decision_policy(policy) for policy in selected]
    ranked = rank_probes(dataset)
    probe_subjects = {p["subject_id"] for p in dataset.probes}
    probe_captures = {p["capture_id"] for p in dataset.probes}
    warnings = [
        "Exported embeddings only: not a detector, device, database, authorization or end-to-end accuracy benchmark.",
        "Reference search is exact float64; hosted float32/ANN search and model-runtime parity are not certified.",
        "Wilson intervals are uncorrected 95% per-probe approximations, not independent-subject guarantees.",
        "Provenance and consent are custodian assertions; renamed/re-encoded duplicate images cannot be independently detected.",
        "Event identifiers are custodian pseudonyms, not independent event provenance; relabelled events cannot be authenticated by this tool.",
        "No release approval is produced. Calibration sweeps require a separately frozen holdout and human review.",
    ]
    if len(probe_subjects) < len(dataset.probes) or len(probe_captures) < len(dataset.probes):
        warnings.append(
            "Correlated probes detected by repeated subject/capture IDs; independent-binomial interval assumptions may not hold."
        )
    if dataset.raw["dataset_kind"] == "synthetic":
        warnings.append(
            "SYNTHETIC SOFTWARE TEST ONLY: results are not recognition-accuracy evidence."
        )
    return {
        "schema_version": "lovelies-scoped-1n-report-v2",
        "dataset_kind": dataset.raw["dataset_kind"],
        "partition": dataset.raw["partition"],
        "model_version": dataset.raw["model_version"],
        "model_checksum_sha256": dataset.raw["model_checksum_sha256"],
        "processing_contract_version": PROCESSING_CONTRACT,
        "decision_contract": DECISION_CONTRACT,
        "search_contract": SEARCH_CONTRACT,
        "split_check": "subject_capture_and_event_disjoint" if calibration else "not_supplied",
        "event_provenance": "explicit_gallery_and_probe_event_identifiers_validated",
        "counts": {
            "probes": len(dataset.probes),
            "probe_subjects": len(probe_subjects),
            "probe_captures": len(probe_captures),
            "scopes": len(dataset.galleries),
            "events": len(dataset.events),
            "templates": sum(map(len, dataset.galleries.values())),
            "template_comparisons": dataset.comparisons,
        },
        "evaluations": [evaluate_policy(ranked, policy) for policy in selected],
        "approval": {"status": "not_approved"},
        "release_authorized": False,
        "warnings": warnings,
    }
