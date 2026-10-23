-- Fresh Lovelies Supabase authority. No Memories account/media data is imported.
-- Generated from the active logical engine schema; review before remote application.
-- Application tables live outside exposed Data API schemas. All operations require
-- the server-only lovelies_api role plus application session/consent/grant guards.
CREATE SCHEMA lovelies_private;
DO $roles$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') THEN
    CREATE ROLE lovelies_api NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api'
    AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR pg_has_role('anon','lovelies_api','MEMBER')
    OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
    RAISE EXCEPTION 'unexpected_lovelies_api_role';
  END IF;
END $roles$;
REVOKE ALL ON SCHEMA lovelies_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA lovelies_private TO lovelies_api;
GRANT lovelies_api TO postgres;
SET search_path TO lovelies_private, pg_catalog;

CREATE FUNCTION json_valid(input text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
SET search_path=pg_catalog AS $f$ BEGIN PERFORM input::jsonb; RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false; END $f$;
CREATE FUNCTION json_type(input text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path=pg_catalog AS $f$ SELECT jsonb_typeof(input::jsonb) $f$;
CREATE FUNCTION json_array_length(input text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path=pg_catalog AS $f$ SELECT jsonb_array_length(input::jsonb) $f$;
CREATE FUNCTION json_each(input text) RETURNS TABLE(key text,value text) LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path=pg_catalog AS $f$
  SELECT (item.ordinality-1)::text,
    CASE WHEN jsonb_typeof(item.value)='string' THEN item.value#>>'{}' ELSE item.value::text END
  FROM jsonb_array_elements(input::jsonb) WITH ORDINALITY item(value,ordinality)
$f$;
CREATE FUNCTION json_extract(input text,path text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path=pg_catalog AS $f$
  SELECT CASE WHEN path ~ '^\$\.[a-z_]+$' THEN input::jsonb->>substring(path from 3)
    WHEN path ~ '^\$\[[0-9]+\]$' THEN input::jsonb->>(substring(path from 3 for length(path)-3)::integer)
    ELSE NULL END
$f$;
CREATE FUNCTION instr(input text,needle text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path=pg_catalog AS $f$ SELECT strpos(input,needle) $f$;


CREATE TABLE schema_versions(version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL);

CREATE TABLE accounts(
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    roles_json TEXT NOT NULL DEFAULT '["user"]' CHECK(json_valid(roles_json) AND json_type(roles_json)='array'),
    disabled_at BIGINT, auth_epoch BIGINT NOT NULL DEFAULT 1 CHECK(auth_epoch>0),
    created_at BIGINT NOT NULL DEFAULT 0,
    identity_state TEXT NOT NULL DEFAULT 'anonymous' CHECK(identity_state IN('anonymous','registered_face'))
  );

CREATE TABLE consents(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), purpose TEXT NOT NULL,
    policy_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('granted','revoked','expired')),
    expires_at BIGINT, revoked_at BIGINT, created_at BIGINT NOT NULL DEFAULT 0, profile_revision TEXT,
    CHECK(status<>'revoked' OR revoked_at IS NOT NULL)
  );

CREATE TABLE face_profiles(
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), id TEXT NOT NULL UNIQUE,
    revision TEXT NOT NULL, model_id TEXT NOT NULL, template_key TEXT NOT NULL,
    template_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('active','pending','revoked','disabled')),
    consent_id TEXT REFERENCES consents(id), auth_enabled BIGINT NOT NULL DEFAULT 0 CHECK(auth_enabled IN(0,1)),
    auth_epoch BIGINT NOT NULL CHECK(auth_epoch>0), auth_consent_id TEXT REFERENCES consents(id)
  );

CREATE TABLE auth_devices(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)), revision TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','active','revoked','disabled')), created_at BIGINT NOT NULL,
    face_handle TEXT UNIQUE
  );

CREATE TABLE sessions(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), refresh_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL, refresh_expires_at BIGINT NOT NULL, revoked_at BIGINT,
    auth_epoch BIGINT NOT NULL CHECK(auth_epoch>0), auth_method TEXT NOT NULL CHECK(auth_method IN('anonymous','registered_face')),
    face_profile_revision TEXT, face_consent_id TEXT REFERENCES consents(id), device_id TEXT REFERENCES auth_devices(id),
    created_at BIGINT NOT NULL, refresh_consumed_at BIGINT, face_profile_epoch BIGINT, device_revision TEXT,
    CHECK(expires_at>created_at AND refresh_expires_at>=expires_at),
    CHECK(auth_method<>'registered_face' OR (face_profile_revision IS NOT NULL AND face_consent_id IS NOT NULL AND device_id IS NOT NULL))
  );

