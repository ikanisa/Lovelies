/** Minimal pending-approval inbox contract shared by the gateway and operator UI.
 * A cursor is a validated keyset position, never an authorization capability.
 * Pages are live snapshots; they do not fence subsequent review mutations. */
import { parseCredentialJson } from "../supabase/functions/_shared/credential-json";
export const ADMIN_PRIVACY_PAGE_SIZE = 50;
export const ADMIN_PRIVACY_BODY_MAX_BYTES = 32_768;
export type AdminPrivacyRow = {
  id: string;
  request_type: "export" | "delete";
  subject_user_id: string;
  status: "pending_approval";
  requested_at: string;
};
export type AdminPrivacyPage = {
  privacy_requests: AdminPrivacyRow[];
  page: { cursor: string | null; next_cursor: string | null; limit: number };
};
export class AdminPrivacyInboxError extends Error {
  constructor(
    readonly code:
      | "cursor_invalid"
      | "receipt_invalid"
      | "body_too_large"
      | "body_timeout"
      | "body_cancelled",
  ) {
    super(code);
    this.name = "AdminPrivacyInboxError";
  }
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (): never => {
  throw new AdminPrivacyInboxError("receipt_invalid");
};
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
/** Preserve PostgreSQL microseconds so same-millisecond requests cannot disappear
 * between pages. PostgREST's UTC +00:00 and Z forms normalize identically. */
function timestamp(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!match) return invalid();
  const millis = Date.parse(
    `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (
    !Number.isFinite(millis) ||
    new Date(millis).toISOString().slice(0, 19) !== match[1]
  )
    return invalid();
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
}
export function adminPrivacyRow(value: unknown): AdminPrivacyRow {
  if (
    !record(value) ||
    !keys(value, [
      "id",
      "request_type",
      "subject_user_id",
      "status",
      "requested_at",
    ]) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    typeof value.subject_user_id !== "string" ||
    !uuid.test(value.subject_user_id) ||
    typeof value.request_type !== "string" ||
    !["export", "delete"].includes(value.request_type) ||
    value.status !== "pending_approval"
  )
    return invalid();
  return {
    id: value.id.toLowerCase(),
    subject_user_id: value.subject_user_id.toLowerCase(),
    request_type: value.request_type as "export" | "delete",
    status: "pending_approval",
    requested_at: timestamp(value.requested_at),
  };
}
type Position = Pick<AdminPrivacyRow, "id" | "requested_at">;
export function adminPrivacyCursor(row: Position): string {
  if (!uuid.test(row.id)) return invalid();
  return `v1.${timestamp(row.requested_at)}.${row.id.toLowerCase()}`;
}
export function parseAdminPrivacyCursor(value: unknown): Position | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 100)
    throw new AdminPrivacyInboxError("cursor_invalid");
  const match =
    /^v1\.(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\.([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(
      value,
    );
  try {
    if (!match || timestamp(match[1]) !== match[1]) throw new Error();
    return { requested_at: match[1], id: match[2] };
  } catch {
    throw new AdminPrivacyInboxError("cursor_invalid");
  }
}
export function compareAdminPrivacyRows(
  left: Position,
  right: Position,
): number {
  return left.requested_at < right.requested_at
    ? -1
    : left.requested_at > right.requested_at
      ? 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0;
}
export function adminPrivacyRows(
  value: unknown,
  cursor: string | null,
  maxRows: number,
): AdminPrivacyRow[] {
  const position = parseAdminPrivacyCursor(cursor);
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > ADMIN_PRIVACY_PAGE_SIZE + 1 ||
    !Array.isArray(value) ||
    value.length > maxRows
  )
    return invalid();
  const rows = value.map(adminPrivacyRow);
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (
      seen.has(row.id) ||
      (position && compareAdminPrivacyRows(row, position) <= 0) ||
      (index > 0 && compareAdminPrivacyRows(rows[index - 1], row) >= 0)
    )
      return invalid();
    seen.add(row.id);
  }
  return rows;
}
export function adminPrivacyPage(
  value: unknown,
  expectedCursor: string | null,
): AdminPrivacyPage {
  parseAdminPrivacyCursor(expectedCursor);
  if (
    !record(value) ||
    !keys(value, ["privacy_requests", "page"]) ||
    !record(value.page) ||
    !keys(value.page, ["cursor", "next_cursor", "limit"]) ||
    value.page.cursor !== expectedCursor ||
    value.page.limit !== ADMIN_PRIVACY_PAGE_SIZE
  )
    return invalid();
  const rows = adminPrivacyRows(
    value.privacy_requests,
    expectedCursor,
    ADMIN_PRIVACY_PAGE_SIZE,
  );
  const next = value.page.next_cursor;
  if (
    next !== null &&
    (typeof next !== "string" ||
      rows.length !== ADMIN_PRIVACY_PAGE_SIZE ||
      next !== adminPrivacyCursor(rows[rows.length - 1]))
  )
    return invalid();
  parseAdminPrivacyCursor(next);
  return {
    privacy_requests: rows,
    page: {
      cursor: expectedCursor,
      next_cursor: next as string | null,
      limit: ADMIN_PRIVACY_PAGE_SIZE,
    },
  };
}
/** Bound decoded bytes, empty chunks, duration and cancellation. Buffers owned
 * here are cleared; parsed minimal records remain owned by the caller. */
export async function readAdminPrivacyJson(
  response: Response,
  signal?: AbortSignal,
  timeoutMs = 10_000,
  parse: (value: string) => unknown = (value) =>
    parseCredentialJson(value, ADMIN_PRIVACY_BODY_MAX_BYTES),
): Promise<unknown> {
  const discard = () => {
    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {}
  };
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15_000 ||
    !response.ok ||
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    discard();
    return invalid();
  }
  if (signal?.aborted) {
    discard();
    throw new AdminPrivacyInboxError("body_cancelled");
  }
  const declaredText = response.headers.get("content-length");
  let declared: number | undefined;
  if (declaredText !== null) {
    if (
      !/^\d+$/.test(declaredText) ||
      !Number.isSafeInteger(Number(declaredText))
    ) {
      discard();
      return invalid();
    }
    if (
      (response.headers.get("content-encoding") ?? "identity")
        .trim()
        .toLowerCase() === "identity"
    )
      declared = Number(declaredText);
  }
  if (declared !== undefined && declared > ADMIN_PRIVACY_BODY_MAX_BYTES) {
    discard();
    throw new AdminPrivacyInboxError("body_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const bytes = new Uint8Array(ADMIN_PRIVACY_BODY_MAX_BYTES);
  let length = 0,
    empty = 0,
    done = false;
  const expires = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AdminPrivacyInboxError("body_timeout")),
      timeoutMs,
    );
    onAbort = () => reject(new AdminPrivacyInboxError("body_cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const check = () => {
    if (signal?.aborted) throw new AdminPrivacyInboxError("body_cancelled");
    if (performance.now() >= expires)
      throw new AdminPrivacyInboxError("body_timeout");
  };
  try {
    for (;;) {
      check();
      const part = await Promise.race([reader.read(), stopped]);
      check();
      if (part.done) {
        done = true;
        break;
      }
      if (!(part.value instanceof Uint8Array)) return invalid();
      if (!part.value.byteLength) {
        if (++empty > 128) return invalid();
        continue;
      }
      empty = 0;
      if (part.value.byteLength > bytes.length - length)
        throw new AdminPrivacyInboxError("body_too_large");
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    if (declared !== undefined && length !== declared) return invalid();
    const result = parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, length),
      ),
    );
    check();
    return result;
  } catch (error) {
    if (error instanceof AdminPrivacyInboxError) throw error;
    return invalid();
  } finally {
    bytes.fill(0);
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (!done) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {}
    }
    try {
      reader.releaseLock();
    } catch {}
  }
}
