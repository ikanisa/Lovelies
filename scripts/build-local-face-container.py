#!/usr/bin/env python3
"""Build a local-only model overlay from the already retained exact runtime.

No pull, push or deployment. Release rebuild uses services/ml-face/Dockerfile.
"""
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[1]
DOCKER='/Applications/Docker.app/Contents/Resources/bin/docker'
BASE='lovelies-ml-release:security-4a8a73463c5c4ec6'
EXPECTED='sha256:b684cc9768693aaf595107eeabcd20dd4452293db1ff0a4557c8242703fb9e5b'
actual=subprocess.check_output([DOCKER,'image','inspect','--format','{{.Id}}',BASE],text=True).strip()
if actual!=EXPECTED:raise SystemExit('Local cached runtime identity differs; refusing overlay')
subprocess.run([DOCKER,'build','--pull=false','--platform','linux/amd64','--file',str(ROOT/'services/ml-face/Dockerfile.local-cache'),'--tag','lovelies-native-face:20261013-local-cache',str(ROOT/'services/ml-face')],check=True)
