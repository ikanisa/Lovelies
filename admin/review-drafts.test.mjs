import assert from 'node:assert/strict';
import test from 'node:test';
import {ReviewDrafts} from './review-drafts.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope=(changes={})=>({accountId:id(1),recordId:id(2),form:'live-review-form',target:'support',version:'revision:4|under_review',...changes});

test('unsent fields are sealed with a non-extractable key and restored only to the exact record version',async()=>{
  const drafts=new ReviewDrafts(),context=scope(),fields={reason:'Independent review notes',decision:'approve'};
  await drafts.save(context,fields);
  assert.equal((await drafts.key).extractable,false);
  assert(!JSON.stringify([...drafts.entries.values()]).includes(fields.reason));
  assert.deepEqual(await drafts.restore(context),fields);
  assert.equal(await drafts.restore(scope({recordId:id(3)})),null);
  assert.equal(await drafts.restore(scope({version:'revision:5|resolved'})),null);
  assert.equal(drafts.available(context),false,'Changed records retire the stale draft');
});
test('confirmations, credentials and unbounded fields cannot enter a draft',async()=>{
  for(const fields of [{confirmed:true},{adult_verified:'true'},{access_token:'secret'},{reason:'x'.repeat(1001)}]) {
    const drafts=new ReviewDrafts();await assert.rejects(()=>drafts.save(scope(),fields));assert.equal(drafts.entries.size,0);
  }
});
test('account change and expiration destroy access to old unsent notes',async()=>{
  let clock=1000;const drafts=new ReviewDrafts({now:()=>clock,ttlMs:100});
  await drafts.save(scope(),{reason:'Original operator'});
  assert.equal(await drafts.restore(scope({accountId:id(5)})),null);assert.equal(drafts.entries.size,0);
  await drafts.save(scope(),{reason:'Expires soon'});clock+=101;
  assert.equal(await drafts.restore(scope()),null);assert.equal(drafts.entries.size,0);
});
test('logout during encryption cannot publish a late draft or retain its key',async()=>{
  let release,started;const ready=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
  const protectedCrypto={getRandomValues:crypto.getRandomValues.bind(crypto),subtle:{
    generateKey:crypto.subtle.generateKey.bind(crypto.subtle),decrypt:crypto.subtle.decrypt.bind(crypto.subtle),
    async encrypt(...args){started();await blocked;return crypto.subtle.encrypt(...args);},
  }};
  const drafts=new ReviewDrafts({crypto:protectedCrypto}),saving=drafts.save(scope(),{reason:'Must disappear'});
  await ready;drafts.discard();release();assert.equal(await saving,false);
  assert.equal(drafts.key,null);assert.equal(drafts.entries.size,0);assert.equal(await drafts.restore(scope()),null);
});
test('an older asynchronous save cannot overwrite newer notes',async()=>{
  let release,started,count=0;const ready=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
  const protectedCrypto={getRandomValues:crypto.getRandomValues.bind(crypto),subtle:{
    generateKey:crypto.subtle.generateKey.bind(crypto.subtle),decrypt:crypto.subtle.decrypt.bind(crypto.subtle),
    async encrypt(...args){if(++count===1){started();await blocked;}return crypto.subtle.encrypt(...args);},
  }};
  const drafts=new ReviewDrafts({crypto:protectedCrypto}),first=drafts.save(scope(),{reason:'Old draft'});
  await ready;assert.equal(await drafts.save(scope(),{reason:'New draft'}),true);release();assert.equal(await first,false);
  assert.deepEqual(await drafts.restore(scope()),{reason:'New draft'});
});
test('a bounded buffer refuses overflow while retaining existing work',async()=>{
  const drafts=new ReviewDrafts({maxEntries:2});
  await drafts.save(scope(),{reason:'First'});await drafts.save(scope({recordId:id(3)}),{reason:'Second'});
  await assert.rejects(()=>drafts.save(scope({recordId:id(4)}),{reason:'Third'}),/draft_limit_reached/);
  assert.deepEqual(await drafts.restore(scope()),{reason:'First'});
});
test('immediate logout before hydration resumes cannot resurrect a memory-only draft',async()=>{
  const drafts=new ReviewDrafts(),saving=drafts.save(scope(),{reason:'Must not return after logout'});
  await drafts.discard();assert.equal(await saving,false);
  assert.equal(drafts.available(scope()),false);assert.equal(drafts.account,null);assert.equal(drafts.key,null);
});
test('a held old-account save cannot rebind or clear a new account draft',async()=>{
  let release;const writes=[];
  const storage={load:account=>account===id(1)?new Promise(resolve=>release=resolve):Promise.resolve({entries:[],key:null}),
    write:async(account,_key,entries)=>writes.push({account,count:entries.length}),clear:async()=>{},current:()=>true};
  const drafts=new ReviewDrafts({storage}),old=drafts.save(scope(),{reason:'Old operator'}),next=scope({accountId:id(3)});
  assert.equal(await drafts.save(next,{reason:'Current operator'}),true);
  release({entries:[],key:null});assert.equal(await old,false);
  assert.equal(drafts.account,id(3));assert.deepEqual(await drafts.restore(next),{reason:'Current operator'});
  assert(writes.every(write=>write.account===id(3)));assert.equal(drafts.available(scope()),false);assert.equal(drafts.account,id(3));
});
test('a held restore cannot clear authority or notes installed after an account switch',async()=>{
  let release;
  const storage={load:account=>account===id(1)?new Promise(resolve=>release=resolve):Promise.resolve({entries:[],key:null}),
    write:async()=>{},clear:async()=>{},current:()=>true};
  const drafts=new ReviewDrafts({storage}),old=drafts.restore(scope()),next=scope({accountId:id(3)});
  await drafts.save(next,{reason:'Current operator'});release({entries:[],key:null});
  assert.equal(await old,null);assert.equal(drafts.account,id(3));assert.deepEqual(await drafts.restore(next),{reason:'Current operator'});
});
test('draft ownership is captured before asynchronous hydration',async()=>{
  const drafts=new ReviewDrafts(),context=scope(),saving=drafts.save(context,{reason:'Original owner'});
  context.accountId=id(3);context.recordId=id(4);
  assert.equal(await saving,true);assert.deepEqual(await drafts.restore(scope()),{reason:'Original owner'});
  assert.equal(drafts.available(context),false);
});
