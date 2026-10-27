import { ApiError } from './types.ts';

// Limits apply to incoming request-body acquisition only. They do not cancel
// already-dispatched storage or database work.
export const UPLOAD_BODY_IDLE_MS = 120_000;
export const UPLOAD_BODY_SOURCE_TOTAL_MS = 60 * 60_000;
export const UPLOAD_BODY_CHUNK_TOTAL_MS = 30 * 60_000;
export const UPLOAD_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const UPLOAD_BODY_MAX_FRAGMENTS = 4096;
export const UPLOAD_BODY_MAX_EMPTY_FRAGMENTS = 16;

// Inspect built-in slots rather than overridable byteLength/buffer/tag fields.
// The ArrayBuffer getter rejects shared backing stores before copying.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayKind = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const uint8Set = Uint8Array.prototype.set;
function byteLength(value: unknown): number {
    try {
        if (!ArrayBuffer.isView(value) || typedArrayKind.call(value) !== 'Uint8Array') throw new Error();
        arrayBufferLength.call(typedArrayBuffer.call(value));
        return typedArrayLength.call(value) as number;
    } catch { throw new ApiError(400, 'invalid_upload_body'); }
}

export class UploadBodyReader {
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    private readonly deadline: number;
    private fragments = 0;
    private empties = 0;
    constructor(private readonly request: Request, totalMs: number) {
        if (!request.body) throw new ApiError(400, 'image_required');
        try { this.reader = request.body.getReader(); }
        catch { throw new ApiError(400, 'image_required'); }
        this.deadline = performance.now() + totalMs;
    }
    guard(): void {
        if (this.request.signal.aborted) throw new ApiError(400, 'upload_body_aborted');
        if (performance.now() >= this.deadline) throw new ApiError(408, 'upload_body_timeout');
    }
    async readInto(target: Uint8Array, offset: number, tooLargeCode: string): Promise<{ done: boolean; length: number }> {
        this.guard();
        const remaining = this.deadline - performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ApiError(408, 'upload_body_timeout')), Math.min(UPLOAD_BODY_IDLE_MS, remaining));
            onAbort = () => reject(new ApiError(400, 'upload_body_aborted'));
            this.request.signal.addEventListener('abort', onAbort, { once: true });
            if (this.request.signal.aborted) onAbort();
        });
        try {
            const next = await Promise.race([this.reader.read(), interrupted]);
            this.guard();
            if (next.done) return { done: true, length: 0 };
            const view = next.value;
            const length = byteLength(view);
            if (++this.fragments > UPLOAD_BODY_MAX_FRAGMENTS) throw new ApiError(413, 'upload_body_fragment_limit');
            this.empties = length === 0 ? this.empties + 1 : 0;
            if (this.empties > UPLOAD_BODY_MAX_EMPTY_FRAGMENTS) throw new ApiError(413, 'upload_body_fragment_limit');
            if (length > target.byteLength - offset) throw new ApiError(413, tooLargeCode);
            // Copy synchronously before any further await; never clear a producer-owned view.
            try { uint8Set.call(target, view, offset); }
            catch { throw new ApiError(400, 'invalid_upload_body'); }
            return { done: false, length };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (onAbort) this.request.signal.removeEventListener('abort', onAbort);
        }
    }
    close(): void {
        try { void this.reader.cancel().catch(() => {}); } catch { /* cleanup is best effort */ }
        try { this.reader.releaseLock(); } catch { /* an uncooperative producer may still be settling */ }
    }
}
