#!/usr/local/bin/python3
"""Record actual Cargo compiler messages and rustc argv without changing flags."""
import json
import os
from pathlib import Path
import subprocess
import sys


def append(path, value):
    fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        os.write(fd, (json.dumps(value, separators=(",", ":")) + "\n").encode())
    finally:
        os.close(fd)


if Path(sys.argv[0]).name == "cargo":
    argv = ["/out/toolchain/bin/cargo", *sys.argv[1:]]
    append("/out/cargo-invocations.jsonl", {"argv": argv, "cwd": os.getcwd()})
    process = subprocess.Popen(argv, stdout=subprocess.PIPE)
    for line in process.stdout:
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get("reason") in {
                "compiler-artifact", "build-script-executed", "build-finished"
            }:
                append("/out/cargo-build-messages.jsonl", value)
        except (ValueError, UnicodeDecodeError):
            pass
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
    sys.exit(process.wait())
else:
    argv = sys.argv[1:]
    append("/out/rustc-invocations.jsonl", {
        "argv": argv,
        "cwd": os.getcwd(),
        "package_name": os.environ.get("CARGO_PKG_NAME"),
        "package_version": os.environ.get("CARGO_PKG_VERSION"),
        "manifest_dir": os.environ.get("CARGO_MANIFEST_DIR"),
        "pyo3_environment": {k: v for k, v in os.environ.items() if k.startswith("PYO3_")},
    })
    os.execvp(argv[0], argv)
