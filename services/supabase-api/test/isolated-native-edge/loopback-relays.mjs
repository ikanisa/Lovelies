/** Mechanical, credential-free transports in the production Edge container's
 * network namespace. No application handlers, fixture responses or retries.
 * All three listeners are private loopback; upstream identities are supplied
 * only after the runner verifies its owned PostgreSQL/Storage containers.
 */
import assert from 'node:assert/strict';
import {createServer as tcpServer,createConnection} from 'node:net';
import {createServer as httpServer,request as httpRequest} from 'node:http';
import {Transform,pipeline} from 'node:stream';

const postgresHost=process.env.RELAY_POSTGRES_HOST,storageHost=process.env.RELAY_STORAGE_HOST;
const mlPort=Number(process.env.RELAY_ML_PORT);
assert(/^lovelies-openface-[a-f0-9]{12}-postgres$/.test(postgresHost??''),'Owned PostgreSQL host required');
assert(/^lovelies-openface-[a-f0-9]{12}-storage(?:-retry[0-9]+)?$/.test(storageHost??''),'Owned Storage host required');
assert(Number.isSafeInteger(mlPort)&&mlPort>=1024&&mlPort<=65535,'Bounded host ML relay port required');
const MAX_CONNECTIONS=64,DEADLINE_MS=145000;
const sockets=new Set(),servers=[];
const metrics={postgres_connections:0,storage_requests:0,ml_requests:0,transport_failures:0,bound_failures:0};
let active=0,closing=false;
function remember(socket){
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  socket.on('error',()=>{});return socket;
}
function bounded(limit){
  let size=0;
  return new Transform({transform(chunk,encoding,done){
    size+=chunk.length;
    if(size>limit){metrics.bound_failures++;done(new Error('RelayBodyBound'));}
    else done(null,chunk);
  }});
}
function reject(response,status){
  if(response.destroyed)return;
  if(response.headersSent){response.destroy();return;}
  response.writeHead(status,{'cache-control':'no-store','content-length':'0'});response.end();
}
async function listen(server,port){
  servers.push(server);
  server.on('connection',remember);
  server.on('error',()=>{metrics.transport_failures++;void close(1);});
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',done);});
}

await listen(tcpServer(client=>{
  if(closing||active>=MAX_CONNECTIONS){client.destroy();return;}
  active++;metrics.postgres_connections++;
  const upstream=remember(createConnection({host:postgresHost,port:5432}));
  let incoming=0,outgoing=0;
  const fail=()=>{client.destroy();upstream.destroy();};
  client.once('close',()=>{active--;upstream.destroy();});upstream.once('close',()=>client.destroy());
  client.on('error',fail);upstream.on('error',()=>{metrics.transport_failures++;fail();});
  client.setTimeout(180000,fail);upstream.setTimeout(180000,fail);
  client.on('data',chunk=>{incoming+=chunk.length;if(incoming>128*1024*1024){metrics.bound_failures++;fail();}});
  upstream.on('data',chunk=>{outgoing+=chunk.length;if(outgoing>128*1024*1024){metrics.bound_failures++;fail();}});
  client.pipe(upstream);upstream.pipe(client);
}),54321);

function gateway({label,port,host,upstreamPort,requestLimit,responseLimit,strip=''}){
  const server=httpServer({maxHeaderSize:32*1024},(incoming,outgoing)=>{
    if(closing||active>=MAX_CONNECTIONS){reject(outgoing,503);incoming.resume();return;}
    const path=incoming.url??'';
    if(!path.startsWith('/')||path.startsWith('//')||strip&&!path.startsWith(strip+'/')){
      reject(outgoing,404);incoming.resume();return;
    }
    const contentLength=incoming.headers['content-length'];
    if(contentLength!==undefined&&(!/^\d+$/.test(contentLength)||Number(contentLength)>requestLimit)){
      reject(outgoing,413);incoming.resume();return;
    }
    active++;metrics[label+'_requests']++;
    // Forward every end-to-end header, including Authorization/apikey and
    // metadata. Only gateway framing/Host changes; private bytes stay streamed.
    const headers={...incoming.headers,host:host+':'+upstreamPort};
    delete headers.connection;delete headers['proxy-connection'];
    const upstream=httpRequest({hostname:host,port:upstreamPort,
      path:strip?path.slice(strip.length):path,method:incoming.method,headers,agent:false},response=>{
      const length=response.headers['content-length'];
      if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>responseLimit)){
        metrics.bound_failures++;response.destroy();reject(outgoing,502);return;
      }
      outgoing.writeHead(response.statusCode??502,response.headers);
      pipeline(response,bounded(responseLimit),outgoing,error=>{
        if(error&&!closing){metrics.transport_failures++;upstream.destroy();}
      });
    });
    const timeout=setTimeout(()=>{metrics.transport_failures++;upstream.destroy();reject(outgoing,504);},DEADLINE_MS);
    const failed=()=>{metrics.transport_failures++;reject(outgoing,502);};
    upstream.once('error',failed);
    upstream.once('socket',remember);
    incoming.once('aborted',()=>upstream.destroy());
    outgoing.once('close',()=>{clearTimeout(timeout);active--;upstream.destroy();});
    pipeline(incoming,bounded(requestLimit),upstream,error=>{
      if(error){upstream.destroy();if(!closing)failed();}
    });
  });
  server.requestTimeout=DEADLINE_MS;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  server.maxRequestsPerSocket=0;
  return listen(server,port);
}
await gateway({label:'storage',port:54322,host:storageHost,upstreamPort:5000,
  requestLimit:24*1024*1024,responseLimit:24*1024*1024,strip:'/storage/v1'});
await gateway({label:'ml',port:54323,host:'host.docker.internal',upstreamPort:mlPort,
  requestLimit:40*1024*1024,responseLimit:6*1024*1024});

async function close(code=0){
  if(closing)return;closing=true;
  for(const server of servers)server.close();
  for(const socket of sockets)socket.destroy();
  console.log(JSON.stringify({event:'loopback_relays_stopped',metrics}));
  process.exitCode=code;
}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
console.log(JSON.stringify({event:'loopback_relays_ready',ports:[54321,54322,54323],credentials:false}));
