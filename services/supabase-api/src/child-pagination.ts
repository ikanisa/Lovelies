import { base64url, decodeBase64url } from './auth.ts';
import { ApiError, stable, uuid, type AppContext } from './types.ts';

export type AdminPageRow = { id: string; created_at: number; queue_rank?: number };
type Position = AdminPageRow;
export type AdminPageQuery = {
    scope: string; q: string; status: string; sort: 'newest' | 'oldest'; limit: number;
    ranked: boolean; cursor: Position | null;
};
type Options = {
    scope: string; statuses: readonly string[]; defaultStatus?: string;
    defaultSort?: 'newest' | 'oldest'; defaultLimit?: number; ranked?: boolean;
    idFormat?: 'uuid' | 'sha256';
};

/** A cursor is a bounded query position, never authorization. Each caller must
 * recheck current operator authority and its account scope inside the read
 * transaction. Binding the scope and filters prevents accidental cross-queue
 * continuation. A refresh intentionally starts a new view of live records. */
export function readAdminPage(params: URLSearchParams, options: Options): AdminPageQuery {
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => !['q', 'status', 'sort', 'limit', 'cursor'].includes(key)))
        throw new ApiError(400, 'invalid_input');
    const q = (params.get('q') ?? '').trim().normalize('NFC');
    const status = params.get('status') ?? options.defaultStatus ?? 'all';
    const sort = params.get('sort') ?? options.defaultSort ?? 'newest';
    const limit = params.get('limit') ?? String(options.defaultLimit ?? 25);
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q) || !options.statuses.includes(status) ||
        !['newest', 'oldest'].includes(sort) || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100)
        throw new ApiError(400, 'invalid_input');
    const page: AdminPageQuery = { scope: options.scope, q, status, sort: sort as AdminPageQuery['sort'],
        limit: Number(limit), ranked: options.ranked ?? false, cursor: null };
    const raw = params.get('cursor');
    if (raw !== null) {
        try {
            if (raw.length > 4096) throw new Error();
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(raw, 3072)));
            const expected = page.ranked ? 'created_at,id,limit,q,queue_rank,scope,sort,status,v' : 'created_at,id,limit,q,scope,sort,status,v';
            if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== expected || value.v !== 1 ||
                value.scope !== page.scope || value.q !== page.q || value.status !== page.status || value.sort !== page.sort ||
                value.limit !== page.limit || !Number.isSafeInteger(value.created_at) || value.created_at < 0 ||
                page.ranked && ![0, 1].includes(value.queue_rank)) throw new Error();
            let id: string;
            if (options.idFormat === 'sha256') {
                if (typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id)) throw new Error();
                id = value.id;
            } else id = uuid(value.id);
            page.cursor = { id, created_at: value.created_at,
                ...(page.ranked ? { queue_rank: value.queue_rank } : {}) };
        } catch { throw new ApiError(400, 'invalid_cursor'); }
    }
    return page;
}

export function adminSearch(q: string, columns: readonly string[]): { clause: string; values: string[] } {
    if (!q) return { clause: 'TRUE', values: [] };
    const pattern = '%' + q.replace(/[\\%_]/g, value => '\\' + value) + '%';
    return { clause: '(' + columns.map(column => `${column} ILIKE ? ESCAPE '\\'`).join(' OR ') + ')',
        values: columns.map(() => pattern) };
}

export function adminStatus(status: string, column: string, attention: readonly string[]): { clause: string; values: string[] } {
    if (status === 'all') return { clause: 'TRUE', values: [] };
    if (status === 'attention') return { clause: `${column} IN (${attention.map(() => '?').join(',')})`, values: [...attention] };
    return { clause: `${column}=?`, values: [status] };
}

/** SQL fragments and identifiers are only supplied by the repository's route
 * implementations. All request values remain bound parameters. */
export async function selectAdminPage<T extends AdminPageRow>(ctx: AppContext, page: AdminPageQuery, query: {
    select: string; from: string; where?: string[]; values?: (string | number)[];
    idColumn?: string; createdColumn?: string; rankColumn?: string;
}) {
    const id = query.idColumn ?? 'id', created = query.createdColumn ?? 'created_at';
    const rank = query.rankColumn ?? 'queue_rank';
    const where = [...query.where ?? []], values = [...query.values ?? []];
    const suffix = (parts: string[]) => parts.length ? ' WHERE ' + parts.map(clause => '(' + clause + ')').join(' AND ') : '';
    const total = (await ctx.db.one<{ n: number }>(`SELECT count(*) n FROM ${query.from}${suffix(where)}`, ...values))!.n;
    if (page.cursor) {
        const position = `(${created}${page.sort === 'newest' ? '<' : '>'}? OR (${created}=? AND ${id}>?))`;
        if (page.ranked) {
            where.push(`(${rank}>? OR (${rank}=? AND ${position}))`);
            values.push(page.cursor.queue_rank!, page.cursor.queue_rank!);
        } else where.push(position);
        values.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const rows = await ctx.db.all<T>(`SELECT ${query.select} FROM ${query.from}${suffix(where)} ORDER BY ${page.ranked ? rank + ' ASC,' : ''}${created} ${page.sort === 'newest' ? 'DESC' : 'ASC'},${id} ASC LIMIT ?`, ...values, page.limit + 1);
    const items = rows.slice(0, page.limit), last = items.at(-1), hasMore = rows.length > page.limit;
    const next = hasMore && last ? base64url(new TextEncoder().encode(stable({ v: 1, scope: page.scope, q: page.q,
        status: page.status, sort: page.sort, limit: page.limit, id: last.id, created_at: last.created_at,
        ...(page.ranked ? { queue_rank: last.queue_rank } : {}) }))) : null;
    return { items, page: { limit: page.limit, has_more: hasMore, next_cursor: next, total, sort: page.sort } };
}
