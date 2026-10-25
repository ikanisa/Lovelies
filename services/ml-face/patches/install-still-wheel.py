"""Offline installer for the single pinned account-free OpenFace still wheel.

This installs no dependency and replaces no existing distribution. All archive,
RECORD and source-identity checks finish before an installation root is created.
"""
from __future__ import annotations

import argparse
import base64
import csv
from email.parser import Parser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import sys
import sysconfig
import zipfile

PACKAGE = "openface_still"
DIST = "openface_still-0.1.0.dist-info"
WHEEL_SHA256 = "6d1c65ce23679009b8f7531f8d1ca94e33e96167179724c3bae841c628799a50"
ENGINE_SHA256 = "173b43d8f5d259f022f4fd83b7c658fc7ade3070e36321965436cd59f2da909f"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def json_object(data):
    result = json.loads(data, object_pairs_hook=unique_object)
    if not isinstance(result, dict):
        raise ValueError("JSON object required")
    return result


def validate_archive(raw):
    """Validate archive structure independently so rejection controls exercise it."""
    files = {}
    names = set()
    total = 0
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if not 10 <= len(entries) <= 64:
            raise ValueError("Unexpected wheel member count")
        for info in entries:
            name = info.filename
            parsed = PurePosixPath(name.rstrip("/"))
            mode = info.external_attr >> 16
            if (name in names or not name or "\\" in name or "\x00" in name
                    or parsed.is_absolute() or str(parsed) != name.rstrip("/")
                    or any(part in {"", ".", ".."} for part in name.rstrip("/").split("/"))):
                raise ValueError("Duplicate or unsafe wheel path")
            names.add(name)
            if (parsed.parts[0] not in {PACKAGE, DIST} or info.flag_bits & 1
                    or stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}
                    or info.is_dir() and stat.S_IFMT(mode) not in {0, stat.S_IFDIR}):
                raise ValueError("Unexpected root, encryption or wheel member type")
            if not info.is_dir() and (len(parsed.parts) < 2 or parsed.suffix not in {".py", ".json", ".md"}
                                      and parsed.parts[0] != DIST):
                raise ValueError("Only package source/data and distribution metadata are admitted")
            total += info.file_size
            if info.file_size > 256 * 1024 or total > 2 * 1024 * 1024:
                raise ValueError("Wheel expansion exceeds bound")
            if not info.is_dir():
                files[name] = archive.read(info)
    record = DIST + "/RECORD"
    rows = list(csv.reader(io.StringIO(files[record].decode("utf-8"))))
    if (any(len(row) != 3 for row in rows) or len({row[0] for row in rows}) != len(rows)
            or {row[0] for row in rows} != set(files)):
        raise ValueError("RECORD must cover every file exactly once")
    for name, encoded, length in rows:
        if name == record:
            if encoded or length:
                raise ValueError("RECORD self-entry must be unhashed")
        else:
            digest = base64.urlsafe_b64encode(hashlib.sha256(files[name]).digest()).decode().rstrip("=")
            if encoded != "sha256=" + digest or length != str(len(files[name])):
                raise ValueError("RECORD hash or size mismatch")
    metadata = Parser().parsestr(files[DIST + "/METADATA"].decode("utf-8"))
    for key, expected in {"Name": "openface-still", "Version": "0.1.0", "Requires-Python": "<3.14,>=3.12"}.items():
        if metadata.get_all(key) != [expected]:
            raise ValueError("Pinned distribution metadata differs: " + key)
    if sorted(metadata.get_all("Requires-Dist", [])) != ["Pillow<14,>=12.3.0", "numpy<3,>=2.3.5"]:
        raise ValueError("Unexpected dependency declaration")
    wheel = Parser().parsestr(files[DIST + "/WHEEL"].decode("utf-8"))
    if wheel.get_all("Root-Is-Purelib") != ["true"] or wheel.get_all("Tag") != ["py3-none-any"]:
        raise ValueError("Exact pure-Python wheel required")
    required = {PACKAGE + "/LICENSE-FIRST-PARTY.md", PACKAGE + "/THIRD_PARTY_NOTICES.md", DIST + "/licenses/NOTICES.md"}
    if not required <= files.keys() or any(not files[name] for name in required):
        raise ValueError("Required notices are missing")
    manifest = json_object(files[PACKAGE + "/build-manifest.json"])
    members = manifest.get("source_members")
    if (manifest.get("contract_version") != "openface-still-v1"
            or manifest.get("engine_artifact_sha256") != ENGINE_SHA256 or not isinstance(members, dict)):
        raise ValueError("Pinned engine identity differs")
    sources = {name.removeprefix(PACKAGE + "/"): sha(data) for name, data in files.items()
               if name.startswith(PACKAGE + "/") and (name.endswith(".py") or name.endswith("/contract.json"))}
    if members != sources or sha(json.dumps(members, sort_keys=True, separators=(",", ":")).encode()) != ENGINE_SHA256:
        raise ValueError("Engine source closure differs")
    return files


