-- Operator bootstrap for this self-hosted database, executed as supabase_admin.
-- The installer first stores the bearer in Vault. No credential belongs here.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;
CREATE SCHEMA IF NOT EXISTS lovelies_deployment;
REVOKE ALL ON SCHEMA lovelies_deployment FROM PUBLIC,anon,authenticated,service_role,lovelies_api;

-- On managed Supabase these grants are platform-owned. This local deployment
-- executes as the real owner and verifies the resulting ACLs on the live host.
REVOKE ALL ON SCHEMA net FROM PUBLIC,anon,authenticated,service_role,lovelies_api;
REVOKE ALL ON ALL TABLES IN SCHEMA net FROM PUBLIC,anon,authenticated,service_role,lovelies_api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA net FROM PUBLIC,anon,authenticated,service_role,lovelies_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC,anon,authenticated,service_role,lovelies_api;
GRANT USAGE ON SCHEMA net TO postgres,supabase_admin;
GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres,supabase_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO postgres,supabase_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO postgres,supabase_admin;
REVOKE ALL ON SCHEMA vault FROM PUBLIC,anon,authenticated,service_role,lovelies_api;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC,anon,authenticated,service_role,lovelies_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM PUBLIC,anon,authenticated,service_role,lovelies_api;

CREATE OR REPLACE FUNCTION lovelies_deployment.schedule_maintenance_request()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE bearer text;
BEGIN
 SELECT decrypted_secret INTO STRICT bearer FROM vault.decrypted_secrets WHERE name='lovelies_internal_maintenance';
 IF length(bearer)<32 THEN RAISE EXCEPTION 'maintenance_secret_unavailable'; END IF;
 RETURN net.http_post(
  url:='http://api-gw:8000/functions/v1/lovelies-api/_internal/maintenance',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||bearer),
  body:='{}'::jsonb,timeout_milliseconds:=30000);
END $function$;
REVOKE ALL ON FUNCTION lovelies_deployment.schedule_maintenance_request() FROM PUBLIC,anon,authenticated,service_role,lovelies_api;
GRANT USAGE ON SCHEMA lovelies_deployment TO postgres;
GRANT EXECUTE ON FUNCTION lovelies_deployment.schedule_maintenance_request() TO postgres;
SELECT cron.schedule('lovelies-private-maintenance','* * * * *','SELECT lovelies_deployment.schedule_maintenance_request()');

DO $verify$
BEGIN
 IF has_table_privilege('lovelies_api','net.http_request_queue','SELECT')
 OR has_table_privilege('lovelies_api','vault.decrypted_secrets','SELECT')
 OR has_function_privilege('lovelies_api','lovelies_deployment.schedule_maintenance_request()','EXECUTE')
 THEN RAISE EXCEPTION 'maintenance_privilege_boundary_failed'; END IF;
END $verify$;
