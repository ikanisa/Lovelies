import assert from 'node:assert/strict';
import test from 'node:test';
import {previewAllowed} from './entry.mjs';
import {parseRoute,reviewIntent,recordTable,startWorkspace,permittedRoutes} from './live-app.mjs';
import {AUDIENCE_POLICY} from './audience.mjs';
import {queueQuery,queuePage,queueStatuses} from './live-queues.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const unknownAudience=account=>({protocol:'lovelies-audience-v1',policy_version:AUDIENCE_POLICY,account_id:account,
 audience:{age_band:'unknown',status:'unknown',version:0,policy_version:null,next_review_at:null},
 capabilities:{face_authentication:false,photo_matching:false,photo_processing:false},guardian_request:null});
test('production entry never enables sample mode outside an explicit loopback preview',()=>{
  for(const href of ['https://lovelies.app/admin/?preview=1','https://evil-localhost.example/admin/?preview=1','http://localhost/admin/','http://localhost/admin/?preview=true'])assert.equal(previewAllowed({href}),false,href);
  for(const href of ['http://127.0.0.1/admin/?preview=1','http://localhost/admin/?preview=1','http://[::1]/admin/?preview=1'])assert.equal(previewAllowed({href}),true,href);
});
test('routes have a bounded query and reject invented destinations',()=>{
  assert.deepEqual(parseRoute('#privacy?q=Alice'),{route:'privacy',q:'Alice',filter:'all'});
  assert.equal(parseRoute('#invented').route,'overview');assert.equal(parseRoute('#users?q='+'x'.repeat(500)).q.length,100);
});
test('support review sends the current revision and named notes contract',()=>{
  assert.deepEqual(reviewIntent('support',{id:id(1),revision:3},'approve',' verified request ',id(2)),{path:`/admin/support-requests/${id(1)}/approve`,body:{review_notes:'verified request',expected_revision:3,operation_key:id(2)}});
});
test('safety and match review retain their distinct numeric and UUID revisions',()=>{
  assert.equal(reviewIntent('safety',{id:id(1),revision:2},'hold','Reviewed scope',id(2)).body.expected_revision,2);
  assert.equal(reviewIntent('match',{id:id(1),version:id(3)},'reject','Reviewed incorrect match',id(2)).body.expected_revision,id(3));
  assert.throws(()=>reviewIntent('safety',{id:id(1),revision:0},'resolve','Reviewed scope',id(2)));
  assert.throws(()=>reviewIntent('match',{id:id(1),version:2},'approve','Reviewed scope',id(2)));
});
test('privacy approval and explicit processing use only the accepted fields',()=>{
  assert.deepEqual(reviewIntent('privacy',{id:id(1)},'approve','Independent review',id(2)),{path:`/privacy-requests/${id(1)}/approve`,body:{reason:'Independent review',operation_key:id(2)}});
  assert.deepEqual(reviewIntent('privacy',{id:id(1)},'process','Process approved request',id(2)),{path:`/privacy-requests/${id(1)}/process`,body:{}});
});
test('session revocation names the exact account and session with an original operation key',()=>{
  assert.deepEqual(reviewIntent('session',{id:id(1)},id(3),'Device lost',id(2)),{path:`/admin/users/${id(1)}/sessions/revoke`,body:{session_id:id(3),reason:'Device lost',operation_key:id(2)}});
});
test('invalid paths, actions, note control bytes and missing review reasons fail before dispatch',()=>{
  for(const [kind,row,action,reason,key] of [['support',{id:'../../admin',revision:1},'approve','note',id(2)],['support',{id:id(1),revision:1},'grant_admin','note',id(2)],['privacy',{id:id(1)},'approve','',id(2)],['safety',{id:id(1),revision:1},'hold','a\nb',id(2)],['session',{id:id(1)},'not-a-session','Device lost',id(2)],['privacy',{id:id(1)},'approve','Review','not-a-key']])assert.throws(()=>reviewIntent(kind,row,action,reason,key));
});
test('server record copy is escaped and no raw metadata or private media is rendered',()=>{
  const html=recordTable('support',[{id:id(1),subject:'<img src=x onerror=alert(1)>',status:'open',created_at:0,template:'private-template',token:'private-token',photo_url:'https://private.example/image'}]);
  assert(html.includes('&lt;img'));assert(!html.includes('<img'));assert(!html.includes('private-template'));assert(!html.includes('private-token'));assert(!html.includes('private.example'));assert(html.includes('scope="col"'));
});

