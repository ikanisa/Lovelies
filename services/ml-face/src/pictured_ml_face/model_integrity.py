"""Startup file integrity for the private recognizer, not recognition approval.

No decoder, model runtime, network call or user data is used here. Configured
absolute artifact paths remain supported. Deploy artifacts read-only: metadata
rechecks detect ordinary concurrent replacement, not a hostile filesystem or a
transaction with OpenCV's later file opens. A colocated digest is not a signature.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
from typing import Any, BinaryIO, Iterator

MAX_MANIFEST_BYTES = 1_048_576
MAX_EVALUATION_BYTES = 2_097_152
MAX_ARTIFACT_BYTES = 268_435_456
MAX_REGISTRY_MODELS = 128
MAX_POLICY_DEPTH = 64
_HASH = re.compile(r"[0-9a-fA-F]{64}")


class ModelPolicyError(RuntimeError):
    """A configured model or its evidence cannot satisfy the startup policy."""


def _stamp(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@contextmanager
def _regular_file(path: Path, limit: int, label: str) -> Iterator[BinaryIO]:
    if type(limit) is not int or limit <= 0:
        raise ModelPolicyError("Invalid integrity byte limit")
    path = Path(path)
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
            raise ModelPolicyError(f"{label} must be a nonempty bounded regular file")
        # Reject a replaced leaf symlink/FIFO where supported; never open a
        # deliberately configured special file. Parent mounts may be symlinks.
        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as handle:
            opened = os.fstat(handle.fileno())
            if not stat.S_ISREG(opened.st_mode) or _stamp(opened) != _stamp(before):
                raise ModelPolicyError(f"{label} changed during verification")
            yield handle
            after = os.fstat(handle.fileno())
            current = path.lstat()
            if _stamp(after) != _stamp(before) or _stamp(current) != _stamp(before):
                raise ModelPolicyError(f"{label} changed during verification")
    except OSError:
        # Do not expose filesystem paths or underlying parser/file exception text.
        raise ModelPolicyError(f"{label} is unavailable") from None


def read_bounded_file(path: Path, limit: int, label: str) -> bytes:
    with _regular_file(path, limit, label) as handle:
        data = handle.read(limit + 1)
        if not 0 < len(data) <= limit:
            raise ModelPolicyError(f"{label} exceeds its byte limit or is empty")
    return data


def _check_json_depth(data: bytes) -> None:
    # A bounded byte count alone does not bound recursive parser depth. Ignore
    # brackets in quoted strings, including escaped quotes and backslashes.
    depth, quoted, escaped = 0, False, False
    for byte in data:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            if depth > MAX_POLICY_DEPTH:
                raise ValueError("nesting")
        elif byte in (93, 125):
            depth -= 1


def parse_json_object(data: bytes, label: str) -> dict[str, Any]:
    """Reject duplicate fields at every depth, nonfinite numbers and scalar roots."""

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("nonfinite")

    def finite_float(text):
        value = float(text)
        if not math.isfinite(value):
            raise ValueError("nonfinite")
        return value

    try:
        if not isinstance(data, bytes) or not 0 < len(data) <= MAX_EVALUATION_BYTES:
            raise ValueError("size")
        _check_json_depth(data)
        result = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=unique,
            parse_constant=reject_constant,
            parse_float=finite_float,
        )
    except (ValueError, UnicodeError, RecursionError):
        raise ModelPolicyError(f"{label} is not unambiguous finite JSON") from None
    if not isinstance(result, dict):
        raise ModelPolicyError(f"{label} must be a JSON object")
    return result


def load_manifest_object(path: Path) -> dict[str, Any]:
    return parse_json_object(
        read_bounded_file(path, MAX_MANIFEST_BYTES, "ML model manifest"), "ML model manifest"
    )


def _version(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 128 and value == value.strip()


def select_active_model(manifest: Mapping[str, Any]) -> dict[str, Any]:
    active = manifest.get("active_model_version")
    models = manifest.get("models")
    blocked = manifest.get("blocked_models")
    if (
        not _version(active)
        or not isinstance(models, list)
        or not 0 < len(models) <= MAX_REGISTRY_MODELS
    ):
        raise ModelPolicyError("ML model registry is invalid")
    versions: set[str] = set()
    selected = None
    for model in models:
        if not isinstance(model, dict) or not _version(model.get("version")):
            raise ModelPolicyError("ML model registry entry is invalid")
        version = model["version"]
        if version in versions:
            raise ModelPolicyError("ML model registry has duplicate versions")
        versions.add(version)
        if version == active:
            selected = model
    if not isinstance(blocked, list) or len(blocked) > MAX_REGISTRY_MODELS:
        raise ModelPolicyError("ML blocked-model registry is invalid")
    for model in blocked:
        if not isinstance(model, dict) or not _version(model.get("version")):
            raise ModelPolicyError("ML blocked-model registry entry is invalid")
        if model["version"] == active:
            raise ModelPolicyError("Active model version is blocked")
    if selected is None:
        raise ModelPolicyError("Active model version is not present in manifest")
    return dict(selected)


def verified_model_paths(
    active: Mapping[str, Any], resolve: Callable[[str], Path]
) -> dict[str, Path]:
    """Both artifacts and hashes are mandatory; only return after BOTH succeed."""
    specs = []
    for name in ("detector", "recognizer"):
        value, expected = active.get(f"{name}_path"), active.get(f"{name}_sha256")
        if not isinstance(value, str) or not value or value != value.strip() or "\x00" in value:
            raise ModelPolicyError(f"Production ML {name} artifact path is missing or invalid")
        if not isinstance(expected, str) or _HASH.fullmatch(expected) is None:
            raise ModelPolicyError(f"Production ML {name} artifact checksum is missing or invalid")
        specs.append((name, value, expected.lower()))
    result = {}
    for name, value, expected in specs:
        path = resolve(value)
        digest, total = hashlib.sha256(), 0
        with _regular_file(path, MAX_ARTIFACT_BYTES, "Production ML model artifact") as handle:
            for chunk in iter(lambda: handle.read(1_048_576), b""):
                total += len(chunk)
                if total > MAX_ARTIFACT_BYTES:
                    raise ModelPolicyError("Production ML model artifact exceeds its byte limit")
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ModelPolicyError("Production ML artifact hash mismatch")
        result[f"{name}_path"] = path
    return result


def load_verified_evaluation_bytes(path: Path, *, maximum: int = MAX_EVALUATION_BYTES) -> bytes:
    """Hash and parse the same bounded report bytes, not two separate file reads."""
    if type(maximum) is not int or not 1 <= maximum <= MAX_EVALUATION_BYTES:
        raise ModelPolicyError("Invalid evaluation byte limit")
    digest_bytes = read_bounded_file(Path(f"{path}.sha256"), 512, "Production ML evaluation digest")
    try:
        text = digest_bytes.decode("ascii").strip()
        # Accept a plain digest or the conventional sha256sum filename suffix.
        match = re.fullmatch(r"([0-9a-fA-F]{64})(?:[ \t]+[^\r\n]+)?", text)
        if match is None:
            raise ValueError()
        expected = match.group(1).lower()
    except (UnicodeError, ValueError):
        raise ModelPolicyError("Production ML evaluation digest is invalid") from None
    data = read_bounded_file(path, maximum, "Production ML evaluation report")
    if hashlib.sha256(data).hexdigest() != expected:
        raise ModelPolicyError("Production ML evaluation report hash mismatch")
    parse_json_object(data, "Production ML evaluation report")
    return data


def load_verified_evaluation(path: Path) -> dict[str, Any]:
    """Backwards-compatible object API backed by the exact verified bytes."""
    return parse_json_object(
        load_verified_evaluation_bytes(path), "Production ML evaluation report"
    )
