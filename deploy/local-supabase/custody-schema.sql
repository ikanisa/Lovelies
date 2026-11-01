-- Run only in the independent local Supabase custody database, never the app DB.
-- Runtime roles receive no CREATE, DROP, DELETE, TRUNCATE or role-management rights.
BEGIN;
DO $$ BEGIN CREATE ROLE lovelies_journal NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE lovelies_push NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN('lovelies_journal','lovelies_push') AND (rolinherit OR rolbypassrls OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN RAISE EXCEPTION 'existing_custody_role_requires_review'; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS restore_journal;
CREATE SCHEMA IF NOT EXISTS push_receipts;
REVOKE ALL ON SCHEMA restore_journal,push_receipts FROM PUBLIC;
GRANT USAGE ON SCHEMA restore_journal TO lovelies_journal;
GRANT USAGE ON SCHEMA push_receipts TO lovelies_push;

CREATE TABLE IF NOT EXISTS restore_journal.schema_version(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=1));
CREATE TABLE IF NOT EXISTS push_receipts.schema_version(LIKE restore_journal.schema_version INCLUDING ALL);
INSERT INTO restore_journal.schema_version VALUES(true,1) ON CONFLICT(singleton) DO NOTHING;
INSERT INTO push_receipts.schema_version VALUES(true,1) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS restore_journal.kv(key text COLLATE "C" PRIMARY KEY CHECK(octet_length(key) BETWEEN 1 AND 768),value jsonb NOT NULL CHECK(octet_length(value::text)<=2097152));
CREATE TABLE IF NOT EXISTS push_receipts.kv(LIKE restore_journal.kv INCLUDING ALL);
CREATE TABLE IF NOT EXISTS restore_journal.protocol_activation(protocol text PRIMARY KEY,activated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS push_receipts.protocol_activation(LIKE restore_journal.protocol_activation INCLUDING ALL);

CREATE OR REPLACE FUNCTION restore_journal.protect_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'custody_history_is_append_only' USING ERRCODE='55000'; END IF;
  IF OLD.key ~ '^(event:|operation:|binding:|plan:|prepare:|commit:|reconciliation:|recovery:[0-9a-f-]{36}$|recovery:v2:completion:|recovery:v2:operation-outcome:|effect:v1:sequence:|effect:v1:observation:|manifest:v2:chunk:)' AND NEW.value IS DISTINCT FROM OLD.value THEN
    RAISE EXCEPTION 'custody_fact_is_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS journal_history_immutable ON restore_journal.kv;
CREATE TRIGGER journal_history_immutable BEFORE UPDATE OR DELETE ON restore_journal.kv FOR EACH ROW EXECUTE FUNCTION restore_journal.protect_history();
CREATE OR REPLACE FUNCTION push_receipts.reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'custody_receipt_is_immutable' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION restore_journal.protect_history(),push_receipts.reject_mutation() FROM PUBLIC;

CREATE TABLE IF NOT EXISTS push_receipts.push_dispatch_admissions_v1(operation_key text PRIMARY KEY,request_sha256 text NOT NULL,provider_request_id text NOT NULL UNIQUE,created_at bigint NOT NULL CHECK(created_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_dispatch_intents_v1(operation_key text PRIMARY KEY REFERENCES push_receipts.push_dispatch_admissions_v1(operation_key),provider_request_id text NOT NULL UNIQUE,dispatched_at bigint NOT NULL CHECK(dispatched_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_plans_v2(notification_id text PRIMARY KEY,subject_sha256 text NOT NULL,provider_generation text NOT NULL,plan_sha256 text NOT NULL UNIQUE,plan_json text NOT NULL,created_at bigint NOT NULL CHECK(created_at>0));
CREATE INDEX IF NOT EXISTS push_roster_subject_v2 ON push_receipts.push_roster_plans_v2(subject_sha256,notification_id);
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_entries_v2(operation_key text PRIMARY KEY,notification_id text NOT NULL REFERENCES push_receipts.push_roster_plans_v2(notification_id),ordinal integer NOT NULL CHECK(ordinal>=0),entry_sha256 text NOT NULL,provider_request_id text NOT NULL UNIQUE,UNIQUE(notification_id,ordinal));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_claims_v2(operation_key text PRIMARY KEY REFERENCES push_receipts.push_roster_entries_v2(operation_key),claim_id text,lease_until bigint NOT NULL CHECK(lease_until>=0),provider_code text,updated_at bigint NOT NULL CHECK(updated_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_intents_v2(operation_key text PRIMARY KEY REFERENCES push_receipts.push_roster_entries_v2(operation_key),provider_request_id text NOT NULL UNIQUE,dispatched_at bigint NOT NULL CHECK(dispatched_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_outcomes_v2(operation_key text PRIMARY KEY REFERENCES push_receipts.push_roster_intents_v2(operation_key),status text NOT NULL CHECK(status IN('accepted','rejected')),provider_message_id text,provider_code text,retryable integer NOT NULL CHECK(retryable IN(0,1)),token_invalid integer NOT NULL CHECK(token_invalid IN(0,1)),observed_at bigint NOT NULL CHECK(observed_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_subject_retirements_v2(subject_sha256 text PRIMARY KEY,created_at bigint NOT NULL CHECK(created_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_plan_retirements_v2(notification_id text PRIMARY KEY,created_at bigint NOT NULL CHECK(created_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_generations_v2(provider_generation text PRIMARY KEY,ordinal bigint NOT NULL UNIQUE CHECK(ordinal>0),created_at bigint NOT NULL CHECK(created_at>0));
CREATE TABLE IF NOT EXISTS push_receipts.push_roster_generation_retirements_v2(provider_generation text PRIMARY KEY REFERENCES push_receipts.push_roster_generations_v2(provider_generation),created_at bigint NOT NULL CHECK(created_at>0));
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['protocol_activation','push_dispatch_admissions_v1','push_dispatch_intents_v1','push_roster_plans_v2','push_roster_entries_v2','push_roster_intents_v2','push_roster_outcomes_v2','push_roster_subject_retirements_v2','push_roster_plan_retirements_v2','push_roster_generations_v2','push_roster_generation_retirements_v2'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS immutable_receipt ON push_receipts.%I',name);
    EXECUTE format('CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON push_receipts.%I FOR EACH ROW EXECUTE FUNCTION push_receipts.reject_mutation()',name);
  END LOOP;
END $$;

-- Neither schema is exposed in PostgREST. RLS also denies access unless the
-- caller is a member of its dedicated server role; application roles get no grant.
DO $$ DECLARE row record; role_name text; BEGIN
  FOR row IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('restore_journal','push_receipts') LOOP
    role_name:=CASE row.schemaname WHEN 'restore_journal' THEN 'lovelies_journal' ELSE 'lovelies_push' END;
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',row.schemaname,row.tablename);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',row.schemaname,row.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',row.schemaname,row.tablename);
    EXECUTE format('DROP POLICY IF EXISTS custody_service ON %I.%I',row.schemaname,row.tablename);
    EXECUTE format('CREATE POLICY custody_service ON %I.%I TO %I USING(true) WITH CHECK(true)',row.schemaname,row.tablename,role_name);
    EXECUTE format('GRANT SELECT ON %I.%I TO %I',row.schemaname,row.tablename,role_name);
  END LOOP;
END $$;
GRANT INSERT,UPDATE ON restore_journal.kv TO lovelies_journal;
GRANT INSERT,UPDATE ON push_receipts.kv,push_receipts.push_roster_claims_v2 TO lovelies_push;
GRANT INSERT ON push_receipts.protocol_activation,push_receipts.push_dispatch_admissions_v1,push_receipts.push_dispatch_intents_v1,
  push_receipts.push_roster_plans_v2,push_receipts.push_roster_entries_v2,push_receipts.push_roster_intents_v2,push_receipts.push_roster_outcomes_v2,
  push_receipts.push_roster_subject_retirements_v2,push_receipts.push_roster_plan_retirements_v2,push_receipts.push_roster_generations_v2,push_receipts.push_roster_generation_retirements_v2 TO lovelies_push;
COMMIT;
