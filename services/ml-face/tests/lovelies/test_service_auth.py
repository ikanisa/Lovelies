import asyncio
import pytest
from lovelies_ml_face.service_auth import ServiceAuthentication

@pytest.mark.parametrize("secret", [None,"short", "a"*32+"\n"])
def test_external_transport_requires_secret(secret):
    with pytest.raises(RuntimeError): ServiceAuthentication(None, mode="https_service", secret=secret)

@pytest.mark.parametrize("headers", [[], [(b"authorization",b"Bearer wrong")], [(b"authorization",b"Bearer "+b"s"*32)]*2])
def test_rejects_before_any_body_read(headers):
    async def run():
        async def forbidden(*_): raise AssertionError("untrusted body or inference reached")
        app=ServiceAuthentication(forbidden, mode="https_service",secret="s"*32)
        await app({"type":"http","headers":headers},forbidden,send)
    output=[]
    async def send(value): output.append(value)
    asyncio.run(run());assert output[0]["status"]==401;assert b"no-store" in dict(output[0]["headers"]).values()

def test_authenticated_forwarding_removes_credential():
    output=[]
    async def downstream(scope,*_): output.append(scope)
    async def send(_): raise AssertionError()
    asyncio.run(ServiceAuthentication(downstream,mode="https_service",secret="s"*32)(
        {"type":"http","headers":[(b"authorization",b"Bearer "+b"s"*32),(b"content-type",b"application/json")]},None,send))
    assert output[0]["headers"]==[(b"content-type",b"application/json")]
