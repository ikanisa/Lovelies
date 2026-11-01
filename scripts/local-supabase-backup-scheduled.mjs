#!/usr/bin/env node
/** Host timer entrypoint. Backup bytes and scheduling authority remain local. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {args,runtime} from './local-supabase-common.mjs';
import {backupKey,createSnapshot,expireSnapshot} from './local-supabase-backup.mjs';
const options=args(process.argv.slice(2),['--runtime','--directory']);
(async()=>{
 const r=await runtime(options['--runtime']),directory=options['--directory'];if(!directory||!path.isAbsolute(directory))throw Error('absolute_backup_root_required');
 await fs.mkdir(directory,{mode:0o700,recursive:true});const stat=await fs.lstat(directory);if(!stat.isDirectory()||(stat.mode&0o077)!==0)throw Error('private_backup_root_required');
 const destination=path.join(directory,'snapshot-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
 const receipt=await createSnapshot(r,destination),key=await backupKey(r.directory),expired=[];
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^snapshot-\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[0-9a-f-]{36}$/.test(entry.name))continue;
  const candidate=path.join(directory,entry.name);if(candidate===destination)continue;
  try{expired.push(await expireSnapshot(candidate,key));}catch{expired.push({directory:entry.name,status:'preserved_requires_operator_review'});}
 }
 console.log(JSON.stringify({protocol:'lovelies-local-supabase-scheduled-backup-v1',completed_at:new Date().toISOString(),receipt,expiry:expired}));
})().catch(()=>{console.error('Scheduled snapshot failed; inspect the private snapshot directory and service resumption status.');process.exitCode=1;});
