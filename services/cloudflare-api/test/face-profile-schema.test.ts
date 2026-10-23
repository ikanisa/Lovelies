import { describe, it, expect } from 'vitest';
import { schemaFixture } from './schema-fixture';
import { initSchema } from '../src/schema';

describe('v6 face-profile lifecycle migration',()=>{
  it('adds private controls and retirement journals without changing the existing account or registered identity',()=>{
    const f=schemaFixture(),actor=f.actor();
    try {
      const names=['accounts','auth_devices','face_profiles','consents','sessions'];
      const before=Object.fromEntries(names.map(name=>[name,f.db.all('SELECT * FROM '+name)]));
      f.db.run('DROP TABLE face_profile_retirements');
      f.db.run('DROP INDEX face_profile_operation_expiry');f.db.run('DROP TABLE face_profile_operations');
      f.db.run('DROP TABLE face_profile_controls');f.db.run('DROP TABLE face_profile_states');
      f.db.run('DELETE FROM schema_versions WHERE version>=6');
      initSchema(f.db);
      expect(Object.fromEntries(names.map(name=>[name,f.db.all('SELECT * FROM '+name)]))).toEqual(before);
      expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:7});
      expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
      for(const name of ['face_profile_controls','face_profile_states','face_profile_operations','face_profile_retirements'])
        expect(f.db.one('SELECT count(*) n FROM '+name)).toEqual({n:0});
      expect(f.db.one('SELECT identity_state FROM accounts WHERE id=?',actor.accountId)).toEqual({identity_state:'registered_face'});
    } finally {f.close();}
  });
  it('refuses a weaker private control definition without advancing or reinterpreting v5',()=>{
    const f=schemaFixture();
    try {
      f.db.run('DROP TABLE face_profile_controls');
      f.db.run('DELETE FROM schema_versions WHERE version>=6');
      f.db.run('CREATE TABLE face_profile_controls(account_id TEXT,device_id TEXT,control_hash TEXT,expires_at INTEGER)');
      expect(()=>initSchema(f.db)).toThrow('sqlite_schema_migration_required');
      expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:5});
    } finally {f.close();}
  });
});
