"""Source preparation and separately gated runtime regressions for the candidate.

No model service is imported. Source-only checks do not qualify a native image.
Runtime cases require the real selected interpreter/library, and explicitly skip
on the unchanged old environment. Upstream issue/commit references are retained
in patches/cpython-backports and the artifact-specific repair plan.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import io
import json
from pathlib import Path
import shutil
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch

SERVICE = Path(__file__).resolve().parents[1]
BASE = SERVICE / "patches/cpython-backports"
SPEC = importlib.util.spec_from_file_location("candidate_backports", BASE / "cpython-apply-backports.py")
BACKPORTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKPORTS)
MANIFEST = json.loads((BASE / "cpython-backports-manifest.json").read_text())
UPSTREAM = BASE / "upstream/3.13.17"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class CandidateSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lovelies-security-source-")
        self.root = Path(self.temporary.name)
        self.stdlib = self.root / "stdlib"
        self.output = self.root / "prepared/stdlib"
        for entry in MANIFEST["modules"]:
            target = self.stdlib / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((UPSTREAM / "Lib" / entry["path"]).read_bytes())

    def tearDown(self):
        self.temporary.cleanup()

    def test_rebase_retains_new_tarfile_and_applies_only_missing_cleanup_fix(self):
        before = {entry["path"]: (self.stdlib / entry["path"]).read_bytes()
                  for entry in MANIFEST["modules"]}
        receipt = BACKPORTS.prepare_backports(self.stdlib, self.output)
        self.assertEqual([row["id"] for row in receipt["patches"]], ["PSF-2026-42"])
        self.assertEqual((self.output / "tarfile.py").read_bytes(), before["tarfile.py"])
        old = json.loads((BASE / "history/3.13.15/cpython-backports-manifest.json").read_text())
        previous = {row["path"]: row for row in old["modules"]}
        self.assertNotEqual(digest(before["tarfile.py"]), previous["tarfile.py"]["patched_sha256"])
        for name in ("tempfile.py", "shutil.py"):
            self.assertEqual(digest((self.output / name).read_bytes()), previous[name]["patched_sha256"])
        for name, data in before.items():
            self.assertEqual((self.stdlib / name).read_bytes(), data)
        self.assertFalse(receipt["native_binary_qualified"])
        self.assertEqual(len(receipt["modules"]), 7)

    def test_tar_containment_link_and_filter_rejection_source_survive(self):
        text = (UPSTREAM / "Lib/tarfile.py").read_text()
        self.assertIn("normalized = os.path.normpath(name)", text)
        self.assertIn("os.link(os.path.realpath(tarinfo._link_target), targetpath)", text)
        self.assertIn("unfiltered.replace(name=tarinfo.name, deep=False),\n"
                      "                    extraction_root)\n"
                      "                if filtered is None:\n                    return", text)
        evidence = BACKPORTS.verify_upstream_source_evidence(BASE, MANIFEST)
        ids = {identifier for row in evidence["source_checks"] for identifier in row["ids"]}
        self.assertTrue({"CVE-2026-19672", "CVE-2026-82049", "CVE-2026-87910",
                         "CVE-2026-19445", "CVE-2026-19553"} <= ids)
        self.assertFalse(evidence["native_binary_qualified"])

    def test_wrong_original_is_rejected_before_output(self):
        target = self.stdlib / "tarfile.py"
        target.write_bytes(target.read_bytes() + b"\n# changed\n")
        with self.assertRaisesRegex(ValueError, "Original module hash differs"):
            BACKPORTS.prepare_backports(self.stdlib, self.output)
        self.assertFalse(self.output.exists())
        self.assertFalse((self.output.parent / "cpython-backport-receipt.json").exists())

    def test_symlink_original_is_rejected(self):
        target = self.stdlib / "ssl.py"
        original = self.root / "ssl-original.py"
        target.rename(original)
        target.symlink_to(original)
        with self.assertRaisesRegex(ValueError, "ordinary stdlib file"):
            BACKPORTS.prepare_backports(self.stdlib, self.output)
        self.assertFalse(self.output.exists())

    def test_altered_patch_is_rejected_before_output(self):
        candidate = self.root / "candidate"
        shutil.copytree(BASE, candidate)
        target = candidate / "cpython-runtime-CVE-2026-12345.patch"
        target.write_bytes(target.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "Patch hash differs"):
            BACKPORTS.prepare_backports(self.stdlib, self.output, candidate)
        self.assertFalse(self.output.exists())

    def test_changed_source_proof_is_rejected(self):
        candidate = self.root / "candidate"
        shutil.copytree(BASE, candidate)
        target = candidate / "upstream/3.13.17/Modules/_ssl.c"
        target.write_bytes(target.read_bytes().replace(b"Py_XNewRef(sslctx->set_sni_cb)",
                                                      b"sslctx->set_sni_cb", 1))
        with self.assertRaisesRegex(ValueError, "Upstream source hash differs"):
            BACKPORTS.prepare_backports(self.stdlib, self.output, candidate)
        self.assertFalse(self.output.exists())

    def test_previous_receipt_is_preserved(self):
        self.output.parent.mkdir()
        receipt = self.output.parent / "cpython-backport-receipt.json"
        receipt.write_bytes(b"historical-evidence\n")
        with self.assertRaisesRegex(ValueError, "Preserve the existing backport receipt"):
            BACKPORTS.prepare_backports(self.stdlib, self.output)
        self.assertEqual(receipt.read_bytes(), b"historical-evidence\n")
        self.assertFalse(self.output.exists())

    def test_wrong_interpreter_cannot_run_installer(self):
        argv = ["candidate-backports", "--stdlib", str(self.stdlib), "--output", str(self.output)]
        with patch.object(sys, "argv", argv), patch.object(sys, "version_info", (3, 13, 15)):
            with self.assertRaisesRegex(SystemExit, "only valid for CPython 3.13.17"):
                BACKPORTS.main()
        self.assertFalse(self.output.exists())

    def test_registry_pin_matches_candidate_metadata_and_old_manifest_remains(self):
        base = json.loads((BASE / "python-base-image-candidate.json").read_text())
        dockerfile = (SERVICE / "Dockerfile").read_text()
        self.assertIn("python:3.13.17-slim-trixie@" + base["index_digest"], dockerfile)
        self.assertIn(base["amd64_manifest_digest"], dockerfile)
        self.assertEqual((base["os"], base["architecture"], base["python_version"]),
                         ("linux", "amd64", "3.13.17"))
        self.assertFalse(base["layers_downloaded"])
        old = json.loads((BASE / "history/3.13.15/cpython-backports-manifest.json").read_text())
        self.assertEqual(old["base_version"], "3.13.15")
        self.assertEqual(len(old["patch_order"]), 7)
        self.assertEqual(len(old["modules"]), 6)


@unittest.skipUnless(sys.version_info[:3] == (3, 13, 17),
                     "Requires actual candidate CPython 3.13.17; source checks are separate")
class CandidateSSLRuntimeTests(unittest.TestCase):
    def test_wrap_bio_rejects_missing_hostname_and_accepts_valid_hostname(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        for hostname in (None, ""):
            with self.subTest(hostname=hostname), self.assertRaises(ValueError):
                context.wrap_bio(ssl.MemoryBIO(), ssl.MemoryBIO(), server_hostname=hostname)
        connection = context.wrap_bio(ssl.MemoryBIO(), ssl.MemoryBIO(),
                                      server_hostname="candidate.invalid")
        self.assertEqual(connection.server_hostname, "candidate.invalid")

    def test_sni_context_release_then_callback_error_has_a_controlled_tls_failure(self):
        # Behavioral regression for upstream d8717ed; no certificate or network is needed.
        original = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        replacement = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        holders = [original]
        seen, unraisable = [], []

        def select_context(connection, hostname, _context):
            seen.append(hostname)
            connection.context = replacement
            holders.clear()
            raise ValueError("candidate-sni-callback")

        original.sni_callback = select_context
        incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
        server = original.wrap_bio(incoming, outgoing, server_side=True)
        del original
        client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        # Own both BIOs explicitly to transfer only the generated ClientHello.
        client_in, client_out = ssl.MemoryBIO(), ssl.MemoryBIO()
        client = client_context.wrap_bio(client_in, client_out, server_hostname="candidate.invalid")
        with self.assertRaises(ssl.SSLWantReadError):
            client.do_handshake()
        incoming.write(client_out.read())
        with patch.object(sys, "unraisablehook", unraisable.append):
            with self.assertRaises(ssl.SSLError):
                server.do_handshake()
        self.assertEqual(seen, ["candidate.invalid"])
        self.assertEqual(holders, [])
        self.assertEqual(len(unraisable), 1)
        self.assertEqual(unraisable[0].exc_type, ValueError)


try:
    PILLOW_VERSION = importlib.metadata.version("Pillow")
except importlib.metadata.PackageNotFoundError:
    PILLOW_VERSION = None


@unittest.skipUnless(PILLOW_VERSION == "13.0.0",
                     "Requires actual Pillow 13.0.0; unchanged old ML environment is not upgraded")
class CandidatePillowRuntimeTests(unittest.TestCase):
    def test_bounded_duplicate_exif_headers(self):
        from PIL import Image
        source = Image.Exif()
        source[274] = 1
        encoded = source.tobytes()
        for prefix_count in (0, 1):
            parsed = Image.Exif()
            parsed.load(b"Exif\x00\x00" * prefix_count + encoded)
            self.assertEqual(parsed[274], 1)
        with self.assertRaises(SyntaxError):
            Image.Exif().load(b"Exif\x00\x00" * 2 + encoded)

    def test_jpeg_decoder_rejects_scanline_wider_than_declared_tile(self):
        from PIL import Image
        encoded = io.BytesIO()
        Image.new("RGB", (128, 128), "white").save(encoded, format="JPEG")
        encoded.seek(0)
        with Image.open(encoded) as image:
            image.tile = [image.tile[0]._replace(extents=(0, 0, 16, 16))]
            with self.assertRaises(OSError):
                image.load()

    def test_mpo_seek_retires_core_storage_before_mode_change(self):
        from PIL import Image
        encoded = io.BytesIO()
        Image.new("L", (32, 32), 128).save(encoded, format="MPO", save_all=True,
                                           append_images=[Image.new("RGB", (32, 32), "white")])
        encoded.seek(0)
        with Image.open(encoded) as image:
            image.load()
            image.seek(1)
            self.assertIsNone(image._im)
            image.load()
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.im.mode, "RGB")

    def test_tiff_in_memory_seek_past_buffer_matches_regular_file(self):
        from PIL import Image
        image = Image.new("L", (7, 8191))
        image.putdata(bytes(range(7)) * 8191)
        encoded = io.BytesIO()
        options = {"format": "TIFF", "compression": "packbits", "tiffinfo": {270: "a" * 65536}}
        image.save(encoded, **options)
        with tempfile.TemporaryDirectory(prefix="lovelies-tiff-candidate-") as directory:
            path = Path(directory) / "same.tif"
            image.save(path, **options)
            self.assertEqual(encoded.getvalue(), path.read_bytes())


if __name__ == "__main__":
    unittest.main()
