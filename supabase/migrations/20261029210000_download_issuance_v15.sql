-- Additive v15: authenticated, independently bound download issuance only.
-- Historical tickets/operations are preserved and never backfilled into v2.
SET search_path TO lovelies_private,pg_catalog;
DO $download_v15$
DECLARE migrator name:=current_user; actual bigint; relation text;
BEGIN
 -- Hold the writer lock through every DDL/version statement even when a
 -- migration runner sends top-level statements separately.
 PERFORM pg_advisory_xact_lock(704536419730718193::bigint);
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
   EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api' AND
     (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
   pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
   RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 14 THEN RAISE EXCEPTION 'download_issuance_requires_schema_v14'; END IF;
 ALTER TABLE restore_control ADD COLUMN last_disposition TEXT CHECK(last_disposition IN('issued','not_issued'));
 ALTER TABLE restore_control ADD COLUMN last_receipt_hash TEXT CHECK(last_receipt_hash ~ '^[0-9a-f]{64}$');
 ALTER TABLE restore_control ADD CONSTRAINT restore_download_disposition_pair CHECK((last_disposition IS NULL)=(last_receipt_hash IS NULL));
 CREATE TABLE download_v2_operations(
   operation_id TEXT PRIMARY KEY CHECK(operation_id ~ '^[0-9a-f-]{36}$'),account_id TEXT NOT NULL,operation_key TEXT NOT NULL,
   asset_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN('issued','not_issued')),
   receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json)='object')),
   receipt_hash TEXT NOT NULL CHECK(receipt_hash ~ '^[0-9a-f]{64}$'),recorded_at BIGINT NOT NULL CHECK(recorded_at BETWEEN 0 AND 9007199254740991),retired_at BIGINT,
   UNIQUE(account_id,operation_key),CHECK((retired_at IS NULL)=(receipt_json IS NOT NULL))
 );
 -- No evidence FK to a deletable account/session/asset; ordinary erasure retires
 -- redeemable rows and authority material after pending settlement is resolved.
 CREATE TABLE download_v2_tickets(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES download_v2_operations(operation_id),
   receipt_hash TEXT NOT NULL CHECK(receipt_hash ~ '^[0-9a-f]{64}$'));
 CREATE INDEX download_v2_asset ON download_v2_operations(asset_id,retired_at);
 -- Reject default ACL/membership drift before revoking expected public/backend
 -- entries. FORCE RLS does not constrain TRUNCATE, REFERENCES or grant options.
 IF pg_has_role('anon',migrator,'MEMBER') OR pg_has_role('authenticated',migrator,'MEMBER') OR
   pg_has_role('lovelies_api',migrator,'MEMBER') OR EXISTS(
     SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname NOT IN(migrator,'lovelies_api') AND NOT r.rolsuper
       AND pg_has_role(r.oid,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='lovelies_api'),'MEMBER')
   ) OR EXISTS(
     SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
     WHERE n.nspname='lovelies_private' AND c.relname IN('download_v2_operations','download_v2_tickets') AND
       (acl.grantee NOT IN(c.relowner,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='lovelies_api')) OR
        acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='lovelies_api') AND
          (acl.privilege_type NOT IN('SELECT','INSERT','UPDATE','DELETE') OR acl.is_grantable))
   ) THEN RAISE EXCEPTION 'unexpected_download_issuance_grant'; END IF;
 FOREACH relation IN ARRAY ARRAY['download_v2_operations','download_v2_tickets'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
   EXECUTE format('CREATE POLICY backend_only ON %I TO lovelies_api USING(true) WITH CHECK(true)',relation);
   EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated,lovelies_api',relation);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO lovelies_api',relation);
 END LOOP;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO schema_versions(version,applied_at) VALUES(15,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $download_v15$;
RESET search_path;
