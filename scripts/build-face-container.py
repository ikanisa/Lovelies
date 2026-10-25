#!/usr/bin/env python3
"""Build the private face image locally, retaining the canonical native gates.

Resolver fixtures require namespaces unavailable in ordinary BuildKit RUNs.
Build their exact inputs, run the unchanged recipe in an owned network-none
container, and supply only its accepted package to the final named stage.
This producer never pushes, deploys, prunes, or changes a shared builder.
"""
import argparse
import gzip
import hashlib
import json
import shutil
import shlex
import subprocess
import uuid
import importlib.util
import re
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = ROOT / "services/ml-face"
TESTS = {
    "stdlib": ["tst-strfmon-bug34510", "tst-strfmon_l"],
    "misc": ["tst-tsearch"],
    "posix": ["tst-wordexp-append", "tst-wordexp-tilde"],
    "libio": ["tst-fopen-ccs-empty"],
    "iconvdata": ["tst-jisx0213-progress"],
    "resolv": ["tst-ns_sprintrr", "tst-resolv-res_init",
               "tst-resolv-res_init-multi", "tst-resolv-res_init-thread"],
    "nptl": ["tst-stack2", "tst-stack3", "tst-attr3", "tst-minstack-cancel",
             "tst-minstack-exit", "tst-minstack-throw", "tst-stackguard1", "tst-tls3", "tst-tls5"],
    "malloc": ["tst-mallocalign1", "tst-malloc-thread-exit", "tst-malloc-thread-fail",
               "tst-malloc-fork-deadlock", "tst-malloc-alternate-path", "tst-malloc_info", "tst-mallinfo2"],
}


