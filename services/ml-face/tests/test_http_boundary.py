"""Tests the actual pure-ASGI boundary without ML models or image-codec shims."""

import asyncio
import json
import logging
import uuid

import pytest

from pictured_ml_face.http_boundary import MlHttpBoundary, body_limits


def scope(path="/v1/process-photo-binary", headers=(), method="POST"):
    return {
        "type": "http",
        "path": path,
        "method": method,
        "headers": list(headers),
        "query_string": b"",
    }


def receiver(chunks):
    remaining = iter(chunks)

    async def receive():
        return next(remaining, {"type": "http.disconnect"})

    return receive


def request_bytes(data=b"abc", more=False):
    return {"type": "http.request", "body": data, "more_body": more}


async def echo_app(scope, receive, send):
    message = await receive()
    data = message.get("body", b"")
    await send(
        {"type": "http.response.start", "status": 200, "headers": [(b"cache-control", b"public")]}
    )
    await send({"type": "http.response.body", "body": data})


def run(boundary, request_scope=None, chunks=None):
    sent = []

    async def send(message):
        sent.append(message)

    asyncio.run(boundary(request_scope or scope(), receiver(chunks or [request_bytes()]), send))
    return sent


def status(messages):
    return next(m["status"] for m in messages if m["type"] == "http.response.start")


def code(messages):
    return json.loads(messages[-1]["body"])["detail"]["code"]


