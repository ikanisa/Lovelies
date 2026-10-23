import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {OperatorVault} from './operator-session.mjs';
import {faceSigningBytes} from '../clients/backend/face-contracts.mjs';
const base='https://operator-test.invalid/functions/v1/lovelies-api';
test('browser vault encrypts journal and restores a usable non-extractable device key',async()=>{
 const idb=new IDBFactory(),first=new OperatorVault(base,idb);const state=await first.create();state.enrollment={original:'sensitive-journal-fixture'};await first.save(state);
 const db=await first.database(),record=await new Promise((resolve,reject)=>{const r=db.transaction('records').objectStore('records').get(base);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 assert.equal(record.signingKey.extractable,false);assert.equal(record.encryptionKey.extractable,false);assert.equal(JSON.stringify(record).includes('sensitive-journal-fixture'),false);
 await assert.rejects(crypto.subtle.exportKey('jwk',record.signingKey));
 const restored=new OperatorVault(base,idb);assert.deepEqual(await restored.load(),state);const proof={step:'test',nonce:crypto.randomUUID()},signature=await restored.sign(proof);
 const publicKey=await crypto.subtle.importKey('jwk',state.devicePublicJwk,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);
 assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,Buffer.from(signature,'base64url'),faceSigningBytes(proof)),true);
});
test('stale browser tab cannot overwrite a newer durable action or replace device keys',async()=>{
 const idb=new IDBFactory(),first=new OperatorVault(base,idb),second=new OperatorVault(base,idb);const initial=await first.create(),stale=await second.load();
 initial.pendingAction={path:'/admin/controlled',body:{operation_key:crypto.randomUUID()}};await first.save(initial);
 stale.pendingAction={path:'/admin/different'};await assert.rejects(second.save(stale),{code:'private_state_changed'});
 const third=new OperatorVault(base,idb);assert.deepEqual((await third.load()).pendingAction,initial.pendingAction);await assert.rejects(third.create(),{code:'existing_device_must_recover'});
});
test('concurrent first setup commits only one protected browser identity',async()=>{
 const idb=new IDBFactory(),one=new OperatorVault(base,idb),two=new OperatorVault(base,idb);const result=await Promise.allSettled([one.create(),two.create()]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);
 const saved=await new OperatorVault(base,idb).load();assert.deepEqual(saved.devicePublicJwk,result.find(r=>r.status==='fulfilled').value.devicePublicJwk);
});
test('same vault instance cannot let an older encryption overwrite a committed retirement',async()=>{
 const idb=new IDBFactory(),vault=new OperatorVault(base,idb),initial=await vault.create();let release,entered,gate=true;
 const ready=new Promise(resolve=>entered=resolve),encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
 crypto.subtle.encrypt=async(...args)=>{let value;try{value=JSON.parse(new TextDecoder().decode(args[2]));}catch{}
   if(gate&&value?.refreshDelivery?.retired===false){gate=false;entered();await new Promise(resolve=>release=resolve);}return encrypt(...args);};
 try{
   const older=vault.save({...initial,refreshDelivery:{retired:false}}).then(()=>null,error=>error);await ready;
   await vault.save({...initial,refreshDelivery:{retired:true}});release();assert.equal((await older).code,'private_state_changed');
   assert.equal((await new OperatorVault(base,idb).load()).refreshDelivery.retired,true);
 }finally{release?.();crypto.subtle.encrypt=encrypt;}
});
test('concurrent setup on one vault never mismatches the committed public and private keys',async()=>{
 const idb=new IDBFactory(),vault=new OperatorVault(base,idb);let release,entered,generated=0;
 const ready=new Promise(resolve=>entered=resolve),generate=crypto.subtle.generateKey.bind(crypto.subtle);
 crypto.subtle.generateKey=async(...args)=>{if(args[0]?.name==='ECDSA'){generated++;entered();await new Promise(resolve=>release=resolve);}return generate(...args);};
 try{
   const creating=vault.create();await ready;await assert.rejects(vault.create(),{code:'device_creation_in_progress'});release();const state=await creating;assert.equal(generated,1);
   const restored=new OperatorVault(base,idb);assert.deepEqual(await restored.load(),state);
   const proof={purpose:'fixture',nonce:crypto.randomUUID()},signature=await restored.sign(proof),publicKey=await crypto.subtle.importKey('jwk',state.devicePublicJwk,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);
   assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,Buffer.from(signature,'base64url'),faceSigningBytes(proof)),true);
 }finally{release?.();crypto.subtle.generateKey=generate;}
});
