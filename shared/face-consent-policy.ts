/** Runtime-neutral photo consent grant rules. Historical policy rows remain
 * readable; a new grant must name a version used by the current product. */
export const supportedFaceConsentPolicies = [
  "zero-touch-photo-identity-v1",
  "global-biometric-v1",
] as const;

export type FaceConsentGrant = { policy_version: string; expires_at?: string };

export class FaceConsentPolicyError extends Error {
  constructor(
    readonly code:
      | "invalid_consent_input"
      | "consent_policy_required"
      | "consent_policy_unsupported"
      | "invalid_consent_expiry",
  ) {
    super(code);
    this.name = "FaceConsentPolicyError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject date rollover and locale-dependent parsing, while retaining RFC3339
 * offsets and fractional seconds supported by the existing database API. */
export function faceConsentTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    (match[7] && (Number(match[8]) > 23 || Number(match[9]) > 59))
  )
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function parseFaceConsentGrant(
  value: unknown,
  nowMilliseconds = Date.now(),
): FaceConsentGrant {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => key !== "policy_version" && key !== "expires_at",
    )
  ) {
    throw new FaceConsentPolicyError("invalid_consent_input");
  }
  if (
    typeof value.policy_version !== "string" ||
    !value.policy_version.trim()
  ) {
    throw new FaceConsentPolicyError("consent_policy_required");
  }
  if (
    !(supportedFaceConsentPolicies as readonly string[]).includes(
      value.policy_version,
    )
  ) {
    throw new FaceConsentPolicyError("consent_policy_unsupported");
  }
  if (value.expires_at !== undefined) {
    const expiry = faceConsentTimestamp(value.expires_at);
    if (expiry === null || expiry <= nowMilliseconds)
      throw new FaceConsentPolicyError("invalid_consent_expiry");
  }
  return {
    policy_version: value.policy_version,
    ...(value.expires_at !== undefined
      ? { expires_at: value.expires_at as string }
      : {}),
  };
}

/** Reaffirmation never revives, changes policy or extends a stored grant. */
export function faceConsentCanReuse(
  value: unknown,
  grant: FaceConsentGrant,
  nowMilliseconds = Date.now(),
): boolean {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.id,
    ) ||
    value.policy_version !== grant.policy_version ||
    value.revoked_at != null
  )
    return false;
  const expiry =
    value.expires_at == null ? null : faceConsentTimestamp(value.expires_at);
  if (
    value.expires_at != null &&
    (expiry === null || expiry <= nowMilliseconds)
  )
    return false;
  return (
    grant.expires_at === undefined || grant.expires_at === value.expires_at
  );
}

export type CurrentFaceConsent = Readonly<{
  id: string;
  expiresAtMilliseconds: number | null;
}>;
export class FaceConsentReceiptError extends Error {
  constructor() {
    super("invalid_current_consent_receipt");
    this.name = "FaceConsentReceiptError";
  }
}
const consentUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const consentFields = ["id", "user_id", "status", "revoked_at", "expires_at"];

/** Server predicates limit selection; the receipt is still independently
 * validated. Historical policy versions and explicit null expiry remain valid. */
export function currentFaceConsentQuery(
  subject: string,
  nowMilliseconds = Date.now(),
): string {
  if (!consentUuid(subject) || !Number.isFinite(nowMilliseconds))
    throw new FaceConsentReceiptError();
  return (
    `user_id=eq.${encodeURIComponent(subject)}&status=eq.granted&revoked_at=is.null` +
    `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(new Date(nowMilliseconds).toISOString())})` +
    `&select=${consentFields.join(",")}&limit=2`
  );
}
export function currentFaceConsentUsable(
  consent: CurrentFaceConsent | null,
  nowMilliseconds = Date.now(),
): consent is CurrentFaceConsent {
  return (
    consent !== null &&
    Number.isFinite(nowMilliseconds) &&
    (consent.expiresAtMilliseconds === null ||
      consent.expiresAtMilliseconds > nowMilliseconds)
  );
}
export function parseCurrentFaceConsent(
  rows: unknown,
  subject: string,
  nowMilliseconds = Date.now(),
): CurrentFaceConsent | null {
  if (
    !consentUuid(subject) ||
    !Number.isFinite(nowMilliseconds) ||
    !Array.isArray(rows) ||
    rows.length > 1
  )
    throw new FaceConsentReceiptError();
  if (rows.length === 0) return null;
  const row: unknown = rows[0];
  if (
    !record(row) ||
    Object.keys(row).length !== consentFields.length ||
    consentFields.some(
      (key) => !Object.prototype.hasOwnProperty.call(row, key),
    ) ||
    !consentUuid(row.id) ||
    !consentUuid(row.user_id) ||
    row.user_id.toLowerCase() !== subject.toLowerCase() ||
    typeof row.status !== "string" ||
    !["granted", "revoked", "expired"].includes(row.status) ||
    (row.revoked_at !== null && faceConsentTimestamp(row.revoked_at) === null)
  )
    throw new FaceConsentReceiptError();
  const expiry =
    row.expires_at === null ? null : faceConsentTimestamp(row.expires_at);
  if (row.expires_at !== null && expiry === null)
    throw new FaceConsentReceiptError();
  const consent = Object.freeze({
    id: row.id.toLowerCase(),
    expiresAtMilliseconds: expiry,
  });
  return row.status === "granted" &&
    row.revoked_at === null &&
    currentFaceConsentUsable(consent, nowMilliseconds)
    ? consent
    : null;
}
