"""Real-model engineering compatibility; never representative recognition approval.

The immutable original pipeline remains an independent comparator. Only aggregate
errors, task decisions and fixture/source hashes may be written by the report
runner. It never serializes a vector, an image, a template or a credential.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass, field
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import sys
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageOps
import pytest

from pictured_ml_face.models import CandidateEmbedding, MatchRequest, PhotoProcessRequest
from pictured_ml_face.pipeline import FacePipeline


ROOT = Path(__file__).resolve().parents[4]
CONTRACT_FIXTURE = Path(__file__).with_name("openface-engineering-fixtures.json")
FIXTURE_CONTRACT = json.loads(CONTRACT_FIXTURE.read_text())
ENGINE_SPACE = "lovelies-sface-openface-still-v1"
LANDMARKS = ("right_eye", "left_eye", "nose", "mouth_right", "mouth_left")
CORE_FIXTURES = tuple(f"{slot}-{i}" for slot in ("A", "B") for i in range(3)) + (
    "P1", "P2", "P3", "P4",
)
GENERATED_FIXTURES = (
    "no-face", "png", "webp", "exif-right", "mirror", "large-2400", "small-face-2400",
)
ALL_FIXTURES = CORE_FIXTURES + GENERATED_FIXTURES


@dataclass(frozen=True)
class Sample:
    fixture_id: str
    content_type: str
    raw: bytes = field(repr=False)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.raw).hexdigest()


def _jpeg(image: Image.Image, *, quality: int = 93, exif: bytes = b"") -> bytes:
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=quality, exif=exif)
    return output.getvalue()


def sample(fixture_id: str) -> Sample:
    if fixture_id in CORE_FIXTURES:
        if fixture_id[0] in ("A", "B"):
            index = int(fixture_id[-1])
            path = ROOT / FIXTURE_CONTRACT["canonical_assets"][fixture_id[0]]["path"]
            with Image.open(path) as source:
                image = ImageEnhance.Brightness(source.convert("RGB")).enhance(1 + index * 0.025)
                return Sample(fixture_id, "image/jpeg", _jpeg(image, quality=93 - index))
        if fixture_id in ("P1", "P3"):
            value = sample("A-0" if fixture_id == "P1" else "B-0")
            return Sample(fixture_id, value.content_type, value.raw)
        canvas = Image.new("RGB", (1200, 700), "white")
        for slot, position in zip(("A", "B") if fixture_id == "P2" else ("B", "A"), ((150, 180), (800, 180)), strict=True):
            path = ROOT / FIXTURE_CONTRACT["canonical_assets"][slot]["path"]
            with Image.open(path) as source:
                image = source.convert("RGB")
                ratio = 330 / max(image.size)
                image = image.resize(tuple(round(value * ratio) for value in image.size), Image.Resampling.LANCZOS)
                canvas.paste(image, position)
        return Sample(fixture_id, "image/jpeg", _jpeg(canvas))
    if fixture_id == "no-face":
        return Sample(fixture_id, "image/jpeg", _jpeg(Image.new("RGB", (256, 256), "white")))
    with Image.open(io.BytesIO(sample("A-0").raw)) as source:
        image = source.convert("RGB")
    output = io.BytesIO()
    if fixture_id == "png":
        image.save(output, format="PNG")
        return Sample(fixture_id, "image/png", output.getvalue())
    if fixture_id == "webp":
        image.save(output, format="WEBP", quality=93)
        return Sample(fixture_id, "image/webp", output.getvalue())
    if fixture_id == "exif-right":
        exif = Image.Exif()
        exif[274] = 6
        return Sample(fixture_id, "image/jpeg", _jpeg(image.transpose(Image.Transpose.ROTATE_90), exif=exif.tobytes()))
    if fixture_id == "mirror":
        return Sample(fixture_id, "image/jpeg", _jpeg(ImageOps.mirror(image)))
    if fixture_id == "large-2400":
        ratio = 2400 / max(image.size)
        enlarged = image.resize(tuple(round(value * ratio) for value in image.size), Image.Resampling.LANCZOS)
        return Sample(fixture_id, "image/jpeg", _jpeg(enlarged))
    if fixture_id == "small-face-2400":
        canvas = Image.new("RGB", (2400, 1600), "white")
        canvas.paste(image, ((canvas.width - image.width) // 2, (canvas.height - image.height) // 2))
        return Sample(fixture_id, "image/jpeg", _jpeg(canvas))
    raise ValueError("unknown_engineering_fixture")


def real_pipelines() -> tuple[Any, Any]:
    # Model execution is mandatory. No fixture can replace either implementation.
    from lovelies_ml_face.engine import OpenFacePipeline

    previous = os.environ.get("ML_USE_DETERMINISTIC_SIMULATOR")
    os.environ["ML_USE_DETERMINISTIC_SIMULATOR"] = "false"
    try:
        cv2.setNumThreads(1)
        original = FacePipeline(ROOT / "services/ml-face/models/model-manifest.json")
        assert not original.using_deterministic_simulator
        return original, OpenFacePipeline(ROOT / "services/ml-face/models/model-manifest.json")
    finally:
        if previous is None:
            os.environ.pop("ML_USE_DETERMINISTIC_SIMULATOR", None)
        else:
            os.environ["ML_USE_DETERMINISTIC_SIMULATOR"] = previous


@pytest.fixture(scope="module")
def pipelines() -> tuple[Any, Any]:
    engines = real_pipelines()
    try:
        yield engines
    finally:
        engines[1].close()


def run_photo(engine: Any, value: Sample) -> Any:
    request = PhotoProcessRequest(
        event_id="compatibility-engineering", asset_id="fixture", object_key="fixture",
        content_type=value.content_type,
    )
    return engine.process_photo_bytes(request, value.raw)


def _bbox(face: Any) -> np.ndarray:
    return np.array([face.bbox[key] for key in ("x", "y", "width", "height")], dtype=np.float64)


def _landmarks(face: Any) -> np.ndarray:
    return np.array([face.landmarks[key] for key in LANDMARKS], dtype=np.float64)


def parity(original: Any, consumer: Any, value: Sample) -> tuple[dict[str, Any], Any, Any]:
    old, new = run_photo(original, value), run_photo(consumer, value)
    # Geometry fixes pairing independently of detection response order.
    old_faces = sorted(old.faces, key=lambda face: tuple(_bbox(face)))
    new_faces = sorted(new.faces, key=lambda face: tuple(_bbox(face)))
    summary: dict[str, Any] = {
        "fixture_id": value.fixture_id, "sha256": value.sha256,
        "encoded_bytes": len(value.raw), "content_type": value.content_type,
        "original_face_count": len(old_faces), "consumer_face_count": len(new_faces),
        "expected_face_count": FIXTURE_CONTRACT["expected_face_counts"][value.fixture_id],
        "max_box_error_pixels": 0.0, "max_landmark_error_pixels": 0.0,
        "max_confidence_error": 0.0, "max_quality_error": 0.0,
        "max_embedding_absolute_error": 0.0, "max_embedding_cosine_distance": 0.0,
        "max_norm_error": 0.0,
    }
    if len(old_faces) == len(new_faces):
        for left, right in zip(old_faces, new_faces, strict=True):
            a, b = np.asarray(left.embedding, dtype=np.float64), np.asarray(right.embedding, dtype=np.float64)
            assert a.shape == b.shape == (128,)
            assert bool(np.isfinite(a).all() and np.isfinite(b).all())
            summary["max_box_error_pixels"] = max(summary["max_box_error_pixels"], float(np.max(np.abs(_bbox(left) - _bbox(right)))))
            summary["max_landmark_error_pixels"] = max(summary["max_landmark_error_pixels"], float(np.max(np.abs(_landmarks(left) - _landmarks(right)))))
            summary["max_confidence_error"] = max(summary["max_confidence_error"], abs(left.detection_confidence - right.detection_confidence))
            summary["max_quality_error"] = max(summary["max_quality_error"], abs(left.quality_score - right.quality_score))
            summary["max_embedding_absolute_error"] = max(summary["max_embedding_absolute_error"], float(np.max(np.abs(a - b))))
            summary["max_embedding_cosine_distance"] = max(summary["max_embedding_cosine_distance"], float(1 - np.clip(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)), -1, 1)))
            summary["max_norm_error"] = max(summary["max_norm_error"], abs(float(np.linalg.norm(b)) - 1))
            a.fill(0)
            b.fill(0)
    summary["engineering_parity_passed"] = (
        len(old_faces) == len(new_faces) == summary["expected_face_count"]
        and summary["max_box_error_pixels"] <= 0.0001
        and summary["max_landmark_error_pixels"] <= 0.0001
        and summary["max_confidence_error"] <= 0.000001
        and summary["max_quality_error"] <= 0.0001
        and summary["max_embedding_absolute_error"] <= 0.000001
        and summary["max_embedding_cosine_distance"] <= 0.000001
        and summary["max_norm_error"] <= 0.000001
    )
    return summary, old, new


def _distance(left: Any, right: Any) -> float:
    # Freeze current authentication arithmetic; photo distance is separately tested.
    return float(1 - np.clip(np.dot(np.asarray(left, dtype=np.float64), np.asarray(right, dtype=np.float64)), -1, 1))


def task_decisions(engine: Any) -> dict[str, Any]:
    refs = {slot: [run_photo(engine, sample(f"{slot}-{i}")).faces[0].embedding for i in range(3)] for slot in ("A", "B")}
    result: dict[str, Any] = {}
    for slot in ("A", "B"):
        vectors = refs[slot]
        pairwise = [_distance(a, b) for i, a in enumerate(vectors) for b in vectors[i + 1:]]
        other = "B" if slot == "A" else "A"
        fresh = returning_sample(slot)
        fresh_vector = run_photo(engine, fresh).faces[0].embedding
        replacements = replacement_samples(slot)
        replacement_vectors = [run_photo(engine, value).faces[0].embedding for value in replacements]
        result[slot] = {
            "registration_max_pairwise_distance": max(pairwise),
            "registration_accepted": max(pairwise) <= 0.35,
            "returning_capture_sha256": fresh.sha256,
            "returning_best_distance": min(_distance(fresh_vector, vector) for vector in vectors),
            "returning_accepted": min(_distance(fresh_vector, vector) for vector in vectors) <= 0.35,
            "replacement_capture_sha256": [value.sha256 for value in replacements],
            "replacement_accepted": all(min(_distance(value, vector) for vector in vectors) <= 0.35 for value in replacement_vectors),
            "wrong_face_accepted": min(_distance(refs[other][0], vector) for vector in vectors) <= 0.35,
        }
    candidates = [CandidateEmbedding(user_id=slot, face_profile_id=f"profile-{slot}", embedding=vector) for slot in ("A", "B") for vector in refs[slot]]
    photo_decisions = {}
    for fixture_id in ("P1", "P2", "P3", "P4", "no-face"):
        faces = run_photo(engine, sample(fixture_id)).faces
        decisions = []
        for index, face in enumerate(faces):
            decision = engine.match_face(MatchRequest(event_id="compatibility-engineering", detected_face_id=str(index), embedding=face.embedding, candidates=candidates))
            decisions.append({"candidate_fixture": decision.user_id, "numeric_decision": str(decision.numeric_decision.value), "transport_decision": str(decision.decision.value), "score": decision.score, "margin": decision.margin, "threshold": decision.threshold})
        photo_decisions[fixture_id] = sorted(decisions, key=lambda row: str(row["candidate_fixture"]))
    result["photo_decisions"] = photo_decisions
    return result


def capture(value: Sample) -> dict[str, str]:
    return {"mime": value.content_type, "sha256": value.sha256, "bytes_base64": base64.b64encode(value.raw).decode("ascii")}


def returning_sample(slot: str = "A") -> Sample:
    with Image.open(io.BytesIO(sample(f"{slot}-0").raw)) as source:
        image = ImageEnhance.Brightness(source.convert("RGB")).enhance(1.035)
        return Sample(f"returning-{slot}", "image/jpeg", _jpeg(image, quality=89))


def replacement_samples(slot: str = "A") -> list[Sample]:
    output = []
    for index in range(3):
        with Image.open(io.BytesIO(sample(f"{slot}-{index}").raw)) as source:
            image = ImageEnhance.Brightness(source.convert("RGB")).enhance(1.015)
            value = Sample(f"replacement-{slot}-{index}", "image/jpeg", _jpeg(image, quality=91 - index))
        output.append(value)
    return output


def replacement_captures(slot: str = "A") -> list[dict[str, str]]:
    return [capture(value) for value in replacement_samples(slot)]


def test_original_reference_sources_and_model_bytes_are_frozen():
    required = (
        "services/ml-face/src/pictured_ml_face/components.py",
        "services/ml-face/src/pictured_ml_face/pipeline.py",
        "services/ml-face/src/pictured_ml_face/detection_strategy.py",
        "services/ml-face/src/pictured_ml_face/vector_matching.py",
        "services/ml-face/models/face_detection_yunet_2023mar.onnx",
        "services/ml-face/models/face_recognition_sface_2021dec.onnx",
    )
    recorded = {entry["path"]: entry["sha256"] for entry in FIXTURE_CONTRACT["source_bindings"]}
    for path in required:
        assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == recorded[path], path


def test_engineering_three_still_inputs_are_distinct_encodings_of_tracked_sources():
    for entry in FIXTURE_CONTRACT["canonical_assets"].values():
        assert hashlib.sha256((ROOT / entry["path"]).read_bytes()).hexdigest() == entry["sha256"]
    for slot in ("A", "B"):
        enrolled = {sample(f"{slot}-{index}").sha256 for index in range(3)}
        assert len(enrolled) == 3
        assert returning_sample(slot).sha256 not in enrolled
        replacement = {value.sha256 for value in replacement_samples(slot)}
        assert len(replacement) == 3 and not replacement.intersection(enrolled)


@pytest.mark.parametrize("fixture_id", ALL_FIXTURES)
def test_actual_engine_numerical_geometry_quality_parity(pipelines, fixture_id):
    summary, _, _ = parity(*pipelines, sample(fixture_id))
    assert summary["original_face_count"] == FIXTURE_CONTRACT["expected_face_counts"][fixture_id], summary
    assert summary["consumer_face_count"] == FIXTURE_CONTRACT["expected_face_counts"][fixture_id], summary
    assert summary["engineering_parity_passed"], summary


def test_actual_engine_preserves_authentication_and_distinct_identity_photo_decisions(pipelines):
    old, new = (task_decisions(engine) for engine in pipelines)
    for slot in ("A", "B"):
        for key in ("registration_accepted", "returning_accepted", "replacement_accepted", "wrong_face_accepted"):
            assert old[slot][key] == new[slot][key], (slot, key)
        assert new[slot]["registration_accepted"]
        assert new[slot]["returning_accepted"]
        assert new[slot]["replacement_accepted"]
        assert not new[slot]["wrong_face_accepted"]
    for fixture_id, expected in old["photo_decisions"].items():
        actual = new["photo_decisions"][fixture_id]
        assert len(expected) == len(actual), fixture_id
        for left, right in zip(expected, actual, strict=True):
            for key in ("candidate_fixture", "numeric_decision", "transport_decision", "threshold"):
                assert left[key] == right[key], (fixture_id, key)
            assert abs(left["score"] - right["score"]) <= 0.000001
            assert abs(left["margin"] - right["margin"]) <= 0.000001


def test_consumer_creates_v2_reference_and_keeps_registered_authentication_semantics():
    from lovelies_ml_face.app import ENGINE_SPACE as selected_space, FaceJob, face_result

    old = face_result(FaceJob(reference_mode="first_registration", captures=[capture(sample(f"A-{i}")) for i in range(3)]))
    assert old["identity_verified"] and old["enrollment_verified"]
    template = json.loads(base64.b64decode(old["template_base64"], validate=True))
    assert template["protocol"] == "lovelies-face-template-v2"
    assert template["engine_space"] == selected_space == ENGINE_SPACE
    for key in ("engine_artifact_sha256", "processing_fingerprint"):
        assert len(template[key]) == 64
    reference = {"reference_base64": old["template_base64"], "reference_digest": old["template_sha256"]}
    valid = face_result(FaceJob(reference_mode="existing_reference", captures=[capture(returning_sample())], **reference))
    assert valid["identity_verified"] and valid["reference_match"]
    wrong = face_result(FaceJob(reference_mode="existing_reference", captures=[capture(sample("B-0"))], **reference))
    assert wrong["identity_verified"] is False and wrong["reference_match"] is False
    replacement = face_result(FaceJob(reference_mode="replace_reference", captures=replacement_captures(), **reference))
    assert replacement["identity_verified"] and replacement["reference_match"]
    assert replacement["template_sha256"] != old["template_sha256"]
    no_face = face_result(FaceJob(reference_mode="existing_reference", captures=[capture(sample("no-face"))], **reference))
    assert no_face["capture_rejection"] == {"code": "no_face", "capture_index": 0}
    multi = face_result(FaceJob(reference_mode="existing_reference", captures=[capture(sample("P2"))], **reference))
    assert multi["capture_rejection"] == {"code": "multiple_faces", "capture_index": 0}


def test_consumer_rejects_cross_identity_registration_and_replacement():
    from lovelies_ml_face.app import FaceJob, face_result

    mixed = face_result(FaceJob(reference_mode="first_registration", captures=[capture(sample(key)) for key in ("A-0", "A-1", "B-2")]))
    assert mixed["identity_verified"] is False
    assert "template_base64" not in mixed
    old = face_result(FaceJob(reference_mode="first_registration", captures=[capture(sample(f"A-{i}")) for i in range(3)]))
    wrong = face_result(FaceJob(reference_mode="replace_reference", captures=replacement_captures("B"), reference_base64=old["template_base64"], reference_digest=old["template_sha256"]))
    assert wrong["identity_verified"] is False and wrong["reference_match"] is False
    assert "template_base64" not in wrong


def test_actual_multiface_processing_returns_only_supplied_profile_candidates():
    from lovelies_ml_face.app import FaceJob, MODEL, PhotoJob, face_result, photo_result

    profiles = []
    for slot, identifier in (("A", "1"), ("B", "2")):
        enrollment = face_result(FaceJob(reference_mode="first_registration", captures=[capture(sample(f"{slot}-{i}")) for i in range(3)]))
        profiles.append({
            "account_id": f"00000000-0000-4000-8000-{identifier * 12}",
            "profile_id": f"00000000-0000-4000-9000-{identifier * 12}",
            "revision": "engineering-reference-v2", "model_id": MODEL,
            "template_base64": enrollment["template_base64"],
            "template_digest": enrollment["template_sha256"],
        })
    for admitted in (profiles, profiles[:1], []):
        result = photo_result(PhotoJob(asset_id="00000000-0000-4000-a000-333333333333", source=capture(sample("P2")), profiles=admitted))
        assert {row["recipient_id"] for row in result["matches"]} == {profile["account_id"] for profile in admitted}
        assert {row["profile_id"] for row in result["matches"]} == {profile["profile_id"] for profile in admitted}
        assert not any(key in result for key in ("grants", "access_token", "embeddings", "faces"))
        with Image.open(io.BytesIO(base64.b64decode(result["preview"]["bytes_base64"], validate=True))) as preview:
            assert preview.format == "JPEG"
            assert max(preview.size) <= 1600
            assert not preview.getexif()


def test_legacy_template_is_not_relabelled_by_engineering_parity(pipelines):
    from fastapi import HTTPException
    from lovelies_ml_face.app import FaceJob, face_result

    old_vectors = [run_photo(pipelines[0], sample(f"A-{i}")).faces[0].embedding for i in range(3)]
    legacy = {"protocol": "lovelies-face-template-v1", "model_id": "opencv-yunet-sface-2021dec-v1", "embeddings": old_vectors}
    raw = json.dumps(legacy, separators=(",", ":"), sort_keys=True).encode()
    with pytest.raises(HTTPException) as error:
        face_result(FaceJob(reference_mode="existing_reference", captures=[capture(sample("A-1"))], reference_base64=base64.b64encode(raw).decode(), reference_digest=hashlib.sha256(raw).hexdigest()))
    assert error.value.status_code == 409
    assert error.value.detail == "registered_reference_space_incompatible"


def write_report(destination: Path) -> None:
    original, consumer = real_pipelines()
    rows = [parity(original, consumer, sample(fixture_id))[0] for fixture_id in ALL_FIXTURES]
    original_decisions, consumer_decisions = task_decisions(original), task_decisions(consumer)
    identity = consumer.identity
    if hasattr(identity, "model_dump"):
        identity = identity.model_dump()
    report = {
        "scope": "Real-model engineering compatibility only. Supplied screen-reference fixtures and declared derivatives, not representative biometric, optical camera, hosted, device or release acceptance.",
        "contains_raw_images_vectors_templates_or_credentials": False,
        "runtime": {"python": sys.version.split()[0], "platform": platform.platform(), "architecture": platform.machine(), "opencv": cv2.__version__, "numpy": np.__version__},
        "fixture_contract_sha256": hashlib.sha256(CONTRACT_FIXTURE.read_bytes()).hexdigest(),
        "baseline_source_commit": FIXTURE_CONTRACT["baseline_source_commit"],
        "test_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "consumer_source_bindings": {
            relative: hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
            for relative in (
                "services/ml-face/src/lovelies_ml_face/engine.py",
                "services/ml-face/src/lovelies_ml_face/app.py",
                "services/ml-face/src/lovelies_ml_face/service_auth.py",
                "services/ml-face/models/manifest.json",
            )
        },
        "consumer_package_bindings": {
            relative: hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
            for relative in (
                "services/ml-face/vendor/openface_still-0.1.0-py3-none-any.whl",
                "services/ml-face/pyproject.toml",
                "services/ml-face/uv.lock",
            )
        },
        "consumer_identity": identity,
        "fixtures": rows,
        "all_engineering_parity_checks_passed": all(row["engineering_parity_passed"] for row in rows),
        "original_task_decisions": original_decisions,
        "consumer_task_decisions": consumer_decisions,
        "template_policy": {"protocol": "lovelies-face-template-v2", "engine_space": ENGINE_SPACE, "allow_legacy_template_reuse": False, "reason": "Limited engineering agreement does not establish full embedding-space or purpose-specific recognition acceptance."},
        "remaining_acceptance": ["Permissioned representative registration consistency, returning authentication and photo-candidate evaluation on the exact delivered runtime.", "Exact deployment, hosted authority, physical native devices and distribution qualification remain separate."],
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    consumer.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Write sanitized actual-model comparison evidence")
    parser.add_argument("--report", required=True, type=Path)
    arguments = parser.parse_args()
    write_report(arguments.report)
    print(f"Sanitized compatibility report: {arguments.report}")
