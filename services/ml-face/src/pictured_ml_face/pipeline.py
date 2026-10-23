from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path

import numpy as np
from pydantic import ValidationError

from pictured_ml_face.components import (
    CosineVectorMatcher,
    DeterministicEmbeddingModel,
    DeterministicFaceDetector,
    HashQualityScorer,
    LandmarkFaceAligner,
    MAX_FACES_PER_IMAGE,
    OpenCvQualityScorer,
    OpenCvSFaceAligner,
    OpenCvSFaceEmbeddingModel,
    OpenCvYuNetDetector,
    ThresholdDecisionEngine,
    decode_image,
    decode_validated_image,
    normalize,
)
from pictured_ml_face.models import (
    DetectedFace,
    ImageQualityProfile,
    MatchRequest,
    MatchResult,
    ModelManifest,
    PhotoProcessRequest,
    PhotoProcessResponse,
)

from pictured_ml_face.image_analysis import (
    image_diagnostics,
    IMAGE_ANALYSIS_VERSION,
    PROCESSING_CONTRACT_VERSION,
)

from pictured_ml_face.vector_matching import rank_face_candidates
from pictured_ml_face.capture_metadata import capture_metadata as _capture_metadata
from pictured_ml_face.evaluation_policy import validate_evaluation_report
from pictured_ml_face.model_integrity import (
    ModelPolicyError as ModelPolicyError,
    load_manifest_object,
    load_verified_evaluation_bytes,
    parse_json_object,
    read_bounded_file,
    select_active_model,
    verified_model_paths,
)
from pictured_ml_face.evaluation_contract import (
    REPORT_LIMIT,
    approval_metadata,
    sha256,
)
from pictured_ml_face.detection_strategy import (
    REFERENCE_PROFILE,
    detect_views,
    profile_fingerprint,
    validate_profile,
)
from pictured_ml_face.processing_metrics import ProcessingMetrics
from pictured_ml_face.processing_observation import trace_from_diagnostics

PROHIBITED_CATEGORIES = ["emotion", "age", "gender", "ethnicity", "demographic"]
PHOTO_SIMILARITY_THRESHOLD = 0.80
PHOTO_DUPLICATE_THRESHOLD = 0.95


