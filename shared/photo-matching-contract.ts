/** Shared, side-effect-free matching guards. No authentication or consent bypass. */
export const IMAGE_HASH_ALGORITHM = "dhash-luma-upright-v1";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Unknown coordinate units fail closed. Pixel boxes require upright dimensions. */
export function verifiedFaceAreaRatio(
  bbox: unknown,
  imageWidth?: number,
  imageHeight?: number,
  coordinateSpace?: unknown,
): number | undefined {
  if (!bbox || typeof bbox !== "object" || Array.isArray(bbox)) {
    return undefined;
  }
  const b = bbox as Record<string, unknown>;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every(finite)) return undefined;
  const [left, top, w, h] = [x, y, width, height] as number[];
  if (w <= 0 || h <= 0 || left < 0 || top < 0) return undefined;
  const units = coordinateSpace ?? b.coordinate_space;
  if (units === "normalized") {
    if (left + w > 1.000001 || top + h > 1.000001) return undefined;
    return Math.min(1, w * h);
  }
  // Older server responses omitted the label but supplied actual pixel dimensions.
  if (units !== undefined && units !== "pixels") return undefined;
  if (
    !finite(imageWidth) || !finite(imageHeight) || imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return undefined;
  }
  if (left + w > imageWidth + 1 || top + h > imageHeight + 1) return undefined;
  return Math.min(1, (w * h) / (imageWidth * imageHeight));
}

export function eligibleFaceArea(value: unknown, minimum: number): boolean {
  return finite(value) && value > 0 && value <= 1 && finite(minimum) &&
    minimum >= 0 && minimum <= 1 && value >= minimum;
}

type Candidate = {
  user_id: string;
  face_profile_id: string;
  distance: number;
  model_version: string;
};

/** The runner-up must be a different identity, not another pose of the same user. */
export function distinctIdentityCandidates<T extends Candidate>(
  candidates: T[],
  modelVersion: string,
): T[] {
  const selected = new Map<string, T>();
  for (const c of candidates) {
    if (
      !c || typeof c !== "object" || !c.user_id || !c.face_profile_id ||
      c.model_version !== modelVersion || !finite(c.distance) ||
      c.distance < -0.000001 || c.distance > 2.000001
    ) continue;
    const previous = selected.get(c.user_id);
    if (!previous || c.distance < previous.distance) selected.set(c.user_id, c);
  }
  return [...selected.values()].sort((a, b) =>
    a.distance - b.distance ||
    a.user_id.localeCompare(b.user_id)
  );
}

export function modelAllowsAutomaticDelivery(moduleVersions: unknown): boolean {
  if (!moduleVersions || typeof moduleVersions !== "object") return false;
  const m = moduleVersions as Record<string, unknown>;
  return m.evaluation_status === "approved" &&
    m.geometry_contract === "upright-pixels-v1" &&
    m.processing_contract_version === "canonical-upright-aligned-pixels-v2";
}

export const EMBEDDING_DIMENSIONS = 128;
export const CANDIDATE_QUERY_LIMIT = 20;
export const CANDIDATE_DISTANCE_LIMIT = 1;
export const MAX_PHOTO_FACES = 100;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMatchingUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
}

export function isUnitScore(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

/** No Number(...) coercion: null, booleans and numeric strings are not vectors.
 * Max-component scaling makes normalization safe for finite extreme magnitudes.
 */
export function normalizeFaceEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) return [];
  let maximum = 0;
  for (let i = 0; i < value.length; i++) {
    const component: unknown = value[i];
    if (!finite(component)) return [];
    maximum = Math.max(maximum, Math.abs(component));
  }
  if (maximum === 0) return [];
  const scaled = value.map((component: number) => component / maximum);
  const norm = Math.sqrt(
    scaled.reduce((sum, component) => sum + component * component, 0),
  );
  if (!finite(norm) || norm <= 0) return [];
  return scaled.map((component) => component / norm);
}
