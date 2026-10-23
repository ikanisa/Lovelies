#!/usr/bin/env python3
"""Bind NumPy's compiler runtime replacement to exact Debian bytes and ABI.

Keep the original OpenBLAS/NumPy payload, redirect only the two compiler
libraries, and retain original notices plus actual replacement provenance.
"""
import argparse
import base64
import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

COMPONENTS = {
    "libgfortran5": {
        "wheel_name": "libgfortran-040039e1-0352e75f.so.5.0.0",
        "wheel_sha256": "c6090048eccc763522c12ef016f81da6b627cb3a044f55cf0479a839c41c0980",
        "system_name": "libgfortran.so.5",
    },
    "libquadmath0": {
        "wheel_name": "libquadmath-96973f99-934c22de.so.0.0.0",
        "wheel_sha256": "6ed5137f412781ad7863439fb543613f620b43c32b63292a0029246162f5bbc6",
        "system_name": "libquadmath.so.0",
    },
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args):
    return subprocess.check_output(args, text=True)


def package_info(name):
    info = command(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}", name]).strip().split("\t")
    assert len(info) == 5 and info[-1] == "amd64"
    return dict(zip(("package", "version", "source_package", "source_version", "architecture"), info, strict=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--numpy-libs", type=Path, required=True)
    args = parser.parse_args()
    assert args.prepare != args.replace
    assert os.getuid() == 0 and sys.version_info[:2] == (3, 13)
    triplet = "x86_64-linux-gnu"
    receipt_path = args.output / "compiler-runtime-replacement.json"
    if args.prepare:
        args.output.mkdir(parents=True)
        records = []
        for name, component in COMPONENTS.items():
            original = args.numpy_libs / component["wheel_name"]
            replacement = Path("/usr/lib") / triplet / component["system_name"]
            assert original.is_file() and not original.is_symlink()
            assert sha(original) == component["wheel_sha256"], "Compiler runtime differs from the checksum-bound publisher wheel"
            assert replacement.is_file()
            before = sorted(line.split()[-1] for line in command(["nm", "-D", "--defined-only", str(original)]).splitlines() if line.split())
            after = sorted(line.split()[-1] for line in command(["nm", "-D", "--defined-only", str(replacement)]).splitlines() if line.split())
            assert before and after and not set(before).difference(after), "Debian replacement does not preserve the versioned compiler API"
            assert f"Library soname: [{component['system_name']}]" in command(["readelf", "-d", str(replacement)])
            (args.output / f"{name}-original-api.txt").write_text("\n".join(before) + "\n")
            (args.output / f"{name}-replacement-api.txt").write_text("\n".join(after) + "\n")
            shutil.copyfile(Path("/usr/share/doc") / name / "copyright", args.output / f"{name}-copyright.txt")
            records.append({**component, **package_info(name), "runtime_path": str(replacement), "replacement_sha256": sha(replacement),
                            "original_exported_symbols": len(before), "replacement_exported_symbols": len(after), "missing_versioned_symbols": []})
        shutil.copyfile(__file__, args.output / Path(__file__).name)
        (args.output / "LOVELIES-MODIFICATION-NOTICE.txt").write_text(
            "Lovelies modified NumPy runtime distribution, 30 September 2026.\n"
            "NumPy 2.4.6 and its OpenBLAS payload retain their original code and notices.\n"
            "Two stripped wheel compiler libraries are replaced by ABI-compatible Debian GCC shared libraries.\n"
            "The original hashed dependency filenames are symlinks to checksum-bound Debian bytes.\n"
            "The complete original NumPy notices and actual Debian copyrights remain supplied.\n"
            "Corresponding Debian sources, signed repository metadata and replacement instructions accompany the local distribution kit.\n"
            "Recipients retain modification/relinking and debugging rights under the original library licences.\n"
            "This is a local modification, not a publisher wheel, independent legal approval or production release.\n"
        )
        receipt_path.write_text(json.dumps({"schema": "lovelies-numpy-compiler-runtime-replacement-v1", "numpy_version": "2.4.6",
                                           "publisher_wheel_sha256": "a7830bab239b79cda9c08c2da014761cafb48da6150e1da17ac06283f43b6089",
                                           "script_sha256": sha(Path(__file__)), "libraries": records}, indent=2) + "\n")
    else:
        assert importlib.metadata.version("numpy") == "2.4.6"
        receipt = json.loads(receipt_path.read_text())
        assert receipt["schema"] == "lovelies-numpy-compiler-runtime-replacement-v1"
        assert receipt["script_sha256"] == sha(Path(__file__))
        assert len(receipt["libraries"]) == len(COMPONENTS)
        for record in receipt["libraries"]:
            original = args.numpy_libs / record["wheel_name"]
            replacement = Path(record["runtime_path"])
            assert not original.is_symlink() and sha(original) == record["wheel_sha256"]
            assert sha(replacement) == record["replacement_sha256"]
            assert package_info(record["package"]) == {k: record[k] for k in ("package", "version", "source_package", "source_version", "architecture")}
            original.unlink()
            original.symlink_to(replacement)
        metadata_dirs = list(args.numpy_libs.parent.glob("numpy-2.4.6.dist-info"))
        assert len(metadata_dirs) == 1
        record_path = metadata_dirs[0] / "RECORD"
        with record_path.open(newline="") as stream:
            entries = list(csv.reader(stream))
        updated = set()
        for entry in entries:
            if "numpy.libs/" not in entry[0]:
                continue
            for record in receipt["libraries"]:
                if Path(entry[0]).name != record["wheel_name"]:
                    continue
                original_hash = base64.urlsafe_b64encode(bytes.fromhex(record["wheel_sha256"])).decode().rstrip("=")
                assert entry[1] == "sha256=" + original_hash
                actual_hash = base64.urlsafe_b64encode(bytes.fromhex(record["replacement_sha256"])).decode().rstrip("=")
                entry[1] = "sha256=" + actual_hash
                entry[2] = str(Path(record["runtime_path"]).stat().st_size)
                updated.add(record["wheel_name"])
        assert updated == {record["wheel_name"] for record in receipt["libraries"]}
        with record_path.open("w", newline="") as stream:
            csv.writer(stream).writerows(entries)
        # Import after replacement, so any loader/ABI issue prevents publication.
        import numpy as np
        assert np.__version__ == "2.4.6"
        matrix = np.arange(128 * 128, dtype=np.float64).reshape(128, 128) / 16384
        vector = np.linspace(-1, 1, 128)
        actual = matrix @ vector
        reference = np.array([sum(float(matrix[i, j]) * float(vector[j]) for j in range(128)) for i in range(128)])
        assert np.allclose(actual, reference, rtol=1e-12, atol=1e-12)
        normalized = actual / np.linalg.norm(actual)
        assert np.isfinite(normalized).all() and abs(float(np.linalg.norm(normalized)) - 1) < 1e-12
        (args.output / "runtime-numerical-regression.json").write_text(json.dumps({"result": "passed", "matrix_shape": [128, 128],
            "finite_unit_vector_dimensions": 128, "max_absolute_reference_difference": float(np.max(np.abs(actual-reference))),
            "numpy_version": np.__version__, "modified_numpy_RECORD_sha256": sha(record_path),
            "record_entries_updated_to_actual_replacement_bytes": len(updated)}, indent=2) + "\n")
    print(json.dumps({"result": "passed", "mode": "prepare" if args.prepare else "replace", "receipt": str(receipt_path)}))


if __name__ == "__main__":
    main()
