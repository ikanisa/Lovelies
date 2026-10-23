/** Pure presentation for the existing synthetic admin records. Actions stay in app.js. */
const normalKey = value => String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
const valueFor = (row, key) => Object.entries(row.context || {}).find(([label]) => normalKey(label) === normalKey(key))?.[1];
const labelFor = (ctx, value) => ctx.statusLabels[value] || String(value ?? '').replaceAll('_', ' ');
const hasValue = value => value !== null && value !== undefined && value !== '';
const dateTime = (ctx, value) => value && Number.isFinite(Date.parse(value)) ? `${ctx.shortDate(value)} at ${ctx.shortTime(value)} CAT` : null;
const matchingLabel = value => ({active:'Enabled',enabled:'Enabled',paused:'Paused',absent:'Not enrolled',not_enrolled:'Not enrolled'})[value] || 'Not enabled';

function facts(ctx, rows, className = '') {
  return `<dl class="detail-fact-list ${className}">${rows.filter(([, value]) => hasValue(value)).map(([label, value, markup]) => `<div><dt>${ctx.escape(label)}</dt><dd>${markup ? value : ctx.escape(value)}</dd></div>`).join('')}</dl>`;
}

function contextFacts(ctx, row, excluded = []) {
  const skip = new Set(excluded.map(normalKey));
  return Object.entries(row.context || {}).filter(([key]) => !skip.has(normalKey(key)));
}

function card(title, body, className = '') {
  return `<section class="detail-card ${className}"><h3>${title}</h3>${body}</section>`;
}

function header(ctx, type, reference) {
  const {escape: e, icon, position, backLabel} = ctx;
  const backTo = {'User account':'Back to users','Support request':'Back to support','Match report':'Back to match reports','Privacy request':'Back to privacy','Upload':'Back to uploads'}[type] || 'Back to list';
  return `<div class="dialog-head detail-workspace-head"><div class="detail-header-context">${backLabel ? `<button class="detail-back" data-action="back-detail">${icon('back')}<span>${e(backLabel)}</span></button>` : `<button class="detail-back" data-action="close-detail">${icon('back')}<span>${e(backTo)}</span></button>`}</div><div class="detail-header-tools">${position?.total > 1 ? `<div class="detail-pager" aria-label="Browse current results"><button class="icon-button" data-detail-step="-1" aria-label="Previous ${type === 'User account' ? 'user' : 'record'}" ${position.previous ? '' : 'disabled'}>${icon('back')}</button><span>${e(position.index)} <span class="detail-pager-of">of</span> ${e(position.total)}</span><button class="icon-button" data-detail-step="1" aria-label="Next ${type === 'User account' ? 'user' : 'record'}" ${position.next ? '' : 'disabled'}>${icon('chevron')}</button></div>` : ''}<button class="icon-button detail-copy" data-copy-reference="${e(reference)}" aria-label="Copy reference ${e(reference)}" title="Copy reference">${icon('copy')}</button><button class="icon-button" data-action="close-detail" aria-label="Close ${type === 'User account' ? 'user' : 'request'} details">${icon('close')}</button></div></div>`;
}

function history(ctx, title = 'Activity') {
  const {events = [], escape: e} = ctx;
  const actionLabels = {submitted:'Request received',approve:'Request approved',reject:'Rejected',resolve:'Resolved',hold:'Access held',start:'Review started',close:'Closed',revoke_session:'Session revoked',execution_started:'Execution started',execution_completed:'Execution completed',execution_failed:'Execution failed',processing_completed:'Processing completed',processing_failed:'Processing failed'};
  const eventMarkup = item => {
    const transition = [item.fromStatus, item.action === 'reject' ? 'rejected' : item.toStatus].filter(hasValue).map(value => labelFor(ctx, value));
    const when = dateTime(ctx, item.createdAt);
    return `<li><div class="detail-event-heading"><strong>${e(actionLabels[item.action] || labelFor(ctx, item.toStatus) || item.action || 'Activity recorded')}</strong>${when ? `<time datetime="${e(item.createdAt)}">${e(when)}</time>` : ''}</div>${item.note ? `<p>${e(item.note)}</p>` : ''}<div class="detail-event-scope">${transition.length ? `<span>${e(transition.join(' → '))}</span>` : ''}${item.sessionId ? `<span>Session · ${e(item.sessionId)}</span>` : ''}${item.recordId ? `<span>${e(item.recordId)}</span>` : ''}</div><small>${e(item.actor || 'Sample operator')}${hasValue(item.revision) ? ` · Revision ${e(item.revision)}` : ''}</small></li>`;
  };
  return card(`${e(title)} <span class="heading-count">${events.length}</span>`, events.length ? `<ol class="detail-timeline">${eventMarkup(events[0])}</ol>${events.length > 1 ? `<details class="detail-older-events"><summary>View ${events.length - 1} earlier event${events.length > 2 ? 's' : ''}</summary><ol class="detail-timeline">${events.slice(1).map(eventMarkup).join('')}</ol></details>` : ''}` : '<p class="detail-empty">No recorded activity in this sample workspace.</p>', 'detail-activity');
}

