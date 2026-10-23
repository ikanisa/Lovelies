import assert from 'node:assert/strict';
import test from 'node:test';
import {previewAllowed} from './entry.mjs';
import {parseRoute,reviewIntent,recordTable,startWorkspace} from './live-app.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
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

function harness({hash='#overview',operator=false}={}) {
  class Element {
    constructor(){this.innerHTML='';this.textContent='';this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.open=false;this.firstElementChild={textContent:''};this.listeners=new Map();this.classList={add(){}};}
    setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}replaceChildren(){}focus(){this.focused=true;}close(){this.open=false;}showModal(){this.open=true;}prepend(){}insertAdjacentHTML(_where,html){this.innerHTML+=html;}addEventListener(k,v){this.listeners.set(k,v);}querySelector(){return null;}
  }
  const elements=new Map(),events=new Map(),windowEvents=new Map(),calls=[];
  const get=s=>{if(!elements.has(s))elements.set(s,new Element());return elements.get(s);};
  const document={hidden:false,body:{classList:{add(){}}},querySelector:get,createElement:()=>new Element(),addEventListener:(type,callback)=>events.set(type,callback)};
  const window={navigator:{onLine:true},location:{hash},requestAnimationFrame:fn=>fn(),setTimeout,FormData:class{},addEventListener:(type,callback)=>windowEvents.set(type,callback),URL:{revokeObjectURL(){}}};
  const session={operator:operator?{user_id:id(9),roles:['admin']}:null,credentials:operator?{}:null,challenge:null,captures:[],state:{reference:{},pendingAction:null},cancelled:0,
    async restore(){return {registered:true,pending:false};},cancelCapture(){this.challenge=null;this.captures=[];this.cancelled++;},async request(path){calls.push(path);return {accounts:4,uploads:8,active_grants:3,open_support:2,open_reports:1};}};
  return {document,window,session,events,windowEvents,calls,get};
}
test('initial protected shell reads private device state without calling an API or displaying sample rows',async()=>{
  const h=harness();await startWorkspace(h);const html=h.get('#main').innerHTML;
  assert(html.includes('Verify my face'));assert(!html.includes('Alex Morgan'));assert(!html.includes('Sample operator'));assert.deepEqual(h.calls,[]);
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
 release({user:{id:id(1),name:'Protected account'},sessions:[],cases:{},history:[]});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.get('#detail-dialog').open,false);assert(!h.get('#detail-dialog').innerHTML.includes('Protected account'));
});
