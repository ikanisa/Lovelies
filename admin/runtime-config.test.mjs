import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRuntimeConfig} from './runtime-config.mjs';

test('self-hosted public admin selects its own HTTPS gateway without a cloud fallback',()=>{
  const local=resolveRuntimeConfig({}, {protocol:'https:',origin:'https://photos.example.test'});
  assert.equal(local.apiBaseUrl,'https://photos.example.test/functions/v1/lovelies-api');
  assert.equal(resolveRuntimeConfig({apiBaseUrl:'https://api.example.test:8443/functions/v1/lovelies-api/'}).apiBaseUrl,
    'https://api.example.test:8443/functions/v1/lovelies-api');
  assert(Object.isFrozen(local));
});
test('public client configuration rejects insecure internal addresses, credentials and altered route identity',()=>{
  for(const apiBaseUrl of ['http://api-gw:8000/functions/v1/lovelies-api','http://192.168.1.8/functions/v1/lovelies-api',
    'https://key:secret@example.test/functions/v1/lovelies-api','https://example.test/functions/v1/other',
    'https://example.test/functions/v1/lovelies-api?key=secret','https://example.test/functions/v1/lovelies-api#x',
    'https://example.test/functions%2fv1/lovelies-api','file:///functions/v1/lovelies-api',' https://example.test/functions/v1/lovelies-api']){
    assert.throws(()=>resolveRuntimeConfig({apiBaseUrl}),/invalid_public_api_configuration/);
  }
  assert.throws(()=>resolveRuntimeConfig({apiBaseUrl:'http://127.0.0.1:55101/functions/v1/lovelies-api'},
    {protocol:'https:',origin:'https://photos.example.test'}),/invalid_public_api_configuration/);
});
test('development preview uses only the configured loopback gateway',()=>{
  assert.equal(resolveRuntimeConfig({}, {protocol:'http:',origin:'http://localhost:3010'}).apiBaseUrl,
    'http://127.0.0.1:55101/functions/v1/lovelies-api');
});
