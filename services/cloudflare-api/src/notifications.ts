import { ApiError, jsonBody, ok, stable, digest, uuid, record, type Actor, type AppContext, type Database } from './types';
import { assertRegisteredActor, executeOperation, prepareOperation } from './operations';

export const notificationsSchemaStatements:readonly string[]=[
  `CREATE TABLE IF NOT EXISTS notification_settings(account_id TEXT PRIMARY KEY REFERENCES accounts(id),match_alerts INTEGER NOT NULL DEFAULT 1 CHECK(match_alerts IN(0,1)),payment_alerts INTEGER NOT NULL DEFAULT 1 CHECK(payment_alerts IN(0,1)),support_alerts INTEGER NOT NULL DEFAULT 1 CHECK(support_alerts IN(0,1)),updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),auth_device_id TEXT NOT NULL REFERENCES auth_devices(id),platform TEXT NOT NULL CHECK(platform IN('ios','android')),token_hash TEXT NOT NULL UNIQUE,token_value TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL CHECK(kind IN('match','payment','support')),entity_id TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER,UNIQUE(account_id,kind,entity_id))`,
  `CREATE TABLE IF NOT EXISTS notification_jobs(notification_id TEXT PRIMARY KEY REFERENCES notifications(id),account_id TEXT NOT NULL REFERENCES accounts(id),auth_epoch INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('queued','dispatched','accepted','ambiguous','cancelled','inbox_only')),created_at INTEGER NOT NULL,dispatched_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),device_id TEXT NOT NULL REFERENCES push_devices(id),operation_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN('queued','dispatching','accepted','ambiguous','cancelled')),token_hash TEXT NOT NULL,provider_receipt TEXT,lease_token TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(notification_id,device_id))`,
  `CREATE INDEX IF NOT EXISTS notification_account ON notifications(account_id,created_at)`,
];
export function initNotificationsSchema(db:Database):void {for(const sql of notificationsSchemaStatements)db.run(sql);}
function settings(ctx:AppContext,account:string):Record<string,unknown> {
  const row=ctx.db.one<any>('SELECT * FROM notification_settings WHERE account_id=?',account);
  return {user_id:account,match_alerts:row?row.match_alerts===1:true,payment_alerts:row?row.payment_alerts===1:true,support_alerts:row?row.support_alerts===1:true};
}
function permitted(ctx:AppContext,account:string,kind:string,epoch?:number):boolean {
  const row=ctx.db.one<any>('SELECT identity_state,disabled_at,auth_epoch FROM accounts WHERE id=?',account);
  return !!row&&row.identity_state==='registered_face'&&row.disabled_at===null&&(epoch==null||row.auth_epoch===epoch)&&settings(ctx,account)[kind+'_alerts']===true;
}
/** Internal producer only. Titles contain no photos, tokens, counterpart names
 * or links; opening the entity still requires the usual current authority. */
