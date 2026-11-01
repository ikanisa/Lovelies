#!/usr/bin/env node
// Opt-in qualification of the real public service worker. No entry replacement,
// retained browser profile, authentication fixture, or hosted request is used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';

const root=fileURLToPath(new URL('../',import.meta.url));
const target=new URL(process.argv[2]??'http://127.0.0.1:8765/admin/');
if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password||target.search||target.hash||!['/','/admin/'].includes(target.pathname))throw new Error('Pass an exact http://127.0.0.1 preview origin or /admin/ URL');
target.pathname='/admin/';
const workerSource=await readFile(resolve(root,'admin/sw.js'),'utf8');
// Only read the worker's declarations here. Lifecycle, messaging, navigation,
// cache contents and request exclusions are exercised by Chromium below.
const metadata=JSON.parse(JSON.stringify(runInNewContext(`${workerSource}\n;({version:VERSION,cacheName:CACHE_NAME,paths:SHELL_PATHS})`,{
 URL,self:{location:{origin:target.origin},addEventListener(){}},
},{filename:'admin/sw.js',timeout:1000})));
assert.equal(typeof metadata.version,'string');assert.equal(typeof metadata.cacheName,'string');
assert(Array.isArray(metadata.paths)&&metadata.paths.length>0);assert.equal(new Set(metadata.paths).size,metadata.paths.length);
const shellFiles=Object.fromEntries(metadata.paths.map(path=>{
 const url=new URL(path,target);
 assert.equal(url.origin,target.origin);assert.equal(url.pathname,path);assert.equal(url.search,'');assert.equal(url.hash,'');
 assert(/^\/admin\/(?:[a-z0-9-]+\.(?:html|css|js|mjs|svg|png|webmanifest))?$/.test(path)||/^\/clients\/backend\/[a-z0-9-]+\.mjs$/.test(path)||path==='/shared/assets/wordmark.png',`Unexpected public shell path: ${path}`);
 return [url.href,path==='/admin/'?'admin/index.html':path.slice(1)];
}));
const inputPaths=[...new Set(['admin/check-browser-offline.mjs','admin/sw.js',...Object.values(shellFiles)])];
const hashes=async()=>Object.fromEntries(await Promise.all(inputPaths.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const inputs=await hashes(),checks=[],requests=[],outsideOrigins=[],proxyRejections=[],pageErrors=[],sockets=new Set();
const report={protocol:'lovelies-admin-browser-offline-v1',status:'incomplete',started_at:new Date().toISOString(),target:target.href,inputs,checks,requests,outside_origins:outsideOrigins,proxy_rejections:proxyRejections,page_errors:pageErrors,
 scope:{production_entry:true,fresh_browser_context:true,synthetic_session:false,production_authentication:false,service_workers:'allow',native_installation:false,hosted_traffic:false}};
let browser,proxy;
const networkSessions=[];

async function bounded(promise,milliseconds,label){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),milliseconds);})]);}finally{clearTimeout(timer);}
}
async function inventory(page){
 return page.evaluate(async()=>{
  const result=[];
  for(const name of (await caches.keys()).sort()){
   const cache=await caches.open(name),entries=[];
   for(const request of (await cache.keys()).sort((a,b)=>a.url.localeCompare(b.url))){
    const response=await cache.match(request);
    const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
    entries.push({url:request.url,method:request.method,authorization:request.headers.has('Authorization'),status:response.status,type:response.type,sha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')});
   }
   result.push({name,entries});
  }
  return result;
 });
}
async function connectionState(page){
 return page.evaluate(()=>{
  const banner=document.querySelector('#connection-banner');
  return {online:navigator.onLine,document_hidden:document.hidden,banner_hidden:banner.hidden,banner_display:getComputedStyle(banner).display,banner_height:banner.getBoundingClientRect().height,banner_text:banner.textContent,controller:navigator.serviceWorker.controller?.scriptURL};
 });
}
async function applyCurrentDocumentOffline(context,page,phase,{blockRequests=false}={}){
 const before=await connectionState(page),transition={phase,before};report.offline_transitions.push(transition);
 // Observe the browser's event. No synthetic event, navigator getter, or
 // application state is supplied by the test. Keep this session until cleanup.
 await page.evaluate(()=>{
  const observation={events:[]};
  observation.listener=event=>observation.events.push({type:event.type,trusted:event.isTrusted});
  window.__loveliesOfflineObservation=observation;
  window.addEventListener('offline',observation.listener);
 });
 const session=await context.newCDPSession(page);networkSessions.push(session);
 await session.send('Network.enable');
 const {targetInfo}=await session.send('Target.getTargetInfo');
 const {frameTree}=await session.send('Page.getFrameTree');
 Object.assign(transition,{target_id:targetInfo.targetId,frame_id:frameTree.frame.id,loader_id:frameTree.frame.loaderId});
 if(blockRequests)await context.setOffline(true);
 await session.send('Network.overrideNetworkState',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:'none'});
 try{await page.waitForFunction(expectEvent=>navigator.onLine===false&&!document.querySelector('#connection-banner').hidden&&(!expectEvent||window.__loveliesOfflineObservation.events.some(event=>event.type==='offline'&&event.trusted)),before.online!==false,{timeout:5000});}
 finally{
  transition.after=await connectionState(page);
  transition.events=await page.evaluate(()=>{
   const observation=window.__loveliesOfflineObservation;
   window.removeEventListener('offline',observation.listener);delete window.__loveliesOfflineObservation;return observation.events;
  });
 }
 assert.equal(transition.after.online,false,'Current document must report native offline state after explicit setup');
 assert.equal(await page.locator('#connection-banner').isVisible(),true);
 return transition.after;
}
async function qualify(){
 // There is deliberately no forwarding code. The browser-wide proxy also
 // contains worker/background requests that page routing cannot intercept.
 proxy=createServer((request,response)=>{
  proxyRejections.push({method:request.method,destination:request.url.split('?')[0]});
  response.writeHead(403,{'Content-Type':'text/plain','Content-Length':'0','Connection':'close'});response.end();
 });
 const rejectTunnel=(request,socket)=>{
  proxyRejections.push({method:request.method,destination:request.url.split('?')[0]});
  socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
 };
 proxy.on('connect',rejectTunnel);proxy.on('upgrade',rejectTunnel);
 proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setTimeout(2000,()=>socket.destroy());});
 proxy.on('clientError',(_error,socket)=>socket.destroy());
 proxy.requestTimeout=2000;proxy.headersTimeout=2000;proxy.keepAliveTimeout=1000;
 await bounded(new Promise((resolveListen,rejectListen)=>{proxy.once('error',rejectListen);proxy.listen(0,'127.0.0.1',resolveListen);}),3000,'Local rejecting proxy');
 const proxyURL=`http://127.0.0.1:${proxy.address().port}`;
 // Remove Chromium's implicit loopback exemption, then allow only this exact
 // preview URL's HTTP host/port. Other loopback ports must use the rejecting proxy.
 const bypass=`<-loopback>,http://127.0.0.1:${target.port||'80'}`;
 report.network_containment={proxy:proxyURL,bypass,forwards_requests:false};
 const {chromium}=await import(process.env.LOVELIES_PLAYWRIGHT_MODULE||'playwright');
 browser=await chromium.launch({headless:true,timeout:15000,proxy:{server:proxyURL,bypass},
  args:['--disable-quic','--dns-prefetch-disable','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  ...(process.env.LOVELIES_CHROMIUM_EXECUTABLE?{executablePath:process.env.LOVELIES_CHROMIUM_EXECUTABLE}:{})});
 report.browser=await browser.version();
 const context=await browser.newContext({serviceWorkers:'allow',acceptDownloads:false,viewport:{width:1280,height:900}});
 context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(10000);
 context.on('request',request=>{
  const url=new URL(request.url());
  if(!['http:','https:'].includes(url.protocol))return;
  const record={method:request.method(),origin:url.origin,path:url.pathname,query:!!url.search,service_worker:!!request.serviceWorker?.()};
  requests.push(record);if(url.origin!==target.origin)outsideOrigins.push(record);
 });
 context.on('page',page=>{
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('websocket',socket=>outsideOrigins.push({websocket:socket.url()}));
 });
 assert.deepEqual(await context.cookies(),[]);assert.equal(context.serviceWorkers().length,0);
 checks.push('Fresh browser context has no retained cookies or service workers');
 const page=await context.newPage();
 await page.goto(target.href,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated'&&document.readyState==='complete'&&document.querySelector('#main .live-auth'),null,{timeout:20000});
 await page.waitForLoadState('networkidle');
 assert.equal(await page.locator('.preview-pill').innerText(),'Face sign-in');
 assert.equal(await page.locator('#main h1').innerText(),'Your protected workspace');
 const registration=await page.evaluate(async()=>{
  const registrations=await navigator.serviceWorker.getRegistrations();
  return registrations.map(item=>({scope:item.scope,active:item.active?.scriptURL,controller:navigator.serviceWorker.controller?.scriptURL}));
 });
 assert.deepEqual(registration,[{scope:target.href,active:new URL('sw.js',target).href,controller:new URL('sw.js',target).href}]);
 checks.push('Unmodified production entry reaches public sign-in and activates the real /admin/ service worker');
 report.worker_status=await page.evaluate(()=>new Promise((resolveStatus,rejectStatus)=>{
  const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();channel.port2.close();rejectStatus(new Error('Worker status timed out'));},4000);
  channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();channel.port2.close();resolveStatus(event.data);};
  navigator.serviceWorker.controller.postMessage({type:'GET_STATUS'},[channel.port2]);
 }));
 assert.deepEqual(report.worker_status,{type:'ADMIN_SW_STATUS',version:metadata.version,cacheName:metadata.cacheName,offlineReady:true});
 const workerHash=await page.evaluate(async url=>{
  const response=await fetch(url,{cache:'no-store',credentials:'omit'});if(!response.ok)throw new Error('Worker source unavailable');
  const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
 },new URL('sw.js',target).href);
 assert.equal(workerHash,inputs['admin/sw.js']);
 const installed=await inventory(page);report.installed_cache=installed;
 assert.deepEqual(installed.map(cache=>cache.name),[metadata.cacheName]);
 assert.deepEqual(installed[0].entries.map(entry=>entry.url).sort(),Object.keys(shellFiles).sort());
 for(const entry of installed[0].entries){
  assert.equal(entry.method,'GET');assert.equal(entry.authorization,false);assert.equal(entry.status,200);assert.equal(entry.type,'basic');
  assert.equal(entry.sha256,inputs[shellFiles[entry.url]],`Cached public bytes differ: ${entry.url}`);
 }
 checks.push(`Real worker installation caches exactly the ${metadata.paths.length} declared SHELL_PATHS with matching public file bytes`);
 // Native navigator state can reset when a worker serves a new document.
 // Request blocking remains enabled; reapply the separate navigator override
 // to each current document and qualify the real offline event/UI transition.
 report.offline_emulation={requests:'BrowserContext.setOffline',navigator:'Network.overrideNetworkState reapplied to each current document',persists_across_navigation:false};
 report.offline_transitions=[];
 report.offline_state_before_reload=await applyCurrentDocumentOffline(context,page,'before_reload',{blockRequests:true});
 const reload=await page.reload({waitUntil:'networkidle'});
 report.offline_reload={status:reload.status(),from_service_worker:reload.fromServiceWorker(),url:reload.url()};
 assert.equal(reload.status(),200);assert.equal(reload.fromServiceWorker(),true);
 await page.locator('#main .live-auth').waitFor();report.offline_state_after_reload=await connectionState(page);
 await applyCurrentDocumentOffline(context,page,'after_reload');
 assert.equal(await page.locator('#main h1').innerText(),'Your protected workspace');
 checks.push('Public reload comes from the real worker while requests are offline; explicit current-document native offline state triggers the visible notice');
 const hashNavigation=await page.goto(new URL('index.html#support?filter=attention&sort=oldest',target).href,{waitUntil:'networkidle'});
 assert.equal(hashNavigation.status(),200);assert.equal(hashNavigation.fromServiceWorker(),true);
 await page.locator('#main .live-auth').waitFor();assert.equal(await page.locator('#main h1').innerText(),'Your protected workspace');
 report.offline_state_after_hash_navigation=await connectionState(page);
 await applyCurrentDocumentOffline(context,page,'after_hash_navigation');
 checks.push('Offline index alias and client-side hash route load the public shell through the real worker');
 for(const path of ['/admin/api/requests','/admin/?offline-probe=1']){
  const probePage=await context.newPage();let failure;
  try{await probePage.goto(new URL(path,target).href,{waitUntil:'domcontentloaded'});}catch(error){failure=error.message;}finally{await probePage.close();}
  assert(failure&&/net::ERR_(?:INTERNET_DISCONNECTED|FAILED)/.test(failure),`${path} must fail offline without a navigation fallback`);
  assert.deepEqual(await inventory(page),installed,`${path} changed the public cache`);
  checks.push(`Offline navigation to ${path} fails without fallback and leaves the public cache unchanged`);
 }
 const probes=[
  {name:'private API',path:'/admin/api/requests'},
  {name:'private JSON',path:'/admin/private.json'},
  {name:'private source',path:'/services/supabase-api/src/index.ts'},
  {name:'shell query',path:'/admin/?offline-probe=1'},
  {name:'asset query',path:'/admin/styles.css?v=offline-probe'},
  {name:'Authorization header',path:'/admin/',headers:{Authorization:'Bearer synthetic-offline-denial-probe'}},
  {name:'POST',path:'/admin/',method:'POST',body:'synthetic offline denial probe'},
  {name:'unlisted public route',path:'/preview/'},
 ];
 report.excluded_requests=[];
 for(const probe of probes){
  const result=await page.evaluate(async probe=>{
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
   try{
    const response=await fetch(probe.path,{method:probe.method??'GET',headers:probe.headers??{},...(probe.body?{body:probe.body}:{}),credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
    return {outcome:'response',status:response.status,type:response.type};
   }catch(error){return {outcome:'rejected',error_name:error.name,aborted:controller.signal.aborted};}finally{clearTimeout(timer);}
  },probe);
  report.excluded_requests.push({name:probe.name,path:probe.path,...result});
  assert.deepEqual(result,{outcome:'rejected',error_name:'TypeError',aborted:false},`${probe.name} must fail at the offline network boundary, not return a cached response or time out`);
  assert.deepEqual(await inventory(page),installed,`${probe.name} changed public cache keys or contents`);
  checks.push(`Offline ${probe.name} request rejects without fallback and preserves exact public cache keys and bytes`);
 }
 assert.deepEqual(outsideOrigins,[],'Application attempted traffic outside the exact preview origin');
 assert.deepEqual(pageErrors,[],'Browser script error');
 assert.deepEqual(await hashes(),inputs,'Qualification inputs changed during verification');
 checks.push('Observed page/worker requests stay on the exact preview origin; production source remains unchanged');
}

try{await bounded(qualify(),60000,'Offline browser qualification');report.status='passed';}
catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1;}
finally{
 try{if(browser)await bounded(browser.close(),5000,'Browser cleanup');}catch(error){report.status='failed';report.cleanup_error=error.message;process.exitCode=1;}
 if(proxy){for(const socket of sockets)socket.destroy();proxy.closeAllConnections();try{await bounded(new Promise(resolveClose=>proxy.close(resolveClose)),3000,'Proxy cleanup');}catch(error){report.status='failed';report.proxy_cleanup_error=error.message;process.exitCode=1;}}
 report.finished_at=new Date().toISOString();
 if(process.argv[3]){const output=resolve(process.argv[3]);await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
 console.log(JSON.stringify(report,null,2));
}
