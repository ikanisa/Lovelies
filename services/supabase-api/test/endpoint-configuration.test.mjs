import {test} from 'node:test';
import assert from 'node:assert/strict';
import {internalEndpoint,internalEndpointPolicy,publicApiBase,databaseTlsConfiguration} from '../src/endpoint-configuration.ts';

test('local gateway HTTP is explicit and public clients require the exact HTTPS function base',()=>{
 const policy=internalEndpointPolicy('http://api-gw:8000');
 assert.equal(internalEndpoint('http://api-gw:8000',policy).origin,'http://api-gw:8000');
 assert.equal(publicApiBase('https://api.example.test/functions/v1/lovelies-api/'),'https://api.example.test/functions/v1/lovelies-api');
 assert.equal(publicApiBase('http://localhost/functions/v1/lovelies-api','test'),'http://localhost/functions/v1/lovelies-api');
 for(const value of ['http://api-gw:8000','http://api-gw:8001','http://api-gw.example.test:8000'])
  assert.throws(()=>internalEndpoint(value));
 for(const value of ['https://user:secret@api.example.test/functions/v1/lovelies-api','https://api.example.test/functions/v1/lovelies-api?grant=x',
  'https://api.example.test/functions/v1/lovelies-api#x','https://api.example.test/functions/x/../v1/lovelies-api',
  'https://api.example.test/functions/%2e%2e/v1/lovelies-api','https://api.example.test/functions%2fv1/lovelies-api',
  'https://api.example.test/','http://localhost/functions/v1/lovelies-api','http://api.example.test/functions/v1/lovelies-api'])
  assert.throws(()=>publicApiBase(value));
 assert.throws(()=>internalEndpointPolicy('http://api-gw:8000/'));
 assert.throws(()=>internalEndpoint('http://api-gw:8001',policy));
});

test('database certificate verification is the default even for loopback and cannot be URL-overridden',()=>{
 assert.equal(databaseTlsConfiguration('postgres://user:secret@localhost/db'),'verify-full');
 assert.deepEqual(databaseTlsConfiguration('postgres://user:secret@db.example.test/db','fixture-ca'),
  {rejectUnauthorized:true,ca:'fixture-ca',servername:'db.example.test'});
 assert.equal(databaseTlsConfiguration('postgres://user:secret@db/db',undefined,{mode:'disable-internal',trustedPlaintextHosts:['db']}),false);
 for(const query of ['sslmode=disable','ssl=false','sslrootcert=other'])
  assert.throws(()=>databaseTlsConfiguration('postgres://user:secret@db/db?'+query));
 assert.throws(()=>databaseTlsConfiguration('postgres://user:secret@outside.example/db',undefined,{mode:'disable-internal',trustedPlaintextHosts:['db']}));
 assert.throws(()=>databaseTlsConfiguration('postgres://user:secret@db/db','fixture-ca',{mode:'disable-internal',trustedPlaintextHosts:['db']}));
});
