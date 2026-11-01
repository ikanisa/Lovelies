import { ApiError, type Actor, type AppContext } from './types.ts';
import { assertRegisteredActor } from './operations.ts';
import { audienceContext, audienceRow } from './audience.ts';

/** Explicit capabilities are current database authority, never token claims.
 * Existing independently provisioned administrators retain their full role.
 * Delegation neither creates an administrator nor grants private-media access. */
export const OPERATOR_CAPABILITIES = Object.freeze([
  'overview.read', 'users.read', 'users.sessions.revoke', 'support.read', 'support.review',
  'safety.read', 'safety.review', 'guardian.read', 'guardian.review', 'privacy.read',
  'privacy.review', 'uploads.read', 'uploads.recover', 'retention.read', 'retention.manage',
] as const);
export type OperatorCapability = typeof OPERATOR_CAPABILITIES[number];
export const operatorCapabilitySchemaStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS operator_access_versions(account_id TEXT PRIMARY KEY REFERENCES accounts(id),version INTEGER NOT NULL CHECK(version>0))`,
  `CREATE TABLE IF NOT EXISTS operator_capability_grants(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),capability TEXT NOT NULL,
    granted_by TEXT NOT NULL REFERENCES accounts(id),operation_key TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    revoked_at INTEGER,revoked_by TEXT REFERENCES accounts(id),CHECK(account_id<>granted_by),CHECK(expires_at>created_at),
    CHECK(revoked_at IS NULL OR revoked_at>=created_at),CHECK(capability IN(${OPERATOR_CAPABILITIES.map(value => "'" + value + "'").join(',')})))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS operator_capability_active ON operator_capability_grants(account_id,capability) WHERE revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS operator_capability_subject ON operator_capability_grants(account_id,expires_at)`,
];

export async function operatorCapabilities(ctx: AppContext, accountId: string): Promise<OperatorCapability[]> {
  const account = await ctx.db.one<{roles_json:string;identity_state:string;disabled_at:number|null}>(
    'SELECT roles_json,identity_state,disabled_at FROM accounts WHERE id=?', accountId);
  if (!account || account.disabled_at !== null || account.identity_state !== 'registered_face') return [];
  let roles: unknown;
  try { roles = JSON.parse(account.roles_json); } catch { throw new ApiError(503, 'operator_authority_unavailable'); }
  if (!Array.isArray(roles)) throw new ApiError(503, 'operator_authority_unavailable');
  if (roles.includes('admin')) return [...OPERATOR_CAPABILITIES];
  const audience = await audienceRow(ctx, accountId);
  // A delegated operator must remain an eligible adult. Ordinary registered
  // face/audience/session checks still run before every interactive operation.
  if (!audience || audience.age_band !== '18_plus' || !await audienceContext(ctx, accountId, 'face_authentication')) return [];
  const grants = await ctx.db.all<{capability:string;created_at:number;expires_at:number}>(`SELECT capability,created_at,expires_at FROM operator_capability_grants
    WHERE account_id=? AND revoked_at IS NULL AND created_at<=? AND expires_at>? ORDER BY capability`, accountId, ctx.now(), ctx.now());
  if (grants.some(row => !OPERATOR_CAPABILITIES.includes(row.capability as OperatorCapability)) ||
      new Set(grants.map(row => row.capability)).size !== grants.length) throw new ApiError(503, 'operator_authority_unavailable');
  // The query may have waited for a lock or transport. A grant that expired
  // during that wait must not be released as current authority.
  const now = ctx.now();
  return grants.filter(row => row.created_at <= now && row.expires_at > now).map(row => row.capability as OperatorCapability);
}
export async function hasOperatorCapability(ctx: AppContext, accountId: string, capability: OperatorCapability): Promise<boolean> {
  if (!OPERATOR_CAPABILITIES.includes(capability)) throw new ApiError(500, 'operator_capability_invalid');
  return (await operatorCapabilities(ctx, accountId)).includes(capability);
}
export async function assertOperatorCapability(ctx: AppContext, actor: Actor, capability: OperatorCapability): Promise<void> {
  await ctx.db.read(async () => {
    await assertRegisteredActor(ctx, actor);
    if (!await hasOperatorCapability(ctx, actor.accountId, capability)) throw new ApiError(403, 'operator_capability_required');
    if (actor.expiresAt <= ctx.now()) throw new ApiError(401, 'session_invalid');
  });
}

/** Runs inside the operation transaction before returning any old receipt.
 * Capability removal must also deny a replay, including one admitted by an
 * earlier HTTP check. Sources/actions are server-selected, never caller roles. */
export async function assertOperatorOperationCapability(ctx: AppContext, actor: Actor, action: string, source: string): Promise<void> {
  let capability: OperatorCapability | undefined;
  if (source === 'support' && ['support.start','support.approve','support.reject','support.close'].includes(action)) capability = 'support.review';
  else if (source === 'moderation' && ['safety.review','match.review'].includes(action)) capability = 'safety.review';
  else if (source === 'guardian' && action === 'guardian.review' || source === 'audience' && action === 'audience.adult-review') capability = 'guardian.review';
  else if (source === 'privacy' && ['privacy.review.approve','privacy.review.reject'].includes(action)) capability = 'privacy.review';
  else if (source === 'admin_users' && action === 'admin.user.session.revoke') capability = 'users.sessions.revoke';
  else if (source === 'retention' && ['retention.update','retention.schedule'].includes(action)) capability = 'retention.manage';
  else if (source === 'operator_recovery' && action === 'operator.photo.resume') capability = 'uploads.recover';
  else if (source === 'operator_access' || source.startsWith('admin_')) {
    await ctx.db.read(async () => {
      await assertRegisteredActor(ctx, actor);
      if (!actor.roles.includes('admin')) throw new ApiError(403, 'admin_required');
    });
    return;
  }
  if (capability) await assertOperatorCapability(ctx, actor, capability);
}
