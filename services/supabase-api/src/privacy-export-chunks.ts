import { ApiError, digest, stable, type AppContext } from './types.ts';
import { privacyExportDatasets } from './privacy-export-catalog.ts';
import { IncrementalSha256, type Sha256State } from './incremental-sha256.ts';
import { completeUndispatchedMediaWrite, settleMediaWrite } from './operations.ts';
import { readPrivateBytes } from './private-body.ts';

export const EXPORT_CHUNK_BYTES=1048576;
export const EXPORT_MANIFEST_PAGE=128;
export const EXPORT_FLAT_BYTES=20*1024*1024;
export const EXPORT_CHUNKS_PROTOCOL='lovelies-privacy-export-chunks-v1';
const encoder=new TextEncoder(),ttl=24*60*60*1000,hash=/^[0-9a-f]{64}$/;
type Snapshot={id:string;request_id:string;subject_id:string;generated_at:number;status:string;segment_count:number;row_count:number;
 total_bytes:number;cursor_seq:number;cursor_offset:number;emitted_bytes:number;chunk_count:number;hash_state_json:string;chain_sha256:string;
 sha256:string|null;root_write_id:string|null;expires_at:number};
export type ExportChunk={publication_id:string;chunk_index:number;bytes:number;sha256:string;root_sha256:string;object_key:string;
 write_intent_id:string;status:string;start_seq:number;start_offset:number;end_seq:number;end_offset:number;hash_state_json:string;created_at:number};
type Lease=()=>Promise<unknown>;
const invalid=():never=>{throw new ApiError(503,'privacy_export_snapshot_unverified');};
const number=(value:number):number=>{if(!Number.isSafeInteger(value)||value<0)return invalid();return value;};
function state(row:Snapshot):Sha256State{
 try{const value=JSON.parse(row.hash_state_json) as Sha256State;const parsed=new IncrementalSha256(value);
 if(value.bytes!==row.emitted_bytes)return invalid();parsed.clear();return value;}catch{return invalid();}
}
async function snapshot(ctx:AppContext,id:string,subject:string):Promise<Snapshot>{
 const row=await ctx.db.one<Snapshot>('SELECT * FROM privacy_export_snapshots WHERE id=? AND subject_id=?',id,subject);
 if(!row||!['building','publishing','completed'].includes(row.status)||row.expires_at<=ctx.now())return invalid();
 for(const n of [row.segment_count,row.row_count,row.total_bytes,row.cursor_seq,row.cursor_offset,row.emitted_bytes,row.chunk_count])number(n);
 if(row.total_bytes<1||row.cursor_seq>row.segment_count||row.emitted_bytes>row.total_bytes||!hash.test(row.chain_sha256))return invalid();
 if(row.status!=='completed')state(row);return row;
}
export const exportManifestSeed=(publication_id:string):Promise<string>=>digest(stable({protocol:EXPORT_CHUNKS_PROTOCOL,publication_id}));
export const exportManifestNext=(previous_sha256:string,index:number,bytes:number,sha256:string):Promise<string>=>digest(stable({previous_sha256,index,bytes,sha256}));

/** One INSERT SELECT materializes every source projection at a single PostgreSQL
 * statement snapshot, even if an out-of-band writer ignores the application
 * advisory lock. Byte counts stay in PostgreSQL; JS never receives an account-
 * sized row array. A crash either leaves the whole snapshot or none.
 * Subsequent jobs never reread mutable source tables. */