def fingerprint(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": h.hexdigest()}


def verify_inputs_archive(path, manifest_path, canonical_id):
    """Bind the retained config ID to one complete, uncompressed-layer OCI graph.

    This explicit handoff proof supports the retained docker-save OCI layout,
    not an arbitrary registry or compressed-layer converter. Nothing is extracted.
    """
    retained = json.loads(manifest_path.read_text())
    expected = retained.get("archive", {})
    if (retained.get("image_id") != canonical_id
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", canonical_id)
            or type(expected.get("bytes")) is not int or expected["bytes"] < 1
            or not re.fullmatch(r"[0-9a-f]{64}", str(expected.get("sha256", "")))
            or path.stat().st_size != expected["bytes"]):
        raise ValueError("Retained input archive manifest/size differs")
    records, small, seen = {}, {}, set()
    archive_hash = hashlib.sha256()
    archive_bytes = 0

    class HashedReader:
        def __init__(self, source):
            self.source = source

        def read(self, size=-1):
            nonlocal archive_bytes
            data = self.source.read(size)
            archive_bytes += len(data)
            if archive_bytes > expected["bytes"]:
                raise ValueError("Retained input archive grew while reading")
            archive_hash.update(data)
            return data

    total, small_bytes = 0, 0
    with path.open("rb") as source:
        hashed = HashedReader(source)
        with tarfile.open(fileobj=hashed, mode="r|gz") as archive:
            for member in archive:
                name = member.name
                if (name in seen or name.startswith("/") or ".." in name.split("/")
                        or name != str(Path(name)) or len(seen) >= 256
                        or not (member.isdir() or member.isfile())):
                    raise ValueError("Retained input archive has unsafe/duplicate members")
                seen.add(name)
                if member.isdir():
                    continue
                total += member.size
                if member.size > 1024 ** 3 or total > 4 * 1024 ** 3:
                    raise ValueError("Retained input archive exceeds bounded proof budget")
                digest = hashlib.sha256()
                capture = member.size <= 1024 ** 2
                chunks = []
                with archive.extractfile(member) as content:
                    for block in iter(lambda: content.read(1024 * 1024), b""):
                        digest.update(block)
                        if capture:
                            chunks.append(block)
                records[name] = {"bytes": member.size, "sha256": digest.hexdigest()}
                if name.startswith("blobs/") and name != "blobs/sha256/" + digest.hexdigest():
                    raise ValueError("Retained OCI blob does not match its content address")
                if capture:
                    small_bytes += member.size
                    if small_bytes > 8 * 1024 ** 2:
                        raise ValueError("Retained input archive metadata exceeds budget")
                    small[name] = b"".join(chunks)
        # Include compressed trailing bytes/read-ahead in the original receipt's
        # digest. The graph and archive hash are observed in this same file pass.
        while hashed.read(1024 * 1024):
            pass
    if archive_bytes != expected["bytes"] or archive_hash.hexdigest() != expected["sha256"]:
        raise ValueError("Retained input archive checksum differs")

    def metadata(name):
        if name not in small:
            raise ValueError("Retained OCI metadata missing or oversized: " + name)
        return json.loads(small[name])

    def descriptor(value, media_type):
        if (not isinstance(value, dict) or value.get("mediaType") != media_type
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(value.get("digest", "")))
                or type(value.get("size")) is not int or value["size"] < 1):
            raise ValueError("Retained OCI descriptor differs")
        name = "blobs/sha256/" + value["digest"][7:]
        if records.get(name) != {"bytes": value["size"], "sha256": value["digest"][7:]}:
            raise ValueError("Retained OCI descriptor bytes/checksum differ")
        return {key: value[key] for key in ["mediaType", "digest", "size"]}, name

    if metadata("oci-layout").get("imageLayoutVersion") != "1.0.0":
        raise ValueError("Retained OCI layout version differs")
    index = metadata("index.json")
    if (index.get("schemaVersion") != 2 or index.get("mediaType") != "application/vnd.oci.image.index.v1+json"
            or not isinstance(index.get("manifests"), list) or len(index["manifests"]) != 1):
        raise ValueError("Retained OCI input must select exactly one manifest")
    manifest_descriptor, manifest_name = descriptor(index["manifests"][0], "application/vnd.oci.image.manifest.v1+json")
    manifest = metadata(manifest_name)
    if manifest.get("schemaVersion") != 2 or manifest.get("mediaType") != manifest_descriptor["mediaType"]:
        raise ValueError("Retained OCI manifest schema differs")
    config_descriptor, config_name = descriptor(manifest.get("config"), "application/vnd.oci.image.config.v1+json")
    if config_descriptor["digest"] != canonical_id:
        raise ValueError("Retained OCI config differs from canonical input identity")
    config = metadata(config_name)
    if config.get("os") != "linux" or config.get("architecture") != "amd64" or config.get("variant") not in [None, ""]:
        raise ValueError("Retained OCI input platform must be linux/amd64")
    platform = index["manifests"][0].get("platform")
    if platform is not None and platform != {"os": "linux", "architecture": "amd64"}:
        raise ValueError("Retained OCI index platform differs")
    layers, rootfs = manifest.get("layers"), config.get("rootfs", {})
    if (not isinstance(layers, list) or not 1 <= len(layers) <= 64 or rootfs.get("type") != "layers"
            or not isinstance(rootfs.get("diff_ids"), list) or len(rootfs["diff_ids"]) != len(layers)
            or not isinstance(config.get("config"), dict)):
        raise ValueError("Retained OCI rootfs/config differs")
    layer_names, layer_descriptors = [], []
    for layer, diff_id in zip(layers, rootfs["diff_ids"]):
        item, name = descriptor(layer, "application/vnd.oci.image.layer.v1.tar")
        if item["digest"] != diff_id:
            raise ValueError("Retained uncompressed layer differs from ordered rootfs")
        layer_names.append(name)
        layer_descriptors.append(item)
    if "manifest.json" in records:
        legacy = metadata("manifest.json")
        if (not isinstance(legacy, list) or len(legacy) != 1 or legacy[0].get("Config") != config_name
                or legacy[0].get("Layers") != layer_names):
            raise ValueError("Docker/OCI archive graphs disagree")
    return {"schema": "lovelies-input-oci-archive-proof-v1", "canonical_config_id": canonical_id,
            "archive": {"path": str(path), "bytes": archive_bytes, "sha256": archive_hash.hexdigest()},
            "archive_manifest": fingerprint(manifest_path), "manifest_descriptor": manifest_descriptor,
            "config_descriptor": config_descriptor, "platform": {"os": "linux", "architecture": "amd64"},
            "config": config["config"], "rootfs_diff_ids": rootfs["diff_ids"], "layer_descriptors": layer_descriptors}


