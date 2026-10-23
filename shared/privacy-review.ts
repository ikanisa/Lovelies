/** Atomic privacy review and leased delivery contracts. Trusted transports only;
 * a Queue send can repeat after uncertain acceptance, using the same request id.
 * The SQL review/logout fence does not fence every other application operation. */
import { readCredentialJson } from "../supabase/functions/_shared/credential-json.ts";

export type PrivacyDecision = "approve" | "reject";
export type PrivacyReviewBinding = {
  requestId: string;
  adminId: string;
  decision: PrivacyDecision;
  reason: string | null;
  accessJti: string;
  accessExpiry: number;
};
export type PrivacyReviewReceipt = {
  outcome: "committed" | "replayed";
  requestId: string;
  decision: PrivacyDecision;
  requestType: "export" | "delete";
  status: "queued" | "processing" | "failed" | "completed" | "rejected";
  reviewedBy: string;
  reviewedAt: string;
  deliveryStatus: "pending" | "leased" | "delivered" | "retired" | null;
};
export class PrivacyReviewError extends Error {
  constructor(
    readonly code:
      | "input_invalid"
      | "authority_changed"
      | "not_found"
      | "conflict"
      | "receipt_unverified"
      | "send_timeout",
  ) {
    super(code);
    this.name = "PrivacyReviewError";
  }
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).length === fields.length &&
  fields.every((key) => Object.hasOwn(v, key));
