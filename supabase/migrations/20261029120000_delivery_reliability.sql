-- Additive v14. Recoverable privacy deliveries and immutable push request binding.
-- Does not bootstrap a restore marker, migrate customer data or enable serving.
SET search_path TO lovelies_private,pg_catalog;
DO $delivery_reliability$
DECLARE migrator name:=current_user; actual bigint;
BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
   AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication))
   OR pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 13 THEN RAISE EXCEPTION 'delivery_reliability_requires_schema_v13'; END IF;
 CREATE TABLE lovelies_private.privacy_export_deliveries(
  id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES lovelies_private.privacy_requests(id),
  subject_id TEXT NOT NULL REFERENCES lovelies_private.accounts(id),session_id TEXT NOT NULL REFERENCES lovelies_private.sessions(id),
  publication_id TEXT NOT NULL REFERENCES lovelies_private.privacy_exports(id),operation_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),bytes BIGINT NOT NULL CHECK(bytes BETWEEN 1 AND 20971520),
  expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL,acknowledged_at BIGINT,UNIQUE(subject_id,operation_key),
  CHECK(expires_at>created_at AND expires_at<=created_at+300000),CHECK(acknowledged_at IS NULL OR acknowledged_at>=created_at)
 );
 CREATE INDEX privacy_delivery_subject ON lovelies_private.privacy_export_deliveries(subject_id,expires_at);
 ALTER TABLE lovelies_private.privacy_export_deliveries ENABLE ROW LEVEL SECURITY;
 ALTER TABLE lovelies_private.privacy_export_deliveries FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON lovelies_private.privacy_export_deliveries TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON lovelies_private.privacy_export_deliveries FROM PUBLIC,anon,authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.privacy_export_deliveries TO lovelies_api;
 ALTER TABLE lovelies_private.notification_deliveries ADD COLUMN request_sha256 TEXT CHECK(request_sha256 IS NULL OR request_sha256~'^[0-9a-f]{64}$');
 ALTER TABLE lovelies_private.notification_deliveries ADD COLUMN platform TEXT CHECK(platform IS NULL OR platform IN('ios','android'));
 ALTER TABLE lovelies_private.notification_deliveries ADD COLUMN provider_outcome TEXT CHECK(provider_outcome IS NULL OR provider_outcome IN('accepted','rejected','not_dispatched'));
 ALTER TABLE lovelies_private.job_queue ADD COLUMN handoff_count BIGINT NOT NULL DEFAULT 0 CHECK(handoff_count>=0);
 ALTER TABLE lovelies_private.processing_attempts ADD COLUMN profile_batch_count BIGINT NOT NULL DEFAULT 0 CHECK(profile_batch_count>=0);
 CREATE TABLE lovelies_private.processing_profile_batches(
  attempt_id TEXT NOT NULL REFERENCES lovelies_private.processing_attempts(id) ON DELETE CASCADE,
  batch_index BIGINT NOT NULL CHECK(batch_index>=0),profiles_json TEXT NOT NULL CHECK(json_valid(profiles_json) AND json_array_length(profiles_json)<=1000),
  status TEXT NOT NULL CHECK(status IN('pending','completed')),matches_json TEXT CHECK(matches_json IS NULL OR json_valid(matches_json)),
  preview_sha256 TEXT,preview_content_type TEXT,preview_width BIGINT,preview_height BIGINT,PRIMARY KEY(attempt_id,batch_index),
  CHECK(status<>'completed' OR(matches_json IS NOT NULL AND preview_sha256~'^[0-9a-f]{64}$' AND preview_content_type IN('image/jpeg','image/png','image/webp') AND preview_width>0 AND preview_height>0))
 );
 ALTER TABLE lovelies_private.processing_profile_batches ENABLE ROW LEVEL SECURITY;
 ALTER TABLE lovelies_private.processing_profile_batches FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON lovelies_private.processing_profile_batches TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON lovelies_private.processing_profile_batches FROM PUBLIC,anon,authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.processing_profile_batches TO lovelies_api;
 -- Keep every table/column/guard/privilege change and the version marker in
 -- this single statement. A late guard collision must roll back all v14 DDL
 -- even when an executor submits the surrounding statements separately.
 CREATE FUNCTION guard_privacy_delivery_binding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
 IF (to_jsonb(NEW)-'acknowledged_at') IS DISTINCT FROM (to_jsonb(OLD)-'acknowledged_at')
    OR OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='privacy_delivery_binding_immutable';
 END IF; RETURN NEW;
END $f$;
CREATE TRIGGER privacy_delivery_binding BEFORE UPDATE ON privacy_export_deliveries FOR EACH ROW EXECUTE FUNCTION guard_privacy_delivery_binding();
REVOKE ALL ON FUNCTION guard_privacy_delivery_binding() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION guard_privacy_delivery_binding() TO lovelies_api;
CREATE FUNCTION guard_notification_delivery_binding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
    OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR OLD.request_sha256 IS NOT NULL AND NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
    OR OLD.platform IS NOT NULL AND NEW.platform IS DISTINCT FROM OLD.platform
    OR OLD.status='accepted' AND (NEW.status<>'accepted' OR NEW.provider_receipt IS DISTINCT FROM OLD.provider_receipt) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='notification_delivery_binding_immutable';
 END IF; RETURN NEW;
END $f$;
CREATE TRIGGER notification_delivery_binding BEFORE UPDATE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION guard_notification_delivery_binding();
REVOKE ALL ON FUNCTION guard_notification_delivery_binding() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION guard_notification_delivery_binding() TO lovelies_api;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO lovelies_private.schema_versions(version,applied_at) VALUES(14,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $delivery_reliability$;
RESET search_path;
