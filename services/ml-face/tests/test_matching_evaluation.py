"""Reference evaluator tests use mathematical vectors, never real identities."""

import copy
import json

import pytest

from pictured_ml_face.evaluate_matching import main
from pictured_ml_face.evaluation_contract import EvaluationContractError
from pictured_ml_face.matching_evaluation import (
    SCHEMA,
    PROCESSING_CONTRACT,
    check_holdout,
    evaluate,
    prepare_dataset,
    rank_probes,
    rate,
)
from test_evaluation_contract import POLICY


def vec(axis):
    return [float(i == axis) for i in range(128)]


def dataset(prefix="s", partition="calibration"):
    def template(n):
        return {
            "subject_id": f"{prefix}-person-{n}",
            "template_id": f"{prefix}-template-{n}",
            "capture_id": f"{prefix}-enroll-{n}",
            "confidence": "high",
            "embedding": vec(n),
        }

    def probe(n, subject, axis, failure=None):
        return {
            "probe_id": f"{prefix}-probe-{n}",
            "scope_id": f"{prefix}-scope",
            "event_id": f"{prefix}-event",
            "subject_id": f"{prefix}-person-{subject}",
            "capture_id": f"{prefix}-query-{n}",
            "embedding": None if failure else vec(axis),
            "quality": 0.9,
            "detection_confidence": 0.99,
            "face_area_ratio": 0.1,
            "failure": failure,
        }

    return {
        "schema_version": SCHEMA,
        "dataset_kind": "synthetic",
        "partition": partition,
        "dataset_id": f"{prefix}-dataset",
        "model_version": "test-model",
        "model_checksum_sha256": "a" * 64,
        "processing_contract_version": PROCESSING_CONTRACT,
        "consent_reviewed": False,
        "policy": dict(POLICY),
        "galleries": [
            {
                "scope_id": f"{prefix}-scope",
                "event_id": f"{prefix}-event",
                "templates": [template(0), template(1)],
            }
        ],
        "probes": [
            probe(0, 0, 0),
            probe(1, 1, 1),
            probe(2, 7, 7),
            probe(3, 8, 0),
            probe(4, 0, 0, "no_face"),
        ],
    }


def test_metrics_include_failed_extraction_and_unknown_impostors():
    report = evaluate(prepare_dataset(dataset()))
    m = report["evaluations"][0]["metrics"]
    assert m["policy_fpir"]["rate"] == 0.5
    assert m["policy_fnir"]["rate"] == pytest.approx(1 / 3)
    assert m["automatic_candidate_error_rate"]["rate"] == pytest.approx(1 / 3)
    assert m["extraction_failure_rate"]["rate"] == 0.2
    assert report["release_authorized"] is False
    assert report["approval"]["status"] == "not_approved"


def test_metrics_do_not_hide_unusable_probes():
    d = dataset()
    d["probes"][0]["quality"] = 0
    report = evaluate(prepare_dataset(d))
    m = report["evaluations"][0]["metrics"]
    assert m["policy_fnir"]["rate"] == pytest.approx(2 / 3)
    assert m["threshold_rank1_fnir"]["rate"] == pytest.approx(1 / 3)
    assert m["review_rate"]["rate"] == 0.2


def test_output_never_contains_probe_subject_capture_ids_or_vectors():
    report = evaluate(prepare_dataset(dataset(prefix="private-canary")))
    serialized = json.dumps(report)
    assert "private-canary" not in serialized
    assert "embedding" not in report
    assert all("probe_id" not in e for e in report["evaluations"])


def test_scopes_prevent_global_nearest_identity_search():
    d = dataset()
    other = copy.deepcopy(d["galleries"][0])
    other["scope_id"] = "other-scope"
    for t in other["templates"]:
        t["template_id"] += "-other"
        t["subject_id"] += "-other"
    d["galleries"].append(other)
    d["probes"][0]["subject_id"] = "s-person-0-other"
    ranked = rank_probes(prepare_dataset(d))
    assert ranked[0]["known"] is False
    assert ranked[0]["candidates"][0]["subject_id"] == "s-person-0"


def test_template_poses_do_not_become_competing_people():
    d = dataset()
    extra = copy.deepcopy(d["galleries"][0]["templates"][0])
    extra["template_id"] += "-pose"
    extra["capture_id"] += "-pose"
    d["galleries"][0]["templates"].append(extra)
    ranked = rank_probes(prepare_dataset(d))
    assert len(ranked[0]["candidates"]) == 2
    assert evaluate(prepare_dataset(d))["evaluations"][0]["counts"]["automatic_candidate"] == 3


