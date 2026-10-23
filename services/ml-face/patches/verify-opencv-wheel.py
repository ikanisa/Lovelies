#!/usr/bin/env python3
"""Reject corrupt wheels before accepting or removing their compiled tree."""
import base64
import csv
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath


def verify_wheel(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if (len(names) != len(set(names))
                or any(n.startswith('/') or '..' in PurePosixPath(n).parts for n in names)
                or archive.testzip() is not None):
            raise ValueError('OpenCV wheel ZIP contents are invalid')
        records = [n for n in names if n.endswith('.dist-info/RECORD')]
        if len(records) != 1:
            raise ValueError('OpenCV wheel must contain one RECORD')
        rows = list(csv.reader(io.StringIO(archive.read(records[0]).decode('utf-8'))))
        if len(rows) != len(names) or {r[0] for r in rows} != set(names):
            raise ValueError('OpenCV wheel RECORD does not cover its exact files')
        for name, digest, size in rows:
            if name == records[0]:
                if digest or size:
                    raise ValueError('RECORD must use its standard unhashed self entry')
                continue
            h = hashlib.sha256()
            total = 0
            with archive.open(name) as content:
                for block in iter(lambda: content.read(1048576), b''):
                    h.update(block)
                    total += len(block)
            expected = 'sha256=' + base64.urlsafe_b64encode(h.digest()).decode().rstrip('=')
            if digest != expected or int(size) != total:
                raise ValueError('OpenCV wheel RECORD hash/size differs: ' + name)
        libraries = [n for n in names if n.endswith('.so')]
        if 'cv2/cv2.abi3.so' not in libraries:
            raise ValueError('OpenCV wheel lacks its native module')
        for name in libraries:
            with archive.open(name) as content:
                header = content.read(64)
            if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\x3e\x00':
                raise ValueError('OpenCV native module is not AMD64 ELF64: ' + name)
    return {'schema': 'lovelies-opencv-wheel-validation-v1', 'status': 'passed',
            'wheel_bytes': path.stat().st_size, 'wheel_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'record_entries_verified': len(rows), 'native_libraries_verified': libraries}


if __name__ == '__main__':
    result = verify_wheel(Path(sys.argv[1]))
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