export async function captureExportSnapshot(ctx:AppContext,requestId:string,subject:string,lease:Lease):Promise<string>{
 return ctx.db.transaction(async()=>{
  await lease();
  const previous=await ctx.db.one<{id:string}>('SELECT id FROM privacy_export_snapshots WHERE request_id=? AND subject_id=?',requestId,subject);
  if(previous){await snapshot(ctx,previous.id,subject);return previous.id;}
  const id=crypto.randomUUID(),now=ctx.now(),key=`privacy/${subject}/${requestId}/${id}.json`,seed=await exportManifestSeed(id);
  await ctx.db.run("INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES(?,?,?,?,?,1,?,'pending',?)",id,requestId,subject,key,'0'.repeat(64),now+ttl,now);
  await ctx.db.run(`INSERT INTO privacy_export_snapshots(id,request_id,subject_id,generated_at,status,hash_state_json,chain_sha256,expires_at)
   VALUES(?,?,?,?,'capturing',?,?,?)`,id,requestId,subject,now,stable(new IncrementalSha256().state()),seed,now+ttl);
  const segments=["SELECT -1 dataset,0 phase,0::bigint ordinal,?::text payload"],bindings:string[]=[
   '{"schema_version":2,"inventory_version":"supabase-personal-data-v2","subject_user_id":'+JSON.stringify(subject)+',"generated_at":'+JSON.stringify(new Date(now).toISOString())+',"tables":{'];
  for(let index=0;index<privacyExportDatasets.length;index++){
   const dataset=privacyExportDatasets[index];
   segments.push(`SELECT ${index},0,0,?::text`);
   bindings.push((index?',':'')+JSON.stringify(dataset.name)+':[');
   // Use a reserved row alias: several projections contain a scalar `source`
   // column, which PostgreSQL resolves before a same-named whole-row alias.
   segments.push(`SELECT ${index},1,_export_index,(CASE WHEN _export_index=1 THEN '' ELSE ',' END)||(to_jsonb(_export_row)-'_export_index')::text FROM(${dataset.sql}) _export_row`);
   bindings.push(...Array.from({length:dataset.copies??1},()=>subject));
   segments.push(`SELECT ${index},2,0,']'::text`);
  }
  segments.push(`SELECT ${privacyExportDatasets.length},0,0,'}}'::text`);
  await ctx.db.run(`WITH source_segments AS(${segments.join(' UNION ALL ')}),numbered AS(
    SELECT row_number() OVER(ORDER BY dataset,phase,ordinal)-1 sequence,payload FROM source_segments)
   INSERT INTO privacy_export_snapshot_rows(snapshot_id,sequence,payload_text,byte_length)
   SELECT ?,sequence,payload,octet_length(payload) FROM numbered`,...bindings,id);
  const totals=await ctx.db.one<{n:number;bytes:number;first:number;last:number}>('SELECT count(*) n,sum(byte_length)::bigint bytes,min(sequence) first,max(sequence) last FROM privacy_export_snapshot_rows WHERE snapshot_id=?',id);
  if(!totals||totals.first!==0||totals.last!==number(totals.n)-1||number(totals.bytes)<1)return invalid();
  const sequence=totals.n,rows=number(sequence-(privacyExportDatasets.length*2+2));
  await ctx.db.run("UPDATE privacy_export_snapshots SET status='building',segment_count=?,row_count=?,total_bytes=? WHERE id=?",sequence,rows,totals.bytes,id);
  await ctx.db.run('UPDATE privacy_exports SET bytes=? WHERE id=?',totals.bytes,id);
  await lease();return id;
 });
}

function decode(value:string):Uint8Array{
 // PostgreSQL encode(base64) wraps at 76 columns. Only this internal result uses
 // whitespace normalization, never a caller-supplied manifest or hash.
 try{return Uint8Array.from(atob(value.replaceAll('\n','')),c=>c.charCodeAt(0));}catch{return invalid();}
}
/** Read at most 16 x 64KiB database fragments at a time. A single unusually large
 * textual record is itself continued by byte offset, without UTF-8 decoding. */
