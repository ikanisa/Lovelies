/** One photo-result generation and immutable result lookup. Small control
 * receipts are bounded and strict. A canceled/failed response cannot establish
 * rollback; commit is never automatically retried or followed by failure writes.
 * PostgreSQL still owns current authority, source, policy and atomic writes.
 * Canonical face arrays use the caller's larger bounded database reader. */
import { readCredentialJson } from "../supabase/functions/_shared/credential-json.ts";
import { faceConsentTimestamp } from "./face-consent-policy.ts";
import { isMatchingUuid, isRecord } from "./photo-matching-contract.ts";
import {
  photoResultSqlAuthority,
  type PhotoResultAuthority,
} from "./photo-result-authority.ts";

export const photoResultProtocol = "photo-result-v1";
export type PhotoResultMode = "process" | "validation_only";
export class PhotoResultError extends Error {
  constructor(
    readonly code:
      | "input_invalid"
      | "receipt_unverified"
      | "authority_changed"
      | "commit_unconfirmed",
  ) {
    super(`photo_result_${code}`);
    this.name = "PhotoResultError";
  }
}
const fail = (code: PhotoResultError["code"] = "input_invalid"): never => {
  throw new PhotoResultError(code);
};
const uuid4 = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const sha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const keys = (value: Record<string, unknown>, wanted: readonly string[]) =>
  Object.keys(value).length === wanted.length &&
  wanted.every((key) => Object.hasOwn(value, key));
const objectKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\u0000-\u001f\u007f\\]/.test(value) &&
  !value.startsWith("/") &&
  value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
const mode = (value: unknown): value is PhotoResultMode =>
  value === "process" || value === "validation_only";
