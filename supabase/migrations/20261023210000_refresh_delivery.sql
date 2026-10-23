-- Additive v8: exact refresh credential delivery and cancellation reconciliation.
-- Apply AFTER 20261023162016_lovelies_private_core.sql, in one migration transaction.
-- The reviewed v7 baseline is intentionally unchanged. No existing data is reset.
DO $preflight$
DECLARE migrator name := current_user; version bigint;
BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
     EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
       AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
     pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
    RAISE EXCEPTION 'unexpected_lovelies_api_role';
  END IF;
  IF has_schema_privilege('anon','lovelies_private','USAGE') OR
     has_schema_privilege('authenticated','lovelies_private','USAGE') THEN
    RAISE EXCEPTION 'unexpected_lovelies_private_privileges';
  END IF;
  -- The v7 migration grants this SET ROLE membership to the Supabase postgres
  -- migration account. Do not disable FORCE RLS to read or update metadata.
  EXECUTE 'SET LOCAL ROLE lovelies_api';
  SELECT max(v.version) INTO version FROM lovelies_private.schema_versions v;
  IF version IS DISTINCT FROM 7 THEN RAISE EXCEPTION 'refresh_delivery_requires_schema_v7'; END IF;
  EXECUTE format('SET LOCAL ROLE %I',migrator);
END $preflight$;

CREATE TABLE lovelies_private.refresh_delivery_receipts(
  original_session_id text PRIMARY KEY REFERENCES lovelies_private.sessions(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES lovelies_private.accounts(id) ON DELETE CASCADE,
  rotation_key text NOT NULL UNIQUE, secret_hash text NOT NULL CHECK(length(secret_hash)=64),
  successor_session_id text UNIQUE REFERENCES lovelies_private.sessions(id) ON DELETE CASCADE,
  state text NOT NULL CHECK(state IN('active','cancelled')), ciphertext text, iv text,
  created_at bigint NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>created_at),
  CHECK(original_session_id<>successor_session_id),
  CHECK((state='active' AND successor_session_id IS NOT NULL AND ciphertext IS NOT NULL
    AND length(ciphertext) BETWEEN 22 AND 16384 AND iv IS NOT NULL AND length(iv)=16)
    OR (state='cancelled' AND ciphertext IS NULL AND iv IS NULL))
);
CREATE INDEX refresh_delivery_expiry ON lovelies_private.refresh_delivery_receipts(expires_at,original_session_id);
ALTER TABLE lovelies_private.refresh_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lovelies_private.refresh_delivery_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON lovelies_private.refresh_delivery_receipts TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON lovelies_private.refresh_delivery_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.refresh_delivery_receipts TO lovelies_api;

DO $version$
DECLARE migrator name := current_user;
BEGIN
  EXECUTE 'SET LOCAL ROLE lovelies_api';
  INSERT INTO lovelies_private.schema_versions(version,applied_at)
    VALUES(8,(extract(epoch FROM clock_timestamp())*1000)::bigint);
  EXECUTE format('SET LOCAL ROLE %I',migrator);
END $version$;
