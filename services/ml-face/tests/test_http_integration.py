"""Actual FastAPI application integration; synthetic images/vectors only."""

import asyncio
import base64
import io
import threading

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from pictured_ml_face.main import app


def image_bytes():
    image = Image.new("RGB", (64, 64), (90, 120, 150))
    data = io.BytesIO()
    image.save(data, format="PNG")
    return data.getvalue()


@pytest.mark.parametrize(
    "payload",
    [
        {"embedding": ["PRIVATE-FACE-VECTOR"] * 128},
        {
            "event_id": "qa",
            "detected_face_id": "face",
            "embedding": [False] * 128,
            "candidates": [],
        },
        {"event_id": "qa", "detected_face_id": "face", "embedding": [0] * 128, "candidates": []},
    ],
)
def test_fastapi_validation_does_not_echo_input(payload):
    response = TestClient(app).post("/v1/match-face", json=payload)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_request"
    assert set(detail) == {"code", "message", "error_count"}
    assert "PRIVATE-FACE-VECTOR" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_invalid_json_does_not_echo_submitted_body():
    response = TestClient(app).post(
        "/v1/process-photo",
        content=b'{"SECRET-PHOTO-DATA":',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422
    assert "SECRET-PHOTO-DATA" not in response.text


def test_base64_and_binary_routes_have_same_corrected_result():
    client = TestClient(app)
    raw = image_bytes()
    binary = client.post(
        "/v1/process-photo-binary",
        content=raw,
        headers={
            "content-type": "image/png",
            "x-lovelies-event-id": "qa",
            "x-lovelies-asset-id": "asset",
        },
    )
    encoded = client.post(
        "/v1/process-photo",
        json={
            "event_id": "qa",
            "asset_id": "asset",
            "object_key": "",
            "content_type": "image/png",
            "image_b64": base64.b64encode(raw).decode(),
        },
    )
    assert binary.status_code == encoded.status_code == 200
    binary_body, encoded_body = binary.json(), encoded.json()
    # Actual stage durations depend on scheduling; all deterministic output must agree.
    assert (
        binary_body.pop("processing_trace")["counts"]
        == encoded_body.pop("processing_trace")["counts"]
    )
    for body in (binary_body, encoded_body):
        diagnostics = body["image_metadata"]["processing_diagnostics"]
        assert diagnostics.pop("total_ms") >= 0
        assert all(value >= 0 for value in diagnostics.pop("stage_ms").values())
    assert binary_body == encoded_body
    assert binary.json()["image_metadata"]["geometry"]["orientation"] == "upright"


def test_wire_size_rejection_precedes_json_validation():
    response = TestClient(app).post(
        "/v1/process-photo",
        content=b"INVALID SECRET",
        headers={"content-type": "application/json", "content-length": str(40 * 1024 * 1024)},
    )
    assert response.status_code == 413
    assert "INVALID SECRET" not in response.text


def test_encoding_and_body_length_are_checked_on_live_app():
    client = TestClient(app)
    encoded = client.post(
        "/v1/validate-image", content=b"abc", headers={"content-encoding": "gzip"}
    )
    assert encoded.status_code == 415
    short = client.post("/v1/validate-image", content=b"abc", headers={"content-length": "1"})
    assert short.status_code == 400


def test_matching_uses_the_existing_bounded_cpu_pool(monkeypatch):
    import pictured_ml_face.main as service

    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(service, "_job_slots", slots)
    assert slots.acquire(blocking=False)
    payload = {
        "event_id": "qa",
        "detected_face_id": "face",
        "embedding": [1.0] + [0.0] * 127,
        "candidates": [],
    }
    try:
        response = TestClient(app).post("/v1/match-face", json=payload)
        assert response.status_code == 503
        assert response.headers["retry-after"] == "2"
    finally:
        slots.release()
    assert TestClient(app).post("/v1/match-face", json=payload).status_code == 200


def test_live_admission_blocks_third_request_but_not_health(monkeypatch):
    import pictured_ml_face.main as service

    original = service.pipeline.process_photo_bytes
    entered, release = threading.Event(), threading.Event()
    count = 0
    lock = threading.Lock()

    def slow(*args):
        nonlocal count
        with lock:
            count += 1
            if count == 2:
                entered.set()
        assert release.wait(4)
        return original(*args)

    monkeypatch.setattr(service.pipeline, "process_photo_bytes", slow)

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            headers = {
                "content-type": "image/png",
                "x-lovelies-event-id": "qa",
                "x-lovelies-asset-id": "asset",
            }
            jobs = [
                asyncio.create_task(
                    client.post("/v1/process-photo-binary", content=image_bytes(), headers=headers)
                )
                for _ in range(2)
            ]
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(0.01)
            try:
                assert entered.is_set()
                third = await client.post(
                    "/v1/process-photo-binary", content=image_bytes(), headers=headers
                )
                assert third.status_code == 503
                assert third.json()["detail"]["code"] == "ml_busy"
                assert (await asyncio.wait_for(client.get("/health"), 1)).status_code == 200
            finally:
                release.set()
            assert all(r.status_code == 200 for r in await asyncio.gather(*jobs))

    asyncio.run(scenario())
