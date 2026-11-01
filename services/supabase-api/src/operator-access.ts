import { audienceBandSQL } from './audience-decision.ts';
import { ApiError, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
import { executeOperation, prepareOperation } from './operations.ts';
import { requireOperator } from './operators.ts';
import { OPERATOR_CAPABILITIES, operatorCapabilities, type OperatorCapability } from './operator-capabilities.ts';
import { parseAdminPage, readAdminPage } from './admin-pagination.ts';
import { audienceContext } from './audience.ts';

async function target(ctx: AppContext, accountId: string) {
  const account = await ctx.db.one<{id:string;name:string;roles_json:string;identity_state:string;disabled_at:number|null}>(
    'SELECT id,name,roles_json,identity_state,disabled_at FROM accounts WHERE id=?', accountId);
  if (!account) throw new ApiError(404, 'operator_account_not_found');
  const grants = await ctx.db.all<{id:string;capability:OperatorCapability;created_at:number;expires_at:number;revoked_at:number|null}>(
    'SELECT id,capability,created_at,expires_at,revoked_at FROM operator_capability_grants WHERE account_id=? AND revoked_at IS NULL ORDER BY capability', accountId);
  const revision = (await ctx.db.one<{version:number}>('SELECT version FROM operator_access_versions WHERE account_id=?', accountId))?.version ?? 0;
  const administrator = JSON.parse(account.roles_json).includes('admin');
  return { id: account.id, name: account.disabled_at === null ? account.name : '',
    status: account.disabled_at !== null ? 'deleted' : administrator ? 'administrator' : grants.some(g => g.expires_at > ctx.now()) ? 'delegated' : 'unassigned',
    identity_state: account.identity_state, revision, administrator, capabilities: await operatorCapabilities(ctx, accountId),
    grants: grants.map(g => ({...g, expired: g.expires_at <= ctx.now()})) };
}
async function audit(ctx: AppContext, actor: Actor, accountId: string, action: string, details: Record<string, unknown>) {
  await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
    crypto.randomUUID(), actor.accountId, accountId, action, accountId, stable(details), ctx.now());
}
export async function handleOperatorAccess(request: Request, ctx: AppContext): Promise<Response|null> {
  const url = new URL(request.url), route = /^\/admin\/operators\/([0-9a-f-]{36})(?:\/(capabilities))?$/i.exec(url.pathname);
  if (url.pathname !== '/admin/operators' && !route) return null;
  const actor = await ctx.authenticate(request);
  await requireOperator(ctx, actor);
  if (request.method === 'GET' && !route?.[2]) return ok(await ctx.db.transaction(async () => {
    await requireOperator(ctx, actor);
    if (route) {
      if (url.search) throw new ApiError(400, 'invalid_input');
      const accountId = uuid(route[1]), operator = await target(ctx, accountId);
      await audit(ctx, actor, accountId, 'operator.access.read', {});
      return { operator, available_capabilities: OPERATOR_CAPABILITIES, maximum_grant_days: 30 };
    }
    const page = parseAdminPage(url, {scope:'operator.access',statuses:['administrator','delegated','unassigned']});
    const now = ctx.now();
    const status = `CASE WHEN EXISTS(SELECT 1 FROM json_each(a.roles_json) role WHERE role.value='admin') THEN 'administrator'
      WHEN EXISTS(SELECT 1 FROM operator_capability_grants g WHERE g.account_id=a.id AND g.revoked_at IS NULL AND g.expires_at>${now}) THEN 'delegated' ELSE 'unassigned' END`;
    const result = await readAdminPage(ctx.db,page,{select:`a.id,a.name,a.created_at,${status} status`,from:'accounts a',
      where:"a.disabled_at IS NULL AND a.identity_state='registered_face' AND (EXISTS(SELECT 1 FROM operator_access_versions v WHERE v.account_id=a.id) OR EXISTS(SELECT 1 FROM json_each(a.roles_json) role WHERE role.value='admin'))",
      priority:'0',statusColumn:status,searchColumns:['a.id','a.name'],idColumn:'a.id',createdAtColumn:'a.created_at'});
    return {operators:result.items,page:result.page};
  }));
  if (!route?.[2] || request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  if (url.search) throw new ApiError(400, 'invalid_input');
  const accountId = uuid(route[1]), body = await jsonBody(request,8192);
  if (Object.keys(body).some(k => !['capabilities','expires_at','expected_revision','reason','operation_key'].includes(k)) ||
      !Array.isArray(body.capabilities) || body.capabilities.length > OPERATOR_CAPABILITIES.length ||
      body.capabilities.some(c => !OPERATOR_CAPABILITIES.includes(c)) || new Set(body.capabilities).size !== body.capabilities.length ||
      !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0 ||
      typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.trim().length > 1000 || /[\x00-\x1f\x7f]/.test(body.reason))
    throw new ApiError(400,'operator_access_input_invalid');
  const capabilities = [...body.capabilities].sort() as OperatorCapability[];
  const expires = capabilities.length ? Date.parse(body.expires_at) : null;
  if (capabilities.length && !Number.isSafeInteger(expires) || !capabilities.length && body.expires_at != null)
    throw new ApiError(400,'operator_grant_expiry_invalid');
  const intent = await prepareOperation('operator.access.update',{account_id:accountId,capabilities,expires_at:body.expires_at ?? null,
    expected_revision:body.expected_revision,reason:body.reason.trim(),operation_key:body.operation_key},'operator_access');
  return ok(await ctx.db.transaction(async () => {
    await requireOperator(ctx,actor,true);
    if (actor.accountId === accountId) throw new ApiError(403,'self_management_forbidden');
    return executeOperation(ctx,actor,intent,async restore => {
      await requireOperator(ctx,actor,true);
      if (capabilities.length && (expires! <= ctx.now() || expires! > ctx.now()+30*86400000)) throw new ApiError(400,'operator_grant_expiry_invalid');
      const prerequisite: Record<string,string> = {'users.sessions.revoke':'users.read','support.review':'support.read','safety.review':'safety.read','guardian.review':'guardian.read','privacy.review':'privacy.read','uploads.recover':'uploads.read','retention.manage':'retention.read'};
      if (capabilities.some(capability => prerequisite[capability] && !capabilities.includes(prerequisite[capability] as OperatorCapability))) throw new ApiError(400,'operator_read_capability_required');
      const before = await target(ctx,accountId);
      if (before.administrator) throw new ApiError(409,'administrator_role_not_delegated');
      if (before.revision !== body.expected_revision) throw new ApiError(409,'operator_access_revision_changed');
      if (capabilities.length && (before.status === 'deleted' || before.identity_state !== 'registered_face' ||
          !await ctx.db.one(`SELECT account_id FROM account_audience WHERE account_id=? AND ${audienceBandSQL('account_audience')}='18_plus' AND status='eligible'`,accountId) ||
          !await audienceContext(ctx,accountId,'face_authentication'))) throw new ApiError(403,'operator_adult_required');
      const retiring = before.grants.filter(g => !capabilities.includes(g.capability) || g.expires_at !== expires);
      for (const grant of retiring) await restore.restrict('operator-capability-retired',
        {account_id:accountId,grant_id:grant.id,capability:grant.capability});
      for (const grant of retiring) await ctx.db.run('UPDATE operator_capability_grants SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL',ctx.now(),actor.accountId,grant.id);
      for (const capability of capabilities) if (!before.grants.some(g => g.capability === capability && g.expires_at === expires))
        await ctx.db.run('INSERT INTO operator_capability_grants(id,account_id,capability,granted_by,operation_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
          crypto.randomUUID(),accountId,capability,actor.accountId,intent.key,ctx.now(),expires);
      await ctx.db.run('INSERT INTO operator_access_versions(account_id,version) VALUES(?,1) ON CONFLICT(account_id) DO UPDATE SET version=operator_access_versions.version+1',accountId);
      await audit(ctx,actor,accountId,'operator.access.update',{capabilities,expires_at:expires,revision:before.revision+1,reason:body.reason.trim()});
      return {operator:await target(ctx,accountId),authority:'current_database_grants',administrator_created:false};
    },[accountId]);
  }));
}
