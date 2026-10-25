-- Additive v11: private class and per-source retention scan continuation only.
-- No cursor seed, audience backfill, imports, retention-date changes or deletions.
SET search_path TO lovelies_private,pg_catalog;
DO $retention_cursors$
DECLARE migrator name:=current_user; actual bigint;
BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
   AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication))
   OR pg_has_role('anon','lovelies_api','MEMBER')
   OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 10 THEN
  RAISE EXCEPTION 'retention_scan_cursors_requires_schema_v10';
 END IF;
 CREATE TABLE lovelies_private.retention_scan_cursors(
  scan TEXT NOT NULL CHECK(scan IN('support','guardian','adult','privacy')),
  entity_id TEXT NOT NULL DEFAULT '',
  last_at BIGINT,last_id TEXT,PRIMARY KEY(scan,entity_id),CHECK((last_at IS NULL)=(last_id IS NULL))
 );
 ALTER TABLE lovelies_private.retention_scan_cursors ENABLE ROW LEVEL SECURITY;
 ALTER TABLE lovelies_private.retention_scan_cursors FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON lovelies_private.retention_scan_cursors TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON lovelies_private.retention_scan_cursors FROM PUBLIC,anon,authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.retention_scan_cursors TO lovelies_api;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO lovelies_private.schema_versions(version,applied_at)
  VALUES(11,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $retention_cursors$;
RESET search_path;
