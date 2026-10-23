"""Unsupported native/container parsers must never receive contributed bytes."""

from io import BytesIO

from PIL import Image
import pytest

from pictured_ml_face.components import decode_image, decode_validated_image
from pictured_ml_face.image_contract import ImageValidationError


@pytest.mark.parametrize("validator", [False, True])
def test_unapproved_registered_parser_is_never_invoked(monkeypatch, validator):
    Image.init()
    calls = []

    def forbidden_parser(*args):
        calls.append(args)
        raise AssertionError("An excluded parser received contributed bytes")

    monkeypatch.setattr(Image, "ID", [*Image.ID, "QA_EXCLUDED_NATIVE"])
    monkeypatch.setitem(Image.OPEN, "QA_EXCLUDED_NATIVE", (forbidden_parser, lambda _: True))
    with pytest.raises(ImageValidationError):
        if validator:
            decode_validated_image(b"QA-unsupported-container", "image/png")
        else:
            decode_image(b"QA-unsupported-container")
    assert calls == []


@pytest.mark.parametrize("format_name", ["TIFF", "BMP", "GIF"])
@pytest.mark.parametrize("validator", [False, True])
def test_unsupported_actual_image_formats_are_rejected(format_name, validator):
    output = BytesIO()
    Image.new("RGB", (8, 8), "white").save(output, format=format_name)
    with pytest.raises(ImageValidationError):
        if validator:
            decode_validated_image(output.getvalue(), "image/png")
        else:
            decode_image(output.getvalue())