CREATE TABLE auth_challenges(
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), device_id TEXT,
    purpose TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, profile_revision TEXT, profile_id TEXT,
    policy_version TEXT NOT NULL, expires_at BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts BIGINT NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20), capture_digest TEXT,
    created_at BIGINT NOT NULL, session_id TEXT, auth_epoch BIGINT, consent_id TEXT,
    proof_key TEXT, proof_sha256 TEXT, proof_mime TEXT, proof_size BIGINT, used_at BIGINT,
    device_revision TEXT, model_id TEXT, profile_auth_epoch BIGINT, reference_digest TEXT,
    required_captures BIGINT NOT NULL DEFAULT 1 CHECK(required_captures IN(1,3)),
    CHECK(expires_at>created_at), CHECK(proof_size IS NULL OR proof_size>0)
  );

CREATE TABLE auth_capture_proofs(
    challenge_id TEXT NOT NULL REFERENCES auth_challenges(id), capture_index BIGINT NOT NULL CHECK(capture_index BETWEEN 0 AND 2),
    object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, mime TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK(byte_size>0),
    created_at BIGINT NOT NULL, PRIMARY KEY(challenge_id,capture_index)
  );

CREATE TABLE face_enrollment_intents(
    account_id TEXT NOT NULL REFERENCES accounts(id), enrollment_key TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE REFERENCES auth_devices(id), device_revision TEXT NOT NULL,
    public_key_digest TEXT NOT NULL CHECK(length(public_key_digest)=64),
    handle_hash TEXT NOT NULL UNIQUE CHECK(length(handle_hash)=64), start_hash TEXT NOT NULL CHECK(length(start_hash)=64),
    consent_id TEXT NOT NULL REFERENCES consents(id), policy_version TEXT NOT NULL,
    auth_epoch BIGINT NOT NULL CHECK(auth_epoch>0), challenge_id TEXT NOT NULL REFERENCES auth_challenges(id),
    generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0), last_resume_key TEXT,
    previous_challenge_id TEXT, previous_generation BIGINT, created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL CHECK(expires_at>created_at), revoked_at BIGINT,
    completed_profile_id TEXT, completed_profile_revision TEXT, completed_model_id TEXT, completed_reference_digest TEXT,
    completed_auth_epoch BIGINT, completed_profile_epoch BIGINT,
    PRIMARY KEY(account_id,enrollment_key),
    CHECK((completed_profile_id IS NULL AND completed_profile_revision IS NULL AND completed_model_id IS NULL AND completed_reference_digest IS NULL
      AND completed_auth_epoch IS NULL AND completed_profile_epoch IS NULL) OR
      (completed_profile_id IS NOT NULL AND completed_profile_revision IS NOT NULL AND completed_model_id IS NOT NULL
      AND completed_reference_digest IS NOT NULL AND length(completed_reference_digest)=64
      AND completed_auth_epoch IS NOT NULL AND completed_profile_epoch IS NOT NULL
      AND completed_auth_epoch>0 AND completed_profile_epoch>0)),
    CHECK((last_resume_key IS NULL AND previous_challenge_id IS NULL AND previous_generation IS NULL) OR
      (last_resume_key IS NOT NULL AND previous_challenge_id IS NOT NULL AND previous_generation IS NOT NULL
      AND previous_generation>0 AND previous_generation<generation))
  );

CREATE TABLE face_recovery_keys(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), operation_key TEXT NOT NULL,
    profile_id TEXT NOT NULL, profile_revision TEXT NOT NULL, model_id TEXT NOT NULL,
    reference_digest TEXT NOT NULL CHECK(length(reference_digest)=64),
    auth_epoch BIGINT NOT NULL CHECK(auth_epoch>0), profile_epoch BIGINT NOT NULL CHECK(profile_epoch>0),
    consent_id TEXT NOT NULL REFERENCES consents(id), policy_version TEXT NOT NULL,
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL CHECK(expires_at>created_at),
    revoked_at BIGINT, consumed_at BIGINT, UNIQUE(account_id,operation_key)
  );

CREATE TABLE face_recovery_intents(
    account_id TEXT NOT NULL REFERENCES accounts(id), recovery_request_id TEXT NOT NULL,
    key_id TEXT NOT NULL REFERENCES face_recovery_keys(id), device_id TEXT NOT NULL UNIQUE REFERENCES auth_devices(id),
    device_revision TEXT NOT NULL, public_key_digest TEXT NOT NULL CHECK(length(public_key_digest)=64),
    public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)),
    handle_hash TEXT NOT NULL UNIQUE CHECK(length(handle_hash)=64), start_hash TEXT NOT NULL CHECK(length(start_hash)=64),
    challenge_id TEXT NOT NULL REFERENCES auth_challenges(id), generation BIGINT NOT NULL CHECK(generation>0),
    last_resume_key TEXT, previous_challenge_id TEXT, previous_generation BIGINT,
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL CHECK(expires_at>created_at),
    completed_at BIGINT, completed_auth_epoch BIGINT,
    PRIMARY KEY(account_id,recovery_request_id),
    CHECK((completed_at IS NULL AND completed_auth_epoch IS NULL) OR
      (completed_at IS NOT NULL AND completed_auth_epoch IS NOT NULL AND completed_auth_epoch>0)),
    CHECK((last_resume_key IS NULL AND previous_challenge_id IS NULL AND previous_generation IS NULL) OR
      (last_resume_key IS NOT NULL AND previous_challenge_id IS NOT NULL AND previous_generation IS NOT NULL
      AND previous_generation>0 AND previous_generation<generation))
  );

