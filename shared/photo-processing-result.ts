/** Private ML-response integrity and bounded transport. This is not authentication
 * or evidence that the ML provider is uncompromised; existing service secrets,
 * consent checks, approval policy and database authorization remain necessary.
 */
import {
  IMAGE_HASH_ALGORITHM,
  isRecord,
  isUnitScore,
  MAX_PHOTO_FACES,
  normalizeFaceEmbedding,
  verifiedFaceAreaRatio,
} from "./photo-matching-contract.ts";
import { validateProcessingDiagnostics } from "./photo-processing-diagnostics.ts";

export const PHOTO_RESULT_CONTRACT = "lovelies-photo-result-v2";
export const MAX_ML_RESPONSE_BYTES = 1024 * 1024;
export type PhotoProcessingMode = "recognition" | "validation";
export interface ExpectedPhotoResult {
  eventId: string;
  assetId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  mode: PhotoProcessingMode;
}
export type ResultFailureCode =
  | "ml_response_http_error"
  | "ml_response_transport_failed"
  | "ml_response_size_limit"
  | "ml_response_timeout"
  | "ml_response_invalid_json"
  | "ml_response_content_type"
  | "ml_response_length_invalid"
  | "ml_response_request_mismatch"
  | "ml_result_contract_invalid"
  | "ml_result_source_mismatch"
  | "ml_result_geometry_invalid"
  | "ml_result_faces_invalid"
  | "ml_result_quality_invalid"
  | "ml_result_trace_invalid";

export class MlPhotoResultError extends Error {
  constructor(
    readonly code: ResultFailureCode,
    readonly upstreamStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "MlPhotoResultError";
  }
}
const fail = (code: ResultFailureCode): never => {
  throw new MlPhotoResultError(code);
};
const integer = (x: unknown, low: number, high: number): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= low && x <= high;
const tag = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[a-zA-Z0-9_.:-]{1,256}$/.test(x);
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
  "faces_considered",
  "alignment_failures",
  "embedding_failures",
  "faces_aligned",
  "embeddings_created",
  "faces_emitted",
] as const;
const MODULES = [
  "detector",
  "aligner",
  "quality_scorer",
  "embedding_model",
  "vector_matcher",
  "decision_engine",
  "recognition_provider",
  "external_recognition_api",
  "evaluation_status",
  "geometry_contract",
  "processing_contract_version",
  "model_checksum_sha256",
  "decision_contract_version",
  "evaluation_search_contract",
  "evaluation_model_version",
  "evaluation_report_sha256",
  "evaluation_model_checksum_sha256",
  "approved_decision_policy",
  "detection_profile",
  "detection_profile_sha256",
] as const;
const QUALITY = [
  "aggregate_score",
  "blur_score",
  "exposure_score",
  "noise_score",
  "color_balance_score",
  "face_quality_score",
  "printability_score",
] as const;

function validatedTrace(
  raw: unknown,
  faceCount: number,
  mode: PhotoProcessingMode,
): Record<string, unknown> {
  if (
    !isRecord(raw) ||
    raw.contract_version !== "aggregate-processing-stages-v2" ||
    !isRecord(raw.stage_ms) || !isRecord(raw.counts)
  ) return fail("ml_result_trace_invalid");
  const duration = (x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x) && x >= 0;
  if (
    !duration(raw.total_ms) ||
    Object.keys(raw.stage_ms).length !== STAGES.length ||
    !STAGES.every((k) =>
      duration((raw.stage_ms as Record<string, unknown>)[k])
    ) ||
    Object.keys(raw.counts).length !== COUNTERS.length ||
    !COUNTERS.every((k) =>
      integer((raw.counts as Record<string, unknown>)[k], 0, MAX_PHOTO_FACES)
    )
  ) {
    return fail("ml_result_trace_invalid");
  }
  const c = raw.counts as Record<typeof COUNTERS[number], number>;
  if (
    c.faces_emitted !== faceCount || c.embeddings_created !== faceCount ||
    c.faces_aligned !== faceCount + c.embedding_failures ||
    c.faces_considered !== c.faces_aligned + c.alignment_failures ||
    (mode === "validation" && COUNTERS.some((k) => c[k] !== 0))
  ) return fail("ml_result_trace_invalid");
  // Return fixed aggregate fields only. Never accept identifiers in operational traces.
  return {
    contract_version: raw.contract_version,
    total_ms: raw.total_ms,
    stage_ms: Object.fromEntries(
      STAGES.map((k) => [k, (raw.stage_ms as Record<string, unknown>)[k]]),
    ),
    counts: Object.fromEntries(COUNTERS.map((k) => [k, c[k]])),
  };
}

