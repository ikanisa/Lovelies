"""Optional external transport authentication, before body parsing or inference.

The private_binding mode is for a network-isolated service binding only. Supabase
calls an HTTPS service and must use https_service with an independent secret.
"""
from __future__ import annotations
import hmac
import os
from typing import Callable

class ServiceAuthentication:
    def __init__(self, app: Callable, *, mode: str, secret: str | None = None):
        if mode not in {"private_binding", "https_service"}:
            raise RuntimeError("Invalid private inference transport")
        if mode == "https_service" and (not secret or len(secret.encode()) < 32 or "\n" in secret or "\r" in secret):
            raise RuntimeError("HTTPS inference requires an independent service secret")
        self.app, self.mode = app, mode
        self.expected = ("Bearer " + (secret or "")).encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or self.mode == "private_binding":
            await self.app(scope, receive, send)
            return
        values = [value for name, value in scope.get("headers", []) if name.lower() == b"authorization"]
        if len(values) != 1 or not hmac.compare_digest(values[0], self.expected):
            body = b'{"error":{"code":"service_authentication_required"}}'
            await send({"type":"http.response.start", "status":401, "headers":[
                (b"content-type", b"application/json"), (b"cache-control", b"no-store"),
                (b"x-content-type-options", b"nosniff"), (b"content-length", str(len(body)).encode())]})
            await send({"type":"http.response.body", "body":body})
            return
        # Do not forward the gateway credential into parsing, inference or logs.
        current = {**scope, "headers":[(k,v) for k,v in scope.get("headers", []) if k.lower() != b"authorization"]}
        await self.app(current, receive, send)


def authenticated_transport(app, *, require_service_auth=False):
    mode = os.environ.get("ML_DEPLOYMENT_TRANSPORT", "https_service")
    if require_service_auth and mode != "https_service":
        raise RuntimeError("The Supabase inference consumer requires service authentication")
    return ServiceAuthentication(app, mode=mode, secret=os.environ.get("ML_INFERENCE_SECRET"))
