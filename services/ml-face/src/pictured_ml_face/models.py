from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field, FiniteFloat

from pictured_ml_face.embedding_contract import normalize_embedding_input


FaceEmbedding = Annotated[
    list[FiniteFloat],
    Field(min_length=128, max_length=128),
    BeforeValidator(normalize_embedding_input),
]
MatchThreshold = Annotated[FiniteFloat, Field(ge=0, le=1, strict=True)]


class MatchDecision(StrEnum):
    AUTO_MATCHED = "auto_matched"
    NEEDS_REVIEW = "needs_review"
    REJECTED = "rejected"


class PhotoProcessRequest(BaseModel):
    event_id: str
    asset_id: str
    object_key: str
    content_type: str = "image/jpeg"
    image_b64: str | None = None
    duplicate_check: bool = True


class DetectedFace(BaseModel):
    bbox: dict[str, int]
    landmarks: dict[str, list[float]]
    detection_confidence: float = Field(default=1, ge=0, le=1)
    quality_score: float = Field(ge=0, le=1)
    embedding: FaceEmbedding
    model_version: str
    aligned_crop_key: str | None = None
    module_versions: dict[str, str] = Field(default_factory=dict)
    bbox_coordinate_space: Literal["pixels"] = "pixels"
    image_width: int | None = Field(default=None, gt=0)
    image_height: int | None = Field(default=None, gt=0)


class ImageQualityProfile(BaseModel):
    aggregate_score: float = Field(ge=0, le=1)
    blur_score: float = Field(ge=0, le=1)
    exposure_score: float = Field(ge=0, le=1)
    noise_score: float = Field(ge=0, le=1)
    color_balance_score: float = Field(ge=0, le=1)
    face_quality_score: float = Field(ge=0, le=1)
    printability_score: float = Field(ge=0, le=1)
    flags: list[str] = Field(default_factory=list)
    perceptual_hash: str
    estimated_width: int = Field(gt=0)
    estimated_height: int = Field(gt=0)
    perceptual_hash_algorithm: str = "dhash-luma-upright-v1"
    measurement_version: str = "upright-pixel-metrics-v2"
    calibration_status: str = "heuristic_not_calibrated"


class PhotoProcessResponse(BaseModel):
    result_contract_version: Literal["lovelies-photo-result-v2"] = "lovelies-photo-result-v2"
    processing_mode: Literal["recognition"] = "recognition"
    processing_trace: dict[str, Any] = Field(default_factory=dict)
    event_id: str
    asset_id: str
    status: str
    faces: list[DetectedFace]
    prohibited_categories: list[str]
    image_metadata: dict[str, Any] = Field(default_factory=dict)
    image_quality: ImageQualityProfile
    duplicate_of_asset_id: str | None = None
    processing_version: str


class CandidateEmbedding(BaseModel):
    user_id: str
    face_profile_id: str
    embedding: FaceEmbedding


class MatchRequest(BaseModel):
    event_id: str
    detected_face_id: str
    embedding: FaceEmbedding
    candidates: list[CandidateEmbedding] = Field(max_length=4096)
    threshold: MatchThreshold | None = None
    review_margin: MatchThreshold | None = None


class MatchResult(BaseModel):
    # Raw vector ranking has no photo-access effect. The Worker remains authoritative.
    authorization_effect: Literal["none"] = "none"
    numeric_decision: MatchDecision | None = None
    decision_contract_version: str = "distinct-identity-current-decision-v4"
    reason_codes: list[str] = Field(default_factory=list)
    user_id: str | None
    face_profile_id: str | None
    score: FiniteFloat = Field(ge=0, le=1)
    margin: FiniteFloat = Field(ge=0, le=2)
    threshold: MatchThreshold
    decision: MatchDecision
    event_scope: str


class ModelManifest(BaseModel):
    active_model_version: str
    models: list[dict[str, Any]]
    blocked_models: list[dict[str, str]]
    production_evidence: dict[str, Any] = Field(default_factory=dict)