function harness({hash='#overview',operator=false,deferDialogClose=false}={}) {
  const dialogCloses=[];
  class Element {
    constructor(){this.innerHTML='';this.textContent='';this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.open=false;this.firstElementChild={textContent:''};this.listeners=new Map();this.classList={add(){}};}
    setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}replaceChildren(){}focus(){this.focused=true;}
    close(){const wasOpen=this.open;this.open=false;if(wasOpen){const dispatch=()=>this.listeners.get('close')?.({target:this});if(deferDialogClose)dialogCloses.push(dispatch);else queueMicrotask(dispatch);}}
    showModal(){this.open=true;}prepend(){}insertAdjacentHTML(_where,html){this.innerHTML+=html;}addEventListener(k,v){this.listeners.set(k,v);}querySelector(){return null;}
  }
  const elements=new Map(),events=new Map(),windowEvents=new Map(),calls=[];
  const get=s=>{if(!elements.has(s))elements.set(s,new Element());return elements.get(s);};
  const document={hidden:false,body:{classList:{add(){}}},querySelector:get,createElement:()=>new Element(),addEventListener:(type,callback)=>events.set(type,callback)};
  const window={navigator:{onLine:true},location:{hash},requestAnimationFrame:fn=>fn(),setTimeout,FormData:class{},addEventListener:(type,callback)=>windowEvents.set(type,callback),URL:{revokeObjectURL(){}}};
  const session={operator:operator?{user_id:id(9),roles:['admin']}:null,credentials:operator?{}:null,challenge:null,captures:[],state:{reference:{},pendingAction:null},cancelled:0,
    async restore(){return {registered:true,pending:false};},cancelCapture(){this.challenge=null;this.captures=[];this.cancelled++;},async request(path){calls.push(path);return {accounts:4,uploads:8,active_grants:3,open_support:2,open_reports:1};}};
  return {document,window,session,events,windowEvents,calls,get,flushDialogCloses(){while(dialogCloses.length)dialogCloses.shift()();}};
}
test('initial protected shell reads private device state without calling an API or displaying sample rows',async()=>{
  const h=harness();await startWorkspace(h);const html=h.get('#main').innerHTML;
  assert(html.includes('Verify my face'));assert(!html.includes('Alex Morgan'));assert(!html.includes('Sample operator'));assert.deepEqual(h.calls,[]);
});
test('delegated support workspace opens only its permitted queue and read-only details have no decision form',async()=>{
 const h=harness({operator:true});h.session.operator={user_id:id(9),roles:['user'],operator_capabilities:['support.read']};
 const row={id:id(1),subject:'Scoped support case',status:'open',revision:1};
 h.session.request=async path=>{h.calls.push(path);return path.startsWith('/admin/support-requests/'+id(1))?{support_request:row,history:[],page:{limit:25,total:0,next_cursor:null}}:{support_requests:[row],page:{limit:25,total:1,next_cursor:null}};};
 const app=await startWorkspace(h);await app.refresh();
 assert.deepEqual(permittedRoutes(h.session.operator),['support']);assert(h.calls[0].startsWith('/admin/support-requests?'));
 const links=h.get('#navigation').innerHTML;assert(links.includes('#support'));for(const route of ['#privacy','#users','#uploads','#operators'])assert(!links.includes(route));
 h.events.get('click')({target:{closest:()=>({dataset:{live:'detail',kind:'support',id:id(1)}})}});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert(h.get('#detail-dialog').innerHTML.includes('Scoped support case'));assert(!h.get('#detail-dialog').innerHTML.includes('live-review-form'));
});
test('operator access is visible only to existing administrators and action scopes do not imply unrelated routes',()=>{
 assert(permittedRoutes({roles:['admin']}).includes('operators'));
 assert.deepEqual(permittedRoutes({roles:['user'],operator_capabilities:['uploads.read','uploads.recover']}),['uploads']);
 assert.deepEqual(permittedRoutes({roles:['user'],operator_capabilities:[]}),[]);
});
test('delegated privacy readers never receive admin-only queue recovery controls or dispatch',async()=>{
 const h=harness({operator:true,hash:'#privacy'}),job='a'.repeat(64);
 h.session.operator={user_id:id(9),roles:['user'],operator_capabilities:['privacy.read']};
 const row={id:id(1),status:'processing',request_type:'delete',diagnostics:{queue:{job_id:job,state:'failed'}}};
 h.session.request=async route=>{h.calls.push(route);return route.startsWith('/privacy-requests/')?{privacy_request:row}:{privacy_requests:[row],page:{limit:25,total:1,next_cursor:null}};};
 const app=await startWorkspace(h);await app.refresh();
 h.events.get('click')({target:{closest:()=>({dataset:{live:'detail',kind:'privacy',id:id(1)}})}});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert(h.get('#detail-dialog').open);assert(!h.get('#detail-dialog').innerHTML.includes('Inspect work recovery'));
 h.events.get('click')({target:{closest:()=>({dataset:{live:'inspect-queue',jobId:job}})}});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert(!h.calls.some(route=>route.startsWith('/admin/queue-repairs/')));assert(h.session.operator);
});
test('authorized overview uses actual response values; offline clears those records',async()=>{
  const h=harness({operator:true}),app=await startWorkspace(h);await app.refresh();
  assert.deepEqual(h.calls,['/admin/metrics']);assert(h.get('#main').innerHTML.includes('<strong>4</strong>'));
  h.window.navigator.onLine=false;h.windowEvents.get('offline')();assert(!h.get('#main').innerHTML.includes('<strong>4</strong>'));assert(h.session.cancelled>0);
});
test('401 discards private list and returns to face authentication',async()=>{
  const h=harness({operator:true}),app=await startWorkspace(h);await app.refresh();
  h.session.request=async()=>{h.session.credentials=null;h.session.operator=null;throw Object.assign(new Error('session_revoked'),{status:401});};
  await app.refresh();const html=h.get('#main').innerHTML;assert(html.includes('Verify my face'));assert(!html.includes('<strong>4</strong>'));assert(html.includes('authorization expired or was revoked'));
});
test('an unknown operation remains explicit and does not dispatch automatically after restore',async()=>{
  const h=harness({operator:true});h.session.state.pendingAction={path:`/privacy-requests/${id(1)}/approve`,body:{reason:'Review',operation_key:id(2)},accountId:id(9)};
  await startWorkspace(h);assert(h.get('#main').innerHTML.includes('Retry original action'));assert.deepEqual(h.calls,[]);
});
test('background clears private records and fences the active capture without deleting stored identity',async()=>{
  const h=harness({operator:true}),app=await startWorkspace(h);await app.refresh();h.session.challenge={required_captures:3};h.document.hidden=true;h.events.get('visibilitychange')();
  assert.equal(h.session.challenge,null);assert(h.session.state.reference);assert(h.get('#main').innerHTML.includes('Private workspace paused'));assert(!h.get('#main').innerHTML.includes('<strong>4</strong>'));
});
test('logout clears authority immediately while a list operation is still busy',async()=>{
 const h=harness({operator:true}),app=await startWorkspace(h);let release,logoutCalls=0;
 h.session.request=()=>new Promise(resolve=>release=resolve);
 h.session.logout=async()=>{logoutCalls++;h.session.credentials=null;h.session.operator=null;};
 const pending=app.refresh();assert(h.get('#main').innerHTML.includes('Loading current records'));
 h.events.get('click')({target:{closest:()=>({dataset:{live:'logout'}})}});
 assert.equal(logoutCalls,1);assert.equal(h.session.credentials,null);assert.equal(h.session.operator,null);
 release({accounts:99});await pending;assert(!h.get('#main').innerHTML.includes('<strong>99</strong>'));assert(h.get('#main').innerHTML.includes('Verify my face'));
});
test('account detail reply cannot reopen a dialog after navigation changes',async()=>{
 const h=harness({operator:true,hash:'#users'}),app=await startWorkspace(h);let release;
 h.session.request=async path=>path==='/admin/users/'+id(1)?new Promise(resolve=>release=resolve):{users:[{id:id(1),name:'Protected account',status:'active'}]};
 await app.refresh();h.events.get('click')({target:{closest:()=>({dataset:{live:'detail',kind:'users',id:id(1)}})}});
 h.window.location.hash='#overview';h.windowEvents.get('hashchange')();
 release({user:{id:id(1),name:'Protected account'},audience:unknownAudience(id(1)),sessions:[],cases:{},history:[]});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.get('#detail-dialog').open,false);assert(!h.get('#detail-dialog').innerHTML.includes('Protected account'));
});
test('guardian review shows exact requested purposes without raw evidence or private media',async()=>{
 const h=harness({operator:true,hash:'#guardians'}),app=await startWorkspace(h);
 const row={id:id(1),child_account_id:id(2),guardian_account_id:id(3),revision:2,state:'under_review',policy_version:AUDIENCE_POLICY,
   requested_purposes:['face_authentication'],evidence_recorded:false,evidence_reference:'private-evidence-record',photo_url:'https://private.example/image'};
 h.session.request=async()=>({guardian_requests:[row]});await app.refresh();
 h.events.get('click')({target:{closest:()=>({dataset:{live:'detail',kind:'guardians',id:id(1)}})}});
 await new Promise(resolve=>setImmediate(resolve));const dialog=h.get('#detail-dialog');
 assert.equal(dialog.open,true);assert(dialog.innerHTML.includes('face_authentication'));assert(dialog.innerHTML.includes('live-guardian-form'));
 assert(dialog.innerHTML.includes('<option value="reject">Reject</option>'));assert(!dialog.innerHTML.includes('private-evidence-record'));assert(!dialog.innerHTML.includes('private.example'));
});

