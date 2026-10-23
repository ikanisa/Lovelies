"""Start the ML service directly, without a shell in the runtime image."""
from __future__ import annotations

import os


def configured_port() -> int:
    value = os.environ.get("PORT") or "8080"
    try:
        port = int(value)
    except ValueError as error:
        raise ValueError("PORT must be an integer between 1 and 65535") from error
    if not 1 <= port <= 65535:
        raise ValueError("PORT must be an integer between 1 and 65535")
    return port


def main() -> None:
    port = configured_port()
    import uvicorn

    uvicorn.run(
        "pictured_ml_face.main:app",
        host="0.0.0.0",
        port=port,
        loop="asyncio",
        http="h11",
        ws="none",
    )


if __name__ == "__main__":
    main()
