"""Synthetic test evidence only; not a model approval or release artifact.

Shared by codec-independent policy checks and full pipeline tests. Importing
this fixture does not initialize the image service, codecs or model weights.
"""


def approved_evaluation_report() -> dict[str, object]:
    return {
        "approval": {"status": "approved"},
        "decision_binding": {
            "decision_contract": "distinct-identity-current-decision-v4",
            "search_contract": "eligible-model-distinct-top20-distance1-v1",
            "policy": {
                "distance_threshold": 0.42,
                "review_margin": 0.05,
                "minimum_quality": 0.72,
                "minimum_detection_confidence": 0.8,
                "featured_face_min_area_ratio": 0.025,
                "high_match_acceptance": 0.85,
                "medium_match_acceptance": 0.88,
            },
        },
        "model_version": "test-model",
        "model_checksum_sha256": "a" * 64,
        "processing_contract_version": "canonical-upright-aligned-pixels-v2",
        "dataset": {
            "event_count": 1,
            "identity_count": 1,
            "image_count": 1,
            "camera_source_mix_reviewed": True,
            "lighting_pose_occlusion_reviewed": True,
            "three_selfie_source_reviewed": True,
            "holdout_split_verified": True,
            "consent_evidence_verified": True,
        },
        "results": {
            "false_positive_rate": 0,
            "false_negative_rate": 0,
            "false_positive_reviewed": True,
            "false_negative_reviewed": True,
        },
        "thresholds": {
            "auto_match_threshold": 0.42,
            "review_threshold": 0.32,
            "minimum_margin": 0.08,
            "minimum_quality_score": 0.72,
            "threshold_dataset_reviewed": True,
            "reviewer_capacity_reviewed": True,
            "top2_margin_policy_reviewed": True,
            "threshold_change_control_approved": True,
            "threshold_freeze_approved": True,
        },
        "bias_review": {"status": "completed"},
        "policy_checks": {
            "profile_based_matching_only": True,
            "no_demographic_outputs": True,
            "no_emotion_age_gender_ethnicity": True,
            "no_global_identity_search": True,
            "source_license_notice_verified": True,
            "consent_scope_verified": True,
        },
        "operations": {
            "health_check_passed": True,
            "queue_to_gallery_smoke_passed": True,
            "admin_review_queue_smoke_passed": True,
            "not_me_dispute_smoke_passed": True,
            "drift_monitoring_configured": True,
            "rollback_drill_passed": True,
            "alert_owner": "ml-on-call",
        },
    }
