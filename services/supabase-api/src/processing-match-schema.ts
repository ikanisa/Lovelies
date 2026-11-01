/** Private durable capture metadata and bounded numerical progress. Raw face
 * templates and query embeddings remain in the existing private model path. */
export const processingMatchSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS processing_attempt_profiles(
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0), account_id TEXT NOT NULL,
        profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND length(profile_json)<=8192),
        PRIMARY KEY(attempt_id,ordinal), UNIQUE(attempt_id,account_id)
    )`,
    `CREATE INDEX IF NOT EXISTS processing_attempt_profiles_subject ON processing_attempt_profiles(account_id,attempt_id)`,
    `CREATE TABLE IF NOT EXISTS processing_match_progress(
        attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id) ON DELETE CASCADE,
        plan_sha256 TEXT NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
        next_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(next_ordinal>=0),
        chain_sha256 TEXT NOT NULL CHECK(chain_sha256 ~ '^[0-9a-f]{64}$'),
        query_sha256 TEXT CHECK(query_sha256 IS NULL OR query_sha256 ~ '^[0-9a-f]{64}$'),
        ranks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(ranks_json) AND length(ranks_json)<=262144), updated_at INTEGER NOT NULL
    )`,
    `CREATE TRIGGER IF NOT EXISTS processing_attempt_profile_immutable BEFORE UPDATE ON processing_attempt_profiles
        BEGIN SELECT RAISE(ABORT,'matching_capture_immutable'); END`,
];
