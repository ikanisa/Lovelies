import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:net';
import https from 'node:https';
import {createPrivateServer} from '../src/private-server.mjs';
import {writeConfiguration} from '../../../scripts/local-supabase-configure.mjs';

test('actual private TLS listener checks CA, exact authority and protected health before storage',async t=>{
 const parent=await fs.mkdtemp('/tmp/lovelies-private-tls-');t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const directory=path.join(parent,'runtime');await writeConfiguration({host:'api.example.test',email:'operator@example.test',runtimeDirectory:directory,publicSiteRoot:path.join(parent,'public')});
 const reservation=createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const token='controlled-private-health-credential-32-characters';let reads=0,handled=0;
 const env={HOST:'127.0.0.1',PORT:String(port),CUSTODY_SERVICE_ORIGIN:'https://restore-journal:'+port,CUSTODY_HEALTH_TOKEN:token,
  CUSTODY_TLS_KEY_FILE:path.join(directory,'tls/restore-journal.key'),CUSTODY_TLS_CERT_FILE:path.join(directory,'tls/restore-journal.crt')};
 const listener=await createPrivateServer({env,service:'restore-journal',storage:{health:async()=>{reads++;return true;}},handle:async()=>{handled++;return Response.json({available:true});}});t.after(()=>listener.close());
 const ca=await fs.readFile(path.join(directory,'tls/ca.crt'));
 const request=(url,headers={},options={})=>new Promise((resolve,reject)=>{
  const req=https.request({hostname:'127.0.0.1',port,servername:'restore-journal',path:url,ca,headers:{host:'restore-journal:'+port,...headers},...options},response=>{
   const data=[];response.on('data',chunk=>data.push(chunk));response.once('end',()=>resolve({status:response.statusCode,body:Buffer.concat(data).toString()}));
  });req.once('error',reject);req.setTimeout(2000,()=>req.destroy(Error('test_timeout')));req.end();
 });
 assert.equal((await request('/healthz')).status,401);assert.equal(reads,0);
 assert.equal((await request('/healthz',{host:'wrong.internal',authorization:'Bearer '+token})).status,503);assert.equal(reads,0);
 assert.equal((await request('/healthz',{authorization:'Bearer '+token})).status,200);assert.equal(reads,1);
 const metrics=await request('/metrics',{authorization:'Bearer '+token});assert.equal(metrics.status,200);assert.match(metrics.body,/lovelies_custody_up/);assert.ok(!metrics.body.includes(token));
 await assert.rejects(()=>request('/healthz',{}, {servername:'wrong.internal'}),error=>error.code==='ERR_TLS_CERT_ALTNAME_INVALID');
 await assert.rejects(()=>request('/healthz',{}, {ca:undefined}));
 assert.equal(handled,0);
});
