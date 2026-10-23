"""Frozen decision settings and bounded JSON. No approval is generated here.

The report digest establishes byte identity, NOT a reviewer signature. Deployment
configuration and access to the private ML service remain trust boundaries.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

PROCESSING_CONTRACT = "canonical-upright-aligned-pixels-v2"
DECISION_CONTRACT = "distinct-identity-current-decision-v4"
SEARCH_CONTRACT = "eligible-model-distinct-top20-distance1-v1"
POLICY_KEYS = (
    "distance_threshold",
    "review_margin",
    "minimum_quality",
    "minimum_detection_confidence",
    "featured_face_min_area_ratio",
    "high_match_acceptance",
    "medium_match_acceptance",
)
REPORT_LIMIT = 1_048_576


class EvaluationContractError(ValueError):
    """Messages are fixed codes, never submitted values or identifiers."""


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise EvaluationContractError("duplicate_json_key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise EvaluationContractError("nonfinite_json_number")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise EvaluationContractError("nonfinite_json_number")
    return number


def strict_json_bytes(data: bytes, maximum: int = REPORT_LIMIT) -> dict[str, Any]:
    if type(data) is not bytes or len(data) > maximum:
        raise EvaluationContractError("json_size_limit")
    try:
        value = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_object,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except EvaluationContractError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise EvaluationContractError("invalid_json") from None
    if not isinstance(value, dict):
        raise EvaluationContractError("json_object_required")
    return value


def read_bounded(path: Path, maximum: int = REPORT_LIMIT) -> bytes:
    # Check the stream, not just stat(): concurrent file growth cannot bypass cap.
    with path.open("rb") as handle:
        data = handle.read(maximum + 1)
    if len(data) > maximum:
        raise EvaluationContractError("json_size_limit")
    return data


def unit_score(value: Any) -> bool:
    return type(value) in (int, float) and 0 <= value <= 1 and math.isfinite(value)


def decision_policy(value: Any) -> dict[str, float]:
    if not isinstance(value, dict) or set(value) != set(POLICY_KEYS):
        raise EvaluationContractError("decision_policy_fields_invalid")
    if not all(unit_score(value[key]) for key in POLICY_KEYS):
        raise EvaluationContractError("decision_policy_value_invalid")
    return {key: float(value[key]) for key in POLICY_KEYS}


def compact_policy(value: Any) -> str:
    return json.dumps(
        decision_policy(value), sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def validate_binding(report: dict[str, Any]) -> dict[str, float]:
    binding = report.get("decision_binding")
    if not isinstance(binding, dict) or set(binding) != {
        "decision_contract",
        "search_contract",
        "policy",
    }:
        raise EvaluationContractError("decision_binding_missing_or_invalid")
    if binding["decision_contract"] != DECISION_CONTRACT:
        raise EvaluationContractError("decision_contract_mismatch")
    if binding["search_contract"] != SEARCH_CONTRACT:
        raise EvaluationContractError("search_contract_mismatch")
    return decision_policy(binding["policy"])


def approval_metadata(
    model: dict[str, Any], policy: dict[str, float] | None, report_digest: str | None, status: str
) -> dict[str, str]:
    # Emit no approval envelope for a pilot, simulator or unvalidated report.
    if status != "approved" or policy is None or not valid_sha256(report_digest):
        return {}
    checksum = model.get("checksum_sha256")
    version = model.get("version")
    if not valid_sha256(checksum) or not isinstance(version, str) or not version.strip():
        raise EvaluationContractError("approval_model_identity_invalid")
    return {
        "evaluation_report_sha256": report_digest,
        "model_checksum_sha256": checksum,
        "evaluation_model_checksum_sha256": checksum,
        "evaluation_model_version": version,
        "decision_contract_version": DECISION_CONTRACT,
        "evaluation_search_contract": SEARCH_CONTRACT,
        "approved_decision_policy": compact_policy(policy),
    }
