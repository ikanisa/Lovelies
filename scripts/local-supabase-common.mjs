/** Operator-only helpers. Commands are argument arrays; secrets travel on stdin. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseEnv} from './local-supabase-configure.mjs';
import {requireOpenLifecycle} from './local-supabase-lifecycle.mjs';

export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
export const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
export function args(argv,allowed,flags=[]){
 const result={};
 for(let n=0;n<argv.length;n++){
  const key=argv[n];if(!allowed.includes(key)||Object.hasOwn(result,key))throw Error('arguments_invalid');
  result[key]=flags.includes(key)?true:argv[++n];
  if(result[key]===undefined)throw Error('arguments_invalid');
 }
 return result;
}
export async function runtime(directory){
 if(!directory||!path.isAbsolute(directory))throw Error('absolute_runtime_directory_required');
 const real=await fs.realpath(directory);if(real!==path.resolve(directory))throw Error('runtime_symlink_rejected');
 const info=await fs.stat(real);if((info.mode&0o077)!==0)throw Error('runtime_permissions_invalid');
 const config=JSON.parse(await fs.readFile(path.join(real,'config.json'),'utf8'));
 if(config.protocol!=='lovelies-local-supabase-deployment-v1'||config.runtime_directory!==real)throw Error('runtime_identity_mismatch');
 const value={directory:real,config};
 for(const name of ['app','api','custody','push','ml']){
  const file=path.join(real,name+'.env'),stat=await fs.lstat(file);
  if(!stat.isFile()||(stat.mode&0o077)!==0)throw Error('runtime_environment_permissions_invalid');
  value[name]=parseEnv(await fs.readFile(file,'utf8'));
 }
 return value;
}
export function command(executable,argv,{input,timeout=120000,maxBytes=4*1024*1024,allowFailure=false}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,argv,{stdio:['pipe','pipe','pipe'],env:{...process.env,COMPOSE_ANSI:'never',NO_COLOR:'1'}});
  const stdout=[],stderr=[];let size=0,failed=false;
  const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},timeout);
  child.once('error',()=>{clearTimeout(timer);reject(Error('operator_command_unavailable'));});
  for(const [stream,chunks] of [[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){failed=true;child.kill('SIGKILL');}else chunks.push(chunk);});
  child.once('close',code=>{
   clearTimeout(timer);
   // Never attach stderr, input, environment, or credentials to an exception.
   if(failed||code!==0&&!allowFailure)return reject(Error(failed?'operator_command_bounded':'operator_command_failed'));
   resolve({code,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)});
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export function composeArgs(r,which='application'){
 const root=r.config.deployment_root;
 return which==='custody'?['compose','--env-file',path.join(r.directory,'custody.env'),'-p','lovelies-custody','-f',path.join(root,'compose.custody.yml')]:
  ['compose','--env-file',path.join(r.directory,'app.env'),'--project-directory',path.join(root,'upstream'),'-p','lovelies-app','-f',path.join(root,'upstream/docker-compose.yml'),'-f',path.join(root,'compose.production.yml')];
}
export const compose=(r,which,argv,options)=>command('docker',[...composeArgs(r,which),...argv],options);
export async function sql(r,text,{custody=false,role='supabase_admin',allowFailure=false}={}){
 if(!['supabase_admin','postgres','lovelies_runtime','lovelies_api','lovelies_journal','lovelies_push','anon','authenticated','service_role'].includes(role))throw Error('operator_role_invalid');
 const privateLogging=role==='supabase_admin'?"SET log_statement='none'; SET log_min_error_statement='panic'; SET log_min_duration_statement=-1;\n":'';
 const out=await compose(r,custody?'custody':'application',['exec','-T',custody?'custody-db':'db','psql','-X','-q','-v','ON_ERROR_STOP=1','-At','-U',role,'-d','postgres'],{input:privateLogging+text,allowFailure});
 return {code:out.code,text:out.stdout.toString('utf8').trim()};
}
export async function privateRequest(r,service,route,{method='GET',body,credential='runtime'}={}){
 if(!['restore-journal','push-ledger'].includes(service)||(!route.startsWith('/v')&&!['/healthz','/metrics'].includes(route))||route.includes('?')||!['runtime','bootstrap','health'].includes(credential))throw Error('custody_request_invalid');
 const key=service==='restore-journal'?'RESTORE_JOURNAL':'PUSH_LEDGER';
 const tokenName=credential==='health'?'CUSTODY_HEALTH_TOKEN':key+(credential==='bootstrap'?'_BOOTSTRAP_TOKEN':'_TOKEN');
 const source=`const request=${JSON.stringify({route,method,body,tokenName})};
 const response=await fetch(process.env.CUSTODY_SERVICE_ORIGIN+request.route,{method:request.method,headers:{'authorization':'Bearer '+process.env[request.tokenName],'content-type':'application/json'},...(request.body===undefined?{}:{body:JSON.stringify(request.body)}),signal:AbortSignal.timeout(15000)});
 const text=await response.text();if(!response.ok||text.length>2000000)process.exit(1);process.stdout.write(request.route==='/metrics'?JSON.stringify(text):text);`;
 const out=await compose(r,'custody',['exec','-T',service,'node','--input-type=module','-'],{input:source});
 return JSON.parse(out.stdout.toString('utf8'));
}
export async function writeReceipt(file,value){
 if(!file||!path.isAbsolute(file))throw Error('absolute_new_receipt_required');
 await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
}
export async function withOperationLock(r,operation,callback){
 const filename=path.join(r.directory,'host-operation.lock');
 const file=await fs.open(filename,'wx',0o600);
 try{await file.writeFile(JSON.stringify({operation,pid:process.pid,started_at:new Date().toISOString()})+'\n');await file.sync();
  if(operation!=='managed-auth-key-rotation')await requireOpenLifecycle(r.directory,r.api.MANAGED_AUTH_ENCRYPTION_KEY);
  return await callback();}
 finally{await file.close();await fs.unlink(filename);}
}
export async function requireCompose(){
 const output=await command('docker',['compose','version','--short']);
 const match=/^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(output.stdout.toString().trim());
 if(!match||Number(match[1])<2||Number(match[1])===2&&(Number(match[2])<24||Number(match[2])===24&&Number(match[3])<4))throw Error('docker_compose_2_24_4_required');
 return match[0];
}
