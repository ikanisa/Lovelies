/** Private durable lifecycle files. No automatic recovery from an unknown file. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LIFECYCLE_PROTOCOL,validateLifecycleGate} from '../deploy/local-supabase/functions-main/lifecycle-gate.mjs';
import {keyFingerprint,digest} from './local-supabase-managed-auth-rotation-core.mjs';

export async function privateRead(filename, {maximum=262144, publicFile=false}={}) {
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await handle.stat();
  if(!before.isFile()||before.nlink!==1||before.size>maximum||(before.mode&(publicFile?0o022:0o077))!==0)throw Error('rotation_private_file_invalid');
  const value=await handle.readFile();const after=await handle.stat();
  if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||value.length>maximum)throw Error('rotation_private_file_changed');
  return value;
 }finally{await handle.close();}
}
export async function syncDirectory(directory){const handle=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}}
async function finishDurability(filename){
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)throw Error('rotation_private_file_invalid');await handle.sync();}finally{await handle.close();}
 await syncDirectory(path.dirname(filename));
}
export async function readDurable(filename,options={}){
 const value=await privateRead(filename,options);let readback;
 try{await finishDurability(filename);readback=await privateRead(filename,options);
  if(!readback.equals(value))throw Error('rotation_private_file_changed');return value;
 }catch(error){value.fill(0);throw error;}finally{readback?.fill(0);}
}
export async function writeImmutable(filename,bytes,{afterStaging,afterPublication}={}){
 const directory=path.dirname(filename),temporary=path.join(directory,'.publication-'+path.basename(filename)+'-'+randomUUID());
 const handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 // A final record is visible only after all its bytes are durable. link() is an
 // atomic no-replace publication; an unrelated existing record is never erased.
 await afterStaging?.();
 try{await fs.link(temporary,filename);await afterPublication?.();await fs.unlink(temporary);await syncDirectory(directory);}
 catch(error){await fs.rm(temporary,{force:true});await syncDirectory(directory);throw error;}
}
export async function readImmutable(filename,options={}){
 const stat=await fs.lstat(filename),directory=path.dirname(filename),prefix='.publication-'+path.basename(filename)+'-';
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('rotation_private_file_invalid');
 if(stat.nlink!==1){
  // A process can die after the atomic link and before unlinking its staging
  // name. Recover only the single same-directory, same-inode publication link.
  // Other hard links, symlinks and unknown final contents remain untrusted.
  const matches=[];
  for(const name of await fs.readdir(directory))if(name.startsWith(prefix)&&/^[0-9a-f-]{36}$/.test(name.slice(prefix.length))){
   const candidate=path.join(directory,name),info=await fs.lstat(candidate);
   if(info.isFile()&&!info.isSymbolicLink()&&info.dev===stat.dev&&info.ino===stat.ino)matches.push(candidate);
  }
  if(stat.nlink!==2||matches.length!==1)throw Error('rotation_immutable_publication_unknown');
  await fs.unlink(matches[0]);await syncDirectory(directory);
 }
 return readDurable(filename,options);
}
export async function compareAndSwapFile(filename,beforeSha,bytes,{afterRename,afterRenameBeforeSync,mode=0o600}={}){
 const prior=await privateRead(filename,{publicFile:mode===0o644});
 const next=Buffer.from(bytes);let temporary;
 const currentHash=async()=>{const value=await privateRead(filename,{publicFile:mode===0o644});try{return digest(value);}finally{value.fill(0);}};
 try{if(digest(prior)===digest(next)){
  await finishDurability(filename);
  if(await currentHash()!==digest(next))throw Error('rotation_configuration_changed');
  return 'already_applied';
 }
 if(digest(prior)!==beforeSha)throw Error('rotation_configuration_changed');
 temporary=path.join(path.dirname(filename),'.rotation-'+randomUUID());
 const handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);
 try{await handle.writeFile(next);await handle.sync();}finally{await handle.close();}
 try{
  if(await currentHash()!==beforeSha)throw Error('rotation_configuration_changed');
  await fs.rename(temporary,filename);await afterRenameBeforeSync?.();await syncDirectory(path.dirname(filename));await afterRename?.();
  if(await currentHash()!==digest(next))throw Error('rotation_configuration_readback_failed');
  return 'applied';
 }finally{await fs.rm(temporary,{force:true});}
 }finally{prior.fill(0);next.fill(0);}
}
export const lifecyclePath=directory=>path.join(directory,'lifecycle','gate.json');
export async function readLifecycle(directory){
 const base=path.join(directory,'lifecycle'),stat=await fs.lstat(base);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o022)!==0)throw Error('rotation_lifecycle_directory_invalid');
 return validateLifecycleGate(JSON.parse((await privateRead(lifecyclePath(directory),{publicFile:true,maximum:2048})).toString()));
}
export async function requireOpenLifecycle(directory,key){const gate=await readLifecycle(directory);if(gate.state!=='open'||gate.key_sha256!==keyFingerprint(key))throw Error('rotation_lifecycle_closed');return gate;}
export async function setLifecycle(directory,gate){
 validateLifecycleGate(gate);const filename=lifecyclePath(directory),before=await privateRead(filename,{publicFile:true,maximum:2048});
 await compareAndSwapFile(filename,digest(before),JSON.stringify(gate)+'\n',{mode:0o644});
}
export const lifecycle=(state,rotation_id,key)=>({protocol:LIFECYCLE_PROTOCOL,state,rotation_id,key_sha256:keyFingerprint(key)});
