import { assertPrivacyActor } from './auth.ts';
import { originalDownloadAccess } from './entitlements.ts';
import { parseMediaAuthority } from './gallery.ts';
import { assertRegisteredActor } from './operations.ts';
import { validateRestoreMarker, type RestoreMarker } from './restore-journal.ts';
import { restoreAllocationID, restoreOperationID } from './restore-transaction.ts';
import { assertDownloadAdmissionFresh, admissionDeadline, captureDownloadAdmission } from './download-v2-authority.ts';
import { DOWNLOAD_CAPABILITY_HEADER, DOWNLOAD_MAX_BYTES, DOWNLOAD_SOURCE, downloadUnresolved, downloadWire,
  parseDownloadInput, sealDownloadEvidence, type DownloadContext, type DownloadEvidence, type DownloadTicket } from './download-v2-contract.ts';
import { bindDownloadProof, downloadSql, loadDownloadProof, writeDownloadEvidence, type DownloadProof } from './download-v2-persistence.ts';
import { ApiError, digest, jsonBody, ok, stable, type Actor, type AppContext } from './types.ts';

async function marker(ctx:AppContext):Promise<RestoreMarker>{
  const r=await ctx.db.one<any>('SELECT database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash FROM restore_control WHERE singleton=1');
  if(!r)return downloadUnresolved();return validateRestoreMarker({database_id:r.database_id,incarnation_id:r.incarnation_id,
    checkpoint:{revision:r.checkpoint_revision,hash:r.checkpoint_hash},cursor:{sequence:r.journal_sequence,hash:r.journal_hash}});
}
async function sessionSnapshot(ctx:AppContext,actor:Actor):Promise<unknown>{
  const row=await ctx.db.one(`SELECT id,account_id,expires_at,refresh_expires_at,auth_epoch,auth_method,face_profile_revision,
    face_consent_id,device_id,face_profile_epoch,device_revision FROM sessions WHERE id=? AND account_id=? AND revoked_at IS NULL`,actor.sessionId,actor.accountId);
  if(!row)return downloadUnresolved();return row;
}
async function readProof(ctx:AppContext,context:DownloadContext,operationID:string):Promise<DownloadProof|null>{
  const proof=await loadDownloadProof(downloadSql(ctx.db),ctx.env,operationID);
  if(!proof)return null;
  if(stable(proof.evidence.context)!==stable(context))return downloadUnresolved();
  const independent=await ctx.db.verifiedRestoreOperation(operationID);
  if(!independent||independent.status!=='committed')return downloadUnresolved();await bindDownloadProof(independent,proof);return proof;
}
/** Bounded read of the bytes actually delivered by Storage. Metadata alone is
 * not a memory bound, checksum or proof that the response stream completed. */
export async function readDownloadBytes(body:ReadableStream<Uint8Array>|null,signal?:AbortSignal):Promise<Uint8Array>{
  if(!body)return downloadUnresolved();const reader=body.getReader(),parts:Uint8Array[]=[];
  let length=0,fragments=0,empty=0,done=false,rejectStop!:(e:unknown)=>void;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});void stopped.catch(()=>{});
  const stop=()=>rejectStop(new ApiError(503,'download_content_unavailable'));
  const timer=setTimeout(stop,55000);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  try{
    for(;;){const next=await Promise.race([reader.read(),stopped]);if(next.done){done=true;break;}
      if(!(next.value instanceof Uint8Array)||++fragments>4096||next.value.byteLength===0&&++empty>16)return downloadUnresolved();
      if(next.value.byteLength)empty=0;length+=next.value.byteLength;if(length>DOWNLOAD_MAX_BYTES)return downloadUnresolved();
      parts.push(new Uint8Array(next.value));
    }
    const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',stop);for(const part of parts)part.fill(0);
    if(!done)try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}
  }
}