export function validateMlPhotoResult(
  value: unknown,
  expected: ExpectedPhotoResult,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.result_contract_version !== PHOTO_RESULT_CONTRACT ||
    value.processing_mode !== expected.mode || !tag(value.processing_version) ||
    !Array.isArray(value.prohibited_categories) ||
    value.prohibited_categories.length !== 0
  ) {
    return fail("ml_result_contract_invalid");
  }
  const meta = value.image_metadata;
  if (
    !isRecord(meta) || value.asset_id !== expected.assetId ||
    value.event_id !== expected.eventId ||
    !expected.assetId || !expected.eventId ||
    !/^[0-9a-f]{64}$/.test(expected.sha256) ||
    !integer(expected.byteSize, 1, 20 * 1024 * 1024) ||
    meta.sha256 !== expected.sha256 || meta.byte_size !== expected.byteSize ||
    meta.content_type !== expected.contentType
  ) return fail("ml_result_source_mismatch");
  const g = meta.geometry;
  if (
    !isRecord(g) || g.coordinate_space !== "pixels" ||
    g.orientation !== "upright" ||
    !integer(g.width, 1, 40_000_000) || !integer(g.height, 1, 40_000_000) ||
    g.width * g.height > 40_000_000
  ) return fail("ml_result_geometry_invalid");
  const faces = value.faces;
  if (
    !Array.isArray(faces) || faces.length > MAX_PHOTO_FACES ||
    (expected.mode === "validation" &&
      (faces.length !== 0 || value.status !== "validated")) ||
    (expected.mode === "recognition" &&
      value.status !== (faces.length ? "processed" : "no_faces"))
  ) {
    return fail("ml_result_faces_invalid");
  }
  for (const f of faces) {
    if (
      !isRecord(f) || !tag(f.model_version) || f.image_width !== g.width ||
      f.image_height !== g.height ||
      f.bbox_coordinate_space !== "pixels" ||
      verifiedFaceAreaRatio(
          f.bbox,
          g.width,
          g.height,
          f.bbox_coordinate_space,
        ) === undefined ||
      !isUnitScore(f.quality_score) || !isUnitScore(f.detection_confidence) ||
      normalizeFaceEmbedding(f.embedding).length !== 128 ||
      !isRecord(f.landmarks) ||
      !isRecord(f.module_versions) ||
      Object.keys(f.module_versions).length > 32 ||
      !Object.entries(f.module_versions).every(([k, v]) =>
        tag(k) && typeof v === "string" && v.length <= 4096
      ) ||
      f.module_versions.processing_contract_version !==
        "canonical-upright-aligned-pixels-v2"
    ) {
      return fail("ml_result_faces_invalid");
    }
    for (
      const k of ["right_eye", "left_eye", "nose", "mouth_right", "mouth_left"]
    ) {
      const p = f.landmarks[k];
      if (
        !Array.isArray(p) || p.length !== 2 ||
        !p.every((x) => typeof x === "number" && Number.isFinite(x))
      ) {
        return fail("ml_result_faces_invalid");
      }
    }
  }
  const q = value.image_quality;
  if (
    !isRecord(q) || !QUALITY.every((k) => isUnitScore(q[k])) ||
    q.estimated_width !== g.width ||
    q.estimated_height !== g.height ||
    q.perceptual_hash_algorithm !== IMAGE_HASH_ALGORITHM ||
    typeof q.perceptual_hash !== "string" ||
    !/^[0-9a-f]{16}$/.test(q.perceptual_hash) ||
    q.measurement_version !== "upright-pixel-metrics-v2" ||
    q.calibration_status !== "heuristic_not_calibrated" ||
    !Array.isArray(q.flags) || q.flags.length > 16 || !q.flags.every(tag)
  ) {
    return fail("ml_result_quality_invalid");
  }
  const trace = validatedTrace(
    value.processing_trace,
    faces.length,
    expected.mode,
  );
  let diagnostics: Record<string, unknown> | undefined;
  if (expected.mode === "recognition") {
    try {
      diagnostics = validateProcessingDiagnostics(
        meta.processing_diagnostics,
        trace,
        faces,
        meta.evaluation_status,
      );
    } catch {
      return fail("ml_result_trace_invalid");
    }
  } else if (meta.processing_diagnostics !== undefined) {
    // Image-only validation has no detector profile or biometric diagnostics.
    return fail("ml_result_trace_invalid");
  }
  const rawExif = isRecord(meta.exif) ? meta.exif : {};
  const exif: Record<string, unknown> = {};
  for (const k of ["status", "captured_at", "source", "timezone_source"]) {
    if (
      typeof rawExif[k] === "string" && (rawExif[k] as string).length <= 128
    ) exif[k] = rawExif[k];
  }
  // Allowlist what enters persistence. Unexpected provider fields (raw input,
  // debug traces or additional metadata) are deliberately not carried forward.
  return {
    result_contract_version: PHOTO_RESULT_CONTRACT,
    processing_mode: expected.mode,
    event_id: expected.eventId,
    asset_id: expected.assetId,
    status: value.status,
    processing_version: value.processing_version,
    prohibited_categories: [],
    image_metadata: {
      sha256: meta.sha256,
      byte_size: meta.byte_size,
      content_type: meta.content_type,
      geometry: {
        width: g.width,
        height: g.height,
        coordinate_space: "pixels",
        orientation: "upright",
      },
      exif,
      ...(diagnostics ? { processing_diagnostics: diagnostics } : {}),
      ...(tag(meta.evaluation_status)
        ? { evaluation_status: meta.evaluation_status }
        : {}),
    },
    image_quality: {
      ...Object.fromEntries(QUALITY.map((k) => [k, q[k]])),
      estimated_width: g.width,
      estimated_height: g.height,
      flags: [...q.flags],
      perceptual_hash: q.perceptual_hash,
      perceptual_hash_algorithm: q.perceptual_hash_algorithm,
      measurement_version: q.measurement_version,
      calibration_status: q.calibration_status,
    },
    faces: faces.map((f) => ({
      bbox: Object.fromEntries(
        ["x", "y", "width", "height"].map((k) => [k, f.bbox[k]]),
      ),
      image_width: g.width,
      image_height: g.height,
      bbox_coordinate_space: "pixels",
      landmarks: Object.fromEntries(
        ["right_eye", "left_eye", "nose", "mouth_right", "mouth_left"].map(
          (k) => [k, [...f.landmarks[k]]],
        ),
      ),
      quality_score: f.quality_score,
      detection_confidence: f.detection_confidence,
      embedding: f.embedding,
      model_version: f.model_version,
      aligned_crop_key: null,
      module_versions: Object.fromEntries(
        MODULES.filter((k) => f.module_versions[k] !== undefined).map(
          (k) => [k, f.module_versions[k]],
        ),
      ),
    })),
    processing_trace: trace,
  };
}

