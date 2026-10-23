/** Additive transfer metadata; private bytes remain in Supabase Storage. */
export const uploadSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS upload_transfers(
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64),
    bytes_received INTEGER NOT NULL DEFAULT 0 CHECK(bytes_received>=0),
    state TEXT NOT NULL CHECK(state IN('uploading','uploaded','cancelled','failed')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
    lease_token TEXT, lease_until INTEGER, error_code TEXT
  )`,
    `CREATE INDEX IF NOT EXISTS upload_transfer_expiry ON upload_transfers(state,expires_at)`,
    `CREATE TABLE IF NOT EXISTS upload_chunks(
    asset_id TEXT NOT NULL REFERENCES upload_transfers(asset_id) ON DELETE CASCADE,
    offset_bytes INTEGER NOT NULL CHECK(offset_bytes>=0),
    byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=262144),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64), object_key TEXT NOT NULL UNIQUE,
    PRIMARY KEY(asset_id,offset_bytes)
  )`,
];
