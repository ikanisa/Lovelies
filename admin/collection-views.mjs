/** Pure presentation of the local sample workspace. No storage, network or mutations. */
const contextValue = (row, key) => row.context?.[key] ?? row.context?.[key.replace(/ ([a-z])/g, (_, letter) => letter.toUpperCase()).replace(/^./, letter => letter.toLowerCase())];
const countLabel = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const priorityOrder = (left, right) => Number(right.priority === 'high') - Number(left.priority === 'high') || Date.parse(right.createdAt) - Date.parse(left.createdAt);

function heading(ctx, title, description, action = '') {
  return `<div class="page-heading collection-heading"><div><h1>${ctx.escape(title)}</h1><p class="page-description">${ctx.escape(description)}</p></div>${action || `<span class="snapshot-date">${ctx.icon('calendar')}Sample · 16 Oct 2026</span>`}</div>`;
}

function routeLink(ctx, route, filter, label, className = 'text-link') {
  const attributes = filter ? `data-route="${route}" data-route-filter="${filter}"` : `data-route="${route}"`;
  return `<a class="${className}" href="#${route}${filter ? `?filter=${filter}` : ''}" ${attributes}>${label}</a>`;
}

function empty(ctx, users = false) {
  const searching = Boolean(ctx.state.q), filtered = ctx.state.filter !== 'all';
  const title = searching ? `No matching ${users ? 'users' : 'records'}` : filtered ? 'No records in this view' : `No ${users ? 'users' : 'requests'} to show`;
  return `<div class="empty-state collection-empty">${ctx.icon(searching ? 'search' : 'check')}<h3>${title}</h3><p>${searching ? 'Try a name, reference or account number.' : filtered ? 'The other views may have what you need.' : 'This sample collection is empty.'}</p>${searching || filtered ? `<button class="button secondary small" data-action="clear-filters">${searching ? 'Clear search and filters' : 'Show all records'}</button>` : ''}</div>`;
}

function dateCell(ctx, value, label = 'Received', {dateOnly = false} = {}) {
  return `<td class="collection-date" data-label="${label}">${value ? `<time datetime="${ctx.escape(value)}"${dateOnly ? ` title="${ctx.escape(value)}" aria-label="${ctx.escape(`${ctx.shortDate(value)} ${new Date(value).getUTCFullYear()}, ${ctx.shortTime(value)} Kigali time`)}"` : ''}>${ctx.escape(ctx.shortDate(value))}${dateOnly ? '' : `<span class="collection-secondary">${ctx.escape(ctx.shortTime(value))}</span>`}</time>` : '<span class="collection-secondary">Not retained</span>'}</td>`;
}

function recordIdentity(ctx, row, { mixed = false, scope = false, category = false } = {}) {
  const summary = scope ? contextValue(row, 'Scope') : '';
  return `<div class="collection-identity">${mixed ? `<span class="record-icon ${ctx.escape(row.kind)}">${ctx.icon(row.kind)}</span>` : ''}<div class="collection-identity-copy"><button class="record-title" data-open="${ctx.escape(row.id)}">${ctx.escape(row.title)}</button>${summary ? `<span class="collection-secondary collection-scope">${ctx.escape(summary)}</span>` : ''}<div class="collection-reference"><span>${ctx.escape(row.id)}</span>${category ? `<span>${ctx.escape(ctx.kindLabels[row.kind])}</span>` : ''}<span>${ctx.escape(row.accountId)}</span>${row.priority === 'high' ? '<span class="collection-priority">High priority</span>' : ''}</div></div></div>`;
}

function privacyExecution(ctx, row) {
  const execution = row.executionStatus || (['pending_approval', 'rejected'].includes(row.status) ? 'not_started' : row.status);
  return execution === 'not_started' ? '<span class="badge">Not started</span>' : ctx.statusBadge({...row, status: execution});
}

