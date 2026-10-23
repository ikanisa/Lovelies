/** Synthetic design-preview data only. This module never contacts an API. */
export const DEMO_STORAGE_KEY = 'lovelies-admin-demo-v1';
const copy = value => JSON.parse(JSON.stringify(value));
const at = time => `2026-10-16T${time}:00+02:00`;
const baseFixtures = [
  { id:'safety-001', kind:'safety', title:'A photo was shared with the wrong person', subtitle:'Photo match report · Account 1042', status:'open', createdAt:at('08:42'), dueAt:at('12:00'), priority:'high', details:'The sample recipient says the person in the photograph is not them. Review the report and hold the affected photo while the match is investigated. A hold retires access; resolving the report does not restore it.', accountId:'Account 1042', revision:1 },
  { id:'safety-002', kind:'safety', title:'Someone else appears in my matched photos', subtitle:'Incorrect match · Account 1086', status:'open', createdAt:at('08:15'), dueAt:at('14:00'), priority:'normal', details:'A sample account says a matched photograph shows someone else. Review the incorrect-match report and record a decision. This preview contains no private photographs.', accountId:'Account 1086', revision:1 },
  { id:'privacy-001', kind:'privacy', title:'Delete my account', subtitle:'Account deletion · Account 1037', status:'pending_approval', createdAt:at('07:50'), dueAt:at('16:00'), priority:'high', details:'The sample account has requested deletion. Approval sends the request to the cleanup queue. It does not mean data has been deleted. This preview only simulates that decision.', accountId:'Account 1037', revision:1 },
  { id:'support-001', kind:'support', title:'I cannot find photos shared with me', subtitle:'Gallery support · Account 1064', status:'open', createdAt:at('07:32'), dueAt:at('16:30'), priority:'normal', details:'The sample account expects photographs from an approved share but cannot see them in their gallery. Start a review, then resolve or reject the request with a note.', accountId:'Account 1064', revision:1 },
  { id:'privacy-002', kind:'privacy', title:'Request a copy of my data', subtitle:'Data export · Account 1019', status:'pending_approval', createdAt:at('06:55'), dueAt:at('17:00'), priority:'normal', details:'The sample account has requested an export of their own account data. Approval queues preparation of the private export. It does not mean the file has been delivered or downloaded.', accountId:'Account 1019', revision:1 },
  { id:'support-002', kind:'support', title:'Help replacing my photo profile', subtitle:'Profile support · Account 1073', status:'under_review', createdAt:at('06:40'), dueAt:at('15:00'), priority:'normal', details:'A sample account needs help replacing their own photo profile. The request is already under review. Resolve it with a note after providing appropriate guidance.', accountId:'Account 1073', revision:2 },
  { id:'upload-001', kind:'upload', title:'Morning portraits', subtitle:'Photo upload · 8 sample photos', status:'ready', createdAt:at('08:35'), priority:'normal', details:'Eight sample photographs have finished processing. Processing completion does not grant photo access to recipients; sharing still requires the exact recipient subsets and approval.', accountId:'Account 1045', revision:1 },
  { id:'upload-002', kind:'upload', title:'Afternoon photographs', subtitle:'Photo upload · 24 sample photos', status:'processing', createdAt:at('08:20'), priority:'normal', details:'Twenty-four sample photographs are being processed. This is a fixed demonstration record, not a live processing job or a promise of completion.', accountId:'Account 1025', revision:1 },
  { id:'upload-003', kind:'upload', title:'Weekend photographs', subtitle:'Photo upload · 12 sample photos', status:'ready', createdAt:at('07:45'), priority:'normal', details:'Twelve sample photographs are ready for their owner to review. Matched candidates do not have access until the sharing approval requirements are satisfied.', accountId:'Account 1060', revision:1 },
  { id:'safety-003', kind:'safety', title:'Duplicate report reviewed', subtitle:'Photo report · Account 1015', status:'resolved', createdAt:at('06:25'), priority:'normal', details:'This sample report has been resolved. Resolution does not restore previously revoked access or erase a copy already downloaded.', accountId:'Account 1015', revision:2 },
  { id:'privacy-003', kind:'privacy', title:'Data export prepared', subtitle:'Data export · Account 1051', status:'completed', createdAt:at('06:10'), priority:'normal', details:'A completed sample export demonstrates the finished request state. It contains no downloadable file, personal data, or real delivery evidence.', accountId:'Account 1051', revision:3 },
  { id:'support-003', kind:'support', title:'Sharing question answered', subtitle:'General support · Account 1033', status:'closed', createdAt:at('05:55'), priority:'normal', details:'This sample support request is closed after an explanation of photo sharing approval. Closed requests cannot receive another review decision.', accountId:'Account 1033', revision:3 },
  { id:'privacy-004', kind:'privacy', title:'Account deletion in progress', subtitle:'Account deletion · Account 1060', status:'running', createdAt:at('05:40'), priority:'normal', details:'The sample deletion was approved and cleanup is running. Approval and execution are separate. The account is not marked deleted until cleanup is confirmed complete.', accountId:'Account 1060', revision:3 },
  { id:'privacy-005', kind:'privacy', title:'Data export needs attention', subtitle:'Data export · Account 1086', status:'failed', createdAt:at('05:25'), priority:'high', details:'The approved sample export could not finish preparing its private file. The failure remains visible for investigation. This preview cannot execute cleanup or retry a worker.', accountId:'Account 1086', revision:4 },
  { id:'upload-004', kind:'upload', title:'Evening photographs', subtitle:'Photo upload · 6 sample photos', status:'failed', createdAt:at('05:15'), priority:'high', details:'Processing stopped because the sample processing service was unavailable. No recipients received access. Inspect the recorded failure and retry metadata; this preview does not retry processing.', accountId:'Account 1073', revision:2 },
];