async function nextBytes(ctx:AppContext,row:Snapshot,startSeq=row.cursor_seq,startOffset=row.cursor_offset,maximum=EXPORT_CHUNK_BYTES):Promise<{bytes:Uint8Array;sequence:number;offset:number}>{
 const output=new Uint8Array(maximum);let used=0,sequence=startSeq,offset=startOffset;
 try{
  while(used<maximum&&sequence<row.segment_count){
   // PostgreSQL bytea/text datum offsets are int32, even though complete export
   // offsets and segment numbers are safe bigint counters across many rows.
   if(!Number.isSafeInteger(offset)||offset<0||offset>=2147483647)return invalid();
   const page=await ctx.db.all<{sequence:number;byte_length:number;fragment:string}>(`SELECT sequence,byte_length,
    encode(substring(convert_to(payload_text,'UTF8') from(CASE WHEN sequence=? THEN ? ELSE 1 END)::integer for 65536),'base64') fragment
    FROM privacy_export_snapshot_rows WHERE snapshot_id=? AND sequence>=? ORDER BY sequence LIMIT 16`,sequence,offset+1,row.id,sequence);
   if(!page.length)return invalid();let restart=false;
   for(const part of page){
    if(part.sequence!==sequence||number(part.byte_length)<offset)return invalid();
    const bytes=decode(part.fragment);
    try{
     if(bytes.length!==Math.min(65536,part.byte_length-offset)||!bytes.length)return invalid();
     const take=Math.min(bytes.length,maximum-used);output.set(bytes.subarray(0,take),used);used+=take;offset+=take;
     if(offset===part.byte_length){sequence++;offset=0;}else restart=true;
     if(restart||used===maximum)break;
    }finally{bytes.fill(0);}
   }
  }
  if(!used)return invalid();return{bytes:output.slice(0,used),sequence,offset};
 }finally{output.fill(0);}
}
async function verifiedObject(ctx:AppContext,key:string,length:number,sha256:string,maximum:number):Promise<Uint8Array>{
 const object=await ctx.env.PRIVACY_EXPORTS.get(key);
 if(!object||object.size!==length||object.size>maximum)throw new ApiError(503,'privacy_export_unverified');
 const bytes=await readPrivateBytes(object.body,length,maximum);
 if(bytes.length!==length||await digest(bytes)!==sha256){bytes.fill(0);throw new ApiError(503,'privacy_export_unverified');}
 return bytes;
}
function sameCursor(a:Snapshot,b:Snapshot):boolean{return a.id===b.id&&a.cursor_seq===b.cursor_seq&&a.cursor_offset===b.cursor_offset&&a.emitted_bytes===b.emitted_bytes&&a.chunk_count===b.chunk_count&&a.hash_state_json===b.hash_state_json&&a.chain_sha256===b.chain_sha256;}
type WriteAttempt={id:string;key:string};
function allocateAttempt(row:Snapshot,part:string):WriteAttempt{
 const id=crypto.randomUUID();return{id,key:`privacy/${row.subject_id}/${row.request_id}/${row.id}/${part}-${id}.${part==='root'?'json':'bin'}`};
}
/** Every actual PUT has its own immutable key and writer. The cleanup obligation
 * is installed before dispatch, including attempts whose SQL/Storage reply is
 * lost. Live publication/candidate guards prevent premature deletion. */