function notice(ctx, text, tone = '') {
  return `<div class="detail-boundary ${tone}">${ctx.icon(tone === 'detail-failure' ? 'alert' : 'privacy')}<p>${ctx.escape(text)}</p></div>`;
}

function retainedDraft(ctx, value, title) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return `<section class="detail-retained-draft"><h4>${ctx.escape(title)}</h4><p class="detail-draft-status">Not submitted · Retained for reference</p><p class="detail-draft-text">${ctx.escape(value)}</p></section>`;
}

function review(ctx) {
  const {row, actions = [], escape: e, icon} = ctx;
  const note = typeof ctx.note === 'string' ? ctx.note : '';
  const consequences = {
    safety:'A hold revokes affected access. Resolving this report does not restore it.',
    privacy:'Approval queues this request. Deletion or export delivery is confirmed separately.',
    support:'Record an internal review note and outcome. This does not send a message to the account owner.',
    upload:'Processing does not grant recipient access. Sharing still requires the owner’s approval.',
  };
  const terminal = row.kind === 'privacy'
    ? row.executionStatus === 'failed' ? 'Execution remains incomplete. No worker retry is available in this preview.' : row.executionStatus === 'completed' ? 'The sample execution is complete. No private file or delivery evidence is available here.' : row.approvalStatus === 'rejected' ? 'This request was rejected. No execution was queued.' : 'This request is being handled by the execution process. No further review decision is available.'
    : row.kind === 'upload' ? 'This workspace shows processing metadata. It cannot retry processing or approve sharing.' : 'This case has a recorded outcome. No further review decision is available.';
  return card(actions.length ? 'Review decision' : row.kind === 'upload' ? 'Access boundary' : 'Current outcome', `${notice(ctx, consequences[row.kind] || '')}${actions.length ? `<form class="review-form" id="review-form"><label for="review-note">Review note</label><textarea id="review-note" name="note" placeholder="Add a short reason for your decision…" minlength="3" maxlength="1000" required aria-describedby="draft-hint review-error">${e(note)}</textarea><div class="detail-note-meta"><p class="field-hint" id="draft-hint">${note ? ctx.draftStorage ? 'Sample note saved on this device.' : 'Note kept for this visit only.' : 'At least 3 characters. Saved only in this preview.'}</p><span id="note-count" aria-hidden="true">${note.length} / 1000</span></div><p class="form-error" id="review-error" role="alert" hidden></p><div class="decision-actions">${actions.map(([value, label, style]) => `<button class="button ${e(style)}" type="submit" name="decision" value="${e(value)}">${e(label)}${style === 'primary' ? icon('arrow') : ''}</button>`).join('')}</div></form>` : `<p class="detail-outcome-copy">${e(terminal)}</p>${retainedDraft(ctx, note, 'Unsent review note')}`}`, 'detail-review-card');
}

function caseSummary(ctx) {
  const {row, escape: e} = ctx;
  return card('Case summary', facts(ctx, [
    [row.kind === 'upload' ? 'Upload' : 'Request', row.id.toUpperCase()],
    ['Account', `<button class="inline-link" data-user="${e(row.accountId)}">${e(row.accountId)}</button>`, true],
    ['Received', dateTime(ctx, row.createdAt)],
    ['Priority', row.priority === 'high' ? 'High' : 'Standard'],
    ['Revision', row.revision],
  ]));
}

