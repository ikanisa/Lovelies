import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { insertPreparedSession, prepareSession } from '../src/auth.ts';
import { sessionRetirementScope } from '../src/session-retirement.ts';
import { digest } from './restore-database-fixture.mjs';

const policy = 'face-policy-fixture-v1';

/** Explicit FK-consistent stored-reference fixtures. Enrollment/recovery rows
 * isolate reference classes, rather than claiming a valid optical recovery or
 * enrollment flow. The session fixture uses the canonical session cryptography
 * and weak own-security guard; it does not claim current product/face authority. */
export async function addConsentReference(f, kind, consentID, { revoked = false } = {}) {
  const h = f.h, person = f.person, profile = f.beforeProfile ?? f.profile, now = h.app.now();
  assert(profile);
  if (kind === 'enrollment') {
    const deviceID = await f.otherDevice(), device = await h.db.one('SELECT * FROM auth_devices WHERE id=?', deviceID);
    const challengeID = randomUUID(), id = randomUUID();
    // A used challenge cannot itself cause the active-challenge branch to fence
    // cleanup. The nonrevoked enrollment reference must be detected on its own.
    await h.db.run(`INSERT INTO auth_challenges(id,account_id,device_id,device_revision,purpose,nonce,profile_id,profile_revision,
      policy_version,expires_at,status,created_at,auth_epoch,consent_id,used_at,required_captures)
      VALUES(?,?,?,?,'registration',?,?,?, ?,?,'consumed',?,?,?,?,3)`, challengeID, person.accountId, deviceID,
      device.revision, randomUUID(), profile.id, profile.revision, policy, now + 120000, now, f.original.auth_epoch, consentID, now);
    await h.db.run(`INSERT INTO face_enrollment_intents(account_id,enrollment_key,device_id,device_revision,public_key_digest,
      handle_hash,start_hash,consent_id,policy_version,auth_epoch,challenge_id,generation,created_at,expires_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`, person.accountId, id, deviceID, device.revision,
      digest(device.public_jwk), digest('reference-handle-' + id), digest('reference-start-' + id), consentID, policy,
      f.original.auth_epoch, challengeID, now, now + 86400000, revoked ? now : null);
    return { kind, id, consent_id: consentID, revoked };
  }
  if (kind === 'recovery') {
    const id = randomUUID();
    await h.db.run(`INSERT INTO face_recovery_keys(id,account_id,token_hash,operation_key,profile_id,profile_revision,model_id,
      reference_digest,auth_epoch,profile_epoch,consent_id,policy_version,created_at,expires_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, person.accountId, digest('reference-key-' + id), randomUUID(), profile.id,
      profile.revision, profile.model_id, profile.template_digest, f.original.auth_epoch, profile.auth_epoch,
      consentID, policy, now, now + 86400000, revoked ? now : null);
    return { kind, id, consent_id: consentID, revoked };
  }
  assert.equal(kind, 'session');
  // Another device isolates the consent-reference rule from the same-device
  // peer rule. This session remains valid for its own security/status controls.
  const deviceID = await f.otherDevice(), device = await h.db.one('SELECT * FROM auth_devices WHERE id=?', deviceID);
  const prepared = await prepareSession({ accountId: person.accountId, roles: ['user'], authEpoch: f.original.auth_epoch,
    authMethod: 'registered_face', profileRevision: profile.revision, profileEpoch: profile.auth_epoch,
    consentId: consentID, deviceId: deviceID, deviceRevision: device.revision }, h.app);
  await h.db.transaction(() => insertPreparedSession(prepared, h.app, true));
  if (revoked) await h.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE id=?', now, now, prepared.id);
  return { kind, id: prepared.id, consent_id: consentID, revoked, token: prepared.credentials.access_token };
}

export async function referenceRows(f) {
  return {
    enrollments: await f.h.db.all('SELECT * FROM face_enrollment_intents ORDER BY account_id,enrollment_key'),
    recovery: await f.h.db.all('SELECT * FROM face_recovery_keys ORDER BY id'),
  };
}
export async function assertIsolatedReference(f, reference) {
  const scope = await sessionRetirementScope(f.h.app, f.original);
  assert.equal(scope.peers.length, 0, 'A same-device peer must not mask this consent-reference regression');
  assert.equal(scope.shared.length, 0, 'A second profile-operation reference must not mask the tested class');
  assert.equal(scope.challenges.length, 0, 'A session-bound active challenge must not mask the tested class');
  assert.deepEqual(scope.otherConsentReferences, reference.revoked ? [] : [{ kind: reference.kind, id: reference.id, consent_id: reference.consent_id }]);
  assert.equal(scope.cancelDeviceLifecycle, reference.revoked);
  assert.equal(scope.cancelSessionChallenges, reference.revoked);
}
export async function assertSurvivingSecuritySession(f, reference) {
  if (reference.kind !== 'session' || reference.revoked) return;
  const rows = await f.h.json('/me/sessions', { token: reference.token });
  assert(rows.items.some(row => row.id === reference.id && row.current), 'The independent own-security credential must remain usable');
}

/** Admit exactly one deliberately historical malformed row in this disposable
 * fixture DB. The current CHECK rejects revoked+NULL, so retain the original
 * CHECK as NOT VALID after creating this legacy row. It then continues to
 * enforce all future inserts/updates; production schema files are untouched. */
export async function historicalRevokedNull(f, consentID) {
  const row = await f.h.db.one('SELECT status,revoked_at FROM consents WHERE id=?', consentID);
  assert.equal(row.status, 'revoked'); assert.notEqual(row.revoked_at, null);
  const definitions = (await f.h.engine.query(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid='lovelies_private.consents'::regclass AND contype='c'`)).rows;
  const exact = definitions.filter(value => /status\s*<>\s*'revoked'(?:::text)?/.test(value.definition)
    && /revoked_at IS NOT NULL/.test(value.definition));
  assert.equal(exact.length, 1, 'Expected only the canonical consent revocation-timestamp CHECK');
  const constraint = exact[0], name = '"' + constraint.conname.replaceAll('"', '""') + '"';
  await f.h.engine.exec('BEGIN');
  try {
    await f.h.engine.exec('ALTER TABLE lovelies_private.consents DROP CONSTRAINT ' + name);
    await f.h.engine.query("UPDATE lovelies_private.consents SET revoked_at=NULL WHERE id=$1 AND status='revoked'", [consentID]);
    await f.h.engine.exec('ALTER TABLE lovelies_private.consents ADD CONSTRAINT ' + name + ' ' + constraint.definition + ' NOT VALID');
    await f.h.engine.exec('COMMIT');
  } catch (error) { await f.h.engine.exec('ROLLBACK'); throw error; }
  assert.deepEqual(await f.h.db.one('SELECT status,revoked_at FROM consents WHERE id=?', consentID), { status: 'revoked', revoked_at: null });
}
