import assert from 'node:assert/strict';
import test from 'node:test';
import {previewAllowed} from './entry.mjs';
import {parseRoute,reviewIntent,queueRepairIntent,recordTable,startWorkspace} from './live-app.mjs';
import {AUDIENCE_POLICY} from './audience.mjs';
import {ReviewDrafts} from './review-drafts.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const unknownAudience=account=>({protocol:'lovelies-audience-v2',policy_version:AUDIENCE_POLICY,account_id:account,
 authority_expires_at:null,
 audience:{at_least_13:null,guardian_required:null,status:'unknown',version:0,policy_version:null,source:null,rule_version:null,territory:null,declared_at:null,next_review_at:null,review_required:false},
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
test('queue repair submits only an eligible exact server fingerprint and requires a fresh reason',()=>{
 const preview={job_id:'a'.repeat(64),fingerprint:'b'.repeat(64),category:'photo',domain_id:id(1),eligible:true,action:'resume_exact_work'};
 assert.deepEqual(queueRepairIntent(preview,' Review original work ',id(2)),{path:'/admin/queue-repairs/'+'a'.repeat(64),body:{operation_key:id(2),expected_fingerprint:'b'.repeat(64),reason:'Review original work'}});
 for(const changed of [{eligible:false},{fingerprint:'invalid'},{job_id:'../other'},{category:'invented'},{action:'restart'},{domain_id:'invalid'}])assert.throws(()=>queueRepairIntent({...preview,...changed},'Review work',id(2)));
 assert.throws(()=>queueRepairIntent(preview,'',id(2)));assert.throws(()=>queueRepairIntent(preview,'New\nline',id(2)));
});
test('invalid paths, actions, note control bytes and missing review reasons fail before dispatch',()=>{
  for(const [kind,row,action,reason,key] of [['support',{id:'../../admin',revision:1},'approve','note',id(2)],['support',{id:id(1),revision:1},'grant_admin','note',id(2)],['privacy',{id:id(1)},'approve','',id(2)],['safety',{id:id(1),revision:1},'hold','a\nb',id(2)],['session',{id:id(1)},'not-a-session','Device lost',id(2)],['privacy',{id:id(1)},'approve','Review','not-a-key']])assert.throws(()=>reviewIntent(kind,row,action,reason,key));
});
test('server record copy is escaped and no raw metadata or private media is rendered',()=>{
  const html=recordTable('support',[{id:id(1),subject:'<img src=x onerror=alert(1)>',status:'open',created_at:0,template:'private-template',token:'private-token',photo_url:'https://private.example/image'}]);
  assert(html.includes('&lt;img'));assert(!html.includes('<img'));assert(!html.includes('private-template'));assert(!html.includes('private-token'));assert(!html.includes('private.example'));assert(html.includes('scope="col"'));
});
test('table navigation is keyboard scrollable and each review action has an exact record name',()=>{
 const html=recordTable('support',[{id:id(1),subject:'Same title',status:'open'},{id:id(2),subject:'Same title',status:'open'}]);
 assert(html.includes('role="region" tabindex="0"'));assert(html.includes('<caption class="sr-only">Support</caption>'));
 assert(html.includes('aria-label="Review Same title; record '+id(1)+'"'));assert(html.includes('aria-label="Review Same title; record '+id(2)+'"'));
});