CREATE TABLE face_profile_controls(
    account_id TEXT NOT NULL REFERENCES accounts(id), device_id TEXT NOT NULL REFERENCES auth_devices(id),
    control_hash TEXT NOT NULL UNIQUE CHECK(length(control_hash)=64), control_operation_key TEXT NOT NULL,
    creation_hash TEXT NOT NULL CHECK(length(creation_hash)=64),
    device_revision TEXT NOT NULL, public_key_digest TEXT NOT NULL CHECK(length(public_key_digest)=64),
    public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)),
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL CHECK(expires_at>created_at),
    PRIMARY KEY(account_id,device_id)
  );

CREATE TABLE face_profile_states(
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), version BIGINT NOT NULL CHECK(version>0),
    matching_paused BIGINT NOT NULL DEFAULT 0 CHECK(matching_paused IN(0,1)), removal_operation_key TEXT
  );

CREATE TABLE request_limits(
    key TEXT PRIMARY KEY, hits BIGINT NOT NULL CHECK(hits>0), expires_at BIGINT NOT NULL
  );

CREATE TABLE blocks(
    blocker_id TEXT NOT NULL REFERENCES accounts(id), blocked_id TEXT NOT NULL REFERENCES accounts(id),
    created_at BIGINT NOT NULL, PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id<>blocked_id)
  );

CREATE TABLE account_preferences(
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), receive_matches BIGINT NOT NULL DEFAULT 0 CHECK(receive_matches IN(0,1)),
    download_photos BIGINT NOT NULL DEFAULT 0 CHECK(download_photos IN(0,1)), updated_at BIGINT NOT NULL
  );

CREATE TABLE assets(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL CHECK(source IN('personal','professional')),
    batch_id TEXT, status TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL CHECK(byte_size>0), checksum_sha256 TEXT, version TEXT NOT NULL,
    width BIGINT, height BIGINT, title TEXT, captured_at BIGINT, deleted_at BIGINT, created_at BIGINT NOT NULL DEFAULT 0,
    CHECK(width IS NULL OR width>0), CHECK(height IS NULL OR height>0)
  );

CREATE TABLE renditions(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), object_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK(byte_size>0), checksum_sha256 TEXT NOT NULL,
    source_checksum_sha256 TEXT NOT NULL, version TEXT NOT NULL, width BIGINT, height BIGINT,
    verified_at BIGINT, status TEXT NOT NULL, source_version TEXT, model_version TEXT, kind TEXT NOT NULL DEFAULT 'preview', orientation BIGINT,
    CHECK(width IS NULL OR width>0), CHECK(height IS NULL OR height>0), CHECK(orientation IS NULL OR orientation BETWEEN 1 AND 8)
  );

CREATE TABLE processing_attempts(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), source_version TEXT NOT NULL,
    source_checksum_sha256 TEXT NOT NULL, model_version TEXT NOT NULL, status TEXT NOT NULL,
    captured_at BIGINT NOT NULL, expires_at BIGINT NOT NULL CHECK(expires_at>captured_at),
    owner_id TEXT REFERENCES accounts(id), source TEXT, rendition_key TEXT,
    profiles_json TEXT CHECK(profiles_json IS NULL OR json_valid(profiles_json)),
    matches_json TEXT CHECK(matches_json IS NULL OR json_valid(matches_json)), processor_nonce TEXT,
    completed_at BIGINT, error_code TEXT, owner_session_id TEXT, owner_auth_epoch BIGINT,
    lease_token TEXT, lease_until BIGINT
  );

CREATE TABLE photo_job_outbox(
    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id), asset_id TEXT NOT NULL REFERENCES assets(id),
    status TEXT NOT NULL, created_at BIGINT NOT NULL, dispatched_at BIGINT
  );

CREATE TABLE match_origins(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
    profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, model_version TEXT NOT NULL,
    source_version TEXT NOT NULL, source_checksum_sha256 TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES processing_attempts(id), captured_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
    matching_consent_id TEXT REFERENCES consents(id), profile_digest TEXT,
    CHECK(expires_at>captured_at), UNIQUE(attempt_id,asset_id,recipient_id,profile_id)
  );

CREATE TABLE candidates(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), owner_id TEXT NOT NULL REFERENCES accounts(id),
    recipient_id TEXT NOT NULL REFERENCES accounts(id), origin_id TEXT NOT NULL REFERENCES match_origins(id),
    status TEXT NOT NULL, version TEXT NOT NULL, created_at BIGINT NOT NULL DEFAULT 0,
    CHECK(owner_id<>recipient_id), UNIQUE(asset_id,owner_id,recipient_id)
  );

CREATE TABLE sharing_snapshots(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL CHECK(source IN('personal','professional')),
    batch_id TEXT, version TEXT NOT NULL, graph_json TEXT NOT NULL CHECK(json_valid(graph_json)),
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL CHECK(expires_at>created_at), privacy_redacted_at BIGINT
  );

