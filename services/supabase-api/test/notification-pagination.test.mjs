import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { startHarness, enroll, faceVerifierFixture } from './runtime-harness.mjs';

const originalFetch = globalThis.fetch;
if (process.env.TEST_DATABASE_URL === undefined) {
  globalThis.fetch = async () => { throw Error('network_denied_by_fixture'); };
  after(() => { globalThis.fetch = originalFetch; });
}
const key = () => crypto.randomUUID();

test('notification paging covers tied timestamps, deleted anchors and newly inserted rows; exact lookup reaches older than100', { timeout: 30000 }, async t => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false }); t.after(() => h.close());
  const owner = await enroll(h), other = await enroll(h), ids = [], at = Date.now() - 10000;
  await h.db.transaction(async () => {
    for (let i = 0; i < 151; i++) {
      const id = key(); ids.push(id);
      await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic update',?)", id, owner.accountId, key(), at);
    }
  });
  ids.sort().reverse();
  const first = await h.json('/me/notifications', { token: owner.token });
  assert.equal(first.items.length,25); assert.deepEqual(first.items.map(row=>row.id),ids.slice(0,25));
  assert.deepEqual(first.notifications,first.items);assert.equal(first.page.limit,25);assert.equal(first.page.total,151);
  assert.equal(typeof first.page.next_cursor,'string');
  const {notification:oldest} = await h.json('/me/notifications/' + ids.at(-1), { token: owner.token });
  assert.equal(oldest.id, ids.at(-1)); assert.equal(oldest.title, 'Synthetic update');
  assert.deepEqual(Object.keys(oldest).sort(), ['created_at','entity_id','id','kind','read_at','title']);
  // A new front-page item and deletion of the page boundary must not move or
  // hide the remaining pre-existing rows.
  await h.db.run('DELETE FROM notifications WHERE id=?', ids[24]);
  const inserted = key();
  await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'New synthetic update',?)", inserted, owner.accountId, key(), at + 1);
  const seen=[];let cursor=first.page.next_cursor;
  while(cursor){
    const next=await h.json('/me/notifications?limit=100&cursor='+cursor,{token:owner.token});
    seen.push(...next.items.map(row=>row.id));cursor=next.page.next_cursor;
    assert(!next.items.some(row=>row.id===inserted));
  }
  assert.deepEqual(seen,ids.slice(25));
  const denied = await h.json('/me/notifications/' + ids.at(-1), { token: other.token }, 404);
  assert.equal(denied.error.code, 'notification_unavailable');
  await h.json('/me/notifications/' + key(), { token: owner.token }, 404);
  await h.json('/me/notifications/' + ids[24], { token: owner.token }, 404);
  const foreignCursor = await h.json('/me/notifications?cursor=' + first.page.next_cursor, { token: other.token }, 400);
  assert.equal(foreignCursor.error.code,'invalid_cursor');
  await h.json('/me/notifications/' + ids.at(-1) + '/read', { token: owner.token, body: { operation_key: key() } });
  assert.equal(typeof (await h.json('/me/notifications/' + ids.at(-1), { token: owner.token })).notification.read_at, 'number');
  await h.json('/me/notifications/' + ids.at(-1), { token: owner.token, body: { operation_key: key() } }, 405);
  await h.json('/auth/logout', { token: owner.token, body: {} });
  const stale = await h.request('/me/notifications/' + ids.at(-1), { token: owner.token });
  assert.equal(stale.status, 401); await stale.body?.cancel();
});

test('notification cursor input is bounded, canonical and account scoped', { timeout: 30000 }, async t => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false }); t.after(() => h.close());
  const owner = await enroll(h);
  for(const [query,code] of [
    ...['limit=0','limit=101','limit=1.5','limit=01'].map(query=>[query,'invalid_page_limit']),
    ...['limit=1&limit=2','cursor=a&cursor=b','unknown=1'].map(query=>[query,'invalid_notification_page']),
    ...['cursor=not-json','cursor='+'a'.repeat(1025)].map(query=>[query,'invalid_cursor'])
  ]) {
    const result=await h.json('/me/notifications?'+query,{token:owner.token},400);
    assert.equal(result.error.code,code,query);
  }
  const canonical={version:1,account_id:owner.accountId,scope:'notifications',created_at:1,id:key()};
  const invalidValues=[null,[],{...canonical,version:2},{...canonical,created_at:-1},{...canonical,id:'bad'},
    {...canonical,extra:true},{...canonical,scope:'support'},{...canonical,account_id:key()}];
  for (const value of invalidValues) {
    const cursor = Buffer.from(JSON.stringify(value)).toString('base64url');
    const result = await h.json('/me/notifications?cursor=' + cursor, { token: owner.token }, 400);
    assert.equal(result.error.code,'invalid_cursor');
  }
  assert.deepEqual(await h.json('/me/notifications?limit=1',{token:owner.token}),{items:[],notifications:[],page:{limit:1,total:0,next_cursor:null}});
  assert.deepEqual(await h.json('/me/notifications?cursor=',{token:owner.token}),{items:[],notifications:[],page:{limit:25,total:0,next_cursor:null}});
});
