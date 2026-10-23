"""Listener configuration remains fixed when shell utilities are removed."""
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from pictured_ml_face.__main__ import main


class RuntimeEntrypointTests(unittest.TestCase):
    def test_runtime_listener_configuration(self):
        for value, expected in [(None, 8080), ("", 8080), ("443", 443), ("65535", 65535)]:
            with self.subTest(port=value), patch.dict(os.environ), patch.dict(
                sys.modules, {"uvicorn": SimpleNamespace(run=Mock())}
            ):
                if value is None:
                    os.environ.pop("PORT", None)
                else:
                    os.environ["PORT"] = value
                main()
                sys.modules["uvicorn"].run.assert_called_once_with(
                    "pictured_ml_face.main:app", host="0.0.0.0", port=expected,
                    loop="asyncio", http="h11", ws="none",
                )

    def test_invalid_port_never_starts_listener(self):
        for value in ["0", "65536", "-1", "invalid", "1.5", "8080 --host 192.0.2.1"]:
            with self.subTest(port=value), patch.dict(os.environ, PORT=value), patch.dict(
                sys.modules, {"uvicorn": SimpleNamespace(run=Mock())}
            ):
                with self.assertRaisesRegex(ValueError, "PORT must be an integer between 1 and 65535"):
                    main()
                sys.modules["uvicorn"].run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
