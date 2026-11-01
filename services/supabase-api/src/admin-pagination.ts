import { base64url, decodeBase64url } from './auth.ts';
import { ApiError, stable, type Database } from './types.ts';

export type AdminPage = {
    scope: string; q: string; status: string; limit: number;
    cursor: { priority: number; created_at: number; id: string } | null;
};
type Options = { scope: string; statuses: readonly string[]; defaultStatus?: string; extraKeys?: readonly string[] };

/** A cursor is a position, never authority. Bind it to the whole query so a
 * cursor from another queue/filter cannot silently omit outstanding work. */
export function parseAdminPage(url: URL, options: Options): AdminPage {
    const params = url.searchParams, keys = [...params.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => !['limit', 'q', 'status', 'cursor', ...(options.extraKeys ?? [])].includes(key)))
        throw new ApiError(400, 'invalid_input');
    const q = (params.get('q') ?? '').trim().normalize('NFC');
    const status = params.get('status') ?? options.defaultStatus ?? 'all';
    const rawLimit = params.get('limit') ?? '25';
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q) || !['all', ...options.statuses].includes(status) ||
        !/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)
        throw new ApiError(400, 'invalid_input');
    const page: AdminPage = { scope: options.scope, q, status, limit: Number(rawLimit), cursor: null };
    const encoded = params.get('cursor');
    if (encoded !== null) {
        try {
            if (!encoded || encoded.length > 2048) throw new Error();
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(encoded, 1536)));
            if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'created_at,id,limit,priority,q,scope,status,v' ||
                value.v !== 1 || value.scope !== page.scope || value.q !== q || value.status !== status || value.limit !== page.limit ||
                !Number.isSafeInteger(value.priority) || value.priority < 0 || value.priority > 100 ||
                !Number.isSafeInteger(value.created_at) || value.created_at < 0 || typeof value.id !== 'string' ||
                !value.id || value.id.length > 256 || /[\u0000-\u001f\u007f]/.test(value.id)) throw new Error();
            page.cursor = { priority: value.priority, created_at: value.created_at, id: value.id };
        } catch { throw new ApiError(400, 'invalid_cursor'); }
    }
    return page;
}

type Query = {
    /** SQL fragments below are constant application code, never request input. */
    select: string; from: string; where?: string; values?: (string | number | null)[];
    priority: string; statusColumn: string; searchColumns: readonly string[];
    idColumn?: string; createdAtColumn?: string;
};

/** Read within the caller's authorized transaction. Oldest open work comes
 * first; the tuple tie-breaker remains deterministic when timestamps match. */
export async function readAdminPage<T extends Record<string, any>>(db: Database, page: AdminPage, query: Query): Promise<{
    items: T[]; page: { limit: number; total: number; has_more: boolean; next_cursor: string | null };
}> {
    const id = query.idColumn ?? 'id', created = query.createdAtColumn ?? 'created_at';
    const where = [query.where ?? '1=1'], values = [...(query.values ?? [])];
    if (page.status !== 'all') { where.push(`${query.statusColumn}=?`); values.push(page.status); }
    if (page.q) {
        if (!query.searchColumns.length) throw new ApiError(400, 'invalid_input');
        const pattern = '%' + page.q.replace(/[\\%_]/g, value => '\\' + value) + '%';
        where.push('(' + query.searchColumns.map(column => `${column} ILIKE ? ESCAPE '\\'`).join(' OR ') + ')');
        values.push(...query.searchColumns.map(() => pattern));
    }
    const totalRow = await db.one<{ n: number }>(`SELECT count(*) n FROM ${query.from} WHERE ${where.join(' AND ')}`, ...values);
    const total = Number(totalRow?.n);
    if (!Number.isSafeInteger(total) || total < 0) throw new ApiError(503, 'admin_page_unavailable');
    if (page.cursor) {
        where.push(`((${query.priority})>? OR ((${query.priority})=? AND (${created}>? OR (${created}=? AND ${id}>?))))`);
        values.push(page.cursor.priority, page.cursor.priority, page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const result = await db.all<T & { _page_priority: number; _page_created_at: number; _page_id: string }>(
        `SELECT ${query.select},(${query.priority}) AS _page_priority,${created} AS _page_created_at,${id} AS _page_id
         FROM ${query.from} WHERE ${where.join(' AND ')} ORDER BY _page_priority,${created},${id} LIMIT ?`, ...values, page.limit + 1);
    const selected = result.slice(0, page.limit), last = selected.at(-1), hasMore = result.length > page.limit;
    if (last && (!Number.isSafeInteger(last._page_priority) || !Number.isSafeInteger(last._page_created_at) ||
        last._page_created_at < 0 || typeof last._page_id !== 'string' || !last._page_id || last._page_id.length > 256))
        throw new ApiError(503, 'admin_page_unavailable');
    const next = hasMore && last ? base64url(new TextEncoder().encode(stable({
        v: 1, scope: page.scope, q: page.q, status: page.status, limit: page.limit,
        priority: last._page_priority, created_at: last._page_created_at, id: last._page_id,
    }))) : null;
    return { items: selected.map(row => {
        const { _page_priority, _page_created_at, _page_id, ...item } = row;
        return item as unknown as T;
    }), page: { limit: page.limit, total, has_more: hasMore, next_cursor: next } };
}
