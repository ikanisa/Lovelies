-- Targeted least-privilege correction for the existing function inspected in
-- project ltqfplqevxztlswlzexn on 2026-10-23. This is not an app-schema migration.
-- Preserve the function definition, owner, event trigger and backend grants.
BEGIN;
DO $guard$
DECLARE target oid := to_regprocedure('public.rls_auto_enable()');
BEGIN
  IF target IS NULL OR NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=target
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.prorettype='event_trigger'::regtype
    AND md5(pg_get_functiondef(p.oid))='846ec2fbff751d24b890656d63c3a9bf') OR
    (SELECT count(*) FROM pg_event_trigger WHERE evtfoid=target AND evtenabled<>'D')<>1 THEN
    RAISE EXCEPTION 'event_trigger_preimage_changed';
  END IF;
END $guard$;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
DO $verify$
DECLARE target oid := to_regprocedure('public.rls_auto_enable()');
BEGIN
  IF has_function_privilege('anon',target,'EXECUTE') OR
     has_function_privilege('authenticated',target,'EXECUTE') OR
     NOT has_function_privilege('service_role',target,'EXECUTE') OR
     md5(pg_get_functiondef(target))<>'846ec2fbff751d24b890656d63c3a9bf' OR
     (SELECT count(*) FROM pg_event_trigger WHERE evtfoid=target AND evtenabled<>'D')<>1 THEN
    RAISE EXCEPTION 'event_trigger_privilege_verification_failed';
  END IF;
END $verify$;
COMMIT;
