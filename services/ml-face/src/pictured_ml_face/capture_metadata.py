"""Allowlisted gallery capture time from real Pillow EXIF, without model inference.

This is optional metadata, not proof of when/where a photo was taken. Image
validation/orientation remains in components.py. No GPS, device, comment, maker
note, thumbnail, raw EXIF, or submitted value is returned or logged here.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from io import BytesIO
import re

from PIL import Image

MAX_CAPTURE_INPUT_BYTES = 20 * 1024 * 1024
MAX_CAPTURE_EXIF_BYTES = 256 * 1024
_EXIF_IFD = 0x8769
# EXIF offsets are paired fields, not an interchangeable list. DateTime lives in
# IFD0; the original/digitized times normally live in its ExifIFD subdirectory.
_TIME_FIELDS = (
    (36867, 36881, "DateTimeOriginal"),
    (36868, 36882, "DateTimeDigitized"),
    (306, 36880, "DateTime"),
)
_DATE = re.compile(r"[0-9]{4}:[0-9]{2}:[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}")
_OFFSET = re.compile(r"[+-][0-9]{2}:[0-9]{2}")


class _InvalidCaptureTime(ValueError):
    pass


def _ascii_field(value: object, limit: int) -> str | None:
    if value is None:
        return None
    # Do not stringify arbitrary EXIF objects or copy unbounded fields.
    if not isinstance(value, (str, bytes)) or len(value) > limit:
        raise _InvalidCaptureTime()
    if isinstance(value, bytes):
        try:
            value = value.decode("ascii")
        except UnicodeDecodeError:
            raise _InvalidCaptureTime() from None
    value = value.strip(" \t\r\n\x00")
    if not value:
        return None
    if not value.isascii():
        raise _InvalidCaptureTime()
    return value


def _select_capture_time(root: Mapping, nested: Mapping) -> dict[str, str]:
    for date_tag, offset_tag, source in _TIME_FIELDS:
        # Keep support for historic flat-layout uploads, but prefer the standard
        # ExifIFD field when both layouts supply the same original/digitized tag.
        fields = nested if date_tag != 306 and date_tag in nested else root
        raw_date = _ascii_field(fields.get(date_tag), 64)
        if raw_date is None:
            continue
        if not _DATE.fullmatch(raw_date):
            raise _InvalidCaptureTime()
        captured = datetime.strptime(raw_date, "%Y:%m:%d %H:%M:%S")
        offset_value = nested.get(offset_tag) if offset_tag in nested else root.get(offset_tag)
        raw_offset = _ascii_field(offset_value, 16)
        if raw_offset is None:
            # Preserve the existing wire/calendar policy, explicitly labelled as
            # an assumption. Never infer a timezone from GPS or the worker host.
            captured = captured.replace(tzinfo=timezone.utc)
            timezone_source = "offset_missing_assumed_utc"
        else:
            # A present malformed offset is not a missing offset. Returning a
            # made-up UTC time could put a photo under the wrong gallery day.
            if not _OFFSET.fullmatch(raw_offset):
                raise _InvalidCaptureTime()
            captured = datetime.strptime(raw_date + raw_offset, "%Y:%m:%d %H:%M:%S%z")
            timezone_source = "exif_offset"
        return {
            "status": "capture_time_extracted",
            "captured_at": captured.isoformat(),
            "source": source,
            "timezone_source": timezone_source,
        }
    return {"status": "unavailable"}


def capture_metadata(image_bytes: bytes) -> dict[str, str]:
    """Read only the chosen time and its own offset while the image is open.

    Malformed preferred timestamps are rejected rather than silently replaced by
    a lower-priority edited/digitized time. Blank/missing timestamps may fall back.
    Oversized metadata or decoder errors yield no date; they do not approve image
    content. The caller must still run the ordinary image/format validation.
    """
    if not isinstance(image_bytes, bytes) or not 0 < len(image_bytes) <= MAX_CAPTURE_INPUT_BYTES:
        return {"status": "unavailable"}
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            raw_exif = image.info.get("exif")
            if isinstance(raw_exif, (bytes, bytearray)) and len(raw_exif) > MAX_CAPTURE_EXIF_BYTES:
                return {"status": "unavailable"}
            exif = image.getexif()
            if not exif:
                return {"status": "unavailable"}
            # Reading nested IFD data may seek in the input; finish before close.
            nested = exif.get_ifd(_EXIF_IFD) if _EXIF_IFD in exif else {}
            if not isinstance(nested, Mapping):
                return {"status": "unavailable"}
            try:
                return _select_capture_time(exif, nested)
            except (ValueError, OverflowError):
                return {"status": "invalid_capture_time"}
    except MemoryError:
        # An allocation failure is not an ordinary absent optional field.
        raise
    except Exception:
        # Optional EXIF is not allowed to turn a separately valid photo into a
        # failed matching job. Do not return/log exception text or raw metadata.
        return {"status": "unavailable"}
