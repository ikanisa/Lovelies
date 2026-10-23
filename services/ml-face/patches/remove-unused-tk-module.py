#!/usr/bin/env python3
"""Remove the unused base GUI extension with unresolved Tk/Tcl dependencies."""
import hashlib
import json
from pathlib import Path
import sys

assert sys.version_info[:2] == (3, 13)
root = Path("/usr/local/lib/python3.13/lib-dynload")
modules = list(root.glob("_tkinter*.so"))
assert len(modules) == 1, "Pinned base optional GUI payload differs"
module = modules[0]
record = {"path": str(module), "sha256": hashlib.sha256(module.read_bytes()).hexdigest(), "bytes": module.stat().st_size}
module.unlink()
receipt = {
    "schema": "lovelies-ml-optional-gui-removal-v1", "modified_at": "2026-09-30",
    "base_python_version": sys.version, "removed": record,
    "reason": "No ML application GUI path. The pinned slim base shipped this optional extension without libtk8.6/libtcl8.6; removing it gives complete linkage for every remaining shipped native module.",
    "scope": "Container-local Python optional module only; no host OS settings are modified.",
    "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}
Path("/usr/local/share/doc/lovelies-build/optional-gui-removal.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"removed_optional_module": record["path"], "sha256": record["sha256"]}))
