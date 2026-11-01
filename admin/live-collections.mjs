/** Query and page contracts for the live operator workspace. */
export const queueFilters = Object.freeze({
  users:[['all','All accounts'],['attention','Needs attention'],['registered','Registered'],['anonymous','Anonymous'],['deleted','Deleted']],
  'match-reports':[['all','All reports'],['attention','Needs attention'],['open','Open'],['under_review','In review'],['resolved','Resolved'],['rejected','Rejected']],
  guardians:[['attention','Needs attention'],['all','All requests'],['pending','Awaiting guardian'],['under_review','In review'],['approved','Approved'],['rejected','Rejected'],['withdrawn','Withdrawn'],['expired','Expired']],
  privacy:[['all','All requests'],['attention','Needs attention'],['pending_approval','Awaiting decision'],['approved','Approved'],['queued','Queued'],['processing','Processing'],['failed','Failed'],['completed','Completed'],['rejected','Rejected'],['cancelled','Cancelled']],
  support:[['all','All requests'],['attention','Needs attention'],['open','Open'],['under_review','In review'],['resolved','Resolved'],['closed','Closed']],
  uploads:[['all','All uploads'],['attention','Needs attention'],['uploading','Uploading'],['uploaded','Uploaded'],['processing','Processing'],['ready','Processing complete'],['failed','Failed'],['cancelled','Cancelled']],
  'queue-recovery':[['attention','Needs recovery review'],['all','All stopped work'],['failed','Failed'],['completed','Recorded complete']],
  matches:[['all','All flagged proposals'],['attention','Needs attention'],['needs_review','Needs review'],['not_me','Reported incorrect'],['blocked','Blocked'],['invalidated','Invalidated'],['rejected','Rejected'],['deleted','Deleted']],
});

export function collectionState(route, params = new URLSearchParams()) {
  const choices=queueFilters[route],fallback=['guardians','queue-recovery'].includes(route)?'attention':'all';
  let filter=params.get('filter')??fallback;
  if(route==='users'&&filter==='registered_face')filter='registered';
  if(filter==='running')filter='processing';
  if(!choices?.some(([value])=>value===filter))filter=fallback;
  const sort=['newest','oldest'].includes(params.get('sort'))?params.get('sort'):(route==='guardians'?'oldest':'newest');
  return {q:(params.get('q')??'').slice(0,100),filter,sort};
}

export function collectionHash(state, changes={}) {
  const next={...state,...changes},params=new URLSearchParams();
  if(next.q)params.set('q',next.q.slice(0,100));
  if(next.filter)params.set('filter',next.filter);
  if(next.sort)params.set('sort',next.sort);
  if(next.matchFilter&&next.matchFilter!=='all')params.set('match_filter',next.matchFilter);
  return next.route+(params.size?'?'+params:'');
}

export function collectionQuery(state,cursor=null) {
  const params=new URLSearchParams({limit:'25',q:state.q,status:state.filter,sort:state.sort});
  if(cursor)params.set('cursor',cursor);
  return params.toString();
}

export function collectionPage(value) {
  // Older deployments can still return the first page while the new API rolls
  // out. Never invent a continuation when its authority is absent.
  if(value==null)return {has_more:false,next_cursor:null,total:null};
  if(typeof value!=='object'||typeof value.has_more!=='boolean'||
      value.has_more&&(typeof value.next_cursor!=='string'||!value.next_cursor||value.next_cursor.length>8192)||
      value.total!=null&&(!Number.isSafeInteger(value.total)||value.total<0))throw new Error('invalid_response');
  return {has_more:value.has_more,next_cursor:value.has_more?value.next_cursor:null,total:value.total??null};
}

export function accountLabel(record) {
  if(record.status==='deleted')return 'Deleted';
  if(record.status&&record.status!=='active')return record.status.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  return record.identity_state==='registered_face'?'Registered':record.identity_state==='anonymous'?'Anonymous':'Unavailable';
}
