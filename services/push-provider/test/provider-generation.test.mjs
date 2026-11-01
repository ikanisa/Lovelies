import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,chmod,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configuredProviderGeneration} from '../src/provider-generation.mjs';
import {providerGeneration} from '../src/providers.mjs';

test('generation inspector makes no network call and cannot relabel disabled configuration as enabled',async t=>{
  t.mock.method(globalThis,'fetch',()=>{assert.fail('generation inspection must not make a network request');});
  const disabled=await configuredProviderGeneration({PUSH_PROVIDER_SEND_ENABLED:'false',APNS_PRIVATE_KEY_FILE:'/never-read-disabled-file'});
  assert.deepEqual(disabled,{protocol:'lovelies-push-provider-generation-v1',provider_generation:providerGeneration({}),platforms:[],sends_enabled:false});
  await assert.rejects(()=>configuredProviderGeneration({PUSH_PROVIDER_SEND_ENABLED:'true'}),/without_configuration/);
  const directory=await mkdtemp(path.join(await realpath(tmpdir()),'lovelies-generation-'));await chmod(directory,0o700);
  t.after(()=>rm(directory,{recursive:true,force:true}));const filename=path.join(directory,'synthetic-apns-key');
  await writeFile(filename,generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const enabled=await configuredProviderGeneration({PUSH_PROVIDER_SEND_ENABLED:'true',APNS_PRIVATE_KEY_FILE:filename,APNS_TEAM_ID:'ABCDEFGHIJ',APNS_KEY_ID:'1234567890',APNS_TOPIC:'com.lovelies.synthetic',APNS_ENVIRONMENT:'sandbox'});
  assert.deepEqual(enabled.platforms,['ios']);assert.equal(enabled.sends_enabled,true);assert.match(enabled.provider_generation,/^[0-9a-f]{64}$/);
  assert.notEqual(enabled.provider_generation,disabled.provider_generation);assert(!JSON.stringify(enabled).includes('PRIVATE KEY'));
});
