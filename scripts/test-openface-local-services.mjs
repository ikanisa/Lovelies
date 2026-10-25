/** Owned, disposable, loopback-only real PostgreSQL + Supabase Storage services.
 * Cached images only. This never reads, resets or deletes an existing database,
 * volume or container. Stop retains this run's volumes and failure evidence. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const images={postgres:'public.ecr.aws/supabase/postgres:17.6.1.158',storage:'public.ecr.aws/supabase/storage-api:v1.68.10'};
const [action,destination]=process.argv.slice(2);
if(!['start','stop'].includes(action)||!destination)throw new Error('Usage: node scripts/test-openface-local-services.mjs start|stop <new-owned-directory>');
const directory=resolve(destination),manifestPath=join(directory,'services.json');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
let sequence=0;
async function command(label,args,{input,allowFailure=false}={}){
 const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let output='',error='';
 child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{error+=chunk;});
 if(input!==undefined)child.stdin.end(input);else child.stdin.end();
 const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done);});
 // Docker/SQL errors may contain configuration. Preserve them privately.
 await writeFile(join(directory,`${String(++sequence).padStart(3,'0')}-${label}.log`),output+error,{mode:0o600});
 if(code!==0&&!allowFailure)throw new Error(label+' failed; private diagnostic retained in the owned directory');
 return {code,output};
}
async function port(){const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const value=server.address().port;await new Promise(done=>server.close(done));return value;}
function token(secret,role){
 const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const value=encoded({alg:'HS256',typ:'JWT'})+'.'+encoded({role,iss:'lovelies-owned-local-test',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+86400});
 return value+'.'+createHmac('sha256',secret).update(value).digest('base64url');
}
if(action==='stop'){
 const info=JSON.parse(await readFile(manifestPath,'utf8'));
 if(info.kind!=='lovelies-openface-owned-local-v1'||!/^lovelies-openface-[a-f0-9]{12}$/.test(info.prefix))throw new Error('Not an owned local service manifest');
 for(const name of [...new Set([info.storageContainer,...(info.previousStorageContainers??[]),info.postgresContainer])]){
  if(!new RegExp('^'+info.prefix+'-(storage|postgres)(-retry[0-9]+)?$').test(name))throw new Error('Manifest ownership mismatch');
  const check=await command('inspect-owned',['inspect','--format','{{index .Config.Labels "lovelies.openface.owner"}}',name]);
  if(check.output.trim()!==info.prefix)throw new Error('Container ownership label mismatch');
  await command('stop-owned',['stop','--time','15',name]);
 }
 console.log('Stopped owned PostgreSQL/Storage containers; exact volumes, configuration and evidence retained at '+directory);
}else{
 try{await stat(directory);throw new Error('Start requires a new owned directory');}catch(error){if(error.code!=='ENOENT')throw error;}
 await mkdir(directory,{recursive:true,mode:0o700});
 for(const [name,image] of Object.entries(images))await command('cached-image-'+name,['image','inspect',image,'--format','{{.Id}} {{.Architecture}}']);
 const prefix='lovelies-openface-'+randomBytes(6).toString('hex'),postgresPort=await port(),storagePort=await port();
 const password=randomBytes(32).toString('base64url'),jwtSecret=randomBytes(48).toString('base64url');
 const serviceKey=token(jwtSecret,'service_role'),anonKey=token(jwtSecret,'anon');
 const pgEnv=join(directory,'postgres.env'),storageEnv=join(directory,'storage.env');
 await writeFile(pgEnv,`POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=postgres\nPOSTGRES_USER=supabase_admin\n`,{mode:0o600});
 const storageDatabase='postgresql://supabase_admin:'+password+'@postgres:5432/postgres';
 await writeFile(storageEnv,Object.entries({NODE_ENV:'production',SERVER_PORT:'5000',AUTH_JWT_SECRET:jwtSecret,AUTH_JWT_ALGORITHM:'HS256',
  // The pinned Supabase PostgreSQL image has already installed these roles.
  // Reinstalling them creates a postgres/authenticator membership cycle.
  DATABASE_URL:storageDatabase,DATABASE_POOL_URL:storageDatabase,DATABASE_MAX_CONNECTIONS:'5',DB_INSTALL_ROLES:'false',DB_SUPER_USER:'supabase_admin',
  STORAGE_BACKEND:'file',STORAGE_FILE_BACKEND_PATH:'/var/lib/storage',STORAGE_FILE_ETAG_ALGORITHM:'md5',
  STORAGE_S3_BUCKET:'local-owned-file-backend',STORAGE_S3_REGION:'local',REGION:'local',TENANT_ID:prefix,
  UPLOAD_FILE_SIZE_LIMIT:String(20*1024*1024),UPLOAD_FILE_SIZE_LIMIT_STANDARD:String(20*1024*1024),
  ANON_KEY:anonKey,SERVICE_KEY:serviceKey,PG_QUEUE_ENABLE:'false',PG_QUEUE_WORKERS_ENABLE:'false',
  S3_PROTOCOL_ENABLED:'false',IMAGE_TRANSFORMATION_ENABLED:'false',LOG_LEVEL:'error',TRACING_ENABLED:'false',
  ICEBERG_ENABLED:'false',VECTOR_ENABLED:'false',EXPOSE_DOCS:'false'}).map(([key,value])=>key+'='+value).join('\n')+'\n',{mode:0o600});
 const info={kind:'lovelies-openface-owned-local-v1',prefix,createdAt:new Date().toISOString(),images,
  postgresContainer:prefix+'-postgres',storageContainer:prefix+'-storage',network:prefix+'-network',
  postgresVolume:prefix+'-postgres-data',storageVolume:prefix+'-storage-data',postgresPort,storagePort};
 await writeFile(manifestPath,JSON.stringify(info,null,2)+'\n',{mode:0o600});
 await writeFile(join(directory,'test.env'),[
  'TEST_DATABASE_URL=postgresql://supabase_admin:'+password+'@127.0.0.1:'+postgresPort+'/postgres',
  'TEST_STORAGE_API_URL=http://127.0.0.1:'+storagePort,
  'TEST_STORAGE_SERVICE_KEY='+serviceKey,
  'RUN_OPENFACE_HTTP_TESTS=1','RUN_OPENFACE_STORAGE_HTTP_TESTS=1',
 ].join('\n')+'\n',{mode:0o600});
 await command('network-create',['network','create','--label','lovelies.openface.owner='+prefix,info.network]);
 for(const name of [info.postgresVolume,info.storageVolume])await command('volume-create',['volume','create','--label','lovelies.openface.owner='+prefix,name]);
 await command('postgres-start',['run','-d','--pull=never','--name',info.postgresContainer,'--label','lovelies.openface.owner='+prefix,
  '--network',info.network,'--network-alias','postgres','--publish',`127.0.0.1:${postgresPort}:5432`,
  '--env-file',pgEnv,'--mount',`type=volume,source=${info.postgresVolume},target=/var/lib/postgresql/data`,
  '--memory','512m','--cpus','1',images.postgres]);
 let ready=false;
 for(let index=0;index<120;index++){
  const check=await command('postgres-ready',['exec',info.postgresContainer,'pg_isready','-h','127.0.0.1','-U','supabase_admin','-d','postgres'],{allowFailure:true});
  if(check.code===0){ready=true;break;}await pause(500);
 }
 if(!ready){await command('postgres-failure-log',['logs',info.postgresContainer],{allowFailure:true});throw new Error('Owned PostgreSQL did not become ready');}
 await command('storage-start',['run','-d','--pull=never','--name',info.storageContainer,'--label','lovelies.openface.owner='+prefix,
  '--network',info.network,'--publish',`127.0.0.1:${storagePort}:5000`,'--env-file',storageEnv,
  '--mount',`type=volume,source=${info.storageVolume},target=/var/lib/storage`,'--memory','256m','--cpus','1',images.storage]);
 ready=false;
 for(let index=0;index<120;index++){
  try{const response=await fetch(`http://127.0.0.1:${storagePort}/status`,{signal:AbortSignal.timeout(1000)});
   if(response.ok){ready=true;await response.body?.cancel();break;}await response.body?.cancel();}catch{}
  await pause(500);
 }
 if(!ready){await command('storage-failure-log',['logs',info.storageContainer],{allowFailure:true});throw new Error('Owned Supabase Storage did not become ready');}
 await command('storage-ready-log',['logs',info.storageContainer],{allowFailure:true});
 console.log('Owned PostgreSQL and actual Supabase Storage ready on loopback; configuration: '+join(directory,'test.env'));
 console.log('Use node --env-file=<that file> --experimental-transform-types --test --test-concurrency=1 services/supabase-api/test/openface-http.test.mjs');
}
