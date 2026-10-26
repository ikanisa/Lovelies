import type { RestoreTransactionScope } from './restore-transaction.ts';

export type Binding = string | number | null | ArrayBuffer;
export interface Database {
    invocation<T>(callback: () => T | Promise<T>): Promise<T>;
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
    head(key:string):Promise<Omit<PrivateObject,'body'|'arrayBuffer'>|null>;
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
export async function jsonBody(request: Request, maximum = 2 * 1024 * 1024): Promise<Record<string, any>> {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
        throw new ApiError(415, "json_required");
    const reader = request.body?.getReader();
    if (!reader)
        throw new ApiError(400, "invalid_input");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            bytes += next.value.byteLength;
            if (bytes > maximum)
                throw new ApiError(413, "request_too_large");
            chunks.push(next.value);
        }
        const all = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.byteLength;
        }
        try {
            return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all)));
        }
        catch (error) {
            if (error instanceof ApiError)
                throw error;
            throw new ApiError(400, "invalid_json");
        }
        finally {
            all.fill(0);
        }
    }
    finally {
        for (const chunk of chunks)
            chunk.fill(0);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
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
