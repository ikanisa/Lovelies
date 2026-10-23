import { createDemoStore } from './demo-store.mjs';
import {filters, statusLabels, needsAttention as isAttention, matchesFilter, filterUsers, decisionLabel} from './view-model.mjs';

import {renderOverview as overviewView, renderCollection as collectionView, renderUsers as usersView} from './collection-views.mjs';
import {renderUserDetail as userDetailView, renderCaseDetail as caseDetailView} from './detail-views.mjs';

let store = createDemoStore();
const icons = {
  overview:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2M19 3a4 4 0 0 1 0 8"/>',
  safety:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="M12 8v5m0 3h.01"/>',
  privacy:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  support:'<path d="M4 13v-2a8 8 0 0 1 16 0v2m-1 5c0 3-3 3-5 3"/><rect x="2" y="11" width="4" height="7" rx="2"/><rect x="18" y="11" width="4" height="7" rx="2"/><path d="M11 21h3"/>',
  upload:'<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 5"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  arrowUp:'<path d="M6 18 18 6M6 6h12v12"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.9.4-1.1 1-1.1 1.8m0 3h.01"/>',
  reset:'<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  sort:'<path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  back:'<path d="m14 5-7 7 7 7"/>',
  alert:'<path d="m12 3 10 18H2zM12 9v5m0 3h.01"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  stack:'<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.overview}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const routes = {
  overview:{label:'Overview',icon:'overview',description:'A little clarity for the work that matters.'},
  users:{label:'Users',icon:'user',description:'Find an account, review its cases and manage access.'},
  'match-reports':{label:'Match reports',icon:'safety',kind:'safety',description:'Review incorrect photo matches and their access impact.'},
  privacy:{label:'Privacy',icon:'privacy',kind:'privacy',description:'Handle every account request with care.'},
  support:{label:'Support',icon:'support',kind:'support',description:'Help people get back to their photographs.'},
  uploads:{label:'Uploads',icon:'upload',kind:'upload',description:'Track processing and investigate upload issues.'},
};
const kindLabels = {user:'User',safety:'Match report',privacy:'Privacy request',support:'Support request',upload:'Upload'};
const dateFormat = new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',timeZone:'Africa/Kigali'});
const timeFormat = new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Africa/Kigali'});
const shortDate = date => dateFormat.format(new Date(date));
const shortTime = date => timeFormat.format(new Date(date));
const main = document.querySelector('#main');
const detail = document.querySelector('#detail-dialog');
const utility = document.querySelector('#utility-dialog');
const navigationDialog = document.querySelector('#navigation-dialog');
const searchInput = document.querySelector('#search');
let currentId = null;
let currentUserId = null;
let currentRevision = null;
let detailSequence = [];
let detailTrail = [];
let detailType = null;
let recoveryTarget = null;
const revokeDrafts = {};
let detailOrigin = null;
let pendingRevocation = null;
let toastTimer;
let pendingInstall = null;
let waitingRegistration = null;
let updating = false;
let state = readRoute();
const routeState = {};
let memoryOnlyChanges = false;
let drafts = {};
let draftStorage = true;
try { const saved = JSON.parse(localStorage.getItem('lovelies-admin-preview-drafts-v1') || '{}'); if (saved && !Array.isArray(saved) && typeof saved === 'object') for (const [id,note] of Object.entries(saved)) if (store.records().some(row=>row.id===id) && typeof note === 'string' && note.length <= 1000) drafts[id]=note; } catch { draftStorage = false; }

