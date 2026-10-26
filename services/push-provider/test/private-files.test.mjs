import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { privateProviderFile } from '../src/private-files.mjs';
import { configuredProviders } from '../src/server.mjs';

const failure = problem => problem instanceof Error && problem.message === 'private_provider_file_unavailable' && !problem.cause;
async function fixture(t, content = 'controlled-synthetic-key') {
  const base = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'lovelies-provider-private-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'credential');
  await fs.writeFile(filename, content, { mode: 0o600, flag: 'wx' });
  return { directory, filename };
}

test('owned0700 parent/0600 single-link file is read once through the verified descriptor', async t => {
  const f = await fixture(t); const open = fs.open; let leafOpens = 0; const handles = [];
  t.mock.method(fs, 'open', async function (name, flags, ...rest) {
    const handle = await open.call(this, name, flags, ...rest); handles.push(handle);
    if (name === f.filename) { leafOpens++; assert.ok(flags & constants.O_NOFOLLOW); }
    return handle;
  });
  assert.equal(await privateProviderFile(f.filename), 'controlled-synthetic-key');
  assert.equal(leafOpens, 1);
  for (const handle of handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
});

test('missing/relative/noncanonical paths and empty/oversize/invalidUTF8 files fail with one sanitized error', async t => {
  const f = await fixture(t);
  for (const name of [undefined, '', 'relative-key', f.filename + '\0', path.join(f.directory, 'absent'), f.directory + '/./credential'])
    await assert.rejects(privateProviderFile(name), failure);
  for (const content of [Buffer.alloc(0), Buffer.alloc(65_537, 65), Buffer.from([0xff])]) {
    await fs.writeFile(f.filename, content);
    await assert.rejects(privateProviderFile(f.filename), failure);
  }
  await fs.writeFile(f.filename, Buffer.alloc(65_536, 65));
  assert.equal((await privateProviderFile(f.filename)).length, 65_536);
});

test('broadmode private parents/files, leaf symlinks/hardlinks and directories are refused', async t => {
  const f = await fixture(t);
  for (const mode of [0o644, 0o640, 0o400, 0o660, 0o4600]) {
    await fs.chmod(f.filename, mode); await assert.rejects(privateProviderFile(f.filename), failure);
  }
  await fs.chmod(f.filename, 0o600);
  await fs.chmod(f.directory, 0o755); await assert.rejects(privateProviderFile(f.filename), failure);
  await fs.chmod(f.directory, 0o700);
  const linked = path.join(f.directory, 'linked');
  await fs.symlink(f.filename, linked); await assert.rejects(privateProviderFile(linked), failure);
  await fs.unlink(linked); await fs.link(f.filename, linked);
  await assert.rejects(privateProviderFile(f.filename), failure); await assert.rejects(privateProviderFile(linked), failure);
  await fs.unlink(linked);
  const folder = path.join(f.directory, 'folder'); await fs.mkdir(folder, { mode: 0o700 });
  await assert.rejects(privateProviderFile(folder), failure);
});

test('symlink ancestors and unsafe writable ancestors are refused before credential opening', async t => {
  const f = await fixture(t), parent = path.join(f.directory, 'private'); await fs.mkdir(parent, { mode: 0o700 });
  const key = path.join(parent, 'key'); await fs.writeFile(key, 'synthetic', { mode: 0o600 });
  const alias = path.join(f.directory, 'alias'); await fs.symlink(parent, alias);
  await assert.rejects(privateProviderFile(path.join(alias, 'key')), failure);
  await fs.chmod(f.directory, 0o777); await assert.rejects(privateProviderFile(key), failure);
  await fs.chmod(f.directory, 0o700);
});

test('a special file is rejected before read and a FIFO substitution cannot hang open', async t => {
  const f = await fixture(t), fifo = path.join(f.directory, 'fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' }); assert.equal(made.status, 0);
  await fs.chmod(fifo, 0o600); await assert.rejects(privateProviderFile(fifo), failure);
  const open = fs.open; let substituted = false;
  t.mock.method(fs, 'open', async function (name, flags, ...args) {
    if (name === f.filename) {
      assert.ok(flags & constants.O_NONBLOCK); substituted = true;
      await fs.unlink(f.filename); await fs.rename(fifo, f.filename);
    }
    return open.call(this, name, flags, ...args);
  });
  await assert.rejects(privateProviderFile(f.filename), failure); assert.equal(substituted, true);
});

test('wrongowner path and wrongowner opened-descriptor metadata are refused', async t => {
  const f = await fixture(t), lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async function (name, options) {
    const value = await lstat.call(this, name, options);
    if (name === f.filename) value.uid = BigInt(process.getuid()) + 1n;
    return value;
  });
  await assert.rejects(privateProviderFile(f.filename), failure);
  t.mock.restoreAll();
  const open = fs.open;
  t.mock.method(fs, 'open', async function (name, ...args) {
    const handle = await open.call(this, name, ...args);
    if (name === f.filename) {
      const stat = handle.stat.bind(handle);
      handle.stat = async options => { const value = await stat(options); value.uid = BigInt(process.getuid()) + 1n; return value; };
    }
    return handle;
  });
  await assert.rejects(privateProviderFile(f.filename), failure);
});

test('a symlink replacement between lstat and open is refused without reading the target', async t => {
  const f = await fixture(t), other = path.join(f.directory, 'other'); await fs.writeFile(other, 'other-synthetic', { mode: 0o600 });
  const open = fs.open; let leafOpens = 0;
  t.mock.method(fs, 'open', async function (name, ...args) {
    if (name === f.filename) { leafOpens++; await fs.unlink(f.filename); await fs.symlink(other, f.filename); }
    return open.call(this, name, ...args);
  });
  await assert.rejects(privateProviderFile(f.filename), failure); assert.equal(leafOpens, 1);
});