const contexts = {
  'safety-001': {reportType:'Incorrect match', affectedItem:'Sample photo 0042', submittedBy:'Recipient', accessState:'Reported access held', reviewFocus:'Confirm the report and retain the access hold.'},
  'safety-002': {reportType:'Incorrect match', affectedItem:'Sample photo 0086', submittedBy:'Recipient', accessState:'Reported access held', reviewFocus:'Review the incorrect match; no private image is available in this preview.'},
  'safety-003': {reportType:'Duplicate report', affectedItem:'Sample photo 0015', submittedBy:'Recipient', accessState:'Prior hold retained', reviewFocus:'Duplicate linked to the earlier reviewed report.'},
  'support-001': {category:'Photo access', submittedBy:'Account owner', affectedItem:'Sample share 0064', expectedResult:'See photographs from an accepted share.', observedResult:'The shared photographs are absent from the gallery.'},
  'support-002': {category:'Photo profile', submittedBy:'Account owner', affectedItem:'Registered photo profile', expectedResult:'Replace the registered profile through the app.', observedResult:'The account owner requested guidance.'},
  'support-003': {category:'Sharing approval', submittedBy:'Account owner', affectedItem:'Sample share 0033', expectedResult:'Understand when a recipient can view photographs.', observedResult:'Approval requirements explained; request closed.'},
};
const executionDetails = {
  'privacy-003': {attemptCount:1,queuedAt:at('06:25'),startedAt:at('06:35'),completedAt:at('07:05'),lastErrorCode:null,lastErrorMessage:null,nextRetryAt:null},
  'privacy-004': {attemptCount:1,queuedAt:at('06:00'),startedAt:at('06:15'),completedAt:null,lastErrorCode:null,lastErrorMessage:null,nextRetryAt:null},
  'privacy-005': {attemptCount:2,queuedAt:at('05:45'),startedAt:at('06:00'),completedAt:null,lastErrorCode:'export_storage_unavailable',lastErrorMessage:'The sample export file could not be written. Execution remains incomplete.',nextRetryAt:null},
};
const fixtures = baseFixtures.map(original => {
  const row = {...original,revision:original.id==='privacy-003'?4:original.kind==='upload' && original.status==='ready'?2:original.revision};
  const rawContext = contexts[row.id] ?? (row.kind === 'privacy'
    ? {requestType:row.title.toLowerCase().includes('delet')?'Account deletion':'Data export',submittedBy:'Account owner',scope:'Current account and associated records',delivery:'No private file is available in this preview.'}
    : {source:'Personal upload',photoCount:({'upload-001':8,'upload-002':24,'upload-003':12,'upload-004':6})[row.id],sharingState:'Processing does not grant recipient access.'});
  const context = Object.fromEntries(Object.entries(rawContext).map(([key,value])=>[key.replace(/([A-Z])/g,' $1').replace(/^./,letter=>letter.toUpperCase()).toLowerCase().replace(/^./,letter=>letter.toUpperCase()),value]));
  if(row.id==='privacy-004') Object.assign(context,{'Worker state':'Running · Started 16 Oct, 06:15 CAT','Execution attempts':1,'Completion':'Not yet confirmed'});
  if(row.id==='privacy-005') Object.assign(context,{'Failure':'Export storage unavailable','Execution attempts':2,'Retry':'No retry scheduled in this preview','Completion':'Not completed; no export file is available'});
  if(row.id==='upload-004') Object.assign(context,{'Failure':'Photo processing service unavailable','Processing attempts':2,'Last failure':'16 Oct, 06:10 CAT','Retry':'No retry scheduled in this preview'});
  if (row.kind === 'privacy') {
    const approved = ['queued','running','failed','completed'].includes(row.status);
    return {...row,context,approvalStatus:approved?'approved':'pending_approval',executionStatus:approved?row.status:'not_started',executionDetails:executionDetails[row.id] ?? {attemptCount:0,queuedAt:null,startedAt:null,completedAt:null,lastErrorCode:null,lastErrorMessage:null,nextRetryAt:null}};
  }
  if (row.kind === 'upload') return {...row,context,source:'personal',processing:{attemptCount:row.status==='failed'?2:1,lastAttemptAt:row.createdAt,lastFailureAt:row.status==='failed'?at('06:10'):null,errorCode:row.status==='failed'?'processor_unavailable':null,errorMessage:row.status==='failed'?'The sample processing service was unavailable.':null,retryEligible:false,nextRetryAt:null}};
  return {...row,context};
});