CREATE TABLE sharing_previews(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), snapshot_id TEXT NOT NULL REFERENCES sharing_snapshots(id),
    source TEXT NOT NULL CHECK(source IN('personal','professional')), version TEXT NOT NULL,
    draft_version BIGINT NOT NULL CHECK(draft_version>0),
    pairs_json TEXT NOT NULL CHECK(json_valid(pairs_json) AND json_type(pairs_json)='array' AND json_array_length(pairs_json) BETWEEN 1 AND 1000),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL CHECK(expires_at>created_at), committed_at BIGINT, operation_key TEXT,
    privacy_redacted_at BIGINT, CHECK((committed_at IS NULL)=(operation_key IS NULL))
  );

CREATE TABLE sharing_requests(
    id TEXT PRIMARY KEY, preview_id TEXT NOT NULL REFERENCES sharing_previews(id), sender_id TEXT NOT NULL REFERENCES accounts(id),
    recipient_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL CHECK(source IN('personal','professional')),
    asset_ids_json TEXT NOT NULL CHECK(json_valid(asset_ids_json) AND json_type(asset_ids_json)='array' AND json_array_length(asset_ids_json) BETWEEN 1 AND 100),
    status TEXT NOT NULL CHECK(status IN('requested','accepted','declined','withdrawn','expired','revoked','blocked')),
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL CHECK(expires_at>created_at), updated_at BIGINT NOT NULL,
    UNIQUE(preview_id,recipient_id), CHECK(sender_id<>recipient_id)
  );

CREATE TABLE sharing_approvals(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES sharing_requests(id), preview_id TEXT NOT NULL REFERENCES sharing_previews(id),
    owner_id TEXT NOT NULL REFERENCES accounts(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
    asset_id TEXT NOT NULL REFERENCES assets(id), candidate_id TEXT NOT NULL REFERENCES candidates(id),
    pair_version TEXT NOT NULL, approved_at BIGINT NOT NULL, origin_id TEXT REFERENCES match_origins(id),
    UNIQUE(preview_id,asset_id,recipient_id)
  );

CREATE TABLE media_grants(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES sharing_requests(id), approval_id TEXT REFERENCES sharing_approvals(id) ON DELETE SET NULL,
    owner_id TEXT NOT NULL REFERENCES accounts(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
    asset_id TEXT NOT NULL REFERENCES assets(id), active BIGINT NOT NULL CHECK(active IN(0,1)),
    created_at BIGINT NOT NULL, revoked_at BIGINT, review_managed BIGINT NOT NULL DEFAULT 1 CHECK(review_managed IN(0,1)),
    UNIQUE(request_id,asset_id,recipient_id), CHECK(active=0 OR revoked_at IS NULL)
  );

CREATE TABLE media_tickets(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), session_id TEXT NOT NULL REFERENCES sessions(id),
    asset_id TEXT NOT NULL REFERENCES assets(id), rendition_id TEXT NOT NULL REFERENCES renditions(id),
    asset_version TEXT NOT NULL, rendition_version TEXT NOT NULL, expires_at BIGINT NOT NULL
  );

CREATE TABLE operations(
    actor_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL, operation_key TEXT NOT NULL,
    action TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at BIGINT NOT NULL,
    PRIMARY KEY(actor_id,source,operation_key)
  );

CREATE TABLE operation_subjects(
    actor_id TEXT NOT NULL, source TEXT NOT NULL, operation_key TEXT NOT NULL,
    subject_id TEXT NOT NULL REFERENCES accounts(id), PRIMARY KEY(actor_id,source,operation_key,subject_id),
    FOREIGN KEY(actor_id,source,operation_key) REFERENCES operations(actor_id,source,operation_key) ON DELETE CASCADE
  );

CREATE TABLE outbox(
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), category TEXT NOT NULL,
    entity_id TEXT, event_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at BIGINT NOT NULL, delivered_at BIGINT, cancelled_at BIGINT
  );

CREATE TABLE privacy_requests(
    id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES accounts(id), requested_by TEXT NOT NULL REFERENCES accounts(id),
    request_type TEXT NOT NULL CHECK(request_type IN('export','delete')),
    status TEXT NOT NULL CHECK(status IN('pending_approval','approved','queued','processing','completed','rejected','failed','cancelled')),
    reason TEXT, created_at BIGINT NOT NULL, reviewed_by TEXT REFERENCES accounts(id), reviewed_at BIGINT, review_reason TEXT,
    expires_at BIGINT NOT NULL, completed_at BIGINT, export_key TEXT, export_sha256 TEXT, export_bytes BIGINT,
    export_expires_at BIGINT, failure_code TEXT, legal_hold BIGINT NOT NULL DEFAULT 0 CHECK(legal_hold IN(0,1)),
    execution_token TEXT, lease_until BIGINT, metadata_erased_at BIGINT
  );

CREATE TABLE privacy_deletion_status_receipts(
    request_id TEXT PRIMARY KEY REFERENCES privacy_requests(id), token_hash TEXT NOT NULL UNIQUE,
    operation_key TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
    revoked_at BIGINT, CHECK(length(token_hash)=64 AND expires_at>created_at)
  );

