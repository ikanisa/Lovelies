import { base64url, decodeBase64url } from './auth.ts';
import { ApiError, stable, uuid } from './types.ts';

type Cursor = { created_at: number; id: string };
/** A cursor is a position, never authorization. Bind it to the account and
 * collection so it cannot accidentally continue a different user's list. */
export function accountPage(input: { limit?: unknown; cursor?: unknown }, account: string, scope: string): { limit: number; cursor: Cursor | null } {
    const limit = input.limit == null ? 25 : typeof input.limit === 'string' && /^[1-9][0-9]*$/.test(input.limit) ? Number(input.limit) : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_page_limit');
    if (input.cursor == null || input.cursor === '') return { limit, cursor: null };
    const invalid = (): never => { throw new ApiError(400, 'invalid_cursor'); };
    if (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(input.cursor)) return invalid();
    try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(input.cursor, 768)));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'account_id,created_at,id,scope,version' ||
            value.version !== 1 || value.account_id !== account || value.scope !== scope || !Number.isSafeInteger(value.created_at) || value.created_at < 0 || uuid(value.id) !== value.id) return invalid();
        return { limit, cursor: { created_at: value.created_at, id: value.id } };
    } catch { return invalid(); }
}
export function accountCursor(row: Cursor, account: string, scope: string): string {
    return base64url(new TextEncoder().encode(stable({ version: 1, account_id: account, scope, created_at: row.created_at, id: row.id })));
}