function readRoute() {
  const [rawId,query=''] = location.hash.slice(1).split('?');
  const id=rawId==='safety'?'match-reports':rawId;
  const params = new URLSearchParams(query);
  const route=routes[id]?id:'overview';
  return {route,missing:!!rawId&&!routes[id],q:(params.get('q')||'').slice(0,200),filter:(params.get('q')&&route!=='users'?filters.overview:filters[route]).some(([key])=>key===params.get('filter'))?params.get('filter'):'all',sort:['oldest','name'].includes(params.get('sort'))?params.get('sort'):'priority',expanded:params.get('view')==='queue'};
}
function routeURL(next) {
  const params = new URLSearchParams();
  if(next.q)params.set('q',next.q);
  if(next.filter!=='all')params.set('filter',next.filter);
  if(next.sort!=='priority')params.set('sort',next.sort);
  if(next.expanded)params.set('view','queue');
  return `#${next.route}${params.size?'?'+params:''}`;
}
function setState(values,{replace=false,focus=false}={}) {
  if(values.q&&!state.q)routeState[state.route]={filter:state.filter,sort:state.sort,expanded:state.expanded};
  state={...state,...values,missing:false};
  history[replace?'replaceState':'pushState'](null,'',routeURL(state));
  render();
  if(focus)main.focus({preventScroll:true});
}
function navHTML() {
  const metrics = store.metrics();
  const counts={'match-reports':metrics.safetyOpen,privacy:metrics.privacyPending,support:metrics.supportOpen};
  return Object.entries(routes).map(([id,route])=>`<a class="nav-link" href="#${id}" data-route="${id}" ${!state.missing&&state.route===id?'aria-current="page"':''}>${icon(route.icon)}<span>${route.label}</span>${counts[id]?`<span class="nav-count" aria-label="${counts[id]} awaiting review">${counts[id]}</span>`:''}</a>`).join('');
}
function updateShell() {
  const nav=navHTML();
  document.querySelector('#navigation').innerHTML=nav;
  document.querySelector('#mobile-navigation').innerHTML=nav+`<div class="mobile-utilities"><button class="utility-link" data-action="install">${icon('download')}<span>Install app</span></button><button class="utility-link" data-action="about">${icon('help')}<span>About this preview</span></button><button class="utility-link" data-action="reset">${icon('reset')}<span>Reset sample workspace</span></button></div>`;
  document.querySelector('#breadcrumb').textContent=state.missing?'Page not found':routes[state.route].label;
  document.title=`${state.missing?'Page not found':state.q?'Search':routes[state.route].label} · Lovelies Admin`;
  searchInput.value=state.q;
  document.querySelector('.search-clear').hidden=!state.q;
  document.querySelector('.global-search kbd').hidden=!!state.q;
  searchInput.placeholder=state.route==='users'?'Search users…':'Search workspace…';
  searchInput.setAttribute('aria-label',state.route==='users'?'Search sample users':'Search sample workspace');
  document.querySelector('#storage-note').textContent=store.storageStatus==='memory'?'Changes kept for this visit only':store.storageStatus==='recovered'?'Sample workspace restored':'Changes saved on this device';
}
function statusBadge(row) {return `<span class="badge ${escape(row.reviewOutcome==='rejected'?'rejected':row.status)}">${escape(row.reviewOutcome==='rejected'?'Rejected':statusLabels[row.status]||row.status)}</span>`;}
function sorted(rows) {return [...rows].sort((a,b)=>state.sort==='oldest'?Date.parse(a.createdAt)-Date.parse(b.createdAt):(Number(b.priority==='high')-Number(a.priority==='high')||Date.parse(b.createdAt)-Date.parse(a.createdAt)));}
function scopedRows() {
  let rows=store.records();
  if(state.q) {const q=state.q.toLocaleLowerCase();rows=rows.filter(row=>[row.title,row.subtitle,row.id,row.kind,row.accountId,row.reviewOutcome,statusLabels[row.status]].join(' ').toLocaleLowerCase().includes(q));}
  else if(routes[state.route].kind) rows=rows.filter(row=>row.kind===routes[state.route].kind);
  return rows;
}
function filteredRows() {return sorted(scopedRows().filter(row=>matchesFilter(row,state.filter)));}
function sharedViewContext() {return {icon,escape,statusLabels,shortDate,shortTime,statusBadge,userAvatar,kindLabels};}
function collectionContext() {return {...sharedViewContext(),state,records:store.records(),users:store.users(),activity:store.activity(),metrics:store.metrics(),filters,filterUsers,matchesFilter,needsAttention:isAttention,decisionLabel,routes};}
function renderOverview() {return overviewView(collectionContext());}
function renderList() {return collectionView({...collectionContext(),baseRows:scopedRows(),rows:filteredRows(),userMatches:state.q&&state.filter==='all'?filterUsers(store.users(),{q:state.q}):[]});}
function renderUsers() {return usersView(collectionContext());}
function userAvatar(user) {
  const initials=user.status==='deleted'?'–':user.name.trim().split(/\s+/).filter(Boolean).slice(0,2).map(part=>Array.from(part)[0]).join('').toLocaleUpperCase();
  return `<span class="user-initials" aria-hidden="true">${escape(initials)}</span>`;
}

