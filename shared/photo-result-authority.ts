/** Actual photo callers carry either a verified signed session, an owned queue
 * claim, or a community discovery claim. This validates their transport shape;
 * the result transaction must lock and verify the current database authority.
 * Provider AuthUser fallback is identity-only and supplies no signed binding. */
import { isMatchingUuid, isRecord } from "./photo-matching-contract.ts";
import { faceConsentTimestamp } from "./face-consent-policy.ts";
import {
  platformSessionRoles,
  type PlatformSessionRole,
} from "./session-authority-policy.ts";

export type PhotoResultAuthority = Readonly<
  | {
      kind: "signed_session";
      actor_user_id: string;
      signed_roles: readonly PlatformSessionRole[];
      access_jti: string;
      access_expiry: number;
      admin_only: boolean;
    }
  | {
      kind: "queue_lease";
      business_key: string;
      job_type: "photo_uploaded";
      lease_token: string;
      lease_expires_at: string;
    }
  | {
      kind: "community_discovery";
      user_id: string;
      lease_id: string;
      phase: "assets";
      selected_asset_id: string;
    }
>;
export class PhotoResultAuthorityError extends Error {
  constructor() {
    super("photo_result_authority_unverified");
    this.name = "PhotoResultAuthorityError";
  }
}
const fail = (): never => {
  throw new PhotoResultAuthorityError();
};
const isLeaseToken = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** Own scalar/role values before any await. No privileged identity or expiry is
 * invented for queue/community jobs, or for the provider-auth fallback. */
export function parsePhotoResultAuthority(
  value: unknown,
  assetId: string,
  nowMs = Date.now(),
): PhotoResultAuthority {
  if (
    !isMatchingUuid(assetId) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !isRecord(value)
  )
    return fail();
  if (value.kind === "signed_session") {
    if (
      !exact(value, [
        "kind",
        "actor_user_id",
        "signed_roles",
        "access_jti",
        "access_expiry",
        "admin_only",
      ]) ||
      !isMatchingUuid(value.actor_user_id) ||
      !Array.isArray(value.signed_roles) ||
      value.signed_roles.length < 1 ||
      value.signed_roles.length > platformSessionRoles.length ||
      new Set(value.signed_roles).size !== value.signed_roles.length ||
      !value.signed_roles.every(
        (role) =>
          typeof role === "string" &&
          (platformSessionRoles as readonly string[]).includes(role),
      ) ||
      typeof value.access_jti !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(value.access_jti) ||
      !Number.isSafeInteger(value.access_expiry) ||
      Number(value.access_expiry) * 1000 <= nowMs ||
      Number(value.access_expiry) * 1000 > nowMs + 930_000 ||
      typeof value.admin_only !== "boolean" ||
      (value.admin_only && !value.signed_roles.includes("admin"))
    )
      return fail();
    return Object.freeze({
      kind: "signed_session",
      actor_user_id: value.actor_user_id.toLowerCase(),
      signed_roles: Object.freeze(
        value.signed_roles.slice(),
      ) as readonly PlatformSessionRole[],
      access_jti: value.access_jti,
      access_expiry: Number(value.access_expiry),
      admin_only: value.admin_only,
    });
  }
  if (value.kind === "queue_lease") {
    const expiry = faceConsentTimestamp(value.lease_expires_at);
    if (
      !exact(value, [
        "kind",
        "business_key",
        "job_type",
        "lease_token",
        "lease_expires_at",
      ]) ||
      value.business_key !== `photo_uploaded:${assetId.toLowerCase()}` ||
      value.job_type !== "photo_uploaded" ||
      !isLeaseToken(value.lease_token) ||
      typeof value.lease_expires_at !== "string" ||
      expiry === null ||
      expiry <= nowMs ||
      expiry > nowMs + 930_000
    )
      return fail();
    return Object.freeze({
      kind: "queue_lease",
      business_key: value.business_key as string,
      job_type: "photo_uploaded",
      lease_token: value.lease_token.toLowerCase(),
      lease_expires_at: value.lease_expires_at,
    });
  }
  if (value.kind === "community_discovery") {
    // Current claim does not return lease_until. Its database row owns expiry;
    // accept no fabricated local expiry or invented queue/signed-session fields.
    if (
      !exact(value, [
        "kind",
        "user_id",
        "lease_id",
        "phase",
        "selected_asset_id",
      ]) ||
      !isMatchingUuid(value.user_id) ||
      !isLeaseToken(value.lease_id) ||
      value.phase !== "assets" ||
      !isMatchingUuid(value.selected_asset_id) ||
      value.selected_asset_id.toLowerCase() !== assetId.toLowerCase()
    )
      return fail();
    return Object.freeze({
      kind: "community_discovery",
      user_id: value.user_id.toLowerCase(),
      lease_id: value.lease_id.toLowerCase(),
      phase: "assets",
      selected_asset_id: value.selected_asset_id.toLowerCase(),
    });
  }
  return fail();
}

export function photoResultSqlAuthority(
  value: PhotoResultAuthority,
  assetId: string,
  nowMs = Date.now(),
) {
  const authority = parsePhotoResultAuthority(value, assetId, nowMs);
  if (authority.kind !== "signed_session") return { ...authority };
  return {
    kind: authority.kind,
    actor_user_id: authority.actor_user_id,
    signed_roles: [...authority.signed_roles],
    access_jti: authority.access_jti,
    access_expires_at: new Date(authority.access_expiry * 1000).toISOString(),
    admin_only: authority.admin_only,
  };
}
