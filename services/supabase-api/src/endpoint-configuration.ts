/** The public client origin and private service origin are different trust
 * boundaries. No cloud-project hostname or Docker hostname is implicit. */
export type InternalEndpointPolicy = Readonly<{ trustedHttpOrigins?: readonly string[] }>;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function exactUrl(value: string): URL {
    if (typeof value !== 'string' || value !== value.trim() || !value || /[\\\s]/.test(value))
        throw new Error('Invalid endpoint URL');
    // URL parsing normalizes dot segments before callers can inspect them.
    const path = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0];
    if (/%(?:2f|5c)/i.test(path) || path.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment)))
        throw new Error('Endpoint path normalization is forbidden');
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
        throw new Error('Endpoint credentials, query and fragment are forbidden');
    return url;
}

export function internalEndpoint(value: string, policy: InternalEndpointPolicy = {}, allowPath = false): URL {
    const url = exactUrl(value);
    if (!allowPath && url.pathname !== '/') throw new Error('Internal service origin required');
    const trusted = new Set(policy.trustedHttpOrigins ?? []);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback.has(url.hostname) || trusted.has(url.origin))))
        throw new Error('HTTPS or an explicitly trusted private HTTP origin required');
    return url;
}

export function internalEndpointPolicy(value: string | undefined): InternalEndpointPolicy {
    const origins = value ? value.split(',').map(origin => origin.trim()) : [];
    if (origins.some(origin => !origin)) throw new Error('Empty trusted internal service origin');
    for (const origin of origins) {
        const url = exactUrl(origin);
        if (url.protocol !== 'http:' || url.pathname !== '/' || url.origin !== origin)
            throw new Error('Trusted internal HTTP entries must be exact origins');
    }
    return Object.freeze({ trustedHttpOrigins: Object.freeze([...new Set(origins)]) });
}

export function publicApiBase(value: string, environment = 'production'): string {
    const url = exactUrl(value);
    const development = ['test', 'development', 'local'].includes(environment);
    if (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && loopback.has(url.hostname)))
        throw new Error('Public API HTTPS required');
    if (!/^\/functions\/v1\/lovelies-api\/?$/.test(url.pathname))
        throw new Error('Public API base must end in /functions/v1/lovelies-api');
    return url.origin + '/functions/v1/lovelies-api';
}

export type DatabaseTlsPolicy = Readonly<{
    mode?: 'verify-full' | 'disable-internal';
    trustedPlaintextHosts?: readonly string[];
}>;
export function databaseTlsConfiguration(value: string, rootCertificate?: string, policy: DatabaseTlsPolicy = {}):
    false | 'verify-full' | { rejectUnauthorized: true; ca: string; servername: string } {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash)
        throw new Error('PostgreSQL URL required');
    for (const name of url.searchParams.keys())
        if (/^(ssl|sslmode|sslcert|sslkey|sslrootcert|sslpassword)$/i.test(name))
            throw new Error('Configure PostgreSQL TLS with the explicit TLS policy');
    if (policy.mode !== undefined && !['verify-full', 'disable-internal'].includes(policy.mode))
        throw new Error('Unsupported PostgreSQL TLS mode');
    if (policy.mode === 'disable-internal') {
        if (rootCertificate || !new Set(policy.trustedPlaintextHosts ?? []).has(url.hostname))
            throw new Error('Plaintext PostgreSQL requires an explicitly trusted host and no CA');
        return false;
    }
    return rootCertificate ? { rejectUnauthorized: true, ca: rootCertificate, servername: url.hostname.replace(/^\[|\]$/g, '') } : 'verify-full';
}