def verify_inputs_inspection(inspection, proof):
    """Verify a loaded immutable reference; a manifest ID is never relabelled."""
    if not isinstance(inspection, list) or len(inspection) != 1:
        raise ValueError("Expected one retained input image inspection")
    image = inspection[0]
    canonical_id, manifest = proof["canonical_config_id"], proof["manifest_descriptor"]
    if image.get("Id") not in [canonical_id, manifest["digest"]]:
        raise ValueError("Loaded input reference differs from verified OCI graph")
    actual_descriptor = image.get("Descriptor")
    if image["Id"] != canonical_id or actual_descriptor is not None:
        if (not isinstance(actual_descriptor, dict)
                or {key: actual_descriptor.get(key) for key in ["mediaType", "digest", "size"]} != manifest):
            raise ValueError("Loaded input manifest descriptor differs")
    if image.get("Os") != "linux" or image.get("Architecture") != "amd64" or image.get("Variant") not in [None, ""]:
        raise ValueError("Loaded input platform differs")
    if image.get("RootFS") != {"Type": "layers", "Layers": proof["rootfs_diff_ids"]}:
        raise ValueError("Loaded input ordered rootfs differs")
    actual, expected = image.get("Config"), proof["config"]
    if not isinstance(actual, dict) or any(actual.get(key) != value for key, value in expected.items()):
        raise ValueError("Loaded input execution config differs")
    # Classic Docker may include absent fields with empty/default values. Added
    # nondefault execution settings still change semantics and must be rejected.
    if any(value not in [None, "", False, 0, [], {}] for key, value in actual.items() if key not in expected):
        raise ValueError("Loaded input has additional execution settings")
    return image["Id"]


def resolve_inputs_archive(run, proof):
    canonical_id = proof["canonical_config_id"]
    encoded = run(["image", "inspect", canonical_id], "input-image-config", True, allow_failure=True)
    if encoded is None:
        encoded = run(["image", "inspect", proof["manifest_descriptor"]["digest"]], "input-image-manifest", True)
    return verify_inputs_inspection(json.loads(encoded), proof)


def validate_receipt(receipt):
    if (receipt.get("schema") != "lovelies-glibc-backport-build-receipt-v1"
            or receipt.get("architecture") != "amd64"
            or receipt.get("source_patch_count") != 99
            or receipt.get("native_acceptance") is False
            or receipt.get("classification") == "UNACCEPTED_DIAGNOSTIC"
            or not all(receipt.get(k) is True for k in ["relro", "bind_now", "stack_canary"])):
        raise ValueError("Canonical glibc acceptance receipt is missing or unaccepted")
    expected = {subdir + "/" + name for subdir, names in TESTS.items() for name in names}
    results = receipt.get("vendor_regression_results", [])
    if (len(results) != len(expected) or {r["test"] for r in results} != expected
            or any(not r["result"].startswith("PASS:") for r in results)):
        raise ValueError("Every canonical vendor fixture must PASS")
    if receipt.get("local_runtime_profile_tests", {}).get("passed") is not True:
        raise ValueError("Required local runtime profile did not pass")
    if any(row["missing_symbols"] for row in receipt.get("public_abi", [])):
        raise ValueError("Replacement lost public ABI symbols")
    if len(receipt.get("public_abi", [])) != 14 or len(receipt.get("runtime_files", [])) != 279:
        raise ValueError("Canonical runtime and ABI coverage differs")