async function registerAttempt(ctx:AppContext,row:Snapshot,attempt:WriteAttempt):Promise<void>{
 await ctx.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PRIVACY_EXPORTS',?,'pending',?)",attempt.id,row.subject_id,attempt.key,ctx.now());
 await ctx.db.run("INSERT INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,?,'PRIVACY_EXPORTS',?,'pending',?)",crypto.randomUUID(),row.request_id,row.subject_id,attempt.key,ctx.now());
}
function sameChunk(a:ExportChunk|null,b:ExportChunk|null):boolean{
 return a===null&&b===null||!!a&&!!b&&a.publication_id===b.publication_id&&a.chunk_index===b.chunk_index&&a.object_key===b.object_key&&a.write_intent_id===b.write_intent_id&&a.status===b.status;
}
async function advanceChunk(ctx:AppContext,id:string,subject:string,lease:Lease):Promise<boolean>{
 const before=await ctx.db.read(async()=>{await lease();return snapshot(ctx,id,subject);});
 if(before.cursor_seq===before.segment_count)return true;
 const piece=await nextBytes(ctx,before),hasher=new IncrementalSha256(state(before));
 let ownedAttempt:WriteAttempt|undefined,dispatched=false;
 try{
  const checksum=await digest(piece.bytes),root=await exportManifestNext(before.chain_sha256,before.chunk_count,piece.bytes.length,checksum);
  hasher.update(piece.bytes);const hashState=stable(hasher.state());
  const observed=await ctx.db.read(async()=>{
   await lease();const current=await snapshot(ctx,id,subject);if(!sameCursor(current,before))throw new ApiError(409,'privacy_export_cursor_changed');
   const previous=await ctx.db.one<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=?',id,before.chunk_count);
   if(previous){
    if(previous.bytes!==piece.bytes.length||previous.sha256!==checksum||previous.root_sha256!==root||previous.start_seq!==before.cursor_seq||previous.start_offset!==before.cursor_offset||previous.end_seq!==piece.sequence||previous.end_offset!==piece.offset||previous.hash_state_json!==hashState||previous.status!=='pending')return invalid();
   }
   return previous;
  });
  // A complete verified read of a unique key can recover a lost PUT reply.
  // Absence cannot prove that an older PUT terminated: a retry gets a new key,
  // and the older intent/cleanup obligation remains independently unresolved.
  let recovered=false;
  if(observed&&await ctx.env.PRIVACY_EXPORTS.head(observed.object_key)){
   const persisted=await verifiedObject(ctx,observed.object_key,observed.bytes,observed.sha256,EXPORT_CHUNK_BYTES);persisted.fill(0);recovered=true;
  }
  const chunk=await ctx.db.transaction(async()=>{
   await lease();if(!sameCursor(await snapshot(ctx,id,subject),before))throw new ApiError(409,'privacy_export_cursor_changed');
   const current=await ctx.db.one<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=?',id,before.chunk_count);
   if(!sameChunk(current,observed))throw new ApiError(409,'privacy_export_cursor_changed');
   if(recovered)return current!;
   ownedAttempt=allocateAttempt(before,`chunk-${before.chunk_count}`);await registerAttempt(ctx,before,ownedAttempt);
   if(current)await ctx.db.run('UPDATE privacy_export_chunks SET object_key=?,write_intent_id=? WHERE publication_id=? AND chunk_index=?',ownedAttempt.key,ownedAttempt.id,id,before.chunk_count);
   else await ctx.db.run(`INSERT INTO privacy_export_chunks(publication_id,chunk_index,bytes,sha256,root_sha256,object_key,write_intent_id,status,start_seq,start_offset,end_seq,end_offset,hash_state_json,created_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`,id,before.chunk_count,piece.bytes.length,checksum,root,ownedAttempt.key,ownedAttempt.id,before.cursor_seq,before.cursor_offset,piece.sequence,piece.offset,hashState,ctx.now());
   return(await ctx.db.one<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=?',id,before.chunk_count))!;
  });
  const currentBinding=async()=>{
   await lease();if(!sameCursor(await snapshot(ctx,id,subject),before)||!sameChunk(await ctx.db.one<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=?',id,chunk.chunk_index),chunk))throw new ApiError(409,'privacy_export_cursor_changed');
  };
  await ctx.db.read(currentBinding);
  if(ownedAttempt){dispatched=true;await ctx.env.PRIVACY_EXPORTS.put(chunk.object_key,piece.bytes.buffer as ArrayBuffer,{httpMetadata:{contentType:'application/octet-stream'}});}
  await settleMediaWrite(ctx,chunk.write_intent_id);
  const persisted=await verifiedObject(ctx,chunk.object_key,chunk.bytes,chunk.sha256,EXPORT_CHUNK_BYTES);persisted.fill(0);
  await ctx.db.transaction(async()=>{
   await currentBinding();
   await ctx.db.run("UPDATE privacy_export_chunks SET status='verified',hash_state_json='{}' WHERE publication_id=? AND chunk_index=?",id,chunk.chunk_index);
   await ctx.db.run('UPDATE privacy_export_snapshots SET cursor_seq=?,cursor_offset=?,emitted_bytes=emitted_bytes+?,chunk_count=chunk_count+1,hash_state_json=?,chain_sha256=? WHERE id=?',piece.sequence,piece.offset,piece.bytes.length,hashState,root,id);
  });
  return piece.sequence===before.segment_count;
 }finally{
  piece.bytes.fill(0);hasher.clear();
  // This invocation is the only one allowed to dispatch its newly allocated
  // attempt. A rejected allocation/guard can therefore retire an undispatched
  // intent; a rejected PUT remains unknown and is never settled here.
  if(ownedAttempt&&!dispatched)await completeUndispatchedMediaWrite(ctx,ownedAttempt.id);
 }
}

async function publish(ctx:AppContext,id:string,subject:string,lease:Lease):Promise<void>{
 let ownedAttempt:WriteAttempt|undefined,dispatched=false,bytes:Uint8Array|undefined;
 try{
 const prepared=await ctx.db.transaction(async()=>{
  await lease();const row=await snapshot(ctx,id,subject);
  if(row.status==='completed'){
   const committed=await ctx.db.one<{sha256:string;bytes:number;status:string;request_status:string;export_key:string;object_key:string}>(`SELECT e.sha256,e.bytes,e.status,r.status request_status,r.export_key,e.object_key
    FROM privacy_exports e JOIN privacy_requests r ON r.id=e.request_id WHERE e.id=? AND e.subject_id=?`,id,subject);
   if(!committed||committed.request_status!=='completed'||!['published','retired'].includes(committed.status)||committed.sha256!==row.sha256||committed.bytes!==row.total_bytes||committed.export_key!==committed.object_key)return invalid();
   return null;
  }
  if(row.cursor_seq!==row.segment_count||row.cursor_offset!==0||row.emitted_bytes!==row.total_bytes||row.chunk_count!==Math.ceil(row.total_bytes/EXPORT_CHUNK_BYTES))return invalid();
  const totals=await ctx.db.one<{n:number;bytes:number;first:number;last:number}>('SELECT count(*) n,sum(bytes)::bigint bytes,min(chunk_index) first,max(chunk_index) last FROM privacy_export_chunks WHERE publication_id=? AND status=?',id,'verified');
  if(!totals||totals.n!==row.chunk_count||totals.bytes!==row.total_bytes||totals.first!==0||totals.last!==row.chunk_count-1)return invalid();
  const hasher=new IncrementalSha256(state(row)),sha256=hasher.hex();hasher.clear();
  if(row.sha256!==null&&row.sha256!==sha256)return invalid();
  const publication=await ctx.db.one<{object_key:string}>('SELECT object_key FROM privacy_exports WHERE id=? AND status=?',id,'pending');
  if(!publication)return invalid();
  let attempt:WriteAttempt;
  if(row.root_write_id){
   const writer=await ctx.db.one<{id:string;object_key:string}>("SELECT id,object_key FROM media_write_intents WHERE id=? AND account_id=? AND bucket='PRIVACY_EXPORTS'",row.root_write_id,subject);
   if(!writer)return invalid();attempt={id:writer.id,key:writer.object_key};
  }else{
   ownedAttempt=allocateAttempt(row,'root');await registerAttempt(ctx,row,ownedAttempt);attempt=ownedAttempt;
  }
  await ctx.db.run("UPDATE privacy_export_snapshots SET status='publishing',sha256=?,root_write_id=? WHERE id=?",sha256,attempt.id,id);
  return{row:{...row,sha256,root_write_id:attempt.id},attempt};
 });
 if(!prepared)return;
 const row=prepared.row,flat=row.total_bytes<=EXPORT_FLAT_BYTES;let attempt=prepared.attempt;
 if(flat){
  bytes=new Uint8Array(row.total_bytes);let offset=0,root=await exportManifestSeed(id);
  try{for(let index=0;index<row.chunk_count;index++){
   const chunk=await ctx.db.one<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=? AND status=?',id,index,'verified');if(!chunk)return invalid();
   const part=await verifiedObject(ctx,chunk.object_key,chunk.bytes,chunk.sha256,EXPORT_CHUNK_BYTES);
   try{root=await exportManifestNext(root,index,part.length,chunk.sha256);if(root!==chunk.root_sha256)return invalid();bytes.set(part,offset);offset+=part.length;}finally{part.fill(0);}
  }
  if(offset!==row.total_bytes||await digest(bytes)!==row.sha256||root!==row.chain_sha256)return invalid();
  }catch(error){bytes.fill(0);throw error;}
 }else bytes=encoder.encode(stable({protocol:EXPORT_CHUNKS_PROTOCOL,publication_id:id,bytes:row.total_bytes,sha256:row.sha256,chunk_count:row.chunk_count,chunk_bytes:EXPORT_CHUNK_BYTES,manifest_sha256:row.chain_sha256}));
  const objectSha256=await digest(bytes);
  const currentBinding=async()=>{
   await lease();const current=await snapshot(ctx,id,subject);
   if(current.status!=='publishing'||current.sha256!==row.sha256||current.chain_sha256!==row.chain_sha256||current.root_write_id!==attempt.id)return invalid();
  };
  if(!ownedAttempt){
   const head=await ctx.env.PRIVACY_EXPORTS.head(attempt.key);
   if(head){const previous=await verifiedObject(ctx,attempt.key,bytes.length,objectSha256,EXPORT_FLAT_BYTES);previous.fill(0);}
   else attempt=await ctx.db.transaction(async()=>{
    await currentBinding();ownedAttempt=allocateAttempt(row,'root');await registerAttempt(ctx,row,ownedAttempt);
    await ctx.db.run('UPDATE privacy_export_snapshots SET root_write_id=? WHERE id=?',ownedAttempt.id,id);
    return ownedAttempt;
   });
  }
  await ctx.db.read(currentBinding);
  if(ownedAttempt){dispatched=true;await ctx.env.PRIVACY_EXPORTS.put(attempt.key,bytes.buffer as ArrayBuffer,{httpMetadata:{contentType:'application/json'}});}
  await settleMediaWrite(ctx,attempt.id);
  const persisted=await verifiedObject(ctx,attempt.key,bytes.length,objectSha256,EXPORT_FLAT_BYTES);persisted.fill(0);
  await ctx.db.transaction(async()=>{
   await currentBinding();
   const now=ctx.now(),expires=now+ttl;
   await ctx.db.run(`UPDATE privacy_exports SET status='published',object_key=?,sha256=?,bytes=?,expires_at=?,content_format=?,chunk_count=?,manifest_sha256=?,manifest_object_sha256=?,manifest_object_bytes=? WHERE id=? AND status='pending'`,attempt.key,row.sha256,row.total_bytes,expires,flat?'flat':'chunked',flat?0:row.chunk_count,flat?null:row.chain_sha256,flat?null:objectSha256,flat?null:bytes!.length,id);
   await ctx.db.run("UPDATE privacy_export_snapshots SET status='completed',expires_at=?,hash_state_json='{}' WHERE id=?",expires,id);
   await ctx.db.run('DELETE FROM privacy_export_snapshot_rows WHERE snapshot_id=?',id);
   await ctx.db.run("UPDATE privacy_requests SET status='completed',completed_at=?,export_key=?,export_sha256=?,export_bytes=?,export_expires_at=?,failure_code=NULL,execution_token=NULL,lease_until=NULL WHERE id=?",now,attempt.key,row.sha256,row.total_bytes,expires,row.request_id);
   await ctx.db.run("INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) SELECT ?,reviewed_by,subject_id,'privacy.export.completed',id,?,? FROM privacy_requests WHERE id=?",crypto.randomUUID(),stable({inventory_version:'supabase-personal-data-v2',chunked:!flat}),now,row.request_id);
   if(flat)await scheduleExportChunkCleanup(ctx,id,row.request_id,subject);
  });
 }finally{
  bytes?.fill(0);
  if(ownedAttempt&&!dispatched)await completeUndispatchedMediaWrite(ctx,ownedAttempt.id);
 }
}

/** At most four MiB of new chunks per invocation; a legacy-compatible flat file
 * is assembled only below the pre-existing 20MiB memory bound. */
export async function advanceExportSnapshot(ctx:AppContext,id:string,subject:string,lease:Lease):Promise<boolean>{
 for(let count=0;count<4;count++)if(await advanceChunk(ctx,id,subject,lease)){await publish(ctx,id,subject,lease);return true;}
 return false;
}
/** SQL-side INSERT SELECT keeps cleanup bounded in application memory even for
 * arbitrarily many chunks. The exact request/bucket/key uniqueness retains the
 * original UUID on retry and keeps the shared bounded cleanup scan applicable.
 * No prefix listing or deletion of unknown objects is authorized. */
export async function scheduleExportChunkCleanup(ctx:AppContext,publicationId:string,requestId:string,subject:string):Promise<void>{
 await ctx.db.run(`INSERT INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,created_at)
  SELECT gen_random_uuid()::text,?,?,'PRIVACY_EXPORTS',object_key,'pending',?
  FROM privacy_export_chunks WHERE publication_id=? ON CONFLICT(request_id,bucket,object_key) DO NOTHING`,requestId,subject,ctx.now(),publicationId);
}
export async function retireExportSnapshots(ctx:AppContext,subject:string,erasureRequestId?:string):Promise<void>{
 const now=ctx.now();
 await ctx.db.run("UPDATE privacy_export_snapshots SET status='retired',hash_state_json='{}' WHERE subject_id=?",subject);
 await ctx.db.run("UPDATE privacy_export_chunks SET hash_state_json='{}' WHERE publication_id IN(SELECT id FROM privacy_export_snapshots WHERE subject_id=?)",subject);
 await ctx.db.run('DELETE FROM privacy_export_snapshot_rows WHERE snapshot_id IN(SELECT id FROM privacy_export_snapshots WHERE subject_id=?)',subject);
 await ctx.db.run(`INSERT INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,created_at)
  SELECT gen_random_uuid()::text,coalesce(?,s.request_id),s.subject_id,'PRIVACY_EXPORTS',c.object_key,'pending',?
  FROM privacy_export_chunks c JOIN privacy_export_snapshots s ON s.id=c.publication_id WHERE s.subject_id=?
  ON CONFLICT(request_id,bucket,object_key) DO UPDATE SET status='pending',verified_at=NULL`,erasureRequestId??null,now,subject);
}