export const DEMO_OPERATOR_ID = 'Account 1001';
const userNames = [
  ['1001','Alex Morgan','admin','registered_face','active'],
  ['1042','Maya Reed','user','registered_face','active'],['1086','Leo Park','user','registered_face','paused'],
  ['1037','Nina Cole','user','registered_face','paused'],['1064','Sam Rivers','user','registered_face','active'],
  ['1019','Ella Stone','user','registered_face','active'],['1073','Noah Lane','user','registered_face','paused'],
  ['1045','Ava Brooks','user','registered_face','active'],['1025','Max Green','user','registered_face','active'],
  ['1060','Ivy West','user','registered_face','paused'],['1015','Robin Ellis','admin','registered_face','active'],
  ['1051','Theo Gray','user','registered_face','active'],['1033','Zoe Hart','user','anonymous','absent'],
];
const userFixtures = userNames.map(([number,name,role,identityState,matchingStatus],index) => {
  const id = `Account ${number}`;
  return {id,name,role,roles:role==='admin'?['user','admin']:['user'],status:'active',identityState,createdAt:`2026-10-${String(index+1).padStart(2,'0')}T09:00:00+02:00`,matchingStatus,
    faceProfile:{status:matchingStatus,updatedAt:identityState==='anonymous'?null:at('06:00')},
    sessions:[{id:`sample-session-${number}-1`,device:index%2?'iPhone · Lovelies':'Android · Lovelies',createdAt:at('06:00'),lastSeenAt:at('08:40'),status:'active'},
      {id:`sample-session-${number}-2`,device:'Previous phone · Lovelies',createdAt:'2026-10-14T08:00:00+02:00',lastSeenAt:'2026-10-15T17:30:00+02:00',status:index%3===0?'active':'expired'}],
    revision:1,isCurrentOperator:id===DEMO_OPERATOR_ID};
});
// A deleted account is a tombstone, with no retained profile or session metadata.
userFixtures.push({id:'Account 1099',name:'Deleted account',role:null,roles:[],status:'deleted',identityState:null,createdAt:null,matchingStatus:null,faceProfile:null,sessions:[],revision:1,isCurrentOperator:false});