CREATE TABLE privacy_exports(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES privacy_requests(id), subject_id TEXT NOT NULL REFERENCES accounts(id),
    object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes BIGINT NOT NULL CHECK(bytes>0),
    expires_at BIGINT NOT NULL, status TEXT NOT NULL CHECK(status IN('pending','published','retired')), created_at BIGINT NOT NULL
  );

CREATE TABLE privacy_export_grants(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES privacy_requests(id), subject_id TEXT NOT NULL REFERENCES accounts(id),
    session_id TEXT NOT NULL REFERENCES sessions(id), token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL, consumed_at BIGINT, created_at BIGINT NOT NULL
  );

CREATE TABLE cleanup_intents(
    id TEXT PRIMARY KEY, request_id TEXT REFERENCES privacy_requests(id), subject_id TEXT REFERENCES accounts(id),
    bucket TEXT NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE','PRIVACY_EXPORTS')), object_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','verified','failed')), attempts BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL, verified_at BIGINT, UNIQUE(request_id,bucket,object_key)
  );

CREATE TABLE media_write_intents(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    bucket TEXT NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE','PRIVACY_EXPORTS')), object_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','settled')), created_at BIGINT NOT NULL, settled_at BIGINT
  );

CREATE TABLE audit_events(
    id TEXT PRIMARY KEY, actor_id TEXT, subject_id TEXT, action TEXT NOT NULL, entity_id TEXT,
    details_json TEXT NOT NULL CHECK(json_valid(details_json)), created_at BIGINT NOT NULL
  );

CREATE TABLE financial_records(
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), record_type TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at BIGINT NOT NULL
  );

CREATE TABLE privacy_redaction_context(
    request_id TEXT PRIMARY KEY REFERENCES privacy_requests(id), subject_id TEXT NOT NULL REFERENCES accounts(id)
  );

CREATE TABLE upload_transfers(
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64),
    bytes_received BIGINT NOT NULL DEFAULT 0 CHECK(bytes_received>=0),
    state TEXT NOT NULL CHECK(state IN('uploading','uploaded','cancelled','failed')),
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL CHECK(expires_at>created_at),
    lease_token TEXT, lease_until BIGINT, error_code TEXT
  );

CREATE TABLE upload_chunks(
    asset_id TEXT NOT NULL REFERENCES upload_transfers(asset_id) ON DELETE CASCADE,
    offset_bytes BIGINT NOT NULL CHECK(offset_bytes>=0),
    byte_size BIGINT NOT NULL CHECK(byte_size>0 AND byte_size<=262144),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64), object_key TEXT NOT NULL UNIQUE,
    PRIMARY KEY(asset_id,offset_bytes)
  );

CREATE TABLE store_subscriptions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),provider TEXT NOT NULL CHECK(provider IN('apple','google')),app_identity TEXT NOT NULL,original_id TEXT NOT NULL,product_id TEXT NOT NULL,billing_environment TEXT NOT NULL CHECK(billing_environment IN('production','sandbox')),active BIGINT NOT NULL CHECK(active IN(0,1)),starts_at BIGINT NOT NULL,expires_at BIGINT NOT NULL CHECK(expires_at>starts_at),observed_at BIGINT NOT NULL,transaction_id TEXT NOT NULL,version BIGINT NOT NULL DEFAULT 1,acknowledged BIGINT NOT NULL DEFAULT 1 CHECK(acknowledged IN(0,1)),UNIQUE(provider,billing_environment,original_id));

CREATE TABLE store_transactions(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES store_subscriptions(id),account_id TEXT NOT NULL REFERENCES accounts(id),provider TEXT NOT NULL,transaction_id TEXT NOT NULL,billing_environment TEXT NOT NULL,product_id TEXT NOT NULL,starts_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,observed_at BIGINT NOT NULL,payload_hash TEXT NOT NULL,active BIGINT NOT NULL,financial_eligible BIGINT NOT NULL CHECK(financial_eligible IN(0,1)),UNIQUE(provider,billing_environment,transaction_id));

CREATE TABLE store_notifications(provider TEXT NOT NULL,event_id TEXT NOT NULL,payload_hash TEXT NOT NULL,account_id TEXT REFERENCES accounts(id),status TEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(provider,event_id));

CREATE TABLE download_tickets(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),session_id TEXT NOT NULL REFERENCES sessions(id),asset_id TEXT NOT NULL REFERENCES assets(id),asset_version TEXT NOT NULL,source_checksum TEXT NOT NULL,subscription_id TEXT NOT NULL REFERENCES store_subscriptions(id),subscription_version BIGINT NOT NULL,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL);

CREATE TABLE download_records(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL REFERENCES accounts(id),asset_id TEXT NOT NULL REFERENCES assets(id),subscription_id TEXT NOT NULL REFERENCES store_subscriptions(id),created_at BIGINT NOT NULL,financial_eligible BIGINT NOT NULL CHECK(financial_eligible IN(0,1)));

