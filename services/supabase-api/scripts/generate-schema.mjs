import fs from 'node:fs';
import path from 'node:path';
import {schemaStatements,extensionSchemaStatements,currentSchemaVersion} from '../src/schema.ts';
const project=path.resolve(import.meta.dirname,'../../..');
if(currentSchemaVersion!==7)throw new Error('The reviewed v7 baseline is frozen; use additive migrations for later schema versions.');
const files=fs.readdirSync(path.join(project,'supabase/migrations')).filter(x=>/_lovelies_private_core\.sql$/.test(x));
if(files.length!==1)throw new Error('First create exactly one lovelies_private_core migration with the Supabase CLI');
const prefix=`-- Fresh Lovelies Supabase authority. No Memories account/media data is imported.
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
  SELECT CASE WHEN path ~ '^\\$\\.[a-z_]+$' THEN input::jsonb->>substring(path from 3)
    WHEN path ~ '^\\$\\[[0-9]+\\]$' THEN input::jsonb->>(substring(path from 3 for length(path)-3)::integer)
    ELSE NULL END
$f$;
CREATE FUNCTION instr(input text,needle text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path=pg_catalog AS $f$ SELECT strpos(input,needle) $f$;
`;
const statements=[...schemaStatements,...extensionSchemaStatements];
const tables=statements.filter(x=>/^CREATE TABLE/.test(x)).map(x=>x.replace(/IF NOT EXISTS /g,'').replace(/\bINTEGER\b/g,'BIGINT'));
tables.push(`CREATE TABLE job_queue(id text PRIMARY KEY,category text NOT NULL CHECK(category IN('photo','privacy','notification')),payload_json text NOT NULL CHECK(json_valid(payload_json)),state text NOT NULL CHECK(state IN('pending','processing','completed','failed')),available_at bigint NOT NULL,created_at bigint NOT NULL,attempts bigint NOT NULL DEFAULT 0,lease_token text,lease_until bigint,completed_at bigint,error_code text)`);
const names=new Set(),ordered=[];let remaining=[...tables];
while(remaining.length){let progress=false;remaining=remaining.filter(sql=>{
 const name=/^CREATE TABLE ([a-z_]+)/.exec(sql)[1];const refs=[...sql.matchAll(/REFERENCES ([a-z_]+)\(/g)].map(x=>x[1]);
 if(refs.some(x=>x!==name&&!names.has(x)))return true;
 if(names.has(name))throw new Error('Duplicate logical table '+name);names.add(name);ordered.push(sql+';');progress=true;return false;
});if(!progress)throw new Error('Cyclic or missing table references: '+remaining.map(x=>/^CREATE TABLE ([a-z_]+)/.exec(x)[1]).join(','));}
const indexes=statements.filter(x=>/^CREATE (?:UNIQUE )?INDEX/.test(x)).map(x=>x.replace(/IF NOT EXISTS /g,'')+';');
indexes.push('CREATE INDEX job_queue_due ON job_queue(state,available_at);');
const triggers=statements.filter(x=>/^CREATE TRIGGER/.test(x)).map(sql=>{
 const match=/CREATE TRIGGER IF NOT EXISTS ([a-z_]+) BEFORE UPDATE ON ([a-z_]+)([\s\S]*?)BEGIN SELECT RAISE\(ABORT,'([^']+)'\); END/.exec(sql);
 if(!match)throw new Error('Unsupported trigger definition');
 const [,name,table,when,error]=match,condition=when.trim().replace(/^WHEN\s+/,'').replace(/\bIS NOT OLD\./g,'IS DISTINCT FROM OLD.');
 return `CREATE FUNCTION guard_${name}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=lovelies_private,pg_catalog AS $f$ BEGIN
  ${condition?'IF '+condition+' THEN ':''}RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='${error}';${condition?' END IF;':''}
  RETURN NEW;
END $f$;
CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION guard_${name}();`;
});
const security=[...names].map(name=>`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON ${name} TO lovelies_api USING(true) WITH CHECK(true);`).join('\n');
const suffix=`
-- Seed schema metadata while the migration owner still has ordinary table-owner
-- authority. FORCE RLS below also applies to an owner without BYPASSRLS.
INSERT INTO schema_versions(version,applied_at) VALUES(${currentSchemaVersion},(extract(epoch FROM clock_timestamp())*1000)::bigint);
${security}
REVOKE ALL ON ALL TABLES IN SCHEMA lovelies_private FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA lovelies_private TO lovelies_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lovelies_private FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lovelies_private TO lovelies_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET search_path;
`;
const target=path.join(project,'supabase/migrations',files[0]);
fs.writeFileSync(target,[prefix,...ordered,...indexes,...triggers,suffix].join('\n\n')+'\n');
console.log(`Generated ${names.size} tables, ${indexes.length} indexes, ${triggers.length} immutability triggers in ${target}`);
