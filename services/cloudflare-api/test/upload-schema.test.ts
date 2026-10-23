import { describe, expect, it } from 'vitest';
import { initSchema } from '../src/schema';
import { schemaFixture } from './schema-fixture';

describe('Additive v7 transfer recovery',()=>{
  it('preserves existing v6 accounts, sessions, references and reviewed data',()=>{
    const f=schemaFixture();try {
      const actor=f.actor();const tables=['accounts','sessions','face_profiles','consents','auth_devices','assets','operations'];
      const before=Object.fromEntries(tables.map(t=>[t,f.db.all('SELECT * FROM '+t)]));
      f.db.run('DROP TABLE upload_chunks');f.db.run('DROP INDEX upload_transfer_expiry');f.db.run('DROP TABLE upload_transfers');
      f.db.run('DELETE FROM schema_versions WHERE version>=7');initSchema(f.db);
      expect(Object.fromEntries(tables.map(t=>[t,f.db.all('SELECT * FROM '+t)]))).toEqual(before);
      expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:7});
      expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(actor.accountId).toBeTruthy();
    } finally {f.close();}
  });
  it('refuses weaker resumable metadata without advancing the migration',()=>{
    const f=schemaFixture();try {
      f.db.run('DROP TABLE upload_chunks');f.db.run('DROP INDEX upload_transfer_expiry');f.db.run('DROP TABLE upload_transfers');
      f.db.run('DELETE FROM schema_versions WHERE version>=7');
      f.db.run('CREATE TABLE upload_transfers(asset_id TEXT PRIMARY KEY,bytes_received INTEGER,state TEXT,expires_at INTEGER)');
      expect(()=>initSchema(f.db)).toThrow('sqlite_schema_migration_required');
      expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:6});
    } finally {f.close();}
  });
});
