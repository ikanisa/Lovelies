/** Logical declarations only; the additive v16 migration owns installation. */
export const chunkedExportSchemaStatements:readonly string[]=[
    `CREATE TABLE IF NOT EXISTS privacy_export_snapshots(
  id text PRIMARY KEY REFERENCES privacy_exports(id),request_id text NOT NULL UNIQUE REFERENCES privacy_requests(id),
  subject_id text NOT NULL REFERENCES accounts(id),generated_at INTEGER NOT NULL,
  status text NOT NULL CHECK(status IN('capturing','building','publishing','completed','retired')),
  segment_count INTEGER NOT NULL DEFAULT 0 CHECK(segment_count BETWEEN 0 AND 9007199254740991),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 9007199254740991),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes BETWEEN 0 AND 9007199254740991),
  cursor_seq INTEGER NOT NULL DEFAULT 0 CHECK(cursor_seq BETWEEN 0 AND 9007199254740991),
  cursor_offset INTEGER NOT NULL DEFAULT 0 CHECK(cursor_offset BETWEEN 0 AND 9007199254740991),
  emitted_bytes INTEGER NOT NULL DEFAULT 0 CHECK(emitted_bytes BETWEEN 0 AND 9007199254740991),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count BETWEEN 0 AND 9007199254740991),
  hash_state_json text NOT NULL CHECK(json_valid(hash_state_json) AND octet_length(hash_state_json)<=2048),
  chain_sha256 text NOT NULL CHECK(chain_sha256~'^[0-9a-f]{64}$'),sha256 text CHECK(sha256 IS NULL OR sha256~'^[0-9a-f]{64}$'),
  root_write_id text,expires_at INTEGER NOT NULL,CHECK(expires_at>generated_at),
  CHECK(cursor_seq<=segment_count AND emitted_bytes<=total_bytes),
  CHECK(status NOT IN('publishing','completed') OR(cursor_seq=segment_count AND cursor_offset=0 AND emitted_bytes=total_bytes AND sha256 IS NOT NULL AND root_write_id IS NOT NULL))
 )`,
    `CREATE TABLE IF NOT EXISTS privacy_export_snapshot_rows(
  snapshot_id text NOT NULL REFERENCES privacy_export_snapshots(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991),payload_text text NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length=octet_length(payload_text)),PRIMARY KEY(snapshot_id,sequence)
 )`,
    `CREATE TABLE IF NOT EXISTS privacy_export_chunks(
  publication_id text NOT NULL REFERENCES privacy_exports(id),chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 9007199254740991),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 1048576),sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  root_sha256 text NOT NULL CHECK(root_sha256~'^[0-9a-f]{64}$'),object_key text NOT NULL UNIQUE,write_intent_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN('pending','verified')),start_seq INTEGER NOT NULL CHECK(start_seq>=0),start_offset INTEGER NOT NULL CHECK(start_offset>=0),
  end_seq INTEGER NOT NULL CHECK(end_seq>=start_seq),end_offset INTEGER NOT NULL CHECK(end_offset>=0),
  hash_state_json text NOT NULL CHECK(json_valid(hash_state_json) AND octet_length(hash_state_json)<=2048),created_at INTEGER NOT NULL,
  PRIMARY KEY(publication_id,chunk_index),CHECK(end_seq>start_seq OR end_offset>start_offset)
 )`,
    `CREATE INDEX IF NOT EXISTS privacy_export_snapshot_subject ON privacy_export_snapshots(subject_id,expires_at)`,
];
