"""Read-only health probes: process health is not model/release approval.

These are startup-state observations, not continuous ONNX checksums or latency SLOs.
The gateway authenticates the /v1/* aliases before forwarding them to this private service.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse

PROBE_CONTRACT = "lovelies-ml-health-v1"
_SAFE_VERSION = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")


def health_snapshot(pipeline: Any) -> dict[str, object]:
    if pipeline is None:
        return {
            "contract": PROBE_CONTRACT,
            "runtime_ready": False,
            "model_evaluation_approved": False,
            "evaluation_status": "unavailable",
            "artifact_integrity": "not_verified",
            "model_version": None,
            "mode": "unavailable",
            "observation": "startup_state",
        }
    active = getattr(pipeline, "active_model", None)
    model = active if type(active) is dict else {}
    version = model.get("version")
    version = version if isinstance(version, str) and _SAFE_VERSION.fullmatch(version) else None
    integrity = (
        "verified"
        if getattr(pipeline, "artifact_integrity", None) == "verified"
        else "not_verified"
    )
    status = getattr(pipeline, "evaluation_status", None)
    if status not in ("approved", "monitored_pilot", "not_required", "optimization_candidate"):
        status = "unavailable"
    mode = getattr(pipeline, "deployment_mode", None)
    if mode not in ("production", "monitored_pilot", "development"):
        mode = "unavailable"
    loaded = all(
        getattr(pipeline, name, None) is not None
        for name in (
            "detector",
            "aligner",
            "quality_scorer",
            "embedding_model",
            "vector_matcher",
            "decision_engine",
        )
    )
    ready = (
        loaded
        and integrity == "verified"
        and version is not None
        and model.get("runtime") == "opencv-dnn"
        and getattr(pipeline, "using_deterministic_simulator", None) is False
    )
    digest = getattr(pipeline, "evaluation_report_digest", None)
    policy = getattr(pipeline, "approved_decision_policy", None)
    approved = (
        ready
        and status == "approved"
        and mode == "production"
        and getattr(pipeline, "detection_profile", None) == "reference-v1"
        and isinstance(digest, str)
        and bool(_HASH.fullmatch(digest))
        and type(policy) is dict
        and bool(policy)
    )
    return {
        "contract": PROBE_CONTRACT,
        "runtime_ready": ready,
        "model_evaluation_approved": approved,
        "evaluation_status": status,
        "artifact_integrity": integrity,
        "model_version": version,
        "mode": mode,
        "observation": "startup_state",
    }


def install_health_routes(app: FastAPI, get_pipeline: Callable[[], Any]) -> None:
    def response(body: dict[str, object], status: int) -> JSONResponse:
        return JSONResponse(
            body,
            status_code=status,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.get("/live", include_in_schema=False)
    async def live() -> JSONResponse:
        return response({"contract": PROBE_CONTRACT, "probe": "liveness", "status": "ok"}, 200)

    def snapshot() -> dict[str, object]:
        try:
            return health_snapshot(get_pipeline())
        except Exception:
            # Never emit model paths, submitted data, or exception details.
            return health_snapshot(None)

    @app.get("/ready", include_in_schema=False)
    async def ready() -> JSONResponse:
        state = snapshot()
        ok = state["runtime_ready"] is True
        return response(
            {**state, "probe": "runtime_readiness", "status": "ready" if ok else "unavailable"},
            200 if ok else 503,
        )

    @app.get("/model-approval", include_in_schema=False)
    async def model_approval() -> JSONResponse:
        state = snapshot()
        ok = state["model_evaluation_approved"] is True
        return response(
            {**state, "probe": "model_evaluation", "status": "approved" if ok else "not_approved"},
            200 if ok else 503,
        )
