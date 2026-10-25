/** Restricted operator backups. No application/Storage credentials or serving restore. */
import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import {PassThrough,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';

export const PROJECT='ltqfplqevxztlswlzexn';
export const BACKUP_TTL=7*86400000;
const MAXIMUM=512*1024*1024,MAGIC=Buffer.from('LVBK0001');
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const manifestPattern=/^lovelies-db-([0-9a-f-]{36})\.json$/;
const fail=code=>Object.assign(new Error(code),{code});
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,Object.keys(value).sort());

export function backupKey(text){
  if(typeof text!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(text))throw fail('backup_key_invalid');
  const key=Buffer.from(text,'base64url');
  if(key.length!==32||key.toString('base64url')!==text)throw fail('backup_key_invalid');
  return key;
}
function keys(key){
  if(!Buffer.isBuffer(key)||key.length!==32)throw fail('backup_key_invalid');
  const derive=purpose=>Buffer.from(hkdfSync('sha256',key,Buffer.from('lovelies-backup-v1'),Buffer.from(purpose),32));
  return {encryption:derive('archive-encryption'),manifest:derive('catalog-authentication'),id:sha(key).slice(0,24)};
}
export async function backupDirectory(directory){
  if(!path.isAbsolute(directory))throw fail('backup_directory_invalid');
  // Every existing ancestor is real. Never follow a substituted output symlink.
  let current=path.parse(directory).root;
  for(const part of directory.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try{const item=await fs.lstat(current);if(!item.isDirectory()||item.isSymbolicLink())throw fail('backup_directory_invalid');}
    catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(current,{mode:0o700});}
  }
  const stat=await fs.lstat(directory);
  if(stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw fail('backup_directory_permissions');
  return directory;
}
async function regular(file){
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw fail('backup_file_invalid');
  return stat;
}
async function locked(directory,work){
  await backupDirectory(directory);
  const name=path.join(directory,'.lovelies-backup.lock');
  const handle=await fs.open(name,'wx',0o600);
  try{await handle.writeFile(JSON.stringify({pid:process.pid}));await handle.sync();return await work();}
  finally{await handle.close();await fs.unlink(name);}
}
async function syncDirectory(directory){const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
async function writeAll(handle,bytes){let at=0;while(at<bytes.length){const {bytesWritten}=await handle.write(bytes,at,bytes.length-at);if(!bytesWritten)throw fail('backup_write_incomplete');at+=bytesWritten;}}
function prefix(previous,chunk){return Buffer.concat([previous,chunk.subarray(0,Math.max(0,5-previous.length))]);}
function headerBytes(header){const data=Buffer.from(canonical(header));const length=Buffer.alloc(4);length.writeUInt32BE(data.length);return Buffer.concat([MAGIC,length,data]);}
function signature(metadata,key){return createHmac('sha256',key).update(canonical(metadata)).digest('hex');}
function signed(metadata,key){return {...metadata,mac:signature(metadata,key)};}
function checkManifest(value,key,environment){
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail('backup_manifest_invalid');
  const {mac,...metadata}=value;
  if(typeof mac!=='string'||!/^[0-9a-f]{64}$/.test(mac)||!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(signature(metadata,key),'hex')))throw fail('backup_manifest_authentication');
  const names=['protocol','project','environment','id','created_at','completed_at','expires_at','key_id','archive','archive_bytes','archive_sha256','plaintext_bytes','plaintext_sha256'];
  if(Object.keys(metadata).sort().join('|')!==names.sort().join('|')||metadata.protocol!=='lovelies-db-backup-v1'||metadata.project!==PROJECT||metadata.environment!==environment||!idPattern.test(metadata.id)||
    metadata.archive!==`lovelies-db-${metadata.id}.lvbk`||![metadata.created_at,metadata.completed_at,metadata.expires_at,metadata.archive_bytes,metadata.plaintext_bytes].every(Number.isSafeInteger)||
    metadata.created_at<0||metadata.completed_at<metadata.created_at||metadata.expires_at!==metadata.created_at+BACKUP_TTL||metadata.completed_at>=metadata.expires_at||
    metadata.archive_bytes<28||metadata.archive_bytes>MAXIMUM+4096||metadata.plaintext_bytes<5||metadata.plaintext_bytes>MAXIMUM||
    !/^[0-9a-f]{64}$/.test(metadata.archive_sha256)||!/^[0-9a-f]{64}$/.test(metadata.plaintext_sha256)||!/^[0-9a-f]{24}$/.test(metadata.key_id))throw fail('backup_manifest_invalid');
  return metadata;
}
function environmentName(value){if(!['production','local-qualification'].includes(value))throw fail('backup_environment_invalid');return value;}
function archiveRead(file,handle,options={}){return handle?handle.createReadStream({...options,autoClose:false}):createReadStream(file,options);}
async function hashFile(file,handle){const hash=createHash('sha256');for await(const chunk of archiveRead(file,handle,{start:0}))hash.update(chunk);return hash.digest('hex');}
async function loadManifest(directory,id,key,environment){
  if(!idPattern.test(id))throw fail('backup_id_invalid');
  const derived=keys(key),manifestFile=path.join(directory,`lovelies-db-${id}.json`);
  const ms=await regular(manifestFile);if(ms.size>4096)throw fail('backup_manifest_invalid');
  const metadata=checkManifest(JSON.parse(await fs.readFile(manifestFile,'utf8')),derived.manifest,environment);
  if(metadata.id!==id||metadata.key_id!==derived.id)throw fail('backup_manifest_invalid');
  return {metadata,manifestFile,manifestStat:ms,derived};
}
async function verifyUnlocked(directory,id,key,environment,snapshot){
  const {metadata,manifestFile,manifestStat:ms,derived}=await loadManifest(directory,id,key,environment);
  const archive=path.join(directory,metadata.archive),original=await regular(archive),as=snapshot?await snapshot.stat():original;
  if(original.size!==metadata.archive_bytes||as.size!==metadata.archive_bytes||await hashFile(archive,snapshot)!==metadata.archive_sha256)throw fail('backup_archive_integrity');
  const handle=snapshot??await fs.open(archive,'r');let encoded,tag;
  try{
    const prefix=Buffer.alloc(12);if((await handle.read(prefix,0,12,0)).bytesRead!==12||!prefix.subarray(0,8).equals(MAGIC))throw fail('backup_header_invalid');
    const size=prefix.readUInt32BE(8);if(size<2||size>2048||as.size<12+size+16)throw fail('backup_header_invalid');
    encoded=Buffer.alloc(12+size);if((await handle.read(encoded,0,encoded.length,0)).bytesRead!==encoded.length)throw fail('backup_header_invalid');
    tag=Buffer.alloc(16);if((await handle.read(tag,0,16,as.size-16)).bytesRead!==16)throw fail('backup_archive_integrity');
  }finally{if(!snapshot)await handle.close();}
  const header=JSON.parse(encoded.subarray(12).toString('utf8'));
  if(!headerBytes(header).equals(encoded)||Object.keys(header).sort().join('|')!==['algorithm','created_at','environment','expires_at','format','id','iv','key_id','project','protocol','schema'].sort().join('|')||
    header.protocol!=='lovelies-db-backup-v1'||header.project!==PROJECT||header.environment!==environment||header.id!==id||header.created_at!==metadata.created_at||header.expires_at!==metadata.expires_at||
    header.algorithm!=='AES-256-GCM'||header.schema!=='lovelies_private'||header.format!=='pg_dump_custom'||header.key_id!==derived.id||typeof header.iv!=='string'||!/^[A-Za-z0-9_-]{16}$/.test(header.iv))throw fail('backup_header_invalid');
  const decrypt=()=>{const cipher=createDecipheriv('aes-256-gcm',derived.encryption,Buffer.from(header.iv,'base64url'));cipher.setAAD(encoded);cipher.setAuthTag(tag);return cipher;};
  const hash=createHash('sha256');let bytes=0,magic=Buffer.alloc(0);
  await pipeline(archiveRead(archive,snapshot,{start:encoded.length,end:as.size-17}),decrypt(),new Writable({write(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);if(magic.length<5)magic=prefix(magic,chunk);chunk.fill(0);done();}}));
  if(bytes!==metadata.plaintext_bytes||hash.digest('hex')!==metadata.plaintext_sha256||magic.toString()!=='PGDMP')throw fail('backup_plaintext_integrity');
  derived.encryption.fill(0);derived.manifest.fill(0);
  return {metadata,archive,archiveStat:as,manifestFile,manifestStat:ms,encoded,tag,iv:header.iv};
}