function historyFor(id) {return store.activity().filter(item=>item.recordId===id).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));}
function prepareDetail(type,id,{navigation=false,fromTrail=false}={}) {
  if(!detail.open) {
    detailOrigin=type==='user'?`[data-user="${id}"]`:`[data-open="${id}"]`;
    detailSequence=[...new Set([...main.querySelectorAll(type==='user'?'[data-user]':'[data-open]')].map(node=>type==='user'?node.dataset.user:node.dataset.open))];
    detailTrail=[];
  } else if(type!==detailType&&!navigation&&!fromTrail) {
    detailTrail.push({type:detailType,id:currentUserId||currentId,sequence:[...detailSequence]});
    detailSequence=type==='case'&&currentUserId?store.records().filter(row=>row.accountId===currentUserId).map(row=>row.id):[id];
  }
  if(!detailSequence.includes(id))detailSequence=[id];
  detailType=type;
  const index=detailSequence.indexOf(id);
  const prior=detailTrail.at(-1);
  return {position:{index:index+1,total:detailSequence.length,previous:index>0,next:index<detailSequence.length-1},backLabel:prior?(prior.type==='user'?'Back to account':'Back to case'):null};
}
function stepDetail(step) {
  const index=detailSequence.indexOf(currentUserId||currentId),id=detailSequence[index+step];
  if(id)(detailType==='user'?openUser:openDetail)(id,{navigation:true});
}
function backDetail() {
  const prior=detailTrail.pop();if(!prior)return;
  detailSequence=prior.sequence;
  (prior.type==='user'?openUser:openDetail)(prior.id,{fromTrail:true});
}
function openUser(id,options={}) {
  const user=store.user(id);if(!user)return;
  const navigation=prepareDetail('user',id,options);
  currentId=null;currentUserId=id;currentRevision=user.revision;
  detail.innerHTML=userDetailView({...sharedViewContext(),user,cases:store.records().filter(row=>row.accountId===id),events:historyFor(id),sessionDrafts:Object.fromEntries(Object.entries(revokeDrafts).filter(([key])=>key.startsWith(`${id}:`)).map(([key,value])=>[key.slice(id.length+1),value])),...navigation});
  if(!detail.open)detail.showModal();detail.querySelector('[data-action="close-detail"]').focus({preventScroll:true});
  detail.scrollTop=0;
}
function confirmRevocation(sessionId) {
  const user=store.user(currentUserId),session=user?.sessions.find(item=>item.id===sessionId);
  if(!session)return;
  pendingRevocation={userId:user.id,sessionId,revision:user.revision};
  const key=`${user.id}:${sessionId}`;
  showUtility('Revoke this session?',`<p>This ends access from the selected session. The account and photographs remain intact.</p><dl class="confirmation-summary"><div><dt>Account</dt><dd>${escape(user.name)}<small>${escape(user.id)}</small></dd></div><div><dt>Device</dt><dd>${escape(session.device||'Registered device')}</dd></div><div><dt>Session</dt><dd class="reference-value">${escape(session.id)}</dd></div><div><dt>Last active</dt><dd>${escape(shortDate(session.lastSeenAt||session.createdAt))}, ${escape(shortTime(session.lastSeenAt||session.createdAt))} CAT</dd></div></dl><div class="review-form"><label for="revoke-note">Reason</label><textarea id="revoke-note" minlength="3" maxlength="1000" placeholder="Record why this session should end…" aria-describedby="revoke-hint revoke-error">${escape(revokeDrafts[key]||'')}</textarea><p id="revoke-hint" class="field-hint">At least 3 characters. Kept while this preview is open.</p><p id="revoke-error" class="form-error" role="alert" hidden></p></div><p class="field-hint">Sample action only. The user would need to verify again to sign in.</p>`,`<button class="button secondary" data-action="close-utility">Cancel</button><button class="button danger" data-action="confirm-revoke-session">${icon('privacy')}Revoke session</button>`);
}
function showActionError(error,selector,target) {
  const message=document.querySelector(selector);message.hidden=false;
  const stale=['stale_revision','stale_state'].includes(error.code);
  recoveryTarget=stale?target:null;
  message.innerHTML=`<span>${escape(error.message)}</span>${stale?'<span class="recovery-copy">Your reason is kept. Review the latest state before deciding again.</span><button class="button secondary small recovery-action" type="button" data-action="review-latest">Review latest</button>':''}`;
  if(stale)message.querySelector('button').focus();else document.querySelector(selector==='#revoke-error'?'#revoke-note':'#review-note')?.focus();
}
function reviewLatest() {
  const target=recoveryTarget;if(!target)return;
  store=createDemoStore();render();recoveryTarget=null;
  if(target.type==='session') {
    if(utility.open)utility.close();
    openUser(target.userId,{restoreFocus:true});
    showToast('Latest account loaded. Review its sessions before making another change.');
  } else {
    openDetail(target.id,{restoreFocus:true});
    showToast('Latest case loaded. Your note is kept; no decision was repeated.');
  }
}
function revokeSession() {
  if(!pendingRevocation)return;
  try {
    const result=store.revokeUserSession(pendingRevocation.userId,pendingRevocation.sessionId,document.querySelector('#revoke-note').value,{expectedRevision:pendingRevocation.revision});
    memoryOnlyChanges=!result.persisted;
    delete revokeDrafts[`${pendingRevocation.userId}:${pendingRevocation.sessionId}`];
    utility.close();render();openUser(pendingRevocation.userId,{restoreFocus:true});pendingRevocation=null;updateBanner();
    showToast(result.persisted?'Sample session revoked.':'Sample session revoked for this visit. Device storage is unavailable.');
  } catch(error) {showActionError(error,'#revoke-error',{type:'session',userId:pendingRevocation.userId});}
}
function missingPage() {return `<section class="empty-state missing-page">${icon('help')}<h1>This page isn’t available</h1><p>The link may be incomplete or out of date. Your sample workspace is still available.</p><a class="button primary" href="#overview" data-route="overview">Back to overview ${icon('arrow')}</a></section>`;}
function render() {updateShell();main.innerHTML=state.missing?missingPage():state.route==='users'?renderUsers():state.route==='overview'&&!state.q&&!state.expanded?renderOverview():renderList();}
function saveDraft(id,note) {
  if(note)drafts[id]=note;else delete drafts[id];
  try{localStorage.setItem('lovelies-admin-preview-drafts-v1',JSON.stringify(drafts));draftStorage=true;}catch{draftStorage=false;}
  updateBanner();
  const count=document.querySelector('#note-count');if(count)count.textContent=`${note.length} / 1,000`;
  const hint=document.querySelector('#draft-hint');if(hint)hint.textContent=draftStorage?'Sample note saved on this device.':'Note kept for this visit only. Device storage is unavailable.';
}
function actionsFor(row) {
  if(!['open','pending','pending_approval','under_review'].includes(row.status))return [];
  if(row.kind==='privacy')return [['approve','Approve request','primary'],['reject','Reject','secondary']];
  if(row.kind==='safety')return [...(row.status==='open'?[['hold','Place on hold','primary']]:[]),['resolve','Resolve report',row.status==='open'?'secondary':'primary'],['reject','Reject','secondary']];
  if(row.kind==='support')return [...(row.status==='open'?[['start','Start review','secondary']]:[]),['resolve','Resolve request','primary'],['reject','Reject','secondary']];
  return [];
}
function openDetail(id,options={}) {
  const row=store.records().find(item=>item.id===id);if(!row)return;
  const navigation=prepareDetail('case',id,options);
  currentId=id;currentUserId=null;currentRevision=row.revision;
  detail.innerHTML=caseDetailView({...sharedViewContext(),row,events:historyFor(id),actions:actionsFor(row),note:drafts[id]||'',draftStorage,...navigation});
  if(!detail.open)detail.showModal();detail.querySelector('[data-action="close-detail"]').focus({preventScroll:true});
  detail.scrollTop=0;
}
function showToast(message) {const toast=document.querySelector('#toast');toast.innerHTML=`<span class="toast-icon">${icon('info')}</span><span class="toast-message">${escape(message)}</span>`;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.hidden=true,4500);}
function showUtility(title,body,actions='') {if(navigationDialog.open)navigationDialog.close();utility.innerHTML=`<div class="dialog-head"><h2 id="utility-title">${escape(title)}</h2><button class="icon-button" data-action="close-utility" aria-label="Close dialog">${icon('close')}</button></div>${body}${actions?`<div class="decision-actions">${actions}</div>`:''}`;utility.showModal();utility.scrollTop=0;utility.querySelector('[data-action="close-utility"]').focus({preventScroll:true});}
function showAbout() {showUtility('Made for a little clarity.',`<img class="brand-image" src="/shared/assets/wordmark.png" alt="Lovelies" width="144" height="80"><p>A working design preview of the Lovelies admin workspace. Search, filter, review a request, and try a decision.</p><p>All records are sample data. Your notes and decisions stay on this device. No live accounts, photos, or Cloudflare services are changed.</p><p>Live access will use Lovelies’ registered-face administrator session. There is no password or OTP sign-in in this preview.</p><section class="keyboard-help"><h3>Keyboard shortcuts</h3><dl><div><dt><kbd>⌘ / Ctrl K</kbd></dt><dd>Search workspace</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Close the current dialog</dd></div><div><dt><kbd>Tab</kbd></dt><dd>Move between controls</dd></div></dl></section>`);}
function updateBanner() {const banner=document.querySelector('#connection-banner');if(!navigator.onLine){banner.innerHTML='You’re offline. The sample workspace is still available; no live requests are sent.';banner.hidden=false;}else if(waitingRegistration){banner.innerHTML=memoryOnlyChanges||(!draftStorage&&Object.keys(drafts).length)?'An update is ready. Keep this window open: some preview work could not be saved.':'A new preview is ready. Your saved sample notes will be kept. <button data-action="update-app">Update</button>';banner.hidden=false;}else banner.hidden=true;}

