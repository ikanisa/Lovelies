"""Create the finite removal plan from preserved, actual-image observations.

This prepares build input only. It neither changes the image nor closes an
advisory. Each omitted payload must be checked again in the resulting artifact.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import subprocess
import sys

PREPARER_SCHEMA = "lovelies-runtime-minimization-preparer-v2"
OBSERVATION_SCHEMA = "lovelies-runtime-minimization-observation-v2"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
REMOVABLE = {
    "acl", "apt", "coreutils", "dash", "diffutils", "ncurses", "pam", "perl",
    "shadow", "sqlite3", "systemd", "tar", "util-linux", "dpkg", "adduser",
    "debconf", "findutils", "grep", "sed", "gzip", "bzip2", "xz-utils",
    "readline", "libcap2", "libcap-ng", "libgpg-error", "libgcrypt20",
    "libxxhash", "libseccomp",
}
OPTIONAL = ("/_sqlite3.", "/readline.", "/_curses.", "/_curses_panel.")
DOCUMENTATION = ("/usr/share/doc/", "/usr/share/common-licenses/", "/usr/share/man/", "/usr/share/locale/")
PROTECTED = ("/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow",
             "/etc/nsswitch.conf", "/etc/hosts", "/etc/resolv.conf",
             "/etc/ssl/", "/usr/share/ca-certificates/", "/usr/local/share/doc/",
             "/app/licenses/", "/var/lib/dpkg/", *DOCUMENTATION)
ADVISORY_TARGETS = {
    "acl": "libacl pathname implementation/ACL utilities; all observed libacl code is omitted",
    "apt": "APT trust/package-management implementation; all observed APT programs/shared libraries omitted",
    "coreutils": "chown/chgrp, sort, uniq/unexpand; all observed coreutils programs omitted",
    "dash": "shell printf/pattern matcher; dash and sh aliases omitted after direct Python entrypoint",
    "diffutils": "diff3 line mapper; all observed diffutils programs omitted",
    "ncurses": "terminal database parser/tinfo and infocmp; optional extensions plus all observed ncurses code omitted",
    "pam": "pam_namespace/pam_userdb authentication implementations; PAM modules/libraries/programs omitted",
    "perl": "Perl regex/File::Temp/Pod::Text/Archive::Tar implementation; interpreter and module payload omitted",
    "shadow": "account creation/credential tools; original passwd/group and existing empty login logs retained",
    "sqlite3": "SQLite C implementation; optional _sqlite3 extension plus complete observed SQLite DSO omitted",
    "systemd": "journal/permission implementation; all observed libsystemd/libudev code omitted",
    "tar": "GNU tar archive extraction implementation; GNU tar/rmt/tarcat omitted (CPython tarfile is distinct)",
    "util-linux": "chfn/chsh/login/mount/nsenter tool implementations; toolset and nonrequired DSOs omitted, libuuid retained",
}


def fingerprint(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Ordinary evidence file required: " + str(path))
    return {"path": str(path), "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def duplicate_safe(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate evidence key: " + key)
        result[key] = value
    return result


def read_json(path: Path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Bounded ordinary JSON evidence required: " + str(path))
    return json.loads(path.read_text(), object_pairs_hook=duplicate_safe)


def validate_record(record):
    name = record.get("path", "")
    parsed = PurePosixPath(name)
    if not name.startswith("/") or str(parsed) != name or ".." in parsed.parts or "\x00" in name:
        raise ValueError("Noncanonical observed path: " + name)
    if record.get("kind", "file") == "symlink":
        if not isinstance(record.get("target"), str) or not record["target"]:
            raise ValueError("Observed symlink target required")
    elif (record.get("kind", "file") != "file" or type(record.get("bytes")) is not int
          or record["bytes"] < 0 or not SHA256.fullmatch(record.get("sha256", ""))):
        raise ValueError("Actual observed file size/hash required: " + name)


def advisory_rows(path: Path, image_id: str):
    scan = read_json(path)
    if scan.get("source", {}).get("target", {}).get("imageID") != image_id:
        raise ValueError("Advisory scan does not bind the exact observed image")
    if not isinstance(scan.get("matches"), list):
        raise ValueError("Actual Grype matches required; no hard-coded advisory count")
    rows = {}
    for match in scan["matches"]:
        identity = match["vulnerability"]["id"]
        if not isinstance(identity, str) or not identity or len(identity) > 256:
            raise ValueError("Bounded exact advisory identifier required")
        artifact = match["artifact"]
        metadata = artifact.get("metadata") or {}
        family = metadata.get("sourceName") or metadata.get("sourcePackage") or artifact["name"]
        if not isinstance(family, str) or not family:
            raise ValueError("Observed package/source family required")
        rows.setdefault(identity, set()).add(family.split()[0])
    return rows, len(scan["matches"])


def prepare(evidence: Path, advisories: Path, *, image_id: str,
            python_version: str, pillow_version: str) -> dict:
    if not IMAGE_ID.fullmatch(image_id) or not re.fullmatch(r"3\.13\.[0-9]+", python_version):
        raise ValueError("Exact image ID and supported observed Python 3.13 version required")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", pillow_version):
        raise ValueError("Exact observed Pillow release required")
    observation = read_json(evidence / "observation.json")
    expected_identity = {"image_id": image_id, "python_version": python_version,
                         "pillow_version": pillow_version, "architecture": "x86_64"}
    if observation.get("schema") != OBSERVATION_SCHEMA or observation.get("runtime") != expected_identity:
        raise ValueError("Actual image/Python/Pillow/architecture observation mismatch")
    evidence_names = ["runtime-closure.json", "optional-consumers.json", "retained-tools.json",
                      "retained-libmd.json", "font-consumers.json", "inspect-runtime.executed.py",
                      "prepare-plan.executed.py", "service-entrypoint.json"]
    bindings = observation.get("evidence")
    if not isinstance(bindings, dict) or set(bindings) != set(evidence_names):
        raise ValueError("Exact closure, import, font and collector evidence set required")
    for name in evidence_names:
        actual = fingerprint(evidence / name)
        if any(actual[key] != bindings[name].get(key) for key in ("bytes", "sha256")):
            raise ValueError("Observed evidence drift: " + name)
    for observed_name, source_name in [("prepare-plan.executed.py", "prepare-plan.py"),
                                        ("inspect-runtime.executed.py", "inspect-runtime.py")]:
        if (fingerprint(evidence / observed_name)["sha256"]
                != fingerprint(Path(__file__).with_name(source_name))["sha256"]):
            raise ValueError("Candidate observer/closure producer source changed")
    closure = read_json(evidence / "runtime-closure.json")
    optional = read_json(evidence / "optional-consumers.json")
    tools = read_json(evidence / "retained-tools.json")
    font = read_json(evidence / "font-consumers.json")
    entrypoint = read_json(evidence / "service-entrypoint.json")
    if (closure.get("schema") != "lovelies-readonly-native-runtime-closure-v1"
            or optional.get("schema") != "lovelies-targeted-optional-module-consumers-v2"
            or font.get("schema") != "lovelies-targeted-service-font-exclusion-v2"
            or closure.get("python", "").split()[0] != python_version
            or optional.get("service_module") != "lovelies_ml_face.app"
            or font.get("service_module") != "lovelies_ml_face.app"
            or entrypoint.get("module") != "lovelies_ml_face"):
        raise ValueError("Current Lovelies service/runtime evidence required")
    for record in [*closure["native_roots"], *closure["required_resolved_files"],
                   *optional["optional_native_modules"], *optional["symlink_native_roots"],
                   *tools, entrypoint["file"]]:
        validate_record(record)
    advisory_families, advisory_match_count = advisory_rows(advisories, image_id)
    open_ids = set(advisory_families)
    if closure["missing_dependencies"] or optional["source_consumer_hits"]:
        raise ValueError("Missing dependencies or optional-module consumers remain")
    if optional["service_import_with_optional_modules_denied"] is not True or optional["optional_modules_loaded"]:
        raise ValueError("Actual service import did not exclude the optional modules")
    removed_roots = {r["path"] for r in optional["optional_native_modules"]}
    if (len(removed_roots) != 4 or {Path(path).name.split(".")[0] for path in removed_roots}
            != {"_sqlite3", "readline", "_curses", "_curses_panel"}):
        raise ValueError("Exact four optional extension roots required")
    if font["service_font_consumer_hits"] or font["font_and_four_optional_modules_loaded"] is not False:
        raise ValueError("Actual service font exclusion not established")
    if ([r["format"] for r in font["actual_model_cases"]] != ["PNG", "JPEG", "WEBP"]
            or any(r["status"] != "no_faces" or r["faces"] != 0 for r in font["actual_model_cases"])):
        raise ValueError("Exact ordinary decoder/no-face cases required")
    font_markers = ("/PIL/_imagingft.", "/pillow.libs/libfreetype-", "/pillow.libs/libharfbuzz-",
                    "/pillow.libs/libpng16-", "/pillow.libs/libbrotlidec-", "/pillow.libs/libbrotlicommon-")
    font_roots = {r["path"] for r in closure["native_roots"] if any(x in r["path"] for x in font_markers)}
    if len(font_roots) != 6 or any(sum(marker in path for path in font_roots) != 1 for marker in font_markers):
        raise ValueError("Exact six font-only payloads required")
    for r in closure["native_roots"]:
        if r["path"] not in font_roots and font_roots.intersection(r["resolved_dependencies"]):
            raise ValueError("Non-font native root consumes proposed font payload: " + r["path"])
    removed_roots.update(font_roots)
    retained_roots = [r for r in closure["native_roots"]
                      if r["path"] not in removed_roots and r["path"] != "/usr/bin/dash"]
    needed = {r["path"] for r in retained_roots}
    needed.update(p for r in retained_roots for p in r["resolved_dependencies"])
    needed.update(r["path"] for r in optional["symlink_native_roots"])
    needed.update(r["path"] for r in closure["required_resolved_files"] if "/libnss" in r["path"])
    if [record["path"] for record in tools] != ["/usr/bin/dpkg-query", "/usr/bin/openssl"]:
        raise ValueError("Exact retained package-query and TLS tools required")
    needed.update(r["path"] for r in tools)
    needed.update(p for r in tools for p in r["resolved_dependencies"])
    libmd = read_json(evidence / "retained-libmd.json")
    validate_record(libmd)
    needed.add(libmd["path"])
    needed.add(entrypoint["file"]["path"])
    removed = {}
    for package in closure["packages"]:
        if package["source_package"] not in REMOVABLE:
            continue
        for original in package["files"]:
            path = original["path"]
            target = original.get("resolved_path", path)
            if path.startswith(DOCUMENTATION) or path in needed or target in needed:
                continue
            if path in {"/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow"}:
                continue
            record = dict(original, package=package["package"],
                          package_version=package["version"],
                          source_package=package["source_package"],
                          source_version=package["source_version"])
            if path in removed and removed[path] != record:
                raise ValueError("Ambiguous package ownership: " + path)
            removed[path] = record
    for r in optional["optional_native_modules"]:
        removed[r["path"]] = dict(r, kind="file", package="upstream-cpython",
                                  source_package="cpython", source_version=python_version)
    for r in closure["native_roots"]:
        if r["path"] in font_roots:
            removed[r["path"]] = {k: r[k] for k in ("path", "kind", "bytes", "sha256")}
            removed[r["path"]].update(package="pillow", package_version=pillow_version,
                                      source_package="pillow-font-closure")
    families = {r["source_package"] for r in removed.values()}
    applicability = []
    for identity in sorted(open_ids):
        matching = sorted(advisory_families[identity] & families)
        if not matching:
            continue
        paths = sorted(p for p, r in removed.items() if r["source_package"] in matching)
        applicability.append({"advisory_id": identity, "source_families": matching,
            "removed_payload_paths": paths,
            "affected_implementation_scope": [ADVISORY_TARGETS.get(n,
                "Observed optional source-family payload; exact advisory applicability remains separate")
                for n in matching],
            "status": "proposed_payload_removal_requires_final_artifact_absence",
            "retained_source_family_payload": sorted(p for p in needed if any(
                r["source_package"] in matching and r["path"] == p
                for package in closure["packages"] for r in
                [dict(f, source_package=package["source_package"]) for f in package["files"]])),
            "limits": "Raw scan source-family match is preserved; this is not a vendor fix or an advisory waiver."})
        if identity == "DEBIAN-CVE-2007-5686":
            applicability[-1].update(
                status="existing_log_permission_condition_requires_final_artifact_recheck",
                exact_condition="Use the exact login_log_observation below; omission does not prove permissions.",
                required_final_checks=["btmp missing or ordinary non-world-readable root-owned file",
                                       "passwd/group unchanged", "all planned login tools absent"])
    required_files = {r["path"]: r for r in closure["required_resolved_files"]}
    required_files.update({r["path"]: r for r in optional["symlink_native_roots"]})
    required_files.update({r["path"]: r for r in retained_roots})
    required_files.update({r["path"]: r for r in tools})
    required_files[libmd["path"]] = libmd
    required_files[entrypoint["file"]["path"]] = entrypoint["file"]
    if needed - required_files.keys():
        raise ValueError("Required runtime files lack actual hash evidence: " + str(sorted(needed - required_files.keys())))
    for record in removed.values():
        validate_record(record)
    return {
        "schema": "lovelies-ml-runtime-minimization-plan-v1", "baseline_image": image_id,
        "preparer_schema": PREPARER_SCHEMA, "observed_runtime": expected_identity,
        "service_entrypoint": ["/app/.venv/bin/python", "-m", "lovelies_ml_face"],
        "legacy_entrypoint_guard": "The unchanged minimizer also requires the retained pictured_ml_face entrypoint; actual Lovelies entrypoint bytes are separately required.",
        "entrypoint_requirement": ["/app/.venv/bin/python", "-m", "pictured_ml_face"],
        "evidence": [fingerprint(evidence / name) for name in evidence_names],
        "observation_evidence": fingerprint(evidence / "observation.json"),
        "advisory_set_evidence": fingerprint(advisories),
        "observed_advisory_ids": sorted(open_ids), "observed_advisory_match_count": advisory_match_count,
        "qualification": {"native_runtime_accepted": False, "final_image_accepted": False},
        "protected_prefixes": list(PROTECTED), "required_runtime_paths": sorted(needed),
        "baseline_retained_native_files": [required_files[p] for p in sorted(needed) if p in required_files],
        "optional_extension_removals": sorted(r["path"] for r in optional["optional_native_modules"]),
        "font_payload_removals": sorted(font_roots),
        "removals": [removed[p] for p in sorted(removed)], "advisory_applicability": applicability,
        "login_log_observation": optional["login_log_metadata"],
        "metadata_policy": "Keep dpkg status/info and original source identities as historical installation provenance. Removed code is classified by exact absent paths and receipt, never silently erased from the SBOM.",
        "licensing_policy": "Preserve copyright, complete licences, prominent notices, build receipts and corresponding-source/relinking materials, including historically installed source packages.",
        "limitations": ["Build proposal; final artifact runtime, ELF closure and every relevant affected-file absence gate remain required.",
                        "No security clearance follows from nonroot operation, urgency, or missing direct imports.",
                        "Optional SQLite/interactive/curses functionality is outside the declared ML service contract.",
                        "Retained glibc, PNG, zlib, protobuf and GCC runtime applicability remains separately reviewed."]}


def observed_file(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Actual ordinary runtime file required: " + str(path))
    return dict(fingerprint(path), kind="file")


def write_new(path: Path, value):
    # Failed/prior observations and reviewed plans are never replaced in place.
    with path.open("x") as handle:
        if isinstance(value, bytes):
            raise ValueError("Use byte-preserving source copy for collector files")
        handle.write(json.dumps(value, indent=2) + "\n")


def loader_dependencies(path: Path):
    result = subprocess.run(["/usr/bin/ldd", str(path)], capture_output=True,
                            text=True, timeout=30, check=True)
    if "not found" in result.stdout:
        raise ValueError("Actual retained-tool loader dependency missing")
    paths = []
    for line in result.stdout.splitlines():
        match = re.search(r"(?:=>\s+)?(/[^\s]+)\s+\(", line)
        if match:
            paths.append(str(Path(match.group(1)).resolve(strict=True)))
    return result.stdout, sorted(set(paths))


def observe(evidence: Path, *, image_id: str):
    """Run only inside the exact first-pass image, with network disabled by its host.

    The image ID is supplied by the host's immutable docker-run argument. An
    in-container string is not remote attestation; retain the host inspect/run
    receipt separately. This collects no account credentials or face portraits.
    """
    import ast
    import importlib.abc
    import importlib.metadata
    import io
    import secrets

    if (not IMAGE_ID.fullmatch(image_id) or sys.version_info[:2] != (3, 13)
            or platform.machine() != "x86_64"):
        raise ValueError("Observe inside the exact AMD64 Python 3.13 candidate image")
    if evidence.is_symlink() or not evidence.is_dir() or any(evidence.iterdir()):
        raise ValueError("New empty ordinary evidence directory required")
    base = Path(__file__).resolve().parent
    inspector = base / "inspect-runtime.py"
    for source, name in [(inspector, "inspect-runtime.executed.py"),
                         (Path(__file__).resolve(), "prepare-plan.executed.py")]:
        with (evidence / name).open("xb") as handle:
            handle.write(source.read_bytes())
    result = subprocess.run([sys.executable, str(inspector)], capture_output=True,
                            text=True, timeout=300, check=True)
    closure = json.loads(result.stdout, object_pairs_hook=duplicate_safe)
    if closure["missing_dependencies"]:
        raise ValueError("Actual native closure is incomplete")

    optional_names = {"sqlite3", "_sqlite3", "readline", "curses", "_curses", "_curses_panel"}
    font_names = {"PIL.ImageFont", "PIL._imagingft"}
    optional_hits, font_hits = [], []
    scanned = 0
    for directory in [Path("/app/src"), Path("/app/.venv/lib/python3.13/site-packages")]:
        for path in sorted(directory.rglob("*.py")):
            if any(part in {"tests", "test", "testing", "benchmarks", "__pycache__"}
                   for part in path.relative_to(directory).parts):
                continue
            try:
                tree = ast.parse(path.read_bytes())
            except (SyntaxError, UnicodeDecodeError):
                continue
            scanned += 1
            # The former inspection used literal production imports. Keep that
            # conservative boundary, plus literal dynamic imports. Font calls
            # are checked in the app and the actual account-free consumer code;
            # Pillow's unused font implementation is not itself an app consumer.
            font_consumer = (str(path).startswith("/app/src/")
                             or "/site-packages/openface_still/" in str(path))
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [item.name for item in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names = [node.module] + [node.module + "." + item.name for item in node.names]
                elif (isinstance(node, ast.Call) and node.args
                      and isinstance(node.args[0], ast.Constant)
                      and isinstance(node.args[0].value, str)
                      and ast.unparse(node.func).endswith(("import_module", "__import__"))):
                    names = [node.args[0].value]
                elif (isinstance(node, ast.Attribute)
                      and node.attr in {"truetype", "text", "textbbox", "textlength", "multiline_text"}):
                    names = [node.attr]
                for name in names:
                    record = {"path": str(path), "line": node.lineno, "module": name,
                              "file_sha256": fingerprint(path)["sha256"]}
                    if name.split(".")[0] in optional_names:
                        optional_hits.append(record)
                    if font_consumer and (any(part in name for part in ("ImageFont", "ImageDraw", "imagingft"))
                                          or name in {"truetype", "text", "textbbox", "textlength", "multiline_text"}):
                        font_hits.append(record)

    class DenyOptional(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname.split(".")[0] in optional_names or fullname in font_names:
                raise ImportError("Optional database/interactive/font implementation denied in candidate observation")

    if any(name.split(".")[0] in optional_names or name in font_names for name in sys.modules):
        raise ValueError("Observer bootstrap already imported proposed optional implementation")
    finder = DenyOptional()
    sys.meta_path.insert(0, finder)
    # Import the real service with an ephemeral local-only credential; never
    # weaken its HTTPS authentication requirement or write/print this value.
    prior_secret = os.environ.get("ML_INFERENCE_SECRET")
    if prior_secret is None:
        os.environ["ML_INFERENCE_SECRET"] = secrets.token_urlsafe(48)
    pipeline = None
    try:
        from PIL import Image
        from lovelies_ml_face.app import pipeline
        from pictured_ml_face.models import PhotoProcessRequest

        results = []
        for fmt, content_type in [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")]:
            output = io.BytesIO()
            Image.new("RGB", (64, 64), (20, 50, 80)).save(output, format=fmt)
            payload = output.getvalue()
            request = PhotoProcessRequest(event_id="synthetic-minimization-observation",
                                          asset_id="synthetic-" + fmt.lower(), object_key="",
                                          content_type=content_type)
            processed = pipeline.process_photo_bytes(request, payload)
            if processed.faces or (processed.width, processed.height) != (64, 64):
                raise ValueError("Actual bounded decoder/model no-face case failed")
            results.append({"format": fmt, "input_sha256": hashlib.sha256(payload).hexdigest(),
                            "bytes": len(payload), "status": "no_faces", "faces": 0,
                            "width": processed.width, "height": processed.height})
        identity = dict(pipeline.identity)
        loaded = [name for name in sys.modules
                  if name.split(".")[0] in optional_names or name in font_names]
        if loaded or optional_hits or font_hits:
            raise ValueError("Proposed optional implementation has a service consumer")
    finally:
        if pipeline is not None:
            pipeline.close()
        sys.meta_path.remove(finder)
        if prior_secret is None:
            os.environ.pop("ML_INFERENCE_SECRET", None)

    native_optional = [observed_file(path) for path in
                       sorted(Path("/usr/local/lib/python3.13/lib-dynload").glob("*.so"))
                       if path.name.split(".")[0] in optional_names]
    symlinks = []
    for path in sorted(Path("/app/.venv").rglob("*")):
        if path.is_symlink() and path.is_file():
            with path.open("rb") as handle:
                is_elf = handle.read(4) == b"\x7fELF"
            if is_elf:
                loader, dependencies = loader_dependencies(path)
                symlinks.append(dict(observed_file(path.resolve(strict=True)), alias=str(path),
                                     target=os.readlink(path), ldd=loader,
                                     resolved_dependencies=dependencies))
    log_metadata = []
    for name in ["/var/log/btmp", "/var/log/wtmp", "/var/log/lastlog"]:
        path = Path(name)
        if path.exists():
            metadata = path.stat()
            log_metadata.append(dict(path=name, bytes=metadata.st_size, mode=oct(metadata.st_mode & 0o777),
                                     uid=metadata.st_uid, gid=metadata.st_gid))
    optional = dict(schema="lovelies-targeted-optional-module-consumers-v2",
                    service_module="lovelies_ml_face.app", symlink_native_roots=symlinks,
                    production_python_source_files_scanned=scanned, source_consumer_hits=optional_hits,
                    service_import_with_optional_modules_denied=True,
                    optional_native_modules=native_optional, optional_modules_loaded=[],
                    login_log_metadata=log_metadata)
    font = dict(schema="lovelies-targeted-service-font-exclusion-v2", service_module="lovelies_ml_face.app",
                service_font_consumer_hits=font_hits, actual_model_cases=results,
                font_and_four_optional_modules_loaded=False, inference_identity=identity,
                limits=["Import denial is observed in the service/observer process; isolated worker behavior is evidenced by real no-face cases and exact source/ELF closure, not an injected worker import hook.",
                        "Generated no-face cases do not establish recognition accuracy or release acceptance."])
    tools = []
    resolved = {record["path"]: record for record in closure["required_resolved_files"]}
    for name in ["/usr/bin/dpkg-query", "/usr/bin/openssl"]:
        path = Path(name)
        loader, dependencies = loader_dependencies(path)
        tools.append(dict(observed_file(path), resolved_dependencies=dependencies, loader_list=loader))
        for dependency in dependencies:
            resolved.setdefault(dependency, observed_file(Path(dependency)))
    closure["required_resolved_files"] = [resolved[name] for name in sorted(resolved)]
    libmd_paths = [name for name in tools[0]["resolved_dependencies"] if Path(name).name.startswith("libmd.so.")]
    if len(libmd_paths) != 1:
        raise ValueError("Exact retained dpkg-query libmd dependency required")
    entrypoint = dict(module="lovelies_ml_face", file=observed_file(Path("/app/src/lovelies_ml_face/__main__.py")))
    for name, value in [("runtime-closure.json", closure), ("optional-consumers.json", optional),
                        ("font-consumers.json", font), ("retained-tools.json", tools),
                        ("retained-libmd.json", observed_file(Path(libmd_paths[0]))),
                        ("service-entrypoint.json", entrypoint)]:
        write_new(evidence / name, value)
    names = ["runtime-closure.json", "optional-consumers.json", "retained-tools.json",
             "retained-libmd.json", "font-consumers.json", "inspect-runtime.executed.py",
             "prepare-plan.executed.py", "service-entrypoint.json"]
    observation = dict(schema=OBSERVATION_SCHEMA,
                       runtime=dict(image_id=image_id, python_version=platform.python_version(),
                                    pillow_version=importlib.metadata.version("pillow"),
                                    architecture=platform.machine()),
                       evidence={name: fingerprint(evidence / name) for name in names},
                       limits=["Retain the host image-inspect and immutable docker-run receipt; supplied image ID is not container attestation.",
                               "Source inspection, actual service import and no-face inference are bounded engineering observations; final minimization/runtime/security verification remains required."])
    write_new(evidence / "observation.json", observation)
    return observation


def verify_runtime(manifest: Path, *, root: Path = Path("/")):
    """Read-only equality check before the existing finite unlink preflight."""
    import importlib.metadata

    plan = read_json(manifest)
    if (plan.get("preparer_schema") != PREPARER_SCHEMA
            or plan.get("schema") != "lovelies-ml-runtime-minimization-plan-v1"
            or not IMAGE_ID.fullmatch(plan.get("baseline_image", ""))
            or plan.get("service_entrypoint") != ["/app/.venv/bin/python", "-m", "lovelies_ml_face"]):
        raise ValueError("New exact-observation candidate plan required; historical plan cannot qualify this candidate")
    actual = {"image_id": plan["baseline_image"], "python_version": platform.python_version(),
              "pillow_version": importlib.metadata.version("pillow"), "architecture": platform.machine()}
    if actual != plan.get("observed_runtime"):
        raise ValueError("Actual runtime version differs from observed first-pass candidate")
    records = plan.get("baseline_retained_native_files")
    required = plan.get("required_runtime_paths")
    if (not isinstance(records, list) or not records or not isinstance(required, list)
            or len(required) != len(set(required)) or len(records) != len(required)
            or {record["path"] for record in records} != set(required)):
        raise ValueError("Exact retained preimage closure required")
    for record in records:
        validate_record(record)
        path = root / record["path"].lstrip("/")
        # Resolve ordinary-file parents only. A replacement alias cannot supply
        # the bytes that were observed at this exact preimage path.
        for parent in path.parents:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError("Retained runtime parent became symbolic")
        current = observed_file(path)
        if any(current[key] != record.get(key) for key in ("bytes", "sha256")):
            raise ValueError("Retained first-pass runtime payload changed: " + record["path"])
    return {"status": "PREIMAGE_MATCH", "baseline_image": plan["baseline_image"],
            "checked_retained_paths": len(records), "native_runtime_accepted": False,
            "final_image_accepted": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    observer = modes.add_parser("observe", help="Read the actual immutable first-pass image from inside it")
    observer.add_argument("--evidence", type=Path, required=True)
    observer.add_argument("--image-id", required=True)
    preparer = modes.add_parser("prepare", help="Prepare a new plan from bound observations and actual-image Grype JSON")
    preparer.add_argument("--evidence", type=Path, required=True)
    preparer.add_argument("--advisories", type=Path, required=True)
    preparer.add_argument("--image-id", required=True)
    preparer.add_argument("--python-version", required=True)
    preparer.add_argument("--pillow-version", required=True)
    preparer.add_argument("--output", type=Path, required=True)
    verifier = modes.add_parser("verify-runtime", help="Read-only exact first-pass closure guard before minimization")
    verifier.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "observe":
        result = observe(args.evidence, image_id=args.image_id)
        print(json.dumps({"schema": result["schema"], "runtime": result["runtime"]}, indent=2))
    elif args.mode == "verify-runtime":
        print(json.dumps(verify_runtime(args.manifest), indent=2))
    else:
        result = prepare(args.evidence, args.advisories, image_id=args.image_id,
                         python_version=args.python_version, pillow_version=args.pillow_version)
        write_new(args.output, result)
        print(json.dumps({"status": "CANDIDATE_ONLY", "output": str(args.output),
                          "baseline_image": result["baseline_image"], "removals": len(result["removals"]),
                          "observed_advisory_ids": len(result["observed_advisory_ids"])}, indent=2))
