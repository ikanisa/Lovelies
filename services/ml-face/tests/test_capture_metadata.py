"""Real encoded synthetic images; no HEIF shim, model weights or identity data."""

from __future__ import annotations

import ast
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from PIL import Image
import pytest

from pictured_ml_face import capture_metadata as metadata

TIME = "2024:03:15 10:20:30"
ISO = "2024-03-15T10:20:30"


def encoded(root=None, nested=None, fmt="JPEG"):
    exif = Image.Exif()
    for tag, value in (root or {}).items():
        exif[tag] = value
    if nested is not None:
        exif[34665] = nested
    out = BytesIO()
    Image.new("RGB", (6, 4), color=(60, 100, 140)).save(out, format=fmt, exif=exif)
    return out.getvalue()


def expected(source="DateTimeOriginal", offset="+02:00", explicit=True):
    return {
        "status": "capture_time_extracted",
        "captured_at": ISO + offset,
        "source": source,
        "timezone_source": "exif_offset" if explicit else "offset_missing_assumed_utc",
    }


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
@pytest.mark.parametrize(
    "date_tag,offset_tag,source",
    [(36867, 36881, "DateTimeOriginal"), (36868, 36882, "DateTimeDigitized")],
)
def test_actual_nested_ifd_capture_time(fmt, date_tag, offset_tag, source):
    data = encoded(nested={date_tag: TIME, offset_tag: "+02:00"}, fmt=fmt)
    assert metadata.capture_metadata(data) == expected(source)


@pytest.mark.parametrize(
    "date_tag,offset_tag,source",
    [
        (36867, 36881, "DateTimeOriginal"),
        (36868, 36882, "DateTimeDigitized"),
        (306, 36880, "DateTime"),
    ],
)
def test_flat_legacy_layout_is_supported_and_correctly_labelled(date_tag, offset_tag, source):
    assert metadata.capture_metadata(encoded({date_tag: TIME, offset_tag: "+02:00"})) == expected(
        source
    )


def test_nested_original_beats_flat_original_and_edited_time():
    data = encoded(
        {36867: "2020:01:01 00:00:00", 306: "2025:01:01 00:00:00"}, {36867: TIME, 36881: "+02:00"}
    )
    assert metadata.capture_metadata(data) == expected()


def test_capture_time_beats_digitized_and_edited_time():
    data = encoded(
        {306: "2025:01:01 00:00:00"},
        {36867: TIME, 36881: "+02:00", 36868: "2025:02:02 00:00:00", 36882: "-06:00"},
    )
    assert metadata.capture_metadata(data) == expected()


@pytest.mark.parametrize(
    "date_tag,offset_tag,source",
    [
        (36867, 36881, "DateTimeOriginal"),
        (36868, 36882, "DateTimeDigitized"),
        (306, 36880, "DateTime"),
    ],
)
def test_each_date_uses_only_its_corresponding_offset(date_tag, offset_tag, source):
    root = {date_tag: TIME, 36880: "-05:00", 36881: "+02:00", 36882: "+09:00"}
    assert metadata.capture_metadata(encoded(root)) == expected(source, root[offset_tag])


def test_root_modification_time_uses_offset_from_nested_ifd():
    data = encoded({306: TIME}, {36880: "-05:00", 36881: "+02:00"})
    assert metadata.capture_metadata(data) == expected("DateTime", "-05:00")


def test_unrelated_offset_is_not_borrowed_for_original():
    assert metadata.capture_metadata(encoded(nested={36867: TIME, 36882: "+09:00"})) == expected(
        offset="+00:00", explicit=False
    )


@pytest.mark.parametrize("offset", [None, "", "   "])
def test_missing_or_blank_offset_preserves_explicit_utc_assumption(offset):
    nested = {36867: TIME}
    if offset is not None:
        nested[36881] = offset
    assert metadata.capture_metadata(encoded(nested=nested)) == expected(
        offset="+00:00", explicit=False
    )


@pytest.mark.parametrize("offset", ["+00:00", "-00:00", "+14:00", "-12:00", "+05:45"])
def test_valid_offsets_are_preserved_without_host_timezone(offset):
    wanted = "+00:00" if offset == "-00:00" else offset
    assert metadata.capture_metadata(encoded(nested={36867: TIME, 36881: offset})) == expected(
        offset=wanted
    )


@pytest.mark.parametrize("offset", ["Z", "+0200", "+24:00", "+02:60", "UTC", "NaN", "x" * 17])
def test_present_invalid_offset_is_not_fabricated_as_utc(offset):
    assert metadata.capture_metadata(encoded(nested={36867: TIME, 36881: offset})) == {
        "status": "invalid_capture_time"
    }


@pytest.mark.parametrize(
    "value",
    [
        "2024:02:30 10:20:30",
        "0000:01:01 00:00:00",
        "2024:03:15 24:00:00",
        "2024:3:15 10:20:30",
        "2024-03-15 10:20:30",
        "not-a-date",
        "x" * 65,
    ],
)
def test_invalid_original_is_not_replaced_by_edit_time(value):
    data = encoded({306: TIME}, {36867: value})
    assert metadata.capture_metadata(data) == {"status": "invalid_capture_time"}


