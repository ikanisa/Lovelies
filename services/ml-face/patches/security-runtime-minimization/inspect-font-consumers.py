"""Targeted service font consumer and ordinary-image observation; read only."""
import ast
import hashlib
import importlib.abc
import io
import json
from pathlib import Path
import sys

hits = []
source_files = list(Path("/app/src").rglob("*.py"))
for path in source_files:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [x.name for x in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [(node.module or "") + "." + x.name for x in node.names]
        elif isinstance(node, ast.Attribute):
            names = [node.attr] if node.attr in {"truetype", "text", "textbbox", "textlength", "multiline_text"} else []
        else:
            names = []
        for name in names:
            if "ImageFont" in name or "ImageDraw" in name or "imagingft" in name or name in {"truetype", "text", "textbbox", "textlength", "multiline_text"}:
                hits.append({"path": str(path), "line": node.lineno, "consumer": name,
                             "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest()})


class Deny(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in {"PIL.ImageFont", "PIL._imagingft", "sqlite3", "_sqlite3", "readline", "curses", "_curses", "_curses_panel"}:
            raise ImportError("Optional functionality intentionally denied")


sys.meta_path.insert(0, Deny())
from PIL import Image
from pictured_ml_face.main import pipeline
from pictured_ml_face.models import PhotoProcessRequest

results = []
for fmt, content_type in [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")]:
    output = io.BytesIO()
    Image.new("RGB", (64, 64), (20, 50, 80)).save(output, format=fmt)
    payload = output.getvalue()
    request = PhotoProcessRequest(event_id="synthetic-font-exclusion", asset_id="synthetic-" + fmt.lower(),
                                  object_key="", content_type=content_type)
    result = pipeline.process_photo_bytes(request, payload)
    assert result.status == "no_faces" and len(result.faces) == 0
    results.append({"format": fmt, "input_sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload),
                    "status": result.status, "faces": len(result.faces),
                    "width": result.image_metadata["geometry"]["width"],
                    "height": result.image_metadata["geometry"]["height"]})
assert not any(x in sys.modules for x in {"PIL.ImageFont", "PIL._imagingft", "_sqlite3", "readline", "_curses", "_curses_panel"})
print(json.dumps({"schema": "lovelies-targeted-service-font-exclusion-v1", "source_files_inspected": len(source_files),
                  "service_font_consumer_hits": hits, "actual_model_cases": results,
                  "font_and_four_optional_modules_loaded": False,
                  "limitations": ["Generated no-face inputs establish this bounded decoder/model consumer observation, not recognition accuracy.",
                                  "Final font ELF/library omission and codec/native runtime gates remain required."]}, indent=2))
