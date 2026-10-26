import {createServer,request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {RestoreJournal} from '../../restore-journal/src/worker.mjs';
import {MemoryStorage} from '../../restore-journal/test/fixtures.mjs';
import {PROJECT_ID} from '../../restore-journal/src/journal.mjs';

/** Actual local TLS + production DO fetch handler. MemoryStorage is explicitly a
 * fixture; SQLite persistence/EU custody have separate qualification. */
export async function startRestoreJournalHTTPSFixture(){
 const directory=await mkdtemp(path.join(tmpdir(),'lovelies-journal-tls-'));
 let server;
 const close=async()=>{if(server?.listening){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}await rm(directory,{recursive:true,force:true});};
 try{
  await chmod(directory,0o700);
  const caPath=path.join(directory,'ca.pem'),caKey=path.join(directory,'ca.key'),keyPath=path.join(directory,'server.key'),csr=path.join(directory,'server.csr'),cert=path.join(directory,'server.pem'),extensions=path.join(directory,'extensions.cnf');
  const openssl=args=>execFileSync('/usr/bin/openssl',args,{stdio:['ignore','ignore','pipe'],timeout:15000});
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',caKey,'-out',caPath,'-days','1','-sha256','-subj','/CN=Lovelies disposable journal test CA']);
  openssl(['req','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',csr,'-sha256','-subj','/CN=localhost']);
  await writeFile(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n',{mode:0o600});
  openssl(['x509','-req','-in',csr,'-CA',caPath,'-CAkey',caKey,'-CAcreateserial','-out',cert,'-days','1','-sha256','-extfile',extensions]);
  await chmod(caKey,0o600);await chmod(keyPath,0o600);
  const token='synthetic-journal-test-'+randomUUID(),env={SUPABASE_PROJECT_ID:PROJECT_ID,RESTORE_JOURNAL_TOKEN:token};
  const object=new RestoreJournal({storage:new MemoryStorage()},env);
  server=createServer({key:await readFile(keyPath),cert:await readFile(cert),minVersion:'TLSv1.2'},async(req,res)=>{
   try{
    const request=new Request('https://127.0.0.1'+req.url,{method:req.method,headers:req.headers,
     ...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});
    const response=await object.fetch(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
   }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"fixture_unavailable"}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port,url='https://127.0.0.1:'+port,ca=await readFile(caPath);
  const request=(route,body)=>new Promise((resolve,reject)=>{
   const req=httpsRequest(url+route,{method:body===undefined?'GET':'POST',ca,rejectUnauthorized:true,timeout:10000,
    headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})}},res=>{
    const chunks=[];let size=0;res.on('data',bytes=>{size+=bytes.length;if(size>131072){res.destroy();reject(new Error('fixture_reply_too_large'));}else chunks.push(bytes);});
    res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('fixture_request_unavailable');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});
   });
   req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('fixture_timeout')));req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const databaseId=randomUUID(),bootstrapId=randomUUID();
  return {url,port,token,caPath,bootstrap:async()=>{
   const value=await request('/v1/control/bootstrap',{version:1,project_id:PROJECT_ID,database_id:databaseId,bootstrap_id:bootstrapId});
   return value.control.marker;
  },control:()=>request('/v1/control'),close};
 }catch(error){await close();throw error;}
}