def normalize_perceptual_hash(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if len(normalized) < 8 or len(normalized) > 128:
        return None
    if any(character not in "0123456789abcdef" for character in normalized):
        return None
    return normalized


def perceptual_hash_similarity(left: str | None, right: str | None) -> float | None:
    left_hash = normalize_perceptual_hash(left)
    right_hash = normalize_perceptual_hash(right)
    if not left_hash or not right_hash or len(left_hash) != len(right_hash):
        return None
    hamming_distance = sum(
        (int(left_digit, 16) ^ int(right_digit, 16)).bit_count()
        for left_digit, right_digit in zip(left_hash, right_hash, strict=True)
    )
    return 1.0 - hamming_distance / (len(left_hash) * 4)


def is_similar_photo(
    left: str | None,
    right: str | None,
    threshold: float = PHOTO_SIMILARITY_THRESHOLD,
) -> bool:
    similarity = perceptual_hash_similarity(left, right)
    return similarity is not None and similarity >= threshold


def strongest_duplicate_candidate(
    perceptual_hash: str | None,
    candidates: list[dict[str, str | None]],
    threshold: float = PHOTO_SIMILARITY_THRESHOLD,
) -> dict[str, object] | None:
    strongest: dict[str, object] | None = None
    for candidate in candidates:
        similarity = perceptual_hash_similarity(perceptual_hash, candidate.get("perceptual_hash"))
        if similarity is None or similarity < threshold:
            continue
        if strongest is None or similarity > float(strongest["similarity"]):
            strongest = {
                "asset_id": candidate.get("asset_id"),
                "perceptual_hash": candidate.get("perceptual_hash"),
                "similarity": round(similarity, 4),
                "policy": "perceptual_hash_hamming_similarity_v1",
                "threshold": threshold,
                "disposition": "review_similarity",
                "exact_duplicate_proven": False,
            }
    return strongest


class FacePipeline:
    def __init__(self, manifest_path: str | Path, *, detection_profile: str | None = None) -> None:
        self.manifest_path = Path(manifest_path)
        self.model_root = self.manifest_path.parent
        self.manifest = self._load_manifest()
        self.active_model = self._active_model()
        self.deployment_mode = os.getenv("ML_DEPLOYMENT_MODE", "development").strip().lower()
        self.evaluation_status = "not_required"
        self.artifact_integrity = "not_verified"
        self._verified_artifact_paths: dict[str, Path] = {}
        self.approved_decision_policy: dict[str, float] | None = None
        self.evaluation_report_digest: str | None = None
        try:
            self.detection_profile = validate_profile(
                detection_profile
                if detection_profile is not None
                else os.getenv("ML_DETECTION_PROFILE", REFERENCE_PROFILE)
            )
        except ValueError as error:
            raise ModelPolicyError("ML detection profile configuration is invalid") from error
        self._enforce_model_policy()
        runtime = str(self.active_model.get("runtime", "unknown"))
        simulator_requested = os.getenv("ML_USE_DETERMINISTIC_SIMULATOR", "").lower() == "true"
        production = (
            os.getenv("APP_ENV") == "production" or os.getenv("CLOUDFLARE_ENV") == "production"
        )
        if (simulator_requested or runtime == "local-deterministic-simulator") and production:
            raise ModelPolicyError("The deterministic face simulator is forbidden in production")
        self._enforce_production_evidence()
        if (simulator_requested or runtime == "local-deterministic-simulator") and (
            self.artifact_integrity == "verified"
        ):
            raise ModelPolicyError(
                "The deterministic face simulator is forbidden with verified artifacts"
            )
        if self.detection_profile != REFERENCE_PROFILE and self.evaluation_status == "approved":
            raise ModelPolicyError(
                "Candidate detection profiles cannot reuse reference release approval"
            )
        self.using_deterministic_simulator = (
            runtime == "local-deterministic-simulator" or simulator_requested
        )
        if self.using_deterministic_simulator and self.evaluation_status == "approved":
            raise ModelPolicyError("Approved evaluation cannot qualify simulator output")
        if self.using_deterministic_simulator:
            self.detector = DeterministicFaceDetector()
            self.aligner = LandmarkFaceAligner()
            self.quality_scorer = HashQualityScorer()
            self.embedding_model = DeterministicEmbeddingModel()
        else:
            detector_path = self._verified_artifact_paths.get(
                "detector_path"
            ) or self._resolve_model_path(str(self.active_model["detector_path"]))
            recognizer_path = self._verified_artifact_paths.get(
                "recognizer_path"
            ) or self._resolve_model_path(str(self.active_model["recognizer_path"]))
            self.detector = OpenCvYuNetDetector(detector_path)
            self.aligner = OpenCvSFaceAligner(recognizer_path)
            self.quality_scorer = OpenCvQualityScorer()
            self.embedding_model = OpenCvSFaceEmbeddingModel(recognizer_path)
        self.vector_matcher = CosineVectorMatcher()
        self.decision_engine = ThresholdDecisionEngine()

    def process_photo(self, request: PhotoProcessRequest) -> PhotoProcessResponse:
        image_bytes = self._image_bytes(request)
        return self.process_photo_bytes(request, image_bytes)

    def process_photo_bytes(
        self, request: PhotoProcessRequest, image_bytes: bytes
    ) -> PhotoProcessResponse:
        metrics = ProcessingMetrics()
        decoded = None
        try:
            with metrics.stage("decode"):
                decoded, geometry = decode_validated_image(image_bytes, request.content_type)
            faces = self._process_faces(image_bytes, request, decoded, metrics=metrics)
            with metrics.stage("metadata"):
                metadata = self._image_metadata(image_bytes, request)
                metadata["geometry"] = {
                    **geometry,
                    "coordinate_space": "pixels",
                    "orientation": "upright",
                }
                metadata["evaluation_status"] = (
                    self.evaluation_status
                    if self.detection_profile == REFERENCE_PROFILE
                    else "optimization_candidate"
                )
            with metrics.stage("image_quality"):
                quality = self._image_quality_profile(image_bytes, faces, decoded)
            metadata["processing_diagnostics"] = metrics.report(
                self.detection_profile, synthetic=self.using_deterministic_simulator
            )
            return PhotoProcessResponse(
                event_id=request.event_id,
                asset_id=request.asset_id,
                status="processed" if faces else "no_faces",
                faces=faces,
                prohibited_categories=[],
                image_metadata=metadata,
                image_quality=quality,
                duplicate_of_asset_id=None,
                processing_version=self.processing_version,
                processing_trace=trace_from_diagnostics(metadata["processing_diagnostics"]),
            )
        finally:
            # Best-effort cleanup of this request's owned decode; not an erasure
            # guarantee for Pillow/OpenCV/framework/allocator copies.
            if decoded is not None:
                decoded.fill(0)

    def match_face(self, request: MatchRequest) -> MatchResult:
        return rank_face_candidates(
            request,
            default_threshold=self.active_model.get("default_threshold", 0.42),
            default_review_margin=self.active_model.get("review_margin", 0.05),
            matcher=self.vector_matcher,
            decision_engine=self.decision_engine,
        )

    def _load_manifest(self) -> ModelManifest:
        try:
            return ModelManifest.model_validate(load_manifest_object(self.manifest_path))
        except ValidationError:
            raise ModelPolicyError("ML model manifest schema is invalid") from None

    def _active_model(self) -> dict[str, object]:
        return select_active_model(self.manifest.model_dump())

    def _enforce_model_policy(self) -> None:
        active_text = json.dumps(self.active_model).lower()
        if "insightface" in active_text:
            raise ModelPolicyError(
                "InsightFace pretrained packs are not part of the Lovelies runtime"
            )
        if "license_metadata" not in self.active_model:
            raise ModelPolicyError("Active model is missing source license metadata")
        if not self.active_model.get("checksum_sha256"):
            raise ModelPolicyError("Active model is missing registry checksum")
        for category in PROHIBITED_CATEGORIES:
            if category in str(self.active_model.get("capabilities", "")).lower():
                raise ModelPolicyError(
                    f"Prohibited biometric categorization configured: {category}"
                )

    def _enforce_production_evidence(self) -> None:
        # Startup verification only, not hot reload. An explicit failed recheck
        # cannot retain previously approved policy or integrity labels.
        self.artifact_integrity = "not_verified"
        self._verified_artifact_paths = {}
        self.evaluation_status = "not_required"
        self.approved_decision_policy = None
        self.evaluation_report_digest = None
        production = (
            os.getenv("APP_ENV") == "production"
            or os.getenv("CLOUDFLARE_ENV") == "production"
            or os.getenv("ML_REQUIRE_MODEL_ARTIFACTS") == "true"
        )
        evidence = self.manifest.production_evidence
        if not production:
            return
        paths = verified_model_paths(self.active_model, self._resolve_model_path)
        self._verified_artifact_paths = paths
        self.artifact_integrity = "verified"
        if self.deployment_mode == "monitored_pilot":
            self.evaluation_status = "monitored_pilot"
            return
        required_report = os.getenv("ML_EVALUATION_REPORT_PATH") or evidence.get(
            "evaluation_report_path"
        )
        if not required_report:
            raise ModelPolicyError("Production ML requires an evaluation_report_path")
        report_path = self._resolve_model_path(str(required_report))
        raw = load_verified_evaluation_bytes(report_path, maximum=REPORT_LIMIT)
        self._enforce_evaluation_report(report_path, raw_bytes=raw)
        self.evaluation_status = "approved"

    def _enforce_evaluation_report(
        self, report_path: Path, *, raw_bytes: bytes | None = None
    ) -> None:
        # Hash/parse the same bounded, duplicate-free bytes. A colocated checksum
        # identifies bytes; it is NOT reviewer authentication or a signature.
        self.approved_decision_policy = None
        self.evaluation_report_digest = None
        raw = (
            raw_bytes
            if raw_bytes is not None
            else read_bounded_file(report_path, REPORT_LIMIT, "Production ML evaluation report")
        )
        report = parse_json_object(raw, "Production ML evaluation report")
        policy = validate_evaluation_report(
            report, self.active_model, self.manifest.production_evidence
        )
        digest = sha256(raw)
        self.approved_decision_policy = policy
        self.evaluation_report_digest = digest

    def _embedding_for_runtime(self, image_bytes: bytes, event_id: str) -> np.ndarray:
        if self.using_deterministic_simulator:
            return self._deterministic_embedding(image_bytes, event_id)
        detections = self.detector.detect(image_bytes)
        if not detections:
            raise ValueError("No face was detected for embedding")
        aligned = self.aligner.align(image_bytes, detections[0])
        return self.embedding_model.embed(aligned, event_id)

    def _image_bytes(self, request: PhotoProcessRequest) -> bytes:
        if request.image_b64:
            return base64.b64decode(request.image_b64)
        return f"{request.event_id}:{request.asset_id}:{request.object_key}".encode()

    def _deterministic_embedding(self, image_bytes: bytes, event_id: str) -> np.ndarray:
        seed = hashlib.sha512(event_id.encode() + b":" + image_bytes).digest()
        values = np.frombuffer(seed * 2, dtype=np.uint8)[:128].astype(np.float32)
        vector = (values / 255.0) - 0.5
        return self._normalize(vector)

    def _quality_score(self, image_bytes: bytes) -> float:
        digest = hashlib.sha256(image_bytes).digest()
        return round(0.72 + (digest[0] / 255.0) * 0.2, 4)

    def _process_faces(
        self,
        image_bytes: bytes,
        request: PhotoProcessRequest,
        decoded_image: np.ndarray | None = None,
        *,
        metrics: ProcessingMetrics | None = None,
    ) -> list[DetectedFace]:
        metrics = metrics if metrics is not None else ProcessingMetrics()
        faces: list[DetectedFace] = []
        if decoded_image is None and not self.using_deterministic_simulator:
            decoded_image = decode_image(image_bytes)
        with metrics.stage("detect"):
            if decoded_image is not None and isinstance(self.detector, OpenCvYuNetDetector):
                batch = detect_views(
                    decoded_image, self.detection_profile, self.detector.detect_decoded
                )
                detections = batch.faces
                for key in (
                    "views_executed",
                    "detector_input_pixels",
                    "candidates_seen",
                    "invalid_candidates",
                    "duplicates_suppressed",
                ):
                    metrics.count(key, getattr(batch, key))
                metrics.face_limit_reached = batch.face_limit_reached
            else:
                detections = self.detector.detect(image_bytes)[:MAX_FACES_PER_IMAGE]
                metrics.count("views_executed")
                metrics.count("candidates_seen", len(detections))
        metrics.count("detections", len(detections))
        for index, detection in enumerate(detections):
            aligned = None
            try:
                try:
                    with metrics.stage("align"):
                        aligned = (
                            self.aligner.align_decoded(decoded_image, detection)
                            if decoded_image is not None
                            and isinstance(self.aligner, OpenCvSFaceAligner)
                            else self.aligner.align(image_bytes, detection)
                        )
                except ValueError:
                    metrics.count("alignment_rejections")
                    continue
                try:
                    with metrics.stage("embed"):
                        embedding = self.embedding_model.embed(aligned, request.event_id)
                except ValueError:
                    # Invalid output for one face does not discard other valid
                    # faces. Fatal runtime/codec/system errors are NOT swallowed.
                    metrics.count("embedding_rejections")
                    continue
                with metrics.stage("face_quality"):
                    quality = self.quality_scorer.score(image_bytes, aligned)
                candidate = self.detection_profile != REFERENCE_PROFILE
                modules = {
                    **self.module_versions,
                    **(
                        {}
                        if candidate
                        else approval_metadata(
                            self.active_model,
                            self.approved_decision_policy,
                            self.evaluation_report_digest,
                            self.evaluation_status,
                        )
                    ),
                    "recognition_provider": "local_opencv_yunet_sface",
                    "external_recognition_api": "disabled",
                    "evaluation_status": "optimization_candidate"
                    if candidate
                    else self.evaluation_status,
                    "geometry_contract": "upright-pixels-v1",
                    "processing_contract_version": PROCESSING_CONTRACT_VERSION,
                    "detection_profile": self.detection_profile,
                    "detection_profile_sha256": profile_fingerprint(self.detection_profile),
                }
                faces.append(
                    DetectedFace(
                        bbox=detection.bbox,
                        image_width=int(decoded_image.shape[1])
                        if decoded_image is not None
                        else None,
                        image_height=int(decoded_image.shape[0])
                        if decoded_image is not None
                        else None,
                        landmarks=detection.landmarks,
                        detection_confidence=detection.confidence,
                        quality_score=quality,
                        embedding=embedding.tolist(),
                        model_version=str(self.active_model["version"]),
                        aligned_crop_key=(
                            f"events/{request.event_id}/faces/{request.asset_id}/{index}.crop"
                            if request.object_key
                            else None
                        ),
                        module_versions=modules,
                    )
                )
                metrics.count("faces_emitted")
            finally:
                if aligned is not None and aligned.pixels is not None:
                    if decoded_image is None or not np.shares_memory(aligned.pixels, decoded_image):
                        aligned.pixels.fill(0)
        return faces

    def _image_metadata(
        self, image_bytes: bytes, request: PhotoProcessRequest
    ) -> dict[str, object]:
        capture_metadata = _capture_metadata(image_bytes)
        return {
            "content_type": request.content_type,
            "byte_size": len(image_bytes),
            "sha256": hashlib.sha256(image_bytes).hexdigest(),
            "exif": capture_metadata,
            "duplicate_check": (
                {
                    "status": "perceptual_hash_ready",
                    "duplicate_of_asset_id": None,
                    "algorithm": "perceptual_hash_hamming_similarity_v1",
                    "similarity_threshold": PHOTO_SIMILARITY_THRESHOLD,
                    "exact_duplicate_threshold": PHOTO_DUPLICATE_THRESHOLD,
                }
                if request.duplicate_check
                else {"status": "skipped"}
            ),
        }

    def _image_quality_profile(
        self,
        image_bytes: bytes,
        faces: list[DetectedFace],
        decoded_image: np.ndarray | None = None,
    ) -> ImageQualityProfile:
        decoded = decoded_image if decoded_image is not None else decode_image(image_bytes)
        return ImageQualityProfile(
            **image_diagnostics(decoded, [face.quality_score for face in faces])
        )

    @property
    def module_versions(self) -> dict[str, str]:
        return {
            "detector": self.detector.version,
            "aligner": self.aligner.version,
            "quality_scorer": self.quality_scorer.version,
            "embedding_model": self.embedding_model.version,
            "vector_matcher": self.vector_matcher.version,
            "decision_engine": self.decision_engine.version,
        }

    @property
    def processing_version(self) -> str:
        base = f"{self.active_model['version']}:{self.module_versions['embedding_model']}:{IMAGE_ANALYSIS_VERSION}"
        return (
            base
            if self.detection_profile == REFERENCE_PROFILE
            else f"{base}:{self.detection_profile}:{profile_fingerprint(self.detection_profile)}"
        )

    def _resolve_model_path(self, value: str) -> Path:
        path = Path(value)
        if path.is_absolute():
            return path
        if path.parts and path.parts[0] == "models":
            return self.model_root.parent / path
        return self.model_root / path

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _normalize(vector: np.ndarray) -> np.ndarray:
        return normalize(vector)

    @staticmethod
    def _cosine_distance(left: np.ndarray, right: np.ndarray) -> float:
        return float(1.0 - np.dot(left, right))