function recordTable(ctx, rows, { mode = 'mixed', overview = false } = {}) {
  if (!rows.length) return empty(ctx);
  const privacy = mode === 'privacy', uploads = mode === 'upload';
  const middle = overview ? '<th scope="col">Status</th>' : privacy ? '<th scope="col">Decision</th><th scope="col">Execution</th>' : mode === 'safety' ? '<th scope="col">Access impact</th><th scope="col">Status</th>' : mode === 'support' ? '<th scope="col">Category</th><th scope="col">Status</th>' : uploads ? '<th scope="col">Photos</th><th scope="col">Processing</th>' : '<th scope="col">Category</th><th scope="col">Status</th>';
  return `<div class="collection-table-wrap"><table class="collection-table ${overview ? 'collection-queue-table' : ''}" aria-label="${overview ? 'Cases needing attention' : uploads ? 'Sample uploads' : privacy ? 'Sample privacy requests' : 'Sample workspace records'}"><thead><tr><th scope="col">${uploads ? 'Upload' : privacy ? 'Request & scope' : 'Request'}</th>${middle}<th scope="col">Received</th><th scope="col"><span class="sr-only">Open details</span></th></tr></thead><tbody>${rows.map(row => {
    let cells = '';
    if (privacy) cells = `<td data-label="Decision" class="collection-decision"><span>${ctx.escape(ctx.decisionLabel(row))}</span></td><td data-label="Execution" class="collection-status">${privacyExecution(ctx, row)}${row.executionDetails?.lastErrorMessage && row.status === 'failed' ? '<span class="collection-secondary collection-failure">Preparation incomplete</span>' : ''}</td>`;
    else {
      let label, body;
      if (mode === 'safety') {label = 'Access impact'; body = `${ctx.escape(contextValue(row, 'Access state') || 'Review report')}<span class="collection-secondary">${ctx.escape(contextValue(row, 'Report type') || 'Photo report')}</span>`;}
      else if (mode === 'support') {label = 'Category'; body = `${ctx.escape(contextValue(row, 'Category') || 'Support')}<span class="collection-secondary">${ctx.escape(contextValue(row, 'Affected item') || '')}</span>`;}
      else if (uploads) {label = 'Photos'; const photos = contextValue(row, 'Photo count'); body = `${Number.isFinite(photos) ? ctx.escape(countLabel(photos, 'photo')) : 'Not recorded'}<span class="collection-secondary">${Number.isFinite(row.processing?.attemptCount) ? ctx.escape(countLabel(row.processing.attemptCount, 'attempt')) : ''}</span>`;}
      else {label = 'Category'; body = ctx.escape(ctx.kindLabels[row.kind]);}
      cells = `${overview ? '' : `<td data-label="${label}" class="collection-context">${body}</td>`}<td data-label="${uploads ? 'Processing' : 'Status'}" class="collection-status">${ctx.statusBadge(row)}${uploads && row.status === 'failed' && row.processing?.errorMessage ? `<span class="collection-secondary collection-failure">${ctx.escape(row.processing.errorMessage)}</span>` : ''}${mode === 'mixed' && row.kind === 'privacy' && row.status !== 'pending_approval' ? `<span class="collection-secondary">Decision: ${ctx.escape(ctx.decisionLabel(row))}</span>` : ''}</td>`;
    }
    return `<tr><td class="collection-subject">${recordIdentity(ctx, row, {mixed:mode === 'mixed' && !overview, scope:privacy, category:overview})}</td>${cells}${dateCell(ctx, row.createdAt)}<td class="collection-open"><button class="icon-button row-action" data-open="${ctx.escape(row.id)}" aria-label="Open ${ctx.escape(row.title)}">${ctx.icon('arrow')}</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function userTable(ctx, users) {
  if (!users.length) return empty(ctx, true);
  return `<div class="collection-table-wrap"><table class="collection-table collection-users-table" aria-label="Sample users"><thead><tr><th scope="col">User</th><th scope="col">Account</th><th scope="col">Active sessions</th><th scope="col">Related cases</th><th scope="col">Joined</th><th scope="col"><span class="sr-only">Open user</span></th></tr></thead><tbody>${users.map(user => {
    const cases = ctx.records.filter(row => row.accountId === user.id).length;
    const label = user.status === 'deleted' ? 'Deleted' : user.identityState === 'registered_face' ? 'Registered' : 'Anonymous';
    const matching = {active:'Matching enabled', paused:'Matching paused', absent:'Not enrolled'}[user.matchingStatus] ?? (user.matchingStatus === null ? 'Matching not enabled' : 'Matching not recorded');
    return `<tr><td class="collection-subject"><div class="collection-identity">${ctx.userAvatar(user)}<div class="collection-identity-copy"><button class="record-title" data-user="${ctx.escape(user.id)}">${ctx.escape(user.name || 'Deleted account')}</button><div class="collection-reference"><span>${ctx.escape(user.id)}</span>${user.role === 'admin' ? '<span>Administrator</span>' : ''}${user.isCurrentOperator ? '<span>You</span>' : ''}</div></div></div></td><td data-label="Account" class="collection-status"><span class="badge collection-account-state">${label}</span>${user.status === 'deleted' ? '' : `<span class="collection-secondary collection-matching">${ctx.escape(matching)}</span>`}</td><td data-label="Active sessions"><span class="collection-number">${user.activeSessionCount}</span></td><td data-label="Related cases"><span class="collection-number">${cases}</span></td>${dateCell(ctx, user.createdAt, 'Joined', {dateOnly:true})}<td class="collection-open"><button class="icon-button row-action" data-user="${ctx.escape(user.id)}" aria-label="View ${ctx.escape(user.name || 'deleted account')}">${ctx.icon('arrow')}</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function toolbar(ctx, { users = false, baseRows = [] } = {}) {
  const choices = users ? ctx.filters.users : ctx.state.q ? ctx.filters.overview : ctx.filters[ctx.state.route];
  const primary = users ? choices : choices.filter(([value]) => ['all', 'attention'].includes(value));
  const count = value => users ? ctx.filterUsers(ctx.users, {...ctx.state, filter:value}).length : baseRows.filter(row => ctx.matchesFilter(row, value)).length + (ctx.state.q && value === 'all' ? ctx.filterUsers(ctx.users, {q:ctx.state.q}).length : 0);
  return `<div class="collection-toolbar"><div class="collection-tabs" aria-label="${users ? 'Filter users' : 'Filter records'}">${primary.map(([value, label]) => `<button data-filter="${value}" aria-pressed="${ctx.state.filter === value}">${ctx.escape(label)}<span class="collection-tab-count">${count(value)}</span></button>`).join('')}</div><div class="collection-controls">${users ? '' : `<label class="collection-select"><span class="sr-only">Status filter</span><select id="status-filter">${choices.map(([value, label]) => `<option value="${value}" ${ctx.state.filter === value ? 'selected' : ''}>${ctx.escape(value === 'all' ? 'All statuses' : label)}</option>`).join('')}</select></label>`}<label class="collection-select collection-sort">${ctx.icon('sort')}<span class="sr-only">Sort ${users ? 'users' : 'records'}</span><select id="sort"><option value="priority" ${ctx.state.sort === 'priority' ? 'selected' : ''}>${users ? 'Newest first' : 'Priority first'}</option><option value="oldest" ${ctx.state.sort === 'oldest' ? 'selected' : ''}>Oldest first</option>${users ? `<option value="name" ${ctx.state.sort === 'name' ? 'selected' : ''}>Name A–Z</option>` : ''}</select></label></div></div>`;
}

export function renderCollection(ctx) {
  const {state, rows = [], userMatches = []} = ctx, route = ctx.routes[state.route];
  const title = state.q ? 'Search results' : state.route === 'overview' ? 'Review queue' : route.label;
  const description = state.q ? 'Requests, uploads and users across your sample workspace.' : state.route === 'overview' ? 'Every open question, in one place.' : route.description;
  const total = rows.length + userMatches.length;
  const note = state.q ? '' : state.route === 'uploads' ? 'Processing creates match candidates. Photo access still needs the contributor’s approved recipient subset.' : state.route === 'privacy' ? 'Approval queues a request. It does not confirm export delivery or completed deletion.' : state.route === 'match-reports' ? 'Resolving a report does not restore revoked photo access. No private photos are shown here.' : '';
  const mode = state.q || state.route === 'overview' ? 'mixed' : route.kind;
  return `<div class="collection-view">${heading(ctx, title, description)}${state.q ? `<p class="search-summary">${ctx.escape(countLabel(total, 'result'))} for <strong>“${ctx.escape(state.q)}”</strong></p>` : ''}<section class="collection-panel" aria-label="${ctx.escape(title)}">${toolbar(ctx, {baseRows:ctx.baseRows || rows})}${userMatches.length ? `<section class="collection-search-users"><h2>Users <span class="heading-count">${userMatches.length}</span></h2>${userTable(ctx, userMatches)}</section>${rows.length ? '<h2 class="collection-subheading">Requests and uploads</h2>' : ''}` : ''}${rows.length || !userMatches.length ? recordTable(ctx, rows, {mode}) : ''}<div class="collection-footer"><span>${ctx.escape(countLabel(total, `sample ${state.q ? 'result' : 'record'}`))}</span><span>Times in Kigali · UTC+2</span></div></section>${note ? `<p class="list-note collection-note">${note}</p>` : ''}</div>`;
}

export function renderUsers(ctx) {
  const users = ctx.filterUsers(ctx.users, ctx.state);
  return `<div class="collection-view">${heading(ctx, 'User management', 'Find an account, review its cases and manage access.')}<section class="collection-panel" aria-label="User management">${toolbar(ctx, {users:true})}${userTable(ctx, users)}<div class="collection-footer"><span>${ctx.escape(countLabel(users.length, 'sample user'))}</span><span>Account data only</span></div></section><p class="list-note collection-note">Session changes are recorded with a reason. Account deletion follows the Privacy request process.</p></div>`;
}

export function renderOverview(ctx) {
  const attention = ctx.records.filter(ctx.needsAttention).sort(priorityOrder), uploads = ctx.records.filter(row => row.kind === 'upload');
  const groups = [
    {kind:'safety', route:'match-reports', title:'Match reports', description:'Review the report and its access impact.'},
    {kind:'privacy', route:'privacy', title:'Privacy requests', description:'Decisions and execution that need attention.'},
    {kind:'support', route:'support', title:'Support', description:'Open questions from account owners.'},
    {kind:'upload', route:'uploads', title:'Upload issues', description:'Inspect recorded processing failures.'},
  ];
  const ready = uploads.filter(row => row.status === 'ready').length, processing = uploads.filter(row => row.status === 'processing').length, failed = uploads.filter(row => row.status === 'failed').length;
  const pendingPrivacy = ctx.records.filter(row => row.kind === 'privacy' && row.status === 'pending_approval').length;
  const supportOpen = ctx.records.filter(row => row.kind === 'support' && ['open', 'under_review'].includes(row.status)).length;
  const usersActive = ctx.users.filter(user => user.status !== 'deleted').length;
  const summary = [
    ['stack', 'Needs attention', attention.length, 'Open cases and processing failures', '#overview?filter=attention&view=queue', 'data-queue'],
    ['privacy', 'Privacy decisions', pendingPrivacy, 'Awaiting review', '#privacy?filter=pending_approval', 'data-route="privacy" data-route-filter="pending_approval"'],
    ['support', 'Open support', supportOpen, 'Open or in review', '#support?filter=attention', 'data-route="support" data-route-filter="attention"'],
    ['user', 'Users', usersActive, 'Active sample accounts', '#users', 'data-route="users"'],
  ];
  const activity = ctx.activity.slice(0, 4);
  return `<div class="overview-view">${heading(ctx, 'Overview', 'A clear view of what needs your attention.', `<button class="button primary" data-action="review-next" ${attention.length ? '' : 'disabled'}>Open next ${ctx.icon('arrow')}</button>`)}<section class="overview-summary" aria-label="Sample workspace summary">${summary.map(([symbol, label, value, description, href, attribute]) => `<a class="overview-summary-item" href="${href}" ${attribute}><span class="overview-summary-label">${ctx.icon(symbol)}${label}</span><strong>${value}</strong><span class="collection-secondary">${description}</span></a>`).join('')}</section>
    <div class="overview-work-grid"><section class="overview-review collection-panel" aria-labelledby="queue-title"><div class="overview-panel-heading"><h2 id="queue-title">Needs attention <span class="heading-count">${attention.length}</span></h2><a class="text-link" href="#overview?filter=attention&view=queue" data-queue>View all ${ctx.icon('arrow')}</a></div><nav class="overview-lanes" aria-label="Review queues">${groups.map(group => {
      const count = attention.filter(row => row.kind === group.kind).length;
      return routeLink(ctx, group.route, 'attention', `<span class="overview-lane-copy">${group.title}</span><span class="overview-lane-count">${count}</span><span class="sr-only">${group.description}</span>`, 'overview-lane');
    }).join('')}</nav>${attention.length ? recordTable(ctx, attention.slice(0, 5), {overview:true}) : '<div class="empty-state collection-empty"><h3>You’re up to date</h3><p>No sample cases currently need attention.</p></div>'}<div class="collection-footer"><span>${Math.min(5, attention.length)} of ${attention.length} cases</span><span>Priority first</span></div></section>
    <aside class="overview-processing collection-panel" aria-label="Photo processing snapshot"><div class="overview-panel-heading"><h2>Photo processing</h2></div><div class="overview-processing-panel"><div class="overview-processing-total"><strong>${ready}<span> / ${uploads.length}</span></strong><p>uploads finished processing</p></div><div class="overview-processing-track" aria-hidden="true">${uploads.map(row => `<span class="${ctx.escape(row.status)}"></span>`).join('')}</div><dl class="overview-processing-key">${[['ready','Processing complete',ready],['processing','Processing',processing],['failed','Failed',failed]].map(([status,label,count]) => `<div><dt><span class="overview-processing-dot ${status}"></span>${label}</dt><dd>${count}</dd></div>`).join('')}</dl><p class="collection-secondary overview-processing-note">This snapshot tracks uploads, not individual photos or granted access.</p>${routeLink(ctx, 'uploads', '', `View uploads ${ctx.icon('arrow')}`, 'overview-processing-link')}</div></aside></div>
    <section class="overview-activity" aria-labelledby="activity-title"><div class="section-heading"><h2 id="activity-title">Recent activity</h2><span class="overview-asof">Local sample history</span></div><div class="overview-activity-list">${activity.length ? activity.map(item => {
      const target = item.kind === 'user' ? `data-user="${ctx.escape(item.recordId)}"` : `data-open="${ctx.escape(item.recordId)}"`;
      const outcome = item.action === 'revoke_session' ? 'Session revoked' : item.action === 'reject' ? 'Rejected' : ctx.statusLabels[item.toStatus] || item.toStatus;
      return `<button class="overview-activity-item" ${target}><span class="overview-activity-icon">${ctx.icon(item.kind === 'user' ? 'user' : item.kind)}</span><span class="overview-activity-copy"><strong>${ctx.escape(item.title)}</strong><span>${ctx.escape(outcome)} · ${ctx.escape(item.recordId)}</span></span><time datetime="${ctx.escape(item.createdAt)}">${ctx.escape(ctx.shortDate(item.createdAt))}<span>${ctx.escape(ctx.shortTime(item.createdAt))}</span>${ctx.icon('chevron')}</button>`;
    }).join('') : '<p class="section-empty">No activity recorded in this sample.</p>'}</div></section></div>`;
}
