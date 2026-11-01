import { internalEndpoint, type InternalEndpointPolicy } from './endpoint-configuration.ts';
import { ApiError, jsonBody, uuid } from './types.ts';

export type ManagedTokens = Readonly<{
    access_token: string; refresh_token: string; user_id: string; session_id: string; expires_at: number;
}>;
export interface ManagedAuthProvider {
    signUp(marker: string): Promise<ManagedTokens>;
    refresh(refreshToken: string): Promise<ManagedTokens>;
    signOut(accessToken: string): Promise<void>;
    deleteUser(userId: string): Promise<void>;
    userExists(userId: string): Promise<boolean>;
    /** Cleanup discovery only. The marker must never grant app authority. */
    signupCandidates(marker: string, createdAt: number, page: number): Promise<{ userIds: readonly string[]; nextPage: number }>;
    ready(): Promise<boolean>;
}
const unavailable = (code = 'managed_auth_unavailable'): never => { throw new ApiError(503, code); };
const discard = (response: Response): void => { try { void response.body?.cancel().catch(() => {}); } catch {} };

/** Only supported GoTrue HTTP APIs create, refresh, sign out and delete managed
 * identities. No SQL writes to auth internals and no locally minted Auth JWTs.
 * The anonymous managed identity is deliberately separate from face authority. */
