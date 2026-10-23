"""Actual ASGI probe routes with controlled pipeline startup-state objects.
No substitute image codec, recognition engine or model-accuracy evidence.
"""

import asyncio
from types import SimpleNamespace
import httpx
from fastapi import FastAPI
from pictured_ml_face.service_health import health_snapshot, install_health_routes


def pipeline(**changes):
    state = dict(
        active_model={"version": "opencv-yunet-sface-2021dec-v1", "runtime": "opencv-dnn"},
        artifact_integrity="verified",
        evaluation_status="approved",
        deployment_mode="production",
        using_deterministic_simulator=False,
        detector=object(),
        aligner=object(),
        quality_scorer=object(),
        embedding_model=object(),
        vector_matcher=object(),
        decision_engine=object(),
        detection_profile="reference-v1",
        evaluation_report_digest="a" * 64,
        approved_decision_policy={"threshold": 0.42, "margin": 0.05},
    )
    state.update(changes)
    return SimpleNamespace(**state)


def test_ready_and_model_approval_are_separate():
    pilot = health_snapshot(
        pipeline(
            evaluation_status="monitored_pilot",
            deployment_mode="monitored_pilot",
            evaluation_report_digest=None,
            approved_decision_policy=None,
        )
    )
    assert pilot["runtime_ready"] is True
    assert pilot["model_evaluation_approved"] is False
    approved = health_snapshot(pipeline())
    assert approved["runtime_ready"] is True and approved["model_evaluation_approved"] is True


def test_simulator_is_never_ready_or_approved():
    state = health_snapshot(pipeline(using_deterministic_simulator=True))
    assert state["runtime_ready"] is False and state["model_evaluation_approved"] is False


def test_missing_artifacts_and_incomplete_engines_are_not_ready():
    for change in (
        {"artifact_integrity": "not_verified"},
        {"detector": None},
        {"quality_scorer": None},
        {"embedding_model": None},
    ):
        assert health_snapshot(pipeline(**change))["runtime_ready"] is False


def test_unknown_state_is_not_echoed_or_approved():
    state = health_snapshot(
        pipeline(
            evaluation_status="SECRET/path",
            deployment_mode="SECRET_MODE",
            active_model={"version": "/SECRET/model.onnx", "runtime": "opencv-dnn"},
        )
    )
    assert state["evaluation_status"] == "unavailable" and state["mode"] == "unavailable"
    assert state["model_version"] is None and state["model_evaluation_approved"] is False
    assert "SECRET" not in str(state)


def test_approval_requires_reference_profile_and_bound_report():
    for change in (
        {"detection_profile": "group-v1"},
        {"evaluation_report_digest": None},
        {"evaluation_report_digest": "invalid"},
        {"approved_decision_policy": None},
        {"approved_decision_policy": {}},
        {"deployment_mode": "development"},
    ):
        state = health_snapshot(pipeline(**change))
        assert state["runtime_ready"] is True and state["model_evaluation_approved"] is False


def test_no_pipeline_is_not_ready():
    assert health_snapshot(None)["runtime_ready"] is False


def test_real_http_routes_status_headers_and_methods():
    async def run():
        current = [pipeline(evaluation_status="monitored_pilot", deployment_mode="monitored_pilot")]
        app = FastAPI()
        install_health_routes(app, lambda: current[0])
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            live = await client.get("/live")
            assert live.status_code == 200 and live.json()["probe"] == "liveness"
            assert (await client.get("/ready")).status_code == 200
            approval = await client.get("/model-approval")
            assert approval.status_code == 503
            assert approval.json()["model_evaluation_approved"] is False
            current[0] = pipeline()
            assert (await client.get("/model-approval")).status_code == 200
            current[0] = None
            assert (await client.get("/live")).status_code == 200
            not_ready = await client.get("/ready")
            assert not_ready.status_code == 503
            assert not_ready.headers["cache-control"] == "no-store"
            assert (await client.post("/ready")).status_code == 405

    asyncio.run(run())


def test_probe_failure_is_sanitized_but_process_lives():
    async def run():
        def broken():
            raise RuntimeError("SECRET_STORAGE_PATH")

        app = FastAPI()
        install_health_routes(app, broken)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert (await client.get("/live")).status_code == 200
            response = await client.get("/ready")
            assert response.status_code == 503 and "SECRET" not in response.text

    asyncio.run(run())
