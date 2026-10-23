/** Versioned, privacy-minimizing validation for merged detector measurements.
 * Diagnostics are private-service assertions, not recognition evidence or auth.
 * Keep candidate markers through response sanitization so approval cannot lose
 * the detector execution profile between the producer and matching policy.
 */
import { isRecord } from "./photo-matching-contract.ts";

export const DETECTION_FINGERPRINTS: Readonly<Record<string, string>> = Object
  .freeze({
    // Generated from detection_strategy.profile_descriptor; cross-language tests
    // bind these exact descriptors. A new profile needs a versioned contract.
    "reference-v1":
      "e1d5296a98f25d1d1bfd969c4bbabe19531aa38fadee970778318fd2581e58fe",
    "bounded-v1":
      "9c41dff4c19aa748774e0901de001bc201dd7f902a672121733230fb6a53fb76",
    "group-v1":
      "eaa26793a99976e8bded1519cc667baed4765645acc5ca4a7d6043fe338d063e",
  });
const STAGES = [
  "decode",
  "detect",
  "align",
  "embed",
  "face_quality",
  "image_quality",
  "metadata",
] as const;
const COUNTERS = [
  "detections",
  "alignment_rejections",
  "embedding_rejections",
  "faces_emitted",
  "views_executed",
  "detector_input_pixels",
  "candidates_seen",
  "invalid_candidates",
  "duplicates_suppressed",
] as const;
const invalid = (): never => {
  throw new Error("invalid_processing_diagnostics");
};
const integer = (x: unknown, max: number): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= max;
const duration = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;

export function validateProcessingDiagnostics(
  raw: unknown,
  trace: Record<string, unknown>,
  faces: Array<Record<string, unknown>>,
  evaluationStatus: unknown,
): Record<string, unknown> {
  if (
    !isRecord(raw) ||
    raw.schema_version !== "photo-processing-diagnostics-v1" ||
    typeof raw.detection_profile !== "string" ||
    !Object.hasOwn(DETECTION_FINGERPRINTS, raw.detection_profile) ||
    raw.detection_profile_sha256 !==
      DETECTION_FINGERPRINTS[raw.detection_profile] ||
    typeof raw.synthetic !== "boolean" ||
    typeof raw.face_limit_reached !== "boolean" ||
    raw.quality_gate_applied !== false ||
    raw.timing_scope !==
      "local_decode_to_response_construction_not_queue_or_network" ||
    !isRecord(raw.counts) || !isRecord(raw.stage_ms) ||
    !isRecord(trace.counts) ||
    !isRecord(trace.stage_ms) || !duration(raw.total_ms) ||
    raw.total_ms !== trace.total_ms ||
    Object.keys(raw.stage_ms).length !== STAGES.length ||
    !STAGES.every((k) =>
      duration((raw.stage_ms as Record<string, unknown>)[k]) &&
      (raw.stage_ms as Record<string, unknown>)[k] ===
        (trace.stage_ms as Record<string, unknown>)[k]
    ) ||
    Object.keys(raw.counts).length !== COUNTERS.length
  ) return invalid();
  const c = raw.counts;
  const bounds: Record<typeof COUNTERS[number], number> = {
    detections: 100,
    alignment_rejections: 100,
    embedding_rejections: 100,
    faces_emitted: 100,
    views_executed: 5,
    detector_input_pixels: 40_000_000,
    candidates_seen: 500,
    invalid_candidates: 500,
    duplicates_suppressed: 500,
  };
  if (!COUNTERS.every((k) => integer(c[k], bounds[k]))) return invalid();
  const counts = c as Record<typeof COUNTERS[number], number>;
  const t = trace.counts;
  const profile = raw.detection_profile;
  if (
    counts.views_executed < 1 ||
    (profile !== "group-v1" && counts.views_executed !== 1) ||
    (profile === "bounded-v1" && counts.detector_input_pixels > 1_638_400) ||
    (profile === "group-v1" && counts.detector_input_pixels > 5_324_800) ||
    counts.detections + counts.invalid_candidates +
          counts.duplicates_suppressed > counts.candidates_seen ||
    counts.candidates_seen > counts.views_executed * 100 ||
    counts.detections !==
      counts.alignment_rejections + counts.embedding_rejections +
        counts.faces_emitted ||
    counts.faces_emitted !== faces.length ||
    counts.faces_emitted !== t.faces_emitted ||
    counts.detections !== t.faces_considered ||
    counts.alignment_rejections !== t.alignment_failures ||
    counts.embedding_rejections !== t.embedding_failures
  ) return invalid();
  const outcome = counts.faces_emitted
    ? "faces_processed"
    : counts.detections
    ? "no_usable_faces"
    : "no_detections";
  if (
    raw.outcome !== outcome ||
    (raw.synthetic && evaluationStatus === "approved") ||
    !["not_required", "monitored_pilot", "approved", "optimization_candidate"]
      .includes(String(evaluationStatus)) ||
    (profile === "reference-v1"
      ? evaluationStatus === "optimization_candidate"
      : evaluationStatus !== "optimization_candidate")
  ) return invalid();
  for (const face of faces) {
    const m = face.module_versions;
    if (
      !isRecord(m) || m.detection_profile !== profile ||
      m.detection_profile_sha256 !== raw.detection_profile_sha256 ||
      m.evaluation_status !== evaluationStatus ||
      (profile !== "reference-v1" &&
        (m.approved_decision_policy !== undefined ||
          m.evaluation_report_sha256 !== undefined))
    ) return invalid();
  }
  return {
    schema_version: raw.schema_version,
    detection_profile: profile,
    detection_profile_sha256: raw.detection_profile_sha256,
    synthetic: raw.synthetic,
    stage_ms: Object.fromEntries(
      STAGES.map((k) => [k, (raw.stage_ms as Record<string, unknown>)[k]]),
    ),
    total_ms: raw.total_ms,
    counts: Object.fromEntries(COUNTERS.map((k) => [k, counts[k]])),
    face_limit_reached: raw.face_limit_reached,
    outcome,
    quality_gate_applied: false,
    timing_scope: raw.timing_scope,
  };
}
