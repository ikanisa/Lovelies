from __future__ import annotations

import base64
import binascii
import os
import threading
from collections.abc import Callable
from typing import TypeVar

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pictured_ml_face.http_boundary import MlHttpBoundary, body_limits
from pictured_ml_face.service_health import install_health_routes
from starlette.concurrency import run_in_threadpool

from pictured_ml_face.models import (
    MatchRequest,
    PhotoProcessRequest,
)
from pictured_ml_face.pipeline import FacePipeline, PROHIBITED_CATEGORIES
from pictured_ml_face.components import ImageValidationError
from pictured_ml_face.validation_pipeline import process_validation_image

MANIFEST_PATH = os.getenv("MODEL_MANIFEST_PATH", "models/model-manifest.json")
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))

# Validate configuration before accepting requests. The public gateway also caps 20 MiB.
body_limits(MAX_UPLOAD_BYTES)
app = FastAPI(title="PICTURED ML Face Service", version="0.1.0")
app.add_middleware(
    MlHttpBoundary,
    max_requests=int(os.getenv("ML_MAX_CONCURRENT_REQUESTS", "2")),
    image_bytes=MAX_UPLOAD_BYTES,
    body_timeout_seconds=float(os.getenv("ML_BODY_TIMEOUT_SECONDS", "30")),
)


@app.exception_handler(RequestValidationError)
async def private_validation_error(_request: Request, error: RequestValidationError):
    # Pydantic errors can contain the submitted face vector/image, or arbitrary
    # field names. Return neither the input, body, location nor exception text.
    return JSONResponse(
        status_code=422,
        content={
            "detail": {
                "code": "invalid_request",
                "message": "ML request validation failed",
                "error_count": len(error.errors()),
            }
        },
    )


pipeline = FacePipeline(MANIFEST_PATH)
install_health_routes(app, lambda: pipeline)

# Bound concurrent CPU/decode jobs per process; never do image work on the event loop.
_max_jobs = int(os.getenv("ML_MAX_CONCURRENT_JOBS", "2"))
if not 1 <= _max_jobs <= 16:
    raise ValueError("ML_MAX_CONCURRENT_JOBS must be between 1 and 16")
_job_slots = threading.BoundedSemaphore(_max_jobs)
_Result = TypeVar("_Result")


def run_image_job(operation: Callable[..., _Result], *args: object) -> _Result:
    if not _job_slots.acquire(blocking=False):
        raise HTTPException(
            status_code=503,
            headers={"Retry-After": "2"},
            detail={"code": "ml_busy", "message": "Retry this image job later"},
        )
    try:
        return operation(*args)
    finally:
        _job_slots.release()


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "pictured-ml-face",
        "active_model_version": pipeline.manifest.active_model_version,
        "runtime": pipeline.active_model.get("runtime", "unknown"),
        "runtime_acceleration": pipeline.active_model.get("runtime_acceleration", "none"),
        "deployment_mode": pipeline.deployment_mode,
        "evaluation_status": pipeline.evaluation_status,
        "vector_mvp": "pgvector",
        "vector_scale_path": ["faiss", "qdrant"],
        "module_versions": pipeline.module_versions,
        "recognition_provider": "local_opencv_yunet_sface",
        "external_recognition_apis": [],
        "internet_egress": "disabled",
        "prohibited_categories": PROHIBITED_CATEGORIES,
        "production_evidence": {
            "status": pipeline.evaluation_status,
            "artifact_integrity": pipeline.artifact_integrity,
            "representative_evaluation": (
                "collecting_pilot_outcomes"
                if pipeline.evaluation_status == "monitored_pilot"
                else pipeline.evaluation_status
            ),
            "quality_claim": (
                "monitored_pilot_active"
                if pipeline.evaluation_status == "monitored_pilot"
                else pipeline.evaluation_status
            ),
        },
    }


@app.get("/v1/models")
def models() -> dict[str, object]:
    return pipeline.manifest.model_dump()


@app.post("/v1/process-photo")
def process_photo(request: PhotoProcessRequest):
    if not request.image_b64:
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_image", "message": "Image bytes are required"},
        )
    # Reject encoded over-limit data before allocating a decoded image buffer.
    if len(request.image_b64) > ((MAX_UPLOAD_BYTES + 2) // 3) * 4:
        raise image_too_large()
    try:
        image_bytes = base64.b64decode(request.image_b64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(
            status_code=415,
            detail={"code": "invalid_image_encoding", "message": "Image must use valid base64"},
        ) from error
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise image_too_large()
    try:
        return run_image_job(pipeline.process_photo_bytes, request, image_bytes)
    except ImageValidationError as error:
        raise HTTPException(
            status_code=415,
            detail={"code": error.code, "message": str(error)},
        ) from error


def image_too_large() -> HTTPException:
    return HTTPException(
        status_code=413,
        detail={
            "code": "image_too_large",
            "message": f"Image exceeds {MAX_UPLOAD_BYTES} bytes",
        },
    )


@app.post("/v1/process-photo-binary")
async def process_photo_binary(request: Request):
    event_id = request.headers.get("x-lovelies-event-id", "").strip()
    asset_id = request.headers.get("x-lovelies-asset-id", "").strip()
    declared_content_type = (
        request.headers.get(
            "x-lovelies-declared-content-type",
            request.headers.get("content-type", "image/jpeg"),
        )
        .strip()
        .lower()
    )
    if not event_id or not asset_id:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "missing_processing_identity",
                "message": "Event and asset identifiers are required",
            },
        )
    image_bytes = await read_bounded_image_bytes(request)
    try:
        photo_request = PhotoProcessRequest(
            event_id=event_id,
            asset_id=asset_id,
            object_key="",
            content_type=declared_content_type,
            image_b64=None,
        )
        return await run_in_threadpool(
            run_image_job, pipeline.process_photo_bytes, photo_request, image_bytes
        )
    except ImageValidationError as error:
        raise HTTPException(
            status_code=415,
            detail={"code": error.code, "message": str(error)},
        ) from error


@app.post("/v1/validate-image")
async def validate_image(request: Request) -> dict[str, object]:
    declared_content_type = (
        request.headers.get("x-lovelies-declared-content-type", "").strip().lower()
    )
    image_bytes = await read_bounded_image_bytes(request)
    try:
        return await run_in_threadpool(
            run_image_job,
            process_validation_image,
            image_bytes,
            declared_content_type,
            request.headers.get("x-lovelies-event-id", "").strip(),
            request.headers.get("x-lovelies-asset-id", "").strip(),
        )
    except ImageValidationError as error:
        raise HTTPException(
            status_code=415,
            detail={"code": error.code, "message": str(error)},
        ) from error


async def read_bounded_image_bytes(request: Request) -> bytes:
    image_bytes = bytearray()
    async for chunk in request.stream():
        if len(chunk) > MAX_UPLOAD_BYTES - len(image_bytes):
            raise image_too_large()
        image_bytes.extend(chunk)
    if not image_bytes:
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_image", "message": "Image bytes are required"},
        )
    return bytes(image_bytes)


@app.post("/v1/enroll-face")
def retired_face_enrollment():
    raise HTTPException(
        status_code=410,
        detail={
            "code": "face_enrollment_retired",
            "message": "Face enrollment is permanently retired. Use on-device photo identity.",
        },
    )


@app.post("/v1/match-face")
def match_face(request: MatchRequest):
    return run_image_job(pipeline.match_face, request)
