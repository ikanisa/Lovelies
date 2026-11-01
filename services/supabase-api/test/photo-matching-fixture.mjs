import assert from 'node:assert/strict';
import {startHarness,enroll,faceVerifierFixture,fixturePng} from './runtime-harness.mjs';
import {MATCH_PAGE_SIZE,MATCH_RANK_PROTOCOL} from '../src/photo-matching.ts';
import {processPhotoJob} from '../src/processing.ts';

export const candidateId=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const candidateNumber=id=>Number(id.slice(-12));
export async function matchingHarness(t,count,{score=(_n)=>.8,beforeReply,mediaWriteGate}={}){
  const calls=[];
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false,mediaWriteGate,
    photoProcessor:async input=>{
      assert(input.profiles.length<=MATCH_PAGE_SIZE,'no private page exceeds its bounded reference count');
      calls.push(structuredClone(input));
      const candidates=input.profiles.map(profile=>({account_id:profile.account_id,profile_id:profile.profile_id,
        profile_version:profile.revision,model_version:profile.model_id,distance:score(candidateNumber(profile.account_id))}))
        .sort((a,b)=>a.distance-b.distance||a.account_id.localeCompare(b.account_id)).slice(0,2);
      const preview={bytes_base64:Buffer.from(fixturePng('matching-preview:'+input.asset_id)).toString('base64'),content_type:'image/png',width:1,height:1};
      const result={attempt_id:input.attempt_id,nonce:input.nonce,asset_id:input.asset_id,source_version:input.source_version,
        source_checksum_sha256:input.source_checksum_sha256,model_version:input.model_version,engine_identity:input.engine_identity,
        ...(input.ranking_protocol?{ranking:{protocol:MATCH_RANK_PROTOCOL,query_sha256:'c'.repeat(64),threshold:.42,review_margin:.05,
          faces:[{face_index:0,candidates}]},...(input.include_preview?{preview}:{})}:{preview,matches:[]})};
      return await beforeReply?.(input,result,h)??result;
    }});
  t.after(()=>h.close());
  const owner=await enroll(h);
  await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,
    processing_consent:true,operation_key:crypto.randomUUID()}});
  await seedCandidates(h,count);
  return {h,owner,calls};
}
export async function seedCandidates(h,count,start=1){
  const account="'20000000-0000-4000-8000-'||lpad(i::text,12,'0')";
  const consent="'30000000-0000-4000-8000-'||lpad(i::text,12,'0')";
  const profile="'40000000-0000-4000-8000-'||lpad(i::text,12,'0')";
  await h.db.transaction(async()=>{
    await h.db.run(`INSERT INTO accounts(id,identity_state) SELECT ${account},'registered_face' FROM generate_series(?,?) i`,start,count);
    await h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status) SELECT ${consent},${account},'photo_matching',?,'granted' FROM generate_series(?,?) i`,h.env.PHOTO_CONSENT_POLICY_VERSION,start,count);
    await h.db.run(`INSERT INTO account_preferences(account_id,receive_matches,download_photos,updated_at) SELECT ${account},1,0,? FROM generate_series(?,?) i`,Date.now(),start,count);
    await h.db.run(`INSERT INTO account_audience(account_id,age_band,status,version,declared_at,policy_version)
      SELECT ${account},'18_plus','eligible',1,?,'audience-2026-10-24-v1' FROM generate_series(?,?) i`,Date.now(),start,count);
    await h.db.run(`INSERT INTO face_profiles(account_id,id,revision,model_id,template_key,template_digest,status,consent_id,auth_epoch)
      SELECT ${account},${profile},'fixture-v1',?,'registered-face/'||(${account})||'/'||(${profile})||'/fixture',?,'active',${consent},1 FROM generate_series(?,?) i`,h.env.PHOTO_MODEL_VERSION,'a'.repeat(64),start,count);
  });
}
export async function queueMatchingPhoto(h,owner){
  const bytes=fixturePng(crypto.randomUUID());
  const upload=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,
    title:'Synthetic bounded matching fixture',operation_key:crypto.randomUUID()}},201);
  await h.json(upload.upload_url,{method:'PUT',token:owner.token,raw:bytes,headers:{'content-type':'image/png'}});
  const completed=await h.json(upload.complete_url,{token:owner.token,body:{operation_key:crypto.randomUUID()}},202);
  const attempt=(await h.storage.exec('SELECT * FROM processing_attempts WHERE id=?',completed.attempt_id))[0];
  return {...upload,attempt};
}
export async function finishMatching(h,item){
  let pages=0,result;
  do{result=await processPhotoJob({attempt_id:item.attempt.id},h.app);pages++;assert(pages<100,'fixture must make durable bounded progress');}while(result?.pending);
  return pages;
}
export async function assertUnpublished(h,item,code){
  const attempt=(await h.storage.exec('SELECT status,error_code FROM processing_attempts WHERE id=?',item.attempt.id))[0];
  assert.equal(attempt.status,'failed');assert.equal(attempt.error_code,code);
  for(const table of ['renditions','candidates','match_origins','media_grants'])
    assert.equal((await h.storage.exec(`SELECT count(*) n FROM ${table} WHERE asset_id=?`,item.asset_id))[0].n,0,table);
}
