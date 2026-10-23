import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesFilter,needsAttention,filterUsers,decisionLabel} from './view-model.mjs';

test('privacy approval and execution remain distinct, failures stay actionable',()=>{
  const queued={kind:'privacy',status:'queued',approvalStatus:'approved'};
  const failed={...queued,status:'failed'};
  assert.equal(decisionLabel(failed),'Approved');
  assert.equal(matchesFilter(queued,'done'),false);
  assert.equal(matchesFilter(failed,'done'),false);
  assert.equal(needsAttention(failed),true);
  assert.equal(matchesFilter(failed,'failed'),true);
  assert.equal(matchesFilter({...queued,status:'completed'},'done'),true);
  assert.equal(matchesFilter({status:'ready',kind:'upload'},'done'),false);
});
test('support rejection does not appear under resolved',()=>{
  const row={kind:'support',status:'resolved',reviewOutcome:'rejected'};
  assert.equal(matchesFilter(row,'resolved'),false);
  assert.equal(matchesFilter(row,'rejected'),true);
});
test('user search and identity filters exclude deleted accounts and preserve input',()=>{
  const users=[{id:'1',name:'Sam',role:'user',status:'active',identityState:'anonymous',createdAt:'2026-10-10'},
    {id:'2',name:'Alex',role:'admin',status:'active',identityState:'registered_face',createdAt:'2026-10-11'},
    {id:'3',name:'Deleted account',role:null,status:'deleted',identityState:null,createdAt:'2026-10-12'}];
  assert.deepEqual(filterUsers(users,{filter:'registered'}).map(u=>u.id),['2']);
  assert.deepEqual(filterUsers(users,{filter:'deleted'}).map(u=>u.id),['3']);
  assert.deepEqual(filterUsers(users,{q:'ADMIN'}).map(u=>u.id),['2']);
  assert.deepEqual(filterUsers(users,{sort:'oldest'}).map(u=>u.id),['1','2','3']);
  assert.equal(users[0].id,'1');
});
