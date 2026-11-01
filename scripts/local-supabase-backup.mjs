#!/usr/bin/env node
/** Coordinated encrypted snapshots. Application rollback never restores custody. */
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Transform,Writable} from 'node:stream';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHash,createHmac,timingSafeEqual,hkdfSync} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {args,runtime,compose,composeArgs,sql,privateRequest,writeReceipt,requireCompose,withOperationLock} from './local-supabase-common.mjs';

const PROTOCOL='lovelies-local-supabase-snapshot-v1';
const SEVEN_DAYS=7*24*60*60*1000;
const helperImage='node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c';
const allowed=new Set(['application.dump','storage.tar','application-db-config.tar','custody.dump','custody-db-config.tar','runtime-escrow.tar']);
const keyFor=(key,kind)=>Buffer.from(hkdfSync('sha256',key,Buffer.alloc(0),'lovelies-snapshot-v1:'+kind,32));
const signature=(payload,key)=>createHmac('sha256',keyFor(key,'manifest')).update(JSON.stringify(payload)).digest('hex');
const equalHex=(a,b)=>/^[0-9a-f]{64}$/.test(a??'')&&/^[0-9a-f]{64}$/.test(b??'')&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
export async function backupKey(directory){const file=path.join(directory,'backup.key'),stat=await fs.lstat(file);if(!stat.isFile()||(stat.mode&0o077)!==0)throw Error('backup_key_permissions_invalid');const value=await fs.readFile(file,'utf8'),key=Buffer.from(value.trim(),'base64');if(key.length!==32)throw Error('backup_key_invalid');return key;}
export function digestStream(){const hash=createHash('sha256');let size=0;return {stream:new Transform({transform(chunk,encoding,done){size+=chunk.length;hash.update(chunk);done(null,chunk);}}),result:()=>({sha256:hash.digest('hex'),bytes:size})};}
export async function encryptStream(input,file,key,aad){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFor(key,aad.component),iv);cipher.setAAD(Buffer.from(JSON.stringify(aad)));
 const clear=digestStream(),encrypted=digestStream();
 await pipeline(input,clear.stream,cipher,encrypted.stream,createWriteStream(file,{flags:'wx',mode:0o600,flush:true}));
 return {aad,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),plaintext:clear.result(),ciphertext:encrypted.result(),filename:path.basename(file)};
}
export async function decryptStream(directory,record,key,output=new Writable({write(chunk,encoding,done){done();}})){
 if(!allowed.has(record.aad?.component)||record.filename!==record.aad.component+'.enc'||!/^\w[\w.-]*$/.test(record.filename)||!/^[0-9a-f]{24}$/.test(record.iv??'')||!/^[0-9a-f]{32}$/.test(record.tag??''))throw Error('snapshot_component_invalid');
 const file=path.join(directory,record.filename),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('snapshot_component_invalid');
 const decipher=createDecipheriv('aes-256-gcm',keyFor(key,record.aad.component),Buffer.from(record.iv,'hex'));decipher.setAAD(Buffer.from(JSON.stringify(record.aad)));decipher.setAuthTag(Buffer.from(record.tag,'hex'));
 const encrypted=digestStream(),clear=digestStream();
 await pipeline(createReadStream(file),encrypted.stream,decipher,clear.stream,output);
 const a=encrypted.result(),b=clear.result();if(a.sha256!==record.ciphertext.sha256||a.bytes!==record.ciphertext.bytes||b.sha256!==record.plaintext.sha256||b.bytes!==record.plaintext.bytes)throw Error('snapshot_component_hash_mismatch');
 return {component:record.aad.component,bytes:b.bytes,sha256:b.sha256};
}
export async function loadSnapshot(directory,key,{now=Date.now(),verifyBytes=true,allowExpired=false}={}){
 const real=await fs.realpath(directory);if(real!==path.resolve(directory))throw Error('snapshot_symlink_rejected');
 const envelope=JSON.parse(await fs.readFile(path.join(real,'manifest.json'),'utf8')),payload=envelope.payload;
 if(payload?.protocol!==PROTOCOL||!equalHex(envelope.hmac_sha256,signature(payload,key))||!Number.isSafeInteger(payload.created_at)||payload.expires_at-payload.created_at!==SEVEN_DAYS||payload.created_at>now+60000||!allowExpired&&payload.expires_at<=now||!Array.isArray(payload.components)||payload.components.length!==allowed.size||new Set(payload.components.map(record=>record.aad?.component)).size!==allowed.size)throw Error('snapshot_manifest_invalid_or_expired');
 for(const record of payload.components){if(!allowed.has(record.aad?.component)||record.filename!==record.aad.component+'.enc'||record.aad.snapshot_id!==payload.snapshot_id||record.aad.protocol!==PROTOCOL||record.aad.created_at!==payload.created_at)throw Error('snapshot_component_binding_mismatch');if(verifyBytes)await decryptStream(real,record,key);}
 return payload;
}
export async function expireSnapshot(directory,key,now=Date.now()){
 const manifest=await loadSnapshot(directory,key,{now,verifyBytes:false,allowExpired:true});
 if(manifest.expires_at>now)return {snapshot_id:manifest.snapshot_id,status:'retained_not_expired'};
 const names=new Set(['manifest.json','resumption.json',...manifest.components.map(record=>record.filename)]);
 const entries=await fs.readdir(directory,{withFileTypes:true});
 if(entries.some(entry=>!entry.isFile()||!names.has(entry.name)))throw Error('unexpected_snapshot_content_preserved');
 for(const entry of entries)await fs.unlink(path.join(directory,entry.name));await fs.rmdir(directory);
 return {snapshot_id:manifest.snapshot_id,status:'expired_encrypted_bundle_removed',expired_at:manifest.expires_at};
}
async function captureProcess(executable,argv,file,key,aad){
 const process=spawn(executable,argv,{stdio:['ignore','pipe','pipe']});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;process.kill('SIGKILL');},60*60*1000);process.stderr.resume();
 let prefix=Buffer.alloc(0);process.stdout.on('data',chunk=>{if(prefix.length<5)prefix=Buffer.concat([prefix,chunk.subarray(0,5-prefix.length)]);});
 const completion=new Promise((resolve,reject)=>{process.once('error',()=>reject(Error('snapshot_producer_unavailable')));process.once('close',code=>code===0&&!timedOut?resolve():reject(Error('snapshot_producer_failed')));});
 try{const [record]=await Promise.all([encryptStream(process.stdout,file,key,aad),completion]);if(aad.component.endsWith('.dump')&&prefix.toString('ascii')!=='PGDMP')throw Error('database_archive_format_invalid');return record;}catch(error){process.kill('SIGKILL');throw error;}finally{clearTimeout(timer);}
}
const volumeTar=(volume)=>['run','--rm','--network','none','--read-only','--cap-drop','ALL','--cap-add','DAC_READ_SEARCH','--security-opt','no-new-privileges','--mount','type=volume,src='+volume+',dst=/snapshot,readonly','--entrypoint','tar',helperImage,'--one-file-system','-C','/snapshot','-cf','-','.'];
const parseComposePS=text=>{const value=text.trim();if(!value)return [];return value.startsWith('[')?JSON.parse(value):value.split('\n').map(line=>JSON.parse(line));};
export const createSnapshot=(r,directory)=>withOperationLock(r,'coordinated-snapshot',()=>createSnapshotLocked(r,directory));
async function createSnapshotLocked(r,directory){
 await requireCompose();if(!path.isAbsolute(directory))throw Error('absolute_new_snapshot_directory_required');
 await fs.mkdir(directory,{mode:0o700});const key=await backupKey(r.directory),snapshotID=randomUUID(),created=Date.now();
 const running=parseComposePS((await compose(r,'application',['ps','--format','json'])).stdout.toString()).filter(value=>value.State==='running').map(value=>value.Service);
 const publicRunning=running.includes('public-proxy'),writers=running.filter(name=>['functions','push-provider','auth','rest','storage','realtime','supavisor','studio','meta','ml-proxy'].includes(name));
 const active=(await sql(r,"SELECT COALESCE(bool_or(active),false) FROM cron.job WHERE jobname='lovelies-private-maintenance';")).text==='t';
 let resumed=false;
 try{
  if(publicRunning)await compose(r,'application',['stop','public-proxy']);
  await sql(r,"SELECT cron.alter_job(jobid,active:=false) FROM cron.job WHERE jobname='lovelies-private-maintenance';");
  if(writers.length)await compose(r,'application',['stop',...writers],{timeout:180000});
  const journal=await privateRequest(r,'restore-journal','/v1/control'),push=await privateRequest(r,'push-ledger','/v2/control');
  const objects=JSON.parse((await sql(r,"SELECT json_build_object('objects',(SELECT count(*) FROM storage.objects),'private_buckets',(SELECT count(*) FROM storage.buckets WHERE id IN ('lovelies-photos','lovelies-quarantine','lovelies-privacy-exports') AND NOT public));")).text);
  const components=[];
  const capture=async(component,executable,argv)=>components.push(await captureProcess(executable,argv,path.join(directory,component+'.enc'),key,{protocol:PROTOCOL,snapshot_id:snapshotID,component,created_at:created}));
  await capture('application.dump','docker',[...composeArgs(r,'application'),'exec','-T','db','pg_dump','-U','supabase_admin','-d','postgres','--format=custom']);
  await capture('storage.tar','docker',volumeTar('lovelies-app-storage'));
  // Upstream db-config contains the separately stored Vault/pgsodium key.
  const configVolume=JSON.parse((await compose(r,'application',['config','--format','json'])).stdout.toString()).volumes['db-config'].name;
  if(!/^[a-zA-Z0-9_.-]+$/.test(configVolume))throw Error('database_config_volume_invalid');
  await capture('application-db-config.tar','docker',volumeTar(configVolume));
  await capture('custody.dump','docker',[...composeArgs(r,'custody'),'exec','-T','custody-db','pg_dump','-U','supabase_admin','-d','postgres','--format=custom']);
  await capture('custody-db-config.tar','docker',volumeTar('lovelies-custody-db-config'));
  await capture('runtime-escrow.tar','tar',['--one-file-system','--exclude=backup.key','-C',r.directory,'-cf','-','app.env','api.env','custody.env','push.env','ml.env','rotation.env','config.json','tls','providers','lifecycle','managed-auth-rotations']);
  const journalAfter=await privateRequest(r,'restore-journal','/v1/control'),pushAfter=await privateRequest(r,'push-ledger','/v2/control');
  if(JSON.stringify(journal)!==JSON.stringify(journalAfter)||JSON.stringify(push)!==JSON.stringify(pushAfter))throw Error('custody_changed_during_quiesced_snapshot');
  const payload={protocol:PROTOCOL,snapshot_id:snapshotID,created_at:created,expires_at:created+SEVEN_DAYS,public_api_base_url:r.config.public_api_base_url,postgres_image:r.config.postgres_image,
   schema_version:r.config.expected_schema_version,journal,push,storage_inventory:objects,components,
   restore_policy:{application:['application.dump','storage.tar','application-db-config.tar'],independent_custody:['custody.dump','custody-db-config.tar'],offline_escrow:['runtime-escrow.tar'],custody_rollback_with_application:false},
   qualification:'encrypted_coordinated_snapshot_restore_not_yet_proven'};
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({payload,hmac_sha256:signature(payload,key)},null,2)+'\n',{flag:'wx',mode:0o600});
  await loadSnapshot(directory,key);
  return {protocol:'lovelies-local-supabase-snapshot-receipt-v1',snapshot_id:snapshotID,created_at:created,expires_at:created+SEVEN_DAYS,components:components.map(value=>({component:value.aad.component,encrypted_bytes:value.ciphertext.bytes,sha256:value.ciphertext.sha256})),status:'encrypted_snapshot_verified_restore_drill_required'};
 }finally{
  // No database restore occurs here. Resume only services that were running.
  try{if(writers.length)await compose(r,'application',['start','--wait','--wait-timeout','180',...writers],{timeout:210000});
   if(active)await sql(r,"SELECT cron.alter_job(jobid,active:=true) FROM cron.job WHERE jobname='lovelies-private-maintenance';");
   if(publicRunning)await compose(r,'application',['start','public-proxy']);resumed=true;
  }finally{await fs.writeFile(path.join(directory,'resumption.json'),JSON.stringify({at:new Date().toISOString(),previous_services_resumed:resumed,public_proxy_previously_running:publicRunning})+'\n',{mode:0o600,flag:'wx'});}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [operation,...rest]=process.argv.slice(2),options=args(rest,['--runtime','--directory','--execute','--receipt'],['--execute']);
 (async()=>{const r=await runtime(options['--runtime']);let result;
  if(operation==='create'){if(!options['--execute'])throw Error('explicit_execute_required');result=await createSnapshot(r,options['--directory']);}
  else if(operation==='verify'){const value=await loadSnapshot(options['--directory'],await backupKey(r.directory));result={protocol:'lovelies-local-supabase-snapshot-verification-v1',snapshot_id:value.snapshot_id,verified_at:new Date().toISOString(),status:'authenticated_components_verified_not_restore_qualified'};}
  else if(operation==='expire'){if(!options['--execute'])throw Error('explicit_execute_required');result=await expireSnapshot(options['--directory'],await backupKey(r.directory));}
  else throw Error('operation_invalid');
  if(options['--receipt'])await writeReceipt(options['--receipt'],result);console.log(JSON.stringify(result,null,2));
 })().catch(()=>{console.error('Snapshot operation did not complete. Preserve partial encrypted files; check resumption.json before reopening traffic. No database or custody restore was attempted.');process.exitCode=1;});
}
