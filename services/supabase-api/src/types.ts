import type { RestoreTransactionScope } from './restore-transaction.ts';

export type Binding = string | number | null | ArrayBuffer;
export interface Database {
    invocation<T>(callback: () => T | Promise<T>): Promise<T>;
    /** Opt-in authority for one active invocation; the caller retains ownership
     * of its exact actor and a synchronous expiry check. */
    bindInvocationAuthority(check: () => Promise<void>, fresh: () => void): void;
    all<T = Record<string, unknown>>(sql: string, ...bindings: Binding[]): Promise<T[]>;
    one<T = Record<string, unknown>>(sql: string, ...bindings: Binding[]): Promise<T | null>;
    run(sql: string, ...bindings: Binding[]): Promise<void>;
    read<T>(callback: () => T | Promise<T>): Promise<T>;
    transaction<T>(callback: (restore: RestoreTransactionScope) => T | Promise<T>, intent?: unknown): Promise<T>;
}
export interface PrivateObject {
    size: number; etag: string; customMetadata?: Record<string,string>;
    httpMetadata?: {contentType?:string};
    arrayBuffer(): Promise<ArrayBuffer>;
    body: ReadableStream<Uint8Array> | null;
}
export interface PrivateBucket {
    get(key:string):Promise<PrivateObject|null>;
    // The bounded successful-info body is opt-in for a read-only preview;
    // cleanup/delete verification keeps the legacy waiting behavior.
    head(key:string,options?:{metadataBody?:'preview-read'}):Promise<Omit<PrivateObject,'body'|'arrayBuffer'>|null>;
    put(key:string,value:ArrayBuffer|Uint8Array,options?:{httpMetadata?:{contentType?:string},customMetadata?:Record<string,string>}):Promise<unknown>;
    delete(key:string|string[]):Promise<void>;
}
export interface ServiceFetcher {
    fetch(input:string|Request|URL,init?:RequestInit):Promise<Response>;
}
export type PhotoAuthorityStage = 'before_source' | 'after_source' | 'before_template' | 'after_template' | 'before_dispatch';
export type PhotoAuthorityProfile = Readonly<{ account_id:string; profile_id:string; revision:string; model_id:string }>;
export interface PhotoProcessorFetcher extends ServiceFetcher {
    fetch(input:string|Request|URL,init?:RequestInit,assertAuthority?:(stage:PhotoAuthorityStage,profile?:PhotoAuthorityProfile)=>Promise<void>):Promise<Response>;
}
export interface SupabaseEnv {
    PHOTOS: PrivateBucket; QUARANTINE: PrivateBucket; PRIVACY_EXPORTS: PrivateBucket;
    PHOTO_JOBS: {send(body:unknown):Promise<void>};
    FACE_AUTH_VERIFIER?: ServiceFetcher; PHOTO_PROCESSOR?: PhotoProcessorFetcher;
    MODEL_SERVICE_READINESS?: (signal?:AbortSignal)=>Promise<boolean>;
    INFERENCE_ENGINE_IDENTITY?: string;
    APP_ENV: string; AUTH_SIGNING_SECRET?:string; MEDIA_SIGNING_SECRET?:string;
    FACE_AUTH_POLICY_VERSION?:string; PHOTO_MODEL_VERSION?:string; PHOTO_CONSENT_POLICY_VERSION?:string;
    STORE_VERIFIER?:ServiceFetcher; PUSH_SERVICE?:ServiceFetcher;
    APPLE_BUNDLE_ID?:string; APPLE_APP_ID?:string; APPLE_SUBSCRIPTION_PRODUCT_ID?:string;
    GOOGLE_PLAY_PACKAGE_NAME?:string; GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID?:string;
    GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL?:string; GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY?:string;
    GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY_ID?:string; GOOGLE_PLAY_RTDN_AUDIENCE?:string;
    GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL?:string; ALLOWED_ORIGINS?:string; PUBLIC_APP_BASE_URL?:string;
    PUBLIC_API_BASE_URL?:string; INTERNAL_MAINTENANCE_SECRET?:string;
}
export type Actor = {
    accountId: string;
    sessionId: string;
    roles: string[];
    expiresAt: number;
    authEpoch: number;
    authMethod: "anonymous" | "registered_face";
};
export type AppContext = {
    db: Database;
    env: SupabaseEnv;
    now: () => number;
    authenticate: (request: Request) => Promise<Actor>;
    assertActor: (actor: Actor) => Promise<void>;
};
export class ApiError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
}
export const uuid = (value: unknown): string => {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw new ApiError(400, "invalid_id");
    return value.toLowerCase();
};
export const record = (value: unknown): Record<string, any> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ApiError(400, "invalid_input");
    return value as Record<string, any>;
};
// Intrinsic getters test internal slots across realms and bypass own/tag
// spoofing. In particular ArrayBuffer's getter rejects shared backing stores.
const bodyTypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bodyTypedArrayKind = Object.getOwnPropertyDescriptor(bodyTypedArrayPrototype, Symbol.toStringTag)!.get!;
const bodyTypedArrayLength = Object.getOwnPropertyDescriptor(bodyTypedArrayPrototype, 'byteLength')!.get!;
const bodyTypedArrayBuffer = Object.getOwnPropertyDescriptor(bodyTypedArrayPrototype, 'buffer')!.get!;
const bodyArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const bodyUint8Set = Uint8Array.prototype.set;
function bodyChunkLength(value: unknown, invalid: () => ApiError): number {
    try {
        if (!ArrayBuffer.isView(value) || bodyTypedArrayKind.call(value) !== 'Uint8Array') throw invalid();
        bodyArrayBufferLength.call(bodyTypedArrayBuffer.call(value));
        return bodyTypedArrayLength.call(value) as number;
    } catch { throw invalid(); }
}
export const JSON_BODY_LIMITS = Object.freeze({ timeoutMs: 55_000, fragments: 4096, emptyFragments: 16 });
export type JsonBodyOptions = { timeoutMs?: number; signal?: AbortSignal };
/** Bounds the bytes actually exposed by fetch. A decoded Response can retain
 * its encoded Content-Length; only native, unencoded Request bodies have an
 * exact declared-length contract here. This helper performs no decompression. */
