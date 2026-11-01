import {guardianReviewIntent,adultReviewIntent,audienceDecision,audienceProjection,audienceChallenge} from './audience.mjs';
import {OperatorSession} from './operator-session.mjs';
import {runtimeConfig} from './runtime-config.mjs';
import {queueStatuses,queueQuery,queuePage,queueKey} from './live-queues.mjs';
import {canOperate,OPERATOR_CAPABILITIES,capabilitySelection} from '../clients/backend/operator-capabilities.mjs';
import {collectionPage,accountLabel} from './live-collections.mjs';
import {ReviewDrafts} from './review-drafts.mjs';
import {ReviewDraftStore} from './draft-store.mjs';

// Deletion requests use deterministic UUIDv8 allocations during recovery.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-58][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requireId=value=>{if(typeof value!=='string'||!UUID.test(value))throw new Error('invalid_record');return value;};
export const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={overview:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',users:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',safety:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM12 8v5m0 3h.01"/>',privacy:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',support:'<path d="M4 13v-2a8 8 0 0 1 16 0v2m-1 5c0 3-3 3-5 3"/><rect x="2" y="11" width="4" height="7" rx="2"/><rect x="18" y="11" width="4" height="7" rx="2"/>',uploads:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 17 5-5 4 4 3-3 6 5"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 1 1 4 3v3m-1 3h.01"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]??paths.overview}</svg>`;
export const routes=Object.freeze({overview:{label:'Overview',icon:'overview',path:'/admin/metrics'},users:{label:'Users',icon:'users',path:'/admin/users',key:'users'},'match-reports':{label:'Match reports',icon:'safety',path:'/admin/safety/reports',key:'reports'},guardians:{label:'Guardian consent',icon:'privacy',path:'/admin/guardian-requests',key:'guardian_requests'},privacy:{label:'Privacy',icon:'privacy',path:'/admin/privacy-requests',key:'privacy_requests'},support:{label:'Support',icon:'support',path:'/admin/support-requests',key:'support_requests'},uploads:{label:'Uploads',icon:'uploads',path:'/admin/uploads',key:'uploads'},'queue-recovery':{label:'Work recovery',icon:'overview',path:'/admin/queue-repairs',key:'queue_repairs'},operators:{label:'Operator access',icon:'users',path:'/admin/operators',key:'operators'}});
const routeCapabilities=Object.freeze({overview:'overview.read',users:'users.read','match-reports':'safety.read',guardians:'guardian.read',privacy:'privacy.read',support:'support.read',uploads:'uploads.read',operators:'operators.manage','queue-recovery':'operators.manage'});
export function permittedRoutes(operator){return Object.keys(routes).filter(route=>canOperate(operator,routeCapabilities[route]));}

export function parseRoute(hash='') {
  const [name,query='']=hash.replace(/^#/,'').split('?');const params=new URLSearchParams(query);
  const route=Object.hasOwn(routes,name)?name:'overview';
  return {route,...(route==='queue-recovery'&&params.get('sort')==='oldest'?{sort:'oldest'}:{}),q:(params.get('q')??'').slice(0,100),filter:(params.get('filter')??(route==='queue-recovery'?'attention':'all')).slice(0,30),
    ...(route==='match-reports'?{collection:params.get('collection')==='matches'?'matches':'reports'}:{})};
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
export function queueRepairIntent(preview,reason,key){
  if(!preview||!['photo','privacy','notification'].includes(preview.category)||preview.eligible!==true||preview.action!=='resume_exact_work'||
    !/^[0-9a-f]{64}$/.test(preview.job_id??'')||!/^[0-9a-f]{64}$/.test(preview.fingerprint??'')||!UUID.test(preview.domain_id??''))throw new Error('queue_repair_blocked');
  requireId(key);
  if(typeof reason!=='string'||reason.trim().length<3||reason.trim().length>1000||/[\x00-\x1f\x7f]/.test(reason))throw new Error('review_reason_required');
  return {path:'/admin/queue-repairs/'+preview.job_id,body:{operation_key:key,expected_fingerprint:preview.fingerprint,reason:reason.trim()}};
}

const label=value=>String(value??'Unavailable').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
const date=value=>{const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(n):'Unavailable';};
const short=value=>typeof value==='string'?`${value.slice(0,8)}…`:'Unavailable';
function rows(value,queue=false) {if(!Array.isArray(value)||value.length>100||value.some(row=>!row||!(queue?/^[0-9a-f]{64}$/.test(row.id)&&row.job_id===row.id:UUID.test(row.id))))throw new Error('invalid_response');return value;}
const button=(action,text,extra='',primary=false)=>`<button type="button" data-live="${escape(action)}" ${extra} class="${primary?'primary':''}">${escape(text)}</button>`;
function workspaceDraftStore(session,window){
  try{return window.indexedDB&&window.localStorage?new ReviewDraftStore(session.base,{indexedDB:window.indexedDB,localStorage:window.localStorage}):null;}
  catch{return null;}
}

export function recordTable(kind,records,{disabled=false}={}) {
  if(!records.length)return '<p class="live-empty">No current records were returned.</p>';
  const tableName=kind==='match'?'Matching proposals':kind==='safety'?'Photo reports':routes[kind]?.label??'Records';
  return `<div class="live-table-wrap" role="region" tabindex="0" aria-label="${escape(tableName)} table; scroll horizontally for all columns"><table class="live-table"><caption class="sr-only">${escape(tableName)}</caption><thead><tr><th scope="col">${['users','operators'].includes(kind)?'Account':kind==='uploads'?'Photo':'Request'}</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${records.map(row=>{
    const title=kind==='queue-recovery'?label(row.category)+' work':['users','operators'].includes(kind)?(row.name||'Unnamed account'):kind==='support'?row.subject:kind==='uploads'?(row.title||'Photo'):kind==='guardians'?'Guardian consent':kind==='privacy'?label(row.request_type):kind==='match'?'Matching proposal':(row.reason||'Photo report');
    return `<tr><td>${escape(title)}<small>${escape(row.id)}</small></td><td>${escape(kind==='users'?accountLabel(row):label(row.queue_state??row.status??row.state))}</td><td>${escape(date(row.created_at))}</td><td>${button('detail','Review',`aria-label="${escape('Review '+title+'; record '+row.id)}" data-kind="${escape(kind)}" data-id="${escape(row.id)}" ${disabled?'disabled':''}`)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function reviewForm(kind,id,actions) {
  return `<form id="live-review-form" data-kind="${escape(kind)}" data-id="${escape(id)}"><label class="live-field">Decision<select name="decision" required>${actions.map(action=>`<option value="${escape(action)}">${escape(label(action))}</option>`).join('')}</select></label><label class="live-field">Review note<textarea name="reason" required minlength="3" maxlength="1000" placeholder="Record the basis for this decision"></textarea></label><p class="live-status">Independent approval and current revisions are checked by the server. A match decision creates no recipient photo access. Processing an approved deletion permanently removes its eligible account data and private media.</p><label class="live-consent"><input name="confirmed" type="checkbox" required><span>I reviewed this current record and confirm the selected action.</span></label><div class="live-actions">${actions.length?'<button type="submit" class="primary">Apply decision</button>':'<p>No current action is available.</p>'}</div></form>`;
}

function message(problem) {
  const code=problem?.code??problem?.message;
  if(code==='private_state_changed')return 'Another tab changed the protected device state. Close other Lovelies tabs and refresh before retrying the original saved operation.';
  if(code==='audience_selection_required')return 'Select your current age range. The selection is used only to record the eligibility decision; it is not saved as an age range.';
  if(code==='audience_confirmation_required')return 'Review your current eligibility selection and confirm it before continuing.';
  if(code==='operator_adult_required')return 'This operator workspace requires an adult account. An age declaration or face match does not grant administrator authority. A restricted account needs its current independent review process.';
  if(code==='audience_review_required')return 'Your eligibility review is due. Check the current account status, then make a fresh eligibility decision and separate face-authentication choice before opening the camera.';
  if(['audience_upgrade_required','reconcile_audience_operation','explicit_auth_consent_required'].includes(code))return 'The original eligibility operation needs reconciliation. Its saved key and decision are preserved. Retry that original operation; do not create another account or replace its key.';
  if(code==='guardian_evidence_required')return 'Record the independent review method and its minimized reference. Approval requires both adulthood and parental-responsibility checks.';
  if(code==='guardian_record_changed')return 'The guardian request changed or is not ready for independent review. Refresh the queue.';
  if(code==='audience_record_changed')return 'The audience record changed. Reopen the account before reviewing adulthood.';
  if(code==='adult_evidence_required')return 'An adulthood transition needs an independent review method, minimized reference and affirmative verification.';
  if(['audience_response_invalid','audience_device_response_invalid','audience_renewal_response_invalid','audience_challenge_invalid'].includes(code))return 'The service did not confirm current audience authority. No camera or private operation has been authorized.';
  if(code==='authentication_consent_required')return 'Read the face authentication consent and select its checkbox before setting up your profile.';
  if(code==='operator_action_in_progress')return 'The original operator action is still finishing. Wait for its result before retrying or starting another action.';
  if(['operation_recovered_without_result','operation_retired_by_recovery'].includes(code))return 'The service preserved the restrictive changes after an interrupted transaction. This action has ended without its original result. Refresh the record and review its current state before deciding again.';
  if(code==='queue_repair_snapshot_changed'||code==='queue_repair_blocked')return 'This work is no longer eligible to resume from the inspected state. Inspect its current status again before deciding.';
  const copy={operator_provisioning_required:'Your face was verified, but this account has no operator authority. An existing authorized administrator must provision your role independently.',fresh_face_authentication_required:'This action requires a fresh face sign-in. Sign out, verify your face again, then retry the original saved action.',independent_review_required:'Another authorized operator must review this request.',self_management_forbidden:'You cannot revoke your own account through this operator action.',last_admin_protected:'The last administrator is protected. Another qualified administrator must remain available.',private_storage_unavailable:'Private browser storage is unavailable. Enable IndexedDB in this browser and retry.',private_state_unavailable:'This browser could not read its protected device state. Keep this browser profile and request operator recovery support.',private_write_failed:'The browser could not save the protected operation. Free storage and retry; no replacement identity has been created.',capture_expired:'This capture request expired. Verify its status or start a fresh sign-in.',reconcile_previous_action:'An earlier action has an unknown result. Retry that original action before starting another.',enrollment_recovery_unavailable:'The original enrollment must be recovered. Keep this browser profile and check its status.',camera_unavailable:'The camera is unavailable. Allow camera access for this site and retry.',invalid_response:'The server returned an unexpected response. Refresh the current view.',review_reason_required:'Enter a review note of 3–1,000 characters.'};
  if(copy[code])return copy[code];
  if(problem?.status===401)return 'Your authorization expired or was revoked. Verify your face again to continue.';
  if(problem?.status===403)return 'Your current account is not authorized for this action. Refresh authorization before retrying.';
  if(problem?.status===409)return 'This record changed or is no longer eligible. Refresh it and review its current state before deciding.';
  return 'The request could not finish. Check the connection and retry. An uncertain action keeps its original saved operation.';
}

export async function startWorkspace({document=globalThis.document,window=globalThis.window,session=new OperatorSession({baseUrl:runtimeConfig.apiBaseUrl,policyVersion:runtimeConfig.facePolicyVersion}),drafts=new ReviewDrafts({storage:workspaceDraftStore(session,window)})}={}) {
  const $=selector=>document.querySelector(selector),main=$('#main'),detail=$('#detail-dialog');
  let state=parseRoute(window.location.hash),data=null,busy=false,error='',notice='',restored=null,generation=0,taskGeneration=0,stream=null,review=null,reviewURL=null,cameraGeneration=0,searchTimer,installPrompt,waitingWorker,detailAudience=null;
  let pageCursors=[null],pageIndex=0,pageIdentity=queueKey(state),detailRecord=null,detailCursor=null,detailGeneration=0,detailRequest=null,displayedDetail=null,accountDetail=null,draftContext=null,detailOrigin=null,queueRepair=null;
  const navigator=window.navigator;
  document.body.classList.add('live-app');
  function stopCamera() {cameraGeneration++;stream?.getTracks().forEach(track=>track.stop());stream=null;if(review)review.fill(0);review=null;if(reviewURL)window.URL.revokeObjectURL(reviewURL);reviewURL=null;}
  function clearPrivate() {data=null;pageCursors=[null];pageIndex=0;closeDetail(false);stopCamera();session.cancelCapture();generation++;}
  function online() {return navigator.onLine!==false;}
  const permitted=capability=>canOperate(session.operator,capability);
  function shell() {
    const available=session.operator?permittedRoutes(session.operator):Object.keys(routes).filter(route=>route!=='operators');
    if(session.operator&&!available.includes(state.route)&&available.length){state={route:available[0],q:'',filter:'all'};data=null;pageIdentity=queueKey(state);pageCursors=[null];pageIndex=0;}
    document.title=`${routes[state.route].label} · Lovelies Admin`;
    $('#breadcrumb').textContent=routes[state.route].label;
    const links=Object.entries(routes).filter(([id])=>available.includes(id)).map(([id,item])=>`<a class="nav-link ${id===state.route?'active':''}" href="#${id}" ${id===state.route?'aria-current="page"':''}>${icon(item.icon)}<span>${item.label}</span></a>`).join('');
    $('#navigation').innerHTML=links;$('#mobile-navigation').innerHTML=links+`<div class="mobile-utilities"><button type="button" class="utility-link" data-action="install" id="mobile-install-button" ${installPrompt?'':'hidden'}>${icon('download')}<span>Install app</span></button><button type="button" class="utility-link" data-action="about">${icon('help')}<span>Workspace help</span></button><button type="button" class="utility-link" data-action="logout" aria-label="Sign out and clear private workspace" ${session.credentials?'':'disabled'}>${icon('close')}<span>Sign out</span></button></div>`;
    $('#search').value=state.q;$('#search').placeholder=state.route==='users'?'Find an account…':'Search current records…';$('#search').setAttribute('aria-label','Search current records on the server');$('#search').disabled=!session.operator||state.route==='overview';
    $('#install-button').hidden=!installPrompt;
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
  function eligibilityFields(renewal=false){return `<fieldset><legend>${renewal?'Annual eligibility review':'Eligibility'}</legend><label class="live-field">Your current age range<select id="operator-age" required ${busy?'disabled':''} aria-describedby="operator-age-note"><option value="">Choose an age range</option><option value="under13">Under 13</option><option value="13_17">13–17</option><option value="18_plus">18 or older</option></select></label><p id="operator-age-note">This selection is temporary. The service records only the eligibility and guardian decisions with their review dates. This operator workspace requires an independently authorized adult account.</p><label class="live-consent"><input id="operator-audience-confirm" type="checkbox" ${busy?'disabled':''}><span>I reviewed this selection and confirm that it applies to my current account.</span></label></fieldset><label class="live-consent"><input id="operator-consent" type="checkbox" ${busy?'disabled':''}><span>${renewal?'I make a new choice to use my profile selfies for face authentication. Renewing eligibility does not restore photo matching, processing, or sharing permissions.':'I consent to use my three profile selfies to register face authentication for this account. Photo matching and processing permissions remain separate.'}</span></label>`;}
  function auth() {
    const challenge=session.challenge,required=challenge?.required_captures??0,count=session.captures.length;
    const audienceReview=session.audienceReview,pendingAudience=session.state?.pendingAudience;
    const pose=challenge?.poses?.[count];
    const hint=pose==='left'?'Turn slightly to your left.':pose==='right'?'Turn slightly to your right.':'Look straight at the camera.';
    return `<section class="live-auth"><h1>${challenge?'Verify your face':audienceReview?'Review your eligibility':'Your protected workspace'}</h1><p>${challenge?`Capture ${count+1} of ${required}. ${escape(hint)} Each photo is compared by the backend before authorization.`:'Use the registered face and private device key for an independently authorized operator account.'}</p>${errorHTML()}${notice?`<p class="live-notice" role="status">${escape(notice)}</p>`:''}
      ${challenge?`<div class="live-camera"><video id="operator-camera" autoplay muted playsinline aria-label="Front-camera preview"></video><img id="operator-review" hidden alt="Unsent selfie for review"></div><div class="live-actions">${button('resume-camera','Open camera',busy?'disabled':'',true)}${button('shutter','Take photo',busy||!stream?'disabled':'',true)}${button('use-photo','Use photo','hidden',true)}${button('retake','Retake','hidden')}${button('cancel-camera','Cancel')}</div><p id="camera-status" role="status" aria-live="polite">Open the camera to continue.</p>`:`
        ${session.state?.audienceTerminal&&!session.state.audienceTerminal.reconciledAt?'<aside class="live-notice"><h2>Earlier eligibility operation ended</h2><p>Recovery ended the original operation without confirming a renewal. Check current eligibility and make a fresh choice when requested. Your account and registered reference are retained.</p></aside>':''}
        ${pendingAudience?`<aside class="live-notice"><h2>Saved eligibility operation</h2><p>The service may already have accepted your original decision. Its exact operation is preserved in this browser. Checking it does not make a new decision or create another account.</p><div class="live-actions">${button('recover-audience','Retry original eligibility operation',busy||!online()?'disabled':'',true)}</div></aside>`:
          audienceReview?.kind==='profile-recovery'?`<aside class="live-notice"><h2>Original profile needs recovery</h2><p>The current service response requires controlled recovery of this account's registered profile. Keep this browser profile and its private key. An independently authorized operator must follow the operator browser recovery procedure. This page will not create a replacement account or open a camera for an unavailable profile.</p><div class="live-actions">${button('login','Check existing device status',busy||!online()?'disabled':'')}</div></aside>`:
          audienceReview?`<p>Your annual eligibility review is due. Make a fresh decision and a separate face-authentication choice before continuing. Your existing account and saved operations are retained.</p>${audienceReview.renewalAvailable?eligibilityFields(true):'<p>The current account requires independent review before this adult workspace can be used.</p>'}<div class="live-actions">${audienceReview.renewalAvailable?button('renew-audience','Confirm annual review',busy||!online()?'disabled':'',true):''}${button('cancel-camera','Back',busy?'disabled':'')}</div>`:
          `${!restored?.registered&&!restored?.pending?eligibilityFields():''}<div class="live-actions">${restored?.pending?button('recover-enrollment','Check saved setup',busy?'disabled':'',true)+button('restart-enrollment','Renew original setup',busy?'disabled':''):restored?.registered?button('login','Verify my face',busy?'disabled':'',true):button('enroll','Set up my face',busy?'disabled':'',true)}</div>`}
        <p>New registration does not grant an administrator role. Keep this browser profile to retain its private device key and original recovery state.</p>`}${waitingWorker?button('activate-update','Apply workspace update',busy?'disabled':''):''}</section>`;
  }
  function render() {
    shell();
    main.setAttribute('aria-busy',busy?'true':'false');
    if(document.hidden){main.innerHTML='<p class="live-status">Private workspace paused.</p>';return;}
    if(!session.operator){main.innerHTML=auth();return;}
    const pending=!!session.state?.pendingAction;
    let body='';
    if(data&&state.route==='overview')body=`<div class="live-grid">${[['accounts','Active accounts'],['uploads','Current uploads'],['active_grants','Active photo grants'],['open_support','Open support'],['open_reports','Open reports']].map(([key,title])=>`<div class="live-metric"><strong>${Number.isSafeInteger(data[key])?escape(data[key]):'Unavailable'}</strong><span>${escape(title)}</span></div>`).join('')}</div><div class="live-actions"><a class="button" href="#support">Support queue</a><a class="button" href="#match-reports">Match reports</a><a class="button" href="#privacy">Privacy queue</a></div>`;
    else if(data) {
      if(state.route==='operators')body+=`<form id="live-operator-open-form"><label class="live-field">Account ID<input name="account_id" required pattern="[0-9a-fA-F-]{36}" autocomplete="off" placeholder="Registered adult account ID"></label><button type="submit">Review access</button><p class="live-status">Grants expire within 30 days. Choose the minimum permissions needed; action permissions include their corresponding read permission. No administrator role is created.</p></form>`;
      const matching=state.route==='match-reports'&&state.collection==='matches';
      const records=rows(data[matching?'matches':routes[state.route].key],state.route==='queue-recovery'),page=queuePage(data.page);
      if(state.route==='match-reports')body+=`<div class="live-actions" role="group" aria-label="Moderation queue">${button('safety-reports','Reports',`aria-pressed="${!matching}"`)}${button('safety-matches','Matching proposals',`aria-pressed="${matching}"`)}</div>`;
      body+=`<label class="live-field">Status<select id="live-status-filter" ${busy?'disabled':''}>${queueStatuses(state).map(value=>`<option value="${escape(value)}" ${value===state.filter?'selected':''}>${escape(label(value))}</option>`).join('')}</select></label>`;
      body+=recordTable(matching?'match':state.route==='match-reports'?'safety':state.route,records,{disabled:busy||!online()||pending});
      body+=`<p class="live-status" aria-live="polite">Page ${pageIndex+1} · ${records.length} returned${page.total===null?'':` · ${page.total} matching records`}. Search and status apply to the server queue. Refresh to include new or changed work.</p>`;
      body+=`<div class="live-actions">${pageIndex>0?button('previous-page','Previous page',busy?'disabled':''):''}${page.next_cursor?button('next-page','Next page',busy?'disabled':''):''}${pageIndex>0?button('first-page','First page',busy?'disabled':''):''}</div>`;
    } else body=`<p class="live-status" role="status">${busy?'Loading current records…':'Refresh to load current records.'}</p>`;
    main.innerHTML=`<header class="live-header"><h1>${routes[state.route].label}</h1><div class="live-actions">${button('refresh','Refresh',busy||!online()?'disabled':'')}${waitingWorker?button('activate-update','Apply workspace update',busy||pending?'disabled':''):''}</div></header>${errorHTML()}${notice?`<p class="live-notice" role="status">${escape(notice)}</p>`:''}${pendingHTML()}${body}`;
  }
  async function task(action,{rerender=true}={}) {
    if(busy)return;const own=++taskGeneration;busy=true;error='';if(rerender)render();
    try {await action();}
    catch(problem){if(own!==taskGeneration)return;error=message(problem);if(!session.operator){clearPrivate();restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};}}
    finally {if(own===taskGeneration){busy=false;if(rerender)render();if(error&&detail.open){detail.querySelector('.live-error')?.remove();detail.querySelector('.live-detail')?.insertAdjacentHTML('afterbegin',errorHTML());}if(error)window.requestAnimationFrame(()=>(detail.open?detail.querySelector('.live-error'):$('.live-error'))?.focus());}}
  }
  async function load({cursor=null,index=0}={}) {
    if(detailRequest)closeDetail(false);
    shell();
    const own=++generation,account=session.operator?.user_id;if(!account||document.hidden)return;
    drafts.bind(account);
    const route=state.route,identity=queueKey(state);
    if(identity!==pageIdentity){pageIdentity=identity;pageCursors=[null];pageIndex=0;cursor=null;index=0;}
    if(!cursor)data=null;error='';busy=true;render();
    try {
      const params=route==='overview'?null:queueQuery(state,cursor);
      const value=await session.request(routes[route].path+(params?'?'+params:''));
      if(own!==generation||account!==session.operator?.user_id)return;
      try{await drafts.hydrate(account);}catch{notice='Saved notes could not be opened in this browser. Current records remain available.';}
      if(own!==generation||account!==session.operator?.user_id)return;
      if(route!=='overview'){rows(value[route==='match-reports'&&state.collection==='matches'?'matches':routes[route].key],route==='queue-recovery');queuePage(value.page);}
      data=value;pageCursors=pageCursors.slice(0,index);pageCursors[index]=cursor;pageIndex=index;
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
    let selection;
    if(action==='enroll'||action==='renew-audience'){
      try{
        if(!$('#operator-consent')?.checked)throw Object.assign(new Error('authentication_consent_required'),{code:'authentication_consent_required'});
        if(!$('#operator-audience-confirm')?.checked)throw Object.assign(new Error('audience_confirmation_required'),{code:'audience_confirmation_required'});
        selection=$('#operator-age')?.value;audienceDecision(selection);
      }catch(problem){error=message(problem);render();window.requestAnimationFrame(()=>$('.live-error')?.focus());return;}
    }
    const authenticationGeneration=taskGeneration+1;
    await task(async()=>{
      try{
      if(action==='enroll'||action==='renew-audience'){
        if(action==='enroll')await session.startEnrollment(true,selection,true);
        else await session.renewOperatorAudience(selection,true,true);
      }
      else if(action==='recover-audience')await session.recoverOperatorAudience();
      else if(action==='recover-enrollment')await session.recoverEnrollment();
      else if(action==='restart-enrollment')await session.restartEnrollment();
      else await session.startLogin();
      }catch(problem){
        // A retained enrollment may reach its annual boundary before it has a
        // registered device reference. Read its own decision without changing
        // an uncertain enrollment/resume operation or declaring a new age.
        if(['audience_review_required','audience_restricted'].includes(problem?.code)&&session.state?.enrollment&&!session.state.reference&&!session.state.pendingAudience){
          await session.declareOperatorAudience();return;
        }
        throw problem;
      }
    },{rerender:false});
    if(authenticationGeneration!==taskGeneration||document.hidden)return;
    if(error){render();return;}
    if(session.operator){await load();return;}
    if(session.challenge)await task(camera,{rerender:false});if(error||!session.challenge)render();
  }
  function draftScope(form) {
    if(!draftContext||!session.operator||!['live-review-form','live-session-form','live-guardian-form','live-adult-form','live-queue-repair-form'].includes(form?.id))return null;
    return {accountId:session.operator.user_id,recordId:draftContext.id,form:form.id,
      target:form.id==='live-session-form'?String(form.elements.namedItem('decision')?.value??''):form.id==='live-queue-repair-form'?String(queueRepair?.job_id??''):draftContext.kind,
      version:draftContext.version+(form.id==='live-session-form'?'|'+(form.dataset.sessionVersion??''):form.id==='live-queue-repair-form'?'|'+(queueRepair?.fingerprint??''):'')};
  }
  function draftFields(form) {
    const fields={};
    for(const name of ['reason','decision','evidence_method','evidence_reference']) {
      const control=form.elements.namedItem(name);
      if(control&&control.type!=='checkbox'&&control.type!=='hidden')fields[name]=String(control.value).slice(0,1000);
    }
    return fields;
  }
  function addDraftRestore(form) {
    const scope=draftScope(form);if(!scope||!drafts.available(scope))return;
    form.insertAdjacentHTML('afterbegin',`<aside class="live-notice" data-draft-notice><p>Unsent notes are available for this unchanged record. Restore them, review the current decision and confirm again. ${drafts.storage?'Encrypted notes can be restored in this browser for up to 30 minutes after editing, including across reloads.':'Notes remain in this tab for up to 30 minutes; persistent browser storage is unavailable.'} Signing out clears access to saved notes.</p><div class="live-actions">${button('restore-draft','Restore unsent notes',`data-form="${escape(form.id)}"`)}${button('discard-draft','Discard saved notes',`data-form="${escape(form.id)}"`)}</div></aside>`);
  }
  async function restoreDraft(formId) {
    if(!['live-review-form','live-session-form','live-guardian-form','live-adult-form','live-queue-repair-form'].includes(formId)||session.state?.pendingAction)return;
    const form=detail.querySelector('#'+formId),scope=draftScope(form),context=draftContext,own=generation;
    if(!scope||!detail.open||document.hidden)return;
    const fields=await drafts.restore(scope);
    if(!fields||own!==generation||draftContext!==context||session.operator?.user_id!==scope.accountId||document.hidden||!detail.open||detail.querySelector('#'+formId)!==form)return;
    for(const [name,value] of Object.entries(fields)) {
      const control=form.elements.namedItem(name);
      if(!control||['checkbox','hidden'].includes(control.type))continue;
      if(control.tagName==='SELECT'&&![...control.options].some(option=>option.value===value))continue;
      control.value=value;
    }
    for(const checkbox of form.querySelectorAll('input[type="checkbox"]'))checkbox.checked=false;
    form.querySelector('[data-draft-notice]')?.remove();form.querySelector('textarea,input:not([type="checkbox"]),select')?.focus();
  }
  function detailSection(type,items,pageValue,index=0,accountId=null) {
    if(!Array.isArray(items)||items.length>100)throw new Error('invalid_response');const page=collectionPage(pageValue);
    let content='';
    if(type==='sessions')content=`<ul class="live-session-list">${items.map(item=>`<li><span>${escape(label(item.status))}<small>${escape(item.id)} · ${escape(date(item.created_at))}</small></span>${permitted('users.sessions.revoke')&&['active','refreshable'].includes(item.status)?button('session-review','Revoke',`data-account="${escape(accountId)}" data-session="${escape(item.id)}" data-session-version="${escape(JSON.stringify([item.status,item.created_at,item.expires_at]))}"`):''}</li>`).join('')}</ul>`;
    else if(type==='history')content=items.map(item=>`<p>${escape(label(item.action))}<small> · ${escape(date(item.created_at))}</small>${item.actor_id?`<small class="live-history-actor">Operator ${escape(item.actor_id)}</small>`:''}</p>`).join('');
    else content=items.map(item=>`<p>${escape(item.subject??item.request_type??short(item.id))} · ${escape(label(item.status))}<small> · ${escape(date(item.created_at))}</small></p>`).join('');
    return `<section id="account-section-${escape(type)}"><h3>${escape(type==='history'?'History':type==='sessions'?'Sessions':label(type)+' cases')}</h3>${content||'<p>No records returned.</p>'}<nav class="live-actions" aria-label="${escape(label(type))} pages">${button('detail-page','Previous',`data-section="${escape(type)}" data-direction="previous" ${index===0?'disabled':''}`)}<span class="live-page-status">Page ${index+1} · ${items.length} records${page.total==null?'':` · ${page.total} total`}</span>${button('detail-page','Next',`data-section="${escape(type)}" data-direction="next" ${!page.has_more?'disabled':''}`)}</nav></section>`;
  }
  async function loadDetailSection(type,direction) {
    const context=accountDetail,own=generation,account=session.operator?.user_id;
    if(!context||!context.pages[type]||!['next','previous'].includes(direction)||!detail.open)return;
    const position=context.positions[type],page=collectionPage(context.pages[type]);
    if(direction==='previous'&&position.index===0||direction==='next'&&!page.has_more)return;
    const cursor=direction==='next'?page.next_cursor:position.cursors[position.index-1];
    const params=new URLSearchParams({q:'',status:'all',sort:context.pages[type].sort??'newest',limit:String(context.pages[type].limit??25)});
    if(cursor)params.set('cursor',cursor);
    const path=context.type==='privacy'?`/admin/privacy-requests/${context.id}/history`:`/admin/users/${context.id}/${type}`;
    const value=await session.request(path+'?'+params);
    if(own!==generation||account!==session.operator?.user_id||accountDetail!==context||!detail.open||document.hidden)return;
    rows(value.items);collectionPage(value.page);
    if(direction==='next'){position.cursors=position.cursors.slice(0,position.index+1);position.cursors.push(cursor);position.index++;}
    else position.index--;
    context.pages[type]=value.page;
    const section=detail.querySelector(`#account-section-${type}`);
    if(section){section.outerHTML=detailSection(type,value.items,value.page,position.index,context.id);detail.querySelector(`#account-section-${type} h3`)?.setAttribute('tabindex','-1');detail.querySelector(`#account-section-${type} h3`)?.focus();}
  }
  function facts(record,keys){return `<dl>${keys.filter(key=>record[key]!=null).map(key=>`<dt>${escape(label(key))}</dt><dd>${escape(typeof record[key]==='object'?JSON.stringify(record[key]):record[key])}</dd>`).join('')}</dl>`;}
  function closeDetail(focus=true){
    const origin=detailOrigin;detailOrigin=null;accountDetail=null;draftContext=null;queueRepair=null;
    detailGeneration++;detailAudience=null;detailRecord=null;detailCursor=null;displayedDetail=null;
    if(detailRequest){detailRequest=null;busy=false;}
    if(detail.open)detail.close();
    detail.innerHTML='';if(focus&&!document.hidden){if(origin?.generation===generation&&origin.element.isConnected!==false&&!origin.element.disabled&&typeof origin.element.focus==='function')origin.element.focus();else main.focus();}
  }
  function observeDetailClosure(){
    // The browser removes `open` before delivering its queued close event.
    // Retire that displayed record before creating a later read owner. The
    // delayed event then has no closed display belonging to the new request.
    if(displayedDetail&&!detail.open)closeDetail(false);
  }
  const currentDetail=request=>request.generation===detailGeneration&&request.navigation===generation&&
    request.account===session.operator?.user_id&&request.epoch===session.epoch&&request.route===state.route&&!document.hidden&&(!displayedDetail||detail.open);
  async function openDetail(kind,id,cursor=null) {
    observeDetailClosure();
    if(busy||!session.operator)return;
    const request={generation:++detailGeneration,navigation:generation,account:session.operator.user_id,epoch:session.epoch,route:state.route};
    detailRequest=request;busy=true;error='';let failed=false;
    try {await showDetail(kind,id,cursor,request);}
    catch(problem){
      observeDetailClosure();
      // A dismissed read can still discover current server-side revocation.
      // Discard stale presentation errors, but never retain private rows after
      // the session itself has removed operator authority.
      if(!session.operator&&(problem.status===401||problem.status===403)){
        clearPrivate();restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};
        busy=false;error=message(problem);render();return;
      }
      if(!currentDetail(request))return;error=message(problem);failed=true;
    }finally{
      if(detailRequest===request){
        detailRequest=null;busy=false;
        if(failed){
          render();
          if(detail.open){detail.querySelector('.live-error')?.remove();detail.querySelector('.live-detail')?.insertAdjacentHTML('afterbegin',errorHTML());}
          window.requestAnimationFrame(()=>{if(currentDetail(request))(detail.open?detail.querySelector('.live-error'):$('.live-error'))?.focus();});
        }
      }
    }
  }
  function selected(kind,id) {
    if(kind==='queue-recovery'){if(!/^[0-9a-f]{64}$/.test(id??''))throw new Error('invalid_record');}else requireId(id);if(detailRecord?.kind===kind&&detailRecord.record.id===id)return detailRecord.record;
    const candidates=kind==='match'?data?.matches:data?.[routes[state.route].key];return candidates?.find(row=>row.id===id);
  }
  async function showDetail(kind,id,cursor,request) {
    if(!currentDetail(request))return;
    const row=kind==='operators'?{id:requireId(id)}:selected(kind,id);if(!row)return;
    let content='',record=row,currentAudience=null,nextDetail=null,nextQueueRepair=null;detailAudience=null;queueRepair=null;
    if(kind==='queue-recovery'){
      if(!permitted('operators.manage'))throw new Error('operator_capability_required');
      const value=(await session.request('/admin/queue-repairs/'+id)).queue_repair;
      if(!validQueuePreview(value,id))throw new Error('invalid_response');
      record={...value,id};nextQueueRepair=value;content=queueRecoverySection(value);
    }else if(kind==='operators') {
      if(!permitted('operators.manage'))throw new Error('operator_capability_required');
      const value=await session.request(`/admin/operators/${requireId(id)}`);record=value.operator;
      if(!record||record.id!==id||!Number.isSafeInteger(record.revision)||!Array.isArray(record.capabilities))throw new Error('invalid_response');
      content=facts(record,['id','name','status','identity_state','revision']);
      content+=`<section><h3>Current permissions</h3>${record.grants.map(grant=>`<p>${escape(grant.capability)} · ${escape(date(grant.expires_at))}${grant.expired?' · expired':''}</p>`).join('')||'<p>No delegated grants.</p>'}</section>`;
      if(!record.administrator&&record.id!==session.operator.user_id){const expiry=new Date(Date.now()+7*86400000).toISOString().slice(0,16);
        content+=`<form id="live-operator-form" data-id="${escape(id)}"><fieldset><legend>Delegated permissions</legend>${OPERATOR_CAPABILITIES.map(capability=>`<label class="live-consent"><input type="checkbox" name="capabilities" value="${capability}" ${record.capabilities.includes(capability)?'checked':''}><span>${escape(capability)}</span></label>`).join('')}</fieldset><label class="live-field">Expiry (UTC, maximum 30 days)<input name="expires_at" type="datetime-local" value="${expiry}" required></label><label class="live-field">Reason<textarea name="reason" required minlength="3" maxlength="1000"></textarea></label><p>Clear every permission to revoke delegated access. Existing sessions immediately lose those capabilities after the server confirms the change.</p><label class="live-consent"><input type="checkbox" required><span>I reviewed this account and its minimum required permissions.</span></label><button type="submit" class="primary">Apply access</button></form>`;}
    } else if(kind==='users') {
      const value=await session.request(`/admin/users/${requireId(id)}`);record=value.user;
      currentAudience=audienceProjection(value.audience,record.id);
      content=facts(record,['id','name','identity_state','status','matching_status','active_sessions','open_support','open_reports','pending_privacy']);
      content+=`<section><h3>Audience status</h3>${facts({minimum_age_met:currentAudience.atLeast13===null?'Not declared':currentAudience.atLeast13?'Yes':'No',guardian_required:currentAudience.guardianRequired===null?'Not declared':currentAudience.guardianRequired?'Yes':'No',status:currentAudience.status,version:currentAudience.version,next_review_at:currentAudience.nextReviewAt},['minimum_age_met','guardian_required','status','version','next_review_at'])}</section>`;
      if(permitted('guardian.review')&&(currentAudience.atLeast13===false||currentAudience.guardianRequired===true))content+=`<section><h3>Independently reviewed adulthood</h3><p>A declaration or face comparison alone cannot change a restricted account to an adult account. Review current evidence independently. This decision retires prior guardian and purpose authority; the person must make fresh purpose choices.</p><form id="live-adult-form" data-id="${escape(id)}"><label class="live-field">Review method<select name="evidence_method" required><option value="independent_live_review">Independent live review</option><option value="independent_document_review">Independent document review</option></select></label><label class="live-field">Minimized review reference<input name="evidence_reference" required minlength="16" maxlength="128" pattern="[A-Za-z0-9._:-]{16,128}" autocomplete="off"></label><label class="live-consent"><input name="adult_verified" type="checkbox" required><span>I independently verified this person's adulthood. I am reviewing another account.</span></label><label class="live-consent"><input type="checkbox" required><span>I reviewed this current account and version. The reference contains no names, identity numbers, private links or biometric material.</span></label><div class="live-actions"><button type="submit" class="primary">Record reviewed adulthood</button></div></form></section>`;
      nextDetail={type:'account',id,pages:value.pages??{},positions:{}};
      for(const type of ['sessions','support','safety','privacy','history']) {
        nextDetail.positions[type]={cursors:[null],index:0};
        if(value.redacted_sections?.includes(type)){content+=`<section><h3>${escape(label(type))} cases</h3><p>This section requires its own read permission.</p></section>`;continue;}
        const items=type==='sessions'?value.sessions??[]:type==='history'?value.history??[]:value.cases?.[type]??[];
        content+=detailSection(type,items,value.pages?.[type],0,id);
      }
      if(!value.pages&&Object.values(value.has_more??{}).some(Boolean))content+='<p class="live-notice">Some history or related records exceed this response limit. Use the corresponding current queue for its returned records.</p>';
    } else if(kind==='support'||kind==='uploads') {
      const value=await session.request(`/admin/${kind==='support'?'support-requests':'uploads'}/${requireId(id)}?limit=25${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
      record=value[kind==='support'?'support_request':'upload'];
      if(kind==='uploads'&&record)record={...record,attempts:value.attempts};
      if(!record||record.id!==id)throw new Error('invalid_response');
      const page=queuePage(value.page);
      content=facts(record,['id','account_id','owner_id','subject','details','status','category','revision','review_outcome','review_notes','created_at','updated_at','byte_size','content_type','width','height']);
      if(kind==='support') {
        if(!Array.isArray(value.history)||value.history.length>100)throw new Error('invalid_response');
        content+=`<section><h3>Decision history</h3>${value.history.map(item=>`<article>${facts(item,['action','actor_id','created_at','status','revision','review_outcome','review_notes'])}</article>`).join('')||'<p>No retained decisions returned.</p>'}<p class="live-status">History follows the operation retention and erasure policy. Retired receipts are not reconstructed.</p></section>`;
        const actions=['resolved','closed'].includes(record.status)?[]:['start','approve','reject','close'];
        if(actions.length&&permitted('support.review'))content+=reviewForm(kind,id,actions);
      } else {
        if(!Array.isArray(value.attempts)||value.attempts.length>100)throw new Error('invalid_response');
        content+='<p>Processing diagnostics contain metadata only. Private photographs are not opened in the operator workspace.</p>';
        content+=`<section><h3>Current diagnostics</h3>${facts(value.diagnostics??{},['observed_at','moderation_hold'])}</section>`;
        content+=`<section><h3>Processing attempts</h3>${value.attempts.map(item=>`<article>${facts(item,['id','status','source_version','model_version','captured_at','expires_at','completed_at','error_code','lease_until'])}<h4>Queue</h4>${facts(item.job??{},['state','attempts','handoff_count','available_at','completed_at','error_code','lease_until'])}<h4>Outbox</h4>${facts(item.outbox??{},['status','created_at','dispatched_at'])}<h4>Recovery</h4>${facts(item.recovery??{},['eligible','reason','maximum_daily_resumes'])}${item.recovery?.eligible&&permitted('uploads.recover')?button('processing-review','Resume original attempt',`data-asset="${escape(id)}" data-attempt="${escape(item.id)}"`):''}</article>`).join('')||'<p>No processing attempt is recorded for this upload.</p>'}</section>`;
      }
      if(kind==='uploads'&&permitted('operators.manage')) {
        const job=record.processing_diagnostics;
        if(/^[0-9a-f]{64}$/.test(job?.job_id??'')&&['failed','completed'].includes(job.job_state))
          content+=button('inspect-queue','Inspect work recovery',`data-job-id="${job.job_id}"`);
      }
      if(page.next_cursor)content+=button('detail-next',kind==='support'?'Next decisions':'Next attempts',`data-kind="${kind}" data-id="${escape(id)}"`);
      if(cursor)content+=button('detail-first','First history page',`data-kind="${kind}" data-id="${escape(id)}"`);
      // Published only after the same authority/navigation check as the detail.
      currentAudience={nextCursor:page.next_cursor,detailOnly:true};
    } else if(kind==='guardians') {
      content=facts(record,['id','child_account_id','guardian_account_id','state','revision','policy_version','requested_purposes','created_at','expires_at','reviewed_at','evidence_recorded']);
      content+='<p class="live-status">Verify the guardian’s adulthood and parental responsibility independently, using the operated review procedure. A face comparison, account declaration or relationship checkbox alone is insufficient. Record only an opaque review reference; do not upload documents or enter names, identity numbers, private links or biometric material here. Approval enables only the requested purposes, and never photo access.</p>';
      if(record.state==='under_review'&&permitted('guardian.review'))content+=`<form id="live-guardian-form" data-kind="guardians" data-id="${escape(id)}"><label class="live-field">Decision<select name="decision" required><option value="reject">Reject</option><option value="approve">Approve reviewed purposes</option></select></label><label class="live-field">Independent review method<select name="evidence_method" required><option value="independent_live_review">Independent live review</option><option value="independent_document_review">Independent document review</option></select></label><label class="live-field">Minimized review reference<input name="evidence_reference" required minlength="16" maxlength="128" pattern="[A-Za-z0-9._:-]{16,128}" autocomplete="off"></label><label class="live-consent"><input name="adult_verified" type="checkbox"><span>I independently verified that the guardian is an adult.</span></label><label class="live-consent"><input name="parental_responsibility_verified" type="checkbox"><span>I independently verified parental responsibility for this child.</span></label><label class="live-consent"><input type="checkbox" required><span>I reviewed this current request, its exact purposes and the independent evidence. I am neither the child nor guardian.</span></label><div class="live-actions"><button type="submit" class="primary">Apply reviewed decision</button></div></form>`;
      else content+='<p>No review action is available in this state. The guardian must claim a pending request before an independent review.</p>';
    } else {
      if(kind==='privacy') {
        const value=await session.request(`/privacy-requests/${requireId(id)}`);
        if(!value.privacy_request||value.privacy_request.id!==id)throw new Error('invalid_response');
        record=value.privacy_request;
      }
      content=facts(record,['id','account_id','subject_user_id','subject','details','reason','status','request_type','asset_id','candidate_id','owner_id','recipient_id','revision','version','failure_code','review_notes','review_outcome','outcome','created_at','updated_at','reviewed_at','completed_at','requested_by','reviewed_by','review_reason']);
      if(kind==='uploads') {
        content+='<p>Processing diagnostics contain metadata only. Private photographs are not opened in the operator workspace.</p>';
        content+=facts(record.processing_diagnostics??{},['attempt_id','attempt_status','attempt_error_code','attempt_captured_at','attempt_completed_at','attempt_lease_until','attempt_lease_expired','outbox_status','outbox_dispatched_at','job_state','job_attempts','job_error_code','job_available_at','job_lease_until','job_lease_expired','job_completed_at','transfer_status','transfer_error_code','transfer_lease_until','transfer_lease_expired']);
        const job=record.processing_diagnostics;
        if(/^[0-9a-f]{64}$/.test(job?.job_id??'')&&['failed','completed'].includes(job.job_state))content+=button('inspect-queue','Inspect work recovery',`data-job-id="${job.job_id}"`);
      }
      else {
        if(kind==='privacy') {
          const diagnostics=record.diagnostics??record;
          content+=`<section><h3>Execution diagnostics</h3>${facts(diagnostics,['legal_hold','execution_lease_until','execution_lease_expired','metadata_erased_at'])}<h4>Private object cleanup</h4>${facts(diagnostics.cleanup??{},['total','pending','failed','verified'])}<h4>Recorded holds</h4>${facts(diagnostics.holds??{},['global_retention','moderation','assets','requests'])}</section>`;
          content+=facts(diagnostics.queue??{},['state','attempts','error_code']);
          if(permitted('operators.manage')&&/^[0-9a-f]{64}$/.test(diagnostics.queue?.job_id??'')&&['failed','completed'].includes(diagnostics.queue.state))content+=button('inspect-queue','Inspect work recovery',`data-job-id="${diagnostics.queue.job_id}"`);
          content+=detailSection('history',record.history??[],record.history_page);
          nextDetail={type:'privacy',id,pages:{history:record.history_page},positions:{history:{cursors:[null],index:0}}};
        }
        const actions=kind==='support'?['start','approve','reject','close']:kind==='privacy'?(['pending_approval'].includes(record.status)?['approve','reject']:['approved','queued','failed','processing'].includes(record.status)?['process']:[]):kind==='match'?['approve','reject','escalate','delete','audit']:['hold','release','resolve','reject'];
        if(permitted(kind==='privacy'?'privacy.review':kind==='support'?'support.review':'safety.review'))content+=`<form id="live-review-form" data-kind="${escape(kind)}" data-id="${escape(id)}"><label class="live-field">Decision<select name="decision" required>${actions.map(action=>`<option value="${action}">${escape(label(action))}</option>`).join('')}</select></label><label class="live-field">Review note<textarea name="reason" required minlength="3" maxlength="1000" placeholder="Record the basis for this decision"></textarea></label><p class="live-status">Independent approval and current revisions are checked by the server. A match decision creates no recipient photo access. Processing an approved deletion permanently removes its eligible account data and private media.</p><label class="live-consent"><input name="confirmed" type="checkbox" required><span>I reviewed this current record and confirm the selected action.</span></label><div class="live-actions">${actions.length?'<button type="submit" class="primary">Apply decision</button>':'<p>No current action is available.</p>'}</div></form>`;
      }
    }
    observeDetailClosure();if(!currentDetail(request))return;
    detailAudience=currentAudience?.detailOnly?null:currentAudience;detailCursor=currentAudience?.detailOnly?currentAudience.nextCursor:null;
    accountDetail=nextDetail;queueRepair=nextQueueRepair;
    detailRecord={kind,record,row:record,id,generation,account:session.operator?.user_id};
    draftContext={kind,id,version:JSON.stringify([record.id,record.revision??null,record.version??null,record.status??record.state??null,record.updated_at??null,record.reviewed_at??null,record.completed_at??null,currentAudience?.version??null])};
    detail.innerHTML=`<div class="live-detail"><div class="live-close">${button('close-detail','×','aria-label="Close record"')}</div><h2 id="detail-title">${escape(kind==='users'?(record.name||'Account'):kind==='support'?record.subject:label(kind))}</h2>${content}</div>`;
    for(const form of detail.querySelectorAll?.('form')??[])addDraftRestore(form);
    if(!detail.open)detail.showModal();displayedDetail=request;detail.querySelector('button')?.focus();
  }
  function validQueuePreview(value,jobID){return value&&value.job_id===jobID&&/^[0-9a-f]{64}$/.test(value.fingerprint??'')&&
    ['photo','privacy','notification'].includes(value.category)&&typeof value.eligible==='boolean'&&
    (!value.eligible||value.action==='resume_exact_work'&&UUID.test(value.domain_id??''));}
  function queueRecoverySection(value){
    const form=value.eligible?`<p>The server confirmed that the original approved work can resume from its recorded state. Its current permissions and exact input will be checked again.</p><form id="live-queue-repair-form"><label class="live-field">Reason for resuming<textarea name="reason" required minlength="3" maxlength="1000"></textarea></label><label class="live-consent"><input type="checkbox" required><span>I reviewed this work and want to resume the same original request.</span></label><div class="live-actions"><button type="submit" class="primary">Resume original work</button></div></form>`:`<p role="status">This work cannot be resumed safely from its current state. Refresh its status or follow the recorded recovery procedure.</p>${facts(value,['blocked_reason'])}`;
    return `<section id="queue-repair-section"><h3 tabindex="-1">Work recovery</h3>${facts(value,['category','domain_id','queue_state','domain_status','attempts','error_code'])}${form}</section>`;
  }
  async function inspectQueue(jobID){
    if(!permitted('operators.manage'))throw new Error('operator_capability_required');
    const current=detailRecord,own=generation,account=session.operator?.user_id;
    if(!current||!detail.open||!['uploads','privacy'].includes(current.kind)||!/^[0-9a-f]{64}$/.test(jobID??''))throw new Error('invalid_record');
    const source=current.kind==='uploads'?current.row.processing_diagnostics:(current.row.diagnostics??current.row).queue;
    const expectedDomain=current.kind==='uploads'?source?.attempt_id:current.id;
    if(source?.job_id!==jobID)throw new Error('invalid_record');
    const value=(await session.request('/admin/queue-repairs/'+jobID)).queue_repair;
    if(own!==generation||account!==session.operator?.user_id||detailRecord!==current||document.hidden||!detail.open)return;
    if(!validQueuePreview(value,jobID)||value.domain_id!==expectedDomain||value.category!==(current.kind==='uploads'?'photo':'privacy'))throw new Error('invalid_response');
    queueRepair=value;detail.querySelector('#queue-repair-section')?.remove();
    detail.querySelector('.live-detail')?.insertAdjacentHTML('beforeend',queueRecoverySection(value));
    const saved=detail.querySelector('#live-queue-repair-form');if(saved)addDraftRestore(saved);
    detail.querySelector('#queue-repair-section h3')?.focus();
  }
  async function apply(intent) {
    if(!online())throw new Error('offline');
    const own=generation,account=session.operator?.user_id;
    try{await session.action(intent.path,intent.body);}
    catch(problem){if(['operation_recovered_without_result','operation_retired_by_recovery'].includes(problem?.code)&&own===generation&&account===session.operator?.user_id){closeDetail();data=null;}throw problem;}
    if(own!==generation||account!==session.operator?.user_id)return;
    for(const form of detail.querySelectorAll?.('form')??[]){const scope=draftScope(form);if(scope)await drafts.remove(scope);}
    notice='The server confirmed this operation. Current records have been refreshed.';closeDetail();data=null;
  }
  document.addEventListener('input',event=>{
    const form=event.target.closest?.('form'),scope=draftScope(form);if(!scope||busy||!detail.open||document.hidden)return;
    const own=generation;
    drafts.save(scope,draftFields(form)).then(saved=>{
      if(!saved||own!==generation||!detail.open||!session.operator)return;
      let status=form.querySelector('[data-draft-save-status]');
      if(!status){form.insertAdjacentHTML('beforeend','<p class="live-status" data-draft-save-status role="status"></p>');status=form.querySelector('[data-draft-save-status]');}
      const text=drafts.storage?'Unsent notes saved in this browser.':'Unsent notes saved for this tab only.';if(status&&status.textContent!==text)status.textContent=text;
    }).catch(()=>{if(own!==generation||!session.operator)return;notice='Unsent notes could not be saved securely. Keep this record open until you finish or copy your own notes to an approved secure location.';render();});
  });
  detail.addEventListener('cancel',event=>{event.preventDefault();closeDetail();});
  detail.addEventListener('close',()=>{if(displayedDetail&&!detail.open)closeDetail();});
  $('.skip-link')?.addEventListener('click',event=>{event.preventDefault();main.focus();});
  document.addEventListener('submit',event=>{
    const form=event.target;if(!['live-review-form','live-session-form','live-guardian-form','live-adult-form','live-operator-open-form','live-operator-form','live-processing-form','live-queue-repair-form'].includes(form.id))return;event.preventDefault();
    if(busy||session.state?.pendingAction||!form.reportValidity())return;
    const fields=new window.FormData(form),reason=fields.get('reason');let intent;
    try {if(form.id==='live-operator-open-form'){const id=requireId(fields.get('account_id'));openDetail('operators',id);return;}
      if(form.id==='live-operator-form'){const row=selected('operators',form.dataset.id),capabilities=capabilitySelection(fields.getAll('capabilities'));if(!row||!Number.isSafeInteger(row.revision))throw new Error('invalid_revision');if(typeof reason!=='string'||reason.trim().length<3)throw new Error('review_reason_required');intent={path:`/admin/operators/${requireId(row.id)}/capabilities`,body:{capabilities,expires_at:capabilities.length?new Date(fields.get('expires_at')+'Z').toISOString():null,expected_revision:row.revision,reason:reason.trim(),operation_key:crypto.randomUUID()}};}
      else if(form.id==='live-processing-form'){const row=selected('uploads',form.dataset.id),attempt=row?.attempts?.find(item=>item.id===form.dataset.attempt);if(!attempt?.recovery?.eligible)throw new Error('operator_recovery_revision_changed');if(typeof reason!=='string'||reason.trim().length<3)throw new Error('review_reason_required');intent={path:`/admin/uploads/${requireId(row.id)}/attempts/${requireId(attempt.id)}/resume`,body:{expected_revision:attempt.recovery.expected_revision,reason:reason.trim(),operation_key:crypto.randomUUID()}};}
      else if(form.id==='live-queue-repair-form'){if(!permitted('operators.manage')||!detailRecord||detailRecord.generation!==generation||detailRecord.account!==session.operator?.user_id)throw new Error('queue_repair_snapshot_changed');intent=queueRepairIntent(queueRepair,reason,crypto.randomUUID());}
      else if(form.id==='live-adult-form'){if(detailAudience?.accountId!==form.dataset.id)throw new Error('audience_record_changed');intent=adultReviewIntent(detailAudience,fields,crypto.randomUUID());}
      else intent=form.id==='live-guardian-form'?guardianReviewIntent(selected('guardians',form.dataset.id),fields,crypto.randomUUID()):reviewIntent(form.dataset.kind,form.id==='live-session-form'?{id:form.dataset.id}:selected(form.dataset.kind,form.dataset.id),fields.get('decision'),reason,crypto.randomUUID());}
    catch(problem){error=message(problem);render();return;}
    task(()=>apply(intent)).then(()=>{if(!error&&session.operator)load();});
  });
  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-live],[data-action],a.skip-link');if(!target)return;
    if(target.matches?.('a.skip-link')){event.preventDefault();main.focus();return;}
    const action=target.dataset.live??target.dataset.action;
    if(['login','enroll','recover-enrollment','restart-enrollment','recover-audience','renew-audience'].includes(action)){authenticate(action);return;}
    if(action==='shutter'){task(shutter,{rerender:false}).then(()=>{if(error)render();});return;}
    if(action==='retake'){stopCamera();task(camera,{rerender:false}).then(()=>{if(error)render();});return;}
    if(action==='resume-camera'){task(camera,{rerender:false}).then(()=>{if(error)render();});return;}
    if(action==='cancel-camera'){stopCamera();session.cancelCapture();restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};render();return;}
    if(action==='use-photo') {
      if(!review||busy)return;const bytes=review;review=null;const own=cameraGeneration;
      task(async()=>{try{await session.useCapture(bytes);}finally{bytes.fill(0);stopCamera();}if(session.captures.length===session.challenge.required_captures)await session.complete();},{rerender:false}).then(async()=>{bytes.fill(0);if(error){render();return;}if(own+1!==cameraGeneration)return;if(session.operator){await load();return;}if(session.challenge){await task(camera,{rerender:false});if(error)render();}else render();});return;
    }
    if(action==='refresh'){load();return;}
    if(action==='next-page'||action==='more-users'){if(!busy&&data?.page?.next_cursor)load({cursor:data.page.next_cursor,index:pageIndex+1});return;}
    if(action==='previous-page'){if(!busy&&pageIndex>0)load({cursor:pageCursors[pageIndex-1],index:pageIndex-1});return;}
    if(action==='first-page'){if(!busy)load();return;}
    if(action==='safety-reports'||action==='safety-matches'){changeQuery({filter:'all',collection:action==='safety-matches'?'matches':'reports'});return;}
    if(action==='detail'){detailOrigin={element:target,generation};openDetail(target.dataset.kind,target.dataset.id);return;}
    if(action==='detail-next'||action==='detail-first'){
      const cursor=action==='detail-next'?detailCursor:null;
      if(action==='detail-next'&&!cursor)return;
      openDetail(target.dataset.kind,target.dataset.id,cursor);return;
    }
    if(action==='processing-review'){
      if(!permitted('uploads.recover'))return;const row=selected('uploads',requireId(target.dataset.asset)),attempt=row?.attempts?.find(item=>item.id===target.dataset.attempt);if(!attempt?.recovery?.eligible)return;
      detail.querySelector('#live-processing-form')?.remove();detail.querySelector('.live-detail').insertAdjacentHTML('beforeend',`<form id="live-processing-form" data-id="${escape(row.id)}" data-attempt="${escape(requireId(attempt.id))}"><h3>Resume this original processing attempt</h3><p>The server rechecks the owner's session, consent, source, model, active leases, holds and unresolved writes. This schedules work; it does not confirm delivery or create photo access.</p><label class="live-field">Reason<textarea name="reason" required minlength="3" maxlength="1000"></textarea></label><label class="live-consent"><input type="checkbox" required><span>I reviewed the current diagnostics and exact attempt.</span></label><button type="submit" class="primary">Resume original attempt</button></form>`);return;
    }
    if(action==='inspect-queue'){task(()=>inspectQueue(target.dataset.jobId),{rerender:false});return;}
    if(action==='detail-page'){task(()=>loadDetailSection(target.dataset.section,target.dataset.direction),{rerender:false});return;}
    if(action==='restore-draft'){task(()=>restoreDraft(target.dataset.form),{rerender:false});return;}
    if(action==='discard-draft'){
      if(busy||!['live-review-form','live-session-form','live-guardian-form','live-adult-form','live-queue-repair-form'].includes(target.dataset.form))return;
      const form=detail.querySelector('#'+target.dataset.form),scope=draftScope(form);
      if(scope){task(async()=>{await drafts.remove(scope);form.querySelector('[data-draft-notice]')?.remove();},{rerender:false});}return;
    }
    if(action==='session-review') {
      if(!permitted('users.sessions.revoke'))return;
      detail.querySelector('#live-session-form')?.remove();
      detail.querySelector('.live-detail').insertAdjacentHTML('beforeend',`<form id="live-session-form" data-kind="session" data-id="${escape(requireId(target.dataset.account))}" data-session-version="${escape(target.dataset.sessionVersion??'')}"><h3>Revoke this session</h3><input type="hidden" name="decision" value="${escape(requireId(target.dataset.session))}"><label class="live-field">Reason<textarea name="reason" required minlength="3" maxlength="1000"></textarea></label><label class="live-consent"><input type="checkbox" required><span>This session will lose access immediately. The server protects self-management and the last administrator.</span></label><div class="live-actions"><button type="submit" class="primary">Revoke session</button></div></form>`);addDraftRestore(detail.querySelector('#live-session-form'));detail.querySelector('#live-session-form textarea').focus();return;
    }
    if(action==='retry-action'){const pending=session.state?.pendingAction;if(!pending)return;task(()=>apply(pending)).then(()=>{if(!error&&session.operator)load();});return;}
    if(action==='close-detail'){closeDetail();return;}
    if(action==='logout'){
      // Logout is a cancellation boundary and must never wait for the busy gate.
      taskGeneration++;const draftCleanup=drafts.discard();clearPrivate();busy=false;error='';notice='';
      $('#navigation-dialog').close();
      const own=generation,revocation=session.logout();
      restored={registered:!!session.state?.reference,pending:!!session.state?.enrollment};render();if(!document.hidden)main.focus();
      draftCleanup.catch(()=>{if(own!==generation)return;notice='Signed out. Browser storage could not confirm removal of saved notes; clear this site’s private browser data before sharing the browser profile.';render();});
      revocation.catch(()=>{if(own!==generation)return;notice='Signed out on this browser. The server revocation could not be confirmed; verify your face to reconnect.';render();});return;
    }
    if(action==='menu'){$('#navigation-dialog').showModal();return;}
    if(action==='close-menu'){$('#navigation-dialog').close();$('.mobile-menu').focus();return;}
    if(action==='install'){
      const prompt=installPrompt;if(!prompt)return;installPrompt=null;$('#install-button').hidden=true;$('#mobile-install-button').hidden=true;
      $('#navigation-dialog').close();if(!document.hidden)main.focus();
      const failed=()=>{notice='The installation prompt could not open. Use this browser’s installation menu if available.';render();};
      try{Promise.resolve(prompt.prompt()).catch(failed);}catch{failed();}return;
    }
    if(action==='about'){$('#navigation-dialog').close();notice='Operator roles require independent provisioning. Face sign-in grants authentication only. Support, privacy and moderation decisions remain server-authorized; downloaded copies cannot be revoked by this workspace.';render();if(!document.hidden)main.focus();return;}
    if(action==='activate-update'){if(session.state?.pendingAction||session.state?.pendingAudience){notice='Reconcile the saved action or eligibility operation before updating.';render();return;}waitingWorker?.postMessage({type:'ACTIVATE_UPDATE'});return;}
    if(action==='clear-search'){$('#search').value='';$('#search').dispatchEvent(new window.Event('input',{bubbles:true}));}
  });
  function changeQuery(change) {
    const next={...state,...change},params=new URLSearchParams();
    if(next.route==='queue-recovery'&&next.sort==='oldest')params.set('sort','oldest');if(next.q)params.set('q',next.q);if(next.filter!=='all')params.set('filter',next.filter);
    if(next.route==='match-reports'&&next.collection==='matches')params.set('collection','matches');
    window.location.hash=next.route+(params.size?'?'+params:'');
  }
  $('#search').addEventListener('input',event=>{clearTimeout(searchTimer);const q=event.target.value.slice(0,100),own=generation;searchTimer=window.setTimeout(()=>{if(own===generation)changeQuery({q});},300);});
  document.addEventListener('change',event=>{if(event.target.id==='live-status-filter')changeQuery({filter:event.target.value});if(event.target.id==='live-sort')changeQuery({sort:event.target.value});});
  window.addEventListener('hashchange',()=>{clearTimeout(searchTimer);state=parseRoute(window.location.hash);closeDetail();$('#navigation-dialog').close();notice='';generation++;if(session.operator)load();else render();main.focus();});
  window.addEventListener('offline',()=>{clearPrivate();busy=false;notice='Offline. Reconnect to load current records.';render();});
  window.addEventListener('online',()=>{if(session.operator)load();else render();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearPrivate();busy=false;main.innerHTML='<p class="live-status">Private workspace paused.</p>';}else if(session.operator)load();else render();});
  window.addEventListener('pagehide',()=>{drafts.suspend();clearPrivate();busy=false;});
  window.addEventListener('storage',event=>{if(drafts.storage&&event.key===drafts.storage.markerKey&&!drafts.storage.current()){drafts.suspend();clearPrivate();busy=false;notice='Saved notes were cleared or the operator changed in another tab. Refresh current records before continuing.';render();}});
  $('#navigation-dialog').addEventListener('cancel',event=>{event.preventDefault();$('#navigation-dialog').close();if(!document.hidden)$('.mobile-menu').focus();});
  window.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!detail.open&&!$('#navigation-dialog').open&&!$('#search').disabled){event.preventDefault();$('#search').focus();}});
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('#install-button').hidden=false;$('#mobile-install-button').hidden=false;});
  window.addEventListener('appinstalled',()=>{installPrompt=null;$('#install-button').hidden=true;$('#mobile-install-button').hidden=true;});
  $('#install-button').hidden=true;
  if('serviceWorker'in navigator)navigator.serviceWorker.register('/admin/sw.js',{scope:'/admin/'}).then(registration=>{
    const update=()=>{if(!registration.waiting)return;waitingWorker=registration.waiting;notice='A workspace update is ready. Finish or reconcile current work before refreshing.';if(!session.challenge)render();};update();registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',update));
    navigator.serviceWorker.addEventListener('controllerchange',()=>window.location.reload());
  }).catch(()=>{});
  render();await task(async()=>{restored=await session.restore();});
  return {refresh:load};
}
