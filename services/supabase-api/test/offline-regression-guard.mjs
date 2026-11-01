// These PGlite-only regressions must never connect to a configured database or
// make an external fetch. The CI job runs them separately from PostgreSQL tests.
import {beforeEach, afterEach} from 'node:test';
if (process.env.TEST_DATABASE_URL !== undefined) throw new Error('external_database_prohibited');
globalThis.fetch = async () => { throw new Error('external_fetch_prohibited'); };
// PGlite's WebAssembly memory is external to V8's ordinary object heap. A long
// fixture file must release closed engines between cases instead of waiting for
// an unrelated allocation threshold on a shared host. The local runner exposes
// GC only to these synthetic test processes; application runtime is unchanged.
const releaseClosedFixtures = () => globalThis.gc?.();
beforeEach(releaseClosedFixtures);
afterEach(releaseClosedFixtures);