def validate_opencv(directory, manifest):
    if (manifest.get("schema") != "lovelies-verified-opencv-build-output-v1"
            or manifest.get("source_recipe_completed") is not True):
        raise ValueError("OpenCV output lacks its completed source recipe proof")
    expected_paths = {r["path"] for r in manifest["files"]}
    actual_paths = {str(p.relative_to(directory)) for p in directory.rglob("*") if p.is_file() or p.is_symlink()}
    if len(expected_paths) != len(manifest["files"]) or actual_paths != expected_paths:
        raise ValueError("Retained OpenCV context contains missing, duplicate or unbound files")
    for row in manifest["files"]:
        if Path(row["path"]).is_absolute() or ".." in Path(row["path"]).parts:
            raise ValueError("Retained OpenCV file escapes its context")
        path = directory / row["path"]
        if path.is_symlink() or any(fingerprint(path)[k] != row[k] for k in ["bytes", "sha256"]):
            raise ValueError("Retained OpenCV output changed: " + row["path"])
    for name, digest in {
        "wrapper.tar.gz": "ecc18f96559493a7968da6a0fa8fff2094a0d8a41f9cc03c8333139da0644171",
        "opencv.tar.gz": "4f2a381ce3377e6f22d0718fe7101e97a21968a21c81f0356f2787bb21024dc4",
    }.items():
        if fingerprint(directory / "opencv" / name)["sha256"] != digest:
            raise ValueError("Retained OpenCV publisher archive differs")
    if ((directory / "opencv/out/build-opencv-image-only.sh").read_bytes()
            != (CONTEXT / "patches/build-opencv-image-only.sh").read_bytes()):
        raise ValueError("Retained OpenCV source recipe differs")
    cache = (directory / "opencv/out/CMakeCache.txt").read_text()
    for flag in ["WITH_FFMPEG", "WITH_GSTREAMER", "BUILD_PROTOBUF", "BUILD_JPEG", "BUILD_PNG", "BUILD_WEBP"]:
        if flag + ":BOOL=OFF" not in cache:
            raise ValueError("Retained OpenCV configuration differs: " + flag)
    for name in ["JPEG_LIBRARY_RELEASE", "PNG_LIBRARY_RELEASE"]:
        if name + ":FILEPATH=/usr/lib/x86_64-linux-gnu/" not in cache:
            raise ValueError("Retained OpenCV uses another codec library")
    if not (directory / "opencv/out/opencv_python_headless-4.13.0.92-cp313-cp313-linux_x86_64.whl").is_file():
        raise ValueError("Retained OpenCV wheel target/version differs")
    if len(list((directory / "opencv/out").glob("*.whl"))) != 1:
        raise ValueError("Retained OpenCV context must contain exactly one wheel")
    spec = importlib.util.spec_from_file_location("lovelies_verify_opencv_wheel", CONTEXT / "patches/verify-opencv-wheel.py")
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    verifier.verify_wheel(directory / "opencv/out/opencv_python_headless-4.13.0.92-cp313-cp313-linux_x86_64.whl")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default="lovelies-face:local")
    parser.add_argument("--build-network", choices=["default", "host"], default="default",
                        help="Networking for image-build steps only; the canonical fixture remains network-none")
    parser.add_argument("--output-stage", choices=["final", "security-runtime-unminimized"], default="final",
                        help="Use the unminimized stage only for actual-image closure observations, never distribution")
    parser.add_argument("--inputs-image", help="Immutable sha256 ID of the exact exported glibc input image")
    parser.add_argument("--inputs-archive", type=Path,
                        help="Explicit retained OCI docker-save archive proving the canonical input config ID")
    parser.add_argument("--inputs-archive-manifest", type=Path,
                        help="Original hash/size/config-ID handoff manifest, required with --inputs-archive")
    parser.add_argument("--docker-storage-path", type=Path,
                        help="Docker backing file or local daemon data directory; defaults to discovered local storage")
    parser.add_argument("--minimum-free-gib", type=float, default=8,
                        help="Minimum free Docker backing-volume space before each expanding phase (default 8 GiB)")
    parser.add_argument("--evidence", type=Path, required=True,
                        help="New directory; existing evidence is never overwritten")
    parser.add_argument("--resume-tar", type=Path,
                        help="Explicit completed /glibc + /fixes snapshot, tar.gz")
    parser.add_argument("--resume-manifest", type=Path,
                        help="Hash-bound snapshot manifest, required with --resume-tar")
    parser.add_argument("--opencv-artifacts", type=Path,
                        help="Explicit compact outputs of a completed pinned OpenCV source recipe")
    parser.add_argument("--opencv-manifest", type=Path,
                        help="Hash-bound compact export manifest, required with --opencv-artifacts")
    args = parser.parse_args()
    if args.minimum_free_gib <= 0:
        parser.error("--minimum-free-gib must be positive")
    if args.inputs_image and (not args.inputs_image.startswith("sha256:")
            or len(args.inputs_image) != 71
            or any(c not in "0123456789abcdef" for c in args.inputs_image[7:])):
        parser.error("--inputs-image must be an immutable sha256 image ID")
    if bool(args.resume_tar) != bool(args.resume_manifest):
        parser.error("--resume-tar and --resume-manifest must be supplied together")
    if bool(args.opencv_artifacts) != bool(args.opencv_manifest):
        parser.error("--opencv-artifacts and --opencv-manifest must be supplied together")
    if bool(args.inputs_archive) != bool(args.inputs_archive_manifest) or args.inputs_archive and not args.inputs_image:
        parser.error("--inputs-archive and --inputs-archive-manifest require each other and --inputs-image")
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False, mode=0o700)
    if args.opencv_artifacts:
        opencv = json.loads(args.opencv_manifest.read_text())
        validate_opencv(args.opencv_artifacts.resolve(), opencv)
        shutil.copy2(args.opencv_manifest, evidence / "completed-opencv-manifest.json")
    token = uuid.uuid4().hex[:12]
    docker = shutil.which("docker")
    if not docker:
        raise SystemExit("Docker is not installed")
    commands = []

    def run(arguments, name, capture=False, allow_failure=False):
        if arguments[0] == "build" and args.build_network == "host":
            arguments = [arguments[0], "--network=host", *arguments[1:]]
        print(name, flush=True)
        commands.append({"command": [docker, *arguments], "log": name + ".log"})
        with (evidence / (name + ".log")).open("wb") as log:
            p = subprocess.run([docker, *arguments], stdout=subprocess.PIPE if capture else log,
                               stderr=log, check=False)
            if capture:
                log.write(p.stdout)
        commands[-1]["exit_code"] = p.returncode
        (evidence / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
        if p.returncode:
            if allow_failure:
                return None
            failure = {"schema": "lovelies-private-face-container-build-failure-v1",
                       "status": "failed", "native_acceptance": False,
                       "stage": name, "exit_code": p.returncode,
                       "command": p.args, "deployment_performed": False}
            (evidence / "failure.json").write_text(json.dumps(failure, indent=2) + "\n")
            raise subprocess.CalledProcessError(p.returncode, p.args)
        return p.stdout.decode() if capture else None

    def check_storage(phase):
        path = args.docker_storage_path
        if path is None and sys.platform == "darwin":
            path = Path.home() / "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"
        if path is None:
            path = Path(run(["info", "--format", "{{.DockerRootDir}}"], "docker-data-directory", True).strip())
        path = path.expanduser().resolve(strict=True)
        usage = shutil.disk_usage(path)
        record = {"path": str(path), "free_bytes": usage.free, "total_bytes": usage.total,
                  "required_free_bytes": int(args.minimum_free_gib * 1024 ** 3), "phase": phase}
        (evidence / ("docker-storage-" + phase + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        if usage.free < record["required_free_bytes"]:
            (evidence / "failure.json").write_text(json.dumps({"status": "failed",
                "native_acceptance": False, "stage": "docker-storage-" + phase,
                "reason": "Insufficient free space on Docker backing volume", **record}, indent=2) + "\n")
            raise RuntimeError("Insufficient free space on Docker backing volume: " + str(path))

    inputs_tag = "lovelies-glibc-inputs:" + token
    final_contexts = []
    if args.opencv_artifacts:
        validate_opencv(args.opencv_artifacts.resolve(), opencv)
        final_contexts = ["--build-context", "opencv-builder=" + str(args.opencv_artifacts.resolve())]
    check_storage("inputs")
    inputs_proof = None
    if args.inputs_archive:
        inputs_proof = verify_inputs_archive(args.inputs_archive, args.inputs_archive_manifest, args.inputs_image)
        execution_reference = resolve_inputs_archive(run, inputs_proof)
        inputs_id = args.inputs_image
        inputs_proof["execution_reference"] = execution_reference
        (evidence / "input-image-archive-proof.json").write_text(json.dumps(inputs_proof, indent=2) + "\n")
        shutil.copy2(args.inputs_archive_manifest, evidence / "input-image-archive-manifest.json")
    elif args.inputs_image:
        inputs_id = run(["image", "inspect", "--format", "{{.Id}}", args.inputs_image], "input-image", True).strip()
        if inputs_id != args.inputs_image:
            raise ValueError("Retained glibc input image differs")
    else:
        run(["build", "--pull=false", "--platform", "linux/amd64", "--progress", "plain", *final_contexts,
             "--target", "glibc-compile-inputs", "--tag", inputs_tag,
             "--file", str(CONTEXT / "Dockerfile"), str(CONTEXT)], "compile-inputs")
        inputs_id = run(["image", "inspect", "--format", "{{.Id}}", inputs_tag], "input-image", True).strip()
    if inputs_proof is None:
        execution_reference = inputs_id
    resume = None
    if args.resume_tar:
        resume = json.loads(args.resume_manifest.read_text())
        actual = fingerprint(args.resume_tar)
        if (resume.get("schema") != "lovelies-completed-glibc-tree-snapshot-v1"
                or resume.get("main_make_exit_code") != 0
                or resume.get("input_image_id") != inputs_id
                or any(actual[k] != resume["archive"][k] for k in ["bytes", "sha256"])):
            raise ValueError("Resume snapshot is incomplete, changed, or uses another toolchain")
        fixes = {"fixes/" + str(p.relative_to(CONTEXT / "patches/security-library-fixes")):
                 fingerprint(p)["sha256"]
                 for p in (CONTEXT / "patches/security-library-fixes").rglob("*") if p.is_file()}
        archived_fixes = {r["path"]: r.get("sha256") for r in resume["files"]
                          if r["path"].startswith("fixes/")}
        if fixes != archived_fixes:
            raise ValueError("Resume source recipes differ from the current pinned inputs")
        shutil.copy2(args.resume_manifest, evidence / "completed-tree-manifest.json")
    fixture = "lovelies-glibc-fixture-" + token
    # Invalidate verdicts only in the owned clone, preserving their preimages.
    prepare = """import hashlib,json,os,shutil
from pathlib import Path
tests=json.loads(%r)
root=Path('/glibc'); preserved=root/'out/previous-vendor-verdicts'
snapshot=Path('/tmp/completed-tree-manifest.json')
if snapshot.is_file():
 for row in json.loads(snapshot.read_text())['files']:
  p=Path('/')/row['path']
  if row['type']=='symlink':
   assert p.is_symlink() and os.readlink(p)==row['target'], 'Resume symlink changed'
  else:
   assert p.is_file() and not p.is_symlink() and p.stat().st_size==row['bytes'], 'Resume file missing'
   h=hashlib.sha256()
   with p.open('rb') as f:
    for block in iter(lambda:f.read(1048576),b''):h.update(block)
   assert h.hexdigest()==row['sha256'], 'Resume file changed'
for subdir in tests:
 # GNU make adds normal API consumers and malloc-check/hugetlb variants.
 # Every generated verdict in this selected subdirectory must be fresh.
 for suffix in ['.out','.test-result']:
  for p in (root/'build'/subdir).glob('*'+suffix):
   if p.is_file():
    d=preserved/subdir/p.name;d.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(p,d);p.unlink()
""" % json.dumps(TESTS)
    mode = "--package-existing-build" if resume else ""
    command = ("python3 -c " + shlex.quote(prepare) + "; sh /fixes/build-glibc-backport.sh " + mode
               + "; python3 /tmp/verify-face-libc-package.py")
    check_storage("fixture")
    run(["create", "--platform", "linux/amd64", "--name", fixture,
         "--label", "lovelies.task=face-container-producer", "--network", "none",
         "--user", "0:0", "--env", "HOME=/root", "--env", "TIMEOUTFACTOR=8",
         "--env", "LOVELIES_GLIBC_BUILD_JOBS=2", "--cap-add", "SYS_ADMIN",
         "--cap-add", "NET_ADMIN", "--security-opt", "seccomp=unconfined",
         "--entrypoint", "/bin/sh", execution_reference, "-ec", command], "create-fixture")
    run(["cp", str(ROOT / "scripts/lib/verify-face-libc-package.py"),
         fixture + ":/tmp/verify-face-libc-package.py"], "copy-package-verifier")
    if resume:
        with gzip.open(args.resume_tar, "rb") as archive:
            p = subprocess.Popen([docker, "cp", "-", fixture + ":/"], stdin=subprocess.PIPE)
            shutil.copyfileobj(archive, p.stdin)
            p.stdin.close()
            if p.wait():
                raise RuntimeError("Could not restore owned completed tree")
        run(["cp", str(args.resume_manifest), fixture + ":/tmp/completed-tree-manifest.json"], "copy-resume-proof")
    inspection = json.loads(run(["inspect", fixture], "fixture-runtime", True))[0]
    if inspection["HostConfig"]["NetworkMode"] != "none" or inspection["Config"]["User"] != "0:0":
        raise ValueError("Owned fixture isolation differs")
    try:
        run(["start", "--attach", fixture], "canonical-glibc-recipe")
    except subprocess.CalledProcessError:
        # Preserve the actual post-run state and redirected vendor diagnostics.
        # A pre-start inspection is never an execution result or acceptance.
        run(["inspect", fixture], "fixture-failure-state", True)
        diagnostics = evidence / "failed-glibc-output"
        diagnostics.mkdir()
        run(["cp", fixture + ":/glibc/out/.", str(diagnostics)], "export-failure-diagnostics")
        raise
    exit_code = int(run(["inspect", "--format", "{{.State.ExitCode}}", fixture], "fixture-exit", True))
    if exit_code != 0:
        raise RuntimeError("Canonical glibc recipe failed")
    export = evidence / "accepted-glibc/glibc/out"
    export.mkdir(parents=True)
    run(["cp", fixture + ":/glibc/out/.", str(export)], "export-accepted-glibc")
    receipt = json.loads((export / "glibc-backport-build-receipt.json").read_text())
    validate_receipt(receipt)
    package = fingerprint(export / "libc6.deb")
    validation = json.loads((export / "package-validation.json").read_text())
    if (validation.get("status") != "passed"
            or validation.get("manifest_sha256") != fingerprint(CONTEXT / "patches/security-library-fixes/glibc-backport-manifest.json")["sha256"]
            or any(validation["package"][k] != package[k] for k in ["bytes", "sha256"])):
        raise ValueError("Exported package did not pass embedded receipt/runtime validation")
    # Only this accepted package replaces the glibc stage; all other recipes run
    # on the original builder, with their existing cache and final minimization.
    if args.opencv_artifacts:
        validate_opencv(args.opencv_artifacts.resolve(), opencv)
    check_storage("final-solve")
    run(["build", "--pull=false", "--platform", "linux/amd64", "--progress", "plain", *final_contexts,
         "--build-context", "glibc-security-builder=" + str(evidence / "accepted-glibc"),
         "--target", args.output_stage,
         "--tag", args.tag, "--iidfile", str(evidence / "final-image-id.txt"),
         "--file", str(CONTEXT / "Dockerfile"), str(CONTEXT)], "final-source-build")
    if fingerprint(export / "libc6.deb") != package:
        raise ValueError("Accepted package changed during the final solve")
    result = {"schema": "lovelies-private-face-container-build-v1", "status": "passed",
              "image_id": (evidence / "final-image-id.txt").read_text().strip(),
              "inputs_image_id": inputs_id, "fixture_container": fixture,
              "inputs_execution_reference": execution_reference,
              "required_vendor_tests": sum(map(len, TESTS.values())),
              "accepted_glibc_package": package, "dockerfile": fingerprint(CONTEXT / "Dockerfile"),
              "resumed_completed_tree": resume is not None,
              "output_stage": args.output_stage, "image_build_network": args.build_network,
              "canonical_fixture_network": "none", "final_image_accepted": False,
              "deployment_performed": False}
    if resume:
        result["resume_manifest"] = fingerprint(evidence / "completed-tree-manifest.json")
        result["resume_archive"] = fingerprint(args.resume_tar)
    if args.opencv_artifacts:
        validate_opencv(args.opencv_artifacts.resolve(), opencv)
        result["retained_opencv_manifest"] = fingerprint(evidence / "completed-opencv-manifest.json")
    (evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    # Remove only this producer's stopped fixture. Failed fixtures are retained
    # for diagnosis; no shared images, cache, volumes or containers are pruned.
    run(["rm", fixture], "remove-owned-fixture")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
