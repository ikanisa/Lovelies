/** Match approval to the actual numerical decision settings. Metadata comes from
 * the private ML service/persisted detection row, never an unauthenticated client.
 * A SHA-256 string binds report bytes; it is NOT a cryptographic reviewer signature.
 */
// Narrow structural operating-point settings. No Worker environment dependency.
export type ApprovalFacePolicy = {
  distance_threshold: number;
  review_margin: number;
  minimum_quality: number;
  minimum_detection_confidence: number;
  featured_face_min_area_ratio: number;
};
export type ApprovalProfilePolicy = {
  model_version: string;
  kill_switch: boolean;
  high_match_acceptance: number;
  medium_match_acceptance: number;
};
export const DECISION_CONTRACT = "distinct-identity-current-decision-v4";
export const SEARCH_CONTRACT = "eligible-model-distinct-top20-distance1-v1";
export const DECISION_POLICY_KEYS = [
  "distance_threshold",
  "review_margin",
  "minimum_quality",
  "minimum_detection_confidence",
  "featured_face_min_area_ratio",
  "high_match_acceptance",
  "medium_match_acceptance",
] as const;
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const unit = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const hash = (x: unknown): x is string =>
  typeof x === "string" && /^[0-9a-f]{64}$/.test(x);

export function approvalPolicyMatches(
  metadata: unknown,
  modelVersion: string,
  facePolicy: ApprovalFacePolicy,
  profilePolicy: ApprovalProfilePolicy | null,
): boolean {
  if (
    !record(metadata) ||
    !profilePolicy ||
    (metadata.detection_profile !== undefined &&
      metadata.detection_profile !== "reference-v1") ||
    metadata.evaluation_status !== "approved" ||
    metadata.geometry_contract !== "upright-pixels-v1" ||
    metadata.processing_contract_version !==
      "canonical-upright-aligned-pixels-v2" ||
    metadata.decision_contract_version !== DECISION_CONTRACT ||
    metadata.evaluation_search_contract !== SEARCH_CONTRACT ||
    metadata.evaluation_model_version !== modelVersion ||
    !hash(metadata.evaluation_report_sha256) ||
    !hash(metadata.model_checksum_sha256) ||
    metadata.evaluation_model_checksum_sha256 !==
      metadata.model_checksum_sha256 ||
    typeof metadata.approved_decision_policy !== "string" ||
    metadata.approved_decision_policy.length > 2048
  )
    return false;
  // The private service emits plain ASCII keys. Forbid escaped/duplicate keys
  // rather than letting JSON.parse silently select the last duplicate value.
  const encoded = metadata.approved_decision_policy;
  if (
    /\\/.test(encoded) ||
    !DECISION_POLICY_KEYS.every(
      (key) =>
        (encoded.match(new RegExp('"' + key + '"\\s*:', "g")) ?? []).length ===
        1,
    )
  )
    return false;
  let evaluated: unknown;
  try {
    evaluated = JSON.parse(metadata.approved_decision_policy);
  } catch {
    return false;
  }
  if (
    !record(evaluated) ||
    Object.keys(evaluated).length !== DECISION_POLICY_KEYS.length ||
    !Object.keys(evaluated).every((k) =>
      (DECISION_POLICY_KEYS as readonly string[]).includes(k),
    )
  )
    return false;
  const current: Record<string, unknown> = {
    distance_threshold: facePolicy.distance_threshold,
    review_margin: facePolicy.review_margin,
    minimum_quality: facePolicy.minimum_quality,
    minimum_detection_confidence: facePolicy.minimum_detection_confidence,
    featured_face_min_area_ratio: facePolicy.featured_face_min_area_ratio,
    high_match_acceptance: profilePolicy.high_match_acceptance,
    medium_match_acceptance: profilePolicy.medium_match_acceptance,
  };
  // Exact comparison is intentional. Even a stricter setting can change miss and
  // review rates. Changed settings need fresh evaluation, not an epsilon bypass.
  return DECISION_POLICY_KEYS.every(
    (k) =>
      unit(evaluated[k]) && unit(current[k]) && evaluated[k] === current[k],
  );
}