function privacyContent(ctx) {
  const {row, escape: e} = ctx;
  const execution = row.executionDetails || {};
  const decision = row.approvalStatus === 'approved' ? 'Approved' : row.approvalStatus === 'rejected' || row.status === 'rejected' ? 'Rejected' : 'Awaiting approval';
  const state = row.executionStatus === 'not_started' ? 'Not started' : labelFor(ctx, row.executionStatus || row.status);
  const failure = execution.lastErrorMessage ? `<section class="detail-failure-panel" aria-label="Execution failure"><div class="detail-failure-title">${ctx.icon('alert')}<h3>Execution needs attention</h3></div><p>${e(execution.lastErrorMessage)}</p>${facts(ctx, [['Failure code', execution.lastErrorCode], ['Recovery', execution.nextRetryAt ? `Retry scheduled ${dateTime(ctx, execution.nextRetryAt)}` : 'No retry scheduled. Execution remains incomplete.']])}</section>` : '';
  return {
    main:`<section class="detail-state-pair" aria-label="Request progress"><div><span>Review decision</span><strong>${e(decision)}</strong></div><div class="${row.executionStatus === 'failed' ? 'detail-state-error' : ''}"><span>Execution</span><strong>${e(state)}</strong></div></section>${failure}${card('Requested scope', facts(ctx, contextFacts(ctx, row, ['Worker state','Execution attempts','Completion','Failure','Retry'])))}`,
    rail:card('Execution record', facts(ctx, [['Attempts', execution.attemptCount ?? 0], ['Queued', dateTime(ctx, execution.queuedAt) || 'Not queued'], ['Started', dateTime(ctx, execution.startedAt) || 'Not started'], ['Completed', dateTime(ctx, execution.completedAt) || 'Not completed']])),
  };
}

function supportContent(ctx) {
  const {row, escape: e} = ctx;
  const expected = valueFor(row, 'expectedResult');
  const observed = valueFor(row, 'observedResult');
  const comparison = expected || observed ? `<div class="detail-comparison" aria-label="Reported behavior">${expected ? `<div><h4>Expected result</h4><p>${e(expected)}</p></div>` : ''}${observed ? `<div><h4>Observed result</h4><p>${e(observed)}</p></div>` : ''}</div>` : '';
  return {
    main:card('Reported issue', `${comparison}${comparison ? `<details class="detail-description-disclosure"><summary>Full request description</summary><p class="detail-prose">${e(row.details)}</p></details>` : `<p class="detail-prose">${e(row.details)}</p>`}`),
    rail:card('Request context', facts(ctx, contextFacts(ctx, row, ['Expected result','Observed result']))),
  };
}

function uploadContent(ctx) {
  const {row, escape: e, icon} = ctx;
  const processing = row.processing || {};
  const failure = processing.errorMessage ? `<section class="detail-failure-panel" aria-label="Processing failure"><div class="detail-failure-title">${icon('alert')}<h3>Processing stopped</h3></div><p>${e(processing.errorMessage)}</p>${facts(ctx, [['Failure code', processing.errorCode], ['Last failure', dateTime(ctx, processing.lastFailureAt)], ['Recovery', processing.nextRetryAt ? `Retry scheduled ${dateTime(ctx, processing.nextRetryAt)}` : 'No retry scheduled in this preview. Processing remains incomplete.']])}</section>` : '';
  return {
    main:`${failure}${card('Upload context', facts(ctx, contextFacts(ctx, row, ['Failure','Processing attempts','Last failure','Retry'])))}`,
    rail:card('Processing record', facts(ctx, [['State', labelFor(ctx, row.status)], ['Attempts', processing.attemptCount], ['Last attempt', dateTime(ctx, processing.lastAttemptAt)], ['Retry available here', 'No']])),
  };
}

function safetyContent(ctx) {
  const {row, escape: e} = ctx;
  const focus = valueFor(row, 'reviewFocus');
  const access = valueFor(row, 'accessState');
  return {
    main:access ? `<section class="detail-access-state"><h3>Access state</h3><strong>${e(access)}</strong>${focus ? `<p>${e(focus)}</p>` : ''}</section>` : '',
    rail:card('Report context', facts(ctx, contextFacts(ctx, row, access ? ['Access state','Review focus'] : []))),
  };
}

export function renderCaseDetail(ctx) {
  const {row, escape: e, icon, statusBadge, kindLabels} = ctx;
  const body = row.kind === 'privacy' ? privacyContent(ctx) : row.kind === 'support' ? supportContent(ctx) : row.kind === 'upload' ? uploadContent(ctx) : safetyContent(ctx);
  const summary = row.kind === 'support' ? '' : card(row.kind === 'upload' ? 'Upload summary' : 'Request summary', `<p class="detail-prose">${e(row.details)}</p>`);
  return `<div class="detail-inner detail-workspace detail-case-workspace">${header(ctx, kindLabels[row.kind], row.id)}<header class="detail-masthead"><span class="record-icon ${e(row.kind)}">${icon(row.kind)}</span><div class="detail-heading-copy"><h2 id="detail-title" class="detail-title">${e(row.title)}</h2><p class="detail-reference">${e(row.id.toUpperCase())} · ${e(kindLabels[row.kind])}</p></div><div class="detail-masthead-state">${statusBadge(row)}</div></header><div class="detail-layout"><div class="detail-main detail-primary-surface">${summary}${body.main}${review(ctx)}</div><aside class="detail-aside" aria-label="Case context and history">${caseSummary(ctx)}${body.rail}${history(ctx, row.kind === 'upload' ? 'Processing history' : row.kind === 'privacy' ? 'Request history' : 'Decision history')}</aside></div><p class="detail-simulation">Design preview · Decisions affect sample records only</p></div>`;
}