const transitions = {
  safety: { open:{hold:'under_review',resolve:'resolved',reject:'rejected'}, under_review:{resolve:'resolved',reject:'rejected'} },
  privacy: { pending_approval:{approve:'queued',reject:'rejected'} },
  support: { open:{start:'under_review',resolve:'resolved',reject:'resolved'}, under_review:{resolve:'resolved',reject:'resolved'} },
  upload: {},
};
const event = (row,action,fromStatus,toStatus,note,time,revision) => ({id:`demo-history-${row.id}-${action}`,recordId:row.id,kind:row.kind,title:row.title,action,fromStatus,toStatus,note,createdAt:time,revision,actor:action==='submitted'?'Sample account':/^(execution_|processing_)/.test(action)?'Sample worker':'Sample operator'});
const initialActivity = fixtures.flatMap(row => {
  const start = row.kind==='privacy'?'pending_approval':row.kind==='upload'?'processing':'open';
  const events = [event(row,'submitted',null,start,'Synthetic request received in the sample workspace.',row.createdAt,1)];
  if (row.id==='safety-003') events.push(event(row,'resolve','open','resolved','Duplicate report reviewed; the prior access hold remains.',at('08:05'),2));
  if (row.id==='support-002') events.push(event(row,'start','open','under_review','Sample support review started.',at('07:20'),2));
  if (row.id==='support-003') events.push(event(row,'start','open','under_review','Sharing approval question reviewed.',at('06:05'),2),event(row,'close','under_review','closed','Sharing approval guidance provided; sample request closed.',at('06:20'),3));
  if (row.kind==='privacy' && row.approvalStatus==='approved') {
    const execution = row.executionDetails;
    events.push(event(row,'approve','pending_approval','queued','Request approved. Execution has not yet completed.',execution.queuedAt,2));
    events.push(event(row,'execution_started','queued','running','Sample worker started the approved request.',execution.startedAt,3));
    if(row.executionStatus==='completed')events.push(event(row,'execution_completed','running','completed','Sample export preparation completed. No delivery or download is claimed.',execution.completedAt,4));
    if(row.executionStatus==='failed')events.push(event(row,'execution_failed','running','failed',execution.lastErrorMessage,at('06:20'),4));
  }
  if (row.kind==='upload' && row.status!=='processing') events.push(event(row,row.status==='ready'?'processing_completed':'processing_failed','processing',row.status,row.status==='ready'?'Sample processing completed; recipient approval is still required.':row.processing.errorMessage,at(row.status==='ready'?'08:45':'06:10'),row.revision));
  return events;
}).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
const failure = (code, message) => Object.assign(new Error(message), {code});
const cleanNote = note => typeof note === 'string' && note.trim().length >= 3 && note.trim().length <= 1000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(note);
const equal = (left,right) => JSON.stringify(left) === JSON.stringify(right);
// A schema change restores synthetic fixtures only; it never imports account data.
const initialState = () => ({version:3,records:copy(fixtures),users:copy(userFixtures),activity:copy(initialActivity)});
const reviewRecord = (previous,action,time) => {
  const status = transitions[previous.kind]?.[previous.status]?.[action];
  if (typeof status !== 'string') throw failure('action_unavailable','This action is no longer available for the sample record.');
  const record = {...previous,status,revision:previous.revision+1};
  if (record.kind === 'support' && ['resolve','reject'].includes(action)) record.reviewOutcome = action === 'reject' ? 'rejected' : 'approved';
  if (record.kind === 'privacy') {
    record.approvalStatus = action==='approve'?'approved':'rejected';
    record.executionStatus = action==='approve'?'queued':'not_started';
    record.executionDetails = {...record.executionDetails,queuedAt:action==='approve'?time:null};
  }
  return record;
};
const sessionForRevocation = (users,id,sessionId) => {
  const user = users.find(row=>row.id===id);
  if (!user) throw failure('user_not_found','This sample account is unavailable.');
  if (user.status==='deleted') throw failure('account_deleted','Deleted sample accounts have no sessions to revoke.');
  if (user.isCurrentOperator) throw failure('self_action_unavailable','The current sample operator cannot revoke their own sessions here.');
  if (user.role==='admin' && users.filter(row=>row.status==='active' && row.role==='admin' && row.identityState==='registered_face').length<=1) throw failure('last_admin_protected','The last active registered sample administrator is protected.');
  const session = user.sessions.find(row=>row.id===sessionId);
  if (!session) throw failure('session_not_found','This sample session is unavailable.');
  if (!['active','refreshable'].includes(session.status)) throw failure('session_unavailable','This sample session is already revoked or expired.');
  return {user,session};
};
const revokeSession = (user,sessionId,time) => ({...user,revision:user.revision+1,sessions:user.sessions.map(session=>session.id===sessionId?{...session,status:'revoked',revokedAt:time}:session)});