function harness({hash='#overview',operator=false}={}) {
  class Element {
    constructor(){this.innerHTML='';this.textContent='';this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.open=false;this.firstElementChild={textContent:''};this.listeners=new Map();this.classList={add(){}};}
    setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}replaceChildren(){}focus(){this.focused=true;}close(){this.open=false;}showModal(){this.open=true;}prepend(){}insertAdjacentHTML(_where,html){this.innerHTML+=html;}addEventListener(k,v){this.listeners.set(k,v);}querySelector(){return null;}
  }
  const elements=new Map(),events=new Map(),windowEvents=new Map(),calls=[];
  const get=s=>{if(!elements.has(s))elements.set(s,new Element());return elements.get(s);};
  const document={hidden:false,body:{classList:{add(){}}},querySelector:get,createElement:()=>new Element(),addEventListener:(type,callback)=>events.set(type,callback)};
  const window={navigator:{onLine:true},location:{hash},requestAnimationFrame:fn=>fn(),setTimeout,FormData:class{},addEventListener:(type,callback)=>windowEvents.set(type,callback),URL:{revokeObjectURL(){}}};
  const session={operator:operator?{user_id:id(9),roles:['admin']}:null,credentials:operator?{}:null,challenge:null,captures:[],audienceReview:null,state:{reference:{},pendingAction:null},cancelled:0,
    async restore(){return {registered:true,pending:false};},cancelCapture(){this.challenge=null;this.captures=[];this.audienceReview=null;this.cancelled++;},async request(path){calls.push(path);return {accounts:4,uploads:8,active_grants:3,open_support:2,open_reports:1};}};
  return {document,window,session,events,windowEvents,calls,get};
}
test('initial protected shell reads private device state without calling an API or displaying sample rows',async()=>{
  const h=harness();await startWorkspace(h);const html=h.get('#main').innerHTML;
  assert(html.includes('Verify my face'));assert(!html.includes('Alex Morgan'));assert(!html.includes('Sample operator'));assert.deepEqual(h.calls,[]);
});
test('narrow navigation exposes the existing utilities with current sign-out authority and no unsupported installation offer',async()=>{
 for(const operator of [false,true]){
  const h=harness({operator});await startWorkspace(h);const html=h.get('#mobile-navigation').innerHTML;
  assert(html.includes('class="mobile-utilities"'));assert(html.includes('Workspace help'));assert(html.includes('Sign out'));
  const logout=html.match(/<button\b[^>]*data-action="logout"[^>]*>/)?.[0];assert(logout);
  assert.equal(/\bdisabled\b/.test(logout),!operator);assert(logout.includes('aria-label="Sign out and clear private workspace"'));
  const install=html.match(/<button\b[^>]*id="mobile-install-button"[^>]*>/)?.[0];assert(install);assert(/\bhidden\b/.test(install));
  assert.equal(h.get('#install-button').hidden,true);assert.deepEqual(h.calls,[]);
 }
});
test('mobile help closes its modal and is visible with focus in both public and authorized content',async()=>{
 for(const operator of [false,true]){
  const h=harness({operator});await startWorkspace(h);const reference=h.session.state.reference;
  h.get('#navigation-dialog').showModal();h.events.get('click')({target:{closest:()=>({dataset:{action:'about'}})}});
  assert.equal(h.get('#navigation-dialog').open,false);assert.equal(h.get('#main').focused,true);
  assert(h.get('#main').innerHTML.includes('Operator roles require independent provisioning.'));
  assert.equal(h.session.state.reference,reference);assert.equal(!!h.session.operator,operator);assert.deepEqual(h.calls,[]);
 }
});
test('Escape closes mobile navigation and returns focus without changing account authority or pending work',async()=>{
 const h=harness({operator:true});await startWorkspace(h);const operator=h.session.operator,pending={operation_key:id(4)};
 h.session.state.pendingAction=pending;h.get('#navigation-dialog').showModal();let prevented=false;
 h.get('#navigation-dialog').listeners.get('cancel')({preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(h.get('#navigation-dialog').open,false);assert.equal(h.get('.mobile-menu').focused,true);
 assert.equal(h.session.operator,operator);assert.equal(h.session.state.pendingAction,pending);assert.deepEqual(h.calls,[]);
});
test('a browser install offer is shared by both layouts and consumed only once',async()=>{
 const h=harness({operator:true});await startWorkspace(h);let prompts=0,prevented=0;
 const offer={preventDefault(){prevented++;},prompt(){prompts++;return Promise.resolve();}};
 h.windowEvents.get('beforeinstallprompt')(offer);
 assert.equal(prevented,1);assert.equal(h.get('#install-button').hidden,false);assert.equal(h.get('#mobile-install-button').hidden,false);
 h.get('#navigation-dialog').showModal();h.events.get('click')({target:{closest:()=>({dataset:{action:'install'}})}});
 assert.equal(prompts,1);assert.equal(h.get('#navigation-dialog').open,false);assert.equal(h.get('#main').focused,true);
 assert.equal(h.get('#install-button').hidden,true);assert.equal(h.get('#mobile-install-button').hidden,true);
 h.events.get('click')({target:{closest:()=>({dataset:{action:'install'}})}});assert.equal(prompts,1);
 h.windowEvents.get('beforeinstallprompt')(offer);h.windowEvents.get('appinstalled')();
 assert.equal(h.get('#install-button').hidden,true);assert.equal(h.get('#mobile-install-button').hidden,true);
 h.events.get('click')({target:{closest:()=>({dataset:{action:'install'}})}});assert.equal(prompts,1);assert.deepEqual(h.calls,[]);
});
test('an unavailable install prompt reports its outcome without reopening navigation or retrying',async()=>{
 for(const asynchronous of [false,true]){
  const h=harness();await startWorkspace(h);let prompts=0;
  h.windowEvents.get('beforeinstallprompt')({preventDefault(){},prompt(){prompts++;if(asynchronous)return Promise.reject(Error('synthetic prompt failure'));throw Error('synthetic prompt failure');}});
  h.get('#navigation-dialog').showModal();h.events.get('click')({target:{closest:()=>({dataset:{action:'install'}})}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(prompts,1);assert.equal(h.get('#navigation-dialog').open,false);
  assert(h.get('#main').innerHTML.includes('The installation prompt could not open.'));assert(h.get('#main').innerHTML.includes('Verify my face'));
  assert.equal(h.get('#install-button').hidden,true);assert.deepEqual(h.calls,[]);
 }
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
 const h=harness({operator:true}),drafts=new ReviewDrafts();
 await drafts.save({accountId:id(9),recordId:id(1),form:'live-review-form',target:'support',version:'revision:1'},{reason:'Private unsent review'});
 const app=await startWorkspace({...h,drafts});let release,logoutCalls=0;
 h.session.request=()=>new Promise(resolve=>release=resolve);
 h.session.logout=async()=>{logoutCalls++;h.session.credentials=null;h.session.operator=null;};
 const pending=app.refresh();assert(h.get('#main').innerHTML.includes('Loading current records'));
 const pendingAction={path:`/privacy-requests/${id(1)}/approve`,body:{operation_key:id(2)}};h.session.state.pendingAction=pendingAction;
 h.get('#navigation-dialog').showModal();h.events.get('click')({target:{closest:()=>({dataset:{action:'logout'}})}});
 assert.equal(logoutCalls,1);assert.equal(h.session.credentials,null);assert.equal(h.session.operator,null);
 assert.equal(h.get('#navigation-dialog').open,false);assert.equal(h.get('#main').focused,true);
 assert.equal(drafts.entries.size,0);assert.equal(drafts.key,null);assert.equal(h.session.state.pendingAction,pendingAction);
 assert(/data-action="logout"[^>]*\bdisabled\b/.test(h.get('#mobile-navigation').innerHTML));
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
 h.session.request=async path=>path===`/admin/guardian-requests/${row.id}`?{guardian_request:row}:{guardian_requests:[row]};await app.refresh();
 h.events.get('click')({target:{closest:()=>({dataset:{live:'detail',kind:'guardians',id:id(1)}})}});
 await new Promise(resolve=>setImmediate(resolve));const dialog=h.get('#detail-dialog');
 assert.equal(dialog.open,true);assert(dialog.innerHTML.includes('face_authentication'));assert(dialog.innerHTML.includes('live-guardian-form'));
 assert(dialog.innerHTML.includes('<option value="reject">Reject</option>'));assert(!dialog.innerHTML.includes('private-evidence-record'));assert(!dialog.innerHTML.includes('private.example'));
});

test('a known product denial removes guardian records and detail DOM while preserving weak credentials and the exact saved action',async()=>{
 const h=harness({operator:true,hash:'#guardians'}),app=await startWorkspace(h);
 const row={id:id(1),child_account_id:id(2),guardian_account_id:id(3),revision:2,state:'under_review',policy_version:AUDIENCE_POLICY,requested_purposes:['face_authentication']};
 h.session.request=async path=>path===`/admin/guardian-requests/${row.id}`?{guardian_request:row}:{guardian_requests:[row]};await app.refresh();
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

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const click=(h,action,extra={})=>h.events.get('click')({target:{closest:()=>({dataset:{live:action,...extra}})}});
const page=(next=null,total=1,limit=25)=>({limit,sort:'newest',has_more:!!next,next_cursor:next,total});

test('allocated UUIDv8 deletion requests remain reviewable and draftable after restriction recovery',async()=>{
 const h=harness({operator:true,hash:'#privacy'}),app=await startWorkspace(h),request=id(1).replace('-4000-','-8000-');
 h.session.request=async()=>({privacy_requests:[{id:request,request_type:'delete',status:'pending_approval'}]});await app.refresh();
 assert(h.get('#main').innerHTML.includes(request));
 assert.equal(reviewIntent('privacy',{id:request},'reject','Independent review',id(2)).path,'/privacy-requests/'+request+'/reject');
 const drafts=new ReviewDrafts(),scope={accountId:id(9),recordId:request,form:'live-review-form',target:'privacy',version:'current'};
 await drafts.save(scope,{reason:'Current independent notes'});assert.equal((await drafts.restore(scope)).reason,'Current independent notes');
});
test('closing a current record returns keyboard focus to its original review control',async()=>{
 const h=harness({operator:true,hash:'#support'}),app=await startWorkspace(h),row={id:id(1),subject:'Current request',status:'open',revision:1};
 h.session.request=async path=>path.includes('/support-requests/'+id(1))?{support_request:row,history:[],page:page()}:{support_requests:[row]};await app.refresh();
 const target={dataset:{live:'detail',kind:'support',id:id(1)},isConnected:true,focus(){this.focused=true;}};
 h.events.get('click')({target:{closest:()=>target}});await tick();
 assert.equal(h.get('#detail-dialog').open,true);
 click(h,'close-detail');assert.equal(target.focused,true);assert.equal(h.get('#detail-dialog').open,false);
});
test('blocked draft storage does not hide an authorized current queue or claim notes were saved',async()=>{
 const h=harness({operator:true,hash:'#support'}),drafts=new ReviewDrafts({storage:{load(){throw Error('blocked');},current(){throw Error('blocked');}}});
 h.session.request=async()=>({support_requests:[{id:id(1),subject:'Current authorized record',status:'open'}]});
 const app=await startWorkspace({...h,drafts});await app.refresh();
 assert(h.get('#main').innerHTML.includes('Current authorized record'));assert(h.get('#main').innerHTML.includes('Saved notes could not be opened'));
});
test('queue inspection presents only a fresh eligible preview and a delayed reply cannot reopen closed private detail',async()=>{
 for(const late of [false,true]){
  const h=harness({operator:true,hash:'#uploads'}),app=await startWorkspace(h),job='a'.repeat(64),fingerprint='b'.repeat(64);
  const row={id:id(1),title:'Synthetic upload',status:'processing',processing_diagnostics:{attempt_id:id(2),job_id:job,job_state:'failed'}};
  let finish,markup='';const preview={job_id:job,fingerprint,category:'photo',domain_id:id(2),eligible:true,action:'resume_exact_work',queue_state:'failed',domain_status:'queued',attempts:5};
  h.session.request=async path=>path.startsWith('/admin/queue-repairs/')?new Promise(resolve=>finish=resolve):path.startsWith('/admin/uploads/'+id(1)+'?')?{upload:row,attempts:[],page:page()}:{uploads:[row]};
  await app.refresh();click(h,'detail',{kind:'uploads',id:id(1)});await tick();assert.equal(h.get('#detail-dialog').open,true);
  h.get('#detail-dialog').querySelector=selector=>selector==='.live-detail'?{insertAdjacentHTML(_position,text){markup+=text;}}:null;
  click(h,'inspect-queue',{jobId:job});await tick();assert.equal(markup,'');
  if(late){h.document.hidden=true;h.events.get('visibilitychange')();}
  finish({queue_repair:preview});await tick();
  if(late){assert.equal(markup,'');assert.equal(h.get('#detail-dialog').open,false);}
  else{assert(markup.includes('id="live-queue-repair-form"'));assert(markup.includes('Resume original work'));assert(markup.includes('type="checkbox" required'));}
 }
});
test('recovery inbox pages hashed job identities and inspects notification eligibility before showing a form',async()=>{
 const h=harness({operator:true,hash:'#queue-recovery'}),app=await startWorkspace(h),job='a'.repeat(64),other='c'.repeat(64);
 const preview={job_id:job,fingerprint:'b'.repeat(64),category:'notification',domain_id:id(1),eligible:true,action:'resume_exact_work',queue_state:'failed',domain_status:'queued',attempts:5};
 h.session.request=async path=>{
  h.calls.push(path);if(path==='/admin/queue-repairs/'+job)return {queue_repair:preview};
  const later=new URL('https://test.invalid'+path).searchParams.has('cursor');
  return {queue_repairs:[{id:later?other:job,job_id:later?other:job,category:'notification',queue_state:'failed',created_at:1}],page:page(later?null:'next-recovery',2)};
 };
 await app.refresh();assert(h.calls[0].includes('status=attention'));assert(h.get('#main').innerHTML.includes('Notification work'));
 click(h,'detail',{kind:'queue-recovery',id:job});await tick();assert(h.get('#detail-dialog').innerHTML.includes('Resume original work'));
 assert(h.calls.includes('/admin/queue-repairs/'+job));
 const drafts=new ReviewDrafts(),scope={accountId:id(9),recordId:job,form:'live-queue-repair-form',target:job,version:preview.fingerprint};
 await drafts.save(scope,{reason:'Reviewed exact notification recovery'});assert.equal((await drafts.restore(scope)).reason,'Reviewed exact notification recovery');
 click(h,'close-detail');click(h,'next-page');await tick();assert(h.get('#main').innerHTML.includes(other));assert(h.calls.some(path=>path.includes('cursor=next-recovery')));
 assert.equal(queueRepairIntent(preview,'Reviewed exact recovery',id(2)).body.expected_fingerprint,preview.fingerprint);
});

test('registered account filters and search are server-side and no longer discard matching identity rows',async()=>{
 const h=harness({operator:true,hash:'#users?filter=registered&q=Face'}),app=await startWorkspace(h);
 h.session.request=async path=>{h.calls.push(path);return {users:[{id:id(1),name:'Face account',identity_state:'registered_face',status:'active',created_at:0}],page:page()};};
 await app.refresh();const query=new URL('http://local'+h.calls[0]).searchParams;
 assert.equal(query.get('status'),'registered');assert.equal(query.get('q'),'Face');assert.equal(query.has('sort'),false);
 const html=h.get('#main').innerHTML;assert(html.includes('Face account'));assert(html.includes('Registered'));assert(html.includes('live-status-filter'));assert(!html.includes('id="live-sort"'));assert(!html.includes('Search filters this loaded set'));
});
test('queue Next and Previous preserve server filters and do not silently cap access at the first page',async()=>{
 const h=harness({operator:true,hash:'#support?filter=open&q=case'}),app=await startWorkspace(h);
 h.session.request=async path=>{h.calls.push(path);const after=new URL('http://local'+path).searchParams.get('cursor');return {support_requests:[{id:id(after?2:1),subject:after?'Older matching case':'First matching case',status:'open'}],page:page(after?null:'opaque+cursor',101)};};
 await app.refresh();click(h,'next-page');await tick();
 assert(h.get('#main').innerHTML.includes('Older matching case'));assert(h.get('#main').innerHTML.includes('Page 2'));
 let query=new URL('http://local'+h.calls.at(-1)).searchParams;assert.equal(query.get('cursor'),'opaque+cursor');assert.equal(query.get('status'),'open');assert.equal(query.has('sort'),false);assert.equal(query.get('q'),'case');
 click(h,'previous-page');await tick();assert(h.get('#main').innerHTML.includes('First matching case'));assert(h.get('#main').innerHTML.includes('Page 1'));
 query=new URL('http://local'+h.calls.at(-1)).searchParams;assert.equal(query.has('cursor'),false);
});
test('search and status controls retain the other route parameters',async()=>{
 const h=harness({operator:true,hash:'#privacy?filter=failed&q=old'});h.window.setTimeout=callback=>{callback();return 0;};await startWorkspace(h);
 h.get('#search').listeners.get('input')({target:{value:'new query'}});
 assert.equal(h.window.location.hash,'privacy?q=new+query&filter=failed');
 h.events.get('change')({target:{id:'live-status-filter',value:'processing'}});
 assert.equal(h.window.location.hash,'privacy?q=old&filter=processing');
});
test('guardian queue preserves the server-defined priority and oldest-work ordering',async()=>{
 const h=harness({operator:true,hash:'#guardians'}),app=await startWorkspace(h);
 h.session.request=async path=>{h.calls.push(path);return {guardian_requests:[],page:page()};};await app.refresh();
 const query=new URL('http://local'+h.calls[0]).searchParams;assert.equal(query.get('status'),'all');assert.equal(query.has('sort'),false);
});
test('skip to content focuses the landmark without changing the current queue or fetching another route',async()=>{
 const h=harness({operator:true,hash:'#support?filter=attention'});await startWorkspace(h);let prevented=false;
 h.events.get('click')({preventDefault(){prevented=true;},target:{closest:()=>({matches:selector=>selector==='a.skip-link'})}});
 assert(prevented);assert(h.get('#main').focused);assert.equal(h.window.location.hash,'#support?filter=attention');assert.deepEqual(h.calls,[]);
});
test('matching proposals page within the selected server collection and preserve its filter',async()=>{
 const h=harness({operator:true,hash:'#match-reports?collection=matches&filter=needs_review'}),app=await startWorkspace(h);
 h.session.request=async path=>{h.calls.push(path);const query=new URL('http://local'+path).searchParams;return {matches:[{id:id(query.has('cursor')?3:2),state:'needs_review'}],page:page(query.has('cursor')?null:'match-cursor',26)};};
 await app.refresh();click(h,'next-page');await tick();
 const query=new URL('http://local'+h.calls.at(-1)).searchParams;assert.equal(query.get('collection'),'matches');assert.equal(query.get('cursor'),'match-cursor');assert.equal(query.get('status'),'needs_review');
 assert(h.get('#main').innerHTML.includes(id(3)));assert(!h.get('#main').innerHTML.includes(id(2)));assert(h.get('#main').innerHTML.includes('Page 2'));
});
test('account history and session continuation use the exact account and original page limits',async()=>{
 const h=harness({operator:true,hash:'#users'}),app=await startWorkspace(h),section={outerHTML:''};
 h.get('#detail-dialog').querySelector=selector=>selector==='#account-section-sessions'?section:null;
 h.session.request=async path=>{h.calls.push(path);if(path.includes('/sessions?'))return {items:[{id:id(7),status:'active',created_at:1}],page:page(null,51,50)};if(path==='/admin/users/'+id(1))return {user:{id:id(1),name:'Account'},audience:unknownAudience(id(1)),sessions:[{id:id(6),status:'active',created_at:0}],cases:{},history:[],pages:{sessions:page('session-cursor',51,50)}};return {users:[{id:id(1),name:'Account'}],page:page()};};
 await app.refresh();click(h,'detail',{kind:'users',id:id(1)});await tick();
 assert(h.get('#detail-dialog').innerHTML.includes('data-section="sessions"'));
 click(h,'detail-page',{section:'sessions',direction:'next'});await tick();
 const url=new URL('http://local'+h.calls.at(-1));assert.equal(url.pathname,`/admin/users/${id(1)}/sessions`);assert.equal(url.searchParams.get('limit'),'50');assert.equal(url.searchParams.get('cursor'),'session-cursor');
 assert(section.outerHTML.includes(id(7)));assert(section.outerHTML.includes('data-session="'+id(7)+'"'));
});
test('a late account-section reply cannot republish after navigation',async()=>{
 const h=harness({operator:true,hash:'#users'}),app=await startWorkspace(h),section={outerHTML:'original'};let release;
 h.get('#detail-dialog').querySelector=selector=>selector==='#account-section-history'?section:null;
 h.session.request=async path=>path.includes('/history?')?new Promise(resolve=>release=resolve):path==='/admin/users/'+id(1)?{user:{id:id(1)},audience:unknownAudience(id(1)),sessions:[],cases:{},history:[],pages:{history:page('history-cursor',31,30)}}:path==='/admin/metrics'?{accounts:1}:{users:[{id:id(1)}],page:page()};
 await app.refresh();click(h,'detail',{kind:'users',id:id(1)});await tick();click(h,'detail-page',{section:'history',direction:'next'});
 h.window.location.hash='#overview';h.windowEvents.get('hashchange')();release({items:[{id:id(8),action:'private.older.event',created_at:0}],page:page()});await tick();
 assert.equal(section.outerHTML,'original');assert.equal(h.get('#detail-dialog').innerHTML,'');
});
test('privacy detail loads current diagnostics and its bounded history from the authorized detail route',async()=>{
 const h=harness({operator:true,hash:'#privacy'}),app=await startWorkspace(h);
 h.session.request=async path=>{h.calls.push(path);return path===`/privacy-requests/${id(1)}`?{privacy_request:{id:id(1),status:'processing',request_type:'delete',review_reason:'Independent reviewer confirmed',legal_hold:true,cleanup:{total:3,pending:2,verified:1},holds:{global_retention:0,moderation:1,assets:1,requests:0},history:[{id:id(7),action:'privacy.approved',created_at:0}],history_page:page('privacy-history',21,20),private_url:'https://private.example'}}:{privacy_requests:[{id:id(1),status:'queued',request_type:'delete'}],page:page()};};
 await app.refresh();click(h,'detail',{kind:'privacy',id:id(1)});await tick();const html=h.get('#detail-dialog').innerHTML;
 assert.equal(h.calls.at(-1),`/privacy-requests/${id(1)}`);assert(html.includes('Independent reviewer confirmed'));assert(html.includes('Legal hold'));assert(html.includes('Privacy.approved'));assert(html.includes('data-section="history"'));assert(!html.includes('private.example'));
});
test('unsent notes survive hiding as sealed drafts and restore only after a fresh record read and explicit action',async()=>{
 const h=harness({operator:true,hash:'#support'}),drafts=new ReviewDrafts();let saving,restoring,submitted=0,form;
 const save=drafts.save.bind(drafts),restore=drafts.restore.bind(drafts);drafts.save=(...args)=>(saving=save(...args));drafts.restore=(...args)=>(restoring=restore(...args));
 const makeForm=()=>{const controls={reason:{type:'textarea',value:'',focus(){}},decision:{type:'select-one',tagName:'SELECT',value:'reject',options:[{value:'reject'},{value:'approve'}]}};const checkbox={checked:true};return {id:'live-review-form',dataset:{kind:'support',id:id(1)},innerHTML:'',controls,checkbox,elements:{namedItem:name=>controls[name]},insertAdjacentHTML(_where,html){this.innerHTML+=html;},querySelector:selector=>selector==='[data-draft-notice]'?{remove(){}}:controls.reason,querySelectorAll:()=>[checkbox]};};
 form=makeForm();const dialog=h.get('#detail-dialog');dialog.querySelectorAll=()=>[form];dialog.querySelector=selector=>selector==='#live-review-form'?form:null;
 const app=await startWorkspace({...h,drafts}),row={id:id(1),subject:'Current request',revision:3,status:'under_review'};h.session.request=async path=>path.startsWith(`/admin/support-requests/${id(1)}?`)?{support_request:row,history:[],page:page()}:{support_requests:[row],page:page()};h.session.action=async()=>{submitted++;};
 await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await tick();form.controls.reason.value='Notes before switching tabs';form.controls.decision.value='approve';
 h.events.get('input')({target:{closest:()=>form}});await saving;
 h.document.hidden=true;h.events.get('visibilitychange')();assert.equal(dialog.innerHTML,'');assert.equal(dialog.open,false);
 form=makeForm();h.document.hidden=false;h.events.get('visibilitychange')();await tick();click(h,'detail',{kind:'support',id:id(1)});await tick();
 assert(form.innerHTML.includes('Restore unsent notes'));assert.equal(form.controls.reason.value,'');
 click(h,'restore-draft',{form:'live-review-form'});await restoring;await tick();
 assert.equal(form.controls.reason.value,'Notes before switching tabs');assert.equal(form.controls.decision.value,'approve');assert.equal(form.checkbox.checked,false);assert.equal(submitted,0);
 h.session.logout=async()=>{h.session.operator=null;h.session.credentials=null;};click(h,'logout');assert.equal(drafts.entries.size,0);assert.equal(drafts.key,null);
});

test('reviewing a cached queue row fetches its current detail and submits that fresh revision',async()=>{
 const h=harness({operator:true,hash:'#support'}),app=await startWorkspace(h);let submitted;
 h.session.request=async path=>{h.calls.push(path);return path.startsWith(`/admin/support-requests/${id(1)}?`)?{support_request:{id:id(1),subject:'Current reviewed case',revision:4,status:'under_review'},history:[],page:page()}:{support_requests:[{id:id(1),subject:'Old queue title',revision:1,status:'open'}],page:page()};};
 h.session.action=async(path,body)=>{submitted={path,body};};
 h.window.FormData=class {get(name){return {decision:'approve',reason:'Current revision reviewed'}[name];}};
 await app.refresh();click(h,'detail',{kind:'support',id:id(1)});await tick();
 assert.equal(h.calls.at(-1),`/admin/support-requests/${id(1)}?limit=25`);assert(h.get('#detail-dialog').innerHTML.includes('Current reviewed case'));assert(!h.get('#detail-dialog').innerHTML.includes('Old queue title'));
 h.events.get('submit')({preventDefault(){},target:{id:'live-review-form',dataset:{kind:'support',id:id(1)},reportValidity:()=>true}});await tick();
 assert.equal(submitted.body.expected_revision,4);assert.equal(submitted.path,`/admin/support-requests/${id(1)}/approve`);
});

test('new operator setup presents a neutral transient range and unchecked independent choices',async()=>{
 const h=harness();h.session.state.reference=null;h.session.restore=async()=>({registered:false,pending:false});const sent=[];
 h.session.startEnrollment=async(...args)=>{sent.push(args);};await startWorkspace(h);
 const html=h.get('#main').innerHTML;
 for(const range of ['under13','13_17','18_plus'])assert(html.includes('value="'+range+'"'));
 assert(html.includes('<option value="">Choose an age range</option>'));assert(!html.includes('selected'));assert(!/type="checkbox"[^>]*\bchecked\b/.test(html));
 assert(html.includes('id="operator-audience-confirm"'));assert(html.includes('id="operator-consent"'));
 click(h,'enroll');await tick();assert.equal(sent.length,0);
 h.get('#operator-consent').checked=true;h.get('#operator-audience-confirm').checked=true;h.get('#operator-age').value='13_17';
 click(h,'enroll');await tick();assert.deepEqual(sent,[[true,'13_17',true]]);assert(!Object.hasOwn(h.session.state,'age_band'));
});
test('an annual status shows explicit new choices before camera and renewal does not authenticate the operator',async()=>{
 const h=harness();let cameras=0,renewals=0;h.window.navigator.mediaDevices={getUserMedia(){cameras++;throw Error('camera_must_stay_closed');}};
 const review={kind:'device',epoch:1,current:{accountId:id(9),reviewRequired:true},renewalAvailable:true};
 h.session.startLogin=async()=>{h.session.audienceReview=review;};
 h.session.renewOperatorAudience=async(...args)=>{assert.deepEqual(args,['18_plus',true,true]);renewals++;h.session.audienceReview=null;return {reviewRequired:false};};
 await startWorkspace(h);click(h,'login');await tick();let html=h.get('#main').innerHTML;
 assert(html.includes('Annual eligibility review'));assert(!/type="checkbox"[^>]*\bchecked\b/.test(html));assert.equal(cameras,0);
 h.get('#operator-age').value='18_plus';h.get('#operator-audience-confirm').checked=true;h.get('#operator-consent').checked=false;
 click(h,'renew-audience');await tick();assert.equal(renewals,0);assert.equal(h.session.audienceReview,review);
 h.get('#operator-consent').checked=true;click(h,'renew-audience');await tick();
 assert.equal(renewals,1);assert.equal(cameras,0);assert.equal(h.session.operator,null);assert.equal(h.session.credentials,null);
 html=h.get('#main').innerHTML;assert(html.includes('Verify my face'));assert(!html.includes('Annual eligibility review'));
});
test('a saved eligibility operation has an explicit original-operation recovery control and no new declaration form',async()=>{
 const h=harness();let retries=0;h.session.state.pendingAudience={accountId:id(9),body:{operation_key:id(3)}};
 h.session.recoverOperatorAudience=async()=>{retries++;throw Object.assign(Error('audience_upgrade_required'),{code:'audience_upgrade_required',status:409});};
 await startWorkspace(h);let html=h.get('#main').innerHTML;
 assert.equal(retries,0);assert(html.includes('Retry original eligibility operation'));assert(!html.includes('id="operator-age"'));assert(!html.includes('data-live="enroll"'));
 click(h,'recover-audience');await tick();html=h.get('#main').innerHTML;
 assert.equal(retries,1);assert.equal(h.session.state.pendingAudience.body.operation_key,id(3));assert(html.includes('saved key and decision are preserved'));
});
test('profile recovery preserves the existing browser identity and cannot open a camera or create a replacement account',async()=>{
 const h=harness(),reference=h.session.state.reference;let cameras=0,checks=0;
 h.window.navigator.mediaDevices={getUserMedia(){cameras++;throw Error('blocked');}};
 h.session.startLogin=async()=>{checks++;h.session.audienceReview={kind:'profile-recovery'};};
 await startWorkspace(h);click(h,'login');await tick();const html=h.get('#main').innerHTML;
 assert(html.includes('Original profile needs recovery'));assert(html.includes('operator browser recovery procedure'));assert(!html.includes('data-live="enroll"'));
 assert.equal(checks,1);assert.equal(cameras,0);assert.equal(h.session.state.reference,reference);
});
test('a held annual reply cannot restart UI authentication after immediate sign-out',async()=>{
 const h=harness();let release,entered,cameras=0;const ready=new Promise(resolve=>entered=resolve);
 h.session.audienceReview={kind:'device',renewalAvailable:true,current:{reviewRequired:true}};
 h.session.renewOperatorAudience=async()=>{entered();await new Promise(resolve=>release=resolve);};
 h.session.logout=async()=>{h.session.operator=null;h.session.credentials=null;};
 h.window.navigator.mediaDevices={getUserMedia(){cameras++;throw Error('blocked');}};
 await startWorkspace(h);h.get('#operator-age').value='18_plus';h.get('#operator-audience-confirm').checked=true;h.get('#operator-consent').checked=true;
 click(h,'renew-audience');await ready;click(h,'logout');release();await tick();
 assert.equal(h.session.operator,null);assert.equal(h.session.credentials,null);assert.equal(cameras,0);assert(h.get('#main').innerHTML.includes('Verify my face'));
});
test('a pending enrollment audience denial reads current review without replacing the enrollment or resume intent',async()=>{
 const h=harness();let reads=0,cameras=0;
 const enrollment={account_id:id(9),enrollment_key:id(11),resume:{resume_key:id(12),expected_generation:1,expected_challenge_id:id(13)}};
 h.session.state={reference:null,enrollment,anonymous:{account_id:id(9)},pendingAudience:null};
 h.session.restore=async()=>({registered:false,pending:true});
 h.session.recoverEnrollment=async()=>{throw Object.assign(new Error('audience_restricted'),{code:'audience_restricted',status:403});};
 h.session.declareOperatorAudience=async(...args)=>{assert.deepEqual(args,[]);reads++;h.session.audienceReview={kind:'anonymous',renewalAvailable:true,current:{reviewRequired:true}};};
 h.window.navigator.mediaDevices={getUserMedia(){cameras++;throw Error('camera_must_stay_closed');}};
 await startWorkspace(h);click(h,'recover-enrollment');await tick();
 assert.equal(reads,1);assert.equal(cameras,0);assert.equal(h.session.state.enrollment,enrollment);
 assert.deepEqual(enrollment.resume,{resume_key:id(12),expected_generation:1,expected_challenge_id:id(13)});
 assert.equal(h.session.state.pendingAudience,null);assert(h.get('#main').innerHTML.includes('Annual eligibility review'));
 assert.equal(h.session.operator,null);assert.equal(h.session.credentials,null);
});
