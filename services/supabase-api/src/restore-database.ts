import { ApiError, digest, stable } from './types.ts';
import { verifyDownloadDescriptor, verifyDownloadSeal, type DownloadKeyConfiguration } from './download-v2-contract.ts';
import { assertDownloadAbsent, bindDownloadProof, loadDownloadProof, writeDownloadEvidence } from './download-v2-persistence.ts';
import type { DatabaseFence, DatabaseLineage, SqlConnection } from './database.ts';
import {
  RESTORE_PROJECT_ID, validateRestoreMarker, validateRestoreOperationInput,
  type RestoreJournalClient, type RestoreMarker, type RestoreOperationInput, type RestoreOperationRecord,
} from './restore-journal.ts';

type JournalPort=Pick<RestoreJournalClient,'control'|'admission'|'prepare'|'lookup'|'acknowledge'> & Partial<Pick<RestoreJournalClient,'prepareDownload'|'settleDownload'>>;
export type RestoreTransactionIntent=Omit<RestoreOperationInput,'version'|'project_id'|'expected'>;
type ControlRow={project_id:string;database_id:string;incarnation_id:string;checkpoint_revision:number;checkpoint_hash:string;
  journal_sequence:number;journal_hash:string;last_operation_id:string|null;last_plan_hash:string|null;last_disposition:'issued'|'not_issued'|null;last_receipt_hash:string|null};
type Admission={row:ControlRow;marker:RestoreMarker};
const unavailable=():never=>{throw new ApiError(503,'restore_reconciliation_required');};
const equal=(a:unknown,b:unknown)=>stable(a)===stable(b);
const columns='project_id,database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash,last_operation_id,last_plan_hash,last_disposition,last_receipt_hash';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;

/** Transaction integration, not a recovery controller. A pending operation with
 * no matching committed PG marker is unavailable; it never reruns its callback,
 * assumes an abort, bootstraps a row or fabricates replay/cleanup clearance. */
