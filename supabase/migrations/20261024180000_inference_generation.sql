-- Additive v10: nullable private generation bindings for new operations only.
-- Legacy NULL identities stay unbound and fail closed; no rows are relabelled.
-- Existing roles, grants, forced RLS, policies and application rows are retained.
SET search_path TO lovelies_private,pg_catalog;
DO $generation$
DECLARE migrator name:=current_user; actual bigint; columns_valid boolean;
BEGIN
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 9 AND actual IS DISTINCT FROM 10 THEN
  RAISE EXCEPTION 'inference_generation_requires_schema_v9';
 END IF;
 IF actual=9 THEN
  ALTER TABLE lovelies_private.auth_challenges ADD COLUMN engine_identity TEXT;
  ALTER TABLE lovelies_private.processing_attempts ADD COLUMN engine_identity TEXT;
 END IF;
 SELECT count(*)=2 AND bool_and(a.atttypid='pg_catalog.text'::regtype
   AND NOT a.attnotnull AND NOT a.atthasdef AND a.attgenerated='')
 INTO columns_valid
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='lovelies_private' AND c.relname IN('auth_challenges','processing_attempts')
   AND a.attname='engine_identity' AND a.attnum>0 AND NOT a.attisdropped;
 IF columns_valid IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'inference_generation_columns_invalid';
 END IF;
 IF actual=9 THEN
  EXECUTE 'SET LOCAL ROLE lovelies_api';
  INSERT INTO lovelies_private.schema_versions(version,applied_at)
   VALUES(10,(extract(epoch FROM clock_timestamp())*1000)::bigint);
  EXECUTE format('SET LOCAL ROLE %I',migrator);
 END IF;
END $generation$;
RESET search_path;