/** Freeze processing purpose at dispatch. A mid-flight opt-in cannot turn an
 * image-validation response into recognition, and revocation suppresses faces.
 * This guard does not replace the database's consent-race protections.
 */
export function mayConsumeRecognition(
  mode: PhotoProcessingMode,
  privatePhoto: boolean,
  state: unknown,
): boolean {
  return mode === "recognition" &&
    (!privatePhoto ||
      (isRecord(state) && state.allowed === true &&
        state.face_discovery === true));
}

function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch { /* best effort */ }
}
function retryDelay(response: Response): number | undefined {
  const value = response.headers.get("retry-after") ?? "";
  return /^[0-9]{1,6}$/.test(value)
    ? Math.max(1, Math.min(300, Number(value)))
    : undefined;
}

/** Count decoded response bytes, not compressed Content-Length. Deadline bounds
 * body reading only; it cannot interrupt a synchronous JSON.parse or inference.
 */
export async function readBoundedMlPhotoResult(
  response: Response,
  expected: ExpectedPhotoResult,
  options: {
    requestId?: string;
    maximumBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Record<string, unknown>> {
  const maximum = options.maximumBytes ?? MAX_ML_RESPONSE_BYTES;
  const timeout = options.timeoutMs ?? 30_000;
  if (
    !integer(maximum, 1, MAX_ML_RESPONSE_BYTES) || !integer(timeout, 1, 30_000)
  ) {
    discard(response);
    throw new Error("invalid_ml_reader_configuration");
  }
  if (options.signal?.aborted) {
    discard(response);
    throw new MlPhotoResultError("ml_response_transport_failed");
  }
  if (!response.ok) {
    discard(response);
    throw new MlPhotoResultError(
      "ml_response_http_error",
      response.status,
      retryDelay(response),
    );
  }
  if (
    (response.headers.get("content-type") ?? "").split(";", 1)[0].trim()
      .toLowerCase() !== "application/json"
  ) {
    discard(response);
    return fail("ml_response_content_type");
  }
  if (
    options.requestId !== undefined &&
    response.headers.get("x-request-id") !== options.requestId
  ) {
    discard(response);
    return fail("ml_response_request_mismatch");
  }
  const encoded = (response.headers.get("content-encoding") ?? "").trim()
    .toLowerCase();
  const lengthText = response.headers.get("content-length");
  let declared: number | undefined;
  if (!encoded || encoded === "identity") {
    if (
      lengthText !== null &&
      (!/^[0-9]+$/.test(lengthText) ||
        !Number.isSafeInteger(Number(lengthText)))
    ) {
      discard(response);
      return fail("ml_response_length_invalid");
    }
    if (lengthText !== null) declared = Number(lengthText);
    if (declared !== undefined && declared > maximum) {
      discard(response);
      return fail("ml_response_size_limit");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return fail("ml_response_invalid_json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let finished = false, total = 0;
  const chunks: Uint8Array[] = [];
  let bytes: Uint8Array | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MlPhotoResultError("ml_response_timeout")),
      timeout,
    );
    abort = () =>
      reject(new MlPhotoResultError("ml_response_transport_failed"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        finished = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        return fail("ml_response_invalid_json");
      }
      if (value.byteLength > maximum - total) {
        return fail("ml_response_size_limit");
      }
      total += value.byteLength;
      chunks.push(value.slice());
    }
    if (declared !== undefined && declared !== total) {
      return fail("ml_response_length_invalid");
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      );
    } catch {
      return fail("ml_response_invalid_json");
    }
    return validateMlPhotoResult(parsed, expected);
  } catch (error) {
    if (error instanceof MlPhotoResultError) throw error;
    throw new MlPhotoResultError("ml_response_transport_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
    if (!finished) {
      try {
        void reader.cancel().catch(() => {});
      } catch {}
    }
    try {
      reader.releaseLock();
    } catch { /* pending cancellation may own lock */ }
    for (const chunk of chunks) chunk.fill(0);
    bytes?.fill(0);
    // Do not claim secure erasure: parsing, SDKs and runtimes may keep copies.
  }
}

/** R2/source input is bounded before the Worker allocates a complete image. The
 * upstream upload checks remain useful, but a stored object is checked again.
 */
export async function readBoundedImageBody(response: Response, options: {
  maximumBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<ArrayBuffer> {
  const maximum = options.maximumBytes ?? 20 * 1024 * 1024;
  const timeout = options.timeoutMs ?? 30_000;
  if (!integer(maximum, 1, 20 * 1024 * 1024) || !integer(timeout, 1, 30_000)) {
    discard(response);
    throw new Error("invalid_photo_source_configuration");
  }
  if (options.signal?.aborted) {
    discard(response);
    throw new Error("photo_source_read_failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("photo_source_empty");
  let timer: ReturnType<typeof setTimeout> | undefined,
    finished = false,
    total = 0;
  let abort: (() => void) | undefined;
  const chunks: Uint8Array[] = [];
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("photo_source_timeout")),
      timeout,
    );
    abort = () => reject(new Error("photo_source_read_failed"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) {
        finished = true;
        break;
      }
      if (
        !(value instanceof Uint8Array) || value.byteLength > maximum - total
      ) {
        throw new Error("photo_source_size_limit");
      }
      total += value.byteLength;
      chunks.push(value.slice());
    }
    if (!total) throw new Error("photo_source_empty");
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output.buffer;
  } catch {
    // No object key, response payload or runtime exception text crosses this API.
    throw new Error("photo_source_read_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
    if (!finished) {
      try {
        void reader.cancel().catch(() => {});
      } catch {}
    }
    try {
      reader.releaseLock();
    } catch {}
    for (const chunk of chunks) chunk.fill(0);
  }
}
