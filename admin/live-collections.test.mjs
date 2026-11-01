import assert from 'node:assert/strict';
import test from 'node:test';
import {accountLabel,collectionState,collectionHash,collectionQuery,collectionPage} from './live-collections.mjs';

test('canonical account filters map registered_face and preserve attention bookmarks',()=>{
  assert.equal(collectionState('users',new URLSearchParams('filter=registered_face')).filter,'registered');
  assert.equal(collectionState('users',new URLSearchParams('filter=attention')).filter,'attention');
  assert.equal(collectionState('users',new URLSearchParams('filter=grant_admin')).filter,'all');
  assert.deepEqual(collectionState('guardians'),{q:'',filter:'attention',sort:'oldest'});
});
test('search and order changes retain the current queue filter and independent match filter',()=>{
  const state={route:'match-reports',q:'old',filter:'attention',sort:'oldest',matchFilter:'needs_review'};
  assert.equal(collectionHash(state,{q:'Review A&B'}),'match-reports?q=Review+A%26B&filter=attention&sort=oldest&match_filter=needs_review');
  assert.equal(collectionHash(state,{sort:'newest'}),'match-reports?q=old&filter=attention&sort=newest&match_filter=needs_review');
  const query=new URLSearchParams(collectionQuery({...state,q:'a%_'},'cursor+original'));
  assert.equal(query.get('q'),'a%_');assert.equal(query.get('cursor'),'cursor+original');assert.equal(query.get('status'),'attention');
});
test('deleted account status takes precedence over registered identity',()=>{
  assert.equal(accountLabel({status:'deleted',identity_state:'registered_face'}),'Deleted');
  assert.equal(accountLabel({status:'active',identity_state:'registered_face'}),'Registered');
  assert.equal(accountLabel({status:'active',identity_state:'anonymous'}),'Anonymous');
  assert.equal(accountLabel({status:'suspended',identity_state:'registered_face'}),'Suspended');
});
test('pagination requires a usable server cursor and never invents a missing continuation',()=>{
  assert.deepEqual(collectionPage(null),{has_more:false,next_cursor:null,total:null});
  assert.equal(collectionPage({has_more:true,next_cursor:'opaque',total:101}).next_cursor,'opaque');
  for(const page of [{has_more:true},{has_more:true,next_cursor:''},{has_more:true,next_cursor:'a'.repeat(8193)},{has_more:'true',next_cursor:'x'},{has_more:false,total:-1}])assert.throws(()=>collectionPage(page));
  assert.equal(collectionPage({has_more:false,next_cursor:'untrusted-unused'}).next_cursor,null);
});
