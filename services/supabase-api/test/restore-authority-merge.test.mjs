/** Isolated adapter contract: one synthetic invocation, no database or network. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PostgresDatabase} from '../src/database.ts';
import {ApiError} from '../src/types.ts';

function fixture(options={}) {
  const events=[];
  const connection={
    async query(sql){events.push('query:'+sql);return [];},
    async begin(callback){
      events.push('begin');let value;
      try {value=await callback(this);}
      catch(error){events.push('rollback');if(options.rollbackUnknown)throw Error('rollback_outcome_unknown');throw error;}
      events.push('commit');if(options.commitUnknown)throw Error('commit_outcome_unknown');return value;
    },
  };
  const fence={
    async enter(){events.push('admit');return {admitted:true};},
    lineage(){return {database_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',incarnation_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};},
    async prepare(){events.push('prepare');return {prepared:true};},
    async committed(){events.push('acknowledge');},
  };
  return {db:new PostgresDatabase(connection,fence),events};
}
const code=value=>error=>error instanceof ApiError&&error.code===value;
function bind(db,events,expired=()=>false){
  db.bindInvocationAuthority(async()=>{events.push('authority-check');},()=>{events.push('fresh');if(expired())throw new ApiError(403,'synthetic_expired');});
}

test('a commit validator runs after independent prepare and before commit under bound authority',async()=>{
  const {db,events}=fixture();
  await db.invocation(async()=>{
    bind(db,events);
    await db.transaction(async()=>{events.push('body');db.beforeCommit(()=>{events.push('validate');});});
  });
  assert(events.indexOf('prepare')<events.indexOf('validate'));
  assert(events.indexOf('validate')<events.indexOf('commit'));
  assert(events.indexOf('commit')<events.indexOf('acknowledge'));
  assert(events.slice(events.indexOf('validate'),events.indexOf('commit')).includes('fresh'));
});

test('authority expiring during an after-prepare validator preserves an unresolved outcome',async()=>{
  const {db,events}=fixture();let expired=false;
  await assert.rejects(db.invocation(async()=>{
    bind(db,events,()=>expired);
    await db.transaction(async()=>db.beforeCommit(()=>{events.push('validate');expired=true;}));
  }),code('store_operation_outcome_unresolved'));
  assert(events.includes('prepare'));assert(events.includes('rollback'));
  assert(!events.includes('commit'));assert(!events.includes('acknowledge'));
});

test('validator rejection after independent prepare leaves the invocation unavailable',async()=>{
  const {db,events}=fixture();
  await assert.rejects(db.invocation(async()=>{
    await db.transaction(async()=>db.beforeCommit(()=>{events.push('validate');throw Error('synthetic_guard_rejected');}));
  }),code('restore_reconciliation_required'));
  assert(events.includes('prepare'));assert(events.includes('rollback'));
  assert(!events.includes('commit'));assert(!events.includes('acknowledge'));
});

test('an unknown rollback poisons the invocation even if its first error is caught',async()=>{
  const {db,events}=fixture({rollbackUnknown:true});
  await assert.rejects(db.invocation(async()=>{
    try{await db.transaction(()=>{throw Error('synthetic_callback_failure');});}catch{}
    await db.read(()=>{events.push('late-business-read');});
  }),code('restore_reconciliation_required'));
  assert(events.includes('rollback'));assert(!events.includes('prepare'));assert(!events.includes('late-business-read'));
});

test('an acknowledged rollback preserves the original callback error and allows an admitted read',async()=>{
  const {db,events}=fixture();const original=Error('synthetic_callback_failure');
  await db.invocation(async()=>{
    await assert.rejects(db.transaction(()=>{throw original;}),error=>error===original);
    await db.read(()=>{events.push('admitted-read');});
  });
  assert(events.includes('rollback'));assert(events.includes('admitted-read'));assert(!events.includes('prepare'));
});

test('an ambiguous commit with bound authority returns unresolved and does not acknowledge',async()=>{
  const {db,events}=fixture({commitUnknown:true});
  await assert.rejects(db.invocation(async()=>{
    bind(db,events);await db.transaction(()=>{});
  }),code('store_operation_outcome_unresolved'));
  assert(events.includes('prepare'));assert(events.includes('commit'));assert(!events.includes('acknowledge'));
});

// Privacy grant authority intentionally has a different outcome code from
// store authority. These synthetic checks exercise only the adapter boundary;
// they do not prove a hosted transaction or provider outcome.
function bindPrivacy(db,events,expired=()=>false){
  db.bindInvocationAuthority(async()=>{events.push('privacy-check');},()=>{events.push('privacy-fresh');if(expired())throw new ApiError(401,'session_invalid');},'privacy_export_grant_outcome_unresolved');
}

test('privacy expiry during an after-prepare validator retains the privacy unresolved code',async()=>{
  const {db,events}=fixture();let expired=false;
  await assert.rejects(db.invocation(async()=>{
    bindPrivacy(db,events,()=>expired);
    await db.transaction(async()=>db.beforeCommit(()=>{events.push('validate');expired=true;}));
  }),code('privacy_export_grant_outcome_unresolved'));
  assert(events.indexOf('prepare')<events.indexOf('validate'));assert(events.includes('rollback'));
  assert(!events.includes('commit'));assert(!events.includes('acknowledge'));
});

test('privacy validator rejection after prepare remains unresolved and is not acknowledged',async()=>{
  const {db,events}=fixture();
  await assert.rejects(db.invocation(async()=>{
    bindPrivacy(db,events);
    await db.transaction(async()=>db.beforeCommit(()=>{events.push('validate');throw Error('synthetic_privacy_guard_rejected');}));
  }),code('privacy_export_grant_outcome_unresolved'));
  assert(events.includes('prepare'));assert(events.includes('rollback'));
  assert(!events.includes('commit'));assert(!events.includes('acknowledge'));
});

test('privacy ambiguous commit retains its own outcome code and never acknowledges',async()=>{
  const {db,events}=fixture({commitUnknown:true});
  await assert.rejects(db.invocation(async()=>{
    bindPrivacy(db,events);await db.transaction(()=>{});
  }),code('privacy_export_grant_outcome_unresolved'));
  assert(events.includes('prepare'));assert(events.includes('commit'));assert(!events.includes('acknowledge'));
});

test('privacy unknown rollback after prepare poisons later reads with the privacy outcome',async()=>{
  const {db,events}=fixture({rollbackUnknown:true});
  await assert.rejects(db.invocation(async()=>{
    bindPrivacy(db,events);
    try{await db.transaction(async()=>db.beforeCommit(()=>{throw Error('synthetic_privacy_guard_rejected');}));}catch{}
    await db.read(()=>{events.push('late-privacy-read');});
  }),code('privacy_export_grant_outcome_unresolved'));
  assert(events.includes('prepare'));assert(events.includes('rollback'));
  assert(!events.includes('commit'));assert(!events.includes('acknowledge'));assert(!events.includes('late-privacy-read'));
});

test('a privacy callback rejected before prepare preserves its original denial',async()=>{
  const {db,events}=fixture();
  await assert.rejects(db.invocation(async()=>{
    bindPrivacy(db,events);await db.transaction(()=>{throw new ApiError(403,'synthetic_preparation_denied');});
  }),code('synthetic_preparation_denied'));
  assert(events.includes('rollback'));assert(!events.includes('prepare'));assert(!events.includes('commit'));assert(!events.includes('acknowledge'));
});
