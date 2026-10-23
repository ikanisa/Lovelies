"""Flatten explicit, hash-bound evidence reference indexes for preservation.

Producer JSON, archive members and provider identifiers have different namespaces.
Only an entry explicitly declared a reference_index is traversed. A payload is
preserved byte-for-byte; its canonical validator still owns semantic acceptance
and whether the declared dependency graph covers the applicable release.
"""
from pathlib import Path

from evidence_archive import (HEX, INPUT_SCHEMA, MAX_RECORDS, _load, _ordinary,
                              _relative, file_record)

REFERENCE_SCHEMA = "lovelies-evidence-reference-index-v1"
MAX_DEPTH = 32


def reference_inventory(source_root, roots):
    root = Path(source_root).resolve(strict=True)
    if not isinstance(roots, list) or not roots or len(roots) > MAX_RECORDS:
        raise ValueError("Explicit evidence reference roots are required")
    for path in roots:
        _relative(path)
    if len(set(roots)) != len(roots):
        raise ValueError("Duplicate evidence reference root")
    pending = [(path, None, 0) for path in roots]
    records, kinds, indexes, scopes, limitations = {}, {}, [], [], []
    while pending:
        path, expected, depth = pending.pop()
        if depth > MAX_DEPTH:
            raise ValueError("Evidence reference graph is too deep")
        kind = expected["kind"] if expected else "reference_index"
        if path in records:
            if kind != kinds[path] or (expected and any(
                    records[path][key] != expected[key] for key in ("bytes", "sha256"))):
                raise ValueError("Contradictory evidence dependency: " + path)
            continue
        actual = file_record(root, path)
        if expected and any(actual[key] != expected[key] for key in ("bytes", "sha256")):
            raise ValueError("Evidence dependency is stale: " + path)
        if len(records) >= MAX_RECORDS:
            raise ValueError("Excessive evidence dependency graph")
        records[path], kinds[path] = actual, kind
        if kind == "payload":
            continue
        value, loaded = _load(_ordinary(root, path), with_record=True)
        if any(actual[key] != loaded[key] for key in ("bytes", "sha256")):
            raise ValueError("Evidence reference index changed while reading")
        if (not isinstance(value, dict) or
                set(value) != {"schema", "scope", "limitations", "files"} or
                value["schema"] != REFERENCE_SCHEMA or
                not isinstance(value["scope"], str) or not value["scope"].strip() or
                not isinstance(value["limitations"], list) or not value["limitations"] or
                not all(isinstance(item, str) and item.strip() for item in value["limitations"]) or
                not isinstance(value["files"], list) or not value["files"] or
                len(value["files"]) > MAX_RECORDS):
            raise ValueError("Invalid explicit evidence reference index: " + path)
        indexes.append(actual)
        scopes.append(value["scope"])
        limitations.extend(value["limitations"])
        local_paths = set()
        for row in value["files"]:
            if (not isinstance(row, dict) or
                    set(row) != {"path", "bytes", "sha256", "kind"} or
                    type(row["bytes"]) is not int or row["bytes"] < 0 or
                    not isinstance(row["sha256"], str) or not HEX.fullmatch(row["sha256"]) or
                    row["kind"] not in ("payload", "reference_index")):
                raise ValueError("Invalid typed evidence dependency")
            _relative(row["path"])
            if row["path"] in local_paths:
                raise ValueError("Duplicate dependency path in reference index")
            local_paths.add(row["path"])
            pending.append((row["path"], row, depth + 1))
    # Bind all selected bytes to one observed stable readback before returning.
    # The archiver independently rechecks them again before and during copying.
    for path, record in records.items():
        if file_record(root, path) != record:
            raise ValueError("Evidence graph changed during inventory: " + path)
    return {"schema": INPUT_SCHEMA,
            "scope": "Declared reference closure: " + "; ".join(dict.fromkeys(scopes)),
            "limitations": list(dict.fromkeys(limitations + [
                "Only explicitly typed reference indexes are traversed; producer JSON payloads and archive member namespaces are not inferred as repository paths.",
                "Canonical producer/release validators own semantic acceptance and complete applicable dependency declarations; this inventory verifies declared bytes only.",
                "No provider, production, encryption/key recovery or RPO/RTO acceptance is inferred."])),
            "files": sorted(records.values(), key=lambda row: row["path"]),
            "reference_roots": roots,
            "reference_indexes": sorted(indexes, key=lambda row: row["path"]),
            "source_unchanged_during_inventory": True,
            "production_ready_claimed": False}
