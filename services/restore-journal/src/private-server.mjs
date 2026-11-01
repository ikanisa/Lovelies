import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash,timingSafeEqual } from 'node:crypto';

const secureEqual=(actual,expected)=>typeof expected==='string'&&/^[!-~]{32,256}$/.test(expected)&&
  timingSafeEqual(createHash('sha256').update(actual??'').digest(),createHash('sha256').update('Bearer '+expected).digest());
/** The socket itself is TLS. Forwarded headers cannot manufacture HTTPS.
 * Health/metrics require a separate bearer token and never return private data. */
export async function createPrivateServer({handle,storage,env=process.env,service}) {
  const origin=new URL(env.CUSTODY_SERVICE_ORIGIN);
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||
    !/^[!-~]{32,256}$/.test(env.CUSTODY_HEALTH_TOKEN??''))throw new Error('private_server_configuration_invalid');
  const port=Number(env.PORT||(origin.port||443));
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('private_server_configuration_invalid');
  const [key,cert]=await Promise.all([readFile(env.CUSTODY_TLS_KEY_FILE),readFile(env.CUSTODY_TLS_CERT_FILE)]);
  const counts={requests:0,failures:0,duration:0};
  const server=createServer({key,cert,minVersion:'TLSv1.2',maxHeaderSize:8192},async(incoming,outgoing)=>{
    const start=performance.now();counts.requests++;
    let controller;
    try{
      if(typeof incoming.url!=='string'||!incoming.url.startsWith('/')||incoming.url.startsWith('//')||incoming.headers.host!==origin.host)throw new Error('private_transport_invalid');
      const path=new URL(incoming.url,origin).pathname;
      if(['/healthz','/metrics'].includes(path)){
        if(incoming.method!=='GET'||incoming.url!==path||!secureEqual(incoming.headers.authorization,env.CUSTODY_HEALTH_TOKEN)){
          outgoing.writeHead(401,{'content-type':'application/json','cache-control':'no-store'});outgoing.end('{"error":"health_authentication_required"}');return;
        }
        await storage.health();
        if(path==='/metrics'){
          outgoing.writeHead(200,{'content-type':'text/plain; version=0.0.4','cache-control':'no-store'});
          outgoing.end(`lovelies_custody_up{service="${service}"} 1\nlovelies_custody_requests_total{service="${service}"} ${counts.requests}\nlovelies_custody_failures_total{service="${service}"} ${counts.failures}\nlovelies_custody_request_duration_seconds_sum{service="${service}"} ${counts.duration/1000}\n`);
        }else{outgoing.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});outgoing.end('{"status":"ok","schema_version":1}');}
        return;
      }
      controller=new AbortController();incoming.once('aborted',()=>controller.abort());
      const method=incoming.method??'GET';
      const request=new Request(new URL(incoming.url,origin),{method,headers:incoming.headers,signal:controller.signal,
        ...(!['GET','HEAD'].includes(method)?{body:Readable.toWeb(incoming),duplex:'half'}:{})});
      const response=await handle(request);
      if(response.status>=500)counts.failures++;
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    }catch{
      counts.failures++;controller?.abort();
      if(!outgoing.headersSent)outgoing.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});
      outgoing.end('{"error":"custody_unavailable"}');
    }finally{counts.duration+=performance.now()-start;}
  });
  server.requestTimeout=30_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;server.maxRequestsPerSocket=100;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,env.HOST??'0.0.0.0',resolve);});
  return {server,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