def test_transport_limits_are_route_specific():
    limits = body_limits()
    assert limits["/v1/process-photo-binary"] == 20 * 1024 * 1024
    assert limits["/v1/process-photo"] == ((20 * 1024 * 1024 + 2) // 3) * 4 + 65536
    assert limits["/v1/match-face"] == 16 * 1024 * 1024


@pytest.mark.parametrize("value", [0, -1, True, 2.5, 16 + 1])
def test_invalid_request_capacity_refused(value):
    with pytest.raises(ValueError):
        MlHttpBoundary(echo_app, max_requests=value)


@pytest.mark.parametrize("value", [0, -1, True, float("inf"), float("nan"), 121])
def test_invalid_timeout_refused(value):
    with pytest.raises(ValueError):
        MlHttpBoundary(echo_app, body_timeout_seconds=value)


@pytest.mark.parametrize("value", [0, True, 0.5, 20971521])
def test_invalid_image_limit_refused(value):
    with pytest.raises(ValueError):
        body_limits(value)


def test_exact_limit_replayed_intact_with_security_headers():
    messages = run(
        MlHttpBoundary(echo_app, image_bytes=4),
        chunks=[request_bytes(b"ab", True), request_bytes(b"cd")],
    )
    assert status(messages) == 200
    assert messages[-1]["body"] == b"abcd"
    headers = dict(messages[0]["headers"])
    assert headers[b"cache-control"] == b"no-store"
    assert headers[b"x-content-type-options"] == b"nosniff"
    uuid.UUID(headers[b"x-request-id"].decode())


@pytest.mark.parametrize("headers", [[], [(b"content-length", b"1")]])
def test_actual_bytes_enforced_with_missing_or_understated_header(headers):
    messages = run(
        MlHttpBoundary(echo_app, image_bytes=3),
        scope(headers=headers),
        [request_bytes(b"ab", True), request_bytes(b"cd")],
    )
    assert status(messages) == 413
    assert code(messages) == "request_body_too_large"


@pytest.mark.parametrize(
    "value", [b"-1", b"+3", b"03", b"3.0", b"1e2", b"abc", b"3, 3", b" ", b"9" * 20]
)
def test_malformed_content_length_fails_before_receive(value):
    calls = []

    async def no_read():
        calls.append(1)
        return request_bytes()

    async def check():
        sent = []

        async def send(message):
            sent.append(message)

        await MlHttpBoundary(echo_app)(scope(headers=[(b"content-length", value)]), no_read, send)
        assert status(sent) == 400

    asyncio.run(check())
    assert not calls


def test_duplicate_content_length_refused():
    messages = run(
        MlHttpBoundary(echo_app),
        scope(headers=[(b"content-length", b"3"), (b"content-length", b"3")]),
    )
    assert status(messages) == 400


@pytest.mark.parametrize("path,method", [("/v1/process-photo-binary", "POST"), ("/health", "GET")])
@pytest.mark.parametrize("transfer", [b"chunked", b"", b"gzip"])
def test_mixed_transfer_and_length_framing_rejected_before_body_read(path, method, transfer):
    calls = []

    async def no_read():
        calls.append("body")
        return request_bytes()

    async def check():
        sent = []

        async def send(message):
            sent.append(message)

        request = scope(path, [(b"Transfer-Encoding", transfer), (b"Content-Length", b"3")], method)
        await MlHttpBoundary(echo_app)(request, no_read, send)
        assert status(sent) == 400
        assert code(sent) == "ambiguous_request_framing"
        assert dict(sent[0]["headers"])[b"connection"] == b"close"

    asyncio.run(check())
    assert not calls


@pytest.mark.parametrize("transfer", [b"", b"gzip", b"identity", b"chunked, chunked"])
def test_unapproved_transfer_encoding_is_rejected(transfer):
    messages = run(MlHttpBoundary(echo_app), scope(headers=[(b"transfer-encoding", transfer)]))
    assert status(messages) == 400
    assert code(messages) == "invalid_transfer_encoding"


def test_duplicate_transfer_encoding_is_rejected():
    messages = run(MlHttpBoundary(echo_app), scope(headers=[
        (b"transfer-encoding", b"chunked"), (b"transfer-encoding", b"chunked")
    ]))
    assert status(messages) == 400
    assert code(messages) == "invalid_transfer_encoding"


def test_valid_chunked_framing_retains_bounded_decoded_body():
    messages = run(MlHttpBoundary(echo_app, image_bytes=3), scope(headers=[
        (b"transfer-encoding", b"chunked")
    ]))
    assert status(messages) == 200
    assert messages[-1]["body"] == b"abc"
    messages = run(MlHttpBoundary(echo_app, image_bytes=2), scope(headers=[
        (b"transfer-encoding", b"chunked")
    ]))
    assert status(messages) == 413


@pytest.mark.parametrize("length", [b"2", b"4"])
def test_final_length_mismatch_refused(length):
    messages = run(MlHttpBoundary(echo_app), scope(headers=[(b"content-length", length)]))
    assert code(messages) == "content_length_mismatch"


def test_declared_over_limit_does_not_acquire_a_slot():
    boundary = MlHttpBoundary(echo_app, image_bytes=3, max_requests=1)
    assert status(run(boundary, scope(headers=[(b"content-length", b"4")]))) == 413
    assert status(run(boundary)) == 200


@pytest.mark.parametrize("encoding", [b"gzip", b"br", b"gzip,identity"])
def test_compressed_wire_body_refused(encoding):
    messages = run(MlHttpBoundary(echo_app), scope(headers=[(b"content-encoding", encoding)]))
    assert status(messages) == 415


def test_identity_content_encoding_allowed():
    assert (
        status(run(MlHttpBoundary(echo_app), scope(headers=[(b"content-encoding", b"identity")])))
        == 200
    )


def test_timeout_releases_admission():
    boundary = MlHttpBoundary(echo_app, max_requests=1, body_timeout_seconds=0.01)

    async def slow():
        await asyncio.sleep(2)
        return request_bytes()

    async def check():
        sent = []

        async def send(m):
            sent.append(m)

        await boundary(scope(), slow, send)
        assert status(sent) == 408

    asyncio.run(check())
    assert status(run(boundary)) == 200


def test_backpressure_precedes_read_and_health_bypasses_full_capacity():
    async def check():
        entered, release = asyncio.Event(), asyncio.Event()
        read_on_rejected = False

        async def app(s, receive, send):
            if s["path"] != "/health":
                await receive()
                entered.set()
                await release.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        boundary = MlHttpBoundary(app, max_requests=1)

        async def discard(_):
            pass

        first = asyncio.create_task(boundary(scope(), receiver([request_bytes()]), discard))
        await entered.wait()

        async def should_not_read():
            nonlocal read_on_rejected
            read_on_rejected = True
            return request_bytes()

        rejected, health = [], []

        async def record_rejection(m):
            rejected.append(m)

        async def record_health(m):
            health.append(m)

        await boundary(scope(), should_not_read, record_rejection)
        await boundary(scope("/health", method="GET"), should_not_read, record_health)
        assert status(rejected) == 503
        assert dict(rejected[0]["headers"])[b"retry-after"] == b"2"
        assert status(health) == 200
        assert not read_on_rejected
        release.set()
        await first

    asyncio.run(check())


def test_client_disconnect_releases_slot_without_response():
    boundary = MlHttpBoundary(echo_app, max_requests=1)
    assert run(boundary, chunks=[{"type": "http.disconnect"}]) == []
    assert status(run(boundary)) == 200


def test_cancelled_request_releases_slot():
    async def check():
        boundary = MlHttpBoundary(echo_app, max_requests=1)
        waiting = asyncio.Event()

        async def receive():
            waiting.set()
            await asyncio.sleep(2)
            return request_bytes()

        async def discard(_):
            pass

        task = asyncio.create_task(boundary(scope(), receive, discard))
        await waiting.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert boundary.slots.acquire(blocking=False)
        boundary.slots.release()

    asyncio.run(check())


def test_application_error_releases_slot_and_keeps_exception_out_of_logs(caplog):
    async def fail(s, r, send):
        raise RuntimeError("PRIVATE VECTOR")

    boundary = MlHttpBoundary(fail, max_requests=1)
    with caplog.at_level(logging.INFO, logger="pictured_ml_face.http"):
        with pytest.raises(RuntimeError):
            run(boundary)
    assert "PRIVATE VECTOR" not in caplog.text
    assert boundary.slots.acquire(blocking=False)
    boundary.slots.release()


def test_log_and_response_do_not_reflect_private_input(caplog):
    async def ok(s, receive, send):
        await receive()
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    private = b"FACE_PRIVATE_DATA"
    with caplog.at_level(logging.INFO, logger="pictured_ml_face.http"):
        messages = run(
            MlHttpBoundary(ok),
            scope(headers=[(b"authorization", private), (b"x-request-id", private)]),
            [request_bytes(private)],
        )
    assert private.decode() not in caplog.text
    assert private not in repr(messages).encode()
    row = json.loads(caplog.records[-1].message)
    assert set(row) == {
        "action",
        "route",
        "request_id",
        "status",
        "outcome",
        "duration_ms",
        "body_bytes",
    }
    assert row["body_bytes"] == len(private)


def test_valid_request_id_is_preserved_but_duplicates_are_replaced():
    good = b"60000000-0000-4000-8000-000000000001"
    single = run(MlHttpBoundary(echo_app), scope(headers=[(b"x-request-id", good)]))
    duplicate = run(
        MlHttpBoundary(echo_app), scope(headers=[(b"x-request-id", good), (b"x-request-id", good)])
    )
    assert dict(single[0]["headers"])[b"x-request-id"] == good
    assert dict(duplicate[0]["headers"])[b"x-request-id"] != good


def test_non_http_passthrough():
    seen = []

    async def app(s, r, send):
        seen.append(s["type"])

    async def discard(_):
        pass

    asyncio.run(MlHttpBoundary(app)({"type": "lifespan"}, receiver([]), discard))
    assert seen == ["lifespan"]


def test_no_log_failure_changes_a_successful_response(monkeypatch):
    from pictured_ml_face import http_boundary

    monkeypatch.setattr(
        http_boundary._LOG,
        "info",
        lambda *args: (_ for _ in ()).throw(RuntimeError("logger failure")),
    )
    assert status(run(MlHttpBoundary(echo_app))) == 200


# V8: fake monotonic time, but the real ASGI boundary and real asyncio execution.
# Advancing during receive reproduces a delayed result winning a due timer.
@pytest.mark.parametrize("chunk", [b"", b"abc"])
def test_final_receive_cannot_overrun_the_absolute_body_deadline(chunk):
    clock = [0.0]
    boundary = MlHttpBoundary(
        echo_app, max_requests=1, body_timeout_seconds=1, clock=lambda: clock[0]
    )

    async def check():
        async def late_receive():
            await asyncio.sleep(0)
            clock[0] = 2.0
            return request_bytes(chunk)

        sent = []

        async def send(message):
            sent.append(message)

        await boundary(scope(), late_receive, send)
        assert status(sent) == 408
        assert code(sent) == "request_body_timeout"

    asyncio.run(check())
    # Failure releases the actual request permit for the next request.
    assert status(run(boundary)) == 200


def test_chunk_progress_does_not_reset_the_absolute_body_deadline():
    clock, calls = [0.0], []
    boundary = MlHttpBoundary(echo_app, body_timeout_seconds=1, clock=lambda: clock[0])

    async def check():
        async def receive():
            await asyncio.sleep(0)
            calls.append(1)
            clock[0] += 0.6
            return request_bytes(b"x", more=len(calls) < 2)

        sent = []

        async def send(message):
            sent.append(message)

        await boundary(scope(), receive, send)
        assert status(sent) == 408
        assert code(sent) == "request_body_timeout"
        assert len(calls) == 2

    asyncio.run(check())


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
def test_invalid_monotonic_clock_is_not_a_successful_body_read(bad):
    values = [0.0, bad]
    boundary = MlHttpBoundary(echo_app, clock=lambda: values.pop(0) if values else 0.0)
    messages = run(boundary)
    assert status(messages) == 503
    assert code(messages) == "invalid_ml_transport_clock"
    assert status(run(boundary)) == 200


def test_clock_regression_cannot_extend_an_accepted_read_budget():
    values = [1.0, 1.0, 0.0]
    boundary = MlHttpBoundary(echo_app, clock=lambda: values.pop(0) if values else 1.0)
    messages = run(boundary)
    assert status(messages) == 503
    assert code(messages) == "invalid_ml_transport_clock"
    assert status(run(boundary)) == 200