export function photoResultPreviewKey(
  assetId: string,
  requestId: string,
  candidateId: string,
  sourceSha256: string,
  transformPolicy: string,
): string {
  if (
    !isMatchingUuid(assetId) ||
    !uuid4(requestId) ||
    !uuid4(candidateId) ||
    !sha256(sourceSha256) ||
    typeof transformPolicy !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(transformPolicy)
  )
    return fail();
  return `renditions/previews/watermarked/${assetId}/${requestId}/${candidateId}/${sourceSha256}-${transformPolicy}.jpg`;
}
const previewKeyFor = (
  key: unknown,
  requestId: string,
  candidateId: string,
): key is string => {
  if (!objectKey(key)) return false;
  const parts = key.split("/");
  return (
    parts.length === 7 &&
    parts.slice(0, 3).join("/") === "renditions/previews/watermarked" &&
    isMatchingUuid(parts[3]) &&
    parts[4] === requestId &&
    parts[5] === candidateId &&
    /^[0-9a-f]{64}-[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.jpg$/.test(parts[6])
  );
};
const sourceFields = [
  "asset_id",
  "event_id",
  "object_key",
  "content_type",
  "status",
  "byte_size",
  "checksum_sha256",
  "uploaded_by",
  "creator_user_id",
  "deleted_at",
  "contribution_purpose",
];
export function photoResultSource(
  value: unknown,
  assetId: string,
): Readonly<Record<string, unknown>> {
  if (
    !isMatchingUuid(assetId) ||
    !isRecord(value) ||
    !keys(value, sourceFields) ||
    value.asset_id !== assetId ||
    !["event_id", "uploaded_by", "creator_user_id"].every(
      (key) => value[key] === null || isMatchingUuid(value[key]),
    ) ||
    !objectKey(value.object_key) ||
    typeof value.content_type !== "string" ||
    ![
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ].includes(value.content_type) ||
    typeof value.status !== "string" ||
    !["uploaded", "queued", "processing", "processed", "failed"].includes(
      value.status,
    ) ||
    !(
      value.byte_size === null ||
      (positive(value.byte_size) && value.byte_size <= 20 * 1024 * 1024)
    ) ||
    !(value.checksum_sha256 === null || sha256(value.checksum_sha256)) ||
    value.deleted_at !== null ||
    !(
      value.contribution_purpose === null ||
      (typeof value.contribution_purpose === "string" &&
        /^[a-z][a-z0-9_-]{0,63}$/.test(value.contribution_purpose))
    )
  )
    return fail();
  return Object.freeze(
    Object.fromEntries(sourceFields.map((key) => [key, value[key]])),
  );
}
export type PhotoResultAttempt = Readonly<{
  requestId: string;
  assetId: string;
  generation: number;
  token: string;
  sourceRevision: string;
  policyRevision: string;
  expiresAt: string;
  mode: PhotoResultMode;
  privatePhoto: boolean;
}>;
function requireAttempt(
  value: PhotoResultAttempt,
  nowMs: number,
  current = true,
) {
  if (
    !uuid4(value.requestId) ||
    !isMatchingUuid(value.assetId) ||
    !uuid4(value.token) ||
    !positive(value.generation) ||
    !sha256(value.sourceRevision) ||
    !sha256(value.policyRevision) ||
    !mode(value.mode) ||
    typeof value.privatePhoto !== "boolean" ||
    faceConsentTimestamp(value.expiresAt) === null ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    (current &&
      (faceConsentTimestamp(value.expiresAt)! <= nowMs ||
        faceConsentTimestamp(value.expiresAt)! > nowMs + 930_000))
  )
    return fail();
}
function ownAttempt(
  value: PhotoResultAttempt,
  nowMs: number,
  current = true,
): PhotoResultAttempt {
  const owned = Object.freeze({ ...value });
  requireAttempt(owned, nowMs, current);
  return owned;
}
export type PreparedPhotoResult = Readonly<{
  text: string;
  sha256: string;
  sourceRevision: string;
  policyRevision: string;
  faceIds: readonly string[];
  matchCount: number;
  previewCandidateId: string | null;
}>;
const payloadFields = [
  "schema",
  "source_revision",
  "policy_revision",
  "faces",
  "selected_candidates",
  "matches",
  "policy",
  "media_result",
  "preview_candidate",
  "audit",
];
/** Own and serialize every proposed field before the first await. Reject values
 * JSON would silently discard/coerce, so the digest binds the actual proposals. */
export async function preparePhotoResult(
  value: unknown,
  attempt: PhotoResultAttempt,
): Promise<PreparedPhotoResult> {
  attempt = ownAttempt(attempt, Date.now());
  if (
    !isRecord(value) ||
    !keys(value, payloadFields) ||
    value.schema !== "photo-result-payload-v1" ||
    value.source_revision !== attempt.sourceRevision ||
    value.policy_revision !== attempt.policyRevision ||
    !["faces", "matches", "selected_candidates"].every(
      (key) => Array.isArray(value[key]) && value[key].length <= 100,
    ) ||
    !["policy", "media_result", "audit"].every((key) => isRecord(value[key])) ||
    !(value.preview_candidate === null || isRecord(value.preview_candidate))
  )
    return fail();
  let nodes = 0;
  const ancestors = new Set<object>();
  const jsonValue = (item: unknown, depth = 0): void => {
    if (++nodes > 65_000 || depth > 20) return fail();
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      !item ||
      typeof item !== "object" ||
      ancestors.has(item) ||
      (!Array.isArray(item) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
    )
      return fail();
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let n = 0; n < item.length; n++) {
        if (!Object.hasOwn(item, n)) return fail();
        jsonValue(item[n], depth + 1);
      }
    } else {
      for (const property of Reflect.ownKeys(item)) {
        if (typeof property !== "string") return fail();
        jsonValue((item as Record<string, unknown>)[property], depth + 1);
      }
    }
    ancestors.delete(item);
  };
  jsonValue(value);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return fail();
  }
  const owned = JSON.parse(text) as Record<string, unknown>;
  const faces = owned.faces as Record<string, unknown>[];
  const matches = owned.matches as Record<string, unknown>[];
  if (
    !faces.every(
      (face) =>
        isRecord(face) &&
        isMatchingUuid(face.id) &&
        face.media_asset_id === attempt.assetId,
    ) ||
    new Set(faces.map((face) => face.id)).size !== faces.length ||
    !matches.every(
      (row) =>
        isRecord(row) &&
        isMatchingUuid(row.id) &&
        row.media_asset_id === attempt.assetId &&
        isMatchingUuid(row.user_id) &&
        faces.some((face) => face.id === row.detected_face_id),
    ) ||
    new Set(matches.map((row) => `${row.detected_face_id}:${row.user_id}`))
      .size !== matches.length
  )
    return fail();
  const preview = owned.preview_candidate as Record<string, unknown> | null;
  if (preview !== null && !uuid4(preview.id)) return fail();
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 1024 * 1024) {
    bytes.fill(0);
    return fail();
  }
  let hash: string;
  try {
    hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
  } finally {
    bytes.fill(0);
  }
  return Object.freeze({
    text,
    sha256: hash,
    sourceRevision: attempt.sourceRevision,
    policyRevision: attempt.policyRevision,
    faceIds: Object.freeze(faces.map((face) => String(face.id))),
    matchCount: matches.length,
    previewCandidateId: preview === null ? null : String(preview.id),
  });
}
export type PhotoResultReceipt = Readonly<{
  requestId: string;
  assetId: string;
  generation: number;
  payloadSha256: string;
  faceIds: readonly string[];
  matchIds: readonly string[];
  privateProposalCount: number;
  previewCandidateId: string | null;
}>;
function denied(value: unknown, requestId: string): boolean {
  return (
    isRecord(value) &&
    keys(value, ["protocol", "outcome", "request_id"]) &&
    value.protocol === photoResultProtocol &&
    value.outcome === "denied" &&
    value.request_id === requestId
  );
}
export function photoResultReceipt(
  value: unknown,
  attempt: PhotoResultAttempt,
  payload: PreparedPhotoResult,
): PhotoResultReceipt {
  if (denied(value, attempt.requestId)) return fail("authority_changed");
  if (
    !isRecord(value) ||
    !keys(value, [
      "protocol",
      "outcome",
      "request_id",
      "asset_id",
      "generation",
      "payload_sha256",
      "face_ids",
      "match_ids",
      "private_proposal_count",
      "media_status",
      "preview_candidate_id",
    ]) ||
    value.protocol !== photoResultProtocol ||
    value.outcome !== "committed" ||
    value.request_id !== attempt.requestId ||
    value.asset_id !== attempt.assetId ||
    value.generation !== attempt.generation ||
    value.payload_sha256 !== payload.sha256 ||
    value.media_status !== "processed" ||
    value.preview_candidate_id !== payload.previewCandidateId ||
    !["face_ids", "match_ids"].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].length <= 100 &&
        value[key].every(isMatchingUuid) &&
        new Set(value[key]).size === value[key].length,
    ) ||
    (value.face_ids as string[]).length !== payload.faceIds.length ||
    !(value.face_ids as string[]).every((id) => payload.faceIds.includes(id)) ||
    (value.match_ids as string[]).length !==
      (attempt.privatePhoto ? 0 : payload.matchCount) ||
    !Number.isSafeInteger(value.private_proposal_count) ||
    Number(value.private_proposal_count) < 0 ||
    Number(value.private_proposal_count) >
      (attempt.privatePhoto ? payload.matchCount : 0)
  )
    return fail("receipt_unverified");
  return Object.freeze({
    requestId: attempt.requestId,
    assetId: attempt.assetId,
    generation: attempt.generation,
    payloadSha256: payload.sha256,
    faceIds: Object.freeze((value.face_ids as string[]).slice()),
    matchIds: Object.freeze((value.match_ids as string[]).slice()),
    privateProposalCount: Number(value.private_proposal_count),
    previewCandidateId: payload.previewCandidateId,
  });
}

