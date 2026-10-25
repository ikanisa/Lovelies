#!/usr/bin/env python3
"""Compile one reviewed Simulator UI runner; never install, launch or reset apps."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess


ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "scripts/ios-ui-audit"
DEFAULT_SOURCE = ROOT / "verification/accessibility-navigation-20261023/ios-isolated-simulator/c9-candidate/revision4/LoveliesFrontendAudit.swift"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=pathlib.Path, help="New absolute output directory; its parent must exist")
    parser.add_argument("--source", type=pathlib.Path, default=DEFAULT_SOURCE)
    parser.add_argument("--source-sha256", required=True, help="SHA256 of the exact reviewed Swift source")
    parser.add_argument("--developer-dir", type=pathlib.Path, default=pathlib.Path("/Applications/Xcode.app/Contents/Developer"))
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    developer = args.developer_dir.resolve(strict=True)
    if not re.fullmatch("[a-f0-9]{64}", args.source_sha256) or not source.is_file() or source.name != "LoveliesFrontendAudit.swift" or digest(source) != args.source_sha256:
        parser.error("Source must match the exact reviewed LoveliesFrontendAudit.swift SHA256")
    if not args.output.is_absolute() or not args.output.parent.is_dir() or not (developer / "usr/bin/xcodebuild").is_file():
        parser.error("A new absolute output path and an installed Xcode Developer directory are required")
    output = args.output.parent.resolve(strict=True) / args.output.name
    if shutil.disk_usage(ROOT).free <= 2 * 1024**3 or shutil.disk_usage(output.parent).free <= 4 * 1024**3:
        parser.error("Insufficient build reserve:2GiB source volume/4GiB output volume required")
    # Exclusive creation never adopts or overwrites another run or user folder.
    output.mkdir(mode=0o700)
    inputs = [pathlib.Path(__file__).resolve(), TEMPLATE / "project.pbxproj.template", TEMPLATE / "LoveliesFrontendAudit.xcscheme", source]
    frozen = {str(path): digest(path) for path in inputs}
    result = {"status": "running", "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "source": frozen, "source_inputs": len(frozen), "source_sha256": args.source_sha256,
              "scope": "Simulator runner-only compilation from one archived reviewed Swift file. No app build/install, device action, runtime, signing or store acceptance."}
    try:
        archived = output / "source/LoveliesFrontendAudit.swift"
        archived.parent.mkdir(mode=0o700)
        shutil.copy2(source, archived)
        assert digest(archived) == args.source_sha256
        project = output / "LoveliesFrontendAudit.xcodeproj"
        scheme = project / "xcshareddata/xcschemes/LoveliesFrontendAudit.xcscheme"
        scheme.parent.mkdir(parents=True)
        template = (TEMPLATE / "project.pbxproj.template").read_text()
        assert template.count("__LOVELIES_QA_SOURCE__") == 1
        (project / "project.pbxproj").write_text(template.replace("__LOVELIES_QA_SOURCE__", json.dumps(str(archived), ensure_ascii=False)))
        shutil.copy2(TEMPLATE / "LoveliesFrontendAudit.xcscheme", scheme)
        derived = output / "DerivedData"
        command = [str(developer / "usr/bin/xcodebuild"), "-project", str(project), "-scheme", "LoveliesFrontendAudit",
                   "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
                   "-derivedDataPath", str(derived), "-jobs", "2", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES",
                   "CODE_SIGNING_ALLOWED=NO", "COMPILER_INDEX_STORE_ENABLE=NO", "build-for-testing"]
        result["command"] = command
        result["developer_dir"] = str(developer)
        (output / "source-seal.json").write_text(json.dumps(result, indent=2) + "\n")
        with (output / "build.stdout").open("xb") as stdout, (output / "build.stderr").open("xb") as stderr:
            process = subprocess.run(command, cwd=ROOT, env=dict(os.environ, DEVELOPER_DIR=str(developer)), stdout=stdout, stderr=stderr, timeout=600)
        result["exit_code"] = process.returncode
        assert process.returncode == 0, "Runner build failed; original output retained"
        lists = list((derived / "Build/Intermediates.noindex").rglob("LoveliesFrontendAudit.SwiftFileList"))
        assert len(lists) == 1
        compiled = [line.strip().strip('"') for line in lists[0].read_text().splitlines() if line.strip()]
        assert compiled == [str(archived)], "Expected exactly the archived reviewed Swift source"
        products = derived / "Build/Products"
        runs = list(products.glob("*.xctestrun"))
        assert len(runs) == 1
        result.update(status="passed_one_file_simulator_runner_compile", actual_compiler_file_list=compiled,
                      archived_source=str(archived), xctestrun=str(runs[0]),
                      products={str(path.relative_to(products)): digest(path) for path in sorted(products.rglob("*")) if path.is_file() and not path.is_symlink()})
    except Exception as problem:
        result.update(status="failed_or_unknown", error_type=type(problem).__name__, error=str(problem))
    finally:
        result["source_unchanged"] = all(path.is_file() and digest(path) == frozen[str(path)] for path in inputs)
        if not result["source_unchanged"]:
            result["status"] = "failed_or_unknown"
        result["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({key: value for key, value in result.items() if key not in ["source", "products", "command"]}))
    return 0 if result["status"] == "passed_one_file_simulator_runner_compile" else 1


if __name__ == "__main__":
    raise SystemExit(main())
