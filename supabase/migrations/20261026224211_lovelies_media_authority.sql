-- Additive v13: bind newly issued private tickets to their admitted authority.
-- Existing rows remain NULL and are handled conservatively by the API; no
-- existing ticket is rewritten, backfilled or deleted by this migration.
SET search_path TO lovelies_private,pg_catalog;
DO $media_authority$
DECLARE migrator name := current_user; actual bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
   EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
     AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
   pg_has_role('anon','lovelies_api','MEMBER') OR
   pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 12 THEN RAISE EXCEPTION 'media_authority_requires_schema_v12'; END IF;
 ALTER TABLE lovelies_private.media_tickets ADD COLUMN authority_json TEXT
   CHECK(authority_json IS NULL OR jsonb_typeof(authority_json::jsonb)='object');
 ALTER TABLE lovelies_private.download_tickets ADD COLUMN authority_json TEXT
   CHECK(authority_json IS NULL OR jsonb_typeof(authority_json::jsonb)='object');
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO lovelies_private.schema_versions(version,applied_at)
   VALUES(13,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $media_authority$;
RESET search_path;
