import {ApiError,digest,stable,type PrivateBucket} from './types.ts';
import {RESTORE_PROJECT_ID,RESTORE_JOURNAL_PROTOCOL,validateRestoreControl,validateRestoreMarker,type RestoreJournalClient,type RestoreMarker} from './restore-journal.ts';
import type {DatabaseLineage} from './database.ts';
const bad=():never=>{throw new ApiError(503,'restore_effect_reconciliation_required');};
const hash=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const exact=(x:unknown,keys:string[]):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export type EffectDescriptor=Readonly<{version:1;project_id:typeof RESTORE_PROJECT_ID;effect_id:string;expected:RestoreMarker;kind:'storage-put'|'service-request';target:Record<string,string>;payload_hash:string;byte_size:number;metadata_hash:string}>;
export type EffectRecord=Readonly<{descriptor:EffectDescriptor;descriptor_hash:string;registration:Record<string,any>;status:string;observation:Record<string,any>|null}>;
export async function validateEffectRecord(value:unknown):Promise<EffectRecord>{
 if(!exact(value,['descriptor','descriptor_hash','registration','status','observation'])||!exact(value.descriptor,
  ['version','project_id','effect_id','expected','kind','target','payload_hash','byte_size','metadata_hash']))return bad();
 const d=value.descriptor;
 if(d.version!==1||d.project_id!==RESTORE_PROJECT_ID||!uuid(d.effect_id)||!hash(d.payload_hash)||!hash(d.metadata_hash)||!Number.isSafeInteger(d.byte_size)||d.byte_size<0||
  !['storage-put','service-request'].includes(d.kind)||!exact(value.registration,['sequence','previous_hash','descriptor_hash','effect_id','recorded_at','hash'])||
  !hash(value.descriptor_hash)||value.descriptor_hash!==await digest(stable(d))||!['registered','dispatching','succeeded','rejected','unknown','cancelled','materialized'].includes(value.status))return bad();
 validateRestoreMarker(d.expected);if(d.kind==='storage-put'?(!exact(d.target,['bucket','object_key','owner_id'])||!uuid(d.target.owner_id)):!exact(d.target,['service','method','path']))return bad();
 const r=value.registration;
 if(!Number.isSafeInteger(r.sequence)||r.sequence<1||!hash(r.previous_hash)||!hash(r.hash)||r.effect_id!==d.effect_id||r.descriptor_hash!==value.descriptor_hash||
  r.hash!==await digest(stable({kind:'effect-registration-v1',...Object.fromEntries(Object.entries(r).filter(([k])=>k!=='hash'))})))return bad();
 if(value.status==='registered'?value.observation!==null:!exact(value.observation,['sequence','previous_hash','effect_id','descriptor_hash','status','result','recorded_at','hash']))return bad();
 if(value.observation){const o=value.observation;if(o.effect_id!==d.effect_id||o.descriptor_hash!==value.descriptor_hash||o.status!==value.status||!hash(o.hash)||
  o.hash!==await digest(stable({kind:'effect-observation-v1',...Object.fromEntries(Object.entries(o).filter(([k])=>k!=='hash'))})))return bad();}
 return value as unknown as EffectRecord;
}
async function effectID(input:unknown):Promise<string>{const h=(await digest(stable(input))).slice(0,32).split('');h[12]='8';h[16]=((parseInt(h[16],16)&3)|8).toString(16);const s=h.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export interface RestoreEffectLease{
 readonly replay:boolean;
 succeed(httpStatus:number):Promise<void>;
 unknown():Promise<void>;
 materialized(sha256:string,byteSize:number,etag:string):Promise<void>;
}
export interface RestoreStorageEffects {prepare(key:string,bytes:Uint8Array,options:Parameters<PrivateBucket['put']>[2]):Promise<RestoreEffectLease>;}
export interface RestoreServiceEffects {prepare(method:string,path:string,bytes:Uint8Array):Promise<RestoreEffectLease>;}
export class RestoreExternalEffects{
 constructor(private readonly journal:RestoreJournalClient,private readonly currentLineage:()=>DatabaseLineage,
  private readonly ownerForWrite?:(bucket:'PHOTOS'|'QUARANTINE'|'PRIVACY_EXPORTS',key:string)=>Promise<string|null>){}
 private async response(path:string,body?:unknown,missing=false):Promise<EffectRecord|null>{
  return this.journal.request(path,body,async(value,status)=>{
   if(missing&&status===404&&exact(value,['error'])&&value.error==='effect_not_found')return null;
   if(status!==200||!exact(value,['protocol','project_id','control','effect'])||value.protocol!==RESTORE_JOURNAL_PROTOCOL||value.project_id!==RESTORE_PROJECT_ID)return bad();
   validateRestoreControl(value.control);return validateEffectRecord(value.effect);
  });
 }
 private async lease(kind:EffectDescriptor['kind'],target:Record<string,string>,payload_hash:string,byte_size:number,metadata_hash:string):Promise<RestoreEffectLease>{
  const lineage=this.currentLineage(),control=await this.journal.control();
  if(control.state!=='serving'||control.marker.database_id!==lineage.database_id||control.marker.incarnation_id!==lineage.incarnation_id)return bad();
  const id=kind==='service-request'?crypto.randomUUID():await effectID({project_id:RESTORE_PROJECT_ID,incarnation_id:lineage.incarnation_id,kind,target,payload_hash,byte_size,metadata_hash});
  const old=await this.response('/v1/effects/'+id,undefined,true);
  const descriptor:EffectDescriptor={version:1,project_id:RESTORE_PROJECT_ID,effect_id:id,expected:old?.descriptor.expected??control.marker,kind,target,payload_hash,byte_size,metadata_hash};
  if(old&&stable(old.descriptor)!==stable(descriptor))return bad();
  let effect=old??await this.response('/v1/effects/register',descriptor);if(!effect)return bad();
  const expectedHash=effect.descriptor_hash,replay=effect.status!=='registered';
  if(['cancelled','rejected'].includes(effect.status))return bad();
  if(!replay){
   const current=this.currentLineage();if(stable(current)!==stable(lineage))return bad();
   effect=await this.response('/v1/effects/'+id+'/dispatch',{version:1,project_id:RESTORE_PROJECT_ID,descriptor_hash:expectedHash,incarnation_id:lineage.incarnation_id});
   if(effect?.status!=='dispatching')return bad();
  }
  const observe=async(status:string,result:Record<string,unknown>)=>{
   const current=await this.response('/v1/effects/'+id+'/observe',{version:1,project_id:RESTORE_PROJECT_ID,descriptor_hash:expectedHash,status,result});
   if(!current||current.descriptor_hash!==expectedHash||current.status!==status)return bad();effect=current;
  };
  return Object.freeze({replay,
   succeed:async(http_status:number)=>{if(effect?.status==='succeeded')return;await observe('succeeded',{http_status,sha256:null,byte_size:null,etag:null});},
   unknown:async()=>{if(!effect||!['dispatching','unknown'].includes(effect.status))return;await observe('unknown',{http_status:null,sha256:null,byte_size:null,etag:null});},
   materialized:async(sha256:string,byteSize:number,etag:string)=>{if(sha256!==payload_hash||byteSize!==byte_size)return bad();
    if(effect?.status==='materialized'||effect?.status==='succeeded')return;await observe('materialized',{http_status:null,sha256,byte_size:byteSize,etag});},
  });
 }
 storage(bucket:'PHOTOS'|'QUARANTINE'|'PRIVACY_EXPORTS'):RestoreStorageEffects{return Object.freeze({prepare:async(key:string,bytes:Uint8Array,options:Parameters<PrivateBucket['put']>[2])=>{if(!this.ownerForWrite)return bad();const owner=await this.ownerForWrite(bucket,key);if(!uuid(owner))return bad();return this.lease('storage-put',{bucket,object_key:key,owner_id:owner},await digest(bytes),bytes.byteLength,await digest(stable(options??{})));}});}
 service(service:'inference'|'push'|'store'):RestoreServiceEffects{return Object.freeze({prepare:async(method:string,path:string,bytes:Uint8Array)=>this.lease('service-request',{service,method,path},await digest(bytes),bytes.byteLength,await digest('lovelies-private-service-effect-v1'))});}
}
