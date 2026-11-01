-- v18: minimized eligibility decisions, finite annual review and exact retained
-- review-reference custody. Preserve every legacy row and original receipt.
SET search_path TO lovelies_private,pg_catalog;
DO $audience_decisions$
DECLARE migrator name := current_user; actual bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
   EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api' AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
   pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
  RAISE EXCEPTION 'unexpected_lovelies_api_role'; END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 17 THEN RAISE EXCEPTION 'audience_decisions_requires_schema_v17'; END IF;
 ALTER TABLE account_audience ALTER COLUMN age_band DROP NOT NULL;
 ALTER TABLE account_audience
 ADD COLUMN decision_protocol TEXT NOT NULL DEFAULT 'legacy-v1' CHECK(decision_protocol IN('legacy-v1','decision-v2')),
 ADD COLUMN at_least_13 BIGINT,
 ADD COLUMN guardian_required BIGINT,
 ADD COLUMN decision_source TEXT,
 ADD COLUMN rule_version TEXT,
 ADD COLUMN territory TEXT;
 ALTER TABLE account_audience ADD CONSTRAINT account_audience_decision_tuple CHECK((decision_protocol='legacy-v1' AND age_band IS NOT NULL AND at_least_13 IS NULL AND guardian_required IS NULL AND decision_source IS NULL AND rule_version IS NULL AND territory IS NULL)
 OR(decision_protocol='decision-v2' AND age_band IS NULL AND at_least_13 IS NOT NULL AND guardian_required IS NOT NULL AND decision_source IS NOT NULL AND rule_version IS NOT NULL AND territory IS NOT NULL AND at_least_13 IN(0,1) AND guardian_required IN(0,1) AND (at_least_13=1 OR guardian_required=0)
 AND decision_source IN('self_declaration','independent_review','legacy_declaration') AND rule_version='audience-13-plus-guardian-v1' AND territory='global'
 AND next_review_at IS NOT NULL AND next_review_at>declared_at AND next_review_at<=declared_at+31536000000));
CREATE TABLE audience_review_retirements(
  account_id TEXT NOT NULL REFERENCES accounts(id),audience_version BIGINT NOT NULL CHECK(audience_version>0),
  deadline BIGINT NOT NULL,retired_at BIGINT NOT NULL,recover_until BIGINT NOT NULL,
  profile_id TEXT,profile_revision TEXT,profile_epoch BIGINT,auth_consent_id TEXT,auth_policy TEXT,
  template_key TEXT,template_digest TEXT,cleanup_id TEXT,removal_verified_at BIGINT,
  enrollment_binding TEXT,enrollment_consent_id TEXT,enrollment_rebound_consent_id TEXT,enrollment_expires_at BIGINT,
  disposition TEXT NOT NULL CHECK(disposition IN('retained','renewed','removed')),
  PRIMARY KEY(account_id,audience_version),CHECK(retired_at>=deadline AND recover_until>=deadline AND recover_until<=deadline+86400000),
  CHECK((profile_id IS NULL AND profile_revision IS NULL AND profile_epoch IS NULL AND auth_consent_id IS NULL AND auth_policy IS NULL AND template_key IS NULL AND template_digest IS NULL AND cleanup_id IS NULL)
   OR(profile_id IS NOT NULL AND profile_revision IS NOT NULL AND profile_epoch IS NOT NULL AND template_key IS NOT NULL AND template_digest IS NOT NULL AND cleanup_id IS NOT NULL
    AND ((auth_consent_id IS NULL AND auth_policy IS NULL) OR (auth_consent_id IS NOT NULL AND auth_policy IS NOT NULL)))),
  CHECK((enrollment_binding IS NULL AND enrollment_consent_id IS NULL AND enrollment_rebound_consent_id IS NULL AND enrollment_expires_at IS NULL)
   OR(enrollment_binding IS NOT NULL AND length(enrollment_binding)=64 AND enrollment_consent_id IS NOT NULL AND enrollment_expires_at IS NOT NULL AND enrollment_expires_at>retired_at AND profile_id IS NULL)),
  CHECK(removal_verified_at IS NULL OR (removal_verified_at>=retired_at AND disposition='removed' AND profile_id IS NULL)),
  CHECK(disposition<>'retained' OR (profile_id IS NOT NULL AND auth_consent_id IS NOT NULL AND auth_policy IS NOT NULL AND recover_until>retired_at)));
CREATE INDEX audience_review_due ON account_audience(declared_at,account_id);
CREATE INDEX audience_review_reference_cleanup ON audience_review_retirements(cleanup_id) WHERE cleanup_id IS NOT NULL;
 ALTER TABLE audience_review_retirements ENABLE ROW LEVEL SECURITY;
 ALTER TABLE audience_review_retirements FORCE ROW LEVEL SECURITY;
 CREATE POLICY backend_only ON audience_review_retirements TO lovelies_api USING(true) WITH CHECK(true);
 REVOKE ALL ON audience_review_retirements FROM PUBLIC,anon,authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON audience_review_retirements TO lovelies_api;

 ALTER TABLE notification_jobs ADD COLUMN last_examined_at BIGINT;
 ALTER TABLE photo_job_outbox ADD COLUMN last_examined_at BIGINT;
 ALTER TABLE outbox ADD COLUMN last_examined_at BIGINT;
 ALTER TABLE privacy_requests ADD COLUMN last_recovery_scan_at BIGINT;
 CREATE INDEX notification_outbox_scan ON notification_jobs(coalesce(last_examined_at,0),created_at,notification_id) WHERE status IN('queued','dispatched','ambiguous');
 CREATE INDEX photo_outbox_scan ON photo_job_outbox(coalesce(last_examined_at,0),created_at,id) WHERE status='pending';
 CREATE INDEX privacy_outbox_scan ON outbox(coalesce(last_examined_at,0),created_at,id) WHERE category='privacy' AND delivered_at IS NULL AND cancelled_at IS NULL;
 CREATE INDEX privacy_recovery_scan ON privacy_requests(coalesce(last_recovery_scan_at,0),created_at,id) WHERE status IN('processing','failed');
