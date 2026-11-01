-- v19: managed anonymous Auth sessions behind existing Lovelies capabilities.
-- No auth schema writes, provider secrets, customer migration or positive backfill.
-- Apply using the self-hosted database migration owner with SELECT authority on
-- auth.sessions/auth.users. Only the boolean functions cross that read boundary.
SET search_path TO lovelies_private,pg_catalog;
DO $managed_auth$
DECLARE migrator name := current_user; actual bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
   EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api' AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
   pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role'; END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 18 THEN RAISE EXCEPTION 'managed_auth_requires_schema_v18'; END IF;
CREATE TABLE managed_auth_bindings(
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,local_session_id TEXT UNIQUE,predecessor_session_id TEXT UNIQUE,
      incarnation_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN('signup','refresh')),
      state TEXT NOT NULL CHECK(state IN('creating','prepared','bound','superseded','ambiguous','retiring','retired')),
      creation_marker TEXT NOT NULL UNIQUE CHECK(length(creation_marker)=64),
      auth_user_id TEXT,auth_session_id TEXT,ciphertext TEXT,iv TEXT,tokens_expires_at BIGINT,
      created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,retire_after BIGINT NOT NULL,
      logout_verified_at BIGINT,user_deleted_at BIGINT,failure_code TEXT,reconcile_page INTEGER NOT NULL DEFAULT 1 CHECK(reconcile_page BETWEEN 1 AND 1000000),
      CHECK((ciphertext IS NULL)=(iv IS NULL)),
      CHECK(state NOT IN('prepared','bound') OR(auth_user_id IS NOT NULL AND auth_session_id IS NOT NULL AND ciphertext IS NOT NULL AND tokens_expires_at IS NOT NULL)),
      CHECK(state<>'bound' OR local_session_id IS NOT NULL),
      CHECK(state<>'retired' OR ciphertext IS NULL));
CREATE INDEX managed_auth_account ON managed_auth_bindings(account_id,state,created_at);
CREATE INDEX managed_auth_identity ON managed_auth_bindings(auth_user_id,state);
CREATE UNIQUE INDEX managed_auth_current_session ON managed_auth_bindings(auth_session_id) WHERE state='bound';
 ALTER TABLE managed_auth_bindings ENABLE ROW LEVEL SECURITY;
 ALTER TABLE managed_auth_bindings FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON managed_auth_bindings TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON managed_auth_bindings FROM PUBLIC,anon,authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON managed_auth_bindings TO lovelies_api;
 CREATE FUNCTION lovelies_private.managed_auth_session_current(user_key text,session_key text,at_millis bigint)
 RETURNS boolean LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $current$
 BEGIN
  IF user_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR session_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR at_millis<0 THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
    WHERE s.id=session_key::uuid AND s.user_id=user_key::uuid AND u.is_anonymous IS TRUE AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until<=to_timestamp(at_millis::double precision/1000.0))
      AND (s.not_after IS NULL OR s.not_after>to_timestamp(at_millis::double precision/1000.0))
      AND s.created_at<=to_timestamp(at_millis::double precision/1000.0)+interval '5 seconds');
 END $current$;
 REVOKE ALL ON FUNCTION lovelies_private.managed_auth_session_current(text,text,bigint) FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION lovelies_private.managed_auth_session_current(text,text,bigint) TO lovelies_api;
 CREATE FUNCTION lovelies_private.managed_auth_user_absent(user_key text)
 RETURNS boolean LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $absent$
 BEGIN
  -- Session inactivity, bans and soft deletion are not physical user absence.
  -- Invalid or missing identifiers cannot manufacture cleanup evidence.
  IF user_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=user_key::uuid);
 END $absent$;
 REVOKE ALL ON FUNCTION lovelies_private.managed_auth_user_absent(text) FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION lovelies_private.managed_auth_user_absent(text) TO lovelies_api;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO schema_versions(version,applied_at) VALUES(19,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $managed_auth$;
RESET search_path;