@pytest.mark.parametrize(
    "change,code",
    [
        ("schema", "unsupported"),
        ("extra", "unexpected"),
        ("duplicate_scope", "duplicate_gallery"),
        ("duplicate_template", "duplicate_template"),
        ("duplicate_probe", "duplicate_probe"),
        ("capture_overlap", "enrollment_probe"),
        ("unknown_scope", "unknown_gallery"),
        ("bad_vector", "invalid_evaluation_embedding"),
        ("bad_quality", "probe_quality"),
        ("bad_failure", "missing_embedding"),
        ("unreviewed", "requires_review"),
        ("duplicate_source", "duplicate_capture"),
    ],
)
def test_dataset_contract_rejects_unsafe_inputs(change, code):
    d = dataset()
    if change == "schema":
        d["schema_version"] = "old"
    if change == "extra":
        d["extra"] = "private metadata"
    if change == "duplicate_scope":
        d["galleries"].append(copy.deepcopy(d["galleries"][0]))
    if change == "duplicate_template":
        d["galleries"][0]["templates"].append(copy.deepcopy(d["galleries"][0]["templates"][0]))
    if change == "duplicate_probe":
        d["probes"].append(copy.deepcopy(d["probes"][0]))
    if change == "capture_overlap":
        d["probes"][0]["capture_id"] = d["galleries"][0]["templates"][0]["capture_id"]
    if change == "unknown_scope":
        d["probes"][0]["scope_id"] = "missing"
    if change == "bad_vector":
        d["probes"][0]["embedding"][0] = True
    if change == "bad_quality":
        d["probes"][0]["quality"] = True
    if change == "bad_failure":
        d["probes"][-1]["failure"] = None
    if change == "unreviewed":
        d["dataset_kind"] = "consented_study"
    if change == "duplicate_source":
        row = copy.deepcopy(d["probes"][0])
        row["probe_id"] = "new-id"
        d["probes"].append(row)
    with pytest.raises(EvaluationContractError, match=code):
        prepare_dataset(d)


def test_query_work_is_bounded_before_ranking(monkeypatch):
    monkeypatch.setattr("pictured_ml_face.matching_evaluation.MAX_COMPARISONS", 1)
    with pytest.raises(EvaluationContractError, match="budget"):
        prepare_dataset(dataset())


def test_subject_capture_and_event_disjoint_holdout():
    calibration = prepare_dataset(dataset("cal"))
    holdout = prepare_dataset(dataset("hold", "holdout"))
    check_holdout(calibration, holdout)
    report = evaluate(holdout, calibration)
    assert report["split_check"] == "subject_capture_and_event_disjoint"
    assert report["counts"]["events"] == 1
    assert report["event_provenance"] == "explicit_gallery_and_probe_event_identifiers_validated"


@pytest.mark.parametrize(
    "change,code",
    [
        ("subject", "subject_overlap"),
        ("capture", "capture_overlap"),
        ("event", "event_overlap"),
        ("policy", "not_frozen"),
        ("model", "model_contract_mismatch"),
    ],
)
def test_holdout_leakage_or_policy_changes_are_refused(change, code):
    cal = dataset("cal")
    hold = dataset("hold", "holdout")
    if change == "subject":
        hold["probes"][0]["subject_id"] = cal["probes"][0]["subject_id"]
    if change == "capture":
        hold["probes"][0]["capture_id"] = cal["probes"][0]["capture_id"]
    if change == "event":
        hold["galleries"][0]["event_id"] = cal["galleries"][0]["event_id"]
        for probe in hold["probes"]:
            probe["event_id"] = cal["galleries"][0]["event_id"]
    if change == "policy":
        hold["policy"]["minimum_quality"] = 0.73
    if change == "model":
        hold["model_version"] = "other-model"
    with pytest.raises(EvaluationContractError, match=code):
        check_holdout(prepare_dataset(cal), prepare_dataset(hold))


@pytest.mark.parametrize("section", ["galleries", "probes"])
@pytest.mark.parametrize("bad", [None, "", "event with spaces", 1, True, []])
def test_every_event_identifier_is_explicit_and_bounded(section, bad):
    value = dataset()
    value[section][0]["event_id"] = bad
    with pytest.raises(EvaluationContractError, match="pseudonymous_identifier"):
        prepare_dataset(value)


@pytest.mark.parametrize("section", ["galleries", "probes"])
def test_missing_events_are_not_inferred_from_scope(section):
    value = dataset()
    del value[section][0]["event_id"]
    with pytest.raises(EvaluationContractError, match="missing_fields"):
        prepare_dataset(value)


def test_legacy_schema_fails_closed_even_with_event_fields():
    value = dataset()
    value["schema_version"] = "lovelies-scoped-1n-input-v1"
    with pytest.raises(EvaluationContractError, match="unsupported_evaluation_schema"):
        prepare_dataset(value)


def test_failed_extraction_cannot_bypass_event_scope_validation():
    value = dataset()
    value["probes"][-1]["event_id"] = "different-event"
    with pytest.raises(EvaluationContractError, match="probe_gallery_event_mismatch"):
        prepare_dataset(value)


def test_unused_gallery_event_is_included_in_holdout_separation():
    cal = dataset("cal")
    hold = dataset("hold", "holdout")
    unused = copy.deepcopy(hold["galleries"][0])
    unused["scope_id"] = "unused-gallery"
    unused["event_id"] = cal["galleries"][0]["event_id"]
    for row in unused["templates"]:
        row["template_id"] += "-unused"
        row["capture_id"] += "-unused"
    hold["galleries"].append(unused)
    with pytest.raises(EvaluationContractError, match="calibration_holdout_event_overlap"):
        check_holdout(prepare_dataset(cal), prepare_dataset(hold))


