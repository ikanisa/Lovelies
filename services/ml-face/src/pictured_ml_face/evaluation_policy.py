"""Production evaluation checks extracted from the pipeline; no approval is created."""

from __future__ import annotations
import math
from typing import Any
from pictured_ml_face.image_analysis import PROCESSING_CONTRACT_VERSION
from pictured_ml_face.evaluation_contract import EvaluationContractError, validate_binding

from pictured_ml_face.model_integrity import ModelPolicyError as ModelPolicyError


def validate_evaluation_report(
    report: dict[str, Any], active_model: dict[str, Any], evidence: dict[str, Any]
) -> dict[str, float]:
    approval = report.get("approval")
    if not isinstance(approval, dict) or approval.get("status") != "approved":
        raise ModelPolicyError("Production ML evaluation report is not approved")
    for section in (
        "approval",
        "dataset",
        "results",
        "thresholds",
        "bias_review",
        "policy_checks",
        "operations",
    ):
        if not isinstance(report.get(section), dict):
            raise ModelPolicyError("Production ML evaluation section is invalid")

    # JSON booleans are Python ints; casts also silently accept strings,
    # truncate counts and let NaN bypass comparisons. Evidence must contain
    # finite, correctly typed measurements before it can support approval.
    def count(value: object, label: str) -> int:
        if type(value) is not int or value < 0:
            raise ModelPolicyError(f"Production ML {label} must be a nonnegative integer")
        return value

    def rate(value: object, label: str) -> float:
        if type(value) not in (int, float) or not 0 <= value <= 1 or not math.isfinite(value):
            raise ModelPolicyError(f"Production ML {label} must be a finite number in [0, 1]")
        return float(value)

    approval = report.get("approval", {})
    if approval.get("status") != "approved":
        raise ModelPolicyError("Production ML evaluation report is not approved")
    # Approval for a different model or preprocessing contract cannot be
    # recycled when image orientation/alignment behavior has changed.
    if report.get("model_version") != active_model["version"]:
        raise ModelPolicyError("Production ML evaluation model version mismatch")
    if report.get("model_checksum_sha256") != active_model["checksum_sha256"]:
        raise ModelPolicyError("Production ML evaluation model checksum mismatch")
    if report.get("processing_contract_version") != PROCESSING_CONTRACT_VERSION:
        raise ModelPolicyError("Production ML evaluation processing contract mismatch")
    dataset = report.get("dataset", {})
    minimum_events = count(
        evidence.get("minimum_dataset_events", 0),
        "minimum_dataset_events",
    )
    if count(dataset.get("event_count"), "event_count") < minimum_events:
        raise ModelPolicyError("Production ML evaluation dataset is below minimum event count")
    minimum_identities = count(
        evidence.get("minimum_dataset_identities", 0),
        "minimum_dataset_identities",
    )
    if count(dataset.get("identity_count"), "identity_count") < minimum_identities:
        raise ModelPolicyError("Production ML evaluation dataset is below minimum identity count")
    minimum_images = count(
        evidence.get("minimum_dataset_images", 0),
        "minimum_dataset_images",
    )
    if count(dataset.get("image_count"), "image_count") < minimum_images:
        raise ModelPolicyError("Production ML evaluation dataset is below minimum image count")
    for key in (
        "camera_source_mix_reviewed",
        "lighting_pose_occlusion_reviewed",
        "three_selfie_source_reviewed",
        "holdout_split_verified",
        "consent_evidence_verified",
    ):
        if dataset.get(key) is not True:
            raise ModelPolicyError(f"Production ML dataset evidence is not complete: {key}")
    results = report.get("results", {})
    max_allowed = rate(
        evidence.get("maximum_false_positive_rate", 0.001),
        "maximum_false_positive_rate",
    )
    if rate(results.get("false_positive_rate"), "false_positive_rate") > max_allowed:
        raise ModelPolicyError("Production ML false positive rate exceeds policy")
    max_false_negative = evidence.get("maximum_false_negative_rate")
    false_negative = rate(results.get("false_negative_rate"), "false_negative_rate")
    if max_false_negative is not None and false_negative > rate(
        max_false_negative, "maximum_false_negative_rate"
    ):
        raise ModelPolicyError("Production ML false negative rate exceeds policy")
    for key in ("false_positive_reviewed", "false_negative_reviewed"):
        if results.get(key) is not True:
            raise ModelPolicyError(f"Production ML result review is not complete: {key}")
    thresholds = report.get("thresholds", {})
    for key in (
        "threshold_dataset_reviewed",
        "reviewer_capacity_reviewed",
        "top2_margin_policy_reviewed",
        "threshold_change_control_approved",
        "threshold_freeze_approved",
    ):
        if thresholds.get(key) is not True:
            raise ModelPolicyError(f"Production ML threshold evidence is not complete: {key}")
    for key in (
        "auto_match_threshold",
        "review_threshold",
        "minimum_margin",
        "minimum_quality_score",
    ):
        rate(thresholds.get(key), key)
    if float(thresholds["review_threshold"]) >= float(thresholds["auto_match_threshold"]):
        raise ModelPolicyError("Production ML review threshold must be below auto-match threshold")
    bias_review = report.get("bias_review", {})
    if bias_review.get("status") != "completed":
        raise ModelPolicyError("Production ML bias review is not complete")
    policy_checks = report.get("policy_checks", {})
    for key in (
        "profile_based_matching_only",
        "no_demographic_outputs",
        "no_emotion_age_gender_ethnicity",
        "no_global_identity_search",
        "consent_scope_verified",
    ):
        if policy_checks.get(key) is not True:
            raise ModelPolicyError(f"Production ML policy check is not complete: {key}")
    operations = report.get("operations", {})
    for key in (
        "health_check_passed",
        "queue_to_gallery_smoke_passed",
        "admin_review_queue_smoke_passed",
        "not_me_dispute_smoke_passed",
        "drift_monitoring_configured",
        "rollback_drill_passed",
    ):
        if operations.get(key) is not True:
            raise ModelPolicyError(f"Production ML operations evidence is not complete: {key}")
    if not operations.get("alert_owner"):
        raise ModelPolicyError("Production ML operations evidence is missing alert_owner")

    try:
        return validate_binding(report)
    except EvaluationContractError as error:
        raise ModelPolicyError(str(error)) from None
