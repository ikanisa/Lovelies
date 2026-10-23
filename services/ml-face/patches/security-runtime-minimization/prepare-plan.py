"""Create the finite removal plan from preserved, actual-image observations.

This prepares build input only. It neither changes the image nor closes an
advisory. Each omitted payload must be checked again in the resulting artifact.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path

BASE_IMAGE = "sha256:6b58ceaf1a710bf28cdc9b837c40535b2ea1e32db382b1a78dbb1357f69f7b6c"
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
    return {"path": str(path), "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def prepare(evidence: Path, dispositions: Path, current_candidate: Path) -> dict:
    closure = json.loads((evidence / "runtime-closure.json").read_text())
    optional = json.loads((evidence / "optional-consumers.json").read_text())
    tools = json.loads((evidence / "retained-tools.json").read_text())
    font = json.loads((evidence / "font-consumers.json").read_text())
    candidate = json.loads(current_candidate.read_text())
    if candidate["image_id"] != BASE_IMAGE:
        raise ValueError("Current candidate does not bind inspected immutable image")
    open_ids = set(candidate["explicit_open_advisory_ids"])
    if len(open_ids) != 62:
        raise ValueError("Expected current remaining 62 identifiers")
    if closure["missing_dependencies"] or optional["source_consumer_hits"]:
        raise ValueError("Missing dependencies or optional-module consumers remain")
    if optional["service_import_with_optional_modules_denied"] is not True or optional["optional_modules_loaded"]:
        raise ValueError("Actual service import did not exclude the optional modules")
    removed_roots = {r["path"] for r in optional["optional_native_modules"]}
    if len(removed_roots) != 4 or not all(any(x in p for x in OPTIONAL) for p in removed_roots):
        raise ValueError("Exact four optional extension roots required")
    if font["service_font_consumer_hits"] or font["font_and_four_optional_modules_loaded"] is not False:
        raise ValueError("Actual service font exclusion not established")
    if ([r["format"] for r in font["actual_model_cases"]] != ["PNG", "JPEG", "WEBP"]
            or any(r["status"] != "no_faces" or r["faces"] != 0 for r in font["actual_model_cases"])):
        raise ValueError("Exact ordinary decoder/no-face cases required")
    font_markers = ("/PIL/_imagingft.", "/pillow.libs/libfreetype-", "/pillow.libs/libharfbuzz-",
                    "/pillow.libs/libpng16-", "/pillow.libs/libbrotlidec-", "/pillow.libs/libbrotlicommon-")
    font_roots = {r["path"] for r in closure["native_roots"] if any(x in r["path"] for x in font_markers)}
    if len(font_roots) != 6:
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
    needed.update(r["path"] for r in tools)
    needed.add("/usr/lib/x86_64-linux-gnu/libmd.so.0.1.0")
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
                                  source_package="cpython", source_version="3.13.15")
    for r in closure["native_roots"]:
        if r["path"] in font_roots:
            removed[r["path"]] = {k: r[k] for k in ("path", "kind", "bytes", "sha256")}
            removed[r["path"]].update(package="pillow", package_version="12.3.0",
                                      source_package="pillow-font-closure")
    families = {r["source_package"] for r in removed.values()}
    applicability = []
    with dispositions.open() as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            components = set(row["components"].split(";"))
            matching = sorted(components & families)
            if row["advisory_id"] in open_ids and matching:
                paths = sorted(p for p, r in removed.items() if r["source_package"] in matching)
                applicability.append({"advisory_id": row["advisory_id"], "source_families": matching,
                    "removed_payload_paths": paths,
                    "affected_implementation_scope": [ADVISORY_TARGETS[n] for n in matching],
                    "status": "proposed_payload_removal_requires_final_artifact_absence",
                    "retained_source_family_payload": sorted(p for p in needed if any(
                        r["source_package"] in matching and r["path"] == p
                        for package in closure["packages"] for r in
                        [dict(f, source_package=package["source_package"]) for f in package["files"]])),
                    "limits": "Metadata/source-family match is preserved; this is not a vendor fix or an advisory waiver."})
                if row["advisory_id"] == "DEBIAN-CVE-2007-5686":
                    applicability[-1].update(status="existing_log_permission_condition_requires_final_artifact_recheck",
                        exact_condition="/var/log/btmp was observed empty, uid0, gid43, mode0660; the cited world-readable log condition was not observed. Login toolset removal does not itself prove permissions.",
                        required_final_checks=["btmp missing or ordinary non-world-readable root-owned file", "passwd/group unchanged", "all planned login tools absent"])
    applicability.append({"advisory_id": "DEBIAN-CVE-2026-46675",
                          "source_families": ["pillow-font-closure"],
                          "removed_payload_paths": sorted(font_roots),
                          "status": "proposed_bundled_font_png_removal_requires_final_artifact_absence",
                          "limits": "System libpng remains a separate retained-worker patch/review. This row addresses only the formerly open Pillow font chain."})
    evidence_names = ["runtime-closure.json", "optional-consumers.json", "retained-tools.json", "retained-libmd.json",
                      "font-consumers.json", "inspect-runtime.executed.py", "inspect-optional-consumers.executed.py", "inspect-font-consumers.executed.py"]
    required_files = {r["path"]: r for r in closure["required_resolved_files"]}
    required_files.update({r["path"]: r for r in optional["symlink_native_roots"]})
    required_files.update({r["path"]: r for r in retained_roots})
    required_files.update({r["path"]: r for r in tools})
    required_files.update({r["path"]: r for r in [json.loads((evidence / "retained-libmd.json").read_text())]})
    return {
        "schema": "lovelies-ml-runtime-minimization-plan-v1", "baseline_image": BASE_IMAGE,
        "entrypoint_requirement": ["/app/.venv/bin/python", "-m", "pictured_ml_face"],
        "evidence": [fingerprint(evidence / name) for name in evidence_names],
        "current_candidate_evidence": fingerprint(current_candidate),
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--dispositions", type=Path, required=True)
    parser.add_argument("--current-candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(prepare(args.evidence, args.dispositions, args.current_candidate), indent=2) + "\n")
