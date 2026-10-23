"""Synthetic evidence-contract tests. No production approval is represented."""

import copy
import json

import pytest

from pictured_ml_face.evaluation_contract import (
    DECISION_CONTRACT,
    SEARCH_CONTRACT,
    EvaluationContractError,
    approval_metadata,
    decision_policy,
    read_bounded,
    strict_json_bytes,
    validate_binding,
)
from pictured_ml_face.evaluation_policy import ModelPolicyError, validate_evaluation_report

POLICY = {
    "distance_threshold": 0.42,
    "review_margin": 0.05,
    "minimum_quality": 0.72,
    "minimum_detection_confidence": 0.8,
    "featured_face_min_area_ratio": 0.025,
    "high_match_acceptance": 0.85,
    "medium_match_acceptance": 0.88,
}


def binding():
    return {
        "decision_contract": DECISION_CONTRACT,
        "search_contract": SEARCH_CONTRACT,
        "policy": dict(POLICY),
    }


@pytest.mark.parametrize("invalid", [True, "0.4", None, -1, 2, float("nan"), float("inf")])
def test_policy_rejects_non_numeric_or_out_of_range_values(invalid):
    value = dict(POLICY, review_margin=invalid)
    with pytest.raises(EvaluationContractError):
        decision_policy(value)


@pytest.mark.parametrize("change", ["extra", "missing", "wrong_type"])
def test_policy_keys_are_closed(change):
    value = dict(POLICY)
    if change == "extra":
        value["extra"] = 0
    if change == "missing":
        value.pop("minimum_quality")
    if change == "wrong_type":
        value = []
    with pytest.raises(EvaluationContractError):
        decision_policy(value)


@pytest.mark.parametrize(
    "raw",
    [
        b'{"x":1,"x":2}',
        b'{"x":NaN}',
        b'{"x":Infinity}',
        b'{"x":-Infinity}',
        b'{"x":1e999}',
        b"[]",
        b"null",
        b"\xff",
    ],
)
def test_json_rejects_ambiguous_or_nonfinite_inputs(raw):
    with pytest.raises(EvaluationContractError):
        strict_json_bytes(raw)


def test_bounded_read_limits_actual_stream(tmp_path):
    file = tmp_path / "oversized"
    file.write_bytes(b"x" * 11)
    with pytest.raises(EvaluationContractError):
        read_bounded(file, 10)
    assert read_bounded(file, 11) == b"x" * 11


def test_binding_requires_current_decision_and_search_contract():
    assert validate_binding({"decision_binding": binding()}) == POLICY
    for key in ("decision_contract", "search_contract"):
        value = binding()
        value[key] = "old"
        with pytest.raises(EvaluationContractError):
            validate_binding({"decision_binding": value})


@pytest.mark.parametrize("status", ["not_required", "monitored_pilot", "blocked", "not_approved"])
def test_nonapproved_runtime_emits_no_approval_envelope(status):
    assert (
        approval_metadata({"version": "v1", "checksum_sha256": "a" * 64}, POLICY, "b" * 64, status)
        == {}
    )


def test_approval_metadata_carries_exact_policy_and_report_identity():
    actual = approval_metadata(
        {"version": "v1", "checksum_sha256": "a" * 64}, POLICY, "b" * 64, "approved"
    )
    assert actual["evaluation_model_version"] == "v1"
    assert actual["evaluation_report_sha256"] == "b" * 64
    assert actual["model_checksum_sha256"] == actual["evaluation_model_checksum_sha256"]
    assert json.loads(actual["approved_decision_policy"]) == POLICY
    assert actual["decision_contract_version"] == DECISION_CONTRACT


def test_approved_metadata_requires_model_checksum():
    with pytest.raises(EvaluationContractError):
        approval_metadata({"version": "v1", "checksum_sha256": "bad"}, POLICY, "b" * 64, "approved")


def test_prior_boolean_only_approval_is_insufficient():
    from evaluation_test_fixtures import approved_evaluation_report

    report = approved_evaluation_report()
    report.pop("decision_binding", None)
    with pytest.raises(ModelPolicyError, match="decision_binding"):
        validate_evaluation_report(
            report, {"version": "test-model", "checksum_sha256": "a" * 64}, {}
        )


def test_validated_policy_is_returned_without_mutating_report():
    from evaluation_test_fixtures import approved_evaluation_report

    report = approved_evaluation_report()
    report["decision_binding"] = binding()
    before = copy.deepcopy(report)
    assert (
        validate_evaluation_report(
            report, {"version": "test-model", "checksum_sha256": "a" * 64}, {}
        )
        == POLICY
    )
    assert report == before


@pytest.mark.parametrize(
    "section",
    ["approval", "dataset", "results", "thresholds", "bias_review", "policy_checks", "operations"],
)
def test_malformed_evidence_sections_fail_as_policy_errors(section):
    from evaluation_test_fixtures import approved_evaluation_report

    report = approved_evaluation_report()
    report[section] = None
    with pytest.raises(ModelPolicyError):
        validate_evaluation_report(
            report, {"version": "test-model", "checksum_sha256": "a" * 64}, {}
        )
