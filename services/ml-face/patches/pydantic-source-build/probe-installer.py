"""Replace an isolated copy of the actual old distribution; test rejection before writes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import sysconfig
import zipfile

out = Path("/out")
built = json.loads((out / "build-provenance.json").read_text())
wheel = out / built["wheel"]["path"]
site = out / "installed-site"
site.mkdir()
old = Path(sysconfig.get_path("purelib"))
for name in ["pydantic_core", "pydantic_core-2.46.4.dist-info"]:
    shutil.copytree(old / name, site / name)
subprocess.run([sys.executable, "/recipes/install-wheel.py", "--wheel", str(wheel),
                "--expected-sha256", built["wheel"]["sha256"], "--site-packages", str(site),
                "--receipt", str(out / "offline-installation-receipt.json")], check=True)
spec = importlib.util.spec_from_file_location("installer", "/recipes/install-wheel.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
controls = []
try:
    installer.validated_members(wheel, "0" * 64)
except ValueError:
    controls.append("wrong_expected_sha_rejected")
else:
    raise AssertionError("Wrong wheel checksum accepted")
with zipfile.ZipFile(wheel) as original:
    members = {x.filename: original.read(x) for x in original.infolist() if not x.is_dir()}
for kind in ["path_escape", "duplicate", "symlink", "record_tamper"]:
    target = out / ("rejected-installer-" + kind + ".whl")
    with zipfile.ZipFile(target, "w") as archive:
        for name, value in members.items():
            if kind == "record_tamper" and name == "pydantic_core/__init__.py":
                value += b"\n# changed without RECORD\n"
            archive.writestr(name, value)
        if kind == "path_escape":
            archive.writestr("pydantic_core/../outside", b"rejected")
        elif kind == "duplicate":
            archive.writestr("pydantic_core/__init__.py", b"rejected")
        elif kind == "symlink":
            info = zipfile.ZipInfo("pydantic_core/rejected-link")
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, b"/outside")
    try:
        installer.validated_members(target, hashlib.sha256(target.read_bytes()).hexdigest())
    except ValueError:
        controls.append(kind + "_rejected")
    else:
        raise AssertionError("Invalid wheel accepted: " + kind)
    target.unlink()
(out / "installer-rejection-controls.json").write_text(json.dumps({"status": "pass", "controls": controls, "passed": len(controls), "failed": 0, "downloads": 0}, indent=2) + "\n")
