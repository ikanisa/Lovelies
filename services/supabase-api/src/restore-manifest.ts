import { ApiError, digest, stable } from './types.ts';
import { RESTORE_PROJECT_ID, RESTORE_JOURNAL_PROTOCOL, validateRestoreMarker,
  type RestoreOperationInput, type RestoreOperationRecord, type RestoreMarker, type RestoreOperationPlanV2 } from './restore-journal.ts';
const fail = (): never => { throw new ApiError(503, 'restore_journal_unavailable'); };
const hash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const uint = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const exact = (x: unknown, keys: string[]): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x,k));
export type RestrictionManifest = Readonly<{count:number;chunks:number;root:string}>;
export type RestoreManifestHeader = Omit<RestoreOperationInput,'events'|'version'> & {readonly version:2;readonly event_manifest:RestrictionManifest};
const ZERO = '0'.repeat(64);
export async function restrictionManifest(input: RestoreOperationInput): Promise<{header:RestoreManifestHeader; chunks:readonly Record<string,unknown>[]}> {
  const chunks:Record<string,unknown>[]=[];let previous=ZERO;
  for(let index=0;index<input.events.length;index+=32){
    const events=input.events.slice(index,index+32), ordinal=chunks.length;
    const root=await digest(stable({protocol:RESTORE_JOURNAL_PROTOCOL,kind:'restriction-manifest-chunk-v2',project_id:RESTORE_PROJECT_ID,
      operation_id:input.operation_id,index:ordinal,previous_hash:previous,events}));
    chunks.push({version:2,project_id:RESTORE_PROJECT_ID,index:ordinal,previous_hash:previous,hash:root,events});previous=root;
  }
  const {events:_,version:__,...base}=input;
  return {header:{...base,version:2,event_manifest:{count:input.events.length,chunks:chunks.length,root:previous}},chunks};
}
export function validateManifestHeader(value:unknown):RestoreManifestHeader {
  if(!exact(value,['version','project_id','operation_id','input_hash','expected','allocations','event_manifest'])||value.version!==2||value.project_id!==RESTORE_PROJECT_ID||
    !uuid(value.operation_id)||!hash(value.input_hash)||!value.allocations||typeof value.allocations!=='object'||Array.isArray(value.allocations)||
    Object.keys(value.allocations).length>32||Object.entries(value.allocations).some(([k,v])=>!/^id_(?:[0-9]|[12][0-9]|3[01])$/.test(k)||!uuid(v))||
    new Set(Object.values(value.allocations)).size!==Object.values(value.allocations).length||!exact(value.event_manifest,['count','chunks','root'])||
    !uint(value.event_manifest.count)||!uint(value.event_manifest.chunks)||value.event_manifest.chunks!==Math.ceil(value.event_manifest.count/32)||
    !hash(value.event_manifest.root)||value.event_manifest.count===0&&value.event_manifest.root!==ZERO)return fail();
  const expected=validateRestoreMarker(value.expected);
  if(value.event_manifest.count>Number.MAX_SAFE_INTEGER-expected.cursor.sequence||expected.checkpoint.revision===Number.MAX_SAFE_INTEGER)return fail();
  return Object.freeze({version:2,project_id:RESTORE_PROJECT_ID,operation_id:value.operation_id,input_hash:value.input_hash,expected,
    allocations:Object.freeze({...value.allocations as Record<string,string>}),event_manifest:Object.freeze({...value.event_manifest as {count:number;chunks:number;root:string}})});
}
export function manifestCheckpointHash(header:RestoreManifestHeader,cursor:RestoreMarker['cursor']):Promise<string>{
  return digest(stable({protocol:RESTORE_JOURNAL_PROTOCOL,kind:'database-checkpoint-v2',project_id:RESTORE_PROJECT_ID,
    operation_id:header.operation_id,input_hash:header.input_hash,expected:header.expected,allocations:header.allocations,event_manifest:header.event_manifest,cursor}));
}
export async function validateManifestRecord(value:unknown):Promise<RestoreOperationRecord>{
  if(!exact(value,['plan','plan_hash','status','committed_at'])||!exact(value.plan,
    ['version','project_id','operation_id','input_hash','expected','allocations','event_manifest','next','prepared_at']))return fail();
  const {next:rawNext,prepared_at:prepared,...rest}=value.plan,header=validateManifestHeader(rest),next=validateRestoreMarker(rawNext);
  if(!uint(prepared)||prepared<1||next.database_id!==header.expected.database_id||next.incarnation_id!==header.expected.incarnation_id||
    next.checkpoint.revision!==header.expected.checkpoint.revision+1||next.cursor.sequence!==header.expected.cursor.sequence+header.event_manifest.count||
    header.event_manifest.count===0&&next.cursor.hash!==header.expected.cursor.hash||next.checkpoint.hash!==await manifestCheckpointHash(header,next.cursor))return fail();
  const plan:RestoreOperationPlanV2=Object.freeze({...header,next,prepared_at:prepared});
  if(!hash(value.plan_hash)||value.plan_hash!==await digest(stable(plan))||!['preparing','pending','committed','recovered'].includes(String(value.status))||
    value.status==='preparing'&&header.event_manifest.count===0||
    (['committed','recovered'].includes(String(value.status)) ? !(uint(value.committed_at)&&value.committed_at>=prepared) : value.committed_at!==null))return fail();
  return Object.freeze({plan,plan_hash:value.plan_hash,status:value.status as RestoreOperationRecord['status'],committed_at:value.committed_at as number|null});
}