export class SupabaseManagedAuth implements ManagedAuthProvider {
    private readonly base: string;
    constructor(origin: string, private readonly anonKey: string, private readonly serviceKey: string,
        private readonly fetcher: typeof fetch = fetch, policy: InternalEndpointPolicy = {}, private readonly timeoutMs = 10_000) {
        this.base = internalEndpoint(origin, policy).origin + '/auth/v1';
        if (!anonKey || !serviceKey || anonKey === serviceKey || timeoutMs < 1 || timeoutMs > 15_000)
            throw new Error('Managed Auth requires separate server and anonymous keys and a bounded timeout');
    }
    private async request(path: string, method = 'GET', body?: unknown, access?: string, admin = false): Promise<{
        status: number; value: Record<string, any>;
    }> {
        const key = admin ? this.serviceKey : this.anonKey;
        const headers = new Headers({ apikey: key, Accept: 'application/json' });
        if (access) headers.set('Authorization', 'Bearer ' + access);
        else if (admin && key.split('.').length === 3) headers.set('Authorization', 'Bearer ' + key);
        if (body !== undefined) headers.set('Content-Type', 'application/json');
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined, response: Response | undefined;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new ApiError(503, 'managed_auth_transport_unresolved')); }, this.timeoutMs);
        });
        void expired.catch(() => {});
        const pending = this.fetcher(this.base + path, { method, headers, redirect: 'manual', signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        void pending.then(value => { if (controller.signal.aborted) discard(value); }, () => {});
        try {
            response = await Promise.race([pending, expired]);
            if (response.redirected || response.status >= 300 && response.status < 400) {
                discard(response); return unavailable('managed_auth_redirect_denied');
            }
            if (response.status === 204) { discard(response); return { status: response.status, value: {} }; }
            const value = await Promise.race([jsonBody(response, 128 * 1024, { timeoutMs: this.timeoutMs, signal: controller.signal }), expired]);
            return { status: response.status, value };
        } catch (error) {
            if (response) discard(response);
            if (error instanceof ApiError && error.code === 'managed_auth_redirect_denied') throw error;
            return unavailable('managed_auth_transport_unresolved');
        } finally { clearTimeout(timer); }
    }
    private async session(value: Record<string, any>): Promise<ManagedTokens> {
        if (value.token_type?.toLowerCase() !== 'bearer' || typeof value.access_token !== 'string' || value.access_token.length > 16_384 ||
            typeof value.refresh_token !== 'string' || value.refresh_token.length < 12 || value.refresh_token.length > 4096 ||
            !value.user || value.user.is_anonymous !== true) return unavailable('managed_auth_reply_unbound');
        let claims: Record<string, any>;
        try {
            const pieces = value.access_token.split('.');
            if (pieces.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(pieces[1])) throw new Error();
            claims = JSON.parse(atob(pieces[1].replace(/-/g, '+').replace(/_/g, '/')));
            uuid(claims.sub); uuid(claims.session_id);
        } catch { return unavailable('managed_auth_reply_unbound'); }
        if (claims.sub !== value.user.id || claims.role !== 'authenticated' || claims.is_anonymous !== true ||
            !(claims.aud === 'authenticated' || Array.isArray(claims.aud) && claims.aud.includes('authenticated')) ||
            !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now() ||
            value.expires_at !== undefined && value.expires_at !== claims.exp) return unavailable('managed_auth_reply_unbound');
        // Decoding above only binds fields. GoTrue itself verifies its signature
        // and identity before any prepared credentials can be accepted.
        const verified = await this.request('/user', 'GET', undefined, value.access_token);
        if (verified.status !== 200 || verified.value.id !== claims.sub || verified.value.is_anonymous !== true)
            return unavailable('managed_auth_reply_unbound');
        return Object.freeze({ access_token: value.access_token, refresh_token: value.refresh_token,
            user_id: claims.sub, session_id: claims.session_id, expires_at: claims.exp * 1000 });
    }
    async signUp(marker: string): Promise<ManagedTokens> {
        if (!/^[0-9a-f]{64}$/.test(marker)) return unavailable('managed_auth_attempt_invalid');
        const response = await this.request('/signup', 'POST', { data: { lovelies_creation_marker: marker } });
        if (response.status !== 200 && response.status !== 201) return unavailable('managed_auth_signup_rejected');
        return this.session(response.value);
    }
    async refresh(refreshToken: string): Promise<ManagedTokens> {
        const response = await this.request('/token?grant_type=refresh_token', 'POST', { refresh_token: refreshToken });
        if (response.status !== 200) return unavailable('managed_auth_refresh_rejected');
        return this.session(response.value);
    }
    async signOut(accessToken: string): Promise<void> {
        const response = await this.request('/logout?scope=local', 'POST', undefined, accessToken, true);
        if (![200, 204].includes(response.status)) return unavailable('managed_auth_logout_unresolved');
    }
    async deleteUser(userId: string): Promise<void> {
        uuid(userId);
        const response = await this.request('/admin/users/' + userId, 'DELETE', { should_soft_delete: false }, undefined, true);
        if (![200, 204].includes(response.status) && !(response.status === 404 &&
            [response.value.code, response.value.error_code].includes('user_not_found')))
            return unavailable('managed_auth_delete_unresolved');
    }
    async userExists(userId: string): Promise<boolean> {
        uuid(userId);
        const response = await this.request('/admin/users/' + userId, 'GET', undefined, undefined, true);
        if (response.status === 404 && [response.value.code, response.value.error_code].includes('user_not_found')) return false;
        if (response.status !== 200 || response.value.id !== userId) return unavailable('managed_auth_user_unverified');
        return true;
    }
    async signupCandidates(marker: string, createdAt: number, page: number): Promise<{ userIds: readonly string[]; nextPage: number }> {
        if (!/^[0-9a-f]{64}$/.test(marker) || !Number.isSafeInteger(createdAt) || createdAt < 1 ||
            !Number.isSafeInteger(page) || page < 1 || page > 1_000_000) return unavailable('managed_auth_attempt_invalid');
        // This is the supported admin listUsers/getUserById API. A bounded page
        // is examined per maintenance turn; lack of a match is NOT evidence
        // that an uncertain signup never created an identity.
        const response = await this.request('/admin/users?page=' + page + '&per_page=50', 'GET', undefined, undefined, true);
        if (response.status !== 200 || !Array.isArray(response.value.users) || response.value.users.length > 50)
            return unavailable('managed_auth_lookup_unresolved');
        const matches = (value: Record<string, any>): boolean => {
            const instant = Date.parse(value.created_at);
            return value.is_anonymous === true && value.user_metadata?.lovelies_creation_marker === marker &&
                Number.isFinite(instant) && instant >= createdAt - 5_000 && instant <= createdAt + 60_000;
        };
        const userIds: string[] = [];
        for (const user of response.value.users) {
            if (!user || typeof user !== 'object') return unavailable('managed_auth_lookup_unresolved');
            if (!matches(user)) continue;
            try { uuid(user.id); } catch { return unavailable('managed_auth_lookup_unresolved'); }
            const exact = await this.request('/admin/users/' + user.id, 'GET', undefined, undefined, true);
            if (exact.status !== 200 || exact.value.id !== user.id || !matches(exact.value))
                return unavailable('managed_auth_lookup_unresolved');
            userIds.push(user.id);
            if (userIds.length > 1) return unavailable('managed_auth_lookup_ambiguous');
        }
        return { userIds: Object.freeze(userIds), nextPage: response.value.users.length < 50 ? 1 : page + 1 };
    }
    async ready(): Promise<boolean> {
        const response = await this.request('/settings');
        return response.status === 200 && response.value.disable_signup === false && response.value.external?.anonymous_users === true;
    }
}
