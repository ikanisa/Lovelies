-- Additive v16: immutable account export snapshots and bounded resumable chunks.
-- No restore bootstrap, serving clearance or hosted data deletion is performed.
SET search_path TO lovelies_private,pg_catalog;
DO $chunked_privacy_exports$
DECLARE migrator name:=current_user;actual bigint;table_name text;
BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
   AND(rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication))
   OR pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 15 THEN RAISE EXCEPTION 'chunked_privacy_exports_requires_schema_v15';END IF;
 ALTER TABLE privacy_exports ADD COLUMN content_format text NOT NULL DEFAULT 'flat' CHECK(content_format IN('flat','chunked'));
 ALTER TABLE privacy_exports ADD COLUMN chunk_count bigint NOT NULL DEFAULT 0 CHECK(chunk_count>=0 AND chunk_count<=9007199254740991);
 ALTER TABLE privacy_exports ADD COLUMN manifest_sha256 text CHECK(manifest_sha256 IS NULL OR manifest_sha256~'^[0-9a-f]{64}$');
 ALTER TABLE privacy_exports ADD COLUMN manifest_object_sha256 text CHECK(manifest_object_sha256 IS NULL OR manifest_object_sha256~'^[0-9a-f]{64}$');
 ALTER TABLE privacy_exports ADD COLUMN manifest_object_bytes bigint CHECK(manifest_object_bytes IS NULL OR manifest_object_bytes BETWEEN 1 AND 4096);
 ALTER TABLE privacy_exports ADD CONSTRAINT privacy_export_chunk_binding CHECK(
  content_format='flat' AND chunk_count=0 AND manifest_sha256 IS NULL AND manifest_object_sha256 IS NULL AND manifest_object_bytes IS NULL
  OR content_format='chunked' AND chunk_count>0 AND manifest_sha256 IS NOT NULL AND manifest_object_sha256 IS NOT NULL AND manifest_object_bytes IS NOT NULL
     AND bytes BETWEEN 1 AND 9007199254740991 AND chunk_count=(bytes+1048575)/1048576);
 CREATE TABLE privacy_export_snapshots(
  id text PRIMARY KEY REFERENCES privacy_exports(id),request_id text NOT NULL UNIQUE REFERENCES privacy_requests(id),
  subject_id text NOT NULL REFERENCES accounts(id),generated_at bigint NOT NULL,
  status text NOT NULL CHECK(status IN('capturing','building','publishing','completed','retired')),
  segment_count bigint NOT NULL DEFAULT 0 CHECK(segment_count BETWEEN 0 AND 9007199254740991),
  row_count bigint NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 9007199254740991),
  total_bytes bigint NOT NULL DEFAULT 0 CHECK(total_bytes BETWEEN 0 AND 9007199254740991),
  cursor_seq bigint NOT NULL DEFAULT 0 CHECK(cursor_seq BETWEEN 0 AND 9007199254740991),
  cursor_offset bigint NOT NULL DEFAULT 0 CHECK(cursor_offset BETWEEN 0 AND 9007199254740991),
  emitted_bytes bigint NOT NULL DEFAULT 0 CHECK(emitted_bytes BETWEEN 0 AND 9007199254740991),
  chunk_count bigint NOT NULL DEFAULT 0 CHECK(chunk_count BETWEEN 0 AND 9007199254740991),
  hash_state_json text NOT NULL CHECK(json_valid(hash_state_json) AND octet_length(hash_state_json)<=2048),
  chain_sha256 text NOT NULL CHECK(chain_sha256~'^[0-9a-f]{64}$'),sha256 text CHECK(sha256 IS NULL OR sha256~'^[0-9a-f]{64}$'),
  root_write_id text,expires_at bigint NOT NULL,CHECK(expires_at>generated_at),
  CHECK(cursor_seq<=segment_count AND emitted_bytes<=total_bytes),
  CHECK(status NOT IN('publishing','completed') OR(cursor_seq=segment_count AND cursor_offset=0 AND emitted_bytes=total_bytes AND sha256 IS NOT NULL AND root_write_id IS NOT NULL))
 );
 CREATE INDEX privacy_export_snapshot_subject ON privacy_export_snapshots(subject_id,expires_at);
 CREATE TABLE privacy_export_snapshot_rows(
  snapshot_id text NOT NULL REFERENCES privacy_export_snapshots(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991),payload_text text NOT NULL,
  byte_length bigint NOT NULL CHECK(byte_length>0 AND byte_length=octet_length(payload_text)),PRIMARY KEY(snapshot_id,sequence)
 );
 CREATE TABLE privacy_export_chunks(
  publication_id text NOT NULL REFERENCES privacy_exports(id),chunk_index bigint NOT NULL CHECK(chunk_index BETWEEN 0 AND 9007199254740991),
  bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 1048576),sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  root_sha256 text NOT NULL CHECK(root_sha256~'^[0-9a-f]{64}$'),object_key text NOT NULL UNIQUE,write_intent_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN('pending','verified')),start_seq bigint NOT NULL CHECK(start_seq>=0),start_offset bigint NOT NULL CHECK(start_offset>=0),
  end_seq bigint NOT NULL CHECK(end_seq>=start_seq),end_offset bigint NOT NULL CHECK(end_offset>=0),
  hash_state_json text NOT NULL CHECK(json_valid(hash_state_json) AND octet_length(hash_state_json)<=2048),created_at bigint NOT NULL,
  PRIMARY KEY(publication_id,chunk_index),CHECK(end_seq>start_seq OR end_offset>start_offset)
 );
 FOREACH table_name IN ARRAY ARRAY['privacy_export_snapshots','privacy_export_snapshot_rows','privacy_export_chunks'] LOOP
  EXECUTE format('ALTER TABLE lovelies_private.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE lovelies_private.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY backend_only ON lovelies_private.%I TO lovelies_api USING(true) WITH CHECK(true)',table_name);
  EXECUTE format('REVOKE ALL ON lovelies_private.%I FROM PUBLIC,anon,authenticated',table_name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.%I TO lovelies_api',table_name);
 END LOOP;
 CREATE FUNCTION guard_privacy_export_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=lovelies_private,pg_catalog AS $fn$
 BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','segment_count','row_count','total_bytes','cursor_seq','cursor_offset','emitted_bytes','chunk_count','hash_state_json','chain_sha256','sha256','root_write_id','expires_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','segment_count','row_count','total_bytes','cursor_seq','cursor_offset','emitted_bytes','chunk_count','hash_state_json','chain_sha256','sha256','root_write_id','expires_at'])
   OR OLD.status<>'capturing' AND(NEW.segment_count IS DISTINCT FROM OLD.segment_count OR NEW.row_count IS DISTINCT FROM OLD.row_count OR NEW.total_bytes IS DISTINCT FROM OLD.total_bytes)
   OR NEW.cursor_seq<OLD.cursor_seq OR NEW.emitted_bytes<OLD.emitted_bytes OR NEW.chunk_count<OLD.chunk_count
   OR OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256
   OR OLD.root_write_id IS NOT NULL AND NEW.root_write_id IS DISTINCT FROM OLD.root_write_id AND NOT(
     OLD.status='publishing' AND NEW.status='publishing' AND NEW.root_write_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM privacy_exports e WHERE e.id=OLD.id AND e.status='pending')
     AND EXISTS(SELECT 1 FROM media_write_intents w JOIN cleanup_intents c ON c.object_key=w.object_key
       AND c.bucket=w.bucket AND c.subject_id=w.account_id WHERE w.id=OLD.root_write_id
       AND w.account_id=OLD.subject_id AND w.bucket='PRIVACY_EXPORTS' AND c.request_id=OLD.request_id)
     AND EXISTS(SELECT 1 FROM media_write_intents w JOIN cleanup_intents c ON c.object_key=w.object_key
       AND c.bucket=w.bucket AND c.subject_id=w.account_id WHERE w.id=NEW.root_write_id
       AND w.account_id=OLD.subject_id AND w.bucket='PRIVACY_EXPORTS' AND w.status='pending' AND c.request_id=OLD.request_id
       AND w.object_key<>(SELECT object_key FROM media_write_intents WHERE id=OLD.root_write_id)))
   OR OLD.status='retired' AND NEW.status<>'retired' OR OLD.status='completed' AND NEW.status NOT IN('completed','retired')
   OR OLD.status='publishing' AND NEW.status NOT IN('publishing','completed','retired')
   OR OLD.status='building' AND NEW.status NOT IN('building','publishing','retired') THEN RAISE EXCEPTION 'privacy_export_snapshot_immutable';END IF;
  RETURN NEW;
 END $fn$;
 CREATE TRIGGER privacy_export_snapshot_immutable BEFORE UPDATE ON privacy_export_snapshots FOR EACH ROW EXECUTE FUNCTION guard_privacy_export_snapshot();
 CREATE FUNCTION guard_privacy_export_snapshot_row() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=lovelies_private,pg_catalog AS $fn$
 DECLARE parent_status text;
 BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'privacy_export_snapshot_row_immutable';END IF;
  SELECT status INTO parent_status FROM privacy_export_snapshots WHERE id=CASE WHEN TG_OP='INSERT' THEN NEW.snapshot_id ELSE OLD.snapshot_id END;
  IF TG_OP='INSERT' AND parent_status IS DISTINCT FROM 'capturing'
    OR TG_OP='DELETE' AND parent_status IN('capturing','building','publishing') THEN RAISE EXCEPTION 'privacy_export_snapshot_row_immutable';END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END $fn$;
 CREATE TRIGGER privacy_export_snapshot_row_immutable BEFORE INSERT OR UPDATE OR DELETE ON privacy_export_snapshot_rows FOR EACH ROW EXECUTE FUNCTION guard_privacy_export_snapshot_row();
 CREATE FUNCTION guard_privacy_export_chunk() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=lovelies_private,pg_catalog AS $fn$
 BEGIN
  IF(to_jsonb(NEW)-ARRAY['status','hash_state_json','object_key','write_intent_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','hash_state_json','object_key','write_intent_id'])
   OR (NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.write_intent_id IS DISTINCT FROM OLD.write_intent_id) AND NOT(
     OLD.status='pending' AND NEW.status='pending' AND NEW.object_key<>OLD.object_key AND NEW.write_intent_id<>OLD.write_intent_id
     AND EXISTS(SELECT 1 FROM privacy_export_snapshots s JOIN privacy_exports e ON e.id=s.id
       JOIN media_write_intents old_write ON old_write.id=OLD.write_intent_id AND old_write.account_id=s.subject_id
         AND old_write.bucket='PRIVACY_EXPORTS' AND old_write.object_key=OLD.object_key
       JOIN cleanup_intents old_cleanup ON old_cleanup.request_id=s.request_id AND old_cleanup.subject_id=s.subject_id
         AND old_cleanup.bucket='PRIVACY_EXPORTS' AND old_cleanup.object_key=OLD.object_key
       JOIN media_write_intents new_write ON new_write.id=NEW.write_intent_id AND new_write.account_id=s.subject_id
         AND new_write.bucket='PRIVACY_EXPORTS' AND new_write.object_key=NEW.object_key AND new_write.status='pending'
       JOIN cleanup_intents new_cleanup ON new_cleanup.request_id=s.request_id AND new_cleanup.subject_id=s.subject_id
         AND new_cleanup.bucket='PRIVACY_EXPORTS' AND new_cleanup.object_key=NEW.object_key
       WHERE s.id=OLD.publication_id AND s.status='building' AND s.chunk_count=OLD.chunk_index AND e.status='pending'))
   OR NEW.hash_state_json IS DISTINCT FROM OLD.hash_state_json AND NOT(NEW.hash_state_json='{}' AND
     (NEW.status='verified' OR EXISTS(SELECT 1 FROM privacy_export_snapshots s WHERE s.id=OLD.publication_id AND s.status='retired')))
   OR OLD.status='verified' AND NEW.status<>'verified' THEN
   RAISE EXCEPTION 'privacy_export_chunk_immutable';END IF;RETURN NEW;
 END $fn$;
 CREATE TRIGGER privacy_export_chunk_immutable BEFORE UPDATE ON privacy_export_chunks FOR EACH ROW EXECUTE FUNCTION guard_privacy_export_chunk();
 REVOKE ALL ON FUNCTION guard_privacy_export_snapshot(),guard_privacy_export_snapshot_row(),guard_privacy_export_chunk() FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION guard_privacy_export_snapshot(),guard_privacy_export_snapshot_row(),guard_privacy_export_chunk() TO lovelies_api;
 ALTER TABLE privacy_export_deliveries ADD COLUMN protocol_version bigint NOT NULL DEFAULT 2 CHECK(protocol_version IN(2,3));
 ALTER TABLE privacy_export_deliveries ADD COLUMN chunk_count bigint NOT NULL DEFAULT 0 CHECK(chunk_count>=0 AND chunk_count<=9007199254740991);
 ALTER TABLE privacy_export_deliveries ADD COLUMN manifest_sha256 text CHECK(manifest_sha256 IS NULL OR manifest_sha256~'^[0-9a-f]{64}$');
 ALTER TABLE privacy_export_deliveries DROP CONSTRAINT privacy_export_deliveries_bytes_check;
 ALTER TABLE privacy_export_deliveries DROP CONSTRAINT privacy_export_deliveries_check;
 ALTER TABLE privacy_export_deliveries ADD CONSTRAINT privacy_delivery_size_binding CHECK(
  protocol_version=2 AND bytes BETWEEN 1 AND 20971520 AND chunk_count=0 AND manifest_sha256 IS NULL
  OR protocol_version=3 AND bytes BETWEEN 1 AND 9007199254740991 AND chunk_count=(bytes+1048575)/1048576 AND manifest_sha256 IS NOT NULL);
 ALTER TABLE privacy_export_deliveries ADD CONSTRAINT privacy_delivery_expiry_binding CHECK(
  expires_at>created_at AND expires_at<=created_at+CASE WHEN protocol_version=2 THEN 300000 ELSE 3600000 END);
 -- Entire schema/guard/permission installation is atomic even when the caller
 -- submits SET/DO/RESET as separate SQL statements.
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO schema_versions(version,applied_at) VALUES(16,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $chunked_privacy_exports$;
RESET search_path;
