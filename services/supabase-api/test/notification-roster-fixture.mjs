import {randomUUID} from 'node:crypto';
import {startHarness} from './runtime-harness.mjs';
import {processNotificationJob} from '../src/notifications.ts';
import {digest} from '../src/types.ts';
import {rosterFixture} from '../../push-provider/test/roster-fixture.mjs';
import {env as ledgerEnv} from '../../push-provider/test/independent-ledger-fixture.mjs';

export async function notificationRosterFixture(t,{devices=2,send,prepare}={}){
  const provider=await rosterFixture({send,prepare}),calls=[];
  const h=await startHarness({consumeQueue:false,vars:{PUSH_PROVIDER_GENERATION:provider.generation,PUSH_LEDGER_ID:ledgerEnv.PUSH_LEDGER_ID,PUSH_LEDGER_BOOTSTRAP_ID:provider.bootstrap}});
  t.after(async()=>{await h.close();provider.storage.database.close();});
  h.env.PUSH_SERVICE={fetch:async(url,init={})=>{const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):undefined;
    calls.push({path,method:init.method??'GET'});return provider.call(path,body);}};
  const account=randomUUID(),notification=randomUUID(),now=Date.now(),entity=randomUUID(),registrations=[];
  await h.db.run("INSERT INTO accounts(id,name,created_at,identity_state,auth_epoch) VALUES(?,'Synthetic push subject',?,'registered_face',1)",account,now);
  for(let index=0;index<devices;index++){
    const auth=randomUUID(),id=randomUUID(),token='synthetic-private-push-device-'+randomUUID();
    await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,'{}','r1','active',?)",auth,account,now);
    await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,?,1,?,?)",id,account,auth,await digest(token),token,now,now);
    registrations.push({id,auth,token});
  }
  await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Your support request was reviewed',?)",notification,account,entity,now);
  await h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,'queued',?)",notification,account,now);
  return {h,provider,calls,account,notification,registrations,process:()=>processNotificationJob({notification_id:notification},h.app),
    job:()=>h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',notification),
    receipts:()=>h.db.all('SELECT * FROM notification_recovered_receipts WHERE notification_id=? ORDER BY operation_key',notification)};
}

