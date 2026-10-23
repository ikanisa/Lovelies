from concurrent.futures import ThreadPoolExecutor

import pytest

from pictured_ml_face.processing_observation import ProcessingObservation, STAGES, COUNTERS


@pytest.mark.parametrize("stage", STAGES)
def test_fixed_stage_duration(stage):
    ticks = iter([0, 1_000_000, 4_000_000, 7_000_000])
    trace = ProcessingObservation(lambda: next(ticks))
    with trace.stage(stage):
        pass
    result = trace.snapshot()
    assert result["stage_ms"][stage] == 3
    assert result["total_ms"] == 7
    assert set(result) == {"contract_version", "total_ms", "stage_ms", "counts"}
    assert set(result["counts"]) == set(COUNTERS)


def test_failed_stage_is_still_measured():
    ticks = iter([0, 1_000_000, 2_000_000, 3_000_000])
    trace = ProcessingObservation(lambda: next(ticks))
    with pytest.raises(RuntimeError), trace.stage("embed"):
        raise RuntimeError("PRIVATE DATA")
    result = trace.snapshot()
    assert result["stage_ms"]["embed"] == 1
    assert "PRIVATE" not in str(result)


@pytest.mark.parametrize(
    "name,amount",
    [
        ("private-name", 1),
        ("faces_emitted", -1),
        ("faces_emitted", True),
        ("faces_emitted", 1.5),
        ("faces_emitted", 101),
    ],
)
def test_invalid_counters_rejected(name, amount):
    with pytest.raises(ValueError):
        ProcessingObservation().increment(name, amount)


def test_cumulative_counter_budget():
    trace = ProcessingObservation()
    trace.increment("faces_considered", 100)
    with pytest.raises(ValueError):
        trace.increment("faces_considered")


def test_unknown_stage_rejected():
    with pytest.raises(ValueError), ProcessingObservation().stage("subject-name"):
        pass


def test_snapshots_are_owned_and_do_not_mutate_observation():
    trace = ProcessingObservation()
    first = trace.snapshot()
    first["counts"]["faces_emitted"] = 100
    assert trace.snapshot()["counts"]["faces_emitted"] == 0


def test_parallel_observations_do_not_share_counters():
    def run(i):
        trace = ProcessingObservation()
        trace.increment("faces_emitted", i)
        return trace.snapshot()["counts"]["faces_emitted"]

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(run, range(10))) == list(range(10))