export function createPhotoResultRepository(
  transport: (path: string, init: RequestInit) => Promise<Response>,
  options: Readonly<{ timeoutMs?: number; now?: () => number }> = {},
) {
  const timeoutMs = options.timeoutMs ?? 10_000,
    now = options.now ?? Date.now;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    return fail();
  async function rpc(
    name: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const encoded = JSON.stringify(body); // own all fields before transport awaits
    const controller = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    if (active.aborted) return fail("receipt_unverified");
    const deadline = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new PhotoResultError("receipt_unverified"));
      active.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    const task = (async () => {
      const response = await transport(`rpc/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encoded,
        signal: active,
      });
      if (active.aborted || performance.now() >= deadline || !response.ok) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {}
        return fail(
          !active.aborted &&
            performance.now() < deadline &&
            response.status === 403
            ? "authority_changed"
            : "receipt_unverified",
        );
      }
      const headers = new Headers({
        "content-type": response.headers.get("content-type") ?? "",
      });
      if (
        ["", "identity"].includes(
          (response.headers.get("content-encoding") ?? "").trim().toLowerCase(),
        )
      ) {
        const length = response.headers.get("content-length");
        if (length !== null) headers.set("content-length", length);
      }
      const result = await readCredentialJson(
        new Request("https://photo-result-parser.invalid", {
          method: "POST",
          headers,
          body: response.body,
          signal: active,
          ...{ duplex: "half" },
        }),
        false,
        timeoutMs,
      );
      if (active.aborted || performance.now() >= deadline)
        return fail("receipt_unverified");
      return result;
    })();
    try {
      return await Promise.race([task, stopped]);
    } catch (error) {
      if (error instanceof PhotoResultError) throw error;
      return fail("receipt_unverified");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      active.removeEventListener("abort", onAbort);
    }
  }
  return Object.freeze({
    async begin(
      input: Readonly<{
        requestId: string;
        assetId: string;
        source: unknown;
        authority: PhotoResultAuthority;
        mode: PhotoResultMode;
      }>,
      signal?: AbortSignal,
    ): Promise<PhotoResultAttempt> {
      if (!uuid4(input.requestId) || !mode(input.mode)) return fail();
      const source = photoResultSource(input.source, input.assetId);
      const authority = photoResultSqlAuthority(
        input.authority,
        input.assetId,
        now(),
      );
      const requestId = input.requestId,
        assetId = input.assetId,
        selectedMode = input.mode;
      const value = await rpc(
        "begin_photo_result_v1",
        {
          p_request_id: requestId,
          p_asset_id: assetId,
          p_source: source,
          p_authority: authority,
          p_mode: selectedMode,
        },
        signal,
      );
      if (denied(value, requestId)) return fail("authority_changed");
      if (
        !isRecord(value) ||
        !keys(value, [
          "protocol",
          "outcome",
          "request_id",
          "asset_id",
          "generation",
          "token",
          "source_revision",
          "policy_revision",
          "expires_at",
          "mode",
        ]) ||
        value.protocol !== photoResultProtocol ||
        value.outcome !== "begun" ||
        value.request_id !== requestId ||
        value.asset_id !== assetId ||
        value.mode !== selectedMode
      )
        return fail("receipt_unverified");
      const attempt = {
        requestId,
        assetId,
        generation: value.generation as number,
        token: value.token as string,
        sourceRevision: value.source_revision as string,
        policyRevision: value.policy_revision as string,
        expiresAt: value.expires_at as string,
        mode: selectedMode,
        privatePhoto: String(source.object_key).startsWith("contributions/"),
      };
      try {
        requireAttempt(attempt, now());
      } catch {
        return fail("receipt_unverified");
      }
      return Object.freeze(attempt);
    },
    async pin(
      attempt: PhotoResultAttempt,
      observed: Readonly<{
        byteSize: number;
        sha256: string;
        contentType: string;
        storageIdentity?: unknown;
      }>,
      signal?: AbortSignal,
    ): Promise<PhotoResultAttempt> {
      attempt = ownAttempt(attempt, now());
      if (
        !positive(observed.byteSize) ||
        observed.byteSize > 20 * 1024 * 1024 ||
        !sha256(observed.sha256) ||
        ![
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/heic",
          "image/heif",
        ].includes(observed.contentType)
      )
        return fail();
      const identity = observed.storageIdentity ?? null;
      if (
        identity !== null &&
        (!isRecord(identity) ||
          !keys(identity, ["version", "etag"]) ||
          !["version", "etag"].every(
            (key) =>
              typeof identity[key] === "string" &&
              identity[key].length >= 1 &&
              identity[key].length <= 256 &&
              !/[\u0000-\u001f\u007f]/.test(identity[key]),
          ))
      )
        return fail();
      const value = await rpc(
        "pin_photo_result_source_v1",
        {
          p_request_id: attempt.requestId,
          p_token: attempt.token,
          p_byte_size: observed.byteSize,
          p_checksum_sha256: observed.sha256,
          p_content_type: observed.contentType,
          p_storage_identity: identity,
        },
        signal,
      );
      if (denied(value, attempt.requestId)) return fail("authority_changed");
      if (
        !isRecord(value) ||
        !keys(value, [
          "protocol",
          "outcome",
          "request_id",
          "asset_id",
          "generation",
          "source_revision",
          "policy_revision",
          "expires_at",
        ]) ||
        value.protocol !== photoResultProtocol ||
        value.outcome !== "pinned" ||
        value.request_id !== attempt.requestId ||
        value.asset_id !== attempt.assetId ||
        value.generation !== attempt.generation ||
        value.policy_revision !== attempt.policyRevision ||
        value.expires_at !== attempt.expiresAt ||
        !sha256(value.source_revision)
      )
        return fail("receipt_unverified");
      const pinned = Object.freeze({
        ...attempt,
        sourceRevision: value.source_revision,
      });
      requireAttempt(pinned, now());
      return pinned;
    },
    async commit(
      attempt: PhotoResultAttempt,
      payload: PreparedPhotoResult,
      signal?: AbortSignal,
    ): Promise<PhotoResultReceipt> {
      attempt = ownAttempt(attempt, now());
      payload = Object.freeze({
        ...payload,
        faceIds: Object.freeze(payload.faceIds.slice()),
      });
      if (
        !sha256(payload.sha256) ||
        payload.sourceRevision !== attempt.sourceRevision ||
        payload.policyRevision !== attempt.policyRevision ||
        typeof payload.text !== "string" ||
        new TextEncoder().encode(payload.text).length > 1024 * 1024
      )
        return fail();
      try {
        return photoResultReceipt(
          await rpc(
            "commit_photo_result_v1",
            {
              p_request_id: attempt.requestId,
              p_token: attempt.token,
              p_payload_text: payload.text,
              p_payload_sha256: payload.sha256,
            },
            signal,
          ),
          attempt,
          payload,
        );
      } catch {
        return fail("commit_unconfirmed");
      }
    },
    async lookup(
      attempt: PhotoResultAttempt,
      payload: PreparedPhotoResult,
      signal?: AbortSignal,
    ): Promise<PhotoResultReceipt | null> {
      attempt = ownAttempt(attempt, now(), false);
      payload = Object.freeze({
        ...payload,
        faceIds: Object.freeze(payload.faceIds.slice()),
      });
      if (!sha256(payload.sha256)) return fail();
      const value = await rpc(
        "lookup_photo_result_v1",
        {
          p_request_id: attempt.requestId,
          p_token: attempt.token,
          p_payload_sha256: payload.sha256,
        },
        signal,
      );
      if (
        isRecord(value) &&
        keys(value, ["protocol", "outcome", "request_id", "generation"]) &&
        value.protocol === photoResultProtocol &&
        value.outcome === "pending" &&
        value.request_id === attempt.requestId &&
        value.generation === attempt.generation
      )
        return null;
      return photoResultReceipt(value, attempt, payload);
    },
    async fail(
      attempt: PhotoResultAttempt,
      errorCode: string,
      signal?: AbortSignal,
      functionName?: string,
    ): Promise<boolean> {
      attempt = ownAttempt(attempt, now());
      if (
        typeof errorCode !== "string" ||
        !/^[a-z][a-z0-9_]{0,119}$/.test(errorCode)
      )
        return fail();
      if (functionName !== undefined && (typeof functionName !== "string"
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(functionName))) return fail();
      const value = await rpc(
        "fail_photo_result_v1",
        {
          p_request_id: attempt.requestId,
          p_token: attempt.token,
          p_error_code: errorCode,
          p_function_name: functionName ?? null,
        },
        signal,
      );
      if (denied(value, attempt.requestId)) return false;
      if (
        !isRecord(value) ||
        !keys(value, [
          "protocol",
          "outcome",
          "request_id",
          "asset_id",
          "generation",
          "error_code",
        ]) ||
        value.protocol !== photoResultProtocol ||
        value.outcome !== "failed" ||
        value.request_id !== attempt.requestId ||
        value.asset_id !== attempt.assetId ||
        value.generation !== attempt.generation ||
        value.error_code !== errorCode
      )
        return fail("receipt_unverified");
      return true;
    },
    async registerPreview(
      attempt: PhotoResultAttempt,
      input: Readonly<{
        candidateId: string;
        objectKey: string;
        contentType: "image/jpeg";
        byteSize: number;
        sha256: string;
      }>,
      signal?: AbortSignal,
    ) {
      attempt = ownAttempt(attempt, now());
      input = Object.freeze({ ...input });
      if (
        !uuid4(input.candidateId) ||
        !previewKeyFor(input.objectKey, attempt.requestId, input.candidateId) ||
        input.objectKey.split("/")[3] !== attempt.assetId ||
        input.contentType !== "image/jpeg" ||
        !positive(input.byteSize) ||
        input.byteSize > 20 * 1024 * 1024 ||
        !sha256(input.sha256)
      )
        return fail();
      const value = await rpc(
        "register_photo_result_preview_v1",
        {
          p_request_id: attempt.requestId,
          p_token: attempt.token,
          p_candidate_id: input.candidateId,
          p_object_key: input.objectKey,
          p_content_type: input.contentType,
          p_byte_size: input.byteSize,
          p_checksum_sha256: input.sha256,
        },
        signal,
      );
      if (denied(value, attempt.requestId)) return fail("authority_changed");
      if (
        !isRecord(value) ||
        !keys(value, [
          "protocol",
          "outcome",
          "request_id",
          "asset_id",
          "generation",
          "candidate_id",
          "writer_token",
          "object_key",
          "content_type",
          "byte_size",
          "checksum_sha256",
        ]) ||
        value.protocol !== photoResultProtocol ||
        value.outcome !== "registered" ||
        value.request_id !== attempt.requestId ||
        value.asset_id !== attempt.assetId ||
        value.generation !== attempt.generation ||
        value.candidate_id !== input.candidateId ||
        !uuid4(value.writer_token) ||
        value.object_key !== input.objectKey ||
        value.content_type !== input.contentType ||
        value.byte_size !== input.byteSize ||
        value.checksum_sha256 !== input.sha256
      )
        return fail("receipt_unverified");
      requireAttempt(attempt, now());
      return Object.freeze({
        id: input.candidateId,
        writer_token: value.writer_token,
        object_key: input.objectKey,
        content_type: input.contentType,
        byte_size: input.byteSize,
        checksum_sha256: input.sha256,
      });
    },
    /** A deletion/404 only completes this sweep. Closed keys remain eligible for
     * repeated sweeps because an already-issued remote PUT can finish late. */
    async claimPreviewCleanup(limit = 25, signal?: AbortSignal) {
      if (!positive(limit) || limit > 25) return fail();
      const value = await rpc(
        "photo_result_preview_cleanup_claim_v1",
        { p_limit: limit },
        signal,
      );
      if (
        !isRecord(value) ||
        !keys(value, ["protocol", "outcome", "items"]) ||
        value.protocol !== photoResultProtocol ||
        value.outcome !== "claimed" ||
        !Array.isArray(value.items) ||
        value.items.length > limit
      )
        return fail("receipt_unverified");
      const ids = new Set<string>();
      const items = value.items.map((item) => {
        if (
          !isRecord(item) ||
          !keys(item, [
            "candidate_id",
            "request_id",
            "object_key",
            "cleanup_token",
            "cleanup_revision",
            "expires_at",
          ]) ||
          !uuid4(item.candidate_id) ||
          !uuid4(item.request_id) ||
          !uuid4(item.cleanup_token) ||
          !positive(item.cleanup_revision) ||
          !previewKeyFor(item.object_key, item.request_id, item.candidate_id) ||
          ids.has(item.candidate_id)
        )
          return fail("receipt_unverified");
        const expiry = faceConsentTimestamp(item.expires_at);
        if (expiry === null || expiry <= now() || expiry > now() + 930_000)
          return fail("receipt_unverified");
        ids.add(item.candidate_id);
        return Object.freeze({
          candidateId: item.candidate_id,
          requestId: item.request_id,
          objectKey: item.object_key,
          token: item.cleanup_token,
          revision: item.cleanup_revision,
          expiresAt: item.expires_at as string,
        });
      });
      return Object.freeze(items);
    },
    async acknowledgePreviewCleanup(
      item: Readonly<{
        candidateId: string;
        token: string;
        revision: number;
        expiresAt: string;
      }>,
      signal?: AbortSignal,
    ) {
      item = Object.freeze({ ...item });
      const expiry = faceConsentTimestamp(item.expiresAt);
      if (
        !uuid4(item.candidateId) ||
        !uuid4(item.token) ||
        !positive(item.revision) ||
        expiry === null ||
        expiry <= now() ||
        expiry > now() + 930_000
      )
        return fail();
      const value = await rpc(
        "photo_result_preview_cleanup_ack_v1",
        {
          p_candidate_id: item.candidateId,
          p_cleanup_token: item.token,
          p_cleanup_revision: item.revision,
        },
        signal,
      );
      if (
        !isRecord(value) ||
        !keys(value, [
          "protocol",
          "outcome",
          "candidate_id",
          "cleanup_revision",
        ]) ||
        value.protocol !== photoResultProtocol ||
        (value.outcome !== "acknowledged" && value.outcome !== "denied") ||
        value.candidate_id !== item.candidateId ||
        value.cleanup_revision !== item.revision
      )
        return fail("receipt_unverified");
      return value.outcome === "acknowledged";
    },
  });
}