test('a known product denial removes guardian records and detail DOM while preserving weak credentials and the exact saved action',async()=>{
 const h=harness({operator:true,hash:'#guardians'}),app=await startWorkspace(h);
 const row={id:id(1),child_account_id:id(2),guardian_account_id:id(3),revision:2,state:'under_review',policy_version:AUDIENCE_POLICY,requested_purposes:['face_authentication']};
 h.session.request=async()=>({guardian_requests:[row]});await app.refresh();
 h.events.get('click')({target:{closest:()=>({dataset:{live:'detail',kind:'guardians',id:id(1)}})}});
 await new Promise(resolve=>setImmediate(resolve));assert(h.get('#detail-dialog').innerHTML.includes(id(2)));
 const credentials=h.session.credentials,reference=h.session.state.reference,pending={path:`/admin/guardian-requests/${id(1)}/review`,body:{operation_key:id(4)},accountId:id(9)};
 h.session.state.pendingAction=pending;
 h.session.request=async()=>{h.session.operator=null;throw Object.assign(new Error('audience_restricted'),{code:'audience_restricted',status:403});};
 await app.refresh();
 assert.equal(h.get('#detail-dialog').open,false);assert.equal(h.get('#detail-dialog').innerHTML,'');
 assert(!h.get('#main').innerHTML.includes(id(2)));assert(h.get('#main').innerHTML.includes('Verify my face'));
 assert.equal(h.session.credentials,credentials);assert.equal(h.session.state.reference,reference);assert.equal(h.session.state.pendingAction,pending);
});