const invalid = (): never => {
  throw new PrivacyReviewError("receipt_unverified");
};
const discard = (response: Response) => {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {}
};
function date(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
      value,
    )
  )
    return invalid();
  const ms = Date.parse(value);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return invalid();
  return ms;
}
export function privacyReviewReason(
  value: unknown,
  decision: PrivacyDecision,
): string | null {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "reason") ||
    !["approve", "reject"].includes(decision) ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" ||
        value.reason.length > 4096 ||
        value.reason.includes("\0")))
  )
    throw new PrivacyReviewError("input_invalid");
  const reason = typeof value.reason === "string" ? value.reason.trim() : null;
  if (decision === "reject" && !reason)
    throw new PrivacyReviewError("input_invalid");
  return reason || null;
}
function binding(value: PrivacyReviewBinding): void {
  if (
    !uuid(value.requestId) ||
    !uuid(value.adminId) ||
    !["approve", "reject"].includes(value.decision) ||
    typeof value.accessJti !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.accessJti) ||
    !Number.isSafeInteger(value.accessExpiry) ||
    value.accessExpiry <= Math.floor(Date.now() / 1000) ||
    value.accessExpiry > Math.floor(Date.now() / 1000) + 930
  )
    throw new PrivacyReviewError("authority_changed");
}
export function privacyReviewReceipt(
  value: unknown,
  expected: PrivacyReviewBinding,
): PrivacyReviewReceipt {
  if (
    !record(value) ||
    value.protocol !== "privacy-review-v1" ||
    value.privacy_request_id !== expected.requestId.toLowerCase()
  )
    return invalid();
  if (["forbidden", "not_found", "conflict"].includes(String(value.outcome))) {
    if (!exact(value, ["protocol", "outcome", "privacy_request_id"]))
      return invalid();
    throw new PrivacyReviewError(
      value.outcome === "forbidden"
        ? "authority_changed"
        : (value.outcome as "not_found" | "conflict"),
    );
  }
  if (
    !exact(value, [
      "protocol",
      "outcome",
      "privacy_request_id",
      "decision",
      "request_type",
      "status",
      "reviewed_by",
      "reviewed_at",
      "delivery_status",
    ]) ||
    !["committed", "replayed"].includes(String(value.outcome)) ||
    value.decision !== expected.decision ||
    !["export", "delete"].includes(String(value.request_type)) ||
    !uuid(value.reviewed_by) ||
    (value.outcome === "committed" &&
      value.reviewed_by !== expected.adminId.toLowerCase()) ||
    !["queued", "processing", "failed", "completed", "rejected"].includes(
      String(value.status),
    ) ||
    (value.delivery_status !== null &&
      !["pending", "leased", "delivered", "retired"].includes(
        String(value.delivery_status),
      ))
  )
    return invalid();
  const reviewedMs = date(value.reviewed_at);
  if (
    reviewedMs > Date.now() + 30_000 ||
    reviewedMs <= 0 ||
    (value.outcome === "committed" && reviewedMs < Date.now() - 30_000) ||
    (expected.decision === "reject" &&
      (value.status !== "rejected" || value.delivery_status !== null)) ||
    (expected.decision === "approve" &&
      (value.status === "rejected" ||
        (value.status === "queued" && value.delivery_status === null)))
  )
    return invalid();
  return Object.freeze({
    outcome: value.outcome as "committed" | "replayed",
    requestId: expected.requestId.toLowerCase(),
    decision: expected.decision,
    requestType: value.request_type as "export" | "delete",
    status: value.status as PrivacyReviewReceipt["status"],
    reviewedBy: value.reviewed_by,
    reviewedAt: value.reviewed_at as string,
    deliveryStatus:
      value.delivery_status as PrivacyReviewReceipt["deliveryStatus"],
  });
}
export type PrivacyDispatchMessage = Readonly<{
  type: "gdpr_export" | "gdpr_delete";
  privacy_request_id: string;
  requested_at: string;
}>;
export type PrivacyDispatchLease = Readonly<{
  requestId: string;
  token: string;
  expiresAt: string;
  message: PrivacyDispatchMessage;
}>;
export type PrivacyDispatchSummary = {
  claimed: number;
  delivered: number;
  sendFailed: number;
  settlementUncertain: number;
  expired: number;
};
export const PRIVACY_DISPATCH_LIMIT = 5;
export const PRIVACY_DISPATCH_LEASE_SECONDS = 120;
export function privacyDispatchClaims(
  value: unknown,
  expectedId: string | null,
): readonly PrivacyDispatchLease[] {
  if (
    !record(value) ||
    !exact(value, ["protocol", "claims"]) ||
    value.protocol !== "privacy-review-dispatch-v1" ||
    !Array.isArray(value.claims) ||
    value.claims.length > PRIVACY_DISPATCH_LIMIT
  )
    return invalid();
  const seen = new Set<string>();
  return Object.freeze(
    value.claims.map((raw) => {
      if (
        !record(raw) ||
        !exact(raw, [
          "privacy_request_id",
          "lease_token",
          "lease_expires_at",
          "message",
        ]) ||
        !uuid(raw.privacy_request_id) ||
        !uuid(raw.lease_token) ||
        !record(raw.message) ||
        !exact(raw.message, ["type", "privacy_request_id", "requested_at"]) ||
        !["gdpr_export", "gdpr_delete"].includes(String(raw.message.type)) ||
        raw.message.privacy_request_id !== raw.privacy_request_id ||
        (expectedId !== null && raw.privacy_request_id !== expectedId) ||
        seen.has(raw.privacy_request_id)
      )
        return invalid();
      const expiry = date(raw.lease_expires_at),
        requested = date(raw.message.requested_at);
      if (
        expiry <= Date.now() ||
        expiry > Date.now() + 150_000 ||
        requested <= 0 ||
        requested > Date.now() + 30_000
      )
        return invalid();
      seen.add(raw.privacy_request_id);
      return Object.freeze({
        requestId: raw.privacy_request_id,
        token: raw.lease_token,
        expiresAt: raw.lease_expires_at as string,
        message: Object.freeze({
          type: raw.message.type as "gdpr_export" | "gdpr_delete",
          privacy_request_id: raw.privacy_request_id,
          requested_at: raw.message.requested_at as string,
        }),
      });
    }),
  );
}
export function createPrivacyReviewRepository(
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
      onAbort = () => reject(new PrivacyReviewError("receipt_unverified"));
      active.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new PrivacyReviewError("receipt_unverified"));
      }, 10_000);
    });
    const task = (async () => {
      const response = await transport(`rpc/${name}`, {
        method: "POST",
        signal: active,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (active.aborted || !response.ok) {
        discard(response);
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
      // This Request is only a bounded stream/parser adapter, never a network call.
      return readCredentialJson(
        new Request("https://privacy-review-parser.invalid", {
          method: "POST",
          headers,
          body: response.body,
          signal: active,
          ...{ duplex: "half" },
        }),
        false,
        10_000,
      );
    })();
    try {
      return await Promise.race([task, stopped]);
    } catch (error) {
      if (error instanceof PrivacyReviewError) throw error;
      return invalid();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      active.removeEventListener("abort", onAbort);
    }
  }
  return Object.freeze({
    async review(value: PrivacyReviewBinding, signal: AbortSignal) {
      binding(value);
      return privacyReviewReceipt(
        await rpc(
          "edge_privacy_review_v1",
          {
            p_request_id: value.requestId.toLowerCase(),
            p_admin_id: value.adminId.toLowerCase(),
            p_decision: value.decision,
            p_reason: value.reason,
            p_access_jti: value.accessJti,
            p_access_expires_at: new Date(
              value.accessExpiry * 1000,
            ).toISOString(),
          },
          signal,
        ),
        value,
      );
    },
    async claim(requestId: string | null = null) {
      if (requestId !== null && !uuid(requestId)) return invalid();
      return privacyDispatchClaims(
        await rpc("edge_privacy_review_dispatch_claim_v1", {
          p_limit: PRIVACY_DISPATCH_LIMIT,
          p_lease_seconds: PRIVACY_DISPATCH_LEASE_SECONDS,
          p_request_id: requestId,
        }),
        requestId,
      );
    },
    async settle(
      lease: PrivacyDispatchLease,
      sent: boolean,
      code: string | null,
    ) {
      const result = await rpc("edge_privacy_review_dispatch_settle_v1", {
        p_request_id: lease.requestId,
        p_lease_token: lease.token,
        p_sent: sent,
        p_error_code: code,
      });
      if (
        !record(result) ||
        !exact(result, [
          "protocol",
          "privacy_request_id",
          "lease_token",
          "settled",
          "delivery_status",
        ]) ||
        result.protocol !== "privacy-review-dispatch-v1" ||
        result.privacy_request_id !== lease.requestId ||
        result.lease_token !== lease.token ||
        typeof result.settled !== "boolean" ||
        result.delivery_status !==
          (result.settled ? (sent ? "delivered" : "pending") : null)
      )
        return invalid();
      return result.settled;
    },
  });
}
export async function dispatchPrivacyReviewOutbox(
  repository: ReturnType<typeof createPrivacyReviewRepository>,
  send: (message: PrivacyDispatchMessage) => Promise<unknown>,
  requestId: string | null = null,
): Promise<PrivacyDispatchSummary> {
  const leases = await repository.claim(requestId);
  const result: PrivacyDispatchSummary = {
    claimed: leases.length,
    delivered: 0,
    sendFailed: 0,
    settlementUncertain: 0,
    expired: 0,
  };
  await Promise.all(
    leases.map(async (lease) => {
      let timer: ReturnType<typeof setTimeout> | undefined,
        sent = false;
      try {
        if (date(lease.expiresAt) <= Date.now()) {
          result.expired++;
          return;
        }
        await Promise.race([
          Promise.resolve().then(() => send(lease.message)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new PrivacyReviewError("send_timeout")),
              15_000,
            );
          }),
        ]);
        sent = true;
      } catch {
        result.sendFailed++;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (date(lease.expiresAt) <= Date.now()) {
        result.expired++;
        return;
      }
      try {
        const settled = await repository.settle(
          lease,
          sent,
          sent ? null : "privacy_dispatch_send_unconfirmed",
        );
        if (!settled) result.settlementUncertain++;
        else if (sent) result.delivered++;
      } catch {
        result.settlementUncertain++;
      }
    }),
  );
  return result;
}
