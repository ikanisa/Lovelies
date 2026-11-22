-- Proposed additive v14: private bounded operator schedule reservations.
-- No command seed, legacy import, provider work or existing data change.
SET search_path TO lovelies_private,pg_catalog;
DO $retention_schedule$
DECLARE migrator name:=current_user; actual bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
   EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
     AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
   pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 13 THEN RAISE EXCEPTION 'retention_schedule_requires_schema_v13'; END IF;
 CREATE TABLE lovelies_private.retention_schedule_commands(
   id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source='retention'), operation_key TEXT NOT NULL,
   payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
   limit_count BIGINT NOT NULL CHECK(limit_count BETWEEN 1 AND 200), planned_count BIGINT NOT NULL CHECK(planned_count BETWEEN 0 AND limit_count),
   next_position BIGINT NOT NULL CHECK(next_position BETWEEN 0 AND planned_count), plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
   created_at BIGINT NOT NULL, UNIQUE(actor_id,source,operation_key),
   FOREIGN KEY(actor_id,source,operation_key) REFERENCES lovelies_private.operations(actor_id,source,operation_key) ON DELETE CASCADE
 );
 CREATE TABLE lovelies_private.retention_schedule_items(
   command_id TEXT NOT NULL REFERENCES lovelies_private.retention_schedule_commands(id) ON DELETE CASCADE,
   position BIGINT NOT NULL CHECK(position BETWEEN 0 AND 199), asset_id TEXT NOT NULL REFERENCES lovelies_private.assets(id) ON DELETE CASCADE,
   owner_id TEXT NOT NULL REFERENCES lovelies_private.accounts(id) ON DELETE CASCADE,
   source_version TEXT NOT NULL, snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
   outcome TEXT NOT NULL CHECK(outcome IN('pending','raw','preview','replaced','already_retired')), completion_id TEXT, superseding_id TEXT,
   CHECK((outcome='pending')=(completion_id IS NULL)), CHECK((outcome='already_retired')=(superseding_id IS NOT NULL)), PRIMARY KEY(command_id,position), UNIQUE(command_id,asset_id)
 );
 -- Ephemeral guard rows are inserted after journal prepare. A deferred
 -- constraint trigger evaluates the database clock during COMMIT and removes
 -- the row. Trigger failure rolls back SQL but never clears a journal plan.
 CREATE TABLE lovelies_private.retention_schedule_commit_guards(
   id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, session_id TEXT NOT NULL,
   auth_epoch BIGINT NOT NULL, deadline_db_ms BIGINT NOT NULL
 );
 CREATE FUNCTION lovelies_private.retention_schedule_check_commit_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=lovelies_private,pg_catalog AS $guard$
 DECLARE db_now BIGINT;
 BEGIN
  db_now := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF db_now >= NEW.deadline_db_ms OR NOT EXISTS(
   SELECT 1 FROM accounts a JOIN sessions s ON s.id=NEW.session_id AND s.account_id=a.id
   WHERE a.id=NEW.actor_id AND a.disabled_at IS NULL AND a.identity_state='registered_face'
    AND a.auth_epoch=NEW.auth_epoch AND (a.roles_json::jsonb @> '["admin"]'::jsonb)
    AND s.auth_epoch=NEW.auth_epoch AND s.auth_method='registered_face' AND s.revoked_at IS NULL
    AND s.expires_at>db_now AND s.refresh_expires_at>db_now
  ) THEN RAISE EXCEPTION 'retention_schedule_commit_authority_expired'; END IF;
  DELETE FROM retention_schedule_commit_guards WHERE id=NEW.id AND actor_id=NEW.actor_id
    AND session_id=NEW.session_id AND auth_epoch=NEW.auth_epoch AND deadline_db_ms=NEW.deadline_db_ms;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_schedule_commit_guard_missing'; END IF;
  RETURN NULL;
 END $guard$;
 REVOKE ALL ON FUNCTION lovelies_private.retention_schedule_check_commit_guard() FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION lovelies_private.retention_schedule_check_commit_guard() TO lovelies_api;
 CREATE CONSTRAINT TRIGGER retention_schedule_commit_guard AFTER INSERT ON lovelies_private.retention_schedule_commit_guards
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lovelies_private.retention_schedule_check_commit_guard();
 ALTER TABLE lovelies_private.retention_schedule_commit_guards ENABLE ROW LEVEL SECURITY;
 ALTER TABLE lovelies_private.retention_schedule_commit_guards FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON lovelies_private.retention_schedule_commit_guards TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON lovelies_private.retention_schedule_commit_guards FROM PUBLIC,anon,authenticated,lovelies_api;
 GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.retention_schedule_commit_guards TO lovelies_api;
 ALTER TABLE lovelies_private.retention_schedule_commands ENABLE ROW LEVEL SECURITY;
 ALTER TABLE lovelies_private.retention_schedule_commands FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON lovelies_private.retention_schedule_commands TO lovelies_api USING(true) WITH CHECK(true);
 ALTER TABLE lovelies_private.retention_schedule_items ENABLE ROW LEVEL SECURITY;
 ALTER TABLE lovelies_private.retention_schedule_items FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON lovelies_private.retention_schedule_items TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON lovelies_private.retention_schedule_commands,lovelies_private.retention_schedule_items FROM PUBLIC,anon,authenticated,lovelies_api;
 GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.retention_schedule_commands,lovelies_private.retention_schedule_items TO lovelies_api;
 -- Unexpected default grants make this proposal fail closed; do not silently
 -- revoke unrelated role privileges. Effective memberships still need audit.
 IF pg_has_role('anon',migrator,'MEMBER') OR pg_has_role('authenticated',migrator,'MEMBER') OR pg_has_role('lovelies_api',migrator,'MEMBER') OR EXISTS(
   SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
   WHERE n.nspname='lovelies_private' AND c.relname IN('retention_schedule_commands','retention_schedule_items','retention_schedule_commit_guards')
     AND acl.grantee NOT IN(c.relowner,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='lovelies_api'))
 ) OR EXISTS(
   SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
   WHERE n.nspname='lovelies_private' AND p.proname='retention_schedule_check_commit_guard'
     AND acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='lovelies_api'))
 ) THEN RAISE EXCEPTION 'unexpected_retention_schedule_grant'; END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO lovelies_private.schema_versions(version,applied_at) VALUES(14,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $retention_schedule$;
RESET search_path;