export function renderUserDetail(ctx) {
  const {user, cases = [], escape: e, icon, userAvatar, kindLabels} = ctx;
  const deleted = user.status === 'deleted';
  const identity = deleted ? 'Deleted account' : user.identityState === 'registered_face' ? 'Registered face' : 'Anonymous';
  const sessions = user.sessions || [];
  const sessionSection = card(`Sessions <span class="heading-count">${e(user.activeSessionCount ?? 0)} active</span>`, sessions.length ? `<ul class="detail-session-list">${sessions.map(session => {
    const draft = ['revoked','expired'].includes(session.status) ? retainedDraft(ctx, ctx.sessionDrafts?.[session.id], 'Unsent revocation reason') : '';
    return `<li${draft ? ' class="detail-session-has-draft"' : ''}><div class="detail-session-main"><span class="detail-session-icon">${icon('privacy')}</span><div><div class="detail-session-heading"><strong>${e(session.device || 'Registered device')}</strong><span class="detail-session-state">${e(labelFor(ctx, session.status))}</span></div><span>${dateTime(ctx, session.lastSeenAt) ? `Last active ${e(dateTime(ctx, session.lastSeenAt))}` : dateTime(ctx, session.createdAt) ? `Created ${e(dateTime(ctx, session.createdAt))}` : 'Activity time unavailable'}</span><small>${e(session.id)}</small></div></div>${['active','refreshable'].includes(session.status) && !user.isCurrentOperator && !deleted ? `<button class="button secondary small" data-revoke-session="${e(session.id)}">Revoke<span class="sr-only"> ${e(session.device || 'session')}</span></button>` : ''}${draft}</li>`;
  }).join('')}</ul>` : `<p class="detail-empty">${deleted ? 'Deleted accounts have no available session records.' : 'No sessions on this account.'}</p>`);
  const related = card(`Related cases <span class="heading-count">${cases.length}</span>`, cases.length ? `<ul class="detail-related-list">${cases.map(row => `<li><button data-open="${e(row.id)}"><span class="record-icon ${e(row.kind)}">${icon(row.kind)}</span><span class="detail-related-text"><strong>${e(row.title)}</strong><small>${e(kindLabels[row.kind])} · ${e(row.id.toUpperCase())}</small></span><span class="detail-related-state">${ctx.statusBadge(row)}</span>${icon('chevron')}</button></li>`).join('')}</ul>` : '<p class="detail-empty">No related cases in this workspace.</p>');
  const summary = card('Account overview', facts(ctx, [['Account status', labelFor(ctx, user.status)], ['Role', deleted ? 'Unavailable' : user.role === 'admin' ? 'Administrator' : 'User'], ['Created', dateTime(ctx, user.createdAt)], ...(!deleted ? [['Photo matching', matchingLabel(user.matchingStatus)]] : [])]), 'detail-user-summary');
  const protection = deleted ? 'This is a deleted-account record. No profile or session actions are available.' : user.isCurrentOperator ? 'Your current preview operator is protected from session revocation here.' : user.role === 'admin' ? 'The last active registered administrator is protected from session revocation.' : 'Revoking a session ends access from that session. It does not delete the account or photos.';
  const access = card('Access controls', `${notice(ctx, protection)}${!deleted ? '<p class="detail-outcome-copy">Account deletion follows a Privacy request. Photo matching state is shown for context and cannot be changed here.</p>' : ''}`);
  return `<div class="detail-inner detail-workspace detail-user-workspace">${header(ctx, 'User account', user.id)}<header class="detail-masthead">${userAvatar(user)}<div class="detail-heading-copy"><h2 id="detail-title" class="detail-title">${e(user.name || (deleted ? 'Deleted account' : 'User account'))}</h2><p class="detail-reference">${e(user.id)}${user.isCurrentOperator ? ' · Current operator' : ''}</p></div><div class="detail-masthead-state"><span class="badge ${deleted ? 'closed' : user.identityState === 'registered_face' ? 'ready' : 'queued'}">${e(identity)}</span></div></header><div class="detail-layout"><div class="detail-main detail-primary-surface">${summary}${sessionSection}${related}</div><aside class="detail-aside" aria-label="Account access and activity">${access}${history(ctx, 'Account activity')}</aside></div><p class="detail-simulation">Sample account · No live user data or account changes</p></div>`;
}
