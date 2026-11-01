#!/usr/bin/env python3
"""Stage only the existing public allowlist; never mount repository directories."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("lovelies_public_allowlist", ROOT / "scripts/serve-preview.py")
allowlist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(allowlist)


def stage(public_site: Path, output: Path):
    if public_site.is_symlink() or output.exists() or not public_site.is_dir():
        raise ValueError("new output and an existing regular public site required")
    output.mkdir(mode=0o755)
    records = []

    def copy(root, parts, destination):
        with allowlist.open_public_file(root, tuple(parts))[0] as source:
            data = source.read()
        target = output / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as sink:
            sink.write(data)
        target.chmod(0o644)
        records.append({"path": destination.as_posix(), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})

    public_names = {Path(*parts[1:]) for parts in allowlist.PUBLIC_FILES if parts[0] == "web"}
    public_names |= {Path(".well-known/apple-app-site-association"), Path(".well-known/assetlinks.json")}
    for file in sorted(public_site.rglob("*")):
        if file.is_symlink():
            raise ValueError("public symlink rejected")
        if not file.is_file():
            continue
        relative = file.relative_to(public_site)
        if relative not in public_names and not (relative.parts[0] == "assets" and relative.suffix.lower() in allowlist.IMAGE_EXTENSIONS):
            # Host-specific build routing files are not served by Caddy.
            if relative.name in {"_headers", "_redirects"}:
                continue
            raise ValueError("unexpected file in public site")
        copy(public_site, relative.parts, Path("public") / relative)
    for parts in sorted(allowlist.PUBLIC_FILES):
        if parts[0] in {"admin", "clients", "shared"}:
            copy(ROOT, parts, Path(*parts))
    copied = {record["path"] for record in records}
    for prefix in allowlist.IMAGE_DIRECTORIES:
        if prefix[0] != "shared":
            continue
        for file in sorted((ROOT / Path(*prefix)).rglob("*")):
            if file.is_symlink():
                raise ValueError("public image symlink rejected")
            if not file.is_file() or file.suffix.lower() not in allowlist.IMAGE_EXTENSIONS:
                continue
            relative = file.relative_to(ROOT)
            if relative.as_posix() not in copied:
                copy(ROOT, relative.parts, relative)
                copied.add(relative.as_posix())
    if not (output / "public/index.html").is_file() or not (output / "admin/index.html").is_file():
        raise ValueError("required public entrypoint missing")
    manifest = {"protocol": "lovelies-local-public-stage-v1", "files": sorted(records, key=lambda value: value["path"])}
    (output / "local-supabase-static-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return {"status": "public_allowlist_staged", "files": len(records), "public_site": str(output.resolve() / "public")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-site", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    print(json.dumps(stage(options.public_site.resolve(), options.output.absolute())))
