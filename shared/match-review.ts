/** Atomic operator review contracts. The SQL RPC owns the complete mutation;
 * transport failure never authorizes a fabricated row or an automatic retry. */
import { readCredentialJson } from "../supabase/functions/_shared/credential-json.ts";

export type MatchReviewAction =
  | "approve"
  | "reject"
  | "reassign"
  | "escalate"
  | "delete"
  | "audit";
export type MatchReviewAuthority = {
  matchId: string;
  adminId: string;
  accessJti: string;
  accessExpiry: number;
};
export type MatchReviewDecision = {
  action: MatchReviewAction;
  expectedRevision: string;
  reason: string | null;
  userId: string | null;
  faceProfileId: string | null;
};
export class MatchReviewError extends Error {
  constructor(
    readonly code:
      | "input_invalid"
      | "authority_changed"
      | "not_found"
      | "conflict"
      | "receipt_unverified",
  ) {
    super(code);
    this.name = "MatchReviewError";
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const revision = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const invalid = (): never => {
  throw new MatchReviewError("receipt_unverified");
};
const date = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
      value,
    )
  )
    return false;
  const ms = Date.parse(value);
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
  );
};
const nullableDate = (value: unknown) => value === null || date(value);
const score = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const text = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length <= maximum && !value.includes("\0");
const actions: MatchReviewAction[] = [
  "approve",
  "reject",
  "reassign",
  "escalate",
  "delete",
  "audit",
];
const statuses = [
  "auto_matched",
  "needs_review",
  "confirmed",
  "rejected",
  "not_me",
];

