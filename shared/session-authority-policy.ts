/** Shared authority policy; transport adapters still verify credentials and
 * query the authoritative database. These snapshots do not fence later writes. */
export const platformSessionRoles = ["attendee", "user", "photographer", "organizer", "reviewer", "admin"] as const;
export type PlatformSessionRole = typeof platformSessionRoles[number];

export class SessionRoleAuthorityError extends Error {
  constructor() { super("role_authority_unavailable"); this.name = "SessionRoleAuthorityError"; }
}

export function currentSessionRoleRows(value: unknown, subject: string): PlatformSessionRole[];
export function currentSessionRoleRows<Role extends PlatformSessionRole>(
  value: unknown, subject: string, allowed: readonly Role[],
): Role[];
export function currentSessionRoleRows(value: unknown, subject: string,
  allowed: readonly PlatformSessionRole[] = platformSessionRoles): PlatformSessionRole[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject) ||
    !Array.isArray(value) || value.length > allowed.length) throw new SessionRoleAuthorityError();
  const selected: PlatformSessionRole[] = [];
  for (const row of value) {
    if (row === null || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 2 ||
      typeof row.user_id !== "string" || row.user_id.toLowerCase() !== subject.toLowerCase() ||
      typeof row.role !== "string" || !(allowed as readonly string[]).includes(row.role) || selected.includes(row.role as PlatformSessionRole)) {
      throw new SessionRoleAuthorityError();
    }
    selected.push(row.role as PlatformSessionRole);
  }
  // An empty authoritative list never receives an implicit ordinary user grant.
  return selected;
}

export function intersectSessionRoles<Role extends string>(current: readonly Role[], signed: readonly string[]): Role[] {
  return current.filter(role => signed.includes(role));
}

export function sessionTimingCurrent(value: { iat?: unknown; exp?: unknown; nbf?: unknown },
  lifetimeSeconds = 900, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return Number.isSafeInteger(nowSeconds) && Number.isSafeInteger(value.iat) && Number.isSafeInteger(value.exp) &&
    (value.iat as number) >= 0 && (value.iat as number) <= nowSeconds + 30 &&
    (value.exp as number) > nowSeconds && (value.exp as number) > (value.iat as number) &&
    (value.exp as number) - (value.iat as number) <= lifetimeSeconds &&
    (value.nbf === undefined || (Number.isSafeInteger(value.nbf) && (value.nbf as number) <= nowSeconds &&
      (value.nbf as number) < (value.exp as number)));
}