export async function verifyBackup({directory,id,key,environment='production'}){
  environmentName(environment);
  return locked(directory,async()=>{const {metadata}=await verifyUnlocked(directory,id,key,environment);return metadata;});
}

/** Verify and consume the same unlinked encrypted snapshot. Reopening the catalog
 * path after verification could stream changed, unauthenticated plaintext before
 * GCM's final rejection. The consumer still requires an isolated recovery target. */
export async function withVerifiedBackup({directory,id,key,environment='production'},consume){
  environmentName(environment);
  return locked(directory,async()=>{
    const record=await loadManifest(directory,id,key,environment),metadata=record.metadata;
    record.derived.encryption.fill(0);record.derived.manifest.fill(0);
    const archive=path.join(directory,metadata.archive),original=await regular(archive);
    if(original.size!==metadata.archive_bytes)throw fail('backup_archive_integrity');
    const temporary=path.join(directory,`.lovelies-verified-${randomUUID()}`),snapshot=await fs.open(temporary,'wx+',0o600);
    try{
      // There is never a plaintext file. Unlink before copying so a crash cannot
      // leave an untracked extra archive; the private descriptor owns its life.
      await fs.unlink(temporary);
      await pipeline(createReadStream(archive,{start:0,end:metadata.archive_bytes-1}),new Writable({write(chunk,encoding,done){writeAll(snapshot,chunk).then(()=>done(),done);}}));
      await snapshot.chmod(0o400);
      const verified=await verifyUnlocked(directory,id,key,environment,snapshot),derived=keys(key);
      const cipher=createDecipheriv('aes-256-gcm',derived.encryption,Buffer.from(verified.iv,'base64url'));
      cipher.setAAD(verified.encoded);cipher.setAuthTag(verified.tag);
      const output=new PassThrough(),transfer=pipeline(archiveRead(verified.archive,snapshot,{start:verified.encoded.length,end:verified.archiveStat.size-17}),cipher,output);
      try{return (await Promise.all([transfer,Promise.resolve().then(()=>consume(output,verified.metadata))]))[1];}
      catch(error){output.destroy();await transfer.catch(()=>{});throw error;}
      finally{derived.encryption.fill(0);derived.manifest.fill(0);}
    }finally{await snapshot.close();}
  });
}

