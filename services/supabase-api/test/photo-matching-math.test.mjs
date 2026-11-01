import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseRanks,mergeRanks,matchedIdentities,MATCH_PAGE_SIZE,matchPlan,MATCH_PLAN_PROTOCOL} from '../src/photo-matching.ts';

const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const rank=(n,distance)=>({account_id:id(n),profile_id:id(10000+n),profile_version:'v1',model_version:'model',distance});
const face=(...candidates)=>({face_index:0,candidates});

test('global top two merge across1001 identities and never promotes a page-local acceptance',()=>{
  const identities=Array.from({length:1001},(_,n)=>rank(n,n===0?.10:n===1000?.12:.8+n/10000));
  let aggregate=[face()];
  for(let start=0;start<identities.length;start+=MATCH_PAGE_SIZE){
    const page=identities.slice(start,start+MATCH_PAGE_SIZE).sort((a,b)=>a.distance-b.distance||a.account_id.localeCompare(b.account_id)).slice(0,2);
    aggregate=mergeRanks(aggregate,parseRanks([face(...page)]));
  }
  assert.deepEqual(aggregate,[face(identities[0],identities[1000])]);
  assert.deepEqual(matchedIdentities(aggregate),[],'late close runner-up prevents acceptance');
  assert.deepEqual(matchedIdentities([face(identities[0],rank(10,.8))]),[identities[0]],'a page-only decision would have been wrong');
});

test('late global winner, cross-page ties and no-face results preserve existing policy',()=>{
  const first=[face(rank(1,.6),rank(2,.7))],last=[face(rank(3,.1),rank(4,.3))];
  assert.deepEqual(matchedIdentities(mergeRanks(first,last)),[rank(3,.1)]);
  assert.deepEqual(matchedIdentities(mergeRanks([face(rank(1,.1))],[face(rank(2,.1))])),[]);
  assert.deepEqual(mergeRanks([],[]),[]);assert.deepEqual(matchedIdentities([]),[]);
  assert.throws(()=>mergeRanks([face(rank(1,.1))],[face(rank(1,.2))]),e=>e.code==='matching_plan_invalid');
  assert.throws(()=>mergeRanks([face()],[]),e=>e.code==='matching_plan_invalid');
});

test('ranking pages require finite ordered distinct identities and exact admitted tuples',()=>{
  const p={account_id:id(1),profile_id:id(10001),revision:'v1',model_id:'model'};
  const admitted=new Map([[p.account_id,p]]);
  assert.deepEqual(parseRanks([face(rank(1,.1))],admitted),[face(rank(1,.1))]);
  for(const candidates of [[rank(1,NaN)],[rank(1,-1)],[rank(1,3)],[rank(1,.1),rank(1,.2)],[rank(2,.1)],[rank(1,.3),rank(2,.1)]])
    assert.throws(()=>parseRanks([face(...candidates)],admitted),e=>e.code==='matching_plan_invalid');
  assert.throws(()=>parseRanks([face()],admitted),e=>e.code==='matching_plan_invalid');
});

test('only an exact complete-plan manifest activates paging; old arrays retain their original path',()=>{
  const valid={protocol:MATCH_PLAN_PROTOCOL,page_size:MATCH_PAGE_SIZE,profile_count:1001,initial_sha256:'a'.repeat(64),root_sha256:'b'.repeat(64)};
  assert.deepEqual(matchPlan(valid),valid);assert.equal(matchPlan([]),null);
  for(const p of [{...valid,page_size:1000},{...valid,profile_count:128},{...valid,extra:true},{...valid,root_sha256:null}])
    assert.throws(()=>matchPlan(p),e=>e.code==='matching_plan_invalid');
});
