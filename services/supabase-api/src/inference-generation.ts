import { INFERENCE_ENGINE_SPACE, sha256Identity } from './inference-contract.ts';
import { ApiError, stable } from './types.ts';
import type { SupabaseEnv } from './types.ts';

const fields = ['engine_space', 'engine_artifact_sha256', 'processing_fingerprint'] as const;
type Selection = Pick<SupabaseEnv, 'INFERENCE_ENGINE_IDENTITY'>;

/** Private operation identity. Never infer it from a human-readable model name
 * or assign the selected generation to an existing unbound operation. */
export function encodeGeneration(value: unknown): string {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
            throw new Error();
        const keys = Reflect.ownKeys(value);
        if (keys.length !== fields.length || keys.some(key => !fields.includes(key as typeof fields[number])))
            throw new Error();
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (fields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')))
            throw new Error();
        const engine_space = descriptors.engine_space.value;
        const engine_artifact_sha256 = descriptors.engine_artifact_sha256.value;
        const processing_fingerprint = descriptors.processing_fingerprint.value;
        if (engine_space !== INFERENCE_ENGINE_SPACE || !sha256Identity(engine_artifact_sha256)
            || !sha256Identity(processing_fingerprint))
            throw new Error();
        return stable({ engine_space, engine_artifact_sha256, processing_fingerprint });
    } catch {
        throw new ApiError(503, 'inference_generation_unavailable');
    }
}

/** Require the exact canonical configuration string. Equality to its re-encoded
 * form also rejects duplicate JSON keys, whitespace and alternate key ordering. */
export function selectedGeneration(env: Selection): string {
    try {
        const selected = env.INFERENCE_ENGINE_IDENTITY;
        if (typeof selected !== 'string' || selected.length > 512)
            throw new Error();
        const canonical = encodeGeneration(JSON.parse(selected));
        if (selected !== canonical)
            throw new Error();
        return canonical;
    } catch {
        throw new ApiError(503, 'inference_generation_unavailable');
    }
}

export function assertGeneration(stored: unknown, env: Selection): string {
    const selected = selectedGeneration(env);
    if (typeof stored !== 'string' || stored !== selected)
        throw new ApiError(409, 'inference_generation_changed');
    return selected;
}