export async function jsonBody(source: Request | Response, maximum = 2 * 1024 * 1024, options: JsonBodyOptions = {}): Promise<Record<string, any>> {
    const inbound = source instanceof Request;
    if (!inbound && !(source instanceof Response))
        throw new ApiError(400, 'invalid_input');
    if (!/^application\/json(?:;|$)/i.test(source.headers.get('content-type') ?? ''))
        throw new ApiError(415, 'json_required');
    const timeoutMs = options.timeoutMs ?? JSON_BODY_LIMITS.timeoutMs;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > JSON_BODY_LIMITS.timeoutMs)
        throw new ApiError(503, 'json_body_configuration_invalid');
    const inputSignal = inbound ? source.signal : undefined;
    const signals = [...new Set([inputSignal, options.signal].filter((value): value is AbortSignal => value !== undefined))];
    if (signals.some(signal => typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
        throw new ApiError(503, 'json_body_configuration_invalid');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try { reader = source.body?.getReader(); }
    catch { throw new ApiError(inbound ? 400 : 503, inbound ? 'json_body_unavailable' : 'upstream_json_body_unavailable'); }
    if (!reader)
        throw new ApiError(400, 'invalid_input');
    const chunks: Uint8Array[] = [];
    let bytes = 0, fragments = 0, emptyFragments = 0, done = false, stopped: ApiError | undefined;
    let rejectStopped!: (error: ApiError) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectStopped = reject; });
    void cancelled.catch(() => {});
    const stop = (error: ApiError): void => { if (!stopped) { stopped = error; rejectStopped(error); } };
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => stop(new ApiError(inbound ? 408 : 503, inbound ? 'json_body_timeout' : 'upstream_json_body_timeout')), timeoutMs);
    const onAbort = (): void => stop(new ApiError(inbound ? 400 : 503, inbound ? 'json_body_aborted' : 'upstream_json_body_aborted'));
    for (const signal of signals) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    }
    const check = (): void => {
        if (!stopped && Date.now() >= deadline) stop(new ApiError(inbound ? 408 : 503, inbound ? 'json_body_timeout' : 'upstream_json_body_timeout'));
        if (stopped) throw stopped;
    };
    try {
        check();
        let declared: number | undefined;
        if (inbound) {
            const encoding = source.headers.get('content-encoding');
            // Empty/malformed coding cannot silently exempt an inbound length.
            if (encoding !== null && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*,\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+)*$/.test(encoding))
                throw new ApiError(415, 'invalid_content_encoding');
            if (encoding === null || encoding.toLowerCase().split(/\s*,\s*/).every(coding => coding === 'identity')) {
                const length = source.headers.get('content-length');
                if (length !== null) {
                    if (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))
                        throw new ApiError(400, 'invalid_content_length');
                    declared = Number(length);
                    if (declared > maximum) throw new ApiError(413, 'request_too_large');
                }
            }
        }
        for (;;) {
            check();
            const next = await Promise.race([reader.read(), cancelled]);
            check();
            if (next.done) { done = true; break; }
            const length = bodyChunkLength(next.value, () => new ApiError(inbound ? 400 : 503, inbound ? 'invalid_input' : 'upstream_json_body_invalid_chunk'));
            if (++fragments > JSON_BODY_LIMITS.fragments) throw new ApiError(inbound ? 413 : 503, inbound ? 'request_fragment_limit' : 'upstream_json_body_fragment_limit');
            if (length === 0) {
                if (++emptyFragments > JSON_BODY_LIMITS.emptyFragments) throw new ApiError(inbound ? 413 : 503, inbound ? 'request_fragment_limit' : 'upstream_json_body_fragment_limit');
                continue;
            }
            emptyFragments = 0; bytes += length;
            if (bytes > maximum) throw new ApiError(413, 'request_too_large');
            // Copy synchronously before any later awaited read can reuse the
            // producer's backing buffer. Only these owned copies are cleared.
            const owned = new Uint8Array(length); bodyUint8Set.call(owned, next.value); chunks.push(owned);
        }
        if (declared !== undefined && declared !== bytes) throw new ApiError(400, 'request_length_mismatch');
        const all = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
        try {
            check();
            const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)));
            check(); return value;
        } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, 'invalid_json');
        } finally { all.fill(0); }
    } finally {
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener('abort', onAbort);
        for (const chunk of chunks) chunk.fill(0);
        // Cancellation is best-effort: its promise may never settle. No parser
        // result or timeout waits for it, and caller-owned bytes are untouched.
        if (!done) try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
        try { reader.releaseLock(); } catch {}
    }
}
export async function digest(value: string | Uint8Array): Promise<string> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))].map(v => v.toString(16).padStart(2, "0")).join("");
}
export function stable(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new ApiError(400, "invalid_input");
    return encoded;
}
export function ok(body: unknown, status = 200): Response {
    return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
