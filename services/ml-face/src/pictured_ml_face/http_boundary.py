"""Bounded, privacy-minimizing ASGI boundary for the private ML container.

Limits raw bytes BEFORE FastAPI JSON/Pydantic processing. Admission is per worker
process, not a distributed rate limit. The proxy must independently enforce its
limits. A permit covers body reading, parsing, inference and response sending.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import threading
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

MAX_IMAGE_BYTES = 20 * 1024 * 1024
JSON_ENVELOPE_BYTES = 64 * 1024
MAX_MATCH_BODY_BYTES = 16 * 1024 * 1024
_LOG = logging.getLogger("pictured_ml_face.http")
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I
)
_CONTENT_LENGTH = re.compile(rb"^(0|[1-9][0-9]{0,18})$")


def body_limits(image_bytes: int = MAX_IMAGE_BYTES) -> dict[str, int]:
    if type(image_bytes) is not int or not 1 <= image_bytes <= MAX_IMAGE_BYTES:
        raise ValueError("MAX_UPLOAD_BYTES must be an integer between 1 and 20971520")
    return {
        "/v1/process-photo-binary": image_bytes,
        "/v1/validate-image": image_bytes,
        "/v1/process-photo": ((image_bytes + 2) // 3) * 4 + JSON_ENVELOPE_BYTES,
        "/v1/match-face": MAX_MATCH_BODY_BYTES,
    }


class _BoundaryFailure(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code


class MlHttpBoundary:
    """Pure ASGI, compatible with the project's existing Starlette release."""

    def __init__(
        self,
        app: Callable[..., Awaitable[None]],
        *,
        max_requests: int = 2,
        image_bytes: int = MAX_IMAGE_BYTES,
        body_timeout_seconds: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        if type(max_requests) is not int or not 1 <= max_requests <= 16:
            raise ValueError("ML_MAX_CONCURRENT_REQUESTS must be between 1 and 16")
        if (
            type(body_timeout_seconds) not in (int, float)
            or not math.isfinite(body_timeout_seconds)
            or not 0 < body_timeout_seconds <= 120
        ):
            raise ValueError("ML_BODY_TIMEOUT_SECONDS must be finite and in (0, 120]")
        self.app, self.limits, self.clock = app, body_limits(image_bytes), clock
        self.timeout = float(body_timeout_seconds)
        self.slots = threading.BoundedSemaphore(max_requests)

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        route = (
            path
            if path in self.limits
            or path in {"/health", "/live", "/ready", "/model-approval", "/v1/models"}
            else "/unknown"
        )
        started = self.clock()
        request_id = self._request_id(scope)
        status = 500
        response_started = False
        acquired = False
        request_bytes = 0
        body: bytearray | None = None
        outcome = "completed"
        # Do not forward an unvalidated request ID supplied by a caller.
        scope = dict(scope)
        scope["headers"] = [
            (k, v) for k, v in scope.get("headers", []) if k.lower() != b"x-request-id"
        ]
        scope["headers"].append((b"x-request-id", request_id.encode("ascii")))

        async def safe_send(message: dict[str, Any]) -> None:
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status = int(message["status"])
                message = dict(message)
                overrides = {
                    b"cache-control": b"no-store",
                    b"x-content-type-options": b"nosniff",
                    b"x-request-id": request_id.encode("ascii"),
                }
                headers = [
                    (k, v) for k, v in message.get("headers", []) if k.lower() not in overrides
                ]
                message["headers"] = headers + list(overrides.items())
            await send(message)

        try:
            headers: dict[bytes, list[bytes]] = {}
            for key, value in scope["headers"]:
                headers.setdefault(key.lower(), []).append(value)
            lengths = headers.get(b"content-length", [])
            transfer = headers.get(b"transfer-encoding", [])
            # HTTP parsers may choose different framing for TE plus CL. Refuse
            # mixed or unsupported framing before any body read or inference.
            if transfer and lengths:
                raise _BoundaryFailure(400, "ambiguous_request_framing")
            if len(transfer) > 1 or (transfer and transfer[0].strip().lower() != b"chunked"):
                raise _BoundaryFailure(400, "invalid_transfer_encoding")
            if path in self.limits and scope.get("method") == "POST":
                if len(lengths) > 1 or (lengths and not _CONTENT_LENGTH.fullmatch(lengths[0])):
                    raise _BoundaryFailure(400, "invalid_content_length")
                encodings = headers.get(b"content-encoding", [])
                if len(encodings) > 1 or (
                    encodings and encodings[0].strip().lower() != b"identity"
                ):
                    raise _BoundaryFailure(415, "unsupported_content_encoding")
                limit = self.limits[path]
                declared = int(lengths[0]) if lengths else None
                if declared is not None and declared > limit:
                    raise _BoundaryFailure(413, "request_body_too_large")
                acquired = self.slots.acquire(blocking=False)
                if not acquired:
                    raise _BoundaryFailure(503, "ml_busy")
                # The complete wire body is bounded before the framework parses it.
                # No content is written to disk. Later framework copies are GC-managed.
                body = bytearray()
                previous_clock = self.clock()
                if not math.isfinite(previous_clock) or previous_clock < started:
                    raise _BoundaryFailure(503, "invalid_ml_transport_clock")
                deadline = previous_clock + self.timeout

                def remaining_budget() -> float:
                    nonlocal previous_clock
                    current = self.clock()
                    if not math.isfinite(current) or current < previous_clock:
                        raise _BoundaryFailure(503, "invalid_ml_transport_clock")
                    previous_clock = current
                    remaining = deadline - current
                    if remaining <= 0:
                        raise _BoundaryFailure(408, "request_body_timeout")
                    return remaining

                while True:
                    remaining = remaining_budget()
                    try:
                        message = await asyncio.wait_for(receive(), timeout=remaining)
                    except TimeoutError as error:
                        raise _BoundaryFailure(408, "request_body_timeout") from error
                    if message["type"] == "http.disconnect":
                        outcome = "client_disconnected"
                        status = (
                            499  # Log classification only; do not send to a disconnected client.
                        )
                        return
                    if message["type"] != "http.request":
                        raise _BoundaryFailure(400, "invalid_request_stream")
                    # A receive future may resolve after the absolute deadline
                    # before the event loop runs its timeout callback. Recheck
                    # even for the final/empty message, before copying any bytes.
                    remaining_budget()
                    chunk = message.get("body", b"")
                    if not isinstance(chunk, bytes):
                        raise _BoundaryFailure(400, "invalid_request_stream")
                    if len(chunk) > limit - len(body):
                        raise _BoundaryFailure(413, "request_body_too_large")
                    body.extend(chunk)
                    request_bytes = len(body)
                    if not message.get("more_body", False):
                        break
                if declared is not None and declared != len(body):
                    raise _BoundaryFailure(400, "content_length_mismatch")
                delivered = False

                async def replay_receive() -> dict[str, Any]:
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": bytes(body), "more_body": False}
                    # Preserve disconnect semantics after the body, not fabricated messages.
                    return await receive()

                await self.app(scope, replay_receive, safe_send)
            else:
                await self.app(scope, receive, safe_send)
        except _BoundaryFailure as error:
            outcome = error.code
            if response_started:
                raise
            headers = [(b"retry-after", b"2")] if error.status == 503 else []
            if error.code in {"ambiguous_request_framing", "invalid_transfer_encoding"}:
                headers.append((b"connection", b"close"))
            data = json.dumps(
                {"detail": {"code": error.code, "message": "ML request was not accepted"}}
            ).encode()
            await safe_send(
                {
                    "type": "http.response.start",
                    "status": error.status,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(data)).encode()),
                        *headers,
                    ],
                }
            )
            await safe_send({"type": "http.response.body", "body": data})
        except asyncio.CancelledError:
            outcome, status = "cancelled", 499
            raise
        except Exception:
            # Exception messages/body/model values never enter these operational logs.
            outcome = "application_error"
            raise
        finally:
            try:
                if body is not None:
                    # Bound cleanup allocations too; never allocate another full image.
                    for offset in range(0, len(body), 65536):
                        count = min(65536, len(body) - offset)
                        body[offset : offset + count] = b"\x00" * count
                    body.clear()
            finally:
                if acquired:
                    self.slots.release()
            elapsed = self.clock() - started
            duration = max(0, round(elapsed * 1000, 3)) if math.isfinite(elapsed) else 0
            try:
                _LOG.info(
                    json.dumps(
                        {
                            "action": "ml_http_request",
                            "route": route,
                            "request_id": request_id,
                            "status": status,
                            "outcome": outcome,
                            "duration_ms": duration,
                            "body_bytes": request_bytes,
                        }
                    )
                )
            except Exception:
                pass  # Non-authoritative instrumentation cannot fail inference.

    @staticmethod
    def _request_id(scope: dict[str, Any]) -> str:
        values = [v for k, v in scope.get("headers", []) if k.lower() == b"x-request-id"]
        if len(values) == 1:
            try:
                text = values[0].decode("ascii")
                if _UUID.fullmatch(text):
                    return text.lower()
            except (UnicodeDecodeError, AttributeError):
                pass
        return str(uuid.uuid4())
