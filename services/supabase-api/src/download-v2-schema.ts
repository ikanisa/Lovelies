export const downloadV2SchemaStatements:readonly string[]=[
  `CREATE TABLE IF NOT EXISTS download_v2_operations(operation_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,operation_key TEXT NOT NULL,
    asset_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN('issued','not_issued')),
    receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json)='object')),
    receipt_hash TEXT NOT NULL CHECK(length(receipt_hash)=64),recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),retired_at INTEGER,
    UNIQUE(account_id,operation_key),CHECK((retired_at IS NULL)=(receipt_json IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS download_v2_tickets(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES download_v2_operations(operation_id),receipt_hash TEXT NOT NULL CHECK(length(receipt_hash)=64))`,
  `CREATE INDEX IF NOT EXISTS download_v2_asset ON download_v2_operations(asset_id,retired_at)`,
];
