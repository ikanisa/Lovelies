-- Additive v17. Explicit, expiring operator capabilities; no account receives
-- a grant from this migration. Provisioning remains an authenticated action.
SET search_path TO lovelies_private,pg_catalog;
DO $operator_capabilities$
DECLARE migrator name:=current_user; actual bigint; relation name;
BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
   AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication))
   OR pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 16 THEN RAISE EXCEPTION 'operator_capabilities_requires_schema_v16'; END IF;
 CREATE TABLE lovelies_private.operator_access_versions(
  account_id TEXT PRIMARY KEY REFERENCES lovelies_private.accounts(id),version BIGINT NOT NULL CHECK(version>0));
 CREATE TABLE lovelies_private.operator_capability_grants(
  id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES lovelies_private.accounts(id),
  capability TEXT NOT NULL CHECK(capability IN('overview.read','users.read','users.sessions.revoke','support.read','support.review',
   'safety.read','safety.review','guardian.read','guardian.review','privacy.read','privacy.review','uploads.read','uploads.recover','retention.read','retention.manage')),
  granted_by TEXT NOT NULL REFERENCES lovelies_private.accounts(id),operation_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,revoked_at BIGINT,revoked_by TEXT REFERENCES lovelies_private.accounts(id),
  CHECK(account_id<>granted_by),CHECK(expires_at>created_at),CHECK(revoked_at IS NULL OR revoked_at>=created_at));
 CREATE UNIQUE INDEX operator_capability_active ON lovelies_private.operator_capability_grants(account_id,capability) WHERE revoked_at IS NULL;
 CREATE INDEX operator_capability_subject ON lovelies_private.operator_capability_grants(account_id,expires_at);
 FOREACH relation IN ARRAY ARRAY['operator_access_versions','operator_capability_grants'] LOOP
  EXECUTE format('ALTER TABLE lovelies_private.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE lovelies_private.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY backend_only ON lovelies_private.%I TO lovelies_api USING(true) WITH CHECK(true)',relation);
  EXECUTE format('REVOKE ALL ON lovelies_private.%I FROM PUBLIC,anon,authenticated',relation);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.%I TO lovelies_api',relation);
 END LOOP;
 CREATE FUNCTION guard_operator_capability_binding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
  IF (to_jsonb(NEW)-'revoked_at'-'revoked_by') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by')
     OR OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='operator_capability_binding_immutable';
  END IF;
  RETURN NEW;
 END $f$;
 CREATE TRIGGER capture_restore_restriction AFTER UPDATE OR DELETE ON operator_capability_grants FOR EACH ROW EXECUTE FUNCTION lovelies_private.capture_restore_restriction();
 CREATE TRIGGER operator_capability_binding BEFORE UPDATE ON operator_capability_grants FOR EACH ROW EXECUTE FUNCTION guard_operator_capability_binding();
 REVOKE ALL ON FUNCTION guard_operator_capability_binding() FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION guard_operator_capability_binding() TO lovelies_api;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO lovelies_private.schema_versions(version,applied_at) VALUES(17,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $operator_capabilities$;
RESET search_path;