CREATE TABLE lovelies_private.processing_attempt_profiles (
    attempt_id TEXT NOT NULL REFERENCES lovelies_private.processing_attempts(id) ON DELETE CASCADE,
    ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
    account_id TEXT NOT NULL,
    profile_json TEXT NOT NULL CHECK (json_valid(profile_json) AND length(profile_json)<=8192),
    PRIMARY KEY (attempt_id, ordinal),
    UNIQUE (attempt_id, account_id)
);
CREATE INDEX processing_attempt_profiles_subject
    ON lovelies_private.processing_attempt_profiles(account_id, attempt_id);

CREATE TABLE lovelies_private.processing_match_progress (
    attempt_id TEXT PRIMARY KEY REFERENCES lovelies_private.processing_attempts(id) ON DELETE CASCADE,
    plan_sha256 TEXT NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
    next_ordinal BIGINT NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
    chain_sha256 TEXT NOT NULL CHECK (chain_sha256 ~ '^[0-9a-f]{64}$'),
    query_sha256 TEXT CHECK (query_sha256 IS NULL OR query_sha256 ~ '^[0-9a-f]{64}$'),
    ranks_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ranks_json) AND length(ranks_json)<=262144),
    updated_at BIGINT NOT NULL
);
CREATE FUNCTION processing_attempt_profile_immutable() RETURNS trigger LANGUAGE plpgsql AS $profile_immutable$
 BEGIN RAISE EXCEPTION 'matching_capture_immutable'; END
$profile_immutable$;
REVOKE ALL ON FUNCTION processing_attempt_profile_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION processing_attempt_profile_immutable() TO lovelies_api;
CREATE TRIGGER processing_attempt_profile_immutable BEFORE UPDATE ON processing_attempt_profiles
 FOR EACH ROW EXECUTE FUNCTION processing_attempt_profile_immutable();

CREATE TABLE notification_dispatch_plans (
 notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
 subject_sha256 TEXT NOT NULL CHECK(subject_sha256 ~ '^[0-9a-f]{64}$'),
 provider_generation TEXT NOT NULL CHECK(provider_generation ~ '^[0-9a-f]{64}$'),
 plan_sha256 TEXT NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND length(plan_json)<=16384),
 created_at BIGINT NOT NULL
);
CREATE TABLE notification_recovered_receipts (
 operation_key TEXT PRIMARY KEY,
 notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 plan_sha256 TEXT NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
 device_id TEXT NOT NULL,
 token_sha256 TEXT NOT NULL CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
 request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 provider_generation TEXT NOT NULL CHECK(provider_generation ~ '^[0-9a-f]{64}$'),
 status TEXT NOT NULL CHECK(status IN('unstarted','preparing','dispatching','accepted','rejected','ambiguous','cancelled')),
 provider_receipt TEXT,provider_code TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 CHECK(status<>'accepted' OR provider_receipt IS NOT NULL)
);
CREATE INDEX notification_recovered_notification ON notification_recovered_receipts(notification_id,operation_key);
CREATE FUNCTION notification_dispatch_plan_immutable() RETURNS trigger LANGUAGE plpgsql AS $plan_immutable$
 BEGIN RAISE EXCEPTION 'notification_dispatch_plan_immutable'; END
$plan_immutable$;
REVOKE ALL ON FUNCTION notification_dispatch_plan_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION notification_dispatch_plan_immutable() TO lovelies_api;
CREATE TRIGGER notification_dispatch_plan_immutable BEFORE UPDATE ON notification_dispatch_plans
 FOR EACH ROW EXECUTE FUNCTION notification_dispatch_plan_immutable();
-- No device FK: independent receipt evidence survives a restored/missing local
-- device without recreating that device or granting new send permission.
ALTER TABLE notification_dispatch_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_dispatch_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON notification_dispatch_plans TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON notification_dispatch_plans FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_dispatch_plans TO lovelies_api;
ALTER TABLE notification_recovered_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_recovered_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON notification_recovered_receipts TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON notification_recovered_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_recovered_receipts TO lovelies_api;
ALTER TABLE processing_attempt_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_attempt_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON processing_attempt_profiles TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON processing_attempt_profiles FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON processing_attempt_profiles TO lovelies_api;

ALTER TABLE processing_match_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_match_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON processing_match_progress TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON processing_match_progress FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON processing_match_progress TO lovelies_api;

 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO schema_versions(version,applied_at) VALUES(18,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END
$audience_decisions$;

RESET search_path;
