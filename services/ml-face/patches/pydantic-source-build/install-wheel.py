"""Build-only, standard-library installer for one exact verified source wheel."""
import argparse
import base64
import csv
from datetime import datetime, timezone
from email.parser import Parser
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import sys
import tempfile
import zipfile

PACKAGE = "pydantic_core"
DIST = "pydantic_core-2.46.4.dist-info"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validated_members(wheel, expected_sha256):
    raw = wheel.read_bytes()
    if digest(raw) != expected_sha256:
        raise ValueError("Exact source wheel SHA-256 mismatch")
    files = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = set()
        for info in archive.infolist():
            name = info.filename
            parts = name.rstrip("/").split("/")
            mode = info.external_attr >> 16
            if name in names or "\\" in name or "\x00" in name or any(x in {"", ".", ".."} for x in parts):
                raise ValueError("Duplicate or unsafe wheel path")
            names.add(name)
            if parts[0] not in {PACKAGE, DIST} or stat.S_ISLNK(mode):
                raise ValueError("Unexpected wheel root or symbolic link")
            if stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}:
                raise ValueError("Unsupported wheel member type")
            if not info.is_dir():
                if info.file_size > 32 * 1024 * 1024 or sum(map(len, files.values())) + info.file_size > 64 * 1024 * 1024:
                    raise ValueError("Wheel member size exceeds bound")
                files[name] = archive.read(info)
    record_path = DIST + "/RECORD"
    rows = list(csv.reader(io.StringIO(files[record_path].decode())))
    if any(len(row) != 3 for row in rows) or len({row[0] for row in rows}) != len(rows):
        raise ValueError("Invalid or duplicate RECORD entry")
    if {row[0] for row in rows} != set(files):
        raise ValueError("RECORD does not cover every wheel file")
    for name, encoded, size in rows:
        if name == record_path:
            if encoded or size:
                raise ValueError("RECORD self-entry must be unhashed")
        else:
            actual = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(files[name]).digest()).decode().rstrip("=")
            if encoded != actual or size != str(len(files[name])):
                raise ValueError("RECORD hash/size mismatch")
    metadata = Parser().parsestr(files[DIST + "/METADATA"].decode())
    if metadata["Name"].replace("-", "_") != PACKAGE or metadata["Version"] != "2.46.4":
        raise ValueError("Pinned distribution/version mismatch")
    tags = Parser().parsestr(files[DIST + "/WHEEL"].decode()).get_all("Tag", [])
    if not tags or any(not t.startswith("cp313-cp313-") or not t.endswith("_x86_64") or not t.split("-", 2)[2].startswith(("linux_", "manylinux_")) for t in tags):
        raise ValueError("Exact CPython3.13 LinuxAMD64 ABI required")
    extensions = [name for name in files if name.startswith(PACKAGE + "/_pydantic_core.") and name.endswith(".so")]
    if len(extensions) != 1 or "cpython-313-x86_64-linux-gnu" not in extensions[0]:
        raise ValueError("Exact cp313 AMD64 extension missing")
    if not any(name.startswith(DIST + "/licenses/") for name in files):
        raise ValueError("Original distribution license files missing")
    return files, extensions[0], tags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--site-packages", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.version_info[:2] != (3, 13) or platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("Installer is restricted to root LinuxAMD64 CPython3.13 build steps")
    files, extension, tags = validated_members(args.wheel, args.expected_sha256)
    site = args.site_packages.absolute()
    if site.resolve() != site or not site.is_dir():
        raise ValueError("Existing ordinary contained site-packages directory required")
    roots = [site / PACKAGE, site / DIST]
    if any(not p.is_dir() or p.is_symlink() for p in roots) or any(p.name != DIST for p in site.glob("pydantic_core-*.dist-info")):
        raise ValueError("Exact existing distribution roots required")
    prior = []
    for path in roots[0].glob("*.so"):
        if path.is_symlink():
            raise ValueError("Existing extension is a symlink")
        prior.append({"path": str(path), "sha256": digest(path.read_bytes()), "bytes": path.stat().st_size})
    stage = Path(tempfile.mkdtemp(prefix=".lovelies-pydantic-build-", dir=site))
    moved = []
    backup_strategies = []
    preserve_recovery_stage = False
    try:
        for name, data in files.items():
            target = stage / "new" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
        for directory in (stage / "new").rglob("*"):
            if directory.is_dir():
                directory.chmod(0o755)
        for old in roots:
            backup = stage / ("old-" + old.name)
            try:
                old.rename(backup)
            except OSError as error:
                if error.errno != errno.EXDEV:
                    raise
                # OverlayFS cannot rename a lower-layer directory. Finish the
                # backup before touching the old root, and journal it before
                # deletion so a partial rmtree can still be rolled back.
                shutil.copytree(old, backup, symlinks=True)
                moved.append((old, backup))
                backup_strategies.append({"root": old.name, "strategy": "EXDEV_copy_then_remove"})
                shutil.rmtree(old)
            else:
                moved.append((old, backup))
                backup_strategies.append({"root": old.name, "strategy": "rename"})
            (stage / "new" / old.name).rename(old)
        actual = site / extension
        if digest(actual.read_bytes()) != digest(files[extension]):
            raise ValueError("Installed extension identity mismatch")
    except Exception as error:
        rollback_errors = []
        for original, backup in reversed(moved):
            try:
                # Includes a partially deleted old root as well as a newly
                # installed root; every completed backup is in the journal.
                if original.exists() or original.is_symlink():
                    if original.is_symlink():
                        original.unlink()
                    else:
                        shutil.rmtree(original)
                backup.rename(original)
            except Exception as rollback_error:
                rollback_errors.append(str(rollback_error))
        if rollback_errors:
            preserve_recovery_stage = True
            raise RuntimeError("Installation rollback incomplete; recovery backups retained at " + str(stage) + ": " + "; ".join(rollback_errors)) from error
        raise
    finally:
        if not preserve_recovery_stage:
            shutil.rmtree(stage)
    receipt = {"schema": "lovelies-pydantic-source-wheel-installation-v1", "status": "pass_exact_offline_installation",
               "installed_at": datetime.now(timezone.utc).isoformat(), "version": "2.46.4", "wheel_sha256": args.expected_sha256,
               "wheel_bytes": args.wheel.stat().st_size, "ABI_tags": tags, "installed_file_count": len(files), "RECORD_all_files_verified": True,
               "original_extension": prior, "installed_extension": {"path": str(actual), "sha256": digest(actual.read_bytes()), "bytes": actual.stat().st_size},
               "replacement_scope": [PACKAGE, DIST], "original_license_members": [n for n in files if n.startswith(DIST + "/licenses/")],
               "backup_strategies": backup_strategies,
               "installer_sha256": digest(Path(__file__).read_bytes()), "downloads": 0, "backup_files_retained": False}
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
