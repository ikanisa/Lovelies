"""Real bounded loopback HTTP checks; no existing server or workspace writes."""

from contextlib import closing
import http.client
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest


source = Path(__file__).with_name("serve-preview.py")
spec = importlib.util.spec_from_file_location("lovelies_preview_server", source)
preview_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview_server)


class PreviewHttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lovelies-preview-http-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "workspace"
        self.root.mkdir()
        self.secret = b"PRIVATE_BACKEND_CONFIGURATION_MUST_NOT_BE_SERVED"
        # These fixtures are independent consumer URLs and content, not values
        # imported from the server's public-path policy.
        files = {
            "admin/index.html": b'<link rel="manifest" href="./manifest.webmanifest"><script type="module" src="./app.js"></script>',
            "admin/app.js": b"import { createDemoStore } from './demo-store.mjs'",
            "admin/demo-store.mjs": b"export function createDemoStore() {}",
            "admin/view-model.mjs": b"export const filters = {};",
            "admin/collection-views.mjs": b"export function renderCollection() {}",
            "admin/detail-views.mjs": b"export function renderCaseDetail() {}",
            "admin/styles.css": b"body { background: #f7f8fa; }",
            "admin/workspace.css": b".topbar { min-height: 68px; }",
            "admin/collection-views.css": b".collection-view { min-width: 0; }",
            "admin/detail-views.css": b".detail-body { min-width: 0; }",
            "admin/manifest.webmanifest": b'{"name":"Lovelies Admin Preview","scope":"/admin/"}',
            "admin/sw.js": b"self.addEventListener('fetch', () => {})",
            "admin/icon.svg": b'<svg xmlns="http://www.w3.org/2000/svg"/>',
            "admin/icon-192.png": b"PUBLIC_ADMIN_ICON_192",
            "admin/icon-512.png": b"PUBLIC_ADMIN_ICON_512",
            "admin/apple-touch-icon.png": b"PUBLIC_ADMIN_TOUCH_ICON",
            "preview/index.html": b'<link href="./styles.css"><script src="./app.js"></script>',
            "preview/app.js": b"fetch('../shared/catalog.json')",
            "preview/styles.css": b"body { background: #09090b; }",
            "preview/README.md": b"Preview reference notes",
            "shared/catalog.json": b'{"screens":48}',
            "shared/home-grid.json": b'{"tiles":[]}',
            "shared/assets/photo01.jpg": b"PUBLIC_MEMORY_IMAGE",
            "shared/reference-art/setup-hero.png": b"PUBLIC_ILLUSTRATION",
            "shared/reference-grids/layouts.json": b'{"13":{"tiles":[]}}',
            "shared/reference-grids/assets/ref13_01.jpg": b"PUBLIC_TILE_CROP",
            "Lovelies-48-Screen-PNGs/screens/Screen 01.png": b"PUBLIC_SCREEN_REFERENCE",
            "clients/backend/client.mjs": b"export class LoveliesClient {}",
            "clients/backend/contracts.mjs": b"export const protocol='reviewed-sharing-v1'",
            "clients/backend/face-contracts.mjs": b"export const FACE_PROTOCOL='lovelies-face-auth-v1'",
            "backend/config.json": self.secret,
            "services/api-worker/src/index.ts": self.secret,
            "services/api-worker/wrangler.jsonc": self.secret,
            "services/cloudflare-api/src/face-auth.ts": self.secret,
            "services/cloudflare-api/wrangler.jsonc": self.secret,
            "services/cloudflare-api/.dev.vars": self.secret,
            "supabase/config.toml": self.secret,
            "node_modules/private/index.js": self.secret,
            "verification/backend-reuse/donor-worker-import.json": self.secret,
            "deliverables/app.apk": self.secret,
            "shared/privacy-execution.ts": self.secret,
            "shared/reference-grids/extract.py": self.secret,
            "shared/assets/config.json": self.secret,
            "clients/backend/client.test.mjs": self.secret,
            ".env": self.secret,
            "preview/.dev.vars": self.secret,
            "admin/.env": self.secret,
            "admin/config.json": self.secret,
            "admin/private.json": self.secret,
            "admin/source.ts": self.secret,
            "admin/assets/private.png": self.secret,
            "shared/assets/.dev.vars": self.secret,
            "shared/assets/.hidden/photo.jpg": self.secret,
        }
        for name, data in files.items():
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        self.server = preview_server.make_server(self.root, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive(), "Owned ephemeral HTTP thread must close")

    def request(self, path, method="GET"):
        with closing(http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)) as client:
            client.request(method, path)
            response = client.getresponse()
            return response.status, dict(response.getheaders()), response.read()

    def test_preview_navigation_and_relative_assets_remain_available(self):
        for path in ["/", "/preview"]:
            status, headers, data = self.request(path)
            self.assertEqual(status, 302)
            self.assertEqual(headers["Location"], "/preview/")
            self.assertEqual(data, b"")
        expected = {
            "/preview/": b'<link href="./styles.css"><script src="./app.js"></script>',
            "/preview/app.js": b"fetch('../shared/catalog.json')",
            "/shared/catalog.json": b'{"screens":48}',
            "/shared/assets/photo01.jpg": b"PUBLIC_MEMORY_IMAGE",
            "/shared/reference-art/setup-hero.png": b"PUBLIC_ILLUSTRATION",
            "/shared/reference-grids/assets/ref13_01.jpg": b"PUBLIC_TILE_CROP",
            "/Lovelies-48-Screen-PNGs/screens/Screen%2001.png": b"PUBLIC_SCREEN_REFERENCE",
        }
        for path, data in expected.items():
            with self.subTest(path=path):
                status, headers, actual = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(actual, data)
                self.assertEqual(int(headers["Content-Length"]), len(data))
        status, headers, body = self.request("/preview/styles.css?v=2", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertIn("text/css", headers["Content-Type"])

    def test_public_client_modules_and_layout_data_are_readable(self):
        for path, mime in [("/clients/backend/client.mjs", "application/javascript"),
                           ("/clients/backend/contracts.mjs", "application/javascript"),
                           ("/clients/backend/face-contracts.mjs", "application/javascript"),
                           ("/shared/home-grid.json", "application/json"),
                           ("/shared/reference-grids/layouts.json", "application/json"),
                           ("/preview/README.md", "text/")]:
            with self.subTest(path=path):
                status, headers, data = self.request(path)
                self.assertEqual(status, 200)
                self.assertIn(mime, headers["Content-Type"])
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertNotIn(self.secret, data)

    def test_admin_navigation_shell_and_install_assets_are_available(self):
        status, headers, data = self.request("/admin")
        self.assertEqual((status, headers["Location"], data), (302, "/admin/", b""))
        status, _, data = self.request("/admin/")
        self.assertEqual(status, 200)
        self.assertIn(b"manifest.webmanifest", data)
        for path, mime in [
            ("/admin/index.html", "text/html"),
            ("/admin/app.js", "javascript"),
            ("/admin/demo-store.mjs", "application/javascript"),
            ("/admin/view-model.mjs", "application/javascript"),
            ("/admin/collection-views.mjs", "application/javascript"),
            ("/admin/detail-views.mjs", "application/javascript"),
            ("/admin/styles.css", "text/css"),
            ("/admin/workspace.css", "text/css"),
            ("/admin/collection-views.css", "text/css"),
            ("/admin/detail-views.css", "text/css"),
            ("/admin/manifest.webmanifest", "application/manifest+json"),
            ("/admin/sw.js", "javascript"),
            ("/admin/icon.svg", "image/svg+xml"),
            ("/admin/icon-192.png", "image/png"),
            ("/admin/icon-512.png", "image/png"),
            ("/admin/apple-touch-icon.png", "image/png"),
        ]:
            with self.subTest(path=path):
                status, headers, data = self.request(path)
                self.assertEqual(status, 200)
                self.assertIn(mime, headers["Content-Type"])
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertNotIn(self.secret, data)
                if path == "/admin/sw.js":
                    self.assertEqual(headers["Service-Worker-Allowed"], "/admin/")
                else:
                    self.assertNotIn("Service-Worker-Allowed", headers)

    def test_admin_allowlist_does_not_expose_private_files_or_fallback_routes(self):
        for path in ["/admin/.env", "/admin/config.json", "/admin/private.json",
                     "/admin/source.ts", "/admin/assets/private.png", "/admin/api/users",
                     "/admin/assets/", "/admin/%2e%2e/backend/config.json"]:
            with self.subTest(path=path):
                status, _, data = self.request(path)
                self.assertIn(status, (403, 404))
                self.assertNotIn(self.secret, data)
                self.assertNotIn(b"Directory listing", data)

    def test_private_configuration_source_and_artifacts_are_unavailable(self):
        for path in ["/backend/config.json", "/services/api-worker/src/index.ts",
                     "/services/api-worker/wrangler.jsonc", "/supabase/config.toml",
                     "/services/cloudflare-api/src/face-auth.ts", "/services/cloudflare-api/wrangler.jsonc",
                     "/services/cloudflare-api/.dev.vars",
                     "/node_modules/private/index.js", "/verification/backend-reuse/donor-worker-import.json",
                     "/deliverables/app.apk", "/shared/privacy-execution.ts",
                     "/shared/reference-grids/extract.py", "/shared/assets/config.json",
                     "/clients/backend/client.test.mjs", "/.env", "/preview/.dev.vars",
                     "/shared/assets/.dev.vars", "/shared/assets/.hidden/photo.jpg"]:
            with self.subTest(path=path):
                status, _, data = self.request(path)
                self.assertIn(status, (403, 404))
                self.assertNotIn(self.secret, data)
                self.assertNotIn(str(self.root).encode(), data)

    def test_raw_and_encoded_traversal_cannot_leave_public_directories(self):
        for path in ["/preview/../.env", "/preview/%2e%2e/.env", "/preview/%2E%2E%2f.env",
                     "/shared/assets/../../backend/config.json", "/shared/assets/%252e%252e/config.json",
                     "/preview/%5c..%5c.env", "/preview/%00index.html", "/preview/%ZZ",
                     "/shared/assets/%ff.jpg"]:
            with self.subTest(path=path):
                status, _, data = self.request(path)
                self.assertIn(status, (403, 404))
                self.assertNotIn(self.secret, data)

    def test_directories_never_produce_file_listings(self):
        for path in ["/shared/", "/shared/assets/", "/shared/reference-grids/",
                     "/Lovelies-48-Screen-PNGs/screens/", "/clients/backend/", "/verification/"]:
            with self.subTest(path=path):
                status, _, data = self.request(path)
                self.assertIn(status, (403, 404))
                self.assertNotIn(b"Directory listing", data)
                self.assertNotIn(b"photo01.jpg", data)

    def test_file_and_parent_symlinks_cannot_expose_private_or_external_bytes(self):
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (outside / "secret.jpg").write_bytes(self.secret)
        (self.root / "shared/assets/escape.jpg").symlink_to(outside / "secret.jpg")
        (self.root / "shared/assets/internal.jpg").symlink_to(self.root / "backend/config.json")
        (self.root / "shared/assets/alias.jpg").symlink_to(self.root / "shared/assets/photo01.jpg")
        (self.root / "shared/assets/external").symlink_to(outside, target_is_directory=True)
        for path in ["/shared/assets/escape.jpg", "/shared/assets/internal.jpg",
                     "/shared/assets/alias.jpg", "/shared/assets/external/secret.jpg"]:
            with self.subTest(path=path):
                status, _, data = self.request(path)
                self.assertIn(status, (403, 404))
                self.assertNotIn(self.secret, data)
        status, _, data = self.request("/shared/assets/photo01.jpg")
        self.assertEqual((status, data), (200, b"PUBLIC_MEMORY_IMAGE"))
        self.assertEqual(self.server.server_address[0], "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
