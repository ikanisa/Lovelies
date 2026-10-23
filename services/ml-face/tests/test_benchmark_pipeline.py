import io
import json
from types import SimpleNamespace
import pytest
from PIL import Image
from pictured_ml_face.benchmark_pipeline import load_input, main, run_benchmark, synthetic_sample
from pictured_ml_face.processing_metrics import STAGES, COUNTERS


def study(tmp_path):
    data, typ = synthetic_sample()
    (tmp_path / "photo.png").write_bytes(data)
    doc = {
        "schema_version": "local-pipeline-benchmark-input-v1",
        "dataset_kind": "consented_study",
        "consent_reviewed": True,
        "samples": [{"path": "photo.png", "content_type": typ}],
    }
    p = tmp_path / "input.json"
    p.write_text(json.dumps(doc))
    return p, doc


def factory(profile):
    def process(request, data):
        assert data and request.asset_id == "case"
        return SimpleNamespace(
            image_metadata={
                "processing_diagnostics": {
                    "schema_version": "photo-processing-diagnostics-v1",
                    "detection_profile": profile,
                    "synthetic": False,
                    "stage_ms": {k: 1.0 for k in STAGES},
                    "counts": {k: 0 for k in COUNTERS},
                    "face_limit_reached": False,
                }
            }
        )

    return SimpleNamespace(
        using_deterministic_simulator=False,
        active_model={"version": "test-model"},
        processing_version="test",
        process_photo_bytes=process,
    )


def test_report_is_aggregate_non_authorizing_and_counts_all_attempts():
    result = run_benchmark(
        ["reference-v1", "group-v1"], 2, lambda _: (b"fixture", "image/png"), factory, repeats=2
    )
    assert (
        result["release_authorized"] is False and result["recognition_accuracy_measured"] is False
    )
    assert all(r["attempts"] == 4 and r["successful_attempts"] == 4 for r in result["profiles"])
    assert all(r["wall_ms_successes_only"]["p95"] >= 0 for r in result["profiles"])
    text = json.dumps(result)
    assert not any(k in text for k in ("photo.png", "user_id", "landmarks", "event_id", "asset_id"))


def test_failed_inputs_are_not_removed_from_denominator():
    def sample(index):
        if index == 1:
            raise ValueError("private filename")
        return b"fixture", "image/png"

    result = run_benchmark(["group-v1"], 2, sample, factory, warmup=0)
    row = result["profiles"][0]
    assert row["attempts"] == 2 and row["failed_attempts"] == 1 and row["successful_attempts"] == 1
    assert "private filename" not in json.dumps(result)


def test_no_success_produces_null_latency_not_zero():
    row = run_benchmark(["reference-v1"], 1, lambda _: (b"", "image/png"), factory, warmup=0)[
        "profiles"
    ][0]
    assert row["failed_attempts"] == 1 and row["wall_ms_successes_only"]["p95"] is None


@pytest.mark.parametrize("repeats", [0, 6, True, 1.5])
def test_repeat_budget_is_strict(repeats):
    with pytest.raises(ValueError):
        run_benchmark(["reference-v1"], 1, lambda _: None, factory, repeats=repeats)


def test_simulator_cannot_be_reported_as_real_inference():
    with pytest.raises(ValueError, match="real configured"):
        run_benchmark(
            ["reference-v1"],
            1,
            lambda _: None,
            lambda _: SimpleNamespace(using_deterministic_simulator=True),
        )


def test_consent_assertion_is_required(tmp_path):
    p, doc = study(tmp_path)
    doc["consent_reviewed"] = False
    p.write_text(json.dumps(doc))
    with pytest.raises(ValueError, match="assertion"):
        load_input(p)


@pytest.mark.parametrize("bad", ["../outside.png", "/absolute.png", "sub\\photo.png", ""])
def test_escaping_input_paths_are_rejected(tmp_path, bad):
    p, doc = study(tmp_path)
    doc["samples"][0]["path"] = bad
    p.write_text(json.dumps(doc))
    with pytest.raises(ValueError):
        load_input(p)


def test_final_and_descendant_input_symlinks_are_rejected(tmp_path):
    p, doc = study(tmp_path)
    (tmp_path / "alias.png").symlink_to(tmp_path / "photo.png")
    doc["samples"][0]["path"] = "alias.png"
    p.write_text(json.dumps(doc))
    with pytest.raises(ValueError):
        load_input(p)


def test_synthetic_fixture_contains_valid_pixels_not_identity_data():
    data, typ = synthetic_sample()
    im = Image.open(io.BytesIO(data))
    assert typ == "image/png" and im.size == (1600, 1200)


def test_cli_does_not_overwrite_existing_output(tmp_path, capsys):
    path = tmp_path / "report.json"
    path.write_text("keep")
    assert main(["--synthetic", "--output", str(path)]) == 2
    assert path.read_text() == "keep"
    assert str(path) not in capsys.readouterr().out


def test_input_extra_fields_are_not_silently_accepted(tmp_path):
    p, doc = study(tmp_path)
    doc["approval"] = "approved"
    p.write_text(json.dumps(doc))
    with pytest.raises(ValueError):
        load_input(p)
