"""Run the accepted offline recipe once with pinned, isolated compiler tools."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import sysconfig
import zipfile

OUT = Path("/out")
INPUTS = json.loads(Path("/recipes/tool-inputs.json").read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(argv, **kwargs):
    subprocess.run(argv, check=True, **kwargs)


assert platform.machine() == "x86_64" and sys.version_info[:2] == (3, 13)
for key in ["maturin_wheel"]:
    row = INPUTS[key]
    assert sha(Path("/inputs") / row["filename"]) == row["sha256"]
toolchain = next((OUT / "official-rustup/toolchains").iterdir())
assert toolchain.name == "1.88.0-x86_64-unknown-linux-gnu", toolchain
(OUT / "toolchain").symlink_to(toolchain)
notices = OUT / "rust-toolchain-original-notices"
notices.mkdir()
notice_records = []
notice_manifest = json.loads(Path("/recipes/rust-standard-library-notices/manifest.json").read_text())
actual_version = subprocess.check_output([str(toolchain / "bin/rustc"), "-vV"], text=True)
assert "commit-hash: " + notice_manifest["actual_compiler_commit"] in actual_version
for row in notice_manifest["notices"]:
    source = Path("/recipes/rust-standard-library-notices") / row["filename"]
    assert sha(source) == row["sha256"]
    shutil.copyfile(source, notices / row["filename"])
    notice_records.append({**row, "path": str((notices / row["filename"]).relative_to(OUT))})
shutil.copyfile("/recipes/rust-standard-library-notices/manifest.json", notices / "manifest.json")
bin_dir = OUT / "tools-bin"
bin_dir.mkdir()
with zipfile.ZipFile("/inputs/" + INPUTS["maturin_wheel"]["filename"]) as wheel:
    candidates = [n for n in wheel.namelist() if n.endswith("/maturin") and not n.endswith("/bin/maturin")]
    assert len(candidates) == 1, candidates
    (bin_dir / "maturin").write_bytes(wheel.read(candidates[0]))
(bin_dir / "maturin").chmod(0o755)
shutil.copyfile("/recipes/compiler-wrapper.py", bin_dir / "cargo")
(bin_dir / "cargo").chmod(0o755)
os.environ.update(
    PATH=str(bin_dir) + ":/out/toolchain/bin:" + os.environ["PATH"],
    CARGO_HOME="/out/cargo-home", CARGO_BUILD_JOBS="2", CARGO_NET_OFFLINE="true",
    RUSTC_WRAPPER="/recipes/compiler-wrapper.py", PYO3_PYTHON=sys.executable,
    LOVELIES_PYDANTIC_BUILD_OUTPUT="/out/build",
)
run(["sh", "/bundle/rebuild-linux-amd64.sh"], timeout=2400)
wheels = list((OUT / "build/wheels").glob("*.whl"))
assert len(wheels) == 1
site = OUT / "probe-site"
site.mkdir()
with zipfile.ZipFile(wheels[0]) as wheel:
    for member in wheel.infolist():
        path = site / member.filename
        assert path.resolve().is_relative_to(site.resolve())
        if not member.is_dir():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(wheel.read(member))
extension = next(site.glob("pydantic_core/*.so"))
assert sha(extension) == sha(OUT / "build/target/x86_64-unknown-linux-gnu/release/lib_pydantic_core.so")
messages = [json.loads(s) for s in (OUT / "cargo-build-messages.jsonl").read_text().splitlines()]
assert any(x.get("reason") == "build-finished" and x.get("success") is True for x in messages)
artifacts = [x for x in messages if x.get("reason") == "compiler-artifact"]
assert any("pydantic-core@2.46.4" in x["package_id"] and "cdylib" in x["target"]["crate_types"] and not x["fresh"] for x in artifacts)
fingerprints = []
for path in (OUT / "build/target").glob("**/.fingerprint/*/*.json"):
    fingerprints.append({"path": str(path.relative_to(OUT)), "sha256": sha(path), "value": json.loads(path.read_text())})
tools = []
for path in [OUT / "toolchain/bin/rustc", OUT / "toolchain/bin/cargo", bin_dir / "maturin", Path(sys.executable), Path("/usr/bin/cc"), Path("/usr/bin/ld")]:
    resolved = path.resolve()
    tools.append({"path": str(path), "resolved_path": str(resolved), "sha256": sha(resolved)})
with (OUT / "extension-dynamic-linkage.txt").open("w") as handle:
    run(["ldd", str(extension)], stdout=handle, stderr=subprocess.STDOUT)
assert "not found" not in (OUT / "extension-dynamic-linkage.txt").read_text()
with (OUT / "extension-elf.txt").open("w") as handle:
    run(["readelf", "-h", "-d", "--version-info", str(extension)], stdout=handle)
for source, name in [
    ("/bundle/.cargo/config.toml", "effective-cargo-config.toml"),
    ("/bundle/source/pydantic_core-2.46.4/Cargo.lock", "source-Cargo.lock"),
    ("/bundle/source/pydantic_core-2.46.4/Cargo.toml", "source-Cargo.toml"),
    ("/bundle/rebuild-linux-amd64.sh", "rebuild-linux-amd64.sh"),
]:
    shutil.copyfile(source, OUT / "build" / name)
compiled_output_paths = [OUT / name for name in [
    "cargo-build-messages.jsonl", "cargo-invocations.jsonl", "rustc-invocations.jsonl",
    "extension-dynamic-linkage.txt", "extension-elf.txt",
]] + sorted(path for path in (OUT / "build").iterdir() if path.is_file())
compiled_output_bindings = [{"path": path.name, "source_path": str(path.relative_to(OUT)),
                             "sha256": sha(path), "bytes": path.stat().st_size}
                            for path in compiled_output_paths]
(OUT / "build-provenance.json").write_text(json.dumps({
    "schema": "lovelies-pydantic-source-wheel-compiler-provenance-v1",
    "status": "built_actual_fresh_source_wheel_pending_load_probe",
    "target": INPUTS["target"], "python": sys.version,
    "python_configuration": {k: sysconfig.get_config_var(k) for k in ["SOABI", "Py_GIL_DISABLED", "Py_DEBUG", "ABIFLAGS"]},
    "compiler_tools": tools, "effective_environment": {k: os.environ[k] for k in ["CARGO_HOME", "CARGO_BUILD_JOBS", "CARGO_NET_OFFLINE", "RUSTC_WRAPPER", "PYO3_PYTHON"]},
    "rust_standard_library_original_notices": notice_records,
    "wheel": {"path": str(wheels[0].relative_to(OUT)), "sha256": sha(wheels[0]), "bytes": wheels[0].stat().st_size},
    "extension": {"path": str(extension.relative_to(OUT)), "sha256": sha(extension), "bytes": extension.stat().st_size},
    "fresh_compiler_artifacts": artifacts, "build_script_executions": [x for x in messages if x.get("reason") == "build-script-executed"],
    "cargo_fingerprints": fingerprints,
    "compiled_output_bindings": compiled_output_bindings,
    "source_built": True, "prior_publisher_wheel_provenance_claimed": False,
    "production_image_verified": False,
}, indent=2) + "\n")