function validState(value) {
  if (!value || value.version !== 3 || !Array.isArray(value.records) || value.records.length !== fixtures.length || !Array.isArray(value.users) || value.users.length !== userFixtures.length || !Array.isArray(value.activity) || value.activity.length > 100) return false;
  if (Object.keys(value).some(key=>!['version','records','users','activity'].includes(key))) return false;
  const ids = new Set(), original = new Map(initialActivity.map(item=>[item.id,item]));
  for (const item of value.activity) {
    if (!item || typeof item.id!=='string' || item.id.length>100 || ids.has(item.id)) return false;
    ids.add(item.id);
    if (original.has(item.id) && !equal(original.get(item.id),item)) return false;
  }
  if (initialActivity.some(item=>!ids.has(item.id))) return false;
  const replay = initialState();
  try {
    for (const item of value.activity.filter(item=>!original.has(item.id)).reverse()) {
      if (!cleanNote(item.note) || item.note!==item.note.trim() || !Number.isFinite(Date.parse(item.createdAt))) return false;
      if (item.kind==='user') {
        const {user,session} = sessionForRevocation(replay.users,item.recordId,item.sessionId);
        if (!equal(item,{id:item.id,recordId:user.id,kind:'user',title:user.name,action:'revoke_session',sessionId:session.id,fromStatus:session.status,toStatus:'revoked',note:item.note,createdAt:item.createdAt,revision:user.revision+1,actor:'Alex Morgan · Sample operator'})) return false;
        replay.users[replay.users.findIndex(row=>row.id===user.id)] = revokeSession(user,session.id,item.createdAt);
      } else {
        const index = replay.records.findIndex(row=>row.id===item.recordId), previous = replay.records[index];
        if (!previous) return false;
        const record = reviewRecord(previous,item.action,item.createdAt);
        if (!equal(item,{id:item.id,recordId:record.id,kind:record.kind,title:record.title,action:item.action,fromStatus:previous.status,toStatus:record.status,note:item.note,createdAt:item.createdAt,revision:record.revision,actor:'Alex Morgan · Sample operator'})) return false;
        replay.records[index] = record;
      }
    }
  } catch { return false; }
  return equal(value.records,replay.records) && equal(value.users,replay.users);
}

/**
 * Uses only the supplied browser storage key. Credentials and live account data
 * do not belong here. Every returned record is a copy, preserving store ownership.
 * storageStatus: persistent | recovered (malformed data reset) | memory.
 */
