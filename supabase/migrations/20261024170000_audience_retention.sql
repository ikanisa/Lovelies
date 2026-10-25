-- Additive v9: no audience backfill, no imports and no object deletions.
-- A missing declaration stays blocked. Owner authorization to apply is separate.
SET search_path TO lovelies_private,pg_catalog;
DO $preflight$
DECLARE migrator name:=current_user; actual bigint;
BEGIN
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 IF actual IS DISTINCT FROM 8 THEN RAISE EXCEPTION 'audience_retention_requires_schema_v8'; END IF;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $preflight$;
CREATE TABLE account_audience(account_id TEXT PRIMARY KEY REFERENCES accounts(id),age_band TEXT NOT NULL CHECK(age_band IN('under13','13_17','18_plus')),status TEXT NOT NULL CHECK(status IN('blocked','guardian_pending','eligible','suspended')),version BIGINT NOT NULL CHECK(version>0),declared_at BIGINT NOT NULL,policy_version TEXT NOT NULL,next_review_at BIGINT);
CREATE TABLE guardian_requests(id TEXT PRIMARY KEY,child_account_id TEXT NOT NULL REFERENCES accounts(id),guardian_account_id TEXT REFERENCES accounts(id),state TEXT NOT NULL CHECK(state IN('pending','under_review','approved','rejected','withdrawn','expired')),child_audience_version BIGINT NOT NULL CHECK(child_audience_version>0),policy_version TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),reviewed_by TEXT REFERENCES accounts(id),reviewed_at BIGINT,evidence_method TEXT,evidence_reference TEXT,terminated_at BIGINT,CHECK(guardian_account_id IS NULL OR guardian_account_id<>child_account_id),CHECK(reviewed_by IS NULL OR (reviewed_by<>child_account_id AND reviewed_by<>guardian_account_id)));
CREATE INDEX guardian_child_state ON guardian_requests(child_account_id,state,expires_at);
CREATE TABLE guardian_purpose_approvals(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES guardian_requests(id) ON DELETE CASCADE,child_account_id TEXT NOT NULL REFERENCES accounts(id),guardian_account_id TEXT NOT NULL REFERENCES accounts(id),guardian_audience_version BIGINT NOT NULL CHECK(guardian_audience_version>0),purpose TEXT NOT NULL CHECK(purpose IN('face_authentication','photo_matching','photo_processing')),policy_version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('requested','approved','revoked')),version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,revoked_at BIGINT,UNIQUE(request_id,purpose),CHECK(child_account_id<>guardian_account_id));
CREATE TABLE audience_adult_reviews(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),reviewed_by TEXT NOT NULL REFERENCES accounts(id),evidence_method TEXT NOT NULL,evidence_reference TEXT NOT NULL,created_at BIGINT NOT NULL,CHECK(account_id<>reviewed_by));
CREATE INDEX guardian_purpose_child ON guardian_purpose_approvals(child_account_id,purpose,status);
ALTER TABLE retention_settings DROP CONSTRAINT retention_settings_audit_days_check;
ALTER TABLE retention_settings ADD CONSTRAINT retention_settings_audit_days_check CHECK(audit_days BETWEEN 1 AND 30) NOT VALID;
DO $settings$ DECLARE migrator name:=current_user; BEGIN
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 UPDATE retention_settings SET audit_days=least(audit_days,30),version=version+1;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $settings$;
ALTER TABLE retention_settings VALIDATE CONSTRAINT retention_settings_audit_days_check;
ALTER TABLE account_audience ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_audience FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON account_audience TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON account_audience FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON account_audience TO lovelies_api;
ALTER TABLE guardian_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON guardian_requests TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON guardian_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON guardian_requests TO lovelies_api;
ALTER TABLE guardian_purpose_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_purpose_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON guardian_purpose_approvals TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON guardian_purpose_approvals FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON guardian_purpose_approvals TO lovelies_api;
ALTER TABLE audience_adult_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_adult_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON audience_adult_reviews TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON audience_adult_reviews FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON audience_adult_reviews TO lovelies_api;
DO $version$ DECLARE migrator name:=current_user; BEGIN
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO schema_versions(version,applied_at) VALUES(9,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $version$;
