/** One durable access-token revocation contract for Worker and native Edge.
 * Callers must verify signatures/claims first. Reads are snapshots, not fences
 * with later business writes, and do not establish hosted replication behavior. */
import { parseCredentialJson } from "../supabase/functions/_shared/credential-json.ts";
import { faceConsentTimestamp as strictTimestamp } from "./face-consent-policy.ts";

export type AccessSessionBinding = { jti: string; user_id: string; exp: number };
export type AccessSessionRevocationPort = (path: string, init: RequestInit) => Promise<Response>;
export class AccessSessionRevocationError extends Error {
  constructor(readonly code: "invalid_token" | "access_session_revocation_unavailable" = "access_session_revocation_unavailable",
    readonly status = code === "invalid_token" ? 401 : 503) {
    super(code); this.name = "AccessSessionRevocationError";
  }
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[^A-Za-z0-9._:-]/.test(value);
}
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function canonicalAccessSessionId(value: string): Promise<string> {
  if (typeof value !== "string" || !value.length || value.length > 128) throw new AccessSessionRevocationError("invalid_token");
  return validId(value) ? value : "jti-sha256:" + await digest(value);
}
function checkBinding(binding: AccessSessionBinding, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (!uuid(binding.user_id) || !validId(binding.jti) || !Number.isSafeInteger(binding.exp) ||
    binding.exp <= nowSeconds || binding.exp > nowSeconds + 930) {
    throw new AccessSessionRevocationError("invalid_token");
  }
}

export async function accessSessionBinding(claims: { sub: string; exp: number; jti?: string },
  verifiedToken: string): Promise<AccessSessionBinding> {
  if (!uuid(claims.sub) || typeof verifiedToken !== "string" || !verifiedToken || verifiedToken.length > 8192 ||
    (claims.jti !== undefined && (typeof claims.jti !== "string" || !claims.jti.length || claims.jti.length > 128))) {
    throw new AccessSessionRevocationError("invalid_token");
  }
  let id = claims.jti;
  if (id === undefined) {
    // Existing no-jti signed credentials remain revocable in both runtimes.
    // This is a token digest identity, never an implicit role or signature proof.
    id = "legacy-sha256:" + await digest(verifiedToken);
  } else if (!validId(id)) {
    // Accepted legacy signed IDs may contain Unicode/whitespace/control bytes.
    // Map their exact UTF-8 value without narrowing either verifier's contract.
    id = await canonicalAccessSessionId(id);
  }
  const binding = { jti: id, user_id: claims.sub.toLowerCase(), exp: claims.exp };
  checkBinding(binding);
  return binding;
}

export function accessSessionRevocationReadPath(binding: AccessSessionBinding): string {
  checkBinding(binding);
  return `edge_session_revocations?jti=eq.${encodeURIComponent(binding.jti)}&select=jti,user_id,revoked_at,expires_at&limit=2`;
}

function validatedRow(value: unknown, binding: AccessSessionBinding, receipt: boolean): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AccessSessionRevocationError();
  const row = value as Record<string, unknown>;
  const fields = receipt ? ["status", "jti", "user_id", "revoked_at", "expires_at"] : ["jti", "user_id", "revoked_at", "expires_at"];
  const revokedAt = strictTimestamp(row.revoked_at), expiresAt = strictTimestamp(row.expires_at);
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key)) ||
    row.jti !== binding.jti || !uuid(row.user_id) || row.user_id.toLowerCase() !== binding.user_id ||
    revokedAt === null || expiresAt === null || revokedAt < 0 || revokedAt > Date.now() + 30_000 ||
    revokedAt >= expiresAt || expiresAt < binding.exp * 1000 ||
    (receipt && row.status !== "revoked")) throw new AccessSessionRevocationError();
}

export function accessSessionRevocationRows(value: unknown, binding: AccessSessionBinding): boolean {
  checkBinding(binding);
  if (!Array.isArray(value) || value.length > 1) throw new AccessSessionRevocationError();
  if (value.length === 0) return false;
  validatedRow(value[0], binding, false);
  return true;
}

export function accessSessionRevocationReceipt(value: unknown, binding: AccessSessionBinding): void {
  checkBinding(binding);
  validatedRow(value, binding, true);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    try { void response.body?.cancel().catch(() => {}); } catch {}
    throw new AccessSessionRevocationError();
  }
  const declared = response.headers.get("content-length");
  // Fetch runtimes decompress response bytes while retaining transport headers.
  // The decoded-byte budget remains enforced; compare lengths only for identity.
  const identityEncoding = ["", "identity"].includes((response.headers.get("content-encoding") ?? "").trim().toLowerCase());
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > 4096)) {
    try { void response.body?.cancel().catch(() => {}); } catch {}
    throw new AccessSessionRevocationError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AccessSessionRevocationError();
  const bytes = new Uint8Array(4096);
  let used = 0, emptyChunks = 0, done = false;
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch {} };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new AccessSessionRevocationError();
      const chunk = await reader.read();
      if (signal.aborted) throw new AccessSessionRevocationError();
      if (chunk.done) { done = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw new AccessSessionRevocationError();
      if (!chunk.value.length) { if (++emptyChunks > 128) throw new AccessSessionRevocationError(); continue; }
      emptyChunks = 0;
      if (chunk.value.length > bytes.length - used) throw new AccessSessionRevocationError();
      bytes.set(chunk.value, used); used += chunk.value.length;
    }
    if (identityEncoding && declared !== null && Number(declared) !== used) throw new AccessSessionRevocationError();
    return parseCredentialJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used)), 4096);
  } finally {
    signal.removeEventListener("abort", cancel);
    bytes.fill(0);
    if (!done) cancel();
    try { reader.releaseLock(); } catch {}
  }
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const parentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", parentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 5000);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new AccessSessionRevocationError());
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    if (parentSignal?.aborted) throw new AccessSessionRevocationError();
    return await Promise.race([run(controller.signal), aborted]);
  } catch (error) {
    if (error instanceof AccessSessionRevocationError) throw error;
    throw new AccessSessionRevocationError();
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", parentAbort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

export async function checkAccessSessionRevocation(port: AccessSessionRevocationPort,
  binding: AccessSessionBinding, parentSignal?: AbortSignal): Promise<boolean> {
  const path = accessSessionRevocationReadPath(binding);
  return withDeadline(async signal => accessSessionRevocationRows(
    await readBoundedJson(await port(path, { method: "GET", signal }), signal), binding,
  ), parentSignal);
}

export async function revokeAccessSession(port: AccessSessionRevocationPort,
  binding: AccessSessionBinding, parentSignal?: AbortSignal): Promise<void> {
  checkBinding(binding);
  await withDeadline(async signal => {
    const response = await port("rpc/edge_revoke_access_session_v1", {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ p_jti: binding.jti, p_user_id: binding.user_id, p_expires_at: new Date(binding.exp * 1000).toISOString() }),
    });
    accessSessionRevocationReceipt(await readBoundedJson(response, signal), binding);
  }, parentSignal);
}
