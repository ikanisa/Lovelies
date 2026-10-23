"""Apply explicitly hashed stdlib backports with exact hunk context, without fuzz.

The immutable original module hashes bind this to CPython 3.13.15. This writes a
separate builder output tree; the calling image build copies verified modules.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import sysconfig


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sections(patch: str):
    lines = patch.splitlines(keepends=True)
    index = 0
    while index < len(lines):
        if not lines[index].startswith("--- a/Lib/"):
            index += 1
            continue
        old = lines[index].strip().removeprefix("--- a/Lib/")
        index += 1
        if index >= len(lines) or lines[index].strip() != "+++ b/Lib/" + old:
            raise ValueError("Only same-path stdlib module patches are permitted")
        index += 1
        hunks = []
        while index < len(lines) and not lines[index].startswith(("diff --git", "--- a/")):
            line = lines[index]
            if not line.startswith("@@ "):
                index += 1
                continue
            match = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
            if match is None:
                raise ValueError("Invalid unified hunk header")
            start = int(match[1]) - 1
            old_count = int(match[2] or 1)
            new_count = int(match[4] or 1)
            before, after = [], []
            index += 1
            while index < len(lines) and lines[index][:1] in {" ", "-", "+"}:
                item = lines[index]
                if item.startswith(("--- a/", "+++ b/")):
                    break
                if item.startswith((" ", "-")):
                    before.append(item[1:])
                if item.startswith((" ", "+")):
                    after.append(item[1:])
                index += 1
            if len(before) != old_count or len(after) != new_count:
                raise ValueError("Hunk line counts differ")
            hunks.append((start, before, after))
        if not hunks:
            raise ValueError("Patch has no exact hunks")
        yield old, hunks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdlib", default=sysconfig.get_path("stdlib"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if sys.version_info[:3] != (3, 13, 15):
        raise SystemExit("This manifest is only valid for CPython 3.13.15")
    base = Path(__file__).resolve().parent
    manifest_path = base / "cpython-backports-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    stdlib = Path(args.stdlib).resolve()
    output = Path(args.output).resolve()
    if output == stdlib or output in stdlib.parents or stdlib in output.parents:
        raise ValueError("Write to a separate builder output tree")
    modules = {entry["path"]: entry for entry in manifest["modules"]}
    if len(modules) != 6:
        raise ValueError("Unexpected stdlib module set")
    contents = {}
    for name, entry in modules.items():
        target = stdlib / name
        if target.is_symlink() or not target.is_file():
            raise ValueError("Original must be an ordinary stdlib file")
        data = target.read_bytes()
        if sha256(data) != entry["original_sha256"]:
            raise ValueError("Original module hash differs: " + name)
        contents[name] = data.decode("utf-8").splitlines(keepends=True)
    applied = []
    for entry in manifest["patch_order"]:
        for filename, expected in (
            (entry["upstream_patch"], entry["upstream_patch_sha256"]),
            (entry["runtime_patch"], entry["runtime_patch_sha256"]),
        ):
            data = (base / filename).read_bytes()
            if sha256(data) != expected:
                raise ValueError("Patch hash differs: " + filename)
        changes = []
        for name, hunks in sections((base / entry["runtime_patch"]).read_text()):
            if name not in modules:
                raise ValueError("Undeclared stdlib module: " + name)
            text = contents[name]
            offset = 0
            for start, before, after in hunks:
                expected_position = start + offset
                if text[expected_position:expected_position + len(before)] == before:
                    position = expected_position
                else:
                    matches = [
                        n for n in range(len(text) - len(before) + 1)
                        if text[n:n + len(before)] == before
                    ]
                    if len(matches) != 1:
                        raise ValueError("No unique exact hunk context: " + name)
                    position = matches[0]
                text[position:position + len(before)] = after
                changes.append({"module": name, "context_fuzz": 0,
                                "line_offset": position - expected_position})
                offset += len(after) - len(before)
            contents[name] = text
        if not changes:
            raise ValueError("Empty declared backport")
        applied.append({"id": entry["id"], "aliases": entry["aliases"], "hunks": changes})
    verified = {}
    for name, lines in contents.items():
        data = "".join(lines).encode("utf-8")
        if sha256(data) != modules[name]["patched_sha256"]:
            raise ValueError("Patched module hash differs: " + name)
        compile(data, name, "exec")
        verified[name] = data
    # No output is written until every original, patch and resulting module passes.
    output.mkdir(parents=True, exist_ok=False)
    for name, data in verified.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o644)
    receipt = {"schema": "lovelies-cpython-stdlib-backport-receipt-v1",
               "manifest_sha256": sha256(manifest_path.read_bytes()),
               "python_version": sys.version.split()[0], "zero_context_fuzz": True,
               "patches": applied,
               "modules": [{"path": name, "sha256": sha256(data), "bytes": len(data)}
                           for name, data in verified.items()]}
    (output.parent / "cpython-backport-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"patch_groups": len(applied), "modules": len(verified),
                      "zero_context_fuzz": True}))


if __name__ == "__main__":
    main()