export async function createBackup({directory,source,sourceCompleted=Promise.resolve(),key,environment='production',now=Date.now}){
  environmentName(environment);const derived=keys(key);
  // Attach a rejection handler immediately; a producer may fail before EOF.
  const completed=sourceCompleted.then(()=>null,error=>error);
  return locked(directory,async()=>{
    const id=randomUUID(),created=now();if(!Number.isSafeInteger(created)||created<0)throw fail('backup_clock_invalid');
    const header={protocol:'lovelies-db-backup-v1',project:PROJECT,environment,id,created_at:created,expires_at:created+BACKUP_TTL,key_id:derived.id,
      algorithm:'AES-256-GCM',schema:'lovelies_private',format:'pg_dump_custom',iv:randomBytes(12).toString('base64url')};
    const encoded=headerBytes(header),archive=`lovelies-db-${id}.lvbk`,temporary=path.join(directory,archive+'.partial'),final=path.join(directory,archive);
    const handle=await fs.open(temporary,'wx',0o600);let renamed=false;
    try{
      await writeAll(handle,encoded);
      const cipher=createCipheriv('aes-256-gcm',derived.encryption,Buffer.from(header.iv,'base64url'));cipher.setAAD(encoded);
      const hash=createHash('sha256');let bytes=0,magic=Buffer.alloc(0);
      const count=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>MAXIMUM)return done(fail('backup_size_exceeded'));hash.update(chunk);if(magic.length<5)magic=prefix(magic,chunk);done(null,chunk);}});
      // Keep the one opened file descriptor through header/ciphertext/tag/fsync.
      await pipeline(source,count,cipher,new Writable({write(chunk,encoding,done){writeAll(handle,chunk).then(()=>done(),done);}}));
      const producerError=await completed;if(producerError)throw producerError;
      if(magic.toString()!=='PGDMP'||bytes<5)throw fail('backup_source_format');
      await writeAll(handle,cipher.getAuthTag());await handle.sync();await handle.close();
      const finished=now();if(!Number.isSafeInteger(finished)||finished<created||finished>=header.expires_at)throw fail('backup_clock_invalid');
      const metadata={protocol:header.protocol,project:PROJECT,environment,id,created_at:created,completed_at:finished,expires_at:header.expires_at,key_id:derived.id,
        archive,archive_bytes:(await regular(temporary)).size,archive_sha256:await hashFile(temporary),plaintext_bytes:bytes,plaintext_sha256:hash.digest('hex')};
      await fs.rename(temporary,final);renamed=true;await syncDirectory(directory);
      const catalog=path.join(directory,`lovelies-db-${id}.json`),pending=catalog+'.partial';
      const mh=await fs.open(pending,'wx',0o600);try{await mh.writeFile(JSON.stringify(signed(metadata,derived.manifest))+'\n');await mh.sync();}finally{await mh.close();}
      await fs.rename(pending,catalog);await syncDirectory(directory);
      await verifyUnlocked(directory,id,key,environment);
      return metadata;
    }catch(error){
      try{await handle.close();}catch{}
      if(!renamed)try{await fs.unlink(temporary);}catch(cleanup){if(cleanup.code!=='ENOENT')throw new AggregateError([error,cleanup],'backup_failure_cleanup');}
      // An orphan final archive is preserved for reconciliation, never adopted.
      throw error;
    }
  });
}