def test_one_probe_capture_cannot_claim_two_events():
    value = dataset()
    second = copy.deepcopy(value["galleries"][0])
    second["scope_id"] = "second-scope"
    second["event_id"] = "second-event"
    for row in second["templates"]:
        row["template_id"] += "-second"
    value["galleries"].append(second)
    row = value["probes"][1]
    row["capture_id"] = value["probes"][0]["capture_id"]
    row["scope_id"], row["event_id"] = second["scope_id"], second["event_id"]
    with pytest.raises(EvaluationContractError, match="probe_capture_event_inconsistent"):
        prepare_dataset(value)


@pytest.mark.parametrize("kind", ["synthetic", "consented_study"])
def test_holdout_requires_calibration_reference(kind):
    d = dataset("hold", "holdout")
    d["dataset_kind"] = kind
    d["consent_reviewed"] = True
    with pytest.raises(EvaluationContractError, match="calibration_reference"):
        evaluate(prepare_dataset(d))


def test_sweeps_are_calibration_only_and_never_choose_an_approved_winner():
    d = prepare_dataset(dataset())
    report = evaluate(d, policies=[POLICY, dict(POLICY, minimum_quality=0.95)])
    assert len(report["evaluations"]) == 2
    assert report["approval"]["status"] == "not_approved"
    with pytest.raises(EvaluationContractError, match="sweep_forbidden"):
        evaluate(
            prepare_dataset(dataset("h", "holdout")),
            prepare_dataset(dataset("cal")),
            policies=[POLICY],
        )


def test_zero_denominators_are_not_reported_as_zero_error():
    d = dataset()
    d["probes"] = [d["probes"][0]]
    report = evaluate(prepare_dataset(d))
    assert report["evaluations"][0]["metrics"]["policy_fpir"]["rate"] is None
    assert rate(0, 0)["wilson95"] is None


def test_zero_observed_errors_have_nonzero_upper_interval():
    assert rate(0, 100)["wilson95"][1] == pytest.approx(0.0369934982069857)
    assert rate(100, 100)["wilson95"][0] == pytest.approx(0.9630065017930143)


def test_wilson_matches_independent_scipy_reference_when_available():
    scipy = pytest.importorskip("scipy.stats")
    for k, n in [(0, 1), (1, 1), (0, 100), (7, 50), (5, 10), (100, 1000)]:
        expected = scipy.binomtest(k, n).proportion_ci(method="wilson")
        assert rate(k, n)["wilson95"] == pytest.approx([expected.low, expected.high], abs=1e-12)


def test_cli_is_create_only_and_never_echoes_sensitive_identifiers(tmp_path, capsys):
    source = tmp_path / "private-source.json"
    source.write_text(json.dumps(dataset("private-canary")))
    output = tmp_path / "report.json"
    assert main(["--input", str(source), "--output", str(output)]) == 0
    before = output.read_bytes()
    assert main(["--input", str(source), "--output", str(output)]) == 2
    assert output.read_bytes() == before
    assert "private-canary" not in capsys.readouterr().err
    assert output.stat().st_mode & 0o777 == 0o600


def test_cli_malformed_json_fails_without_echo(tmp_path, capsys):
    source = tmp_path / "source.json"
    source.write_text('{"private-canary":1,"private-canary":2}')
    output = tmp_path / "report.json"
    assert main(["--input", str(source), "--output", str(output)]) == 2
    assert not output.exists()
    assert "private-canary" not in capsys.readouterr().err


def test_cli_event_overlap_fails_without_report_or_identifier_echo(tmp_path, capsys):
    calibration = dataset("private-cal-canary")
    holdout = dataset("private-hold-canary", "holdout")
    overlapping = calibration["galleries"][0]["event_id"]
    holdout["galleries"][0]["event_id"] = overlapping
    for probe in holdout["probes"]:
        probe["event_id"] = overlapping
    source, cal, output = (tmp_path / name for name in ("hold.json", "cal.json", "out.json"))
    source.write_text(json.dumps(holdout))
    cal.write_text(json.dumps(calibration))
    assert main(["--input", str(source), "--calibration", str(cal), "--output", str(output)]) == 2
    assert not output.exists()
    error = capsys.readouterr().err
    assert "calibration_holdout_event_overlap" in error
    assert "private-" not in error


def test_cli_rejects_null_policy_grid_instead_of_silently_using_defaults(tmp_path):
    source = tmp_path / "source.json"
    source.write_text(json.dumps(dataset()))
    grid = tmp_path / "grid.json"
    grid.write_text('{"policies":null}')
    output = tmp_path / "output.json"
    assert main(["--input", str(source), "--output", str(output), "--policy-grid", str(grid)]) == 2
    assert not output.exists()
