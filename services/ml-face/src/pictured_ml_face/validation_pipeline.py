"""Decode and measure an authorized image without invoking any face component."""

from __future__ import annotations

import hashlib

from pictured_ml_face.components import decode_validated_image
from pictured_ml_face.image_analysis import image_diagnostics, IMAGE_ANALYSIS_VERSION
from pictured_ml_face.processing_observation import PHOTO_RESULT_CONTRACT, ProcessingObservation


def process_validation_image(
    image_bytes: bytes,
    content_type: str,
    event_id: str = "",
    asset_id: str = "",
) -> dict[str, object]:
    trace = ProcessingObservation()
    with trace.stage("decode"):
        decoded, geometry = decode_validated_image(image_bytes, content_type)
    try:
        with trace.stage("image_quality"):
            quality = image_diagnostics(decoded, [])
        with trace.stage("metadata"):
            metadata = {
                "sha256": hashlib.sha256(image_bytes).hexdigest(),
                "byte_size": len(image_bytes),
                "content_type": content_type,
                "geometry": {**geometry, "coordinate_space": "pixels", "orientation": "upright"},
            }
        # Top-level dimensions preserve the earlier validate-image consumer contract.
        # Empty identities are supported for standalone validation; job consumers
        # require nonempty identities equal to those supplied with their request.
        return {
            **geometry,
            "result_contract_version": PHOTO_RESULT_CONTRACT,
            "processing_mode": "validation",
            "event_id": event_id,
            "asset_id": asset_id,
            "status": "validated",
            "faces": [],
            "prohibited_categories": [],
            "image_metadata": metadata,
            "image_quality": quality,
            "processing_version": IMAGE_ANALYSIS_VERSION,
            "processing_trace": trace.snapshot(),
        }
    finally:
        # Owned decoded pixels only; not a promise of complete runtime erasure.
        decoded.fill(0)
