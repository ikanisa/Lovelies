"""Apply one hash-bound, finite ML runtime removal plan after build setup.

No shell, package-manager transaction, recursive deletion or guessed package
status changes. All candidates are checked before the first unlink. Original
Debian metadata and licence/source materials remain readable and truthful.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat

SCHEMA = "lovelies-ml-runtime-minimization-plan-v1"
MANDATORY_PROTECTED = (
    "/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow", "/etc/nsswitch.conf",
    "/etc/hosts", "/etc/resolv.conf", "/etc/ssl/", "/usr/share/ca-certificates/",
    "/usr/share/doc/", "/usr/share/common-licenses/", "/usr/local/share/doc/",
    "/app/licenses/", "/var/lib/dpkg/", "/usr/bin/dpkg-query", "/usr/bin/openssl",
)
ALLOWED_REMOVAL_PREFIXES = ("/usr/bin/", "/usr/sbin/", "/usr/lib/", "/usr/libexec/",
                            "/usr/share/", "/etc/", "/usr/local/lib/python3.13/lib-dynload/",
                            "/app/.venv/lib/python3.13/site-packages/PIL/_imagingft.",
                            "/app/.venv/lib/python3.13/site-packages/pillow.libs/libfreetype-",
                            "/app/.venv/lib/python3.13/site-packages/pillow.libs/libharfbuzz-",
                            "/app/.venv/lib/python3.13/site-packages/pillow.libs/libpng16-",
                            "/app/.venv/lib/python3.13/site-packages/pillow.libs/libbrotlidec-",
                            "/app/.venv/lib/python3.13/site-packages/pillow.libs/libbrotlicommon-")


def duplicate_safe(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key: " + key)
        result[key] = value
    return result


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def inside(root: Path, name: str) -> Path:
    parsed = PurePosixPath(name)
    if (not name.startswith("/") or str(parsed) != name or ".." in parsed.parts
            or name == "/" or "\x00" in name):
        raise ValueError("Noncanonical absolute path")
    path = root.joinpath(*parsed.parts[1:])
    for parent in path.parents:
        if parent == root:
            break
        if parent.is_symlink() or not parent.is_dir():
            raise ValueError("Missing or symbolic parent: " + name)
    return path


def protected(name, prefixes):
    return any(name == prefix or name.startswith(prefix if prefix.endswith("/") else prefix + "/")
               for prefix in prefixes)


def record(path, name):
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode):
        return {"path": name, "kind": "symlink", "target": os.readlink(path)}
    if not stat.S_ISREG(mode):
        raise ValueError("Candidate must be an ordinary file or leaf symlink: " + name)
    return {"path": name, "kind": "file", "bytes": path.stat().st_size, "sha256": digest(path)}


def apply(plan, root: Path, *, dry_run=False):
    if plan.get("schema") != SCHEMA or plan.get("entrypoint_requirement") != ["/app/.venv/bin/python", "-m", "pictured_ml_face"]:
        raise ValueError("Unsupported plan/entrypoint")
    root = root.absolute()
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Ordinary runtime root required")
    entrypoint = inside(root, "/app/src/pictured_ml_face/__main__.py")
    if entrypoint.is_symlink() or not entrypoint.is_file():
        raise ValueError("Direct Python module entrypoint must exist before removing shell")
    required = plan.get("required_runtime_paths")
    if not isinstance(required, list) or not required or len(required) != len(set(required)):
        raise ValueError("Unique nonempty required-runtime path list required")
    required_snapshots = {}
    for name in required:
        path = inside(root, name)
        if not path.is_file():
            raise ValueError("Required runtime path missing: " + name)
        required_snapshots[name] = record(path, name)
    guard_prefixes = (*MANDATORY_PROTECTED, *plan.get("protected_prefixes", []), *required)
    candidates = plan.get("removals")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("Nonempty finite candidate list required")
    before = []
    seen = set()
    for expected in candidates:
        name = expected["path"]
        if name in seen:
            raise ValueError("Duplicate removal path: " + name)
        seen.add(name)
        if not name.startswith(ALLOWED_REMOVAL_PREFIXES) or protected(name, guard_prefixes):
            raise ValueError("Protected/disallowed removal path: " + name)
        path = inside(root, name)
        actual = record(path, name)
        if actual["kind"] != expected.get("kind"):
            raise ValueError("Candidate kind drift: " + name)
        fields = ("target",) if actual["kind"] == "symlink" else ("bytes", "sha256")
        if any(actual[field] != expected.get(field) for field in fields):
            raise ValueError("Candidate payload drift: " + name)
        before.append(actual)
    preserved = {}
    for name in ("/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
                 "/etc/ssl/certs/ca-certificates.crt", "/var/lib/dpkg/status"):
        path = inside(root, name)
        if not path.is_file():
            raise ValueError("Required identity/trust/provenance file missing: " + name)
        preserved[name] = digest(path)
    # Unlink leaf aliases first. No rmtree, parent removal, or link traversal.
    if not dry_run:
        for item in sorted(before, key=lambda r: r["kind"] != "symlink"):
            inside(root, item["path"]).unlink()
        for item in before:
            path = inside(root, item["path"])
            if path.exists() or path.is_symlink():
                raise ValueError("Candidate survived unlink: " + item["path"])
    after = {name: record(inside(root, name), name) for name in required}
    if required_snapshots != after:
        raise ValueError("Retained runtime payload changed during minimization")
    if any(digest(inside(root, name)) != sha for name, sha in preserved.items()):
        raise ValueError("Identity/trust/package provenance changed")
    return {"schema": "lovelies-ml-runtime-minimization-receipt-v1",
            "status": "DRY_RUN" if dry_run else "APPLIED",
            "baseline_image": plan.get("baseline_image"),
            "removed_file_count": 0 if dry_run else len(before),
            "checked_candidate_count": len(before), "checked_candidates": before,
            "preserved_configuration": preserved, "retained_runtime_files": list(after.values()),
            "package_metadata_retained": True,
            "limitations": ["Absence is a build fact; advisory disposition and new-image runtime verification are separate gates.",
                            "Original package identities/source notices remain; installed metadata must not imply every original file still ships."]}


def verify(plan, receipt, root: Path, manifest_sha256: str, producer_sha256: str):
    """Read-only post-omission receipt validation, including native aliases."""
    if (plan.get("schema") != SCHEMA
            or receipt.get("schema") != "lovelies-ml-runtime-minimization-receipt-v1"
            or receipt.get("status") != "APPLIED"
            or receipt.get("manifest_sha256") != manifest_sha256
            or receipt.get("producer_sha256") != producer_sha256
            or receipt.get("baseline_image") != plan.get("baseline_image")
            or receipt.get("package_metadata_retained") is not True):
        raise ValueError("Build receipt/source plan/helper binding mismatch")
    root = root.absolute()
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Ordinary runtime root required")
    candidates = plan.get("removals")
    required = plan.get("required_runtime_paths")
    if (not isinstance(candidates, list) or not candidates or not isinstance(required, list)
            or not required or len({r["path"] for r in candidates}) != len(candidates)
            or len(set(required)) != len(required)
            or receipt.get("removed_file_count") != len(candidates)
            or receipt.get("checked_candidate_count") != len(candidates)):
        raise ValueError("Receipt counts or unique finite plan drift")
    expected_before = []
    for item in candidates:
        fields = ("path", "kind", "target") if item["kind"] == "symlink" else ("path", "kind", "bytes", "sha256")
        expected_before.append({field: item[field] for field in fields})
        path = inside(root, item["path"])
        if path.exists() or path.is_symlink():
            raise ValueError("Removed runtime payload present: " + item["path"])
    if receipt.get("checked_candidates") != expected_before:
        raise ValueError("Receipt candidate evidence does not equal source plan")
    records = receipt.get("retained_runtime_files")
    if (not isinstance(records, list) or len(records) != len(required)
            or {r["path"] for r in records} != set(required)):
        raise ValueError("Retained runtime closure omitted or substituted")
    for expected in records:
        actual = record(inside(root, expected["path"]), expected["path"])
        if actual != expected:
            raise ValueError("Retained build-time runtime payload drift: " + expected["path"])
    preserved = receipt.get("preserved_configuration")
    config_paths = {"/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
                    "/etc/ssl/certs/ca-certificates.crt", "/var/lib/dpkg/status"}
    if not isinstance(preserved, dict) or set(preserved) != config_paths:
        raise ValueError("Missing identity/trust/provenance bindings")
    for name, sha in preserved.items():
        if digest(inside(root, name)) != sha:
            raise ValueError("Preserved configuration drift: " + name)
    native_aliases = 0
    for name in ("/app/.venv", "/usr/local/lib/python3.13/lib-dynload", "/usr/lib/x86_64-linux-gnu"):
        directory = root / name.lstrip("/")
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if path.is_symlink() and (path.name.endswith(".so") or ".so." in path.name):
                native_aliases += 1
                if not path.is_file():
                    raise ValueError("Dangling native alias: " + str(path.relative_to(root)))
    return {"schema": "lovelies-ml-runtime-minimization-verification-v1", "status": "PASS",
            "manifest_sha256": manifest_sha256, "producer_sha256": producer_sha256,
            "build_receipt_sha256": None, "removed_paths_verified": len(candidates),
            "retained_paths_verified": len(records), "native_aliases_checked": native_aliases,
            "uid": os.getuid(),
            "scope": "Read-only exact omission/build-time payload binding; final image advisory/runtime proof remains separate."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path("/"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify and args.dry_run:
        raise SystemExit("Choose verify or dry-run")
    if not args.verify and not args.dry_run and os.geteuid() != 0:
        raise SystemExit("Runtime removal requires the root build stage")
    raw = args.manifest.read_bytes()
    plan = json.loads(raw, object_pairs_hook=duplicate_safe)
    manifest_sha = hashlib.sha256(raw).hexdigest()
    producer_sha = digest(Path(__file__))
    if args.verify:
        receipt_raw = args.receipt.read_bytes()
        result = verify(plan, json.loads(receipt_raw, object_pairs_hook=duplicate_safe),
                        args.root, manifest_sha, producer_sha)
        result["build_receipt_sha256"] = hashlib.sha256(receipt_raw).hexdigest()
        print(json.dumps(result, indent=2))
    else:
        receipt = apply(plan, args.root, dry_run=args.dry_run)
        receipt["manifest_sha256"] = manifest_sha
        receipt["producer_sha256"] = producer_sha
        args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