export class RestoreDatabaseFence implements DatabaseFence{
  private readonly admissions=new WeakSet<object>();
  private readonly lineages=new WeakMap<object,DatabaseLineage>();
  private readonly reservations=new WeakSet<object>();
  constructor(private readonly journal:JournalPort,private readonly downloadKeys:DownloadKeyConfiguration={}){}
  private async local(connection:SqlConnection):Promise<Admission>{
    let rows:ControlRow[];
    try{rows=await connection.query<ControlRow>('SELECT '+columns+' FROM restore_control WHERE singleton=1',[]);}catch{return unavailable();}
    if(rows.length!==1)return unavailable();
    const row=rows[0];
    if((row.last_disposition===null)!==(row.last_receipt_hash===null)||row.last_disposition!==null&&!['issued','not_issued'].includes(row.last_disposition)||
      row.last_receipt_hash!==null&&!hash.test(row.last_receipt_hash)||row.project_id!==RESTORE_PROJECT_ID || row.checkpoint_revision===0&&(row.last_operation_id!==null||row.last_plan_hash!==null) ||
      row.checkpoint_revision>0&&(!uuid.test(row.last_operation_id??'')||!hash.test(row.last_plan_hash??'')))return unavailable();
    const marker=validateRestoreMarker({database_id:row.database_id,incarnation_id:row.incarnation_id,
      checkpoint:{revision:row.checkpoint_revision,hash:row.checkpoint_hash},cursor:{sequence:row.journal_sequence,hash:row.journal_hash}});
    return {row,marker};
  }
  private async acknowledge(connection:SqlConnection,current:Admission,operation:RestoreOperationRecord):Promise<void>{
    if(operation.plan.download){
      const proof=await loadDownloadProof(connection,this.downloadKeys,operation.plan.operation_id);
      if(!proof||current.row.last_disposition!==proof.evidence.disposition||current.row.last_receipt_hash!==proof.seal.receipt_hash||!this.journal.settleDownload)return unavailable();
      await bindDownloadProof(operation,proof);
      await this.journal.settleDownload(operation.plan.operation_id,operation.plan_hash,operation.plan.next,proof.evidence.disposition,proof.seal.receipt_hash);
    }else{
      if(current.row.last_disposition!==null||current.row.last_receipt_hash!==null)return unavailable();
      await this.journal.acknowledge(operation.plan.operation_id,operation.plan_hash,operation.plan.next);
    }
  }
  /** Runs outside the caller transaction BEFORE read-only admission. One SQL
   * lock serializes the original writer, this no-issuance settlement, cleanup
   * and every other pool. Unknown commit/ack is left pending for the next call. */
  async reconcile(connection:SqlConnection):Promise<void>{
    // This preflight is only an optimization. Serving permission and every
    // reconciliation decision are re-read under the PG lock below/in enter.
    if((await this.journal.control()).state!=='pending')return;
    let reserved:RestoreOperationRecord|undefined;
    await connection.begin(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);
      await tx.query('SET LOCAL ROLE lovelies_api',[]);
      await tx.query('SET LOCAL search_path TO lovelies_private, pg_catalog',[]);
      const control=await this.journal.control();
      if(control.state!=='pending'||!control.pending_operation_id)return;
      const operation=await this.journal.lookup(control.pending_operation_id);
      if(!operation?.plan.download)return;
      if(operation.status!=='pending'||!equal(control.marker,operation.plan.expected))return unavailable();
      await verifyDownloadDescriptor(operation.plan.download,operation.plan);
      const current=await this.local(tx);
      if(equal(current.marker,operation.plan.expected)){
        await assertDownloadAbsent(tx,operation);
        const seal=operation.plan.download.not_issued,evidence=await verifyDownloadSeal(this.downloadKeys,seal);
        const proof={seal,evidence};await bindDownloadProof(operation,proof);await writeDownloadEvidence(tx,proof);
        const next=operation.plan.next;
        const updated=await tx.query<{singleton:number}>(`UPDATE restore_control SET database_id=$1,incarnation_id=$2,
          checkpoint_revision=$3,checkpoint_hash=$4,journal_sequence=$5,journal_hash=$6,last_operation_id=$7,last_plan_hash=$8,
          last_disposition='not_issued',last_receipt_hash=$9 WHERE singleton=1 AND database_id=$10 AND incarnation_id=$11
          AND checkpoint_revision=$12 AND checkpoint_hash=$13 AND journal_sequence=$14 AND journal_hash=$15 RETURNING singleton`,
          [next.database_id,next.incarnation_id,next.checkpoint.revision,next.checkpoint.hash,next.cursor.sequence,next.cursor.hash,
          operation.plan.operation_id,operation.plan_hash,seal.receipt_hash,current.marker.database_id,current.marker.incarnation_id,
          current.marker.checkpoint.revision,current.marker.checkpoint.hash,current.marker.cursor.sequence,current.marker.cursor.hash]);
        if(updated.length!==1||updated[0].singleton!==1)return unavailable();
      }else if(!equal(current.marker,operation.plan.next)||current.row.last_operation_id!==operation.plan.operation_id||current.row.last_plan_hash!==operation.plan_hash){
        await this.journal.admission(current.marker);return unavailable();
      }else{
        const proof=await loadDownloadProof(tx,this.downloadKeys,operation.plan.operation_id);if(!proof)return unavailable();
        await bindDownloadProof(operation,proof);
        if(current.row.last_disposition!==proof.evidence.disposition||current.row.last_receipt_hash!==proof.seal.receipt_hash)return unavailable();
      }
      reserved=operation;
    });
    if(!reserved)return;
    await connection.begin(async tx=>{
      await tx.query('SET TRANSACTION READ ONLY',[]);
      await tx.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);
      await tx.query('SET LOCAL ROLE lovelies_api',[]);await tx.query('SET LOCAL search_path TO lovelies_private, pg_catalog',[]);
      const current=await this.local(tx),op=reserved!;
      if(equal(current.marker,op.plan.next)&&current.row.last_operation_id===op.plan.operation_id&&current.row.last_plan_hash===op.plan_hash){
        await this.acknowledge(tx,current,op);return;
      }
      const prior=await this.journal.lookup(op.plan.operation_id);
      if(prior?.status==='committed'&&equal(prior.plan,op.plan)&&prior.plan_hash===op.plan_hash&&
        current.marker.database_id===op.plan.next.database_id&&current.marker.incarnation_id===op.plan.next.incarnation_id&&
        current.marker.checkpoint.revision>op.plan.next.checkpoint.revision){await this.journal.admission(current.marker);return;}
      await this.journal.admission(current.marker);return unavailable();
    });
  }
  async enter(connection:SqlConnection):Promise<unknown>{
    // Caller already holds the shared PG advisory lock; no snapshot is loaded
    // before it. This includes automatic READ ONLY and direct jobs/controls.
    const admission=await this.local(connection),control=await this.journal.control();
    if(control.state==='pending'&&control.pending_operation_id!==null&&control.pending_operation_id===admission.row.last_operation_id){
      const prior=await this.journal.lookup(control.pending_operation_id);
      if(prior?.status==='pending'&&prior.plan_hash===admission.row.last_plan_hash&&equal(prior.plan.next,admission.marker)){
        // COMMIT may have succeeded before its result/ack was lost. Only the
        // exact atomic PG marker + operation/hash can reconcile that commit.
        await this.acknowledge(connection,admission,prior);
      }
    }
    await this.journal.admission(admission.marker);
    this.admissions.add(admission);
    this.lineages.set(admission,Object.freeze({database_id:admission.marker.database_id,incarnation_id:admission.marker.incarnation_id}));
    return admission;
  }
  lineage(rawAdmission:unknown):DatabaseLineage {
    if(!rawAdmission||typeof rawAdmission!=='object'||!this.admissions.has(rawAdmission))return unavailable();
    const lineage=this.lineages.get(rawAdmission);
    if(!lineage)return unavailable();
    return lineage;
  }
  /** A committed record must belong to the currently admitted lineage and
   * cannot be ahead of its checkpoint. Re-admit before returning it. */
  async lookupCommitted(connection:SqlConnection,rawAdmission:unknown,operationID:string):Promise<RestoreOperationRecord|null>{
    if(!rawAdmission||typeof rawAdmission!=='object'||!this.admissions.has(rawAdmission)||!uuid.test(operationID))return unavailable();
    const admission=rawAdmission as Admission,current=await this.local(connection);
    if(!equal(current,admission))return unavailable();
    const prior=await this.journal.lookup(operationID);
    if(!prior||prior.status!=='committed')return null;
    const next=prior.plan.next;
    if(next.database_id!==current.marker.database_id||next.incarnation_id!==current.marker.incarnation_id||
      next.checkpoint.revision>current.marker.checkpoint.revision||next.cursor.sequence>current.marker.cursor.sequence)return unavailable();
    if(next.checkpoint.revision===current.marker.checkpoint.revision&&!equal(next,current.marker))return unavailable();
    await this.journal.admission(current.marker);
    return prior;
  }
  async prepare(connection:SqlConnection,rawAdmission:unknown,rawIntent?:unknown):Promise<unknown>{
    if(!rawAdmission||typeof rawAdmission!=='object'||!this.admissions.has(rawAdmission))return unavailable();
    this.admissions.delete(rawAdmission);
    const admission=rawAdmission as Admission;
    const current=await this.local(connection);
    if(!equal(current,admission))return unavailable();
    // Default execution IDs bind one concrete transaction attempt. A domain
    // operation requiring stable allocated IDs/restriction replay supplies its
    // original explicit intent. No SQL/bindings or business body is replicated.
    const operationId=crypto.randomUUID();
    const intent=rawIntent===undefined?{operation_id:operationId,input_hash:await digest('lovelies-database-mutation-v1:'+operationId),allocations:{},events:[]}:rawIntent;
    if(!intent||typeof intent!=='object'||Array.isArray(intent)||!['allocations,events,input_hash,operation_id','allocations,download,events,input_hash,operation_id'].includes(Object.keys(intent).sort().join(',')))return unavailable();
    const input=validateRestoreOperationInput({version:1,project_id:RESTORE_PROJECT_ID,...intent,expected:admission.marker});
    if(input.download)await verifyDownloadDescriptor(input.download,input);
    const operation=input.download ? await this.journal.prepareDownload?.(input) : await this.journal.prepare(input);
    if(!operation)return unavailable();
    // A historical receipt is never permission to rerun this SQL callback.
    if(operation.status!=='pending'||!equal(operation.plan.expected,admission.marker))return unavailable();
    const next=operation.plan.next;
    const updated=await connection.query<{singleton:number}>(`UPDATE restore_control SET
      database_id=$1,incarnation_id=$2,checkpoint_revision=$3,checkpoint_hash=$4,journal_sequence=$5,journal_hash=$6,last_operation_id=$7,last_plan_hash=$8,last_disposition=$9,last_receipt_hash=$10
      WHERE singleton=1 AND database_id=$11 AND incarnation_id=$12 AND checkpoint_revision=$13 AND checkpoint_hash=$14 AND journal_sequence=$15 AND journal_hash=$16
      RETURNING singleton`,[next.database_id,next.incarnation_id,next.checkpoint.revision,next.checkpoint.hash,next.cursor.sequence,next.cursor.hash,
      operation.plan.operation_id,operation.plan_hash,input.download?'issued':null,input.download?.issued_receipt_hash??null,admission.marker.database_id,admission.marker.incarnation_id,admission.marker.checkpoint.revision,
      admission.marker.checkpoint.hash,admission.marker.cursor.sequence,admission.marker.cursor.hash]);
    if(updated.length!==1||updated[0].singleton!==1)return unavailable();
    if(operation.plan.download){const proof=await loadDownloadProof(connection,this.downloadKeys,operation.plan.operation_id);if(!proof)return unavailable();await bindDownloadProof(operation,proof);if(proof.evidence.disposition!=='issued')return unavailable();}
    this.reservations.add(operation);return operation;
  }
  async committed(connection:SqlConnection,raw:unknown):Promise<void>{
    if(!raw||typeof raw!=='object'||!this.reservations.has(raw))return unavailable();
    this.reservations.delete(raw);const operation=raw as RestoreOperationRecord;
    const current=await this.local(connection),next=operation.plan.next;
    if(equal(current.marker,next)&&current.row.last_operation_id===operation.plan.operation_id&&current.row.last_plan_hash===operation.plan_hash){
      await this.acknowledge(connection,current,operation);return;
    }
    // Another pool can reconcile this exact commit and advance before the
    // originating pool resumes. That is not permission to rerun the callback or
    // rewind an acknowledgement to the old marker. Verify its committed receipt
    // and the independently current local checkpoint while still holding lock.
    if(current.marker.database_id===next.database_id&&current.marker.incarnation_id===next.incarnation_id&&
      current.marker.checkpoint.revision>next.checkpoint.revision){
      const prior=await this.journal.lookup(operation.plan.operation_id);
      if(prior?.status==='committed'&&prior.plan_hash===operation.plan_hash&&equal(prior.plan,operation.plan)){
        await this.enter(connection);return;
      }
    }
    // A restored predecessor must reach independent admission to retain the
    // mismatch quarantine, but must never acknowledge the cached successor.
    await this.journal.admission(current.marker);return unavailable();
  }
}