async function download(request:Request,ctx:AppContext,mode:'sign'|'status'|'content'):Promise<Response>{
  const actor=await ctx.authenticate(request),context=await parseDownloadInput(await jsonBody(request,8192),request.headers.get(DOWNLOAD_CAPABILITY_HEADER),actor.accountId);
  const operationID=await restoreOperationID(actor.accountId,DOWNLOAD_SOURCE,context.operation_key),ticketID=await restoreAllocationID(operationID,'id_0');
  let held:DownloadProof|undefined,admission:Awaited<ReturnType<typeof captureDownloadAdmission>>|undefined;
  let current:Awaited<ReturnType<typeof originalDownloadAccess>>|undefined;
  const fresh=()=>{
    if(actor.expiresAt<=ctx.now())throw new ApiError(401,'session_invalid');
    if(mode!=='status'){
      if(!admission)return downloadUnresolved();assertDownloadAdmissionFresh(admission,ctx.now());
      if(held?.evidence.ticket&&held.evidence.ticket.expires_at<=ctx.now())throw new ApiError(403,'download_expired');
    }
  };
  const check=async()=>{
    if(mode==='status')await assertPrivacyActor(actor,ctx);
    else{
      if(actor.sessionId!==context.original_session_id)throw new ApiError(403,'download_session_changed');
      await assertRegisteredActor(ctx,actor);
      const ticket=held?.evidence.ticket;
      current=await originalDownloadAccess(ctx,actor,context.asset_id,ticket?parseMediaAuthority(stable(ticket.authority)):undefined);
      if(current.asset.version!==context.source_version||current.asset.byte_size>DOWNLOAD_MAX_BYTES)throw new ApiError(403,'download_source_changed');
      admission=await captureDownloadAdmission(ctx,actor,current.authority,Date.parse(current.subscription.expires_at));
      if(ticket&&(ticket.source_checksum!==current.asset.checksum_sha256||ticket.object_key!==current.asset.object_key||
        ticket.byte_size!==current.asset.byte_size||ticket.content_type!==current.asset.content_type||ticket.subscription_id!==current.subscription.id||
        ticket.subscription_version!==current.subscription.version||stable(ticket.admission)!==stable(admission)||
        stable(ticket.session)!==stable(await sessionSnapshot(ctx,actor))))throw new ApiError(403,'download_authority_changed');
    }
    if(held){const latest=await loadDownloadProof(downloadSql(ctx.db),ctx.env,operationID);if(!latest||stable(latest)!==stable(held))return downloadUnresolved();}
    fresh();
  };
  ctx.db.bindInvocationAuthority(check,fresh,'download_operation_outcome_unresolved');
  const prior=await ctx.db.read(async()=>{const proof=await readProof(ctx,context,operationID);if(proof)held=proof;await check();return proof;});
  if(mode==='status'){if(!prior)return downloadUnresolved();return ok(prior.evidence.wire);}
  if(mode==='sign'){
    if(prior)return ok(prior.evidence.wire);
    const result=await ctx.db.transaction(async restore=>{
      // A second pool may have issued this exact intent while this request was
      // waiting for the same PG lock. Reconcile; never allocate another ticket.
      const raced=await readProof(ctx,context,operationID);if(raced){held=raced;await check();return raced.evidence.wire;}
      if(await ctx.db.verifiedRestoreOperation(operationID))return downloadUnresolved();
      const legacy=await ctx.db.all('SELECT operation_key FROM operations WHERE actor_id=? AND operation_key=?',actor.accountId,context.operation_key);
      if(legacy.length)return downloadUnresolved();await check();
      const created=ctx.now(),expires=Math.min(created+120000,admissionDeadline(admission!),actor.expiresAt);
      if(!Number.isSafeInteger(created)||expires<=created)return downloadUnresolved();
      const ticket:DownloadTicket={id:ticketID,created_at:created,expires_at:expires,source_checksum:current!.asset.checksum_sha256!,
        object_key:current!.asset.object_key,content_type:current!.asset.content_type,byte_size:current!.asset.byte_size,
        subscription_id:current!.subscription.id,subscription_version:current!.subscription.version,authority:current!.authority,
        admission:admission!,session:await sessionSnapshot(ctx,actor)};
      const expected=await marker(ctx),inputHash=await digest(stable(context));
      const base={protocol:'lovelies-download-evidence-v2' as const,operation_id:operationID,input_hash:inputHash,recorded_at:created,context,ticket_id:ticketID,expected};
      const issued:DownloadEvidence={...base,disposition:'issued',ticket,wire:downloadWire(context,ticket)};
      const absent:DownloadEvidence={...base,disposition:'not_issued',ticket:null,wire:downloadWire(context,null)};
      const seal=await sealDownloadEvidence(ctx.env,issued),notIssued=await sealDownloadEvidence(ctx.env,absent);
      restore.operation({operation_id:operationID,input_hash:inputHash,allocations:{id_0:ticketID}});
      restore.download({kind:'download-issuance-v2',context,ticket_id:ticketID,issued_receipt_hash:seal.receipt_hash,not_issued:notIssued});
      await writeDownloadEvidence(downloadSql(ctx.db),{evidence:issued,seal});
      await ctx.db.run('INSERT INTO download_v2_tickets(id,operation_id,receipt_hash) VALUES(?,?,?)',ticketID,operationID,seal.receipt_hash);
      await ctx.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
        actor.accountId,DOWNLOAD_SOURCE,context.operation_key,'download.sign.v2',inputHash,stable(context),stable(issued.wire),created);
      // Before independent prepare the proof is not yet committed. Guard only
      // the actual authority here; install held after COMMIT+typed ack returns.
      await check();ctx.db.beforeCommit(check);return {wire:issued.wire,proof:{evidence:issued,seal}};
    });
    if('proof' in result){held=result.proof;return ok(result.wire);}return ok(result);
  }
  if(!prior||prior.evidence.disposition!=='issued'||!prior.evidence.ticket)throw new ApiError(403,'download_not_issued');
  const ticket=prior.evidence.ticket;
  await ctx.db.read(check);const object=await ctx.env.QUARANTINE.get(ticket.object_key);let bytes:Uint8Array|undefined;
  try{
    await ctx.db.read(check);
    if(!object||object.size!==ticket.byte_size||object.httpMetadata?.contentType!==ticket.content_type||
      object.customMetadata?.source_version!==context.source_version||object.customMetadata?.source_checksum_sha256!==ticket.source_checksum)throw new ApiError(404,'source_unverified');
    bytes=await readDownloadBytes(object.body,request.signal);await ctx.db.read(check);
    const checksum=await digest(bytes);await ctx.db.read(check);const head=await ctx.env.QUARANTINE.head(ticket.object_key);
    await ctx.db.transaction(async()=>{
      await check();if(bytes!.byteLength!==ticket.byte_size||checksum!==ticket.source_checksum||!head||head.etag!==object.etag||
        head.size!==ticket.byte_size||head.httpMetadata?.contentType!==ticket.content_type||head.customMetadata?.source_version!==context.source_version||
        head.customMetadata?.source_checksum_sha256!==checksum)throw new ApiError(403,'download_source_changed');
      await ctx.db.run('INSERT OR IGNORE INTO download_records(id,ticket_id,account_id,asset_id,subscription_id,created_at,financial_eligible) VALUES(?,?,?,?,?,?,1)',
        await restoreAllocationID(operationID,'id_1'),ticketID,actor.accountId,context.asset_id,ticket.subscription_id,ctx.now());
      await check();ctx.db.beforeCommit(check);
    });
    await ctx.db.read(check);fresh();
    return new Response(bytes.slice().buffer,{headers:{'Content-Type':ticket.content_type,'Content-Length':String(bytes.length),
      'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','X-Lovelies-Source-Version':context.source_version,
      'X-Lovelies-Content-SHA256':checksum,'Content-Disposition':'attachment; filename="lovelies-'+context.asset_id+'.'+(ticket.content_type==='image/jpeg'?'jpg':ticket.content_type.split('/')[1])+'"'}});
  }finally{bytes?.fill(0);if(object?.body&&!object.body.locked)try{void object.body.cancel().catch(()=>{});}catch{}}
}
export async function handleDownloadV2(request:Request,ctx:AppContext):Promise<Response|null>{
  const url=new URL(request.url),match=/^\/downloads\/v2\/(sign|status|content)$/.exec(url.pathname);
  if(!match)return null;if(request.method!=='POST')throw new ApiError(405,'method_not_allowed');
  if(url.search)throw new ApiError(400,'invalid_download_input');
  try{return await download(request,ctx,match[1] as 'sign'|'status'|'content');}
  catch(error){if(error instanceof ApiError&&error.status>=500)return downloadUnresolved();throw error;}
}
