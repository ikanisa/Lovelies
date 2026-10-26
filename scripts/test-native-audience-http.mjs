/** macOS host qualification only: production Swift/HTTP/API, isolated local SQL. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startHarness} from '../services/supabase-api/test/runtime-harness.mjs';
import {backupDirectory} from './lib/encrypted-backup.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
if(process.platform!=='darwin'||args.length!==2||args[0]!=='--output'||!path.isAbsolute(args[1]))throw new Error('macOS and a new absolute --output directory required');
const directory=path.resolve(args[1]);
await fs.mkdir(directory,{mode:0o700});await backupDirectory(directory);
const sourceNames=[
  'scripts/test-native-audience-http.mjs','scripts/lib/encrypted-backup.mjs','pnpm-lock.yaml','services/supabase-api/package.json',
  'services/supabase-api/test/runtime-harness.mjs','services/supabase-api/test/postgres-harness.mjs',
  'ios/Tests/NativeAudienceHTTPJourney.swift',...['CoreWire','NativeLocalAuthentication','DeviceIdentity','CameraRecovery','UploadRecovery','UploadFileTransport','BackendRepository'].map(name=>'ios/Lovelies/Native/'+name+'.swift'),
];
for(const folder of ['services/supabase-api/src','supabase/migrations'])for(const item of await fs.readdir(path.join(root,folder)))if(/\.(ts|sql)$/.test(item))sourceNames.push(folder+'/'+item);
const hashes=async()=>Object.fromEntries(await Promise.all([...new Set(sourceNames)].sort().map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')])));
const source=await hashes();await fs.writeFile(path.join(directory,'source-seal.json'),JSON.stringify({source,inputs:Object.keys(source).length},null,2)+'\n',{mode:0o600});
const report={status:'running',source_inputs:Object.keys(source).length,started_at:new Date().toISOString(),scope:'Swift host memory storage and real URLSession/production API against isolated local SQL. No physical, UI, provider, guardian approval or hosted acceptance.'};
let h,api,controller;
async function child(name,command,argv,env){
  const stdout=await fs.open(path.join(directory,name+'.stdout'),'wx',0o600),stderr=await fs.open(path.join(directory,name+'.stderr'),'wx',0o600);
  try{
    const task=spawn(command,argv,{cwd:root,env,stdio:['ignore',stdout.fd,stderr.fd]});
    const deadline=setTimeout(()=>task.kill('SIGTERM'),120000);deadline.unref();
    try{await new Promise((resolve,reject)=>{task.once('error',()=>reject(new Error(name+'_spawn_failed')));task.once('exit',(code,signal)=>code===0?resolve():reject(new Error(name+'_failed_'+(signal??code))));});}
    finally{clearTimeout(deadline);}
  }finally{await stdout.close();await stderr.close();}
}
async function body(request){let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>8192)throw new Error('fixture_body_limit');chunks.push(chunk);}return Buffer.concat(chunks);}
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return 'http://127.0.0.1:'+server.address().port;}
async function close(server){if(server?.listening){server.closeIdleConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}}
try{
  if((await fs.statfs(root)).bavail*(await fs.statfs(root)).bsize<2*1024**3)throw new Error('host_reserve_below_2GiB');
  const executable=path.join(directory,'NativeAudienceHTTPJourney');
  const native=sourceNames.filter(name=>name.endsWith('.swift')).map(name=>path.join(root,name));
  const compilerEnvironment=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','DEVELOPER_DIR'].filter(name=>process.env[name]).map(name=>[name,process.env[name]]));
  await child('compile','xcrun',['swiftc',...native,'-o',executable],compilerEnvironment);
  h=await startHarness({consumeQueue:false});
  report.database=process.env.TEST_DATABASE_URL?'isolated_actual_PostgreSQL':'embedded_PostgreSQL_PGlite';
  const summary=async()=>{
    const result={};
    for(const [key,sql] of Object.entries({accounts:'SELECT count(*) n FROM accounts',declared_accounts:'SELECT count(*) n FROM account_audience',
      active_sessions:'SELECT count(*) n FROM sessions WHERE revoked_at IS NULL',consents:'SELECT count(*) n FROM consents',guardian_approvals:'SELECT count(*) n FROM guardian_purpose_approvals',
      media_grants:'SELECT count(*) n FROM media_grants',face_profiles:'SELECT count(*) n FROM face_profiles',auth_devices:'SELECT count(*) n FROM auth_devices',auth_challenges:'SELECT count(*) n FROM auth_challenges',
      withdrawn_guardian_requests:"SELECT count(*) n FROM guardian_requests WHERE state='withdrawn'"}))result[key]=(await h.db.one(sql)).n;
    return result;
  };
  api=createServer(async(request,response)=>{
    try{
      const data=await body(request),headers=new Headers();for(const [name,value] of Object.entries(request.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
      const reply=await h.appHandler(new Request('http://127.0.0.1'+request.url,{method:request.method,headers,...data.length?{body:data}:{}}));
      response.writeHead(reply.status,Object.fromEntries(reply.headers));response.end(Buffer.from(await reply.arrayBuffer()));
    }catch{response.writeHead(500,{'content-type':'application/json'});response.end('{"error":{"code":"isolated_http_bridge_failed"}}');}
  });
  // Keep fixture-only SQL control on a separate authenticated loopback listener.
  // It is never a production API route and is not part of NativeURLTransport.
  const secret=randomBytes(32).toString('base64url');let history;
  controller=createServer(async(request,response)=>{
    try{
      if(request.method!=='POST'||request.url!=='/control'||request.headers['x-lovelies-fixture-control']!==secret){response.writeHead(404);response.end();return;}
      const {action}=JSON.parse((await body(request)).toString());let result;
      if(action==='schema_unavailable'&&!history){history=await h.db.all('SELECT version,applied_at FROM schema_versions ORDER BY version');await h.db.run('DELETE FROM schema_versions WHERE version>8');result={version:8};}
      else if(action==='schema_restore'&&history){await h.db.transaction(async()=>{await h.db.run('DELETE FROM schema_versions');for(const item of history)await h.db.run('INSERT INTO schema_versions(version,applied_at) VALUES(?,?)',item.version,item.applied_at);});result={version:Math.max(...history.map(row=>row.version))};history=undefined;}
      else if(action==='summary')result=await summary();
      else throw new Error('fixture_action_refused');
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));
    }catch{response.writeHead(500,{'content-type':'application/json'});response.end('{"error":"fixture_control_failed"}');}
  });
  // The same exported handler used in production; no HTTP responses are mocked.
  const {createHandler}=await import('../services/supabase-api/src/index.ts');h.appHandler=createHandler(h.app);
  const apiOrigin=await listen(api),controlOrigin=await listen(controller);
  await child('runtime',executable,[apiOrigin,controlOrigin,path.join(directory,'native-report.json')],{...compilerEnvironment,LOVELIES_NATIVE_AUDIENCE_CONTROL_SECRET:secret});
  const nativeReport=JSON.parse(await fs.readFile(path.join(directory,'native-report.json'),'utf8'));
  if(nativeReport.status!=='passed'||nativeReport.checks.length!==6)throw new Error('native_report_not_accepted');
  const readback=await summary();await fs.writeFile(path.join(directory,'database-readback.json'),JSON.stringify(readback,null,2)+'\n',{mode:0o600});
  report.native_checks=nativeReport.checks.length;report.native_assertions=nativeReport.assertions_passed;
  report.source_unchanged=JSON.stringify(await hashes())===JSON.stringify(source);
  if(!report.source_unchanged)throw new Error('source_changed_during_qualification');
  report.status='passed_native_audience_http';
}catch(error){report.status='failed_or_unknown_native_audience_http';report.failure_code=/^[a-zA-Z0-9_]+$/.test(error?.message??'')?error.message:'qualification_failed';}
finally{
  const cleanup=[];for(const server of [api,controller])try{await close(server);}catch{cleanup.push('listener_close_failed');}
  if(h)try{await h.close();}catch{cleanup.push('isolated_database_close_failed');}
  report.cleanup={listeners_closed:!api?.listening&&!controller?.listening,isolated_database_closed:!!h&&cleanup.length===0,failures:cleanup};
  if(cleanup.length)report.status='failed_or_unknown_native_audience_http';
  report.finished_at=new Date().toISOString();await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));if(report.status!=='passed_native_audience_http')process.exitCode=1;
}
