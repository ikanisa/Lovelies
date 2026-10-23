#!/usr/bin/env python3
"""Serve the Lovelies mobile/admin previews and public references on loopback."""

from __future__ import annotations

import argparse
import mimetypes
import os
from pathlib import Path
import re
import shutil
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


WORKSPACE = Path(__file__).resolve().parent.parent
PUBLIC_FILES = frozenset({
    ("web", "index.html"),
    ("web", "privacy", "index.html"),
    ("web", "terms", "index.html"),
    ("web", "account-deletion", "index.html"),
    ("web", "support", "index.html"),
    ("web", "site.css"),
    ("web", "robots.txt"),
    ("admin", "index.html"),
    ("admin", "app.js"),
    ("admin", "entry.mjs"),
    ("admin", "live-app.mjs"),
    ("admin", "live-workspace.css"),
    ("admin", "operator-session.mjs"),
    ("admin", "runtime-config.mjs"),
    ("admin", "demo-store.mjs"),
    ("admin", "view-model.mjs"),
    ("admin", "collection-views.mjs"),
    ("admin", "detail-views.mjs"),
    ("admin", "styles.css"),
    ("admin", "workspace.css"),
    ("admin", "collection-views.css"),
    ("admin", "detail-views.css"),
    ("admin", "manifest.webmanifest"),
    ("admin", "sw.js"),
    ("admin", "icon.svg"),
    ("admin", "icon-192.png"),
    ("admin", "icon-512.png"),
    ("admin", "apple-touch-icon.png"),
    ("preview", "index.html"),
    ("preview", "app.js"),
    ("preview", "styles.css"),
    ("preview", "README.md"),
    ("shared", "catalog.json"),
    ("shared", "home-grid.json"),
    ("shared", "assets", "asset-manifest.json"),
    ("shared", "reference-art", "manifest.json"),
    ("shared", "reference-grids", "layouts.json"),
    ("shared", "reference-grids", "asset-manifest.json"),
    ("clients", "backend", "client.mjs"),
    ("clients", "backend", "contracts.mjs"),
    ("clients", "backend", "face-contracts.mjs"),
    ("Lovelies-48-Screen-PNGs", "screen-index.csv"),
    ("Lovelies-48-Screen-PNGs", "screen-manifest.json"),
    ("Lovelies-48-Screen-PNGs", "README.txt"),
})
IMAGE_DIRECTORIES = (
    ("web", "assets"),
    ("shared", "assets"),
    ("shared", "reference-art"),
    ("shared", "reference-grids", "assets"),
    ("Lovelies-48-Screen-PNGs", "screens"),
)
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"})


def public_path(raw_path: str) -> tuple[str, ...]:
    """Decode once; reject traversal before selecting any filesystem path."""
    if len(raw_path) > 8192:
        raise ValueError("invalid path")
    path = urlsplit(raw_path).path
    if re.search(r"%(?![0-9a-fA-F]{2})", path):
        raise ValueError("invalid encoding")
    path = unquote(path, encoding="utf-8", errors="strict")
    if not path.startswith("/") or "\\" in path or "%" in path or any(ord(char) < 32 or ord(char) == 127 for char in path):
        raise ValueError("invalid path")
    parts = tuple(path[1:].split("/"))
    if any(part in {".", ".."} or part.startswith(".") for part in parts):
        raise ValueError("private or relative path")
    if parts == ("preview", ""):
        return ("preview", "index.html")
    if parts == ("admin", ""):
        return ("admin", "index.html")
    if parts in {("web", ""), ("web", "privacy", ""), ("web", "terms", ""),
                 ("web", "account-deletion", ""), ("web", "support", "")}:
        return (*parts[:-1], "index.html")
    if any(not part for part in parts):
        raise FileNotFoundError("not a public file")
    if parts in PUBLIC_FILES:
        return parts
    if Path(parts[-1]).suffix.lower() in IMAGE_EXTENSIONS and any(
        parts[:len(prefix)] == prefix and len(parts) > len(prefix)
        for prefix in IMAGE_DIRECTORIES
    ):
        return parts
    raise FileNotFoundError("not a public file")


def open_public_file(root: Path, parts: tuple[str, ...]):
    """Open every component without following links, including parent races."""
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise FileNotFoundError("not a regular public file")
        return os.fdopen(descriptor, "rb"), metadata
    except BaseException:
        os.close(descriptor)
        raise


class PreviewHandler(BaseHTTPRequestHandler):
    server_version = "LoveliesPreview/1.0"
    sys_version = ""

    def do_GET(self):
        self._serve(head_only=False)

    def do_HEAD(self):
        self._serve(head_only=True)

    def _serve(self, *, head_only: bool):
        # Explicit navigation routes never enumerate the workspace.
        try:
            path = urlsplit(self.path).path
            if path in {"/", "/preview", "/admin"}:
                self.send_response(302)
                self.send_header("Location", "/admin/" if path == "/admin" else "/preview/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            parts = public_path(self.path)
            file, metadata = open_public_file(self.server.public_root, parts)
        except (ValueError, UnicodeError):
            self.send_error(403, "Path unavailable")
            return
        except OSError:
            self.send_error(404, "File unavailable")
            return
        with file:
            mime = mimetypes.guess_type(parts[-1])[0] or "application/octet-stream"
            if parts[-1].endswith(".mjs"):
                mime = "application/javascript"
            elif parts[-1].endswith(".webmanifest"):
                mime = "application/manifest+json"
            if mime.startswith("text/") or mime in {"application/javascript", "application/json"}:
                mime += "; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(metadata.st_size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if parts == ("admin", "sw.js"):
                self.send_header("Service-Worker-Allowed", "/admin/")
            self.end_headers()
            if not head_only:
                try:
                    shutil.copyfileobj(file, self.wfile, length=64 * 1024)
                except (BrokenPipeError, ConnectionResetError):
                    pass


class PreviewServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root: Path, port: int):
        self.public_root = root.resolve(strict=True)
        if not self.public_root.is_dir():
            raise ValueError("Preview root must be a directory")
        if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
            raise RuntimeError("Preview serving requires filesystem no-follow support")
        super().__init__(("127.0.0.1", port), PreviewHandler)


def make_server(root: Path = WORKSPACE, port: int = 8765) -> PreviewServer:
    if not 0 <= port <= 65535:
        raise ValueError("Port must be between 0 and 65535")
    return PreviewServer(Path(root), port)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="Loopback port (default: 8765)")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    with make_server(port=args.port) as server:
        print(f"Lovelies preview: http://127.0.0.1:{server.server_port}/preview/", flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
