/** Shared SQL authority for both runners. Remote writes are not transactional;
 * every PUT is preceded by an immutable intent retained for repeated cleanup. */
import { readCredentialJson } from "../supabase/functions/_shared/credential-json.ts";
import {
  accountExportCandidateTuple,
  accountExportReferences,
  type AccountExportCandidate,
  type AccountExportReference,
} from "../supabase/functions/_shared/account-erasure.ts";
import { privacyExportManifest } from "../supabase/functions/_shared/privacy-export.ts";
export type PrivacyExecutionLease = {
  requestId: string;
  subject: string;
  requestType: "export" | "delete";
  generation: number;
  token: string;
  expiresAt: string;
  runtime: "worker" | "edge";
};
export class PrivacyExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PrivacyExecutionError";
  }
}
const invalid = (): never => {
  throw new PrivacyExecutionError("privacy_execution_receipt_unverified");
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const integer = (v: unknown, min = 1): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const date = (v: unknown): number => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v)
  )
    return invalid();
  const ms = Date.parse(v);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== v.slice(0, 19)
  )
    return invalid();
  return ms;
};
const currentExpiry = (v: unknown) => {
  const t = date(v);
  if (t <= Date.now() || t > Date.now() + 150000) return invalid();
  return v as string;
};
export type PrivacyCleanupClaim = {
  candidate: AccountExportCandidate | Record<string, unknown>;
  reference: AccountExportReference;
  id: string;
  legacy: boolean;
  revision: number;
  token: string;
  expiresAt: string;
};
export function createPrivacyExecutionRepository(
  transport: (path: string, init: RequestInit) => Promise<Response>,
) {
  async function rpc(
    name: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(
          new PrivacyExecutionError("privacy_execution_backend_unavailable"),
        );
      }, 10000);
    });
    const task = (async () => {
      const r = await transport(`rpc/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (abort.signal.aborted || !r.ok) {
        void r.body?.cancel().catch(() => {});
        return invalid();
      }
      const headers = new Headers({
        "content-type": r.headers.get("content-type") ?? "",
      });
      if (["", "identity"].includes(r.headers.get("content-encoding") ?? "")) {
        const length = r.headers.get("content-length");
        if (length !== null) headers.set("content-length", length);
      }
      return readCredentialJson(
        new Request("https://privacy-execution-parser.invalid", {
          method: "POST",
          headers,
          body: r.body,
          signal: abort.signal,
          ...{ duplex: "half" },
        }),
        false,
        10000,
      );
    })();
    try {
      return await Promise.race([task, deadline]);
    } catch (error) {
      if (error instanceof PrivacyExecutionError) throw error;
      return invalid();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const binding = (l: PrivacyExecutionLease) => ({
    p_request_id: l.requestId,
    p_generation: l.generation,
    p_lease_token: l.token,
  });
  const bound = (
    v: unknown,
    l: PrivacyExecutionLease,
    flag: string,
  ): boolean => {
    if (
      !record(v) ||
      !exact(v, [
        "protocol",
        "privacy_request_id",
        "generation",
        "lease_token",
        flag,
      ]) ||
      v.protocol !== "privacy-execution-v1" ||
      v.privacy_request_id !== l.requestId ||
      v.generation !== l.generation ||
      v.lease_token !== l.token ||
      typeof v[flag] !== "boolean"
    )
      return invalid();
    return v[flag] as boolean;
  };
  return Object.freeze({
    async pending() {
      const v = await rpc("edge_privacy_execution_pending_v1", { p_limit: 10 });
      if (
        !record(v) ||
        !exact(v, ["protocol", "requests"]) ||
        v.protocol !== "privacy-execution-pending-v1" ||
        !Array.isArray(v.requests) ||
        v.requests.length > 10
      )
        return invalid();
      const seen = new Set<string>();
      return v.requests.map((row) => {
        if (
          !record(row) ||
          !exact(row, ["id", "request_type"]) ||
          !uuid(row.id) ||
          !["export", "delete"].includes(String(row.request_type)) ||
          seen.has(row.id)
        )
          return invalid();
        seen.add(row.id);
        return {
          id: row.id,
          request_type: row.request_type as "export" | "delete",
        };
      });
    },
    async claim(
      requestId: string,
      requestType: "export" | "delete",
      runtime: "worker" | "edge",
    ): Promise<PrivacyExecutionLease | null> {
      if (!uuid(requestId)) return invalid();
      const v = await rpc("edge_privacy_execution_claim_v1", {
        p_request_id: requestId,
        p_request_type: requestType,
        p_runtime: runtime,
      });
      if (
        !record(v) ||
        v.protocol !== "privacy-execution-v1" ||
        v.privacy_request_id !== requestId
      )
        return invalid();
      if (v.outcome !== "claimed") {
        if (
          !exact(v, ["protocol", "outcome", "privacy_request_id"]) ||
          !["busy", "closed", "completed", "unavailable"].includes(
            String(v.outcome),
          )
        )
          return invalid();
        if (v.outcome === "completed") return null;
        throw new PrivacyExecutionError(`privacy_execution_${v.outcome}`);
      }
      if (
        !exact(v, [
          "protocol",
          "outcome",
          "privacy_request_id",
          "subject_user_id",
          "request_type",
          "generation",
          "lease_token",
          "lease_expires_at",
          "runtime",
        ]) ||
        !uuid(v.subject_user_id) ||
        v.request_type !== requestType ||
        !integer(v.generation) ||
        !uuid(v.lease_token) ||
        v.runtime !== runtime
      )
        return invalid();
      return Object.freeze({
        requestId,
        subject: v.subject_user_id,
        requestType,
        generation: v.generation,
        token: v.lease_token,
        expiresAt: currentExpiry(v.lease_expires_at),
        runtime,
      });
    },
    async current(l: PrivacyExecutionLease, renew = true) {
      const v = await rpc("edge_privacy_execution_current_v1", {
        ...binding(l),
        p_renew: renew,
      });
      if (
        !record(v) ||
        !exact(v, [
          "protocol",
          "privacy_request_id",
          "generation",
          "lease_token",
          "current",
          "lease_expires_at",
        ]) ||
        v.protocol !== "privacy-execution-v1" ||
        v.privacy_request_id !== l.requestId ||
        v.generation !== l.generation ||
        v.lease_token !== l.token ||
        typeof v.current !== "boolean"
      )
        return invalid();
      if (!v.current) {
        if (v.lease_expires_at !== null) return invalid();
        throw new PrivacyExecutionError("privacy_execution_lost");
      }
      currentExpiry(v.lease_expires_at);
      return true;
    },
    async prepare(
      l: PrivacyExecutionLease,
      storage: {
        backend: "r2" | "supabase";
        binding: "PRIVACY_EXPORTS" | "PHOTOS" | null;
        bucket: string;
      },
      manifest: { export_bytes: number; export_sha256: string },
      expiresAt: string,
    ) {
      const v = await rpc("edge_privacy_export_prepare_v1", {
        ...binding(l),
        p_storage_backend: storage.backend,
        p_storage_binding: storage.binding,
        p_storage_bucket: storage.bucket,
        p_export_bytes: manifest.export_bytes,
        p_export_sha256: manifest.export_sha256,
        p_export_expires_at: expiresAt,
      });
      const c = accountExportCandidateTuple(v, l.requestId, l.subject);
      if (
        c.generation !== l.generation ||
        c.storage.backend !== storage.backend ||
        c.storage.binding !== storage.binding ||
        c.storage.bucket !== storage.bucket ||
        c.export_bytes !== manifest.export_bytes ||
        c.export_sha256 !== manifest.export_sha256 ||
        date(c.export_expires_at) !== date(expiresAt)
      )
        return invalid();
      return c;
    },
    async finish(
      l: PrivacyExecutionLease,
      candidateId: string | null,
      metadata: Record<string, unknown> = {},
    ) {
      return bound(
        await rpc("edge_privacy_execution_finish_v1", {
          ...binding(l),
          p_candidate_id: candidateId,
          p_metadata: metadata,
        }),
        l,
        "completed",
      );
    },
    async fail(l: PrivacyExecutionLease) {
      return bound(
        await rpc("edge_privacy_execution_fail_v1", {
          ...binding(l),
          p_error_code: "privacy_execution_unconfirmed",
        }),
        l,
        "failed",
      );
    },
    async publication(requestId: string, subject: string) {
      const v = await rpc("edge_privacy_export_publication_v1", {
        p_request_id: requestId,
        p_subject: subject,
      });
      if (
        !record(v) ||
        !exact(v, [
          "protocol",
          "privacy_request_id",
          "subject_user_id",
          "authorized",
          "published_candidate",
        ]) ||
        v.protocol !== "privacy-publication-v1" ||
        v.privacy_request_id !== requestId ||
        v.subject_user_id !== subject ||
        typeof v.authorized !== "boolean"
      )
        return invalid();
      if (!v.authorized && v.published_candidate !== null) return invalid();
      if (v.published_candidate !== null)
        accountExportCandidateTuple(v.published_candidate, requestId, subject);
      return {
        authorized: v.authorized,
        publishedCandidate: v.published_candidate,
      };
    },
    async handoff(requestId: string, subject: string, tokenHash: string) {
      const v = await rpc("edge_privacy_export_handoff_v1", {
        p_request_id: requestId,
        p_subject: subject,
        p_token_hash: tokenHash,
      });
      if (typeof v !== "boolean") return invalid();
      return v;
    },
    async create(value: {
      requestId: string;
      subject: string;
      requestType: "export" | "delete";
      reason: string | null;
      admin: boolean;
      accessJti: string | null;
      accessExpiresAt: string | null;
      source: "api" | "supabase_edge";
    }) {
      const v = await rpc("edge_privacy_request_create_v1", {
        p_request_id: value.requestId,
        p_subject: value.subject,
        p_request_type: value.requestType,
        p_reason: value.reason,
        p_admin: value.admin,
        p_access_jti: value.accessJti,
        p_access_expires_at: value.accessExpiresAt,
        p_source: value.source,
      });
      if (
        !record(v) ||
        !exact(v, [
          "protocol",
          "privacy_request_id",
          "subject_user_id",
          "request_type",
          "status",
          "requires_operator_approval",
        ]) ||
        v.protocol !== "privacy-create-v1" ||
        v.privacy_request_id !== value.requestId ||
        v.subject_user_id !== value.subject ||
        v.request_type !== value.requestType ||
        v.status !== (value.admin ? "queued" : "pending_approval") ||
        v.requires_operator_approval !== !value.admin
      )
        return invalid();
      return {
        status: v.status as "queued" | "pending_approval",
        requiresOperatorApproval: v.requires_operator_approval as boolean,
      };
    },
    async cleanupClaim(
      subject: string | null = null,
    ): Promise<PrivacyCleanupClaim[]> {
      const v = await rpc("edge_privacy_candidate_cleanup_claim_v1", {
        p_limit: 5,
        p_subject: subject,
      });
      if (
        !record(v) ||
        !exact(v, ["protocol", "claims"]) ||
        v.protocol !== "privacy-candidate-cleanup-v1" ||
        !Array.isArray(v.claims) ||
        v.claims.length > 5
      )
        return invalid();
      const seen = new Set<string>();
      return v.claims.map((raw) => {
        if (
          !record(raw) ||
          !exact(raw, [
            "candidate",
            "legacy",
            "revision",
            "cleanup_token",
            "cleanup_lease_until",
          ]) ||
          !record(raw.candidate) ||
          typeof raw.legacy !== "boolean" ||
          !integer(raw.revision) ||
          !uuid(raw.cleanup_token)
        )
          return invalid();
        const c = raw.candidate;
        if (
          !uuid(c.id) ||
          !uuid(c.privacy_request_id) ||
          !uuid(c.subject_user_id) ||
          seen.has(c.id) ||
          (subject !== null && c.subject_user_id !== subject)
        )
          return invalid();
        seen.add(c.id);
        let reference: AccountExportReference;
        if (!raw.legacy) {
          const parsed = accountExportCandidateTuple(
            c,
            c.privacy_request_id,
            c.subject_user_id,
          );
          reference = {
            key: parsed.object_key,
            backend: parsed.storage.backend,
            binding: parsed.storage.binding,
            bucket: parsed.storage.bucket,
          };
        } else {
          if (
            !exact(c, [
              "protocol",
              "id",
              "privacy_request_id",
              "subject_user_id",
              "generation",
              "object_key",
              "storage",
              "export_bytes",
              "export_sha256",
              "export_expires_at",
            ]) ||
            c.protocol !== "privacy-export-candidate-v1" ||
            c.generation !== 0 ||
            !record(c.storage)
          )
            return invalid();
          reference = accountExportReferences(
            [
              {
                id: c.privacy_request_id,
                metadata: {
                  export_object_key: c.object_key,
                  export_storage: c.storage,
                },
              },
            ],
            c.subject_user_id,
          )[0];
          if (!reference) return invalid();
        }
        return {
          candidate: c,
          reference,
          id: c.id,
          legacy: raw.legacy,
          revision: raw.revision,
          token: raw.cleanup_token,
          expiresAt: currentExpiry(raw.cleanup_lease_until),
        };
      });
    },
    async closure(requestId: string, subject: string) {
      const v = await rpc("edge_privacy_candidate_closure_v1", {
        p_request_id: requestId,
        p_subject: subject,
      });
      if (
        !record(v) ||
        !exact(v, [
          "protocol",
          "privacy_request_id",
          "subject_user_id",
          "pending",
        ]) ||
        v.protocol !== "privacy-candidate-closure-v1" ||
        v.privacy_request_id !== requestId ||
        v.subject_user_id !== subject ||
        typeof v.pending !== "boolean"
      )
        return invalid();
      return !v.pending;
    },
    async cleanupSettle(c: PrivacyCleanupClaim, absent: boolean) {
      const v = await rpc("edge_privacy_candidate_cleanup_settle_v1", {
        p_candidate_id: c.id,
        p_revision: c.revision,
        p_cleanup_token: c.token,
        p_absent: absent,
      });
      if (
        !record(v) ||
        !exact(v, ["protocol", "id", "revision", "cleanup_token", "settled"]) ||
        v.protocol !== "privacy-candidate-cleanup-v1" ||
        v.id !== c.id ||
        v.revision !== c.revision ||
        v.cleanup_token !== c.token ||
        typeof v.settled !== "boolean"
      )
        return invalid();
      return v.settled;
    },
  });
}
export type PrivacyExecutionRepository = ReturnType<
  typeof createPrivacyExecutionRepository
>;
export async function privacyStorageDeadline<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new PrivacyExecutionError("privacy_storage_unconfirmed")),
          30000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export async function cleanupPrivacyCandidates(
  repository: PrivacyExecutionRepository,
  remove: (reference: AccountExportReference) => Promise<void>,
  subject: string | null = null,
) {
  const claims = await repository.cleanupClaim(subject);
  let confirmed = 0,
    failed = 0;
  await Promise.all(
    claims.map(async (c) => {
      let absent = false;
      try {
        await privacyStorageDeadline(() => remove(c.reference));
        absent = true;
      } catch {
        failed++;
      }
      try {
        if ((await repository.cleanupSettle(c, absent)) && absent) confirmed++;
      } catch {
        failed++;
      }
    }),
  );
  return { claimed: claims.length, confirmed, failed };
}
export async function publishPrivacyExport(
  repository: PrivacyExecutionRepository,
  l: PrivacyExecutionLease,
  storage: {
    backend: "r2" | "supabase";
    binding: "PRIVACY_EXPORTS" | "PHOTOS" | null;
    bucket: string;
  },
  bytes: Uint8Array,
  expiresAt: string,
  write: (key: string) => Promise<unknown>,
  metadata: Record<string, unknown> = {},
) {
  const manifest = await privacyExportManifest(bytes),
    candidate = await repository.prepare(l, storage, manifest, expiresAt);
  await repository.current(l);
  await privacyStorageDeadline(() => write(candidate.object_key));
  if (!(await repository.finish(l, candidate.id, metadata)))
    throw new PrivacyExecutionError("privacy_publication_lost");
  return candidate;
}

/** Bounded physical observations for known candidates. The retained closed-key
 * sweep remains necessary for late writes after even a confirmed early404. */
export async function cleanupPrivacySubjectCandidates(
  repository: PrivacyExecutionRepository,
  lease: PrivacyExecutionLease,
  remove: (reference: AccountExportReference) => Promise<void>,
) {
  for (let batch = 0; batch < 10; batch++) {
    await repository.current(lease);
    const observed = await cleanupPrivacyCandidates(
      repository,
      remove,
      lease.subject,
    );
    if (observed.failed)
      throw new PrivacyExecutionError(
        "privacy_candidate_compensation_unconfirmed",
      );
    if (await repository.closure(lease.requestId, lease.subject)) return;
    if (observed.claimed === 0) break;
  }
  throw new PrivacyExecutionError("privacy_candidate_compensation_pending");
}