CREATE TABLE support_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),subject TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('open','under_review','resolved','closed')),category TEXT NOT NULL DEFAULT 'general_support',assigned_to TEXT REFERENCES accounts(id),sla_due_at BIGINT,review_outcome TEXT,review_notes TEXT,reviewed_by TEXT REFERENCES accounts(id),reviewed_at BIGINT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,revision BIGINT NOT NULL DEFAULT 1);

CREATE TABLE safety_reports(id TEXT PRIMARY KEY,reporter_id TEXT NOT NULL REFERENCES accounts(id),subject_id TEXT REFERENCES accounts(id),asset_id TEXT REFERENCES assets(id),candidate_id TEXT REFERENCES candidates(id),reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('open','under_review','resolved','rejected')),outcome TEXT,reviewed_by TEXT REFERENCES accounts(id),reviewed_at BIGINT,review_notes TEXT,created_at BIGINT NOT NULL,revision BIGINT NOT NULL DEFAULT 1);

CREATE TABLE moderation_holds(id TEXT PRIMARY KEY,subject_id TEXT REFERENCES accounts(id),asset_id TEXT REFERENCES assets(id),report_id TEXT REFERENCES safety_reports(id),active BIGINT NOT NULL CHECK(active IN(0,1)),created_at BIGINT NOT NULL,cleared_at BIGINT,reason TEXT NOT NULL,CHECK(subject_id IS NOT NULL OR asset_id IS NOT NULL));

CREATE TABLE notification_settings(account_id TEXT PRIMARY KEY REFERENCES accounts(id),match_alerts BIGINT NOT NULL DEFAULT 1 CHECK(match_alerts IN(0,1)),payment_alerts BIGINT NOT NULL DEFAULT 1 CHECK(payment_alerts IN(0,1)),support_alerts BIGINT NOT NULL DEFAULT 1 CHECK(support_alerts IN(0,1)),updated_at BIGINT NOT NULL);

CREATE TABLE push_devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),auth_device_id TEXT NOT NULL REFERENCES auth_devices(id),platform TEXT NOT NULL CHECK(platform IN('ios','android')),token_hash TEXT NOT NULL UNIQUE,token_value TEXT NOT NULL,active BIGINT NOT NULL CHECK(active IN(0,1)),created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL);

CREATE TABLE notifications(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL CHECK(kind IN('match','payment','support')),entity_id TEXT NOT NULL,title TEXT NOT NULL,created_at BIGINT NOT NULL,read_at BIGINT,UNIQUE(account_id,kind,entity_id));

CREATE TABLE notification_jobs(notification_id TEXT PRIMARY KEY REFERENCES notifications(id),account_id TEXT NOT NULL REFERENCES accounts(id),auth_epoch BIGINT NOT NULL,status TEXT NOT NULL CHECK(status IN('queued','dispatched','accepted','ambiguous','cancelled','inbox_only')),created_at BIGINT NOT NULL,dispatched_at BIGINT);

CREATE TABLE notification_deliveries(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),device_id TEXT NOT NULL REFERENCES push_devices(id),operation_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN('queued','dispatching','accepted','ambiguous','cancelled')),token_hash TEXT NOT NULL,provider_receipt TEXT,lease_token TEXT,lease_until BIGINT,attempts BIGINT NOT NULL DEFAULT 0,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,UNIQUE(notification_id,device_id));

CREATE TABLE retention_settings(id TEXT PRIMARY KEY CHECK(id='default'),version BIGINT NOT NULL CHECK(version>0),raw_days BIGINT NOT NULL CHECK(raw_days BETWEEN 1 AND 3650),preview_days BIGINT NOT NULL CHECK(preview_days BETWEEN 1 AND 3650),face_crop_days BIGINT NOT NULL CHECK(face_crop_days BETWEEN 1 AND 3650),free_cache_days BIGINT NOT NULL CHECK(free_cache_days BETWEEN 1 AND 3650),audit_days BIGINT NOT NULL CHECK(audit_days BETWEEN 2555 AND 36500),legal_hold BIGINT NOT NULL DEFAULT 0 CHECK(legal_hold IN(0,1)),updated_at BIGINT NOT NULL);

CREATE TABLE asset_retention(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,raw_expires_at BIGINT NOT NULL,preview_expires_at BIGINT NOT NULL,legal_hold BIGINT NOT NULL DEFAULT 0 CHECK(legal_hold IN(0,1)),version BIGINT NOT NULL DEFAULT 1,updated_at BIGINT NOT NULL);

CREATE TABLE retention_jobs(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES accounts(id),asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN('raw','preview','profile')),binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),policy_version BIGINT NOT NULL,object_version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','processing','failed','verified','blocked')),lease_token TEXT,lease_until BIGINT,created_at BIGINT NOT NULL,verified_at BIGINT,error_code TEXT,CHECK((asset_id IS NULL)=(kind='profile')));

CREATE TABLE retention_objects(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES retention_jobs(id) ON DELETE CASCADE,bucket TEXT NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE')),object_key TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','failed','verified')),attempts BIGINT NOT NULL DEFAULT 0,created_at BIGINT NOT NULL,verified_at BIGINT,UNIQUE(job_id,bucket,object_key));

