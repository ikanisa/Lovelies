import { entitlementsSchemaStatements } from './entitlements.ts';
import { operatorsSchemaStatements } from './operators.ts';
import { notificationsSchemaStatements } from './notifications.ts';
import { retentionSchemaStatements } from './retention.ts';
import { uploadSchemaStatements } from './upload-schema.ts';
import { refreshDeliverySchemaStatements } from './refresh-delivery.ts';
export const currentSchemaVersion = 8;
export const extensionSchemaStatements: readonly string[] = [
    ...entitlementsSchemaStatements, ...operatorsSchemaStatements, ...notificationsSchemaStatements, ...retentionSchemaStatements, ...refreshDeliverySchemaStatements,
];
/** Logical engine schema used by the migration generator. Never execute these
 * source definitions at runtime: generate-schema emits reviewed PostgreSQL DDL. */
export const schemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS accounts(
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    roles_json TEXT NOT NULL DEFAULT '["user"]' CHECK(json_valid(roles_json) AND json_type(roles_json)='array'),
    disabled_at INTEGER, auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK(auth_epoch>0),
    created_at INTEGER NOT NULL DEFAULT 0,
    identity_state TEXT NOT NULL DEFAULT 'anonymous' CHECK(identity_state IN('anonymous','registered_face'))
  )`,
    `CREATE TABLE IF NOT EXISTS consents(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), purpose TEXT NOT NULL,
    policy_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('granted','revoked','expired')),
    expires_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0, profile_revision TEXT,
    CHECK(status<>'revoked' OR revoked_at IS NOT NULL)
  )`,
    `CREATE INDEX IF NOT EXISTS consent_account_purpose ON consents(account_id,purpose,status)`,
    `CREATE TABLE IF NOT EXISTS face_profiles(
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), id TEXT NOT NULL UNIQUE,
    revision TEXT NOT NULL, model_id TEXT NOT NULL, template_key TEXT NOT NULL,
    template_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('active','pending','revoked','disabled')),
    consent_id TEXT REFERENCES consents(id), auth_enabled INTEGER NOT NULL DEFAULT 0 CHECK(auth_enabled IN(0,1)),
    auth_epoch INTEGER NOT NULL CHECK(auth_epoch>0), auth_consent_id TEXT REFERENCES consents(id)
  )`,
    `CREATE TABLE IF NOT EXISTS auth_devices(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)), revision TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','active','revoked','disabled')), created_at INTEGER NOT NULL,
    face_handle TEXT UNIQUE
  )`,
    `CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), refresh_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL, revoked_at INTEGER,
    auth_epoch INTEGER NOT NULL CHECK(auth_epoch>0), auth_method TEXT NOT NULL CHECK(auth_method IN('anonymous','registered_face')),
    face_profile_revision TEXT, face_consent_id TEXT REFERENCES consents(id), device_id TEXT REFERENCES auth_devices(id),
    created_at INTEGER NOT NULL, refresh_consumed_at INTEGER, face_profile_epoch INTEGER, device_revision TEXT,
    CHECK(expires_at>created_at AND refresh_expires_at>=expires_at),
    CHECK(auth_method<>'registered_face' OR (face_profile_revision IS NOT NULL AND face_consent_id IS NOT NULL AND device_id IS NOT NULL))
  )`,
    `CREATE INDEX IF NOT EXISTS session_account ON sessions(account_id,revoked_at)`,
    `CREATE TABLE IF NOT EXISTS auth_challenges(
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), device_id TEXT,
    purpose TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, profile_revision TEXT, profile_id TEXT,
    policy_version TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20), capture_digest TEXT,
    created_at INTEGER NOT NULL, session_id TEXT, auth_epoch INTEGER, consent_id TEXT,
    proof_key TEXT, proof_sha256 TEXT, proof_mime TEXT, proof_size INTEGER, used_at INTEGER,
    device_revision TEXT, model_id TEXT, profile_auth_epoch INTEGER, reference_digest TEXT,
    required_captures INTEGER NOT NULL DEFAULT 1 CHECK(required_captures IN(1,3)),
    CHECK(expires_at>created_at), CHECK(proof_size IS NULL OR proof_size>0)
  )`,
    `CREATE INDEX IF NOT EXISTS auth_challenge_account ON auth_challenges(account_id,status)`,
    `CREATE TABLE IF NOT EXISTS auth_capture_proofs(
    challenge_id TEXT NOT NULL REFERENCES auth_challenges(id), capture_index INTEGER NOT NULL CHECK(capture_index BETWEEN 0 AND 2),
    object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, mime TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0),
    created_at INTEGER NOT NULL, PRIMARY KEY(challenge_id,capture_index)
  )`,
    `CREATE TABLE IF NOT EXISTS face_enrollment_intents(
    account_id TEXT NOT NULL REFERENCES accounts(id), enrollment_key TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE REFERENCES auth_devices(id), device_revision TEXT NOT NULL,
    public_key_digest TEXT NOT NULL CHECK(length(public_key_digest)=64),
    handle_hash TEXT NOT NULL UNIQUE CHECK(length(handle_hash)=64), start_hash TEXT NOT NULL CHECK(length(start_hash)=64),
    consent_id TEXT NOT NULL REFERENCES consents(id), policy_version TEXT NOT NULL,
    auth_epoch INTEGER NOT NULL CHECK(auth_epoch>0), challenge_id TEXT NOT NULL REFERENCES auth_challenges(id),
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0), last_resume_key TEXT,
    previous_challenge_id TEXT, previous_generation INTEGER, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), revoked_at INTEGER,
    completed_profile_id TEXT, completed_profile_revision TEXT, completed_model_id TEXT, completed_reference_digest TEXT,
    completed_auth_epoch INTEGER, completed_profile_epoch INTEGER,
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
  )`,
    `CREATE INDEX IF NOT EXISTS face_enrollment_expiry ON face_enrollment_intents(expires_at)`,
    `CREATE TABLE IF NOT EXISTS face_recovery_keys(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), operation_key TEXT NOT NULL,
    profile_id TEXT NOT NULL, profile_revision TEXT NOT NULL, model_id TEXT NOT NULL,
    reference_digest TEXT NOT NULL CHECK(length(reference_digest)=64),
    auth_epoch INTEGER NOT NULL CHECK(auth_epoch>0), profile_epoch INTEGER NOT NULL CHECK(profile_epoch>0),
    consent_id TEXT NOT NULL REFERENCES consents(id), policy_version TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
    revoked_at INTEGER, consumed_at INTEGER, UNIQUE(account_id,operation_key)
  )`,
    `CREATE INDEX IF NOT EXISTS face_recovery_key_account ON face_recovery_keys(account_id,revoked_at,consumed_at)`,
    `CREATE TABLE IF NOT EXISTS face_recovery_intents(
    account_id TEXT NOT NULL REFERENCES accounts(id), recovery_request_id TEXT NOT NULL,
    key_id TEXT NOT NULL REFERENCES face_recovery_keys(id), device_id TEXT NOT NULL UNIQUE REFERENCES auth_devices(id),
    device_revision TEXT NOT NULL, public_key_digest TEXT NOT NULL CHECK(length(public_key_digest)=64),
    public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)),
    handle_hash TEXT NOT NULL UNIQUE CHECK(length(handle_hash)=64), start_hash TEXT NOT NULL CHECK(length(start_hash)=64),
    challenge_id TEXT NOT NULL REFERENCES auth_challenges(id), generation INTEGER NOT NULL CHECK(generation>0),
    last_resume_key TEXT, previous_challenge_id TEXT, previous_generation INTEGER,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
    completed_at INTEGER, completed_auth_epoch INTEGER,
    PRIMARY KEY(account_id,recovery_request_id),
    CHECK((completed_at IS NULL AND completed_auth_epoch IS NULL) OR
      (completed_at IS NOT NULL AND completed_auth_epoch IS NOT NULL AND completed_auth_epoch>0)),
    CHECK((last_resume_key IS NULL AND previous_challenge_id IS NULL AND previous_generation IS NULL) OR
      (last_resume_key IS NOT NULL AND previous_challenge_id IS NOT NULL AND previous_generation IS NOT NULL
      AND previous_generation>0 AND previous_generation<generation))
  )`,
    `CREATE INDEX IF NOT EXISTS face_recovery_intent_expiry ON face_recovery_intents(expires_at)`,
    `CREATE TABLE IF NOT EXISTS face_profile_controls(
    account_id TEXT NOT NULL REFERENCES accounts(id), device_id TEXT NOT NULL REFERENCES auth_devices(id),
    control_hash TEXT NOT NULL UNIQUE CHECK(length(control_hash)=64), control_operation_key TEXT NOT NULL,
    creation_hash TEXT NOT NULL CHECK(length(creation_hash)=64),
    device_revision TEXT NOT NULL, public_key_digest TEXT NOT NULL CHECK(length(public_key_digest)=64),
    public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
    PRIMARY KEY(account_id,device_id)
  )`,
    `CREATE TABLE IF NOT EXISTS face_profile_states(
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), version INTEGER NOT NULL CHECK(version>0),
    matching_paused INTEGER NOT NULL DEFAULT 0 CHECK(matching_paused IN(0,1)), removal_operation_key TEXT
  )`,
    `CREATE TABLE IF NOT EXISTS face_profile_operations(
    account_id TEXT NOT NULL REFERENCES accounts(id), operation_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN('pause','resume','withdraw_authentication','remove','replace','restore_authentication','enroll')),
    input_hash TEXT NOT NULL CHECK(length(input_hash)=64), expected_version INTEGER NOT NULL CHECK(expected_version>0),
    control_device_id TEXT NOT NULL REFERENCES auth_devices(id), control_revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('pending','applied','completed','cancelled')),
    auth_epoch INTEGER NOT NULL CHECK(auth_epoch>0), consent_id TEXT REFERENCES consents(id),
    challenge_id TEXT REFERENCES auth_challenges(id), generation INTEGER NOT NULL CHECK(generation>=0),
    last_resume_key TEXT, previous_challenge_id TEXT, previous_generation INTEGER,
    cleanup_id TEXT REFERENCES cleanup_intents(id), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), PRIMARY KEY(account_id,operation_key),
    CHECK((challenge_id IS NULL AND generation=0) OR (challenge_id IS NOT NULL AND generation>0))
  )`,
    `CREATE INDEX IF NOT EXISTS face_profile_operation_expiry ON face_profile_operations(expires_at)`,
    `CREATE TABLE IF NOT EXISTS face_profile_retirements(
    cleanup_id TEXT PRIMARY KEY REFERENCES cleanup_intents(id), account_id TEXT NOT NULL REFERENCES accounts(id),
    operation_key TEXT NOT NULL, profile_id TEXT NOT NULL, profile_revision TEXT NOT NULL,
    template_key TEXT NOT NULL, template_digest TEXT NOT NULL CHECK(length(template_digest)=64)
  )`,
    `CREATE TABLE IF NOT EXISTS request_limits(
    key TEXT PRIMARY KEY, hits INTEGER NOT NULL CHECK(hits>0), expires_at INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS blocks(
    blocker_id TEXT NOT NULL REFERENCES accounts(id), blocked_id TEXT NOT NULL REFERENCES accounts(id),
    created_at INTEGER NOT NULL, PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id<>blocked_id)
  )`,
    `CREATE TABLE IF NOT EXISTS account_preferences(
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), receive_matches INTEGER NOT NULL DEFAULT 0 CHECK(receive_matches IN(0,1)),
    download_photos INTEGER NOT NULL DEFAULT 0 CHECK(download_photos IN(0,1)), updated_at INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS assets(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL CHECK(source IN('personal','professional')),
    batch_id TEXT, status TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size>0), checksum_sha256 TEXT, version TEXT NOT NULL,
    width INTEGER, height INTEGER, title TEXT, captured_at INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0,
    CHECK(width IS NULL OR width>0), CHECK(height IS NULL OR height>0)
  )`,
    `CREATE INDEX IF NOT EXISTS assets_owner_batch ON assets(owner_id,source,batch_id,deleted_at)`,
    `CREATE TABLE IF NOT EXISTS renditions(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), object_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0), checksum_sha256 TEXT NOT NULL,
    source_checksum_sha256 TEXT NOT NULL, version TEXT NOT NULL, width INTEGER, height INTEGER,
    verified_at INTEGER, status TEXT NOT NULL, source_version TEXT, model_version TEXT, kind TEXT NOT NULL DEFAULT 'preview', orientation INTEGER,
    CHECK(width IS NULL OR width>0), CHECK(height IS NULL OR height>0), CHECK(orientation IS NULL OR orientation BETWEEN 1 AND 8)
  )`,
    `CREATE INDEX IF NOT EXISTS rendition_asset ON renditions(asset_id,status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS rendition_ready_preview ON renditions(asset_id,kind) WHERE status='ready'`,
    `CREATE TABLE IF NOT EXISTS processing_attempts(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), source_version TEXT NOT NULL,
    source_checksum_sha256 TEXT NOT NULL, model_version TEXT NOT NULL, status TEXT NOT NULL,
    captured_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>captured_at),
    owner_id TEXT REFERENCES accounts(id), source TEXT, rendition_key TEXT,
    profiles_json TEXT CHECK(profiles_json IS NULL OR json_valid(profiles_json)),
    matches_json TEXT CHECK(matches_json IS NULL OR json_valid(matches_json)), processor_nonce TEXT,
    completed_at INTEGER, error_code TEXT, owner_session_id TEXT, owner_auth_epoch INTEGER,
    lease_token TEXT, lease_until INTEGER
  )`,
    `CREATE TABLE IF NOT EXISTS photo_job_outbox(
    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id), asset_id TEXT NOT NULL REFERENCES assets(id),
    status TEXT NOT NULL, created_at INTEGER NOT NULL, dispatched_at INTEGER
  )`,
    `CREATE TABLE IF NOT EXISTS match_origins(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
    profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, model_version TEXT NOT NULL,
    source_version TEXT NOT NULL, source_checksum_sha256 TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES processing_attempts(id), captured_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    matching_consent_id TEXT REFERENCES consents(id), profile_digest TEXT,
    CHECK(expires_at>captured_at), UNIQUE(attempt_id,asset_id,recipient_id,profile_id)
  )`,
    `CREATE TABLE IF NOT EXISTS candidates(
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), owner_id TEXT NOT NULL REFERENCES accounts(id),
    recipient_id TEXT NOT NULL REFERENCES accounts(id), origin_id TEXT NOT NULL REFERENCES match_origins(id),
    status TEXT NOT NULL, version TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0,
    CHECK(owner_id<>recipient_id), UNIQUE(asset_id,owner_id,recipient_id)
  )`,
    `CREATE INDEX IF NOT EXISTS candidate_owner ON candidates(owner_id,asset_id,status)`,
    `CREATE TABLE IF NOT EXISTS sharing_snapshots(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL CHECK(source IN('personal','professional')),
    batch_id TEXT, version TEXT NOT NULL, graph_json TEXT NOT NULL CHECK(json_valid(graph_json)),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at), privacy_redacted_at INTEGER
  )`,
    `CREATE INDEX IF NOT EXISTS snapshot_owner ON sharing_snapshots(owner_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS sharing_previews(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), snapshot_id TEXT NOT NULL REFERENCES sharing_snapshots(id),
    source TEXT NOT NULL CHECK(source IN('personal','professional')), version TEXT NOT NULL,
    draft_version INTEGER NOT NULL CHECK(draft_version>0),
    pairs_json TEXT NOT NULL CHECK(json_valid(pairs_json) AND json_type(pairs_json)='array' AND json_array_length(pairs_json) BETWEEN 1 AND 1000),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), committed_at INTEGER, operation_key TEXT,
    privacy_redacted_at INTEGER, CHECK((committed_at IS NULL)=(operation_key IS NULL))
  )`,
    `CREATE TABLE IF NOT EXISTS sharing_requests(
    id TEXT PRIMARY KEY, preview_id TEXT NOT NULL REFERENCES sharing_previews(id), sender_id TEXT NOT NULL REFERENCES accounts(id),
    recipient_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL CHECK(source IN('personal','professional')),
    asset_ids_json TEXT NOT NULL CHECK(json_valid(asset_ids_json) AND json_type(asset_ids_json)='array' AND json_array_length(asset_ids_json) BETWEEN 1 AND 100),
    status TEXT NOT NULL CHECK(status IN('requested','accepted','declined','withdrawn','expired','revoked','blocked')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at), updated_at INTEGER NOT NULL,
    UNIQUE(preview_id,recipient_id), CHECK(sender_id<>recipient_id)
  )`,
    `CREATE INDEX IF NOT EXISTS request_subject ON sharing_requests(recipient_id,status,created_at)`,
    `CREATE TABLE IF NOT EXISTS sharing_approvals(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES sharing_requests(id), preview_id TEXT NOT NULL REFERENCES sharing_previews(id),
    owner_id TEXT NOT NULL REFERENCES accounts(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
    asset_id TEXT NOT NULL REFERENCES assets(id), candidate_id TEXT NOT NULL REFERENCES candidates(id),
    pair_version TEXT NOT NULL, approved_at INTEGER NOT NULL, origin_id TEXT REFERENCES match_origins(id),
    UNIQUE(preview_id,asset_id,recipient_id)
  )`,
    `CREATE TABLE IF NOT EXISTS media_grants(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES sharing_requests(id), approval_id TEXT REFERENCES sharing_approvals(id) ON DELETE SET NULL,
    owner_id TEXT NOT NULL REFERENCES accounts(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
    asset_id TEXT NOT NULL REFERENCES assets(id), active INTEGER NOT NULL CHECK(active IN(0,1)),
    created_at INTEGER NOT NULL, revoked_at INTEGER, review_managed INTEGER NOT NULL DEFAULT 1 CHECK(review_managed IN(0,1)),
    UNIQUE(request_id,asset_id,recipient_id), CHECK(active=0 OR revoked_at IS NULL)
  )`,
    `CREATE INDEX IF NOT EXISTS grant_recipient ON media_grants(recipient_id,asset_id,active)`,
    `CREATE TABLE IF NOT EXISTS media_tickets(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), session_id TEXT NOT NULL REFERENCES sessions(id),
    asset_id TEXT NOT NULL REFERENCES assets(id), rendition_id TEXT NOT NULL REFERENCES renditions(id),
    asset_version TEXT NOT NULL, rendition_version TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS operations(
    actor_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL, operation_key TEXT NOT NULL,
    action TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,source,operation_key)
  )`,
    `CREATE TABLE IF NOT EXISTS operation_subjects(
    actor_id TEXT NOT NULL, source TEXT NOT NULL, operation_key TEXT NOT NULL,
    subject_id TEXT NOT NULL REFERENCES accounts(id), PRIMARY KEY(actor_id,source,operation_key,subject_id),
    FOREIGN KEY(actor_id,source,operation_key) REFERENCES operations(actor_id,source,operation_key) ON DELETE CASCADE
  )`,
    `CREATE INDEX IF NOT EXISTS operation_subject ON operation_subjects(subject_id)`,
    `CREATE TABLE IF NOT EXISTS outbox(
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), category TEXT NOT NULL,
    entity_id TEXT, event_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at INTEGER NOT NULL, delivered_at INTEGER, cancelled_at INTEGER
  )`,
    `CREATE TABLE IF NOT EXISTS privacy_requests(
    id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES accounts(id), requested_by TEXT NOT NULL REFERENCES accounts(id),
    request_type TEXT NOT NULL CHECK(request_type IN('export','delete')),
    status TEXT NOT NULL CHECK(status IN('pending_approval','approved','queued','processing','completed','rejected','failed','cancelled')),
    reason TEXT, created_at INTEGER NOT NULL, reviewed_by TEXT REFERENCES accounts(id), reviewed_at INTEGER, review_reason TEXT,
    expires_at INTEGER NOT NULL, completed_at INTEGER, export_key TEXT, export_sha256 TEXT, export_bytes INTEGER,
    export_expires_at INTEGER, failure_code TEXT, legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN(0,1)),
    execution_token TEXT, lease_until INTEGER, metadata_erased_at INTEGER
  )`,
    `CREATE INDEX IF NOT EXISTS privacy_subject ON privacy_requests(subject_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS privacy_deletion_status_receipts(
    request_id TEXT PRIMARY KEY REFERENCES privacy_requests(id), token_hash TEXT NOT NULL UNIQUE,
    operation_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    revoked_at INTEGER, CHECK(length(token_hash)=64 AND expires_at>created_at)
  )`,
    `CREATE INDEX IF NOT EXISTS privacy_deletion_receipt_expiry ON privacy_deletion_status_receipts(expires_at)`,
    `CREATE TABLE IF NOT EXISTS privacy_exports(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES privacy_requests(id), subject_id TEXT NOT NULL REFERENCES accounts(id),
    object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0),
    expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN('pending','published','retired')), created_at INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS privacy_export_grants(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES privacy_requests(id), subject_id TEXT NOT NULL REFERENCES accounts(id),
    session_id TEXT NOT NULL REFERENCES sessions(id), token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS cleanup_intents(
    id TEXT PRIMARY KEY, request_id TEXT REFERENCES privacy_requests(id), subject_id TEXT REFERENCES accounts(id),
    bucket TEXT NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE','PRIVACY_EXPORTS')), object_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','verified','failed')), attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, verified_at INTEGER, UNIQUE(request_id,bucket,object_key)
  )`,
    `CREATE TABLE IF NOT EXISTS media_write_intents(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    bucket TEXT NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE','PRIVACY_EXPORTS')), object_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','settled')), created_at INTEGER NOT NULL, settled_at INTEGER
  )`,
    `CREATE INDEX IF NOT EXISTS media_write_account ON media_write_intents(account_id,status)`,
    `CREATE TABLE IF NOT EXISTS audit_events(
    id TEXT PRIMARY KEY, actor_id TEXT, subject_id TEXT, action TEXT NOT NULL, entity_id TEXT,
    details_json TEXT NOT NULL CHECK(json_valid(details_json)), created_at INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS financial_records(
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), record_type TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS privacy_redaction_context(
    request_id TEXT PRIMARY KEY REFERENCES privacy_requests(id), subject_id TEXT NOT NULL REFERENCES accounts(id)
  )`,
    `CREATE TRIGGER IF NOT EXISTS snapshot_immutable BEFORE UPDATE ON sharing_snapshots
    WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.source<>OLD.source OR NEW.version<>OLD.version
      OR NEW.batch_id IS NOT OLD.batch_id OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
      OR ((NEW.graph_json<>OLD.graph_json OR NEW.privacy_redacted_at IS NOT OLD.privacy_redacted_at)
        AND NOT EXISTS(SELECT 1 FROM privacy_redaction_context c JOIN privacy_requests r ON r.id=c.request_id
          JOIN accounts a ON a.id=c.subject_id WHERE r.subject_id=c.subject_id AND r.request_type='delete'
          AND r.status='processing' AND r.reviewed_by IS NOT NULL AND a.disabled_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'sharing_snapshot_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS preview_immutable BEFORE UPDATE ON sharing_previews
    WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.snapshot_id<>OLD.snapshot_id OR NEW.source<>OLD.source
      OR NEW.version<>OLD.version OR NEW.draft_version<>OLD.draft_version OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
      OR (OLD.committed_at IS NOT NULL AND (NEW.committed_at IS NOT OLD.committed_at OR NEW.operation_key IS NOT OLD.operation_key))
      OR ((NEW.pairs_json<>OLD.pairs_json OR NEW.manifest_json<>OLD.manifest_json OR NEW.privacy_redacted_at IS NOT OLD.privacy_redacted_at)
        AND NOT EXISTS(SELECT 1 FROM privacy_redaction_context c JOIN privacy_requests r ON r.id=c.request_id
          JOIN accounts a ON a.id=c.subject_id WHERE r.subject_id=c.subject_id AND r.request_type='delete'
          AND r.status='processing' AND r.reviewed_by IS NOT NULL AND a.disabled_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'sharing_preview_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS origin_immutable BEFORE UPDATE ON match_origins BEGIN SELECT RAISE(ABORT,'matching_origin_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS approval_immutable BEFORE UPDATE ON sharing_approvals BEGIN SELECT RAISE(ABORT,'sharing_approval_immutable'); END`,
    ...uploadSchemaStatements,
];
