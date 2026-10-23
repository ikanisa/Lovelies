import { DatabaseSync } from 'node:sqlite';
import { SqlDatabase, type SqlTransactionPort } from '../src/database';
import { initSchema } from '../src/schema';
import { ApiError, type Actor, type AppContext, type CloudflareEnv } from '../src/types';
import { assertActor } from '../src/auth';

export class FixtureBucket {
  readonly values = new Map<string, Uint8Array>();
  onPut?: (key: string) => Promise<void> | void;
  onGet?: (key: string) => Promise<void> | void;
  onDelete?: (key: string) => Promise<void> | void;
  refuseDelete = false;
  async put(key: string, body: ArrayBuffer | Uint8Array): Promise<unknown> {
    await this.onPut?.(key);
    this.values.set(key, new Uint8Array(body instanceof ArrayBuffer ? body : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)).slice());
    return {};
  }
  async head(key: string): Promise<unknown> {
    const value = this.values.get(key); return value ? { size: value.byteLength } : null;
  }
  async get(key: string): Promise<unknown> {
    await this.onGet?.(key); const value = this.values.get(key)?.slice();
    return value ? { size: value.byteLength, arrayBuffer: async () => value.slice().buffer } : null;
  }
  async delete(key: string): Promise<void> {
    await this.onDelete?.(key); if (!this.refuseDelete) this.values.delete(key);
  }
}

export function schemaFixture() {
  const sql = new DatabaseSync(':memory:'); sql.exec('PRAGMA foreign_keys=ON');
  let consumed = 0, depth = 0, time = Date.now();
  const storage: SqlTransactionPort = {
    sql: { exec(query, ...bindings) {
      const statement = sql.prepare(query);
      return { toArray() {
        consumed++;
        return statement.all(...bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value)) as Record<string,unknown>[];
      } };
    } },
    transactionSync<T>(callback: () => T): T {
      const level = depth++, savepoint = 'fixture_' + level;
      sql.exec(level ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
      try { const value = callback(); sql.exec(level ? 'RELEASE ' + savepoint : 'COMMIT'); return value; }
      catch (error) { sql.exec(level ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK'); if (level) sql.exec('RELEASE ' + savepoint); throw error; }
      finally { depth--; }
    },
  };
  const db = new SqlDatabase(storage); initSchema(db);
  const photos = new FixtureBucket(), quarantine = new FixtureBucket(), exports = new FixtureBucket();
  const sent: unknown[] = [];
  const env = { PHOTOS: photos, QUARANTINE: quarantine, PRIVACY_EXPORTS: exports,
    PHOTO_JOBS: { send: async (value: unknown) => { sent.push(value); } },
    FACE_AUTH_POLICY_VERSION: 'fixture-policy-v1', PHOTO_CONSENT_POLICY_VERSION: 'fixture', APP_ENV: 'test' } as unknown as CloudflareEnv;
  let active: Actor | undefined;
  const ctx: AppContext = { db, env, now: () => time,
    authenticate: async () => { if (!active) throw new ApiError(401,'authentication_required'); return active; },
    assertActor: actor => assertActor(actor,ctx) };
  const actor = (roles: string[] = ['user'], anonymous = false): Actor => {
    const accountId = crypto.randomUUID(), sessionId = crypto.randomUUID(), consent = crypto.randomUUID(), device = crypto.randomUUID(), profile = crypto.randomUUID();
    const revision = crypto.randomUUID(), deviceRevision = crypto.randomUUID();
    db.run('INSERT INTO accounts(id,name,roles_json,auth_epoch,identity_state,created_at) VALUES(?,?,?,?,?,?)', accountId,'Fixture member',JSON.stringify(roles),1,anonymous?'anonymous':'registered_face',time);
    if (!anonymous) {
      db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,profile_revision) VALUES(?,?,'face_authentication',?,'granted',?,?)",consent,accountId,env.FACE_AUTH_POLICY_VERSION!,time,revision);
      db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,?,'active',?)",device,accountId,'{}',deviceRevision,time);
      db.run("INSERT INTO face_profiles(account_id,id,revision,model_id,template_key,template_digest,status,auth_enabled,auth_epoch,auth_consent_id) VALUES(?,?,?,?,?,?,'active',1,1,?)",accountId,profile,revision,'fixture-model-v1','private/template/'+accountId,'a'.repeat(64),consent);
      photos.values.set('private/template/'+accountId,new TextEncoder().encode('synthetic-template'));
    }
    db.run('INSERT INTO sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,face_profile_revision,face_consent_id,device_id,created_at,face_profile_epoch,device_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      sessionId,accountId,'fixture-refresh-'+sessionId,time+900000,time+2592000000,1,anonymous?'anonymous':'registered_face',anonymous?null:revision,anonymous?null:consent,anonymous?null:device,time,anonymous?null:1,anonymous?null:deviceRevision);
    return {accountId,sessionId,roles,expiresAt:time+900000,authEpoch:1,authMethod:anonymous?'anonymous':'registered_face'};
  };
  return {db,ctx,sql,storage,photos,quarantine,exports,sent,actor,
    setActor:(value:Actor)=>{active=value;}, advance:(ms:number)=>{time+=ms;}, consumed:()=>consumed, close:()=>sql.close()};
}
