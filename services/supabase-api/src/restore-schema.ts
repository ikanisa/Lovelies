/** Logical schema; migration15 supplies forced RLS and transaction capture triggers. */
export const restoreRecoverySchemaStatements: readonly string[] = [
`CREATE TABLE IF NOT EXISTS restore_transaction_facts(
   id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
   kind TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), captured_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS restore_recovery_runs(
   id TEXT PRIMARY KEY, database_id TEXT NOT NULL, prior_incarnation_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
   generation_hash TEXT NOT NULL,
   restriction_sequence INTEGER NOT NULL CHECK(restriction_sequence>=0), restriction_hash TEXT NOT NULL,
   replayed_sequence INTEGER NOT NULL DEFAULT 0 CHECK(replayed_sequence>=0), replayed_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
   state TEXT NOT NULL CHECK(state IN('replaying','cleanup','prepared','complete')),
   retired_at INTEGER, clearance_json TEXT CHECK(clearance_json IS NULL OR json_valid(clearance_json)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS restore_replay_facts(
   sequence INTEGER PRIMARY KEY CHECK(sequence>0), hash TEXT NOT NULL,
   operation_id TEXT NOT NULL, kind TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), applied_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS restore_recovered_operations(
   operation_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, plan_hash TEXT NOT NULL,
   outcome TEXT NOT NULL CHECK(outcome IN('restricted-abort','restore-retired')), recovered_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS restore_cleanup_objects(
   recovery_id TEXT NOT NULL REFERENCES restore_recovery_runs(id), effect_id TEXT NOT NULL,
   bucket TEXT NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE','PRIVACY_EXPORTS')), object_key TEXT NOT NULL,
   expected_sha256 TEXT NOT NULL CHECK(expected_sha256 ~ '^[0-9a-f]{64}$'), expected_bytes INTEGER NOT NULL CHECK(expected_bytes>=0),
   status TEXT NOT NULL CHECK(status IN('pending','absent','preserved','blocked')), proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
   updated_at INTEGER NOT NULL, PRIMARY KEY(recovery_id,effect_id)
)`
];
