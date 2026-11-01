#!/usr/bin/env python3
"""Exercise the actual Caddy route tree with staged public files on loopback."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("stage_public", ROOT / "scripts/local-supabase-stage-public.py")
stage_public = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage_public)


class PublicDeploymentBoundary(unittest.TestCase):
    def test_actual_proxy_does_not_serve_repository_tests_or_private_routes(self):
        caddy = os.environ.get("LOVELIES_TEST_CADDY") or shutil.which("caddy")
        self.assertTrue(caddy, "A verified Caddy 2.11.7 binary is required for this qualification")
        with tempfile.TemporaryDirectory(prefix="lovelies-static-proof-") as work:
            work = Path(work)
            public = work / "built-public"
            public.mkdir()
            (public / "index.html").write_text("<!doctype html><title>Controlled public fixture</title>")
            staged = work / "stage"
            result = stage_public.stage(public, staged)
            self.assertGreater(result["files"], 20)
            self.assertFalse(list(staged.rglob("*.test.mjs")))
            self.assertFalse((staged / "package.json").exists())
            env = dict(os.environ, PUBLIC_HOST="api.example.test", ACME_EMAIL="operator@example.test",
                       XDG_CONFIG_HOME=str(work / "config"), XDG_DATA_HOME=str(work / "data"))
            adapted = subprocess.run([caddy, "adapt", "--config", str(ROOT / "deploy/local-supabase/Caddyfile"), "--adapter", "caddyfile"], capture_output=True, check=True, env=env)
            configuration = json.loads(adapted.stdout)
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]

            def replace_roots(value):
                if isinstance(value, dict):
                    return {key: replace_roots(item) for key, item in value.items()}
                if isinstance(value, list):
                    return [replace_roots(item) for item in value]
                if isinstance(value, str) and value.startswith("/srv"):
                    return str(staged) + value[4:]
                return value

            configuration = replace_roots(configuration)
            configuration["apps"].pop("tls", None)
            for server in configuration["apps"]["http"]["servers"].values():
                server["listen"] = [f"127.0.0.1:{port}"]
                server["automatic_https"] = {"disable": True}
                server.pop("tls_connection_policies", None)
            config_path = work / "caddy.json"
            config_path.write_text(json.dumps(configuration))
            process = subprocess.Popen([caddy, "run", "--config", str(config_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)

            def request(url, method="GET"):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                try:
                    connection.request(method, url, headers={"Host": "api.example.test"})
                    response = connection.getresponse()
                    response.read()
                    return response.status
                finally:
                    connection.close()

            try:
                for _ in range(30):
                    try:
                        if request("/admin/") == 200:
                            break
                    except OSError:
                        time.sleep(0.1)
                self.assertEqual(request("/admin/"), 200)
                self.assertEqual(request("/admin/entry.mjs"), 200)
                self.assertEqual(request("/clients/backend/contracts.mjs"), 200)
                for url in ["/admin/review-drafts.test.mjs", "/admin/security-regression.test.mjs", "/clients/backend/contracts.test.mjs", "/clients/backend/client.test.mjs", "/package.json", "/services/restore-journal/src/server.mjs", "/admin/%2e%2e/package.json"]:
                    self.assertEqual(request(url), 404, url)
                self.assertEqual(request("/auth/v1/signup", "POST"), 404)
                self.assertEqual(request("/functions/v1/lovelies-api/_internal/maintenance", "POST"), 404)
            finally:
                process.terminate()
                process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
