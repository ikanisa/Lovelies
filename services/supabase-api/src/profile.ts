import { executeOperation, prepareOperation } from './operations.ts';
import { ApiError, jsonBody, ok, type AppContext } from './types.ts';
/** Account-private profile edits cannot alter identity, roles or entitlements. */
export async function handleProfile(request: Request, ctx: AppContext): Promise<Response | null> {
    if (new URL(request.url).pathname !== '/me/profile')
        return null;
    if (!['GET', 'PATCH'].includes(request.method))
        throw new ApiError(405, 'method_not_allowed');
    const actor = await ctx.authenticate(request);
    (await ctx.assertActor(actor));
    if (request.method === 'GET') {
        const row = (await ctx.db.one<{
            name: string;
        }>('SELECT name FROM accounts WHERE id=?', actor.accountId));
        (await ctx.assertActor(actor));
        return ok({ user_id: actor.accountId, name: row?.name ?? '', profile_scope: 'registered_face_profile' });
    }
    const input = await jsonBody(request, 4096);
    if (Object.keys(input).some(key => !['name', 'operation_key'].includes(key)) || typeof input.name !== 'string')
        throw new ApiError(400, 'profile_input_invalid');
    const name = input.name.normalize('NFC').trim();
    if (!name || [...name].length > 120 || /[\u0000-\u001f\u007f]/.test(name))
        throw new ApiError(400, 'profile_name_invalid');
    const intent = await prepareOperation('account.profile.update', { ...input, name }, 'account');
    return ok((await executeOperation(ctx, actor, intent, async () => {
        (await ctx.db.run('UPDATE accounts SET name=? WHERE id=?', name, actor.accountId));
        return { user_id: actor.accountId, name, profile_scope: 'registered_face_profile' };
    })));
}
