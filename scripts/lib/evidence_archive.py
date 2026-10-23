"""Preserve an explicit hash-bound evidence inventory outside the checkout.

No readiness or semantic acceptance is inferred. The inventory owner must supply
the complete applicable transitive set; this utility verifies and restores those
exact bytes. No source, cache, old receipt or signing key is deleted by this tool.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat

INPUT_SCHEMA = "lovelies-portable-evidence-input-v1"
ARCHIVE_SCHEMA = "lovelies-portable-evidence-archive-v1"
HEX = re.compile(r"[a-f0-9]{64}\Z")
MAX_RECORDS = 100_000
MAX_INDEX_BYTES = 32 * 1024 * 1024


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON field")
        value[key] = item
    return value


def _load(path, with_record=False):
    with _open_regular(path) as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(MAX_INDEX_BYTES + 1)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("Evidence index changed while reading")
    if len(raw) > MAX_INDEX_BYTES:
        raise ValueError("Evidence index is too large")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
    return (value, {"path": Path(path).name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}) if with_record else value


def _relative(value):
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 4096:
        raise ValueError("Invalid evidence path")
    parts = value.split("/")
    if value.startswith("/") or "\\" in value or ":" in value or any(
            part in ("", ".", "..") for part in parts) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Unsafe evidence path")
    return PurePosixPath(value)


def _ordinary(root, relative):
    result = root
    parts = _relative(relative).parts
    for index, part in enumerate(parts):
        result = result / part
        mode = result.lstat().st_mode
        if stat.S_ISLNK(mode) or (index < len(parts) - 1 and not stat.S_ISDIR(mode)):
            raise ValueError("Evidence path follows a symlink or non-directory")
    if not stat.S_ISREG(mode):
        raise ValueError("Evidence payload is not a regular file")
    return result


def _open_regular(path):
    # Walk directory descriptors with NOFOLLOW, so a concurrent parent-symlink
    # replacement cannot redirect a read after path validation.
    parts = Path(path).absolute().parts
    directory = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[1:-1]:
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Evidence payload is not a regular file")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def file_record(root, relative):
    path = _ordinary(Path(root).resolve(strict=True), relative)
    digest = hashlib.sha256()
    count = 0
    with _open_regular(path) as stream:
        before = os.fstat(stream.fileno())
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            count += len(chunk)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns) or count != after.st_size:
        raise ValueError("Evidence changed while hashing")
    return {"path": relative, "bytes": count, "sha256": digest.hexdigest()}


def _records(records):
    if not isinstance(records, list) or not records or len(records) > MAX_RECORDS:
        raise ValueError("Missing or excessive evidence inventory")
    paths, digests = set(), {}
    normalized = []
    for row in records:
        if not isinstance(row, dict) or set(row) != {"path", "bytes", "sha256"}:
            raise ValueError("Invalid evidence record")
        _relative(row["path"])
        if (type(row["bytes"]) is not int or row["bytes"] < 0 or
                not isinstance(row["sha256"], str) or not HEX.fullmatch(row["sha256"])):
            raise ValueError("Invalid evidence size or digest")
        if row["path"] in paths:
            raise ValueError("Duplicate evidence path")
        if row["sha256"] in digests and digests[row["sha256"]] != row["bytes"]:
            raise ValueError("Contradictory content-addressed payload")
        paths.add(row["path"])
        digests[row["sha256"]] = row["bytes"]
        normalized.append(dict(row))
    return sorted(normalized, key=lambda row: row["path"])


def _object(row):
    digest = row["sha256"]
    return f"objects/sha256/{digest[:2]}/{digest}"


def _new_destination(destination, source_root=None):
    path = Path(destination)
    parent = path.parent.resolve(strict=True)
    target = parent / path.name
    if source_root is not None and target.is_relative_to(source_root):
        raise ValueError("Evidence archive must be outside the source checkout")
    if target.exists() or target.is_symlink():
        raise ValueError("Destination must be new; existing evidence is never overwritten")
    return target


def _copy(source, destination, expected):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    digest, count = hashlib.sha256(), 0
    with _open_regular(source) as src, destination.open("xb") as dst:
        os.chmod(destination, 0o600)
        before = os.fstat(src.fileno())
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            digest.update(chunk)
            count += len(chunk)
            dst.write(chunk)
        dst.flush()
        os.fsync(dst.fileno())
        after = os.fstat(src.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns) or (
                count != expected["bytes"] or digest.hexdigest() != expected["sha256"]):
        raise ValueError("Evidence changed or mismatched during copy; partial destination retained")
    os.chmod(destination, 0o400)


def create_archive(source_root, inventory_path, destination):
    root = Path(source_root).resolve(strict=True)
    inventory = _load(Path(inventory_path))
    if (not isinstance(inventory, dict) or inventory.get("schema") != INPUT_SCHEMA or
            not isinstance(inventory.get("scope"), str) or not inventory["scope"].strip() or
            not isinstance(inventory.get("limitations"), list) or not inventory["limitations"] or
            not all(isinstance(value, str) and value for value in inventory["limitations"])):
        raise ValueError("Explicit archive scope and limitations are required")
    records = _records(inventory.get("files"))
    target = _new_destination(destination, root)
    unique = {row["sha256"]: row for row in records}
    required = sum(row["bytes"] for row in unique.values())
    if shutil.disk_usage(target.parent).free < required + max(16 * 1024 * 1024, required // 20):
        raise ValueError("Insufficient headroom for a preservation copy")
    # Validate the complete inventory before creating an archive or copying bytes.
    for row in records:
        if file_record(root, row["path"]) != row:
            raise ValueError("Evidence inventory is stale: " + row["path"])
    target.mkdir(mode=0o700)
    for row in unique.values():
        _copy(_ordinary(root, row["path"]), target / _object(row), row)
    index = {"schema": ARCHIVE_SCHEMA, "scope": inventory["scope"],
             "limitations": inventory["limitations"], "files": records,
             "production_ready_claimed": False, "external_acceptance_claimed": False,
             "source_deleted": False, "object_count": len(unique), "payload_bytes": required,
             "access": "local owner-only filesystem permissions; encryption/key recovery not verified"}
    index_path = target / "ARCHIVE_INDEX.json"
    with index_path.open("x", encoding="utf-8") as stream:
        os.chmod(index_path, 0o600)
        json.dump(index, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    return verify_archive(target)


def _verify_loaded(root, index, index_record):
    if not isinstance(index, dict) or index.get("schema") != ARCHIVE_SCHEMA:
        raise ValueError("Unknown evidence archive")
    if (not isinstance(index.get("scope"), str) or not index["scope"].strip() or
            not isinstance(index.get("limitations"), list) or not index["limitations"] or
            not all(isinstance(value, str) and value for value in index["limitations"])):
        raise ValueError("Archive scope or limitations changed")
    for flag in ("production_ready_claimed", "external_acceptance_claimed", "source_deleted"):
        if index.get(flag) is not False:
            raise ValueError("Archive cannot confer readiness or external acceptance")
    records = _records(index.get("files"))
    unique = {row["sha256"]: row for row in records}
    if index.get("object_count") != len(unique) or index.get("payload_bytes") != sum(row["bytes"] for row in unique.values()):
        raise ValueError("Archive inventory totals changed")
    for row in unique.values():
        actual = file_record(root, _object(row))
        if actual["sha256"] != row["sha256"] or actual["bytes"] != row["bytes"]:
            raise ValueError("Archived payload changed")
    return {"schema": "lovelies-portable-evidence-verification-v1", "status": "pass_exact_archived_inventory",
            "files": len(records), "objects": len(unique), "payload_bytes": index["payload_bytes"],
            "archive_index": index_record,
            "production_ready_claimed": False, "external_acceptance_claimed": False}


def verify_archive(archive_root):
    root = Path(archive_root).resolve(strict=True)
    index, index_record = _load(_ordinary(root, "ARCHIVE_INDEX.json"), with_record=True)
    return _verify_loaded(root, index, index_record)


def restore_archive(archive_root, destination):
    root = Path(archive_root).resolve(strict=True)
    # Read the index once: a later replacement cannot introduce unvalidated
    # output paths after the complete payload verification.
    index, index_record = _load(_ordinary(root, "ARCHIVE_INDEX.json"), with_record=True)
    verification = _verify_loaded(root, index, index_record)
    index["files"] = _records(index["files"])
    target = _new_destination(destination)
    required = sum(row["bytes"] for row in index["files"])
    if shutil.disk_usage(target.parent).free < required + max(16 * 1024 * 1024, required // 20):
        raise ValueError("Insufficient restore headroom")
    target.mkdir(mode=0o700)
    for row in index["files"]:
        _copy(_ordinary(root, _object(row)), target / row["path"], row)
    for row in index["files"]:
        if file_record(target, row["path"]) != row:
            raise ValueError("Restored evidence mismatch")
    return {**verification, "status": "pass_independent_directory_restore",
            "restored_files": len(index["files"]),
            "provider_restore_claimed": False, "rpo_rto_acceptance_claimed": False}
