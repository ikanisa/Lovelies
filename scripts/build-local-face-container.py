#!/usr/bin/env python3
"""Produce a supplemental local OpenFace consumer over the exact retained image.

This does not replace the canonical Dockerfile/build-face-container.py, satisfy
its native acceptance gates, pull, push, prune or deploy. Root owns execution.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = ROOT / "services/ml-face"
BASE = "lovelies-ml-release:security-4a8a73463c5c4ec6"
EXPECTED = "sha256:b684cc9768693aaf595107eeabcd20dd4452293db1ff0a4557c8242703fb9e5b"
PLATFORM = "linux/amd64"
INSPECTION = ('{"id":{{json .Id}},"architecture":{{json .Architecture}},"os":{{json .Os}},'
              '"user":{{json .Config.User}},"layers":{{json .RootFS.Layers}},'
              '"source_sha256":{{with index .Config "Labels"}}{{json (index . "io.lovelies.overlay.source-sha256")}}{{else}}null{{end}},'
              '"role":{{with index .Config "Labels"}}{{json (index . "io.lovelies.artifact.role")}}{{else}}null{{end}},'
              '"native_acceptance":{{with index .Config "Labels"}}{{json (index . "io.lovelies.native-acceptance")}}{{else}}null{{end}}}')


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_files():
    """Match the explicit supplemental COPY closure, excluding Python caches."""
    paths = [CONTEXT / name for name in ("Dockerfile.local-cache", "pyproject.toml", "uv.lock", "patches/install-still-wheel.py")]
    for name in ("src", "models", "licenses", "vendor"):
        root = CONTEXT / name
        if root.is_symlink() or not root.is_dir():
            raise ValueError("Ordinary source directory required: " + name)
        for path in root.rglob("*"):
            relative = path.relative_to(CONTEXT)
            if "__pycache__" in relative.parts or path.suffix == ".pyc":
                continue
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError("Unsupported source entry: " + relative.as_posix())
            if stat.S_ISREG(mode):
                paths.append(path)
    return sorted(paths, key=lambda path: path.relative_to(CONTEXT).as_posix())


def freeze_sources(destination):
    destination.mkdir(mode=0o755)
    rows = []
    for source in source_files():
        if source.is_symlink() or not source.is_file():
            raise ValueError("Ordinary source file required")
        relative = source.relative_to(CONTEXT).as_posix()
        data = source.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        with target.open("xb") as output:
            output.write(data)
        target.chmod(0o644)
        rows.append({"path": relative, "bytes": len(data), "sha256": digest(data), "snapshot_mode": "0644"})
    # A concurrent source edit invalidates this attempt without changing its
    # already frozen preimage or overwriting any previous evidence.
    actual = [{"path": path.relative_to(CONTEXT).as_posix(), "bytes": path.stat().st_size,
               "sha256": digest(path.read_bytes()), "snapshot_mode": "0644"} for path in source_files()]
    if actual != rows:
        raise ValueError("Source changed during snapshot; preserve this attempt and retry with fresh evidence")
    for path in [destination, *destination.rglob("*")]:
        if path.is_dir():
            path.chmod(0o755)
    specification = {"schema": "lovelies-local-cache-inputs-v1", "base_image_id": EXPECTED,
                     "platform": PLATFORM, "producer_sha256": digest(Path(__file__).read_bytes()), "files": rows}
    source_sha256 = digest(encoded(specification))
    manifest = {**specification, "source_sha256": source_sha256, "native_acceptance": False,
                "classification": "SUPPLEMENTAL_LOCAL_ENGINEERING"}
    (destination / "local-cache-inputs.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "local-cache-inputs.json").chmod(0o644)
    return manifest


def validate_cached_base(value):
    if value.get("id") != EXPECTED or value.get("architecture") != "amd64" or value.get("os") != "linux":
        raise ValueError("Exact retained Linux AMD64 base identity differs")
    if not value.get("layers") or any(not layer.startswith("sha256:") for layer in value["layers"]):
        raise ValueError("Retained base layer identity missing")


def validate_result(value, base, source_sha256, image_id):
    if (value.get("id") != image_id or value.get("architecture") != "amd64" or value.get("os") != "linux"
            or value.get("user") != "lovelies" or value.get("source_sha256") != source_sha256
            or value.get("role") != "supplemental-local-engineering" or value.get("native_acceptance") != "false"
            or value.get("layers", [])[:len(base["layers"])] != base["layers"]
            or len(value.get("layers", [])) <= len(base["layers"])):
        raise ValueError("Built overlay identity, base layers, source binding or unprivileged user differs")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True, help="Fresh evidence directory; existing paths are never overwritten")
    parser.add_argument("--docker-storage-path", type=Path, help="Optional exact local Docker backing-file/directory path")
    args = parser.parse_args()
    evidence = args.evidence.expanduser().resolve()
    evidence.mkdir(parents=True, exist_ok=False, mode=0o700)
    docker = shutil.which("docker")
    if not docker:
        bundled = Path("/Applications/Docker.app/Contents/Resources/bin/docker")
        docker = str(bundled) if bundled.is_file() else None
    if not docker:
        raise SystemExit("Docker executable is unavailable")
    commands = []

    def run(arguments, name, capture=False):
        print(name, flush=True)
        command = [docker, *arguments]
        entry = {"command": command, "log": name + ".log"}
        commands.append(entry)
        with (evidence / entry["log"]).open("xb") as log:
            result = subprocess.run(command, stdout=subprocess.PIPE if capture else log, stderr=log, check=False)
            if capture:
                log.write(result.stdout)
        entry["exit_code"] = result.returncode
        (evidence / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, command)
        return result.stdout.decode() if capture else None

    try:
        base = json.loads(run(["image", "inspect", "--format", INSPECTION, BASE], "base-before", True))
        validate_cached_base(base)
        context = evidence / "context"
        manifest = freeze_sources(context)
        installer_path = context / "patches/install-still-wheel.py"
        spec = importlib.util.spec_from_file_location("lovelies_exact_still_installer", installer_path)
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        installer.validated_members(context / "vendor/openface_still-0.1.0-py3-none-any.whl", context / "vendor/openface-still.json")
        tag = "lovelies-native-face:openface-local-" + manifest["source_sha256"]
        existing = run(["image", "ls", "--filter", "reference=" + tag, "--format", "{{.ID}}"], "target-tag-before", True).strip()
        if existing:
            raise ValueError("Content-addressed tag already exists; preserve and qualify that artifact instead of overwriting it")
        storage_path = args.docker_storage_path
        if storage_path is None and sys.platform == "darwin":
            storage_path = Path.home() / "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"
        if storage_path is None:
            storage_path = Path(run(["info", "--format", "{{.DockerRootDir}}"], "docker-storage-path", True).strip())
        storage_path = storage_path.expanduser().resolve(strict=True)
        usage = shutil.disk_usage(storage_path)
        # This budget is for the small copied overlay only. The canonical
        # producer's independent eight-GiB/native-rebuild guard is unchanged.
        required_free = max(512 * 1024 ** 2, sum(row["bytes"] for row in manifest["files"]) * 4)
        storage = {"path": str(storage_path), "free_bytes": usage.free, "total_bytes": usage.total,
                   "required_free_bytes": required_free, "scope": "supplemental_copied_overlay_only"}
        (evidence / "docker-storage.json").write_text(json.dumps(storage, indent=2) + "\n")
        if usage.free < required_free:
            raise ValueError("Insufficient Docker backing-volume space for the supplemental overlay")
        iidfile = evidence / "image-id.txt"
        run(["build", "--pull=false", "--network=none", "--platform", PLATFORM, "--progress", "plain",
             "--build-arg", "LOVELIES_OVERLAY_SOURCE_SHA256=" + manifest["source_sha256"], "--iidfile", str(iidfile),
             "--file", str(context / "Dockerfile.local-cache"), "--tag", tag, str(context)], "build")
        image_id = iidfile.read_text().strip()
        if len(image_id) != 71 or not image_id.startswith("sha256:") or any(char not in "0123456789abcdef" for char in image_id[7:]):
            raise ValueError("Build did not produce an immutable image ID")
        result = json.loads(run(["image", "inspect", "--format", INSPECTION, tag], "image-after", True))
        after = json.loads(run(["image", "inspect", "--format", INSPECTION, BASE], "base-after", True))
        validate_cached_base(after)
        if after != base:
            raise ValueError("Retained base metadata/layers changed during build")
        validate_result(result, base, manifest["source_sha256"], image_id)
        receipt = {"schema": "lovelies-local-cache-consumer-build-v1", "status": "built_supplemental_engineering_artifact",
                   "built_at": datetime.now(timezone.utc).isoformat(), "classification": "SUPPLEMENTAL_LOCAL_ENGINEERING",
                   "image": {"id": image_id, "tag": tag, "platform": PLATFORM}, "base": base,
                   "source_sha256": manifest["source_sha256"], "input_manifest": "context/local-cache-inputs.json",
                   "base_layer_prefix_verified": True, "runtime_user": result["user"],
                   "native_acceptance": False, "final_image_accepted": False, "scan_performed": False,
                   "runtime_integration_performed": False, "deployment_performed": False, "push_performed": False}
        (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, sort_keys=True))
    except Exception as error:
        failure = {"schema": "lovelies-local-cache-consumer-build-failure-v1", "status": "failed",
                   "exception": type(error).__name__, "detail": str(error), "native_acceptance": False,
                   "final_image_accepted": False, "deployment_performed": False, "preserved_evidence": str(evidence)}
        (evidence / "failure.json").write_text(json.dumps(failure, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