CREATE TABLE job_queue(id text PRIMARY KEY,category text NOT NULL CHECK(category IN('photo','privacy','notification')),payload_json text NOT NULL CHECK(json_valid(payload_json)),state text NOT NULL CHECK(state IN('pending','processing','completed','failed')),available_at bigint NOT NULL,created_at bigint NOT NULL,attempts bigint NOT NULL DEFAULT 0,lease_token text,lease_until bigint,completed_at bigint,error_code text);

CREATE TABLE face_profile_operations(
    account_id TEXT NOT NULL REFERENCES accounts(id), operation_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN('pause','resume','withdraw_authentication','remove','replace','restore_authentication','enroll')),
    input_hash TEXT NOT NULL CHECK(length(input_hash)=64), expected_version BIGINT NOT NULL CHECK(expected_version>0),
    control_device_id TEXT NOT NULL REFERENCES auth_devices(id), control_revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('pending','applied','completed','cancelled')),
    auth_epoch BIGINT NOT NULL CHECK(auth_epoch>0), consent_id TEXT REFERENCES consents(id),
    challenge_id TEXT REFERENCES auth_challenges(id), generation BIGINT NOT NULL CHECK(generation>=0),
    last_resume_key TEXT, previous_challenge_id TEXT, previous_generation BIGINT,
    cleanup_id TEXT REFERENCES cleanup_intents(id), created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL CHECK(expires_at>created_at), PRIMARY KEY(account_id,operation_key),
    CHECK((challenge_id IS NULL AND generation=0) OR (challenge_id IS NOT NULL AND generation>0))
  );

CREATE TABLE face_profile_retirements(
    cleanup_id TEXT PRIMARY KEY REFERENCES cleanup_intents(id), account_id TEXT NOT NULL REFERENCES accounts(id),
    operation_key TEXT NOT NULL, profile_id TEXT NOT NULL, profile_revision TEXT NOT NULL,
    template_key TEXT NOT NULL, template_digest TEXT NOT NULL CHECK(length(template_digest)=64)
  );

CREATE INDEX consent_account_purpose ON consents(account_id,purpose,status);

CREATE INDEX session_account ON sessions(account_id,revoked_at);

CREATE INDEX auth_challenge_account ON auth_challenges(account_id,status);

CREATE INDEX face_enrollment_expiry ON face_enrollment_intents(expires_at);

CREATE INDEX face_recovery_key_account ON face_recovery_keys(account_id,revoked_at,consumed_at);

CREATE INDEX face_recovery_intent_expiry ON face_recovery_intents(expires_at);

CREATE INDEX face_profile_operation_expiry ON face_profile_operations(expires_at);

CREATE INDEX assets_owner_batch ON assets(owner_id,source,batch_id,deleted_at);

CREATE INDEX rendition_asset ON renditions(asset_id,status);

CREATE UNIQUE INDEX rendition_ready_preview ON renditions(asset_id,kind) WHERE status='ready';

CREATE INDEX candidate_owner ON candidates(owner_id,asset_id,status);

CREATE INDEX snapshot_owner ON sharing_snapshots(owner_id,created_at);

CREATE INDEX request_subject ON sharing_requests(recipient_id,status,created_at);

CREATE INDEX grant_recipient ON media_grants(recipient_id,asset_id,active);

CREATE INDEX operation_subject ON operation_subjects(subject_id);

CREATE INDEX privacy_subject ON privacy_requests(subject_id,created_at);

CREATE INDEX privacy_deletion_receipt_expiry ON privacy_deletion_status_receipts(expires_at);

CREATE INDEX media_write_account ON media_write_intents(account_id,status);

CREATE INDEX upload_transfer_expiry ON upload_transfers(state,expires_at);

CREATE INDEX store_account ON store_subscriptions(account_id,active,expires_at);

CREATE INDEX support_account ON support_requests(account_id,created_at);

CREATE INDEX safety_status ON safety_reports(status,created_at);

CREATE INDEX notification_account ON notifications(account_id,created_at);

CREATE UNIQUE INDEX retention_asset_job ON retention_jobs(asset_id,kind,object_version,policy_version) WHERE asset_id IS NOT NULL;

CREATE UNIQUE INDEX retention_profile_job ON retention_jobs(subject_id,object_version,policy_version) WHERE kind='profile';

CREATE INDEX retention_pending ON retention_jobs(status,created_at);

CREATE INDEX job_queue_due ON job_queue(state,available_at);

CREATE FUNCTION guard_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.source<>OLD.source OR NEW.version<>OLD.version
      OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
      OR ((NEW.graph_json<>OLD.graph_json OR NEW.privacy_redacted_at IS DISTINCT FROM OLD.privacy_redacted_at)
        AND NOT EXISTS(SELECT 1 FROM privacy_redaction_context c JOIN privacy_requests r ON r.id=c.request_id
          JOIN accounts a ON a.id=c.subject_id WHERE r.subject_id=c.subject_id AND r.request_type='delete'
          AND r.status='processing' AND r.reviewed_by IS NOT NULL AND a.disabled_at IS NOT NULL)) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='sharing_snapshot_immutable'; END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER snapshot_immutable BEFORE UPDATE ON sharing_snapshots FOR EACH ROW EXECUTE FUNCTION guard_snapshot_immutable();