test('authority expiry, cancellation or challenge replacement during encoding prevents reading the encoded photo bytes',async t=>{
 for(const change of ['expiry','cancel','replacement'])await t.test(change,async()=>{
  const h=harness();await startWorkspace(h);let clock=Date.now(),encoded,finishEncoding,playing,reads=0,urls=0,stopped=0;
  const ready=new Promise(resolve=>encoded=resolve),cameraReady=new Promise(resolve=>playing=resolve);
  const challenge={account_id:id(1),challenge_id:id(2),device_id:id(3),purpose:'login',required_captures:1,expires_at:new Date(clock+60000).toISOString(),
   audience_authority:{protocol:'lovelies-audience-challenge-v1',policy_version:AUDIENCE_POLICY,account_id:id(1),challenge_id:id(2),device_id:id(3),purpose:'login',audience_version:1,expires_at:new Date(clock+1000).toISOString()}};
  h.session.challenge=challenge;h.session.epoch=0;h.session.now=()=>clock;
  h.session.cancelCapture=()=>{h.session.epoch++;h.session.challenge=null;h.session.captures=[];h.session.cancelled++;};
  h.window.navigator.mediaDevices={async getUserMedia(){return {getTracks:()=>[{stop(){stopped++;}}]};}};
  const video=h.get('#operator-camera');video.videoWidth=640;video.videoHeight=480;video.play=async()=>{playing();};
  const canvas={width:0,height:0,getContext:()=>({drawImage(){}}),toBlob(callback){finishEncoding=callback;encoded();}};
  h.document.createElement=kind=>{assert.equal(kind,'canvas');return canvas;};
  h.window.URL.createObjectURL=()=>{urls++;return 'blob:unsent-review';};
  h.events.get('click')({target:{closest:()=>({dataset:{live:'resume-camera'}})}});await cameraReady;await new Promise(resolve=>setImmediate(resolve));
  h.events.get('click')({target:{closest:()=>({dataset:{live:'shutter'}})}});await ready;
  if(change==='expiry')clock+=1001;
  else if(change==='cancel')h.events.get('click')({target:{closest:()=>({dataset:{live:'cancel-camera'}})}});
  else h.session.challenge={...challenge};
  finishEncoding({async arrayBuffer(){reads++;return new Uint8Array([1,2,3]).buffer;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,0);assert.equal(urls,0);assert(stopped>0);assert.equal(canvas.width,1);assert.equal(canvas.height,1);
 });
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const click=(h,live,extra={})=>h.events.get('click')({target:{closest:()=>({dataset:{live,...extra}})}});
test('all queue queries carry search, status and complete collection identity to the server',()=>{
 for(const route of ['users','support','privacy','guardians','uploads','match-reports']) {
  const state={route,q:'literal %_ & account',filter:route==='users'?'registered':'all',collection:'matches'};
  const params=new URLSearchParams(queueQuery(state,'cursor-value'));
  assert.equal(params.get('q'),state.q);assert.equal(params.get('status'),state.filter);assert.equal(params.get('cursor'),'cursor-value');assert.equal(params.get('limit'),'25');
  assert.equal(params.has('collection'),route==='match-reports');
 }
 assert(queueStatuses({route:'guardians'}).includes('under_review'));
 assert.throws(()=>queueQuery({route:'support'},'bad cursor'));
 for(const page of [{limit:101,next_cursor:null},{limit:25,next_cursor:'bad cursor'},{limit:25,next_cursor:null,total:-1}])assert.throws(()=>queuePage(page));
});
test('support next/previous pages reach server records beyond a bounded first response',async()=>{
 const h=harness({operator:true,hash:'#support'}),app=await startWorkspace(h),paths=[];
 h.session.request=async path=>{paths.push(path);const cursor=new URL(path,'http://fixture').searchParams.get('cursor');return {support_requests:[{id:id(cursor?102:1),subject:cursor?'Later case':'First case',status:'open',revision:1}],page:{limit:25,total:101,next_cursor:cursor?null:'next-cursor'}};};
 await app.refresh();assert(h.get('#main').innerHTML.includes('101 matching records'));assert(h.get('#main').innerHTML.includes('First case'));
 click(h,'next-page');await settle();assert(h.get('#main').innerHTML.includes('Later case'));assert(!h.get('#main').innerHTML.includes('First case'));assert(h.get('#main').innerHTML.includes('Page 2'));
 click(h,'previous-page');await settle();assert(h.get('#main').innerHTML.includes('First case'));assert(h.get('#main').innerHTML.includes('Page 1'));
 assert.deepEqual(paths.map(path=>new URL(path,'http://fixture').searchParams.get('cursor')),[null,'next-cursor',null]);
});
test('server search results are not discarded by a second incompatible browser filter',async()=>{
 const h=harness({operator:true,hash:'#support?q=owner-id'}),app=await startWorkspace(h);let path;
 h.session.request=async value=>{path=value;return {support_requests:[{id:id(1),subject:'A case matched by its owner',status:'open'}],page:{limit:25,total:1,next_cursor:null}};};
 await app.refresh();assert.equal(new URL(path,'http://fixture').searchParams.get('q'),'owner-id');assert(h.get('#main').innerHTML.includes('A case matched by its owner'));assert(!h.get('#main').innerHTML.includes('Search filters this loaded set'));
});
test('safety collection switches retain independent query and cursor identity',async()=>{
 const h=harness({operator:true,hash:'#match-reports?collection=matches&filter=needs_review'}),app=await startWorkspace(h);let path;
 h.session.request=async value=>{path=value;return {reports:[],matches:[{id:id(2),version:id(3),status:'needs_review'}],page:{limit:25,total:1,next_cursor:null}};};
 await app.refresh();const params=new URL(path,'http://fixture').searchParams;assert.equal(params.get('collection'),'matches');assert.equal(params.get('status'),'needs_review');assert(h.get('#main').innerHTML.includes('data-kind="match"'));
 click(h,'safety-reports');assert.equal(h.window.location.hash,'match-reports');
});
test('support detail renders retained rationale and updated revision without raw receipt fields',async()=>{
 const h=harness({operator:true,hash:'#support'}),app=await startWorkspace(h);
 h.session.request=async path=>new URL(path,'http://fixture').pathname.endsWith(id(1))?{
  support_request:{id:id(1),subject:'Case',status:'under_review',revision:3},
  history:[{id:'receipt',action:'support.start',actor_id:id(9),created_at:1000,status:'under_review',revision:2,review_notes:'<script>unsafe markup</script>',payload_json:'private-raw-payload'}],
  page:{limit:25,total:1,next_cursor:null},
 }:{support_requests:[{id:id(1),subject:'Case',status:'open',revision:1}],page:{limit:25,total:1,next_cursor:null}};
 await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await settle();const html=h.get('#detail-dialog').innerHTML;
 assert(html.includes('Decision history'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(!html.includes('private-raw-payload'));assert(html.includes('Retired receipts are not reconstructed'));
});
test('upload diagnostics display job failure metadata without private service fields',async()=>{
 const h=harness({operator:true,hash:'#uploads'}),app=await startWorkspace(h);
 h.session.request=async path=>new URL(path,'http://fixture').pathname.endsWith(id(1))?{
  upload:{id:id(1),title:'Photo',status:'failed',object_key:'private-object'},
  attempts:[{id:id(2),status:'failed',error_code:'inference_unavailable',processor_nonce:'private-nonce',job:{state:'failed',attempts:20,lease_token:'private-lease'},outbox:{status:'dispatched'}}],
  diagnostics:{observed_at:1000,moderation_hold:false},page:{limit:25,total:1,next_cursor:null},
 }:{uploads:[{id:id(1),title:'Photo',status:'failed'}],page:{limit:25,total:1,next_cursor:null}};
 await app.refresh();click(h,'detail',{kind:'uploads',id:id(1)});await settle();const html=h.get('#detail-dialog').innerHTML;
 assert(html.includes('Processing attempts'));assert(html.includes('inference_unavailable'));assert(html.includes('20'));
 for(const secret of ['private-object','private-nonce','private-lease'])assert(!html.includes(secret));
});
test('a late case history cannot reopen the protected detail after logout',async()=>{
 const h=harness({operator:true,hash:'#support'}),app=await startWorkspace(h);let release;
 h.session.request=async path=>new URL(path,'http://fixture').pathname.endsWith(id(1))?new Promise(resolve=>release=resolve):{support_requests:[{id:id(1),subject:'Case',status:'open',revision:1}]};
 h.session.logout=async()=>{h.session.operator=null;h.session.credentials=null;};
 await app.refresh();click(h,'detail',{kind:'support',id:id(1)});click(h,'logout');
 release({support_request:{id:id(1),subject:'Private case',status:'open',revision:1},history:[],page:{limit:25,total:0,next_cursor:null}});await settle();
 assert.equal(h.get('#detail-dialog').open,false);assert(!h.get('#detail-dialog').innerHTML.includes('Private case'));
});

const supportRecord=(number,subject)=>({id:id(number),subject,status:'open',revision:1});
const supportDetail=(record,next=null)=>({support_request:record,history:[],page:{limit:25,total:next?26:1,next_cursor:next}});
test('closing a pending history permits a new record; old close events and replies cannot replace it',async()=>{
 const h=harness({operator:true,hash:'#support',deferDialogClose:true}),first=supportRecord(1,'First private case'),second=supportRecord(2,'Newly selected case');
 let releaseHistory,releaseSecond;
 h.session.request=async path=>{
  const url=new URL(path,'http://fixture');
  if(url.pathname.endsWith(id(2)))return new Promise(resolve=>releaseSecond=resolve);
  if(url.pathname.endsWith(id(1)))return url.searchParams.has('cursor')?new Promise(resolve=>releaseHistory=resolve):supportDetail(first,'next-history');
  return {support_requests:[first,second],page:{limit:25,total:2,next_cursor:null}};
 };
 const app=await startWorkspace(h);await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await settle();
 const dialog=h.get('#detail-dialog');assert.equal(dialog.open,true);
 click(h,'detail-next',{kind:'support',id:id(1)});assert.equal(typeof releaseHistory,'function');
 click(h,'close-detail');assert.equal(dialog.open,false);assert.equal(dialog.innerHTML,'');
 click(h,'detail',{kind:'support',id:id(2)});assert.equal(typeof releaseSecond,'function','dismissal releases only the cancelled detail read');
 h.flushDialogCloses();releaseSecond(supportDetail(second));await settle();
 assert.equal(dialog.open,true);assert(dialog.innerHTML.includes(second.subject));
 const current=dialog.innerHTML;releaseHistory(supportDetail({...first,subject:'Late dismissed history'}));await settle();
 assert.equal(dialog.innerHTML,current);assert.equal(dialog.open,true);
});
test('a queued native close cannot cancel a new request begun after the old dialog was already closed',async()=>{
 const h=harness({operator:true,hash:'#support',deferDialogClose:true}),first=supportRecord(1,'Closed private case'),second=supportRecord(2,'New request after native close');let releaseSecond;
 h.session.request=async path=>{
  const url=new URL(path,'http://fixture');
  if(url.pathname.endsWith(id(2)))return new Promise(resolve=>releaseSecond=resolve);
  if(url.pathname.endsWith(id(1)))return supportDetail(first);
  return {support_requests:[first,second],page:{limit:25,total:2,next_cursor:null}};
 };
 const app=await startWorkspace(h);await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await settle();
 const dialog=h.get('#detail-dialog');assert.equal(dialog.open,true);dialog.close();
 click(h,'detail',{kind:'support',id:id(2)});assert.equal(typeof releaseSecond,'function');
 assert.equal(dialog.innerHTML,'','the already-closed private record is removed before the new read waits');
 h.flushDialogCloses();releaseSecond(supportDetail(second));await settle();
 assert.equal(dialog.open,true);assert(dialog.innerHTML.includes(second.subject));assert(!dialog.innerHTML.includes(first.subject));
});
test('a history reply cannot reopen a native-closed dialog before its close event is delivered',async()=>{
 const h=harness({operator:true,hash:'#support',deferDialogClose:true}),record=supportRecord(1,'Closed history owner');let releaseHistory;
 h.session.request=async path=>{
  const url=new URL(path,'http://fixture');
  if(url.pathname.endsWith(id(1)))return url.searchParams.has('cursor')?new Promise(resolve=>releaseHistory=resolve):supportDetail(record,'next-history');
  return {support_requests:[record],page:{limit:25,total:1,next_cursor:null}};
 };
 const app=await startWorkspace(h);await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await settle();
 click(h,'detail-next',{kind:'support',id:id(1)});const dialog=h.get('#detail-dialog');dialog.close();
 releaseHistory(supportDetail({...record,subject:'Reply before queued close'}));await settle();
 assert.equal(dialog.open,false);assert.equal(dialog.innerHTML,'');h.flushDialogCloses();
 assert.equal(dialog.open,false);assert.equal(dialog.innerHTML,'');
});
test('native Escape cancels history ownership and its later error cannot overwrite a newer error',async()=>{
 const h=harness({operator:true,hash:'#support'}),first=supportRecord(1,'Dismissed private case'),second=supportRecord(2,'Second case');let rejectHistory;
 h.session.request=async path=>{
  const url=new URL(path,'http://fixture');
  if(url.pathname.endsWith(id(2)))throw new Error('invalid_response');
  if(url.pathname.endsWith(id(1)))return url.searchParams.has('cursor')?new Promise((_resolve,reject)=>rejectHistory=reject):supportDetail(first,'next-history');
  return {support_requests:[first,second],page:{limit:25,total:2,next_cursor:null}};
 };
 const app=await startWorkspace(h);await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await settle();
 click(h,'detail-next',{kind:'support',id:id(1)});const dialog=h.get('#detail-dialog');let prevented=false;
 dialog.listeners.get('cancel')({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(dialog.open,false);assert.equal(dialog.innerHTML,'');
 click(h,'detail',{kind:'support',id:id(2)});await settle();
 const current=h.get('#main').innerHTML;assert(current.includes('server returned an unexpected response'));
 rejectHistory(Object.assign(new Error('private_write_failed'),{code:'private_write_failed'}));await settle();
 assert.equal(h.get('#main').innerHTML,current);assert.equal(dialog.open,false);assert.equal(dialog.innerHTML,'');
});
test('native dialog close retires pending history and removes its private DOM',async()=>{
 const h=harness({operator:true,hash:'#support'}),record=supportRecord(1,'Native-close case');let releaseHistory;
 h.session.request=async path=>{
  const url=new URL(path,'http://fixture');
  if(url.pathname.endsWith(id(1)))return url.searchParams.has('cursor')?new Promise(resolve=>releaseHistory=resolve):supportDetail(record,'next-history');
  return {support_requests:[record],page:{limit:25,total:1,next_cursor:null}};
 };
 const app=await startWorkspace(h);await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await settle();
 click(h,'detail-next',{kind:'support',id:id(1)});const dialog=h.get('#detail-dialog');dialog.close();await settle();
 assert.equal(dialog.innerHTML,'');releaseHistory(supportDetail({...record,subject:'Late native-close response'}));await settle();
 assert.equal(dialog.open,false);assert.equal(dialog.innerHTML,'');
});
test('a dismissed detail that discovers current authority loss still clears private records',async()=>{
 const h=harness({operator:true,hash:'#support'}),record=supportRecord(1,'Protected queue record');let rejectHistory;
 h.session.request=async path=>{
  const url=new URL(path,'http://fixture');
  if(url.pathname.endsWith(id(1)))return url.searchParams.has('cursor')?new Promise((_resolve,reject)=>rejectHistory=reject):supportDetail(record,'next-history');
  return {support_requests:[record],page:{limit:25,total:1,next_cursor:null}};
 };
 const app=await startWorkspace(h);await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await settle();
 click(h,'detail-next',{kind:'support',id:id(1)});click(h,'close-detail');
 const credentials=h.session.credentials,pending={path:'/admin/original',body:{operation_key:id(7)},accountId:id(9)};h.session.state.pendingAction=pending;
 h.session.operator=null;rejectHistory(Object.assign(new Error('operator_capability_required'),{code:'operator_capability_required',status:403}));await settle();
 assert(!h.get('#main').innerHTML.includes(record.subject));assert(h.get('#main').innerHTML.includes('Verify my face'));
 assert.equal(h.get('#detail-dialog').innerHTML,'');assert.equal(h.session.credentials,credentials);assert.equal(h.session.state.pendingAction,pending);
});
test('skip link focuses the current queue without changing its hash, records or history',async()=>{
 const h=harness({operator:true,hash:'#support?q=priority&filter=open'});let calls=0;
 h.window.history={pushState(){assert.fail('Skip must not add history');},replaceState(){assert.fail('Skip must not replace history');}};
 h.session.request=async()=>{calls++;return {support_requests:[supportRecord(1,'Current filtered case')],page:{limit:25,total:1,next_cursor:null}};};
 const app=await startWorkspace(h);await app.refresh();const current=h.get('#main').innerHTML,hash=h.window.location.hash;let prevented=false;
 h.get('.skip-link').listeners.get('click')({preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(h.get('#main').focused,true);assert.equal(h.window.location.hash,hash);
 assert.equal(h.get('#main').innerHTML,current);assert.equal(calls,1);
});
