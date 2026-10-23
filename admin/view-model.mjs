/** Presentation rules shared by the preview. No live credentials or records. */
export const statusLabels = {open:'Open',pending:'Awaiting decision',pending_approval:'Awaiting decision',under_review:'In review',queued:'Queued',running:'Running',processing:'Processing',ready:'Processing complete',approved:'Approved',rejected:'Rejected',resolved:'Resolved',completed:'Completed',closed:'Closed',failed:'Failed',active:'Active',deleted:'Deleted',revoked:'Revoked',expired:'Expired',refreshable:'Refreshable'};
export const filters = {
  overview:[['all','All'],['attention','Needs attention'],['done','Finished']],
  users:[['all','All users'],['registered','Registered'],['anonymous','Anonymous'],['deleted','Deleted']],
  'match-reports':[['all','All'],['attention','Needs attention'],['open','Open'],['under_review','In review'],['resolved','Resolved'],['rejected','Rejected']],
  privacy:[['all','All'],['attention','Needs attention'],['pending_approval','Awaiting decision'],['queued','Queued'],['running','Running'],['failed','Failed'],['completed','Completed'],['rejected','Rejected']],
  support:[['all','All'],['attention','Needs attention'],['open','Open'],['under_review','In review'],['resolved','Resolved'],['rejected','Rejected'],['closed','Closed']],
  uploads:[['all','All'],['attention','Needs attention'],['processing','Processing'],['ready','Processing complete'],['failed','Failed']],
};
export const needsAttention = row => ['open','pending','pending_approval','under_review','failed'].includes(row.status);
export function matchesFilter(row, filter) {
  if(filter==='all')return true;
  if(filter==='attention')return needsAttention(row);
  if(filter==='done')return ['rejected','resolved','completed','closed'].includes(row.status);
  if(filter==='rejected')return row.reviewOutcome==='rejected'||row.status==='rejected';
  if(filter==='resolved')return row.status==='resolved'&&row.reviewOutcome!=='rejected';
  return row.status===filter;
}
export function filterUsers(users,{q='',filter='all',sort='priority'}={}) {
  const needle=q.trim().toLocaleLowerCase();
  return users.filter(user=>(!needle||[user.name,user.id,user.role,user.status,user.identityState].join(' ').toLocaleLowerCase().includes(needle)) &&
    (filter==='all'||filter==='deleted'&&user.status==='deleted'||user.status!=='deleted'&&(filter==='registered'&&user.identityState==='registered_face'||filter==='anonymous'&&user.identityState==='anonymous')))
    .sort((a,b)=>sort==='name'?a.name.localeCompare(b.name):sort==='oldest'?(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0):(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
}
export function decisionLabel(row) {
  return {pending:'Awaiting decision',pending_approval:'Awaiting decision',approved:'Approved',rejected:'Rejected'}[row.approvalStatus] || (row.status==='pending_approval'?'Awaiting decision':row.status==='rejected'?'Rejected':'Approved');
}