test('same-size mutation during read is rejected and all opened handles are closed', async t => {
  const f = await fixture(t), open = fs.open, handles = []; let leafOpens = 0;
  t.mock.method(fs, 'open', async function (name, ...args) {
    const handle = await open.call(this, name, ...args); handles.push(handle);
    if (name === f.filename) {
      leafOpens++; const read = handle.read.bind(handle); let changed = false;
      handle.read = async (...values) => {
        const result = await read(...values);
        if (!changed && result.bytesRead) {
          changed = true; await fs.writeFile(f.filename, 'controlled-synthetic-KEY');
          const now = new Date(Date.now() + 5000); await fs.utimes(f.filename, now, now);
        }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(privateProviderFile(f.filename), failure); assert.equal(leafOpens, 1);
  for (const handle of handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
});

test('pathname replacement after the first read is rejected instead of reopening substituted bytes', async t => {
  const f = await fixture(t), replacement = path.join(f.directory, 'replacement'), open = fs.open; let leafOpens = 0;
  await fs.writeFile(replacement, 'replacement-synthetic-key', { mode: 0o600 });
  t.mock.method(fs, 'open', async function (name, ...args) {
    const handle = await open.call(this, name, ...args);
    if (name === f.filename) {
      leafOpens++; const read = handle.read.bind(handle); let changed = false;
      handle.read = async (...values) => { const result = await read(...values); if (!changed && result.bytesRead) { changed = true; await fs.rename(replacement, f.filename); } return result; };
    }
    return handle;
  });
  await assert.rejects(privateProviderFile(f.filename), failure); assert.equal(leafOpens, 1);
});

test('growth or permission changes during read are rejected without returning partial material', async t => {
  for (const mutation of ['grow', 'mode']) {
    const f = await fixture(t), open = fs.open; let changed = false;
    t.mock.method(fs, 'open', async function (name, ...args) {
      const handle = await open.call(this, name, ...args);
      if (name === f.filename) { const read = handle.read.bind(handle); handle.read = async (...values) => {
        const result = await read(...values);
        if (!changed && result.bytesRead) {
          changed = true;
          if (mutation === 'grow') await fs.appendFile(f.filename, Buffer.alloc(70_000, 65));
          else await fs.chmod(f.filename, 0o644);
        }
        return result;
      }; }
      return handle;
    });
    await assert.rejects(privateProviderFile(f.filename), failure); assert.equal(changed, true);
    t.mock.restoreAll();
  }
});

test('a rebound ancestor during read is rejected while the original descriptor remains pinned', async t => {
  const f = await fixture(t), parent = path.join(f.directory, 'private'), moved = path.join(f.directory, 'original');
  await fs.mkdir(parent, { mode: 0o700 }); const filename = path.join(parent, 'key'); await fs.writeFile(filename, 'synthetic', { mode: 0o600 });
  const open = fs.open; let changed = false;
  t.mock.method(fs, 'open', async function (name, ...args) {
    const handle = await open.call(this, name, ...args);
    if (name === filename) { const read = handle.read.bind(handle); handle.read = async (...values) => {
      const result = await read(...values); if (!changed && result.bytesRead) { changed = true; await fs.rename(parent, moved); await fs.mkdir(parent, { mode: 0o700 }); await fs.writeFile(filename, 'substitute', { mode: 0o600 }); } return result;
    }; }
    return handle;
  });
  await assert.rejects(privateProviderFile(filename), failure);
});

test('synthetic APNs/FCM file constructors load safely without any provider request; disabled startup reads none', async t => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = key => key.export({ type: 'pkcs8', format: 'pem' });
  const f = await fixture(t, pem(ec.privateKey)), accountPath = path.join(f.directory, 'service-account.json');
  await fs.writeFile(accountPath, JSON.stringify({ type: 'service_account', project_id: 'controlled-project', client_email: 'push@controlled-project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token', private_key: pem(rsa.privateKey) }), { mode: 0o600 });
  let calls = 0; t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('Provider request forbidden in this test'); });
  assert.deepEqual(await configuredProviders({ APNS_PRIVATE_KEY_FILE: '/unreadable-not-a-key', FCM_SERVICE_ACCOUNT_FILE: '/unreadable-not-an-account' }), {});
  const providers = await configuredProviders({ PUSH_PROVIDER_SEND_ENABLED: 'true', APNS_PRIVATE_KEY_FILE: f.filename, APNS_TEAM_ID: 'ABCDEFGHIJ', APNS_KEY_ID: '1234567890', APNS_TOPIC: 'com.lovelies.memories', APNS_ENVIRONMENT: 'sandbox', FCM_SERVICE_ACCOUNT_FILE: accountPath, FCM_PROJECT_ID: 'controlled-project', ANDROID_PACKAGE_NAME: 'com.lovelies.memories' });
  assert.deepEqual(Object.keys(providers).sort(), ['android', 'ios']); assert.equal(calls, 0);
  await Promise.all(Object.values(providers).map(provider => provider.close()));
  await fs.chmod(accountPath, 0o644);
  await assert.rejects(configuredProviders({ PUSH_PROVIDER_SEND_ENABLED: 'true', FCM_SERVICE_ACCOUNT_FILE: accountPath, FCM_PROJECT_ID: 'controlled-project', ANDROID_PACKAGE_NAME: 'com.lovelies.memories' }), failure);
});
