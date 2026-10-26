-- Additive v12: a private, initially EMPTY database checkpoint. A restored row
-- cannot certify itself: serving compares it to the independently current
-- journal. Deployment bootstrap is separate; request handling never seeds it.
SET search_path TO lovelies_private,pg_catalog;
DO $restore_control$
DECLARE migrator name:=current_user; actual bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
   EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
    AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication))
   OR pg_has_role('anon','lovelies_api','MEMBER')
   OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 11 THEN RAISE EXCEPTION 'restore_control_requires_schema_v11'; END IF;
 CREATE TABLE lovelies_private.restore_control(
  singleton SMALLINT PRIMARY KEY CHECK(singleton=1),
  project_id TEXT NOT NULL CHECK(project_id='ltqfplqevxztlswlzexn'),
  database_id TEXT NOT NULL CHECK(database_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  incarnation_id TEXT NOT NULL CHECK(incarnation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  checkpoint_revision BIGINT NOT NULL CHECK(checkpoint_revision BETWEEN 0 AND 9007199254740991),
  checkpoint_hash TEXT NOT NULL CHECK(checkpoint_hash ~ '^[0-9a-f]{64}$'),
  journal_sequence BIGINT NOT NULL CHECK(journal_sequence BETWEEN 0 AND 9007199254740991),
  journal_hash TEXT NOT NULL CHECK(journal_hash ~ '^[0-9a-f]{64}$'),
  last_operation_id TEXT CHECK(last_operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  last_plan_hash TEXT CHECK(last_plan_hash ~ '^[0-9a-f]{64}$'),
  CHECK((checkpoint_revision=0 AND last_operation_id IS NULL AND last_plan_hash IS NULL)
     OR(checkpoint_revision>0 AND last_operation_id IS NOT NULL AND last_plan_hash IS NOT NULL))
 );
 ALTER TABLE lovelies_private.restore_control ENABLE ROW LEVEL SECURITY;
 ALTER TABLE lovelies_private.restore_control FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON lovelies_private.restore_control TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON lovelies_private.restore_control FROM PUBLIC,anon,authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.restore_control TO lovelies_api;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO lovelies_private.schema_versions(version,applied_at)
  VALUES(12,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $restore_control$;
RESET search_path;
