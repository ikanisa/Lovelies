"""Synthetic geometry tests. They do not establish detector/recognizer accuracy."""

import numpy as np
import pytest
from pictured_ml_face.image_contract import FaceDetection
from pictured_ml_face.detection_strategy import (
    PROFILES,
    LANDMARKS,
    DetectionView,
    detect_views,
    plan_views,
    profile_descriptor,
    profile_fingerprint,
    project_detection,
    intersection_over_union,
)


def face(x=10, y=10, w=20, h=20, confidence=0.9):
    return FaceDetection(
        {"x": x, "y": y, "width": w, "height": h},
        {k: [x + w / 2, y + h / 2] for k in LANDMARKS},
        confidence,
    )


@pytest.mark.parametrize(
    "shape", [(1, 1), (4000, 3000), (3000, 4000), (8000, 5000), (5000, 8000), (500, 900), (5000, 1)]
)
@pytest.mark.parametrize("profile", PROFILES)
def test_plans_are_bounded_and_cover_original(shape, profile):
    w, h = shape
    views = plan_views(w, h, profile)
    assert views[0].x == views[0].y == 0
    assert (views[0].width, views[0].height) == shape
    assert len(views) <= 5
    for v in views:
        assert 0 <= v.x and v.x + v.width <= w and 0 <= v.y and v.y + v.height <= h
        assert v.target_width <= v.width and v.target_height <= v.height
    if profile != "reference-v1":
        assert max(views[0].target_width, views[0].target_height) <= 1280
        assert sum(v.pixels for v in views) <= 1280**2 + 4 * 960**2
    if len(views) > 1:
        tiles = views[1:]
        # Sample interior and edge points: tiles cover image, not just corners.
        for x in [0, w // 4, w // 2, 3 * w // 4, w - 1]:
            for y in [0, h // 4, h // 2, 3 * h // 4, h - 1]:
                assert any(v.x <= x < v.x + v.width and v.y <= y < v.y + v.height for v in tiles)


@pytest.mark.parametrize("shape", [(0, 10), (-1, 10), (True, 10), (1.0, 10), (8001, 5000)])
def test_bad_dimensions_are_rejected(shape):
    with pytest.raises(ValueError):
        plan_views(*shape, "group-v1")


@pytest.mark.parametrize("value", [None, True, {}, "group", "group-v1 ", "GROUP-V1"])
def test_unrecognized_profiles_do_not_silently_fallback(value):
    with pytest.raises(ValueError):
        plan_views(100, 100, value)


def test_exact_coordinate_projection_for_nonuniform_integer_resize():
    v = DetectionView(100, 50, 600, 301, 300, 150)
    actual = project_detection(face(), v, 1000, 800)
    assert actual.bbox == {"x": 120, "y": 70, "width": 40, "height": 41}
    assert actual.landmarks["nose"] == pytest.approx([140, 50 + 20 * 301 / 150])


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), True, "10", None])
def test_invalid_landmarks_rejected(bad):
    f = face()
    f.landmarks["nose"][0] = bad
    assert project_detection(f, DetectionView(0, 0, 100, 100, 100, 100), 100, 100) is None


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), True, "10", None])
def test_invalid_box_values_rejected(bad):
    f = face()
    f.bbox["width"] = bad
    assert project_detection(f, DetectionView(0, 0, 100, 100, 100, 100), 100, 100) is None


def test_malformed_objects_and_off_image_candidates_rejected():
    v = DetectionView(0, 0, 100, 100, 100, 100)
    assert project_detection(None, v, 100, 100) is None
    assert project_detection(face(x=150), v, 100, 100) is None
    assert project_detection(face(w=0), v, 100, 100) is None
    assert project_detection(face(confidence=2), v, 100, 100) is None


def test_reference_passes_original_pixels_and_preserves_order():
    image = np.full((80, 100, 3), 71, dtype=np.uint8)
    rows = [face(40), face(10)]

    def detector(pixels):
        assert pixels is image
        return rows

    batch = detect_views(image, "reference-v1", detector)
    assert batch.faces == rows and batch.views_executed == 1 and batch.detector_input_pixels == 8000
    assert np.all(image == 71)