def validated_members(wheel, manifest):
    if wheel.is_symlink() or not wheel.is_file() or wheel.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Ordinary bounded wheel required")
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 64 * 1024:
        raise ValueError("Ordinary bounded artifact manifest required")
    raw = wheel.read_bytes()
    if sha(raw) != WHEEL_SHA256:
        raise ValueError("Pinned wheel SHA-256 differs")
    declared = json_object(manifest.read_bytes())
    expected = {"distribution": "openface-still", "version": "0.1.0", "wheel": wheel.name,
                "wheel_sha256": WHEEL_SHA256, "wheel_bytes": len(raw), "engine_artifact_sha256": ENGINE_SHA256,
                "reference_space": "lovelies-sface-openface-still-v1", "models_bundled": False,
                "stock_opencv_dependency": False}
    if any(declared.get(key) != value for key, value in expected.items()):
        raise ValueError("Vendored artifact manifest differs")
    return validate_archive(raw)


def install(files, site, receipt):
    site = site.absolute()
    if site.resolve(strict=True) != site or not site.is_dir():
        raise ValueError("Existing ordinary site-packages directory required")
    if (any(os.path.lexists(site / root) for root in (PACKAGE, DIST))
            or list(site.glob("openface_still-*.dist-info"))):
        raise ValueError("Refusing to replace an existing OpenFace distribution")
    if receipt.parent.resolve(strict=True) != receipt.parent or os.path.lexists(receipt):
        raise ValueError("Ordinary receipt parent and a fresh receipt path required")
    created = []
    try:
        for root in (PACKAGE, DIST):
            path = site / root
            path.mkdir(mode=0o755)  # Exclusive creation; never rename over an unknown root.
            created.append(path)
            path.chmod(0o755)
        for name, data in files.items():
            path = site / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as output:
                output.write(data)
                os.fchmod(output.fileno(), 0o644)
        for root in created:
            for path in root.rglob("*"):
                if path.is_dir():
                    path.chmod(0o755)
        if any((site / name).is_symlink() or (site / name).read_bytes() != data for name, data in files.items()):
            raise ValueError("Installed wheel bytes differ")
        result = {"schema": "lovelies-openface-still-offline-installation-v1", "status": "passed",
                  "distribution": "openface-still", "version": "0.1.0", "wheel_sha256": WHEEL_SHA256,
                  "engine_artifact_sha256": ENGINE_SHA256, "installed_file_count": len(files),
                  "RECORD_all_files_verified": True, "dependencies_installed": 0, "downloads": 0,
                  "existing_distributions_replaced": 0, "installer_sha256": sha(Path(__file__).read_bytes()),
                  "files": [{"path": name, "bytes": len(data), "sha256": sha(data)} for name, data in sorted(files.items())]}
        with receipt.open("x") as output:
            json.dump(result, output, indent=2)
            output.write("\n")
            os.fchmod(output.fileno(), 0o644)
        return result
    except Exception:
        for root in reversed(created):
            shutil.rmtree(root)  # Only newly created distribution roots belong to this attempt.
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--site-packages", type=Path, default=Path(sysconfig.get_path("purelib")))
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.version_info[:2] != (3, 13) or platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("Installer is restricted to root Linux AMD64 CPython 3.13 build steps")
    files = validated_members(args.wheel, args.manifest)
    result = install(files, args.site_packages, args.receipt.absolute())
    print(json.dumps({key: value for key, value in result.items() if key != "files"}, sort_keys=True))


if __name__ == "__main__":
    main()
