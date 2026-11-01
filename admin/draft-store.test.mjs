import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {ReviewDraftStore} from './draft-store.mjs';
import {ReviewDrafts} from './review-drafts.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope=(changes={})=>({accountId:id(1),recordId:id(2),form:'live-review-form',target:'support',version:'revision:4',...changes});
function fixture(){
 const indexedDB=new IDBFactory(),values=new Map(),localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))};
 const store=()=>new ReviewDraftStore('https://api.example.test',{indexedDB,localStorage});
 return {store,values,drafts:options=>new ReviewDrafts({storage:store(),...options})};
}
async function persisted(store){const db=await store.database();return new Promise((resolve,reject)=>{const r=db.transaction('drafts').objectStore('drafts').get(store.base);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}

test('saved encrypted notes reload with exact scope; browser markers contain no personal content',async()=>{
 const f=fixture(),first=f.drafts(),fields={reason:'Private reason must not be plaintext',decision:'approve'};
 await first.save(scope(),fields);const row=await persisted(first.storage);
 assert.equal(row.key.extractable,false);assert(!JSON.stringify(row).includes(fields.reason));
 assert([...f.values.values()].every(value=>/^[0-9a-f-]{36}$/.test(value)));
 first.suspend();const restored=f.drafts();await restored.hydrate(id(1));
 assert.deepEqual(await restored.restore(scope()),fields);
 assert.equal(await restored.restore(scope({recordId:id(3)})),null);
 assert.equal(await restored.restore(scope({version:'revision:5'})),null);await restored.pending;
 assert.equal((await persisted(restored.storage)).entries.length,0);
});
test('draft expiry is not extended by reload and expired ciphertext is removed on access',async()=>{
 const f=fixture();let time=1000;const options={now:()=>time,ttlMs:100};
 await f.drafts(options).save(scope(),{reason:'Expires at1100'});time=1075;
 assert.deepEqual(await f.drafts(options).restore(scope()),{reason:'Expires at1100'});
 time=1101;const expired=f.drafts(options);assert.equal(await expired.restore(scope()),null);
 assert.equal((await persisted(expired.storage)).entries.length,0);
});
test('synchronous logout tombstone prevents another tab or reload from recovering old drafts',async()=>{
 const f=fixture(),one=f.drafts();await one.save(scope(),{reason:'Clear on sign out'});
 const other=f.drafts();await other.hydrate(id(1));await one.discard();
 assert.equal(await other.restore(scope()),null);assert.equal(await f.drafts().restore(scope()),null);
 assert.equal((await persisted(one.storage)).key,null);
});
test('a tombstone survives interrupted IndexedDB cleanup and prevents ciphertext resurrection',async()=>{
 const f=fixture(),one=f.drafts();await one.save(scope(),{reason:'Must remain inaccessible'});
 one.storage.database=async()=>{throw Error('synthetic cleanup interrupted');};
 await assert.rejects(one.discard(),/synthetic cleanup interrupted/);
 assert.equal(await f.drafts().restore(scope()),null);
});
test('two tabs cannot silently overwrite each other and account switches retire the old key',async()=>{
 const f=fixture(),one=f.drafts();await one.save(scope(),{reason:'First'});
 const second=f.drafts();await second.hydrate(id(1));await one.save(scope(),{reason:'Newer'});
 await assert.rejects(second.save(scope(),{reason:'Stale tab'}),/draft_storage_changed/);
 assert.deepEqual(await f.drafts().restore(scope()),{reason:'Newer'});
 const switched=f.drafts();await switched.hydrate(id(9));await switched.save(scope({accountId:id(9)}),{reason:'Different operator'});
 assert.equal(await f.drafts().restore(scope()),null);
});
test('discard while a persistent save is waiting cannot resurrect a key or encrypted note',async()=>{
 const f=fixture(),one=f.drafts();await one.hydrate(id(1));let release,started;
 const blocked=new Promise(r=>release=r),entered=new Promise(r=>started=r),write=one.storage.write.bind(one.storage);
 one.storage.write=async(...args)=>{started();await blocked;return write(...args);};
 const saving=one.save(scope(),{reason:'Late persisted draft'});await entered;
 const clearing=one.discard();release();await assert.rejects(saving,/draft_storage_changed/);await clearing;
 assert.equal(await f.drafts().restore(scope()),null);
});
test('parallel first edits to different forms share one hydrated key and retain both',async()=>{
 const f=fixture(),drafts=f.drafts();
 await Promise.all([drafts.save(scope(),{reason:'First record'}),drafts.save(scope({recordId:id(3)}),{reason:'Second record'})]);
 const restored=f.drafts();assert.deepEqual(await restored.restore(scope()),{reason:'First record'});
 assert.deepEqual(await restored.restore(scope({recordId:id(3)})),{reason:'Second record'});
});
