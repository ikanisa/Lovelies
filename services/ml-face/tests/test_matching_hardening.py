"""Regression tests for the September 26 hardening changes. No personal photos."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import io
import json
import math
import threading
from pathlib import Path

import httpx
import numpy as np
from PIL import Image, ImageOps, PngImagePlugin
import pytest

from pictured_ml_face.components import decode_image, decode_validated_image, normalize
from pictured_ml_face.image_analysis import difference_hash, image_diagnostics
from pictured_ml_face.main import app, run_image_job
from pictured_ml_face.models import CandidateEmbedding, MatchRequest
from pictured_ml_face.pipeline import FacePipeline, ModelPolicyError


def png(metadata=None):
    y, x = np.mgrid[:80, :120]
    image = Image.fromarray(np.stack([x * 2, y * 3, (x + y) % 256], axis=2).astype("uint8"))
    buf = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    if metadata:
        info.add_text("Comment", metadata)
    image.save(buf, format="PNG", pnginfo=info)
    return buf.getvalue()


def test_quality_is_invariant_to_encoded_metadata():
    a, b = png("first"), png("other")
    assert a != b
    left, right = decode_image(a), decode_image(b)
    assert np.array_equal(left, right)
    assert image_diagnostics(left, []) == image_diagnostics(right, [])
    result = image_diagnostics(left, [])
    assert (result["estimated_width"], result["estimated_height"]) == (120, 80)
    assert result["perceptual_hash_algorithm"] == "dhash-luma-upright-v1"
    assert result["calibration_status"] == "heuristic_not_calibrated"


@pytest.mark.parametrize("orientation", range(1, 9))
def test_every_exif_orientation_matches_canonical_pixels(orientation):
    image = Image.open(io.BytesIO(png()))
    exif = Image.Exif()
    exif[274] = orientation
    buf = io.BytesIO()
    image.save(buf, format="PNG", exif=exif)
    with Image.open(io.BytesIO(buf.getvalue())) as encoded:
        expected = np.asarray(ImageOps.exif_transpose(encoded).convert("RGB"))[:, :, ::-1]
    actual, metadata = decode_validated_image(buf.getvalue(), "image/png")
    assert np.array_equal(actual, expected)
    assert metadata["height"] == expected.shape[0]
    assert metadata["width"] == expected.shape[1]


def test_hash_is_pixel_based_not_file_based():
    ramp = np.tile(np.arange(120, dtype="uint8"), (80, 1))
    image = np.stack([ramp] * 3, axis=2)
    assert difference_hash(image) != difference_hash(image[:, ::-1, :])


@pytest.mark.parametrize(
    "vector", [np.zeros(128), np.full(128, float("nan")), np.full(128, float("inf"))]
)
def test_invalid_embeddings_fail_closed(vector):
    with pytest.raises(ValueError):
        normalize(vector)


def test_normalization_handles_large_finite_values():
    vector = normalize(np.full(128, 1e150, dtype=np.float64))
    assert np.isfinite(vector).all()
    assert np.linalg.norm(vector) == pytest.approx(1, abs=1e-6)


def test_runner_up_is_a_different_person(monkeypatch):
    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "true")
    pipeline = FacePipeline("models/model-manifest.json")
    query = [1.0] + [0.0] * 127
    other = [0.0, 1.0] + [0.0] * 126
    request = MatchRequest(
        event_id="unit",
        detected_face_id="face",
        embedding=query,
        threshold=0.42,
        review_margin=0.05,
        candidates=[
            CandidateEmbedding(user_id="a", face_profile_id="a-1", embedding=query),
            CandidateEmbedding(user_id="a", face_profile_id="a-2", embedding=query),
            CandidateEmbedding(user_id="b", face_profile_id="b-1", embedding=other),
        ],
    )
    decision = pipeline.match_face(request)
    assert decision.user_id == "a"
    assert decision.margin == pytest.approx(1)


def test_manifest_selected_simulator_is_forbidden_in_production(tmp_path, monkeypatch):
    manifest = json.loads(Path("models/model-manifest.json").read_text())
    manifest["models"][0]["runtime"] = "local-deterministic-simulator"
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    monkeypatch.setenv("ML_USE_DETERMINISTIC_SIMULATOR", "false")
    monkeypatch.setenv("CLOUDFLARE_ENV", "production")
    with pytest.raises(ModelPolicyError, match="forbidden in production"):
        FacePipeline(path)


def test_binary_image_work_does_not_block_health(monkeypatch):
    import pictured_ml_face.main as service

    original = service.pipeline.process_photo_bytes
    entered = threading.Event()
    release = threading.Event()

    def slow(*args):
        entered.set()
        assert release.wait(timeout=5)
        return original(*args)

    monkeypatch.setattr(service.pipeline, "process_photo_bytes", slow)

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            processing = asyncio.create_task(
                client.post(
                    "/v1/process-photo-binary",
                    content=png(),
                    headers={
                        "content-type": "image/png",
                        "x-lovelies-event-id": "qa",
                        "x-lovelies-asset-id": "qa",
                    },
                )
            )
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(0.01)
            assert entered.is_set()
            try:
                health = await asyncio.wait_for(client.get("/health"), timeout=1)
                assert health.status_code == 200
            finally:
                release.set()
            assert (await processing).status_code == 200

    asyncio.run(scenario())


def test_processing_capacity_is_bounded_and_released(monkeypatch):
    import pictured_ml_face.main as service
    from fastapi import HTTPException

    monkeypatch.setattr(service, "_job_slots", threading.BoundedSemaphore(1))
    entered = threading.Event()
    release = threading.Event()

    def blocked():
        entered.set()
        release.wait(2)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run_image_job, blocked)
        assert entered.wait(1)
        try:
            with pytest.raises(HTTPException) as caught:
                run_image_job(lambda: None)
            assert caught.value.status_code == 503
        finally:
            release.set()
        future.result()
    assert run_image_job(lambda: 42) == 42
    with pytest.raises(RuntimeError):
        run_image_job(lambda: (_ for _ in ()).throw(RuntimeError()))
    assert run_image_job(lambda: 43) == 43


def test_diagnostics_reject_nan_scores():
    with pytest.raises(ValueError):
        image_diagnostics(decode_image(png()), [math.nan])


@pytest.mark.parametrize(
    "field,bad",
    [
        ("model_version", "different-model"),
        ("model_checksum_sha256", "b" * 64),
        ("processing_contract_version", "old-crop"),
    ],
)
def test_approval_cannot_be_reused_after_contract_changes(tmp_path, monkeypatch, field, bad):
    from test_pipeline import approved_evaluation_report, write_manifest_for_report

    report = approved_evaluation_report()
    report[field] = bad
    report_path = tmp_path / "evaluation.json"
    report_path.write_text(json.dumps(report))
    manifest = write_manifest_for_report(tmp_path, report_path)
    monkeypatch.setenv("ML_REQUIRE_MODEL_ARTIFACTS", "true")
    with pytest.raises(ModelPolicyError, match="mismatch"):
        FacePipeline(manifest)
