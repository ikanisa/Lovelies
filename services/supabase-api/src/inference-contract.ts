/** Private, still-image consumer contract. This identity is deliberately separate
 * from the native protocol/model name and never relabels historical templates. */
export const INFERENCE_ENGINE_SPACE = 'lovelies-sface-openface-still-v1';
export const INFERENCE_MODEL_ID = 'opencv-yunet-sface-2021dec-v1';
export const INFERENCE_MODEL_HASHES = Object.freeze({
  yunet: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  sface: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
});
export const INFERENCE_CAPABILITIES = Object.freeze([
  'face_registration', 'face_comparison', 'face_replacement', 'photo_processing',
]);
export const INFERENCE_LIMITS = Object.freeze({
  image_bytes: 20 * 1024 * 1024, image_pixels: 40_000_000, faces: 100,
  profiles: 1000, face_body_bytes: 12 * 1024 * 1024, photo_body_bytes: 40 * 1024 * 1024,
});
export const INFERENCE_REPLY_BYTES = 6 * 1024 * 1024;
export const INFERENCE_READY_BYTES = 64 * 1024;
export interface InferenceBinding {
  engine_space: string; engine_artifact_sha256: string; processing_fingerprint: string;
  request_id: string; request_sha256: string;
}
export const sha256Identity = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function exactBinding(result: Record<string, unknown>, expected: InferenceBinding): boolean {
  return Object.entries(expected).every(([key, value]) => result[key] === value);
}
export function exactReadiness(result: Record<string, any>, artifact: string, processing: string): boolean {
  return result.available === true && result.engine_space === INFERENCE_ENGINE_SPACE &&
    result.engine_artifact_sha256 === artifact && result.processing_fingerprint === processing &&
    result.model_id === INFERENCE_MODEL_ID && result.liveness_required === false &&
    result.model_hashes && typeof result.model_hashes === 'object' && !Array.isArray(result.model_hashes) &&
    Object.entries(INFERENCE_MODEL_HASHES).every(([key, value]) => result.model_hashes[key] === value) &&
    Array.isArray(result.capabilities) && result.capabilities.length === INFERENCE_CAPABILITIES.length &&
    new Set(result.capabilities).size === result.capabilities.length &&
    INFERENCE_CAPABILITIES.every(capability => result.capabilities.includes(capability)) &&
    result.limits && typeof result.limits === 'object' && !Array.isArray(result.limits) &&
    Object.entries(INFERENCE_LIMITS).every(([key, value]) => result.limits[key] === value);
}
