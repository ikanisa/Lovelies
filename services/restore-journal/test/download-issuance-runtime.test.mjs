import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROJECT_ID,sha256} from '../src/journal.mjs';
import {env} from './fixtures.mjs';
import {downloadReservationInput} from './download-issuance.fixture.mjs';
import {legacySources,legacySha256} from './inventory-v1-worker.fixture.mjs';
const require=createRequire(new URL('../package.json',import.meta.url)),{Miniflare}=require('miniflare'),{build}=require('esbuild');
const wrapper=line=>`${line}
export class FixtureJournal extends RestoreJournal {async fetch(request){if(new URL(request.url).pathname==='/__fixture_dump')return new Response(JSON.stringify(Object.fromEntries(await this.storage.list())));return super.fetch(request);}}
export default {fetch(request,env){return production.fetch(request,{...env,RESTORE_JOURNAL:{jurisdiction(region){if(region!=='eu')throw Error('wrong jurisdiction');return env.RESTORE_JOURNAL;}}});}};`;
test('actual SQLite DO retains typed settlement across restart and an exact historical binary cannot acknowledge/admit it',{timeout:120000},async()=>{
  const modern=await build({stdin:{contents:wrapper("import production,{RestoreJournal} from './src/worker.mjs';"),resolveDir:new URL('../',import.meta.url).pathname},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  for(const [name,source]of Object.entries(legacySources))assert.equal(await sha256(source),legacySha256[name]);
  const old=await build({stdin:{contents:wrapper("import production,{RestoreJournal} from 'frozen:worker.mjs';")},plugins:[{name:'historical-v1',setup(b){
    b.onResolve({filter:/^frozen:/},a=>({path:a.path.slice(7),namespace:'historical'}));
    b.onResolve({filter:/^\.\//,namespace:'historical'},a=>({path:a.path.slice(2),namespace:'historical'}));
    b.onLoad({filter:/.*/,namespace:'historical'},a=>{if(!Object.hasOwn(legacySources,a.path))throw Error('unknown historical dependency');return {contents:legacySources[a.path],loader:'js'};});
  }}],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const directory=await mkdtemp(path.join(tmpdir(),'lovelies-download-do-'));let mf;
  const open=async script=>{mf=new Miniflare({name:'lovelies-download-local',modules:true,script,compatibilityDate:'2026-07-21',durableObjects:{RESTORE_JOURNAL:{className:'FixtureJournal',useSQLite:true}},durableObjectsPersist:directory,bindings:env});await mf.ready;};
  const restart=async script=>{await mf.dispose();mf=undefined;await open(script);};
  const send=async(route,body,status=200,headers={})=>{const r=await mf.dispatchFetch('https://journal.invalid'+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+env.RESTORE_JOURNAL_TOKEN,'X-Lovelies-Writer-Protocol':'lovelies-api-v15',...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};
  const dump=async()=>{const ns=await mf.getDurableObjectNamespace('RESTORE_JOURNAL'),id=ns.idFromName('lovelies-restriction-journal-v1:'+PROJECT_ID);return (await ns.get(id).fetch('https://journal.invalid/__fixture_dump')).json();};
  try{
    await open(modern.outputFiles[0].text);const boot=await send('/v1/control/bootstrap',{version:1,project_id:PROJECT_ID,database_id:randomUUID(),bootstrap_id:randomUUID()});
    const input=await downloadReservationInput(boot.control.marker),prepared=(await send('/v1/download-operations/prepare',input)).operation;
    const base={version:1,project_id:PROJECT_ID,plan_hash:prepared.plan_hash,marker:prepared.plan.next};
    await send('/v1/operations/'+input.operation_id+'/acknowledge',base,409);
    const settled=(await send('/v1/download-operations/'+input.operation_id+'/settle',{...base,disposition:'not_issued',receipt_hash:input.download.not_issued.receipt_hash})).operation;
    await restart(modern.outputFiles[0].text);assert.deepEqual((await send('/v1/operations/'+input.operation_id)).operation,settled);
    const before=await dump();await restart(old.outputFiles[0].text);
    for(const [route,body]of [['/v1/control'],['/v1/admission',{version:1,project_id:PROJECT_ID,marker:prepared.plan.next}],['/v1/operations/'+input.operation_id+'/acknowledge',base]])
      assert.equal((await send(route,body,503)).error,'journal_integrity_failed');
    assert.deepEqual(await dump(),before);await restart(modern.outputFiles[0].text);
    assert.deepEqual((await send('/v1/operations/'+input.operation_id)).operation,settled);assert.deepEqual(await dump(),before);
  }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});