def test_overlapping_views_deduplicate_same_original_face():
    image = np.full((1500, 2000, 3), 73, dtype=np.uint8)
    original = face(900, 700, 100, 100)
    views = plan_views(2000, 1500, "group-v1")
    calls = []
    buffers = []

    def detector(pixels):
        v = views[len(calls)]
        calls.append(v)
        buffers.append(pixels)
        sx, sy = v.target_width / v.width, v.target_height / v.height
        b = original.bbox
        f = FaceDetection(
            {
                "x": (b["x"] - v.x) * sx,
                "y": (b["y"] - v.y) * sy,
                "width": b["width"] * sx,
                "height": b["height"] * sy,
            },
            {k: [(p[0] - v.x) * sx, (p[1] - v.y) * sy] for k, p in original.landmarks.items()},
            0.9,
        )
        return [f]

    result = detect_views(image, "group-v1", detector)
    assert len(calls) == 5 and len(result.faces) == 1 and result.duplicates_suppressed == 4
    assert result.candidates_seen == 5 and np.all(image == 73)
    assert all(np.count_nonzero(b) == 0 for b in buffers)  # bounded owned buffers cleaned


def test_different_faces_survive_suppression_and_order_is_deterministic():
    image = np.full((100, 100, 3), 31, dtype=np.uint8)
    a, b = face(10), face(60)
    first = detect_views(image, "bounded-v1", lambda _: [b, a])
    second = detect_views(image, "bounded-v1", lambda _: [a, b])
    assert first.faces == second.faces == [a, b]
    assert intersection_over_union(a, b) == 0
    assert intersection_over_union(a, a) == 1
    assert np.all(image == 31)


def test_candidate_output_is_bounded_before_merging():
    with pytest.raises(ValueError, match="bounded candidate"):
        detect_views(
            np.zeros((100, 100, 3), dtype=np.uint8), "bounded-v1", lambda _: [face()] * 101
        )


@pytest.mark.parametrize(
    "image",
    [
        np.zeros((10, 10), dtype=np.uint8),
        np.zeros((10, 10, 4), dtype=np.uint8),
        np.zeros((10, 10, 3)),
        None,
    ],
)
def test_invalid_image_tensors_rejected(image):
    with pytest.raises(ValueError):
        detect_views(image, "group-v1", lambda _: [])


def test_profile_fingerprint_is_stable_and_distinct():
    hashes = [profile_fingerprint(p) for p in PROFILES]
    assert len(set(hashes)) == 3 and all(len(h) == 64 for h in hashes)
    assert hashes == [profile_fingerprint(p) for p in PROFILES]
    assert profile_descriptor("group-v1")["alignment_source"] == "original-upright-pixels"


def test_failure_clears_owned_resized_pixels_without_mutating_original():
    image = np.full((1500, 2000, 3), 111, dtype=np.uint8)
    buffers = []

    def fail(pixels):
        buffers.append(pixels)
        raise RuntimeError("fatal engine failure")

    with pytest.raises(RuntimeError):
        detect_views(image, "group-v1", fail)
    assert np.count_nonzero(buffers[0]) == 0 and np.all(image == 111)


def test_image_contract_import_does_not_initialize_heif_or_opencv():
    import subprocess
    import sys

    code = """import sys
from pictured_ml_face.image_contract import FaceDetection, AlignedFace, MAX_FACES_PER_IMAGE
assert MAX_FACES_PER_IMAGE == 100
assert not {'cv2','pillow_heif','pictured_ml_face.components','pictured_ml_face.pipeline'} & set(sys.modules)
"""
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_legacy_component_reexports_use_the_same_image_contract_types():
    import ast
    from pathlib import Path

    tree = ast.parse((Path(__file__).parents[1] / "src/pictured_ml_face/components.py").read_text())
    imported = {
        name.name
        for node in tree.body
        if isinstance(node, ast.ImportFrom) and node.module == "pictured_ml_face.image_contract"
        for name in node.names
    }
    assert {
        "FaceDetection",
        "AlignedFace",
        "ImageValidationError",
        "MAX_FACES_PER_IMAGE",
    } <= imported
    assert not any(
        isinstance(n, ast.ClassDef) and n.name in {"FaceDetection", "AlignedFace"}
        for n in tree.body
    )