export function enqueueNotification(ctx:AppContext,account:string,kind:'match'|'payment'|'support',entity:string,title:string):string|null {
  if(!permitted(ctx,account,kind))return null;if(!title||title.length>160||/[\u0000-\u001f]/.test(title))throw new ApiError(500,'notification_content_invalid');
  const existing=ctx.db.one<{id:string}>('SELECT id FROM notifications WHERE account_id=? AND kind=? AND entity_id=?',account,kind,entity);if(existing)return existing.id;
  const id=crypto.randomUUID(),epoch=ctx.db.one<{auth_epoch:number}>('SELECT auth_epoch FROM accounts WHERE id=?',account)!.auth_epoch;
  ctx.db.run('INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,?,?,?,?)',id,account,kind,entity,title,ctx.now());
  ctx.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,?,'queued',?)",id,account,epoch,ctx.now());return id;
}
export async function handleNotifications(request:Request,ctx:AppContext):Promise<Response|null> {
  const path=new URL(request.url).pathname,read=/^\/me\/notifications\/([0-9a-f-]{36})\/read$/i.exec(path),device=/^\/me\/push-devices\/([0-9a-f-]{36})$/i.exec(path);
  if(!['/me/notification-settings','/me/notifications','/me/push-devices'].includes(path)&&!read&&!device)return null;
  const actor=await ctx.authenticate(request);assertRegisteredActor(ctx,actor);
  if(request.method==='GET')return ok(ctx.db.transaction(()=>{assertRegisteredActor(ctx,actor);if(path==='/me/notification-settings')return settings(ctx,actor.accountId);if(path==='/me/notifications')return {items:ctx.db.all('SELECT id,kind,entity_id,title,created_at,read_at FROM notifications WHERE account_id=? ORDER BY created_at DESC,id LIMIT 100',actor.accountId)};if(path==='/me/push-devices')return {items:ctx.db.all('SELECT id,auth_device_id,platform,active,created_at,updated_at FROM push_devices WHERE account_id=?',actor.accountId)};throw new ApiError(405,'method_not_allowed');}));
  if(!['POST','PATCH','DELETE'].includes(request.method))throw new ApiError(405,'method_not_allowed');const body=await jsonBody(request,16384);
  const allowed=path==='/me/notification-settings'?['match_alerts','payment_alerts','support_alerts','operation_key']:path==='/me/push-devices'?['platform','push_token','operation_key']:['operation_key'];
  if(Object.keys(body).some(key=>!allowed.includes(key)))throw new ApiError(400,'invalid_input');
  let tokenHash:string|undefined;
  if(path==='/me/push-devices'){if(request.method!=='POST'||!['ios','android'].includes(body.platform)||typeof body.push_token!=='string'||body.push_token.length<16||body.push_token.length>4096||/\s/.test(body.push_token))throw new ApiError(400,'push_device_invalid');tokenHash=await digest(body.push_token);}
  const intent=await prepareOperation('notification.'+path+'.'+request.method,{...body,...(read?{notification_id:uuid(read[1])}:device?{device_id:uuid(device[1])}:{})},'notification');
  return ok(executeOperation(ctx,actor,intent,()=>{
    if(path==='/me/notification-settings'){
      if(request.method!=='PATCH')throw new ApiError(405,'method_not_allowed');ctx.db.run('INSERT OR IGNORE INTO notification_settings(account_id,updated_at) VALUES(?,?)',actor.accountId,ctx.now());
      for(const name of ['match_alerts','payment_alerts','support_alerts'])if(Object.hasOwn(body,name)){if(typeof body[name]!=='boolean')throw new ApiError(400,'invalid_notification_setting');ctx.db.run('UPDATE notification_settings SET '+name+'=?,updated_at=? WHERE account_id=?',body[name]?1:0,ctx.now(),actor.accountId);}return settings(ctx,actor.accountId);
    }
    if(read){if(request.method!=='POST')throw new ApiError(405,'method_not_allowed');const id=uuid(read[1]);if(!ctx.db.one('SELECT id FROM notifications WHERE id=? AND account_id=?',id,actor.accountId))throw new ApiError(404,'notification_unavailable');ctx.db.run('UPDATE notifications SET read_at=coalesce(read_at,?) WHERE id=?',ctx.now(),id);return {id,read:true};}
    if(device){if(request.method!=='DELETE')throw new ApiError(405,'method_not_allowed');const id=uuid(device[1]);if(!ctx.db.one('SELECT id FROM push_devices WHERE id=? AND account_id=?',id,actor.accountId))throw new ApiError(404,'push_device_unavailable');ctx.db.run("UPDATE push_devices SET active=0,token_value='',updated_at=? WHERE id=?",ctx.now(),id);return {id,active:false};}
    const current=ctx.db.one<{device_id:string}>('SELECT device_id FROM sessions WHERE id=?',actor.sessionId)!;
    const prior=ctx.db.one<any>('SELECT id,account_id FROM push_devices WHERE token_hash=?',tokenHash!);if(prior&&prior.account_id!==actor.accountId)throw new ApiError(403,'push_token_owner_conflict');
    if(!prior&&ctx.db.one<{n:number}>('SELECT count(*) n FROM push_devices WHERE account_id=? AND active=1',actor.accountId)!.n>=10)throw new ApiError(409,'push_device_limit');
    const id=prior?.id??crypto.randomUUID();ctx.db.run('INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET auth_device_id=excluded.auth_device_id,platform=excluded.platform,token_value=excluded.token_value,active=1,updated_at=excluded.updated_at',id,actor.accountId,current.device_id,body.platform,tokenHash!,body.push_token,ctx.now(),ctx.now());return {id,platform:body.platform,active:true};
  }));
}
export async function flushNotificationOutbox(ctx:AppContext):Promise<void> {
  for(const row of ctx.db.all<any>("SELECT j.*,n.kind FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.status IN('queued','dispatched','ambiguous') AND (j.dispatched_at IS NULL OR j.dispatched_at<=?) ORDER BY j.created_at LIMIT 25",ctx.now()-60000)) {
    if(!permitted(ctx,row.account_id,row.kind,row.auth_epoch)){ctx.db.run("UPDATE notification_jobs SET status='cancelled' WHERE notification_id=?",row.notification_id);continue;}
    await ctx.env.PHOTO_JOBS.send({category:'notification',payload:{notification_id:row.notification_id}});
    ctx.db.run("UPDATE notification_jobs SET status='dispatched',dispatched_at=? WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')",ctx.now(),row.notification_id);
  }
}
export async function processNotificationJob(payload:unknown,ctx:AppContext):Promise<void> {
  const body=record(payload);if(Object.keys(body).some(key=>key!=='notification_id'))throw new ApiError(400,'invalid_job');const id=uuid(body.notification_id);
  const job=ctx.db.one<any>('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.notification_id=?',id);if(!job||['accepted','cancelled','inbox_only'].includes(job.status))return;
  if(!permitted(ctx,job.account_id,job.kind,job.auth_epoch)){ctx.db.run("UPDATE notification_jobs SET status='cancelled' WHERE notification_id=?",id);return;}
  const devices=ctx.db.all<any>("SELECT p.* FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.account_id=p.account_id AND d.status='active' WHERE p.account_id=? AND p.active=1 ORDER BY p.id LIMIT 10",job.account_id);
  if(!devices.length){ctx.db.run("UPDATE notification_jobs SET status='inbox_only' WHERE notification_id=?",id);return;}
  if(!ctx.env.PUSH_SERVICE)throw new ApiError(503,'push_provider_unavailable');
  for(const device of devices) {
    const operation='notification:'+id+':'+device.id,lease=crypto.randomUUID();
    const delivery=ctx.db.transaction(()=>{
      if(!permitted(ctx,job.account_id,job.kind,job.auth_epoch))throw new ApiError(409,'notification_authority_changed');
      ctx.db.run("INSERT OR IGNORE INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)",crypto.randomUUID(),id,device.id,operation,device.token_hash,ctx.now(),ctx.now());
      const row=ctx.db.one<any>('SELECT * FROM notification_deliveries WHERE operation_key=?',operation)!;if(['accepted','cancelled'].includes(row.status))return null;if(row.status==='dispatching'&&row.lease_until>ctx.now())throw new ApiError(503,'push_delivery_in_progress');
      ctx.db.run("UPDATE notification_deliveries SET status='dispatching',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?",lease,ctx.now()+60000,ctx.now(),row.id);return row;
    });if(!delivery)continue;
    try {
      let receipt:any;
      if(delivery.status!=='queued'){
        const response=await ctx.env.PUSH_SERVICE.fetch('https://push.internal/operations/'+encodeURIComponent(operation),{redirect:'manual'});if(response.redirected||!response.ok)throw new ApiError(503,'push_reconciliation_required');receipt=await jsonBody(response as unknown as Request,8192);
        if(receipt.status!=='accepted')throw new ApiError(503,'push_reconciliation_required');
      } else {
        const response=await ctx.env.PUSH_SERVICE.fetch('https://push.internal/send',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:stable({operation_key:operation,platform:device.platform,token:device.token_value,notification:{id,title:job.title,kind:job.kind,entity_id:job.entity_id}})});
        if(response.redirected||!response.ok)throw new ApiError(503,'push_delivery_unconfirmed');receipt=await jsonBody(response as unknown as Request,8192);
      }
      if(receipt.status!=='accepted'||receipt.operation_key!==operation||typeof receipt.provider_message_id!=='string'||!receipt.provider_message_id||receipt.provider_message_id.length>256)throw new ApiError(503,'push_delivery_unconfirmed');
      ctx.db.transaction(()=>{
        const current=ctx.db.one<any>('SELECT * FROM notification_deliveries WHERE id=?',delivery.id),active=ctx.db.one<any>("SELECT p.id FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.status='active' WHERE p.id=? AND p.account_id=? AND p.active=1 AND p.token_hash=?",device.id,job.account_id,device.token_hash);
        if(!current||current.lease_token!==lease||!active||!permitted(ctx,job.account_id,job.kind,job.auth_epoch))throw new ApiError(409,'notification_authority_changed');ctx.db.run("UPDATE notification_deliveries SET status='accepted',provider_receipt=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",receipt.provider_message_id,ctx.now(),delivery.id);
      });
    } catch(error){ctx.db.run("UPDATE notification_deliveries SET status='ambiguous',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?",ctx.now(),delivery.id,lease);ctx.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",id);throw error;}
  }
  if(devices.length&&ctx.db.one<{n:number}>("SELECT count(*) n FROM notification_deliveries WHERE notification_id=? AND status<>'accepted'",id)!.n===0)ctx.db.run("UPDATE notification_jobs SET status='accepted' WHERE notification_id=?",id);
  // No push device is an actual inbox-only state, never a delivery receipt.
}
export function notificationPrivacyRows(ctx:AppContext,subject:string):Record<string,unknown> {
  const rows={notification_settings:settings(ctx,subject),notifications:ctx.db.all('SELECT id,kind,title,created_at,read_at FROM notifications WHERE account_id=? ORDER BY created_at,id LIMIT 25001',subject),push_devices:ctx.db.all('SELECT id,platform,active,created_at,updated_at FROM push_devices WHERE account_id=? ORDER BY created_at,id LIMIT 25001',subject)};
  if(rows.notifications.length>25000||rows.push_devices.length>25000)throw new ApiError(413,'privacy_export_too_large');return rows;
}
export function eraseNotificationSubject(db:Database,subject:string):void {
  db.run('DELETE FROM notification_deliveries WHERE notification_id IN(SELECT id FROM notifications WHERE account_id=?) OR device_id IN(SELECT id FROM push_devices WHERE account_id=?)',subject,subject);
  db.run('DELETE FROM notification_jobs WHERE account_id=?',subject);db.run('DELETE FROM notifications WHERE account_id=?',subject);db.run('DELETE FROM push_devices WHERE account_id=?',subject);db.run('DELETE FROM notification_settings WHERE account_id=?',subject);
}
