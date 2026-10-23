"""Focused fresh extension loading and canonical validation/serialization checks."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys

import pydantic
import pydantic_core
from pydantic import BaseModel, TypeAdapter
from pydantic_core import SchemaValidator, SchemaSerializer, ValidationError, core_schema

checks = []


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    checks.append(name)


check("fresh_source_extension_loaded", str(pydantic_core._pydantic_core.__file__).startswith("/probe/pydantic_core/"))
check("exact_core_version", pydantic_core.__version__ == "2.46.4")
check("cp313_amd64_abi", sys.version_info[:2] == (3, 13) and "cpython-313-x86_64-linux-gnu" in pydantic_core._pydantic_core.__file__)
v = SchemaValidator(core_schema.int_schema(strict=True))
check("valid_strict_integer", v.validate_python(7) == 7)
try:
    v.validate_python("7")
except ValidationError:
    checks.append("strict_invalid_input_rejected")
else:
    raise AssertionError("strict invalid input accepted")
check("json_integer", v.validate_json(b"7") == 7)
check("canonical_serializer", SchemaSerializer(core_schema.int_schema()).to_json(7) == b"7")
for _ in range(4):
    value = SchemaValidator(core_schema.str_schema(pattern="^[a-z]{2,8}$"))
    check("regex_cache_valid_" + str(_), value.validate_python("local") == "local")


class LocalRecord(BaseModel):
    count: int
    labels: list[str]


check("installed_pydantic_consumer", LocalRecord.model_validate_json('{"count":7,"labels":["fixture"]}').model_dump() == {"count": 7, "labels": ["fixture"]})
check("list_adapter_json", TypeAdapter(list[int]).validate_json("[1,2,3]") == [1, 2, 3])
path = Path(pydantic_core._pydantic_core.__file__)
print(json.dumps({"schema": "lovelies-pydantic-source-wheel-load-probe-v1", "status": "pass_focused_load_checks", "checks": checks, "passed": len(checks), "failed": 0, "extension": {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size}, "core_version": pydantic_core.__version__, "pydantic_consumer_version": pydantic.__version__, "typing_extensions_version": importlib.metadata.version("typing_extensions"), "provider_calls": 0, "production_image_verified": False}))
