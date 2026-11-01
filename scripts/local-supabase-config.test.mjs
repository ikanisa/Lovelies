import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {generateConfiguration,envText,parseEnv} from './local-supabase-configure.mjs';
import {validateValues} from './local-supabase-check.mjs';
import {encryptStream,decryptStream} from './local-supabase-backup.mjs';

const fixture=()=>generateConfiguration({host:'api.example.test',email:'operator@example.test',runtimeDirectory:'/tmp/lovelies-private-test',publicSiteRoot:'/tmp/lovelies-public-test/public',uid:1000,gid:1000});
test('generated service credentials bind exact private/public authorities and preserve the NOLOGIN role boundary',()=>{
 const value=fixture();assert.deepEqual(validateValues(value).errors,[]);
 assert.equal(new URL(value.api.LOVELIES_DATABASE_URL).username,'lovelies_runtime');
 assert.equal(value.app.API_EXTERNAL_URL,value.config.public_supabase_url+'/auth/v1');
 assert.equal(value.api.PUBLIC_API_BASE_URL,value.config.public_supabase_url+'/functions/v1/lovelies-api');
 assert.equal(value.ml.ML_INFERENCE_SECRET,value.api.ML_INFERENCE_SECRET);
 assert.equal(value.push.PUSH_PROVIDER_SEND_ENABLED,'false');
 assert.notEqual(value.api.MANAGED_AUTH_ENCRYPTION_KEY,value.api.AUTH_SIGNING_SECRET);
 assert.throws(()=>generateConfiguration({host:'oldproject.supabase.co',email:'operator@example.test',runtimeDirectory:'/tmp/new',publicSiteRoot:'/tmp/public'}));
});
test('hosted fallback, token aliasing, incorrect JWT role, and application-held bootstrap authority are rejected',()=>{
 for(const [change,expected] of [
  [value=>{value.api.INTERNAL_SUPABASE_URL='https://old.supabase.co';},'internal_gateway_mismatch'],
  [value=>{value.api.AUTH_SIGNING_SECRET=value.api.MEDIA_SIGNING_SECRET;},'secret_strength_or_separation_invalid'],
  [value=>{value.app.ANON_KEY=value.app.SERVICE_ROLE_KEY;},'supabase_anon_key_invalid_or_expiring'],
  [value=>{value.api.RESTORE_JOURNAL_BOOTSTRAP_TOKEN=value.custody.RESTORE_JOURNAL_BOOTSTRAP_TOKEN;},'operator_secret_exposed_to_api'],
 ]){const value=fixture();change(value);assert.ok(validateValues(value).errors.includes(expected),expected);}
});
test('environment serialization is data-only and rejects ambiguous duplicate keys',()=>{
 const value={VALUE:'literal "quote" and backslash \\',SECOND:'alpha-beta_0'};
 assert.deepEqual(parseEnv(envText(value)),value);
 assert.throws(()=>envText({VALUE:'bad\nline'}));assert.throws(()=>parseEnv('VALUE=a\nVALUE=b\n'));
});
test('encrypted snapshot stream detects ciphertext tampering and component substitution',async t=>{
 const directory=await fs.mkdtemp('/tmp/lovelies-backup-crypto-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const key=randomBytes(32),file=path.join(directory,'storage.tar.enc'),bytes=randomBytes(8192);
 const record=await encryptStream(Readable.from([bytes]),file,key,{protocol:'lovelies-local-supabase-snapshot-v1',snapshot_id:'controlled',component:'storage.tar',created_at:Date.now()});
 assert.equal((await decryptStream(directory,record,key)).bytes,8192);
 await assert.rejects(()=>decryptStream(directory,{...record,aad:{...record.aad,component:'application.dump'}},key));
 await assert.rejects(()=>decryptStream(directory,record,randomBytes(32)));
 const encrypted=await fs.readFile(file);encrypted[23]^=1;await fs.writeFile(file,encrypted);
 await assert.rejects(()=>decryptStream(directory,record,key));
});
