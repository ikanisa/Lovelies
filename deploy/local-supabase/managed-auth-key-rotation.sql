-- Deployment-owned metadata, installed only by the explicit operator bootstrap.
-- The ciphertext update, restore marker and this immutable receipt share COMMIT.
CREATE SCHEMA IF NOT EXISTS lovelies_deployment;
CREATE TABLE IF NOT EXISTS lovelies_deployment.managed_auth_key_rotations(
 rotation_id text PRIMARY KEY CHECK(rotation_id ~ '^[0-9a-f-]{36}$'),
 input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
 receipt_json text NOT NULL CHECK(length(receipt_json) BETWEEN 1 AND 32768),
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON SCHEMA lovelies_deployment FROM PUBLIC,anon,authenticated,service_role,lovelies_api,lovelies_runtime;
REVOKE ALL ON lovelies_deployment.managed_auth_key_rotations FROM PUBLIC,anon,authenticated,service_role,lovelies_api,lovelies_runtime,lovelies_rotation;
GRANT USAGE ON SCHEMA lovelies_deployment TO lovelies_rotation;
GRANT SELECT,INSERT ON lovelies_deployment.managed_auth_key_rotations TO lovelies_rotation;
-- No UPDATE/DELETE/TRUNCATE or schema CREATE; the normal runtime cannot SET this role.
