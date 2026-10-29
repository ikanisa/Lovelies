// These PGlite-only regressions must never connect to a configured database or
// make an external fetch. The CI job runs them separately from PostgreSQL tests.
if (process.env.TEST_DATABASE_URL !== undefined) throw new Error('external_database_prohibited');
globalThis.fetch = async () => { throw new Error('external_fetch_prohibited'); };