export function parseMatchReviewDecision(value: unknown): MatchReviewDecision {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "action",
          "status",
          "decision",
          "expected_revision",
          "reason",
          "user_id",
          "face_profile_id",
        ].includes(key),
    ) ||
    !revision(value.expected_revision)
  )
    throw new MatchReviewError("input_invalid");
  const aliases: Record<string, MatchReviewAction> = {
    confirmed: "approve",
    rejected: "reject",
    needs_review: "escalate",
  };
  const supplied: MatchReviewAction[] = [];
  if (value.action !== undefined) {
    if (!actions.includes(value.action as MatchReviewAction))
      throw new MatchReviewError("input_invalid");
    supplied.push(value.action as MatchReviewAction);
  }
  for (const key of ["status", "decision"])
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || !Object.hasOwn(aliases, value[key]))
        throw new MatchReviewError("input_invalid");
      supplied.push(aliases[value[key]]);
    }
  if (
    !supplied.length ||
    supplied.some((action) => action !== supplied[0]) ||
    (value.reason !== undefined && !text(value.reason, 4096))
  )
    throw new MatchReviewError("input_invalid");
  const action = supplied[0];
  if (
    action === "reassign"
      ? !uuid(value.user_id) || !uuid(value.face_profile_id)
      : value.user_id !== undefined || value.face_profile_id !== undefined
  )
    throw new MatchReviewError("input_invalid");
  return Object.freeze({
    action,
    expectedRevision: value.expected_revision,
    reason:
      typeof value.reason === "string" ? value.reason.trim() || null : null,
    userId: action === "reassign" ? String(value.user_id).toLowerCase() : null,
    faceProfileId:
      action === "reassign"
        ? String(value.face_profile_id).toLowerCase()
        : null,
  });
}
function authority(value: MatchReviewAuthority) {
  if (
    !uuid(value.matchId) ||
    !uuid(value.adminId) ||
    typeof value.accessJti !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.accessJti) ||
    !Number.isSafeInteger(value.accessExpiry) ||
    value.accessExpiry <= Math.floor(Date.now() / 1000) ||
    value.accessExpiry > Math.floor(Date.now() / 1000) + 930
  )
    throw new MatchReviewError("authority_changed");
}
function denial(
  value: Record<string, unknown>,
  protocol: string,
  expected: Pick<MatchReviewAuthority, "matchId">,
) {
  if (
    value.protocol !== protocol ||
    value.match_id !== expected.matchId.toLowerCase()
  )
    return invalid();
  if (["forbidden", "not_found", "conflict"].includes(String(value.outcome))) {
    if (!exact(value, ["protocol", "outcome", "match_id"])) return invalid();
    throw new MatchReviewError(
      value.outcome === "forbidden"
        ? "authority_changed"
        : (value.outcome as "not_found" | "conflict"),
    );
  }
}
export type MatchReviewDetail = Readonly<{
  protocol: "match-review-detail-v1";
  outcome: "available";
  match_id: string;
  revision: string;
  match: {
    id: string;
    user_id: string;
    media_asset_id: string;
    face_profile_id: string | null;
    status: string;
    score: number;
    margin: number;
    threshold: number;
    reviewed_at: string | null;
    reason_codes: string[];
  };
  profile: {
    id: string;
    status: string;
    source: string;
    quality_score: number;
    model_version: string;
    revoked_at: string | null;
    deleted_at: string | null;
    matching_paused_at: string | null;
  } | null;
  consent: {
    id: string;
    status: string;
    revoked_at: string | null;
    expires_at: string | null;
  } | null;
  media_status: string;
  subject_active: boolean;
  queue: { id: string; reason: string; resolved_at: string | null } | null;
}>;
export function matchReviewDetail(
  value: unknown,
  expected: Pick<MatchReviewAuthority, "matchId">,
): MatchReviewDetail {
  if (!record(value)) return invalid();
  denial(value, "match-review-detail-v1", expected);
  if (
    !exact(value, [
      "protocol",
      "outcome",
      "match_id",
      "revision",
      "match",
      "profile",
      "consent",
      "media_status",
      "subject_active",
      "queue",
    ]) ||
    value.outcome !== "available" ||
    !revision(value.revision) ||
    !record(value.match)
  )
    return invalid();
  const m = value.match;
  if (
    !exact(m, [
      "id",
      "user_id",
      "media_asset_id",
      "face_profile_id",
      "status",
      "score",
      "margin",
      "threshold",
      "reviewed_at",
      "reason_codes",
    ]) ||
    m.id !== value.match_id ||
    !uuid(m.user_id) ||
    !uuid(m.media_asset_id) ||
    !(m.face_profile_id === null || uuid(m.face_profile_id)) ||
    !statuses.includes(String(m.status)) ||
    !score(m.score) ||
    !score(m.margin) ||
    !score(m.threshold) ||
    !nullableDate(m.reviewed_at) ||
    !Array.isArray(m.reason_codes) ||
    m.reason_codes.length > 100 ||
    !m.reason_codes.every((code) => text(code))
  )
    return invalid();
  if (value.profile !== null) {
    const p = value.profile;
    if (
      !record(p) ||
      !exact(p, [
        "id",
        "status",
        "source",
        "quality_score",
        "model_version",
        "revoked_at",
        "deleted_at",
        "matching_paused_at",
      ]) ||
      !uuid(p.id) ||
      p.id !== m.face_profile_id ||
      !text(p.status) ||
      !text(p.source) ||
      !score(p.quality_score) ||
      !text(p.model_version) ||
      !nullableDate(p.revoked_at) ||
      !nullableDate(p.deleted_at) ||
      !nullableDate(p.matching_paused_at)
    )
      return invalid();
  }
  if (value.consent !== null) {
    const c = value.consent;
    if (
      !record(c) ||
      !exact(c, ["id", "status", "revoked_at", "expires_at"]) ||
      !uuid(c.id) ||
      !["granted", "revoked", "expired"].includes(String(c.status)) ||
      !nullableDate(c.revoked_at) ||
      !nullableDate(c.expires_at)
    )
      return invalid();
  }
  if (!text(value.media_status) || typeof value.subject_active !== "boolean")
    return invalid();
  if (
    value.queue !== null &&
    (!record(value.queue) ||
      !exact(value.queue, ["id", "reason", "resolved_at"]) ||
      !uuid(value.queue.id) ||
      !text(value.queue.reason, 4096) ||
      !nullableDate(value.queue.resolved_at))
  )
    return invalid();
  return Object.freeze(value) as MatchReviewDetail;
}
export type MatchReviewReceipt = Readonly<{
  match_id: string;
  action: MatchReviewAction;
  status: string;
  reviewed_by: string;
  reviewed_at: string;
  expected_revision: string;
}>;
export function matchReviewReceipt(
  value: unknown,
  expected: MatchReviewAuthority,
  decision: MatchReviewDecision,
): MatchReviewReceipt {
  if (!record(value)) return invalid();
  denial(value, "match-review-v1", expected);
  if (
    !exact(value, [
      "protocol",
      "outcome",
      "match_id",
      "action",
      "status",
      "reviewed_by",
      "reviewed_at",
      "expected_revision",
    ]) ||
    value.outcome !== "applied" ||
    value.action !== decision.action ||
    value.expected_revision !== decision.expectedRevision ||
    value.reviewed_by !== expected.adminId.toLowerCase() ||
    !date(value.reviewed_at) ||
    Date.parse(value.reviewed_at) > Date.now() + 30000 ||
    Date.parse(value.reviewed_at) < Date.now() - 30000
  )
    return invalid();
  const status =
    decision.action === "delete"
      ? "deleted"
      : ["approve", "reassign"].includes(decision.action)
        ? "confirmed"
        : decision.action === "reject"
          ? "rejected"
          : decision.action === "escalate"
            ? "needs_review"
            : null;
  if (
    status !== null
      ? value.status !== status
      : !statuses.includes(String(value.status))
  )
    return invalid();
  return Object.freeze({
    match_id: value.match_id as string,
    action: decision.action,
    status: value.status as string,
    reviewed_by: value.reviewed_by as string,
    reviewed_at: value.reviewed_at,
    expected_revision: decision.expectedRevision,
  });
}
export function createMatchReviewRepository(
  transport: (path: string, init: RequestInit) => Promise<Response>,
) {
  async function rpc(
    name: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    if (active.aborted) return invalid();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new MatchReviewError("receipt_unverified"));
      active.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), 10000);
    });
    const task = (async () => {
      const response = await transport(`rpc/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: active,
      });
      if (active.aborted || !response.ok) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {}
        if (!active.aborted && response.status === 403)
          throw new MatchReviewError("authority_changed");
        return invalid();
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
      return readCredentialJson(
        new Request("https://match-review-parser.invalid", {
          method: "POST",
          headers,
          body: response.body,
          signal: active,
          ...{ duplex: "half" },
        }),
        false,
        10000,
      );
    })();
    try {
      return await Promise.race([task, stopped]);
    } catch (error) {
      if (error instanceof MatchReviewError) throw error;
      return invalid();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      active.removeEventListener("abort", onAbort);
    }
  }
  const parameters = (value: MatchReviewAuthority) => ({
    p_match_id: value.matchId.toLowerCase(),
    p_admin_id: value.adminId.toLowerCase(),
    p_access_jti: value.accessJti,
    p_access_expires_at: new Date(value.accessExpiry * 1000).toISOString(),
  });
  return Object.freeze({
    async detail(value: MatchReviewAuthority, signal?: AbortSignal) {
      authority(value);
      const result = await rpc(
        "edge_match_review_detail_v1",
        parameters(value),
        signal,
      );
      authority(value);
      return matchReviewDetail(result, value);
    },
    async review(
      value: MatchReviewAuthority,
      decision: MatchReviewDecision,
      signal?: AbortSignal,
    ) {
      authority(value);
      // Revalidate callers of the typed API, not only HTTP body parsers.
      const parsed = parseMatchReviewDecision({
        action: decision.action,
        expected_revision: decision.expectedRevision,
        ...(decision.reason === null ? {} : { reason: decision.reason }),
        ...(decision.action === "reassign"
          ? {
              user_id: decision.userId,
              face_profile_id: decision.faceProfileId,
            }
          : {}),
      });
      if (
        parsed.userId !== decision.userId ||
        parsed.faceProfileId !== decision.faceProfileId ||
        parsed.reason !== decision.reason
      )
        throw new MatchReviewError("input_invalid");
      return matchReviewReceipt(
        await rpc(
          "edge_match_review_v1",
          {
            ...parameters(value),
            p_expected_revision: parsed.expectedRevision,
            p_action: parsed.action,
            p_reason: parsed.reason,
            p_reassign_user_id: parsed.userId,
            p_reassign_profile_id: parsed.faceProfileId,
          },
          signal,
        ),
        value,
        parsed,
      );
    },
  });
}
