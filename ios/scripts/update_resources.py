#!/usr/bin/env python3
"""Include individual image/JSON resources without changing source or signing settings."""
from pathlib import Path
import hashlib
import re
import subprocess
import json

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "Lovelies.xcodeproj" / "project.pbxproj"


def object_id(value):
    return hashlib.sha1(value.encode()).hexdigest()[:24].upper()


def update():
    value = PROJECT.read_text()
    additions = []
    children = []
    builds = []
    resources = [p for p in sorted((ROOT / "Lovelies" / "Resources").iterdir()) if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png", ".json")]
    for path in resources:
        relative = "Resources/" + path.name
        file_id = object_id("file:" + relative)
        build_id = object_id("build:" + relative)
        children.append(file_id)
        builds.append(build_id)
        if file_id not in value:
            kind = "image.png" if path.suffix == ".png" else "text.json" if path.suffix == ".json" else "image.jpeg"
            additions.append(f'  {file_id} = {{ isa = PBXFileReference; lastKnownFileType = {kind}; path = "{path.name}"; sourceTree = "<group>"; }};\n')
            additions.append(f"  {build_id} = {{ isa = PBXBuildFile; fileRef = {file_id}; }};\n")
    value = value.replace(" objects = {\n", " objects = {\n" + "".join(additions), 1)
    group_id = object_id("group:Resources")
    phase_id = object_id("resources-phase")
    value, groups = re.subn(r"(" + group_id + r" = \{ isa = PBXGroup; children = \()(.*?)(\); path = Resources;)", lambda match: match[1] + ", ".join(children) + match[3], value)
    # Privacy manifest lives beside Info.plist, outside the photo resource group.
    privacy_build = object_id("build:PrivacyInfo.xcprivacy")
    extra_builds = [privacy_build] if privacy_build in value else []
    value, phases = re.subn(r"(" + phase_id + r" = \{ isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = \()(.*?)(\);)", lambda match: match[1] + ", ".join(builds + extra_builds + [object_id("assets-build")]) + match[3], value)
    if groups != 1 or phases != 1:
        raise RuntimeError("Expected one Resources group and resources build phase; project was not changed.")
    PROJECT.write_text(value)
    subprocess.run(["plutil", "-lint", str(PROJECT)], check=True)
    document = json.loads(subprocess.check_output(["plutil", "-convert", "json", "-o", "-", str(PROJECT)]))
    objects = document["objects"]
    for entry in objects.values():
        for key in ("children", "files", "targets", "buildPhases", "buildConfigurations"):
            for reference in entry.get(key, []):
                if reference not in objects:
                    raise RuntimeError(f"Missing project reference: {reference}")
    print(f"Included {len(resources)} image/JSON files individually; all project references resolve.")


if __name__ == "__main__":
    update()