def test_blank_original_can_fall_back_to_digitized():
    data = encoded(nested={36867: "  ", 36868: TIME, 36882: "+02:00"})
    assert metadata.capture_metadata(data) == expected("DateTimeDigitized")


def test_leap_day_is_valid():
    result = metadata.capture_metadata(encoded(nested={36867: "2024:02:29 12:00:00"}))
    assert result["captured_at"] == "2024-02-29T12:00:00+00:00"


def test_private_device_comments_and_maker_note_never_returned():
    data = encoded(
        {
            271: "PRIVATE_MAKER",
            272: "PRIVATE_DEVICE",
            315: "PRIVATE_AUTHOR",
            270: "PRIVATE_COMMENT",
            34853: {0: b"\x02\x03\x00\x00", 1: "N", 2: (1, 2, 3)},
        },
        {
            36867: TIME,
            36881: "+02:00",
            37500: b"PRIVATE_MAKER_NOTE",
            37510: b"PRIVATE_USER_COMMENT",
        },
    )
    value = metadata.capture_metadata(data)
    assert value == expected()
    assert "PRIVATE_" not in json.dumps(value)
    assert set(value) == {"status", "captured_at", "source", "timezone_source"}


@pytest.mark.parametrize("data", [b"", b"not-an-image", None, [], "not-image-bytes"])
def test_unreadable_and_invalid_inputs_have_no_metadata(data):
    assert metadata.capture_metadata(data) == {"status": "unavailable"}


def test_missing_exif_is_unavailable():
    assert metadata.capture_metadata(encoded()) == {"status": "unavailable"}


def test_non_time_exif_is_unavailable():
    assert metadata.capture_metadata(encoded({271: "PRIVATE_MAKER"})) == {"status": "unavailable"}


def test_input_cap_is_checked_before_opening():
    with (
        patch.object(metadata, "MAX_CAPTURE_INPUT_BYTES", 2),
        patch.object(metadata.Image, "open") as opening,
    ):
        assert metadata.capture_metadata(b"abc") == {"status": "unavailable"}
        opening.assert_not_called()


def test_exif_cap_returns_no_date_without_changing_global_limits():
    before = Image.MAX_IMAGE_PIXELS
    data = encoded(nested={36867: TIME, 36881: "+02:00"})
    with patch.object(metadata, "MAX_CAPTURE_EXIF_BYTES", 1):
        assert metadata.capture_metadata(data) == {"status": "unavailable"}
    assert Image.MAX_IMAGE_PIXELS == before


@pytest.mark.parametrize(
    "error",
    [OSError("PRIVATE_CONTENT"), SyntaxError("PRIVATE_CONTENT"), ValueError("PRIVATE_CONTENT")],
)
def test_optional_parser_error_does_not_escape_or_expose_details(error, caplog):
    with patch.object(metadata.Image, "open", side_effect=error):
        assert metadata.capture_metadata(b"abc") == {"status": "unavailable"}
    assert "PRIVATE_CONTENT" not in caplog.text


def test_allocation_failure_not_misrepresented_as_absent_metadata():
    with patch.object(metadata.Image, "open", side_effect=MemoryError):
        with pytest.raises(MemoryError):
            metadata.capture_metadata(b"abc")


@pytest.mark.parametrize(
    "value", [True, 123, ["2024:03:15 10:20:30"], object(), b"\xff", "é", "x" * 65]
)
def test_field_parser_rejects_coercion_and_unbounded_values(value):
    with pytest.raises(ValueError):
        metadata._select_capture_time({36867: value}, {})


def test_null_terminated_ascii_fields_are_supported():
    assert (
        metadata._select_capture_time({36867: TIME.encode() + b"\0", 36881: b"+02:00\0"}, {})
        == expected()
    )


def test_pipeline_imports_the_production_helper_without_duplicate_parser():
    # Wiring assertion only; does not import the codec/model-dependent pipeline.
    source = Path(__file__).parents[1] / "src/pictured_ml_face/pipeline.py"
    tree = ast.parse(source.read_text())
    assert any(
        isinstance(n, ast.ImportFrom)
        and n.module == "pictured_ml_face.capture_metadata"
        and any(a.name == "capture_metadata" and a.asname == "_capture_metadata" for a in n.names)
        for n in tree.body
    )
    assert not any(
        isinstance(n, ast.FunctionDef) and n.name == "_capture_metadata" for n in tree.body
    )


def test_helper_import_does_not_load_recognizer_or_heif_shim():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from pictured_ml_face.capture_metadata import capture_metadata; import sys; "
            "assert all(x not in sys.modules for x in ('cv2','pillow_heif','pictured_ml_face.pipeline')); "
            "assert capture_metadata(b'') == {'status':'unavailable'}",
        ],
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr.decode()
