import assert from 'node:assert/strict';
import {restrictionManifest} from '../src/restore-manifest.ts';

/** Verify the complete ordered restriction set, including its v2 commitment.
 * Fixtures do not synthesize fields in a validated production plan. */
export async function planEvents(f,record){
 assert(record?.plan);
 if(record.plan.version===1)return record.plan.events;
 assert.equal(record.plan.version,2);
 const events=[];let cursor=record.plan.expected.cursor;
 while(cursor.sequence<record.plan.next.cursor.sequence){
  const page=await f.journal.restrictionPage(cursor,record.plan.next.cursor);
  assert(page.length>0&&page.length<=32);
  events.push(...page.map(receipt=>receipt.event));
  const last=page.at(-1);cursor={sequence:last.sequence,hash:last.hash};
 }
 assert.deepEqual(cursor,record.plan.next.cursor);
 assert.equal(events.length,record.plan.event_manifest.count);
 const {header}=await restrictionManifest({version:1,project_id:record.plan.project_id,operation_id:record.plan.operation_id,
  input_hash:record.plan.input_hash,expected:record.plan.expected,allocations:record.plan.allocations,events});
 assert.deepEqual(header.event_manifest,record.plan.event_manifest);
 return events;
}
