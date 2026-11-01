// Each queue is queried on the server. Cursor state belongs to the complete
// route/query/filter/collection and is discarded when any of those change.
const statuses=Object.freeze({
  users:['registered','anonymous','deleted'],
  operators:['administrator','delegated','unassigned'],
  support:['open','under_review','resolved','closed'],
  privacy:['pending_approval','approved','queued','processing','completed','failed','rejected','cancelled'],
  guardians:['pending','under_review','approved','rejected','withdrawn','expired'],
  uploads:['uploading','uploaded','processing','ready','failed','cancelled'],
  reports:['open','under_review','resolved','rejected'],
  matches:['needs_review','rejected','blocked','not_me','deleted','expired'],
  'queue-recovery':['attention','failed','completed'],
});
export function queueStatuses(state) {
  return ['all',...(statuses[state.route==='match-reports'?(state.collection??'reports'):state.route]??[])];
}
export function queueQuery(state,cursor=null) {
  const params=new URLSearchParams({limit:'25',q:state.q??'',status:queueStatuses(state).includes(state.filter)?state.filter:'all'});
  if(state.route==='queue-recovery'&&!state.filter)params.set('status','attention');
  if(state.route==='queue-recovery'&&state.sort==='oldest')params.set('sort','oldest');
  if(state.route==='match-reports')params.set('collection',state.collection==='matches'?'matches':'reports');
  if(cursor!==null) {
    if(typeof cursor!=='string'||!cursor||cursor.length>2048||/[\x00-\x20\x7f]/.test(cursor))throw new Error('invalid_response');
    params.set('cursor',cursor);
  }
  return params.toString();
}
export function queuePage(value) {
  if(value==null)return {next_cursor:null,total:null}; // Older servers never imply completeness.
  if(typeof value!=='object'||Array.isArray(value)||!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>100||
    (value.total!=null&&(!Number.isSafeInteger(value.total)||value.total<0))||
    (value.next_cursor!==null&&(typeof value.next_cursor!=='string'||!value.next_cursor||value.next_cursor.length>2048||/[\x00-\x20\x7f]/.test(value.next_cursor))))throw new Error('invalid_response');
  return {next_cursor:value.next_cursor,total:value.total??null};
}
export function queueKey(state) {
  return JSON.stringify([state.route,state.q??'',state.filter??'all',state.route==='match-reports'?(state.collection??'reports'):null,state.sort??'newest']);
}
