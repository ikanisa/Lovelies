/** Synthetic in-process reproduction: no provider, external socket or live data. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupFaceProofs } from '../src/face-auth.ts';
import { startHarness, closeHarnesses } from './runtime-harness.mjs';

after(closeHarnesses);
const pgliteTest = process.env.TEST_DATABASE_URL ? test.skip : test;
const id = () => crypto.randomUUID();
const data = Uint8Array.from([11, 22, 33, 44]);
const hash = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');

async function exercise(mode) {
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'external PostgreSQL is prohibited');
  const h = await startHarness({ consumeQueue: false });
  try {
    const owner = await h.anonymous();
    const other = mode === 'other_subject_moderation' ? await h.anonymous() : null;
    const subject = owner.account_id, challenge = id(), now = Date.now();
    const key = `face-auth/${subject}/${challenge}/${id()}`;
    const bytesHash = await hash(data);
    await h.env.QUARANTINE.put(key, data);
    await h.db.transaction(async () => {
      await h.db.run(`INSERT INTO auth_challenges
        (id,account_id,purpose,nonce,policy_version,expires_at,status,created_at,used_at)
        VALUES(?,?,'login',?,'synthetic-policy',?,'used',?,?)`,
        challenge, subject, id(), now - 500, now - 2000, now - 1000);
      await h.db.run(`INSERT INTO auth_capture_proofs
        (challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at)
        VALUES(?,0,?,?,'image/png',?,?)`, challenge, key, bytesHash, data.length, now - 1900);
      await h.db.run(`INSERT INTO media_write_intents
        (id,account_id,bucket,object_key,status,created_at,settled_at)
        VALUES(?,?,'QUARANTINE',?,'settled',?,?)`, id(), subject, key, now - 1900, now - 1800);
      if (mode === 'subject_moderation') {
        await h.db.run(`INSERT INTO moderation_holds
          (id,subject_id,asset_id,report_id,active,created_at,reason)
          VALUES(?,?,NULL,NULL,1,?,'synthetic hold')`, id(), subject, now - 100);
      } else if (mode === 'other_subject_moderation') {
        await h.db.run(`INSERT INTO moderation_holds
          (id,subject_id,asset_id,report_id,active,created_at,reason)
          VALUES(?,?,NULL,NULL,1,?,'synthetic other-subject hold')`, id(), other.account_id, now - 100);
      } else if (mode === 'subject_deletion_request') {
        await h.db.run(`INSERT INTO privacy_requests
          (id,subject_id,requested_by,request_type,status,created_at,expires_at,legal_hold)
          VALUES(?,?,?,'delete','pending_approval',?,?,1)`, id(), subject, subject, now - 100, now + 60000);
      } else if (mode === 'global_retention') {
        await h.db.run(`INSERT INTO retention_settings
          (id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at)
          VALUES('default',1,60,60,14,2,30,1,?)
          ON CONFLICT(id) DO UPDATE SET legal_hold=1,updated_at=excluded.updated_at`, now - 100);
      } else if (mode === 'unknown_owner') {
        await h.db.run('UPDATE auth_challenges SET account_id=NULL WHERE id=?', challenge);
      }
    });
    const proofBefore = await h.db.one('SELECT object_key FROM auth_capture_proofs WHERE challenge_id=? AND capture_index=0', challenge);
    const objectBefore = await h.env.QUARANTINE.get(key);
    assert.equal(proofBefore?.object_key, key, 'fixture proof was not persisted');
    assert(objectBefore, 'fixture object was not persisted');
    assert.deepEqual(new Uint8Array(await objectBefore.arrayBuffer()), data, 'fixture bytes differ');
    assert.equal(await h.db.one("SELECT id FROM media_write_intents WHERE bucket='QUARANTINE' AND object_key=? AND status='pending'", key), null);
    if (mode === 'subject_moderation') {
      assert(await h.db.one('SELECT id FROM moderation_holds WHERE subject_id=? AND active=1', subject), 'active subject hold missing');
    } else if (mode === 'other_subject_moderation') {
      assert.notEqual(other.account_id, subject, 'fixture subjects must differ');
      assert(await h.db.one('SELECT id FROM moderation_holds WHERE subject_id=? AND active=1', other.account_id), 'other subject hold missing');
      assert.equal(await h.db.one('SELECT id FROM moderation_holds WHERE subject_id=? AND active=1', subject), null);
    } else if (mode === 'subject_deletion_request') {
      assert(await h.db.one("SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled')", subject), 'active deletion-request hold missing');
    } else if (mode === 'global_retention') {
      assert(await h.db.one("SELECT id FROM retention_settings WHERE id='default' AND legal_hold=1"), 'active global hold missing');
    } else {
      assert.equal(await h.db.one('SELECT id FROM moderation_holds WHERE active=1'), null);
      assert.equal(await h.db.one('SELECT id FROM retention_settings WHERE legal_hold=1'), null);
    }

    const realAll = h.db.all.bind(h.db), realOne = h.db.one.bind(h.db), realDelete = h.env.QUARANTINE.delete.bind(h.env.QUARANTINE);
    let selected = 0;
    let holdQueries = 0;
    const deleteCalls = [], fixtureErrors = [];
    h.db.one = async (sql, ...params) => {
      if (sql.includes('SELECT c.account_id,') && ++holdQueries === (mode === 'fault_before_delete' ? 1 : mode === 'fault_after_delete' ? 2 : -1)) {
        const error = new Error('synthetic hold-query failure');
        fixtureErrors.push({ component: 'hold-query', message: error.message });
        throw error;
      }
      return realOne(sql, ...params);
    };
    h.db.all = async (sql, ...params) => {
      try {
        const rows = await realAll(sql, ...params);
        if (sql.includes('SELECT p.* FROM auth_capture_proofs p JOIN auth_challenges c') &&
            rows.some(row => row.challenge_id === challenge && row.capture_index === 0)) selected++;
        return rows;
      } catch (error) {
        fixtureErrors.push({ component: 'database', message: String(error?.message ?? error) });
        throw error;
      }
    };
    h.env.QUARANTINE.delete = async input => {
      deleteCalls.push(input);
      if (input !== key) {
        const error = new Error('unexpected synthetic delete target');
        fixtureErrors.push({ component: 'bucket', message: error.message });
        throw error;
      }
      try {
        if (mode === 'hold_during_delete' && deleteCalls.length === 1) {
          // The provider operation has started: this hold can keep the row for
          // reconciliation, but cannot undo a deletion that already took effect.
          await h.db.transaction(() => h.db.run(`INSERT INTO moderation_holds
            (id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'synthetic late hold')`, id(), subject, Date.now()));
        }
        return await realDelete(input);
      }
      catch (error) { fixtureErrors.push({ component: 'bucket', message: String(error?.message ?? error) }); throw error; }
    };

    await h.db.invocation(() => cleanupFaceProofs(h.app));
    const proofAfter = await h.db.one('SELECT object_key FROM auth_capture_proofs WHERE challenge_id=? AND capture_index=0', challenge);
    const objectAfter = await h.env.QUARANTINE.get(key);
    const objectBytesIntact = !!objectAfter && await hash(new Uint8Array(await objectAfter.arrayBuffer())) === bytesHash;
    const observation = { mode, selected: selected > 0, delete_calls: deleteCalls.length,
      delete_targets_exact: deleteCalls.every(value => value === key),
      object_bytes_intact: objectBytesIntact, proof_row_intact: proofAfter?.object_key === key,
      fixture_errors: fixtureErrors };
    console.log('SYNTHETIC_OBSERVATION ' + JSON.stringify(observation));
    assert.equal(observation.selected, true, 'terminal proof was not selected by the real cleanup scan');
    const injectedFault = mode === 'fault_before_delete' || mode === 'fault_after_delete';
    assert.deepEqual(fixtureErrors, injectedFault ? [{ component: 'hold-query', message: 'synthetic hold-query failure' }] : [],
      'unexpected fixture errors must not masquerade as a hold');
    assert.equal(observation.delete_targets_exact, true, 'cleanup targeted an unexpected object');
    if (mode === 'unheld' || mode === 'other_subject_moderation') {
      assert.deepEqual([observation.delete_calls, observation.object_bytes_intact, observation.proof_row_intact],
        [1, false, false], 'unheld control must delete the synthetic object and retire its proof');
    } else if (mode === 'hold_during_delete' || mode === 'fault_after_delete') {
      assert.deepEqual([observation.delete_calls, observation.object_bytes_intact, observation.proof_row_intact],
        [1, false, true], 'a late hold or failed recheck must leave the proof row for reconciliation');
    } else {
      assert.deepEqual([observation.delete_calls, observation.object_bytes_intact, observation.proof_row_intact],
        [0, true, true], 'a hold or unknown owner must preserve proof bytes and its row');
    }
    if (['subject_moderation', 'subject_deletion_request', 'global_retention'].includes(mode)) {
      await h.db.transaction(async () => {
        if (mode === 'subject_moderation') await h.db.run('UPDATE moderation_holds SET active=0 WHERE subject_id=?', subject);
        if (mode === 'subject_deletion_request') await h.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE subject_id=?', subject);
        if (mode === 'global_retention') await h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
      });
      await h.db.invocation(() => cleanupFaceProofs(h.app));
      assert.deepEqual([deleteCalls.length, await h.env.QUARANTINE.get(key),
        await h.db.one('SELECT object_key FROM auth_capture_proofs WHERE challenge_id=? AND capture_index=0', challenge)],
        [1, null, null], 'cleanup must resume after the pre-existing hold is released');
      assert.deepEqual(fixtureErrors, [], 'a cleanup error must not masquerade as a hold');
    }
  } finally {
    await h.close();
  }
}

for (const mode of ['unheld', 'other_subject_moderation', 'subject_moderation', 'subject_deletion_request', 'global_retention', 'unknown_owner', 'hold_during_delete', 'fault_before_delete', 'fault_after_delete']) {
  pgliteTest(`terminal face proof cleanup: ${mode}`, { timeout: 60000 }, () => exercise(mode));
}