export function createDemoStore(storage) {
  if (arguments.length === 0) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  let state = initialState(), storageStatus = 'memory', sequence = 0, lastPersisted = null;
  const persist = () => {
    if (!storage || typeof storage.setItem !== 'function') { storageStatus = 'memory'; return false; }
    try { const serialized = JSON.stringify(state); storage.setItem(DEMO_STORAGE_KEY,serialized); lastPersisted = serialized; storageStatus = 'persistent'; return true; }
    catch { storageStatus = 'memory'; return false; }
  };
  try {
    if (storage && typeof storage.getItem === 'function') {
      const saved = storage.getItem(DEMO_STORAGE_KEY);
      if (saved !== null && saved !== undefined) {
        let loaded;
        try { if (typeof saved === 'string' && saved.length <= 250000) loaded = JSON.parse(saved); } catch { /* Recover the synthetic fixture only. */ }
        if (validState(loaded)) { state = loaded; persist(); }
        else if (persist()) storageStatus = 'recovered';
      } else persist();
    }
  } catch { storage = null; storageStatus = 'memory'; }
  sequence = state.activity.length;

  const assertFresh = (revision,expectedRevision) => {
    if (expectedRevision!==undefined && expectedRevision!==revision) throw failure('stale_revision','This sample record changed. Reopen it before confirming.');
    if (storage && lastPersisted!==null && typeof storage.getItem==='function') {
      let saved;
      try { saved = storage.getItem(DEMO_STORAGE_KEY); }
      catch { storageStatus = 'memory'; return; }
      if (saved!==lastPersisted) throw failure('stale_state','The sample workspace changed in another tab. Reload before confirming.');
    }
  };
  const recordView = row => ({...row,history:state.activity.filter(item=>item.recordId===row.id)});
  const userView = row => ({...row,activeSessionCount:row.sessions.filter(session=>['active','refreshable'].includes(session.status)).length,
    history:state.activity.filter(item=>item.recordId===row.id || state.records.some(record=>record.id===item.recordId && record.accountId===row.id)),
    cases:state.records.filter(record=>record.accountId===row.id).map(record=>({id:record.id,kind:record.kind,title:record.title,status:record.status}))});

  return {
    get storageStatus() { return storageStatus; },
    records() { return copy(state.records.map(recordView)); },
    users() { return copy(state.users.map(userView)); },
    user(id) { const row = state.users.find(user=>user.id===id); return row?copy(userView(row)):null; },
    activity() { return copy(state.activity); },
    metrics() {
      const count = check => state.records.filter(check).length;
      const safetyOpen = count(row => row.kind === 'safety' && ['open','under_review'].includes(row.status));
      const privacyPending = count(row => row.kind === 'privacy' && row.status === 'pending_approval');
      const supportOpen = count(row => row.kind === 'support' && ['open','under_review'].includes(row.status));
      return {pendingReviews:safetyOpen+privacyPending+supportOpen,safetyOpen,privacyPending,supportOpen,
        privacyRunning:count(row=>row.kind==='privacy' && row.executionStatus==='running'),privacyFailed:count(row=>row.kind==='privacy' && row.executionStatus==='failed'),
        uploadsTotal:count(row => row.kind === 'upload'),uploadsReady:count(row => row.kind === 'upload' && row.status === 'ready'),uploadsFailed:count(row=>row.kind==='upload' && row.status==='failed'),
        usersTotal:state.users.length,activeUsers:state.users.filter(row=>row.status==='active').length,registeredUsers:state.users.filter(row=>row.identityState==='registered_face').length,
        anonymousUsers:state.users.filter(row=>row.identityState==='anonymous').length,sessionsActive:state.users.reduce((sum,row)=>sum+row.sessions.filter(session=>['active','refreshable'].includes(session.status)).length,0),totalRecords:state.records.length};
    },
    update(id,action,note,{expectedRevision}={}) {
      const index = state.records.findIndex(row => row.id === id);
      if (index < 0) throw failure('record_not_found','This sample record is unavailable.');
      const previous = state.records[index];
      assertFresh(previous.revision,expectedRevision);
      const createdAt = new Date().toISOString(), record = reviewRecord(previous,action,createdAt);
      if (!cleanNote(note)) throw failure('review_note_required','Add a review note of 3–1,000 characters.');
      const activity = {id:`demo-action-${Date.now()}-${++sequence}`,recordId:id,kind:record.kind,title:record.title,action,fromStatus:previous.status,toStatus:record.status,note:note.trim(),createdAt,revision:record.revision,actor:'Alex Morgan · Sample operator'};
      state.records[index] = record;
      state.activity = [activity,...state.activity].slice(0,100);
      const persisted = persist();
      return {record:copy(recordView(record)),activity:copy(activity),persisted};
    },
    revokeUserSession(id,sessionId,note,{expectedRevision}={}) {
      const {user,session} = sessionForRevocation(state.users,id,sessionId);
      assertFresh(user.revision,expectedRevision);
      if (!cleanNote(note)) throw failure('review_note_required','Add a review note of 3–1,000 characters.');
      const createdAt = new Date().toISOString(), next = revokeSession(user,session.id,createdAt);
      const activity = {id:`demo-action-${Date.now()}-${++sequence}`,recordId:user.id,kind:'user',title:user.name,action:'revoke_session',sessionId:session.id,
        fromStatus:session.status,toStatus:'revoked',note:note.trim(),createdAt,revision:next.revision,actor:'Alex Morgan · Sample operator'};
      state.users[state.users.findIndex(row=>row.id===id)] = next;
      state.activity = [activity,...state.activity].slice(0,100);
      const persisted = persist();
      return {user:copy(userView(next)),activity:copy(activity),persisted};
    },
    reset() { state = initialState(); sequence = 0; return {persisted:persist()}; },
  };
}
