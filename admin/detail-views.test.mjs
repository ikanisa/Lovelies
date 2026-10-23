import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoStore} from './demo-store.mjs';
import {renderCaseDetail, renderUserDetail} from './detail-views.mjs';
import {statusLabels} from './view-model.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const helpers = {
  escape,
  icon: () => '',
  userAvatar: () => '',
  statusLabels,
  shortDate: value => new Date(value).toISOString().slice(0,10),
  shortTime: value => new Date(value).toISOString().slice(11,16),
  statusBadge: row => `<span>${escape(row.reviewOutcome === 'rejected' ? 'Rejected' : statusLabels[row.status] || row.status)}</span>`,
  kindLabels: {safety:'Match report',privacy:'Privacy request',support:'Support request',upload:'Upload'},
};

function userContext(store, id, sessionDrafts = {}) {
  return {...helpers,user:store.user(id),cases:[],events:[],sessionDrafts};
}

test('a terminal case retains an escaped unsent review note without another decision form', () => {
  const store = createDemoStore(null);
  const record = store.update('support-001','resolve','A different review completed this case.').record;
  const draft = 'Keep <script>alert("draft")</script> & my reason.\nNot yet submitted.';
  const html = renderCaseDetail({...helpers,row:record,events:[],actions:[],note:draft,draftStorage:true});

  assert.ok(html.includes('Unsent review note'));
  assert.ok(html.includes('Not submitted · Retained for reference'));
  assert.ok(html.includes(escape(draft)), 'the original note remains readable as escaped text');
  assert.ok(!html.includes('<script>'), 'a retained note must not become executable markup');
  assert.doesNotMatch(html, /<form\b|<textarea\b|name="decision"/);
});

test('a revoked session retains its escaped unsent reason without restoring its revoke action', () => {
  const store = createDemoStore(null);
  const user = store.user('Account 1033');
  const [selected, other] = user.sessions;
  assert.equal(selected.status,'active');
  assert.equal(other.status,'active');
  store.revokeUserSession(user.id,selected.id,'A separate review revoked this session.',{expectedRevision:user.revision});
  const reason = '<img src=x onerror="alert(1)"> & keep this unsent reason';
  const html = renderUserDetail(userContext(store,user.id,{[selected.id]:reason}));

  assert.ok(html.includes('Unsent revocation reason'));
  assert.ok(html.includes('Not submitted · Retained for reference'));
  assert.ok(html.includes(escape(reason)));
  assert.ok(!html.includes('<img'), 'an unsent reason is text, not HTML');
  assert.ok(!html.includes(`data-revoke-session="${selected.id}"`));
  assert.ok(html.includes(`data-revoke-session="${other.id}"`), 'another active session remains actionable');
});

test('an expired session also retains its exact unsent reason without a revoke action', () => {
  const store = createDemoStore(null);
  const user = store.user('Account 1042');
  const expired = user.sessions.find(session => session.status === 'expired');
  const reason = 'Investigate <expired> session & keep the draft.';
  const html = renderUserDetail(userContext(store,user.id,{[expired.id]:reason}));

  assert.ok(html.includes('Unsent revocation reason'));
  assert.ok(html.includes(escape(reason)));
  assert.ok(!html.includes(`data-revoke-session="${expired.id}"`));
});

test('an active session keeps its existing revoke action and is not presented as a terminal draft', () => {
  const store = createDemoStore(null);
  const user = store.user('Account 1042');
  const active = user.sessions.find(session => session.status === 'active');
  const html = renderUserDetail(userContext(store,user.id,{[active.id]:'Reason still available for the active-session dialog.'}));

  assert.ok(html.includes(`data-revoke-session="${active.id}"`));
  assert.ok(html.includes('Last active '));
  assert.ok(!html.includes('Unsent revocation reason'));
});

test('a deleted account exposes no matching or profile metadata and no session action', () => {
  const store = createDemoStore(null);
  const context = userContext(store,'Account 1099');
  assert.equal(context.user.status,'deleted');
  const html = renderUserDetail(context);

  assert.ok(html.includes('Deleted account'));
  assert.ok(html.includes('Deleted accounts have no available session records.'));
  assert.doesNotMatch(html, /Photo matching|Not enrolled|Not enabled|Registered face|data-revoke-session=/);
  assert.doesNotMatch(html, /faceProfile|matchingStatus|updatedAt/);
});
