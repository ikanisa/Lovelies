import assert from 'node:assert/strict';
import {test} from 'node:test';
import {notificationRosterFixture} from './notification-roster-fixture.mjs';
import {retirePushSubject} from '../src/push-roster.ts';
import {createApp} from '../src/index.ts';
import {digest,stable} from '../src/types.ts';

test('25 unavailable retired lookups cannot starve a later bound acceptance under a frozen clock',{timeout:40000},async t=>{
  const f=await notificationRosterFixture(t,{devices:1}),device=f.registrations[0],ids=[];
  const subject=await digest('lovelies-push-subject-v2:'+f.account),now=1800000000000;
  for(let index=0;index<26;index++){
    const id=index===0?f.notification:crypto.randomUUID(),p=await f.provider.plan({notificationID:id,subject,devices:[{id:device.id,token:device.token}]});
    ids.push(id);await f.provider.roster.plan(p.plan);const claim=await f.provider.roster.reserve(p.dispatches[0],p.hash);
    await f.provider.roster.start(p.dispatches[0].operation_key,claim.claim,f.provider.generation);
    await f.provider.roster.finish(p.dispatches[0].operation_key,{status:'accepted',provider_message_id:'synthetic-accepted-'+index});
    await f.h.db.transaction(async()=>{
      if(index){
        await f.h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Your support request was reviewed',?)",id,f.account,p.dispatches[0].notification.entity_id,now);
        await f.h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at,last_examined_at) VALUES(?,?,1,'ambiguous',?,?)",id,f.account,now,index);
      }else await f.h.db.run("UPDATE notification_jobs SET status='ambiguous',last_examined_at=0 WHERE notification_id=?",id);
      await f.h.db.run('INSERT INTO notification_dispatch_plans(notification_id,subject_sha256,provider_generation,plan_sha256,plan_json,created_at) VALUES(?,?,?,?,?,?)',id,subject,f.provider.generation,p.hash,stable(p.plan),now);
      const entry=p.plan.attempts[0];await f.h.db.run(`INSERT INTO notification_recovered_receipts(operation_key,notification_id,plan_sha256,device_id,token_sha256,request_sha256,provider_generation,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'ambiguous',?,?)`,entry.operation_key,id,p.hash,device.id,entry.token_sha256,entry.request_sha256,f.provider.generation,now,now);
    });
  }
  const blocked=new Set(ids.slice(0,25)),lookups=[],original=f.h.env.PUSH_SERVICE.fetch;
  f.h.env.PUSH_SERVICE={fetch:async(url,init={})=>{
    const pathname=new URL(url).pathname,match=/^\/notifications\/([0-9a-f-]{36})$/.exec(pathname);
    if(match){lookups.push(match[1]);if(blocked.has(match[1]))return Response.json({error:'synthetic_unavailable'},{status:503});}
    return original(url,init);
  }};
  const ctx=createApp(f.h.db,f.h.env,()=>now);
  await assert.rejects(()=>retirePushSubject(ctx,f.account),error=>error?.code==='push_provider_unavailable');
  assert.equal(lookups.length,25);assert(!lookups.includes(ids[25]));
  lookups.length=0;
  await assert.rejects(()=>retirePushSubject(ctx,f.account),error=>error?.code==='push_provider_unavailable');
  assert.equal(lookups.length,25);assert.equal(lookups[0],ids[25]);
  assert.equal((await f.h.db.one('SELECT status FROM notification_recovered_receipts WHERE notification_id=?',ids[25])).status,'accepted');
  assert.equal((await f.h.db.one("SELECT count(*) n FROM notification_recovered_receipts WHERE status='ambiguous'")).n,25);
});
