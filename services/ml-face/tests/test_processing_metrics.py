import json
import pytest
from pictured_ml_face.processing_metrics import ProcessingMetrics


def test_metrics_use_monotonic_stage_aggregates_and_hide_identifiers():
    times = iter([0, 1000000, 4000000, 5000000, 7000000, 9000000])
    m = ProcessingMetrics(lambda: next(times))
    with m.stage("detect"):
        pass
    with m.stage("detect"):
        pass
    m.count("detections", 2)
    m.count("alignment_rejections")
    m.count("faces_emitted")
    report = m.report("reference-v1", synthetic=False)
    assert report["stage_ms"]["detect"] == 5 and report["total_ms"] == 9
    assert report["outcome"] == "faces_processed" and report["counts"]["detections"] == 2
    assert not any(
        k in json.dumps(report)
        for k in ('"user_id"', '"event_id"', '"asset_id"', '"landmarks"', '"embedding"')
    )


def test_stage_timing_survives_expected_processing_failure():
    times = iter([0, 1000000, 4000000, 5000000])
    m = ProcessingMetrics(lambda: next(times))
    with pytest.raises(ValueError):
        with m.stage("align"):
            raise ValueError("failure")
    assert m.report("reference-v1", synthetic=True)["stage_ms"]["align"] == 3


@pytest.mark.parametrize("bad", [True, -1, 1.5, "1", None])
def test_bad_counters_rejected(bad):
    m = ProcessingMetrics()
    with pytest.raises(ValueError):
        m.count("faces_emitted", bad)


def test_unknown_stages_and_counters_rejected():
    m = ProcessingMetrics()
    with pytest.raises(ValueError):
        with m.stage("secret"):
            pass
    with pytest.raises(ValueError):
        m.count("secret")


def test_empty_versus_unusable_faces_are_distinguished():
    m = ProcessingMetrics()
    assert m.report("group-v1", synthetic=False)["outcome"] == "no_detections"
    m.count("detections")
    m.count("alignment_rejections")
    assert m.report("group-v1", synthetic=False)["outcome"] == "no_usable_faces"


def test_counts_are_request_local_and_return_snapshot():
    a, b = ProcessingMetrics(), ProcessingMetrics()
    a.count("detections", 5)
    report = a.report("reference-v1", synthetic=False)
    report["counts"]["detections"] = 99
    assert a.report("reference-v1", synthetic=False)["counts"]["detections"] == 5
    assert b.report("reference-v1", synthetic=False)["counts"]["detections"] == 0