export async function backupCatalog({directory,key,environment='production'}){
  environmentName(environment);
  return locked(directory,async()=>{
    const entries=await fs.readdir(directory),backups=[],unknown=[];
    for(const name of entries.sort()){
      if(name==='.lovelies-backup.lock')continue;
      const match=manifestPattern.exec(name);
      if(match){backups.push((await verifyUnlocked(directory,match[1],key,environment)).metadata);}
      else if(!/^lovelies-db-[0-9a-f-]{36}\.lvbk$/.test(name))unknown.push(name);
    }
    const owned=new Set(backups.map(x=>x.archive));
    for(const name of entries)if(name.endsWith('.lvbk')&&!owned.has(name))unknown.push(name);
    return {backups,unmanaged_entries:unknown};
  });
}

export async function expireBackups({directory,key,environment='production',now=Date.now}){
  environmentName(environment);const at=now();if(!Number.isSafeInteger(at)||at<0)throw fail('backup_clock_invalid');
  return locked(directory,async()=>{
    const candidates=[],entries=(await fs.readdir(directory)).sort(),known=new Set(['.lovelies-backup.lock']);
    // Validate the entire recognized catalog before deleting any managed pair.
    for(const name of entries){
      const match=manifestPattern.exec(name);if(!match)continue;
      const record=await loadManifest(directory,match[1],key,environment);
      known.add(name);known.add(record.metadata.archive);
      let verified;
      try{verified=await verifyUnlocked(directory,match[1],key,environment);}
      catch(error){
        // Recover only the authenticated, expired catalog half of an interrupted
        // payload-first deletion. Any extant/replaced payload still needs proof.
        if(error.code!=='ENOENT'||record.metadata.expires_at>at)throw error;
        try{await fs.lstat(path.join(directory,record.metadata.archive));throw fail('backup_file_changed');}
        catch(absent){if(absent.code!=='ENOENT')throw absent;}
        verified={...record,archive:path.join(directory,record.metadata.archive),missing:true};
      }
      if(verified.metadata.created_at>at+120000)throw fail('backup_clock_invalid');
      if(verified.metadata.expires_at<=at)candidates.push(verified);
    }
    for(const prior of candidates){
      if(prior.missing){
        const current=await loadManifest(directory,prior.metadata.id,key,environment);
        if(current.manifestStat.ino!==prior.manifestStat.ino||canonical(current.metadata)!==canonical(prior.metadata))throw fail('backup_file_changed');
        try{await fs.lstat(prior.archive);throw fail('backup_file_changed');}catch(absent){if(absent.code!=='ENOENT')throw absent;}
        await fs.unlink(current.manifestFile);await syncDirectory(directory);continue;
      }
      const current=await verifyUnlocked(directory,prior.metadata.id,key,environment);
      if(current.archiveStat.ino!==prior.archiveStat.ino||current.manifestStat.ino!==prior.manifestStat.ino)throw fail('backup_file_changed');
      // Remove the encrypted payload first. A crash cannot leave an untracked copy.
      await fs.unlink(current.archive);await syncDirectory(directory);await fs.unlink(current.manifestFile);await syncDirectory(directory);
    }
    return {expired:candidates.length,unmanaged_entries:entries.filter(name=>!known.has(name)).length};
  });
}