CREATE FUNCTION guard_preview_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.snapshot_id<>OLD.snapshot_id OR NEW.source<>OLD.source
      OR NEW.version<>OLD.version OR NEW.draft_version<>OLD.draft_version OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
      OR (OLD.committed_at IS NOT NULL AND (NEW.committed_at IS DISTINCT FROM OLD.committed_at OR NEW.operation_key IS DISTINCT FROM OLD.operation_key))
      OR ((NEW.pairs_json<>OLD.pairs_json OR NEW.manifest_json<>OLD.manifest_json OR NEW.privacy_redacted_at IS DISTINCT FROM OLD.privacy_redacted_at)
        AND NOT EXISTS(SELECT 1 FROM privacy_redaction_context c JOIN privacy_requests r ON r.id=c.request_id
          JOIN accounts a ON a.id=c.subject_id WHERE r.subject_id=c.subject_id AND r.request_type='delete'
          AND r.status='processing' AND r.reviewed_by IS NOT NULL AND a.disabled_at IS NOT NULL)) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='sharing_preview_immutable'; END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER preview_immutable BEFORE UPDATE ON sharing_previews FOR EACH ROW EXECUTE FUNCTION guard_preview_immutable();

CREATE FUNCTION guard_origin_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='matching_origin_immutable';
  RETURN NEW;
END $f$;
CREATE TRIGGER origin_immutable BEFORE UPDATE ON match_origins FOR EACH ROW EXECUTE FUNCTION guard_origin_immutable();

CREATE FUNCTION guard_approval_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='sharing_approval_immutable';
  RETURN NEW;
END $f$;
CREATE TRIGGER approval_immutable BEFORE UPDATE ON sharing_approvals FOR EACH ROW EXECUTE FUNCTION guard_approval_immutable();


-- Seed schema metadata while the migration owner still has ordinary table-owner
-- authority. FORCE RLS below also applies to an owner without BYPASSRLS.
INSERT INTO schema_versions(version,applied_at) VALUES(7,(extract(epoch FROM clock_timestamp())*1000)::bigint);
ALTER TABLE schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON schema_versions TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON accounts TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON consents TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_profiles TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE auth_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON auth_devices TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON sessions TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON auth_challenges TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE auth_capture_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_capture_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON auth_capture_proofs TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_enrollment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_enrollment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_enrollment_intents TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_recovery_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_recovery_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_recovery_keys TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_recovery_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_recovery_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_recovery_intents TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_profile_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_profile_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_profile_controls TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_profile_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_profile_states FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_profile_states TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE request_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON request_limits TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON blocks TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE account_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON account_preferences TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON assets TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE renditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE renditions FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON renditions TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON processing_attempts TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE photo_job_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_job_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON photo_job_outbox TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE match_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON match_origins TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON candidates TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE sharing_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON sharing_snapshots TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE sharing_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON sharing_previews TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE sharing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON sharing_requests TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE sharing_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON sharing_approvals TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE media_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON media_grants TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE media_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON media_tickets TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON operations TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE operation_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_subjects FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON operation_subjects TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON outbox TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON privacy_requests TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE privacy_deletion_status_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_deletion_status_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON privacy_deletion_status_receipts TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE privacy_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON privacy_exports TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE privacy_export_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_export_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON privacy_export_grants TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE cleanup_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleanup_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON cleanup_intents TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE media_write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_write_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON media_write_intents TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON audit_events TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE financial_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_records FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON financial_records TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE privacy_redaction_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_redaction_context FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON privacy_redaction_context TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE upload_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON upload_transfers TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE upload_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON upload_chunks TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE store_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON store_subscriptions TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE store_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON store_transactions TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE store_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON store_notifications TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE download_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE download_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON download_tickets TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE download_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE download_records FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON download_records TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON support_requests TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE safety_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON safety_reports TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE moderation_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON moderation_holds TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON notification_settings TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON push_devices TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON notifications TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE notification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON notification_jobs TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON notification_deliveries TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON retention_settings TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE asset_retention ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_retention FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON asset_retention TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE retention_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON retention_jobs TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE retention_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON retention_objects TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON job_queue TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_profile_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_profile_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_profile_operations TO lovelies_api USING(true) WITH CHECK(true);
ALTER TABLE face_profile_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE face_profile_retirements FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON face_profile_retirements TO lovelies_api USING(true) WITH CHECK(true);
REVOKE ALL ON ALL TABLES IN SCHEMA lovelies_private FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA lovelies_private TO lovelies_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lovelies_private FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lovelies_private TO lovelies_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET search_path;

