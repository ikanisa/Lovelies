import {guardianReviewIntent,adultReviewIntent,audienceProjection,audienceChallenge} from './audience.mjs';
import {OperatorSession} from './operator-session.mjs';
import {runtimeConfig} from './runtime-config.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requireId=value=>{if(typeof value!=='string'||!UUID.test(value))throw new Error('invalid_record');return value;};
export const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={overview:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',users:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',safety:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM12 8v5m0 3h.01"/>',privacy:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',support:'<path d="M4 13v-2a8 8 0 0 1 16 0v2m-1 5c0 3-3 3-5 3"/><rect x="2" y="11" width="4" height="7" rx="2"/><rect x="18" y="11" width="4" height="7" rx="2"/>',uploads:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 17 5-5 4 4 3-3 6 5"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 1 1 4 3v3m-1 3h.01"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]??paths.overview}</svg>`;
export const routes=Object.freeze({overview:{label:'Overview',icon:'overview',path:'/admin/metrics'},users:{label:'Users',icon:'users',path:'/admin/users',key:'users'},'match-reports':{label:'Match reports',icon:'safety',path:'/admin/safety/reports',key:'reports'},guardians:{label:'Guardian consent',icon:'privacy',path:'/admin/guardian-requests',key:'guardian_requests'},privacy:{label:'Privacy',icon:'privacy',path:'/admin/privacy-requests',key:'privacy_requests'},support:{label:'Support',icon:'support',path:'/admin/support-requests',key:'support_requests'},uploads:{label:'Uploads',icon:'uploads',path:'/admin/uploads',key:'uploads'}});

export function parseRoute(hash='') {
  const [name,query='']=hash.replace(/^#/,'').split('?');const params=new URLSearchParams(query);
  return {route:Object.hasOwn(routes,name)?name:'overview',q:(params.get('q')??'').slice(0,100),filter:(params.get('filter')??'all').slice(0,30)};
}

export function reviewIntent(kind,row,action,reason,key) {
  const id=requireId(row.id);requireId(key);
  if(typeof reason!=='string'||reason.trim().length<3||reason.trim().length>1000||/[\x00-\x1f\x7f]/.test(reason))throw new Error('review_reason_required');
  const rationale=reason.trim();
  if(kind==='session')return {path:`/admin/users/${id}/sessions/revoke`,body:{session_id:requireId(action),reason:rationale,operation_key:key}};
  if(kind==='privacy') {
    if(!['approve','reject','process'].includes(action))throw new Error('invalid_review');
    return {path:`/privacy-requests/${id}/${action}`,body:action==='process'?{}:{reason:rationale,operation_key:key}};
  }
  const revision=kind==='match'?requireId(row.version):row.revision;
  if(kind!=='match'&&(!Number.isSafeInteger(revision)||revision<1))throw new Error('invalid_revision');
  if(kind==='support'&&['start','approve','reject','close'].includes(action))return {path:`/admin/support-requests/${id}/${action}`,body:{review_notes:rationale,expected_revision:revision,operation_key:key}};
  if(kind==='safety'&&['hold','release','resolve','reject'].includes(action))return {path:`/admin/safety/reports/${id}/resolve`,body:{action,reason:rationale,expected_revision:revision,operation_key:key}};
  if(kind==='match'&&['approve','reject','escalate','delete','audit'].includes(action))return {path:`/admin/matches/${id}/resolve`,body:{action,reason:rationale,expected_revision:revision,operation_key:key}};
  throw new Error('invalid_review');
}

const label=value=>String(value??'Unavailable').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
const date=value=>{const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(n):'Unavailable';};
const short=value=>typeof value==='string'?`${value.slice(0,8)}…`:'Unavailable';
function rows(value) {if(!Array.isArray(value)||value.length>100||value.some(row=>!row||!UUID.test(row.id)))throw new Error('invalid_response');return value;}
const button=(action,text,extra='',primary=false)=>`<button type="button" data-live="${escape(action)}" ${extra} class="${primary?'primary':''}">${escape(text)}</button>`;

export function recordTable(kind,records,{disabled=false}={}) {
  if(!records.length)return '<p class="live-empty">No current records were returned.</p>';
  return `<div class="live-table-wrap"><table class="live-table"><thead><tr><th scope="col">${kind==='users'?'Account':kind==='uploads'?'Photo':'Request'}</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${records.map(row=>{
    const title=kind==='users'?(row.name||'Unnamed account'):kind==='support'?row.subject:kind==='uploads'?(row.title||'Photo'):kind==='guardians'?'Guardian consent':kind==='privacy'?label(row.request_type):kind==='match'?'Matching proposal':(row.reason||'Photo report');
    return `<tr><td>${escape(title)}<small>${escape(row.id)}</small></td><td>${escape(label(kind==='users'?row.identity_state:(row.status??row.state)))}</td><td>${escape(date(row.created_at))}</td><td>${button('detail','Review',`data-kind="${escape(kind)}" data-id="${escape(row.id)}" ${disabled?'disabled':''}`)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function message(problem) {
  const code=problem?.code??problem?.message;
  if(code==='private_state_changed')return 'Another tab changed the protected device state. Close other Lovelies tabs and refresh before retrying the original saved operation.';
  if(code==='operator_adult_declaration_required'||code==='operator_adult_required')return 'This operator workspace requires an adult account. Confirm your own age before starting setup; no age or administrator authority is inferred from a face match.';
  if(code==='guardian_evidence_required')return 'Record the independent review method and its minimized reference. Approval requires both adulthood and parental-responsibility checks.';
  if(code==='guardian_record_changed')return 'The guardian request changed or is not ready for independent review. Refresh the queue.';
  if(code==='audience_record_changed')return 'The audience record changed. Reopen the account before reviewing adulthood.';
  if(code==='adult_evidence_required')return 'An adulthood transition needs an independent review method, minimized reference and affirmative verification.';
  if(code==='audience_response_invalid'||code==='audience_challenge_invalid')return 'The service did not confirm current audience authority. No camera or private operation has been authorized.';
  if(code==='authentication_consent_required')return 'Read the face authentication consent and select its checkbox before setting up your profile.';
  const copy={operator_provisioning_required:'Your face was verified, but this account has no operator authority. An existing authorized administrator must provision your role independently.',fresh_face_authentication_required:'This action requires a fresh face sign-in. Sign out, verify your face again, then retry the original saved action.',independent_review_required:'Another authorized operator must review this request.',self_management_forbidden:'You cannot revoke your own account through this operator action.',last_admin_protected:'The last administrator is protected. Another qualified administrator must remain available.',private_storage_unavailable:'Private browser storage is unavailable. Enable IndexedDB in this browser and retry.',private_state_unavailable:'This browser could not read its protected device state. Keep this browser profile and request operator recovery support.',private_write_failed:'The browser could not save the protected operation. Free storage and retry; no replacement identity has been created.',capture_expired:'This capture request expired. Verify its status or start a fresh sign-in.',reconcile_previous_action:'An earlier action has an unknown result. Retry that original action before starting another.',enrollment_recovery_unavailable:'The original enrollment must be recovered. Keep this browser profile and check its status.',camera_unavailable:'The camera is unavailable. Allow camera access for this site and retry.',invalid_response:'The server returned an unexpected response. Refresh the current view.',review_reason_required:'Enter a review note of 3–1,000 characters.'};
  if(copy[code])return copy[code];
  if(problem?.status===401)return 'Your authorization expired or was revoked. Verify your face again to continue.';
  if(problem?.status===403)return 'Your current account is not authorized for this action. Refresh authorization before retrying.';
  if(problem?.status===409)return 'This record changed or is no longer eligible. Refresh it and review its current state before deciding.';
  return 'The request could not finish. Check the connection and retry. An uncertain action keeps its original saved operation.';
}

export async function startWorkspace({document=globalThis.document,window=globalThis.window,session=new OperatorSession({baseUrl:runtimeConfig.apiBaseUrl,policyVersion:runtimeConfig.facePolicyVersion})}={}) {
  const $=selector=>document.querySelector(selector),main=$('#main'),detail=$('#detail-dialog');
  let state=parseRoute(window.location.hash),data=null,busy=false,error='',notice='',restored=null,generation=0,taskGeneration=0,stream=null,review=null,reviewURL=null,cameraGeneration=0,searchTimer,installPrompt,waitingWorker,detailAudience=null;
  const navigator=window.navigator;
  document.body.classList.add('live-app');
  function stopCamera() {cameraGeneration++;stream?.getTracks().forEach(track=>track.stop());stream=null;if(review)review.fill(0);review=null;if(reviewURL)window.URL.revokeObjectURL(reviewURL);reviewURL=null;}
  function clearPrivate() {data=null;detailAudience=null;detail.close();detail.innerHTML='';stopCamera();session.cancelCapture();generation++;}
  function online() {return navigator.onLine!==false;}
  function shell() {
    document.title=`${routes[state.route].label} · Lovelies Admin`;
    $('#breadcrumb').textContent=routes[state.route].label;
    const links=Object.entries(routes).map(([id,item])=>`<a class="nav-link ${id===state.route?'active':''}" href="#${id}" ${id===state.route?'aria-current="page"':''}>${icon(item.icon)}<span>${item.label}</span></a>`).join('');
    $('#navigation').innerHTML=links;$('#mobile-navigation').innerHTML=links;
    $('#search').value=state.q;$('#search').placeholder=state.route==='users'?'Find an account…':'Filter loaded records…';$('#search').setAttribute('aria-label',state.route==='users'?'Search accounts on the server':'Filter current loaded records');$('#search').disabled=!session.operator;
    $('.preview-pill').textContent=session.operator?'Protected workspace':'Face sign-in';
    const operator=$('.operator-identity');operator.removeAttribute('data-user');operator.setAttribute('aria-label',session.operator?'Current authorized operator':'Operator not signed in');
    operator.innerHTML=`<span class="operator-avatar" aria-hidden="true">${session.operator?'✓':'•'}</span><span>${escape(session.operator?.name||'Operator')}<small>${session.operator?'Current registered-face authority':'Sign-in required'}</small></span>`;
    const utility=$('.operator .icon-button');utility.dataset.action='logout';utility.setAttribute('aria-label','Sign out and clear private workspace');utility.innerHTML=icon('close');utility.disabled=!session.credentials;
    $('[data-action="about"]').innerHTML=icon('help')+'<span>Workspace help</span>';
    $('[data-icon="menu"]')?.replaceChildren();$('.mobile-menu').innerHTML=icon('menu');$('.global-search [data-icon="search"]').innerHTML=icon('search');
    $('.workspace-footer').firstElementChild.textContent='Supabase · Current server authority';$('#storage-note').textContent='Private records stay in memory; device operations are encrypted in this browser';
    const banner=$('#connection-banner');banner.hidden=online();banner.textContent='Offline. Private records are not refreshed. Connect before performing an action.';
  }
  function errorHTML(){return error?`<div class="live-error" tabindex="-1" role="alert">${escape(error)}</div>`:'';}
  function pendingHTML(){const p=session.state?.pendingAction;return p?`<aside class="live-notice"><strong>Previous action needs reconciliation</strong><p>Its original operation is saved in this browser. A retry uses that exact request.</p><div class="live-actions">${button('retry-action','Retry original action',busy||!online()?'disabled':'')}</div></aside>`:'';}
  function auth() {
    const challenge=session.challenge,required=challenge?.required_captures??0,count=session.captures.length;
    const pose=challenge?.poses?.[count];
    const hint=pose==='left'?'Turn slightly to your left.':pose==='right'?'Turn slightly to your right.':'Look straight at the camera.';
    return `<section class="live-auth"><h1>${challenge?'Verify your face':'Your protected workspace'}</h1><p>${challenge?`Capture ${count+1} of ${required}. ${escape(hint)} Each photo is compared by the backend before authorization.`:'Use the registered face and private device key for an independently authorized operator account.'}</p>${errorHTML()}
      ${challenge?`<div class="live-camera"><video id="operator-camera" autoplay muted playsinline aria-label="Front-camera preview"></video><img id="operator-review" hidden alt="Unsent selfie for review"></div><div class="live-actions">${button('resume-camera','Open camera',busy?'disabled':'',true)}${button('shutter','Take photo',busy||!stream?'disabled':'',true)}${button('use-photo','Use photo','hidden',true)}${button('retake','Retake','hidden')}${button('cancel-camera','Cancel')}</div><p id="camera-status" role="status" aria-live="polite">Open the camera to continue.</p>`:`
        ${!restored?.registered&&!restored?.pending?'<label class="live-consent"><input id="operator-adult" type="checkbox"><span>I am 18 or older. This adult-only workspace requires independently provisioned operator authority.</span></label><label class="live-consent"><input id="operator-consent" type="checkbox"><span>I consent to use my three profile selfies to register face authentication for this account. Photo matching and processing permissions remain separate.</span></label>':''}
        <div class="live-actions">${restored?.pending?button('recover-enrollment','Check saved setup',busy?'disabled':'',true)+button('restart-enrollment','Renew original setup',busy?'disabled':''):restored?.registered?button('login','Verify my face',busy?'disabled':'',true):button('enroll','Set up my face',busy?'disabled':'',true)}</div>
        <p>New registration does not grant an administrator role. Keep this browser profile to retain its private device key and original recovery state.</p>`}${waitingWorker?button('activate-update','Apply workspace update',busy?'disabled':''):''}</section>`;
  }
  function filtered(records) {const q=state.q.toLocaleLowerCase();return records.filter(row=>(state.filter==='all'||row.status===state.filter||row.state===state.filter||row.identity_state===state.filter)&&(!q||[row.id,row.name,row.subject,row.title,row.reason,row.status,row.state].filter(v=>typeof v==='string').some(v=>v.toLocaleLowerCase().includes(q))));}
  function render() {
    shell();
    if(document.hidden){main.innerHTML='<p class="live-status">Private workspace paused.</p>';return;}
    if(!session.operator){main.innerHTML=auth();return;}
    const pending=!!session.state?.pendingAction;
    let body='';
    if(data&&state.route==='overview')body=`<div class="live-grid">${[['accounts','Active accounts'],['uploads','Current uploads'],['active_grants','Active photo grants'],['open_support','Open support'],['open_reports','Open reports']].map(([key,title])=>`<div class="live-metric"><strong>${Number.isSafeInteger(data[key])?escape(data[key]):'Unavailable'}</strong><span>${escape(title)}</span></div>`).join('')}</div><div class="live-actions"><a class="button" href="#support">Support queue</a><a class="button" href="#match-reports">Match reports</a><a class="button" href="#privacy">Privacy queue</a></div>`;
    else if(data) {
      const records=filtered(rows(data[routes[state.route].key]));
      body=recordTable(state.route==='match-reports'?'safety':state.route,records,{disabled:busy||!online()||pending});
      if(state.route==='match-reports'&&data.matches?.length)body+=`<h2 class="section-title">Flagged matching proposals</h2>${recordTable('match',filtered(rows(data.matches)),{disabled:busy||!online()||pending})}`;
      body+=`<p class="live-status">${state.route==='users'?'Search and pagination use the current server account list.':'This view returns at most 100 current records. Search filters this loaded set.'}</p>`;
      if(state.route==='users'&&data.page?.next_cursor)body+=`<div class="live-actions">${button('more-users','Load next accounts',busy?'disabled':'')}</div>`;
    } else body=`<p class="live-status" role="status">${busy?'Loading current records…':'Refresh to load current records.'}</p>`;
    main.innerHTML=`<header class="live-header"><h1>${routes[state.route].label}</h1><div class="live-actions">${button('refresh','Refresh',busy||!online()?'disabled':'')}${waitingWorker?button('activate-update','Apply workspace update',busy||pending?'disabled':''):''}</div></header>${errorHTML()}${notice?`<p class="live-notice" role="status">${escape(notice)}</p>`:''}${pendingHTML()}${body}`;
  }
  async function task(action,{rerender=true}={}) {
    if(busy)return;const own=++taskGeneration;busy=true;error='';if(rerender)render();
    try {await action();}
    catch(problem){if(own!==taskGeneration)return;error=message(problem);if(!session.operator){clearPrivate();restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};}}
    finally {if(own===taskGeneration){busy=false;if(rerender)render();if(error&&detail.open){detail.querySelector('.live-error')?.remove();detail.querySelector('.live-detail')?.insertAdjacentHTML('afterbegin',errorHTML());}if(error)window.requestAnimationFrame(()=>(detail.open?detail.querySelector('.live-error'):$('.live-error'))?.focus());}}
  }
  async function load({cursor}={}) {
    const own=++generation,account=session.operator?.user_id;if(!account||document.hidden)return;
    const route=state.route,q=state.q;
    if(!cursor)data=null;error='';busy=true;render();
    try {
      const params=route==='users'?new URLSearchParams({limit:'25',q,status:['registered','anonymous','deleted'].includes(state.filter)?state.filter:'all',...(cursor?{cursor}:{})}):null;
      const value=await session.request(routes[route].path+(params?'?'+params:''));
      if(own!==generation||account!==session.operator?.user_id)return;
      if(route!=='overview')rows(value[routes[route].key]);
      data=value;
    }catch(problem){if(own===generation){error=message(problem);if(!session.operator){clearPrivate();restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};busy=false;render();}}}
    finally{if(own===generation){busy=false;render();}}
  }
  async function camera() {
    stopCamera();render();if(document.hidden)return;const own=cameraGeneration,challenge=session.challenge,epoch=session.epoch;
    const current=()=>own===cameraGeneration&&!document.hidden&&epoch===session.epoch&&challenge===session.challenge;
    audienceChallenge(challenge,session.now());
    if(!navigator.mediaDevices?.getUserMedia)throw Object.assign(new Error('camera_unavailable'),{code:'camera_unavailable'});
    const media=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:1280},height:{ideal:1280}}});
    if(!current()){media.getTracks().forEach(track=>track.stop());return;}
    try{audienceChallenge(challenge,session.now());}catch(problem){media.getTracks().forEach(track=>track.stop());throw problem;}
    stream=media;const video=$('#operator-camera');if(!video){stopCamera();return;}video.srcObject=media;await video.play();
    if(!current()){if(stream===media)stopCamera();else media.getTracks().forEach(track=>track.stop());return;}
    try{audienceChallenge(challenge,session.now());}catch(problem){stopCamera();throw problem;}
    $('#camera-status').textContent='Review each photo before sending it.';$('[data-live="shutter"]').disabled=false;$('[data-live="resume-camera"]').hidden=true;
  }
  async function shutter() {
    const own=cameraGeneration,challenge=session.challenge,epoch=session.epoch;
    const current=()=>own===cameraGeneration&&!document.hidden&&epoch===session.epoch&&challenge===session.challenge;
    audienceChallenge(challenge,session.now());
    const video=$('#operator-camera');if(!stream||!video?.videoWidth)throw Object.assign(new Error('camera_unavailable'),{code:'camera_unavailable'});
    const canvas=document.createElement('canvas'),scale=Math.min(1,1280/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.92));canvas.width=1;canvas.height=1;if(!blob)throw new Error('invalid_capture');
    if(!current()){if(own===cameraGeneration)stopCamera();return;}
    try{audienceChallenge(challenge,session.now());}catch(problem){stopCamera();throw problem;}
    const bytes=new Uint8Array(await blob.arrayBuffer());if(!current()){bytes.fill(0);if(own===cameraGeneration)stopCamera();return;}
    try{audienceChallenge(challenge,session.now());}catch(problem){bytes.fill(0);stopCamera();throw problem;}
    review=bytes;reviewURL=window.URL.createObjectURL(blob);$('#operator-review').src=reviewURL;$('#operator-review').hidden=false;video.hidden=true;
    $('[data-live="shutter"]').hidden=true;$('[data-live="use-photo"]').hidden=false;$('[data-live="retake"]').hidden=false;$('#camera-status').textContent='This selfie has not been sent. Choose Use photo or Retake.';
  }
  async function authenticate(action) {
    if(busy)return;
    await task(async()=>{
      if(action==='enroll'){if(!$('#operator-consent')?.checked)throw Object.assign(new Error('authentication_consent_required'),{code:'authentication_consent_required'});if(!$('#operator-adult')?.checked)throw Object.assign(new Error('operator_adult_declaration_required'),{code:'operator_adult_declaration_required'});await session.startEnrollment(true,true);}
      else if(action==='recover-enrollment')await session.recoverEnrollment();
      else if(action==='restart-enrollment')await session.restartEnrollment();
      else await session.startLogin();
    },{rerender:false});
    if(error){render();return;}
    if(session.operator){await load();return;}
    if(session.challenge)await task(camera,{rerender:false});if(error)render();
  }
  function facts(record,keys){return `<dl>${keys.filter(key=>record[key]!=null).map(key=>`<dt>${escape(label(key))}</dt><dd>${escape(typeof record[key]==='object'?JSON.stringify(record[key]):record[key])}</dd>`).join('')}</dl>`;}
  function closeDetail(){detailAudience=null;detail.close();$('#main').focus();}
  function selected(kind,id) {
    requireId(id);const candidates=kind==='match'?data?.matches:data?.[routes[state.route].key];return candidates?.find(row=>row.id===id);
  }
  async function showDetail(kind,id) {
    const own=generation,account=session.operator?.user_id,route=state.route;
    const row=selected(kind,id);if(!row)return;
    let content='',record=row,currentAudience=null;detailAudience=null;
    if(kind==='users') {
      const value=await session.request(`/admin/users/${requireId(id)}`);record=value.user;
      currentAudience=audienceProjection(value.audience,record.id);
      content=facts(record,['id','name','identity_state','status','matching_status','active_sessions','open_support','open_reports','pending_privacy']);
      content+=`<section><h3>Audience status</h3>${facts({age_band:currentAudience.ageBand,status:currentAudience.status,version:currentAudience.version},['age_band','status','version'])}</section>`;
      if(['under13','13_17'].includes(currentAudience.ageBand))content+=`<section><h3>Independently reviewed adulthood</h3><p>A declaration or face comparison alone cannot change a restricted account to an adult account. Review current evidence independently. This decision retires prior guardian and purpose authority; the person must make fresh purpose choices.</p><form id="live-adult-form" data-id="${escape(id)}"><label class="live-field">Review method<select name="evidence_method" required><option value="independent_live_review">Independent live review</option><option value="independent_document_review">Independent document review</option></select></label><label class="live-field">Minimized review reference<input name="evidence_reference" required minlength="16" maxlength="128" pattern="[A-Za-z0-9._:-]{16,128}" autocomplete="off"></label><label class="live-consent"><input name="adult_verified" type="checkbox" required><span>I independently verified this person's adulthood. I am reviewing another account.</span></label><label class="live-consent"><input type="checkbox" required><span>I reviewed this current account and version. The reference contains no names, identity numbers, private links or biometric material.</span></label><div class="live-actions"><button type="submit" class="primary">Record reviewed adulthood</button></div></form></section>`;
      content+=`<section><h3>Sessions</h3><ul class="live-session-list">${(value.sessions??[]).map(item=>`<li><span>${escape(label(item.status))}<small>${escape(item.id)} · ${escape(date(item.created_at))}</small></span>${['active','refreshable'].includes(item.status)?button('session-review','Revoke',`data-account="${escape(record.id)}" data-session="${escape(item.id)}"`):''}</li>`).join('')}</ul></section>`;
      for(const [type,cases] of Object.entries(value.cases??{}))content+=`<section><h3>${escape(label(type))} cases</h3>${cases.length?cases.map(item=>`<p>${escape(item.subject??item.request_type??short(item.id))} · ${escape(label(item.status))}</p>`).join(''):'<p>No records returned.</p>'}</section>`;
      content+=`<section><h3>Account history</h3>${(value.history??[]).map(item=>`<p>${escape(label(item.action))} <small>${escape(date(item.created_at))}</small></p>`).join('')||'<p>No history returned.</p>'}</section>`;
      if(Object.values(value.has_more??{}).some(Boolean))content+='<p class="live-notice">Some history or related records exceed this response limit. Use the corresponding current queue for its returned records.</p>';
    } else if(kind==='guardians') {
      content=facts(record,['id','child_account_id','guardian_account_id','state','revision','policy_version','requested_purposes','created_at','expires_at','reviewed_at','evidence_recorded']);
      content+='<p class="live-status">Verify the guardian’s adulthood and parental responsibility independently, using the operated review procedure. A face comparison, account declaration or relationship checkbox alone is insufficient. Record only an opaque review reference; do not upload documents or enter names, identity numbers, private links or biometric material here. Approval enables only the requested purposes, and never photo access.</p>';
      if(record.state==='under_review')content+=`<form id="live-guardian-form" data-kind="guardians" data-id="${escape(id)}"><label class="live-field">Decision<select name="decision" required><option value="reject">Reject</option><option value="approve">Approve reviewed purposes</option></select></label><label class="live-field">Independent review method<select name="evidence_method" required><option value="independent_live_review">Independent live review</option><option value="independent_document_review">Independent document review</option></select></label><label class="live-field">Minimized review reference<input name="evidence_reference" required minlength="16" maxlength="128" pattern="[A-Za-z0-9._:-]{16,128}" autocomplete="off"></label><label class="live-consent"><input name="adult_verified" type="checkbox"><span>I independently verified that the guardian is an adult.</span></label><label class="live-consent"><input name="parental_responsibility_verified" type="checkbox"><span>I independently verified parental responsibility for this child.</span></label><label class="live-consent"><input type="checkbox" required><span>I reviewed this current request, its exact purposes and the independent evidence. I am neither the child nor guardian.</span></label><div class="live-actions"><button type="submit" class="primary">Apply reviewed decision</button></div></form>`;
      else content+='<p>No review action is available in this state. The guardian must claim a pending request before an independent review.</p>';
    } else {
      content=facts(record,['id','account_id','subject_user_id','subject','details','reason','status','request_type','asset_id','candidate_id','owner_id','recipient_id','revision','version','failure_code','review_notes','review_outcome','outcome']);
      if(kind==='uploads')content+='<p>Processing diagnostics contain metadata only. Private photographs are not opened in the operator workspace.</p>';
      else {
        const actions=kind==='support'?['start','approve','reject','close']:kind==='privacy'?(['pending_approval'].includes(record.status)?['approve','reject']:['approved','queued','failed','processing'].includes(record.status)?['process']:[]):kind==='match'?['approve','reject','escalate','delete','audit']:['hold','release','resolve','reject'];
        content+=`<form id="live-review-form" data-kind="${escape(kind)}" data-id="${escape(id)}"><label class="live-field">Decision<select name="decision" required>${actions.map(action=>`<option value="${action}">${escape(label(action))}</option>`).join('')}</select></label><label class="live-field">Review note<textarea name="reason" required minlength="3" maxlength="1000" placeholder="Record the basis for this decision"></textarea></label><p class="live-status">Independent approval and current revisions are checked by the server. A match decision creates no recipient photo access. Processing an approved deletion permanently removes its eligible account data and private media.</p><label class="live-consent"><input name="confirmed" type="checkbox" required><span>I reviewed this current record and confirm the selected action.</span></label><div class="live-actions">${actions.length?'<button type="submit" class="primary">Apply decision</button>':'<p>No current action is available.</p>'}</div></form>`;
      }
    }
    if(own!==generation||account!==session.operator?.user_id||route!==state.route||document.hidden)return;
    detailAudience=currentAudience;
    detail.innerHTML=`<div class="live-detail"><div class="live-close">${button('close-detail','×','aria-label="Close record"')}</div><h2 id="detail-title">${escape(kind==='users'?(record.name||'Account'):kind==='support'?record.subject:label(kind))}</h2>${content}</div>`;
    if(!detail.open)detail.showModal();detail.querySelector('button')?.focus();
  }
  async function apply(intent) {
    if(!online())throw new Error('offline');
    await session.action(intent.path,intent.body);notice='The server confirmed this operation. Current records have been refreshed.';closeDetail();data=null;
  }
  document.addEventListener('submit',event=>{
    const form=event.target;if(!['live-review-form','live-session-form','live-guardian-form','live-adult-form'].includes(form.id))return;event.preventDefault();
    if(busy||session.state?.pendingAction||!form.reportValidity())return;
    const fields=new window.FormData(form),reason=fields.get('reason');let intent;
    try {if(form.id==='live-adult-form'){if(detailAudience?.accountId!==form.dataset.id)throw new Error('audience_record_changed');intent=adultReviewIntent(detailAudience,fields,crypto.randomUUID());}
      else intent=form.id==='live-guardian-form'?guardianReviewIntent(selected('guardians',form.dataset.id),fields,crypto.randomUUID()):reviewIntent(form.dataset.kind,form.id==='live-session-form'?{id:form.dataset.id}:selected(form.dataset.kind,form.dataset.id),fields.get('decision'),reason,crypto.randomUUID());}
    catch(problem){error=message(problem);render();return;}
    task(()=>apply(intent)).then(()=>{if(!error&&session.operator)load();});
  });
  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-live],[data-action]');if(!target)return;
    const action=target.dataset.live??target.dataset.action;
    if(['login','enroll','recover-enrollment','restart-enrollment'].includes(action)){authenticate(action);return;}
    if(action==='shutter'){task(shutter,{rerender:false}).then(()=>{if(error)render();});return;}
    if(action==='retake'){stopCamera();task(camera,{rerender:false}).then(()=>{if(error)render();});return;}
    if(action==='resume-camera'){task(camera,{rerender:false}).then(()=>{if(error)render();});return;}
    if(action==='cancel-camera'){stopCamera();session.cancelCapture();restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};render();return;}
    if(action==='use-photo') {
      if(!review||busy)return;const bytes=review;review=null;const own=cameraGeneration;
      task(async()=>{try{await session.useCapture(bytes);}finally{bytes.fill(0);stopCamera();}if(session.captures.length===session.challenge.required_captures)await session.complete();},{rerender:false}).then(async()=>{bytes.fill(0);if(error){render();return;}if(own+1!==cameraGeneration)return;if(session.operator){await load();return;}if(session.challenge){await task(camera,{rerender:false});if(error)render();}else render();});return;
    }
    if(action==='refresh'){load();return;}
    if(action==='more-users'){load({cursor:data?.page?.next_cursor});return;}
    if(action==='detail'){task(()=>showDetail(target.dataset.kind,target.dataset.id),{rerender:false}).then(()=>{if(error)render();});return;}
    if(action==='session-review') {
      detail.querySelector('#live-session-form')?.remove();
      detail.querySelector('.live-detail').insertAdjacentHTML('beforeend',`<form id="live-session-form" data-kind="session" data-id="${escape(requireId(target.dataset.account))}"><h3>Revoke this session</h3><input type="hidden" name="decision" value="${escape(requireId(target.dataset.session))}"><label class="live-field">Reason<textarea name="reason" required minlength="3" maxlength="1000"></textarea></label><label class="live-consent"><input type="checkbox" required><span>This session will lose access immediately. The server protects self-management and the last administrator.</span></label><div class="live-actions"><button type="submit" class="primary">Revoke session</button></div></form>`);detail.querySelector('#live-session-form textarea').focus();return;
    }
    if(action==='retry-action'){const pending=session.state?.pendingAction;if(!pending)return;task(()=>apply(pending)).then(()=>{if(!error&&session.operator)load();});return;}
    if(action==='close-detail'){closeDetail();return;}
    if(action==='logout'){
      // Logout is a cancellation boundary and must never wait for the busy gate.
      taskGeneration++;clearPrivate();busy=false;error='';notice='';
      const own=generation,revocation=session.logout();
      restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};render();
      revocation.catch(()=>{if(own!==generation)return;notice='Signed out on this browser. The server revocation could not be confirmed; verify your face to reconnect.';render();});return;
    }
    if(action==='menu'){$('#navigation-dialog').showModal();return;}
    if(action==='close-menu'){$('#navigation-dialog').close();$('.mobile-menu').focus();return;}
    if(action==='install'){installPrompt?.prompt();return;}
    if(action==='about'){notice='Operator roles require independent provisioning. Face sign-in grants authentication only. Support, privacy and moderation decisions remain server-authorized; downloaded copies cannot be revoked by this workspace.';render();return;}
    if(action==='activate-update'){if(session.state?.pendingAction){notice='Reconcile the saved action before updating.';render();return;}waitingWorker?.postMessage({type:'ACTIVATE_UPDATE'});return;}
    if(action==='clear-search'){$('#search').value='';$('#search').dispatchEvent(new window.Event('input',{bubbles:true}));}
  });
  $('#search').addEventListener('input',event=>{clearTimeout(searchTimer);const q=event.target.value.slice(0,100);searchTimer=window.setTimeout(()=>{const params=new URLSearchParams();if(q)params.set('q',q);window.location.hash=state.route+(params.size?'?'+params:'');},300);});
  window.addEventListener('hashchange',()=>{state=parseRoute(window.location.hash);detail.close();$('#navigation-dialog').close();notice='';generation++;if(session.operator)load();else render();main.focus();});
  window.addEventListener('offline',()=>{clearPrivate();busy=false;notice='Offline. Reconnect to load current records.';render();});
  window.addEventListener('online',()=>{if(session.operator)load();else render();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearPrivate();busy=false;main.innerHTML='<p class="live-status">Private workspace paused.</p>';}else if(session.operator)load();else render();});
  window.addEventListener('pagehide',stopCamera);
  window.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('#search').focus();}});
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('#install-button').hidden=false;});
  $('#install-button').hidden=true;
  if('serviceWorker'in navigator)navigator.serviceWorker.register('/admin/sw.js',{scope:'/admin/'}).then(registration=>{
    const update=()=>{if(!registration.waiting)return;waitingWorker=registration.waiting;notice='A workspace update is ready. Finish or reconcile current work before refreshing.';if(!session.challenge)render();};update();registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',update));
    navigator.serviceWorker.addEventListener('controllerchange',()=>window.location.reload());
  }).catch(()=>{});
  render();await task(async()=>{restored=await session.restore();});
  return {refresh:load};
}