for(const slot of document.querySelectorAll('[data-icon]'))slot.innerHTML=icon(slot.dataset.icon);
render();
window.addEventListener('popstate',()=>{state=readRoute();if(detail.open)detail.close();render();});
window.addEventListener('hashchange',()=>{state=readRoute();render();});
searchInput.addEventListener('input',()=>setState({q:searchInput.value,filter:'all'},{replace:true}));
document.addEventListener('change',event=>{if(event.target.id==='sort'){setState({sort:event.target.value});document.querySelector('#sort')?.focus({preventScroll:true});}if(event.target.id==='status-filter'){setState({filter:event.target.value});document.querySelector('#status-filter')?.focus({preventScroll:true});}});
document.addEventListener('input',event=>{if(event.target.id==='review-note'&&currentId)saveDraft(currentId,event.target.value);if(event.target.id==='revoke-note'&&pendingRevocation)revokeDrafts[`${pendingRevocation.userId}:${pendingRevocation.sessionId}`]=event.target.value;});
document.addEventListener('keydown',event=>{
  const activeDialog=[utility,detail,navigationDialog].find(dialog=>dialog.open);
  if(event.key==='Tab'&&activeDialog){
    const controls=[...activeDialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter(element=>element.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(first&&((event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last)||!activeDialog.contains(document.activeElement))){event.preventDefault();(event.shiftKey?last:first).focus();}
  }
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!activeDialog){event.preventDefault();searchInput.focus();searchInput.select();}
});
document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();main.focus();return;}
  const route=event.target.closest('[data-route]');if(route){event.preventDefault();if(!state.q)routeState[state.route]={filter:state.filter,sort:state.sort,expanded:state.expanded};navigationDialog.close();const prior={filter:'all',sort:'priority',expanded:false,...routeState[route.dataset.route]};if(!filters[route.dataset.route]?.some(([key])=>key===prior.filter))prior.filter='all';const requested=route.dataset.routeFilter;if(requested&&filters[route.dataset.route]?.some(([key])=>key===requested))prior.filter=requested;setState({route:route.dataset.route,q:'',...prior},{focus:true});window.scrollTo({top:0});return;}
  const queue=event.target.closest('[data-queue]');if(queue){event.preventDefault();setState({route:'overview',q:'',filter:'attention',expanded:true},{focus:true});return;}
  const step=event.target.closest('[data-detail-step]');if(step){const direction=Number(step.dataset.detailStep);if(direction===1||direction===-1)stepDetail(direction);return;}
  const copy=event.target.closest('[data-copy-reference]');if(copy){try{await navigator.clipboard.writeText(copy.dataset.copyReference);showToast('Reference copied.');}catch{showToast('Copy unavailable. Select the visible reference to copy it.');}return;}
  const user=event.target.closest('[data-user]');if(user){openUser(user.dataset.user);return;}
  const revoke=event.target.closest('[data-revoke-session]');if(revoke){confirmRevocation(revoke.dataset.revokeSession);return;}
  const record=event.target.closest('[data-open]');if(record){openDetail(record.dataset.open);return;}
  const filter=event.target.closest('[data-filter]');if(filter){const value=filter.dataset.filter;setState({filter:value});main.querySelector(`[data-filter="${value}"]`)?.focus({preventScroll:true});return;}
  const target=event.target.closest('[data-action]');if(!target)return;
  switch(target.dataset.action){
    case 'menu':navigationDialog.showModal();break;
    case 'close-menu':navigationDialog.close();break;
    case 'close-detail':detail.close();break;
    case 'back-detail':backDetail();break;
    case 'review-latest':reviewLatest();break;
    case 'clear-search':setState({q:'',filter:'all'});searchInput.focus();break;
    case 'close-utility':utility.close();break;
    case 'about':showAbout();break;
    case 'confirm-revoke-session':revokeSession();break;
    case 'clear-filters':setState({q:'',filter:'all'},{focus:true});break;
    case 'review-next':{const next=sorted(store.records().filter(isAttention))[0];if(next)openDetail(next.id);break;}
    case 'reset':showUtility('Reset the sample workspace?',`<p>This clears your preview decisions and notes, and brings back the original sample requests.</p>`,`<button class="button secondary" data-action="close-utility">Keep my changes</button><button class="button primary" data-action="confirm-reset">Reset preview</button>`);break;
    case 'confirm-reset':{const result=store.reset();memoryOnlyChanges=!result.persisted;drafts={};for(const key of Object.keys(revokeDrafts))delete revokeDrafts[key];pendingRevocation=null;recoveryTarget=null;try{localStorage.removeItem('lovelies-admin-preview-drafts-v1');}catch{draftStorage=false;}utility.close();setState({route:'overview',q:'',filter:'all',expanded:false});showToast(result.persisted?'Sample workspace reset.':'Reset for this visit. Device storage is unavailable.');break;}
    case 'install':if(navigationDialog.open)navigationDialog.close();if(pendingInstall){await pendingInstall.prompt();await pendingInstall.userChoice;pendingInstall=null;}else{showUtility('Lovelies, within reach.',`<p>Install this preview for a focused app window and access to the sample workspace offline after its first successful load.</p><p>In Chrome or Edge, use the browser’s install option. In Safari on Mac, choose <strong>File → Add to Dock</strong>. On iPhone or iPad, use <strong>Share → Add to Home Screen</strong>.</p><p>This installs the design preview. It does not connect a live administrator account.</p>`);}break;
    case 'update-app':if(memoryOnlyChanges||(!draftStorage&&Object.keys(drafts).length)){showToast('Keep this window open. Some preview work has not been saved.');break;}if(waitingRegistration&&!detail.open&&!utility.open){updating=true;waitingRegistration.waiting?.postMessage({type:'ACTIVATE_UPDATE'});}else if(detail.open){showToast('Finish or close this review before updating.');}break;
  }
});
detail.addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.target;if(form.id!=='review-form')return;
  const action=event.submitter?.value;if(!action)return;
  const note=form.elements.note.value;
  try{
    const result=store.update(currentId,action,note,{expectedRevision:currentRevision});
    memoryOnlyChanges=!result.persisted;
    saveDraft(currentId,'');
    render();openDetail(currentId,{restoreFocus:true});
    showToast(result.persisted?`Sample request ${result.record.reviewOutcome==='rejected'?'rejected':statusLabels[result.record.status].toLowerCase()}.`:'Preview updated for this visit. Device storage is unavailable.');
  }catch(error){showActionError(error,'#review-error',{type:'case',id:currentId});}
});
detail.addEventListener('close',()=>{const returnTo=(detailOrigin&&document.querySelector(detailOrigin))||document.querySelector(`[data-user="${currentUserId}"]`)||document.querySelector(`[data-open="${currentId}"]`)||document.querySelector('[data-action="review-next"]')||document.querySelector('[data-open]')||main;returnTo?.focus({preventScroll:true});currentId=null;currentUserId=null;currentRevision=null;detailOrigin=null;detailTrail=[];detailSequence=[];detailType=null;});
for(const dialog of [detail,utility,navigationDialog])dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
window.addEventListener('online',updateBanner);window.addEventListener('offline',updateBanner);
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();pendingInstall=event;});
window.addEventListener('appinstalled',()=>{pendingInstall=null;showToast('Lovelies preview installed.');});
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(updating)location.reload();});
  navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(registration=>{
    if(registration.waiting){waitingRegistration=registration;updateBanner();}
    registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){waitingRegistration=registration;updateBanner();}});});
  }).catch(()=>{document.querySelector('#storage-note').textContent='Offline shell unavailable · Browser preview';});
}
updateBanner();
