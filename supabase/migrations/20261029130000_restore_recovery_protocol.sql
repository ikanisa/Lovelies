-- Additive v15. Replay state is not a serving flag: only the independent
-- journal can accept the computed restriction/effect checkpoint and incarnation.
SET search_path TO lovelies_private,pg_catalog;
DO $restore_recovery$
DECLARE migrator name:=current_user; actual bigint; tab text;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api') OR
    EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api' AND
      (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
    pg_has_role('anon','lovelies_api','MEMBER') OR pg_has_role('authenticated','lovelies_api','MEMBER') THEN
   RAISE EXCEPTION 'unexpected_lovelies_api_role';
 END IF;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 SELECT max(version) INTO actual FROM lovelies_private.schema_versions;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 IF actual IS DISTINCT FROM 14 THEN RAISE EXCEPTION 'restore_recovery_requires_schema_v14'; END IF;
 CREATE TABLE lovelies_private.restore_transaction_facts(
   id text PRIMARY KEY DEFAULT gen_random_uuid()::text, transaction_id text NOT NULL,
   kind text NOT NULL, scope_json text NOT NULL CHECK(json_valid(scope_json)), captured_at bigint NOT NULL
 );
 CREATE INDEX restore_transaction_facts_tx ON lovelies_private.restore_transaction_facts(transaction_id,id);
 CREATE TABLE lovelies_private.restore_recovery_runs(
   id text PRIMARY KEY, database_id text NOT NULL, prior_incarnation_id text NOT NULL, incarnation_id text NOT NULL,
   generation_hash text NOT NULL CHECK(generation_hash ~ '^[0-9a-f]{64}$'),
   restriction_sequence bigint NOT NULL CHECK(restriction_sequence>=0), restriction_hash text NOT NULL CHECK(restriction_hash ~ '^[0-9a-f]{64}$'),
   replayed_sequence bigint NOT NULL DEFAULT 0 CHECK(replayed_sequence>=0), replayed_hash text NOT NULL DEFAULT repeat('0',64),
   state text NOT NULL CHECK(state IN('replaying','cleanup','prepared','complete')),
   retired_at bigint, clearance_json text CHECK(clearance_json IS NULL OR json_valid(clearance_json)), created_at bigint NOT NULL, updated_at bigint NOT NULL
 );
 CREATE TABLE lovelies_private.restore_replay_facts(
   sequence bigint PRIMARY KEY CHECK(sequence>0), hash text NOT NULL CHECK(hash ~ '^[0-9a-f]{64}$'),
   operation_id text NOT NULL, kind text NOT NULL, scope_json text NOT NULL CHECK(json_valid(scope_json)), applied_at bigint NOT NULL
 );
 CREATE TABLE lovelies_private.restore_recovered_operations(
   operation_id text PRIMARY KEY, input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'), plan_hash text NOT NULL CHECK(plan_hash ~ '^[0-9a-f]{64}$'),
   outcome text NOT NULL CHECK(outcome IN('restricted-abort','restore-retired')), recovered_at bigint NOT NULL
 );
 CREATE TABLE lovelies_private.restore_cleanup_objects(
   recovery_id text NOT NULL REFERENCES lovelies_private.restore_recovery_runs(id), effect_id text NOT NULL,
   bucket text NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE','PRIVACY_EXPORTS')), object_key text NOT NULL,
   expected_sha256 text NOT NULL CHECK(expected_sha256 ~ '^[0-9a-f]{64}$'), expected_bytes bigint NOT NULL CHECK(expected_bytes>=0),
   status text NOT NULL CHECK(status IN('pending','absent','preserved','blocked')), proof_json text CHECK(proof_json IS NULL OR json_valid(proof_json)),
   updated_at bigint NOT NULL, PRIMARY KEY(recovery_id,effect_id)
 );
 ALTER TABLE lovelies_private.blocks ADD COLUMN episode_id text NOT NULL DEFAULT gen_random_uuid()::text;
 CREATE UNIQUE INDEX blocks_episode_id ON lovelies_private.blocks(episode_id);
 ALTER TABLE lovelies_private.retention_settings ADD COLUMN restore_hold_episode_id text;
 ALTER TABLE lovelies_private.asset_retention ADD COLUMN restore_hold_episode_id text;
 ALTER TABLE lovelies_private.privacy_requests ADD COLUMN restore_hold_episode_id text;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 UPDATE lovelies_private.retention_settings SET restore_hold_episode_id=gen_random_uuid()::text WHERE legal_hold=1;
 UPDATE lovelies_private.asset_retention SET restore_hold_episode_id=gen_random_uuid()::text WHERE legal_hold=1;
 UPDATE lovelies_private.privacy_requests SET restore_hold_episode_id=gen_random_uuid()::text WHERE legal_hold=1;
 EXECUTE format('SET LOCAL ROLE %I',migrator);
 EXECUTE $function$
 CREATE FUNCTION lovelies_private.mark_restore_hold_episode() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=lovelies_private,pg_catalog AS $episode$
 BEGIN
   IF current_setting('lovelies.restore_replay',true)='on' THEN RETURN NEW; END IF;
   IF NEW.legal_hold=1 THEN
     IF TG_OP='UPDATE' AND OLD.legal_hold=1 THEN NEW.restore_hold_episode_id:=OLD.restore_hold_episode_id;
     ELSE NEW.restore_hold_episode_id:=gen_random_uuid()::text; END IF;
   ELSE NEW.restore_hold_episode_id:=NULL; END IF;
   RETURN NEW;
 END $episode$
 $function$;
 REVOKE ALL ON FUNCTION lovelies_private.mark_restore_hold_episode() FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION lovelies_private.mark_restore_hold_episode() TO lovelies_api;
 FOREACH tab IN ARRAY ARRAY['retention_settings','asset_retention','privacy_requests'] LOOP
   EXECUTE format('CREATE TRIGGER mark_restore_hold_episode BEFORE INSERT OR UPDATE ON lovelies_private.%I FOR EACH ROW EXECUTE FUNCTION lovelies_private.mark_restore_hold_episode()',tab);
 END LOOP;

 ALTER TABLE lovelies_private.media_write_intents ADD COLUMN restore_protocol_version bigint NOT NULL DEFAULT 1 CHECK(restore_protocol_version IN(1,2));
 ALTER TABLE lovelies_private.media_write_intents ADD COLUMN restore_incarnation_id text;
 EXECUTE $function$
 CREATE FUNCTION lovelies_private.mark_restore_writer() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=lovelies_private,pg_catalog AS $writer$
 BEGIN
   IF current_setting('lovelies.restore_replay',true) IS DISTINCT FROM 'on' AND current_setting('lovelies.writer_protocol',true) IS DISTINCT FROM '2'
      AND EXISTS(SELECT 1 FROM restore_control WHERE singleton=1) THEN
     RAISE EXCEPTION 'restore_writer_fence_required' USING ERRCODE='55000';
   END IF;
   NEW.restore_protocol_version:=CASE WHEN current_setting('lovelies.writer_protocol',true)='2' THEN 2 ELSE 1 END;
   IF NEW.restore_protocol_version=2 THEN SELECT incarnation_id INTO NEW.restore_incarnation_id FROM restore_control WHERE singleton=1;
   ELSE NEW.restore_incarnation_id:=NULL; END IF;
   RETURN NEW;
 END $writer$
 $function$;
 REVOKE ALL ON FUNCTION lovelies_private.mark_restore_writer() FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION lovelies_private.mark_restore_writer() TO lovelies_api;
 CREATE TRIGGER mark_restore_writer BEFORE INSERT ON lovelies_private.media_write_intents FOR EACH ROW EXECUTE FUNCTION lovelies_private.mark_restore_writer();

 FOREACH tab IN ARRAY ARRAY['restore_transaction_facts','restore_recovery_runs','restore_replay_facts','restore_recovered_operations','restore_cleanup_objects'] LOOP
   EXECUTE format('ALTER TABLE lovelies_private.%I ENABLE ROW LEVEL SECURITY',tab);
   EXECUTE format('ALTER TABLE lovelies_private.%I FORCE ROW LEVEL SECURITY',tab);
   EXECUTE format('CREATE POLICY backend_only ON lovelies_private.%I TO lovelies_api USING(true) WITH CHECK(true)',tab);
   EXECUTE format('REVOKE ALL ON lovelies_private.%I FROM PUBLIC,anon,authenticated',tab);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON lovelies_private.%I TO lovelies_api',tab);
 END LOOP;
 -- The same SQL transaction captures exact OLD episodes before its independent
 -- prepare. No trigger on recovery/control tables and no callback replay.
 EXECUTE $function$
 CREATE FUNCTION lovelies_private.capture_restore_restriction() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=lovelies_private,pg_catalog AS $capture$
 DECLARE oldrow jsonb; newrow jsonb; fact jsonb; kind text; tick bigint;
 BEGIN
   IF current_setting('lovelies.restore_replay',true)='on' THEN RETURN NULL; END IF;
   IF current_setting('lovelies.writer_protocol',true) IS DISTINCT FROM '2' THEN
     -- Unbound local setup does not manufacture an indefinitely growing queue.
     -- Once a binding exists, an old application writer must fail atomically;
     -- only the explicit privileged restore controller may bypass capture.
     IF EXISTS(SELECT 1 FROM restore_control WHERE singleton=1) THEN
       RAISE EXCEPTION 'restore_writer_fence_required' USING ERRCODE='55000';
     END IF;
     RETURN NULL;
   END IF;
   oldrow:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
   newrow:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
   tick:=(extract(epoch FROM clock_timestamp())*1000)::bigint;
   IF TG_TABLE_NAME='consents' AND oldrow->>'status'='granted' AND
      (newrow IS NULL OR newrow->>'status'<>'granted' OR newrow->>'id'<>oldrow->>'id') THEN
     kind:='consent-withdrawn'; fact:=jsonb_build_object('account_id',oldrow->>'account_id','consent_id',oldrow->>'id','purpose',oldrow->>'purpose');
   ELSIF TG_TABLE_NAME='face_profiles' AND oldrow->>'status'='active' AND
      (newrow IS NULL OR newrow->>'status'<>'active' OR newrow->>'revision'<>oldrow->>'revision') THEN
     kind:='profile-retired'; fact:=jsonb_build_object('account_id',oldrow->>'account_id','profile_id',oldrow->>'id','profile_revision',oldrow->>'revision');
   ELSIF TG_TABLE_NAME='sessions' AND oldrow->>'revoked_at' IS NULL AND
      (newrow IS NULL OR newrow->>'revoked_at' IS NOT NULL OR newrow->>'refresh_consumed_at' IS NOT NULL AND oldrow->>'refresh_consumed_at' IS NULL) THEN
     kind:='session-retired'; fact:=jsonb_build_object('account_id',oldrow->>'account_id','session_id',oldrow->>'id');
   ELSIF TG_TABLE_NAME='auth_devices' AND oldrow->>'status' IN('pending','active') AND
      (newrow IS NULL OR newrow->>'status' NOT IN('pending','active') OR newrow->>'revision'<>oldrow->>'revision') THEN
     kind:='device-retired'; fact:=jsonb_build_object('account_id',oldrow->>'account_id','device_id',oldrow->>'id','device_revision',oldrow->>'revision');
   ELSIF TG_TABLE_NAME='guardian_purpose_approvals' AND oldrow->>'status'='approved' AND
      (newrow IS NULL OR newrow->>'status'<>'approved') THEN
     kind:='guardian-approval-retired'; fact:=jsonb_build_object('child_account_id',oldrow->>'child_account_id','guardian_request_id',oldrow->>'request_id','guardian_approval_id',oldrow->>'id','purpose',oldrow->>'purpose');
   ELSIF TG_TABLE_NAME='sharing_requests' AND oldrow->>'status' IN('requested','accepted') AND
      (newrow IS NULL OR newrow->>'status' NOT IN('requested','accepted')) THEN
     kind:='sharing-request-retired'; fact:=jsonb_build_object('sender_id',oldrow->>'sender_id','recipient_id',oldrow->>'recipient_id','request_id',oldrow->>'id');
   ELSIF TG_TABLE_NAME='assets' AND oldrow->>'deleted_at' IS NULL AND
      (newrow IS NULL OR newrow->>'deleted_at' IS NOT NULL OR newrow->>'version'<>oldrow->>'version') THEN
     kind:='asset-retired'; fact:=jsonb_build_object('owner_id',oldrow->>'owner_id','asset_id',oldrow->>'id','asset_version',oldrow->>'version');
   ELSIF TG_TABLE_NAME='media_grants' AND oldrow->>'active'='1' AND (newrow IS NULL OR newrow->>'active'<>'1') THEN
     kind:='media-grant-retired'; fact:=jsonb_build_object('owner_id',oldrow->>'owner_id','recipient_id',oldrow->>'recipient_id','grant_id',oldrow->>'id','request_id',oldrow->>'request_id','asset_id',oldrow->>'asset_id');
   ELSIF TG_TABLE_NAME='store_subscriptions' AND oldrow->>'active'='1' AND
      (newrow IS NULL OR newrow->>'active'<>'1' OR newrow->>'acknowledged'<>'1' OR newrow->>'version'<>oldrow->>'version') THEN
     kind:='store-entitlement-retired'; fact:=jsonb_build_object('account_id',oldrow->>'account_id','subscription_id',oldrow->>'id','subscription_version',oldrow->>'version');
   ELSIF TG_TABLE_NAME='privacy_export_grants' AND oldrow IS NOT NULL AND oldrow->>'consumed_at' IS NULL AND
      (newrow IS NULL OR newrow->>'consumed_at' IS NOT NULL) THEN
     kind:='privacy-export-grant-retired'; fact:=jsonb_build_object('account_id',oldrow->>'subject_id','grant_id',oldrow->>'id','request_id',oldrow->>'request_id','session_id',oldrow->>'session_id');
   ELSIF TG_TABLE_NAME='privacy_exports' AND oldrow->>'status'='published' AND
      (newrow IS NULL OR newrow->>'status'<>'published' OR newrow->>'object_key'<>oldrow->>'object_key' OR newrow->>'sha256'<>oldrow->>'sha256') THEN
     kind:='privacy-export-publication-retired'; fact:=jsonb_build_object('account_id',oldrow->>'subject_id','publication_id',oldrow->>'id','request_id',oldrow->>'request_id');
   ELSIF TG_TABLE_NAME='guardian_requests' AND oldrow->>'state' IN('pending','under_review','approved') AND
      (newrow IS NULL OR newrow->>'state' IN('withdrawn','expired','rejected')) THEN
     kind:='guardian-request-retired'; fact:=jsonb_build_object('child_account_id',oldrow->>'child_account_id','guardian_request_id',oldrow->>'id','request_revision',oldrow->>'revision','terminal_state',coalesce(newrow->>'state','withdrawn'));
   ELSIF TG_TABLE_NAME='blocks' AND TG_OP='INSERT' THEN
     kind:='pair-blocked'; fact:=jsonb_build_object('blocker_id',newrow->>'blocker_id','blocked_id',newrow->>'blocked_id','block_operation_id',newrow->>'episode_id');
   ELSIF TG_TABLE_NAME='blocks' AND TG_OP='DELETE' THEN
     kind:='pair-block-ended'; fact:=jsonb_build_object('blocker_id',oldrow->>'blocker_id','blocked_id',oldrow->>'blocked_id','block_operation_id',oldrow->>'episode_id');
   ELSIF TG_TABLE_NAME='push_devices' AND oldrow->>'active'='1' AND
      (newrow IS NULL OR newrow->>'active'<>'1' OR newrow->>'token_hash'<>oldrow->>'token_hash' OR newrow->>'account_id'<>oldrow->>'account_id') THEN
     kind:='push-device-retired'; fact:=jsonb_build_object('account_id',oldrow->>'account_id','device_id',oldrow->>'id','token_hash',oldrow->>'token_hash');
   ELSIF TG_TABLE_NAME='candidates' AND oldrow->>'status' IN('eligible','needs_review') AND
      (newrow IS NULL OR newrow->>'status'<>oldrow->>'status' OR newrow->>'version'<>oldrow->>'version') THEN
     kind:='candidate-retired'; fact:=jsonb_build_object('owner_id',oldrow->>'owner_id','recipient_id',oldrow->>'recipient_id','candidate_id',oldrow->>'id','candidate_version',oldrow->>'version');
   ELSIF TG_TABLE_NAME='moderation_holds' AND newrow->>'active'='1' AND coalesce(oldrow->>'active','0')<>'1' THEN
     IF newrow->>'subject_id' IS NOT NULL THEN
       kind:='account-moderation-restricted'; fact:=jsonb_build_object('account_id',newrow->>'subject_id','hold_id',newrow->>'id');
     ELSE
       kind:='asset-moderation-restricted'; fact:=jsonb_build_object('owner_id',(SELECT owner_id FROM assets WHERE id=newrow->>'asset_id'),'asset_id',newrow->>'asset_id','hold_id',newrow->>'id');
     END IF;
   ELSIF TG_TABLE_NAME='moderation_holds' AND oldrow->>'active'='1' AND (newrow IS NULL OR newrow->>'active'<>'1') THEN
     kind:='moderation-restriction-ended'; fact:=jsonb_build_object('hold_id',oldrow->>'id');
   ELSIF TG_TABLE_NAME IN('retention_settings','asset_retention','privacy_requests') AND
      (newrow->>'legal_hold'='1' AND coalesce(oldrow->>'legal_hold','0')<>'1' OR oldrow->>'legal_hold'='1' AND coalesce(newrow->>'legal_hold','0')<>'1') THEN
     IF TG_TABLE_NAME='retention_settings' THEN
       kind:=CASE WHEN newrow->>'legal_hold'='1' THEN 'global-retention-hold-started' ELSE 'global-retention-hold-ended' END;
       fact:=jsonb_build_object('hold_id',CASE WHEN newrow->>'legal_hold'='1' THEN newrow->>'restore_hold_episode_id' ELSE oldrow->>'restore_hold_episode_id' END);
     ELSIF TG_TABLE_NAME='asset_retention' THEN
       kind:=CASE WHEN newrow->>'legal_hold'='1' THEN 'asset-retention-hold-started' ELSE 'asset-retention-hold-ended' END;
       fact:=jsonb_build_object('owner_id',(SELECT owner_id FROM assets WHERE id=coalesce(newrow->>'asset_id',oldrow->>'asset_id')),'asset_id',coalesce(newrow->>'asset_id',oldrow->>'asset_id'),
         'hold_id',CASE WHEN newrow->>'legal_hold'='1' THEN newrow->>'restore_hold_episode_id' ELSE oldrow->>'restore_hold_episode_id' END);
       IF fact->>'owner_id' IS NULL THEN RETURN NULL; END IF;
     ELSE
       kind:=CASE WHEN newrow->>'legal_hold'='1' THEN 'privacy-hold-started' ELSE 'privacy-hold-ended' END;
       fact:=jsonb_build_object('account_id',coalesce(newrow->>'subject_id',oldrow->>'subject_id'),'request_id',coalesce(newrow->>'id',oldrow->>'id'),
         'hold_id',CASE WHEN newrow->>'legal_hold'='1' THEN newrow->>'restore_hold_episode_id' ELSE oldrow->>'restore_hold_episode_id' END);
     END IF;
   ELSIF TG_TABLE_NAME='operator_capability_grants' AND oldrow->>'revoked_at' IS NULL AND
      (newrow IS NULL OR newrow->>'revoked_at' IS NOT NULL) THEN
     kind:='operator-capability-retired'; fact:=jsonb_build_object('account_id',oldrow->>'account_id','grant_id',oldrow->>'id','capability',oldrow->>'capability');
   ELSIF TG_TABLE_NAME='accounts' AND oldrow->>'disabled_at' IS NULL AND newrow->>'disabled_at' IS NOT NULL THEN
     kind:='account-authority-retired'; fact:=jsonb_build_object('account_id',oldrow->>'id','auth_epoch',oldrow->>'auth_epoch');
   END IF;
   IF kind IS NOT NULL THEN
     INSERT INTO restore_transaction_facts(transaction_id,kind,scope_json,captured_at) VALUES(txid_current()::text,kind,fact::text,tick);
   END IF;
   IF TG_TABLE_NAME='notification_settings' AND TG_OP='UPDATE' THEN
     FOREACH kind IN ARRAY ARRAY['match_alerts','payment_alerts','support_alerts'] LOOP
       IF oldrow->>kind='1' AND newrow->>kind='0' THEN
         fact:=jsonb_build_object('account_id',oldrow->>'account_id','setting',kind,'updated_at',oldrow->>'updated_at');
         INSERT INTO restore_transaction_facts(transaction_id,kind,scope_json,captured_at) VALUES(txid_current()::text,'notification-setting-retired',fact::text,tick);
       END IF;
     END LOOP;
   END IF;
   RETURN NULL;
 END $capture$
 $function$;
 REVOKE ALL ON FUNCTION lovelies_private.capture_restore_restriction() FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION lovelies_private.capture_restore_restriction() TO lovelies_api;
 FOREACH tab IN ARRAY ARRAY['accounts','consents','face_profiles','sessions','auth_devices','guardian_requests','guardian_purpose_approvals','sharing_requests','assets','media_grants','blocks','push_devices','candidates','moderation_holds','notification_settings','retention_settings','asset_retention','privacy_requests','store_subscriptions','privacy_export_grants','privacy_exports'] LOOP
   EXECUTE format('CREATE TRIGGER capture_restore_restriction AFTER INSERT OR UPDATE OR DELETE ON lovelies_private.%I FOR EACH ROW EXECUTE FUNCTION lovelies_private.capture_restore_restriction()',tab);
 END LOOP;
 EXECUTE 'SET LOCAL ROLE lovelies_api';
 INSERT INTO lovelies_private.schema_versions(version,applied_at) VALUES(15,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 EXECUTE format('SET LOCAL ROLE %I',migrator);
END $restore_recovery$;
RESET search_path;
