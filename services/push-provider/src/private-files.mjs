import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const maximumBytes = 65_536;
const unavailable = () => new Error('private_provider_file_unavailable');
const identityFields = ['dev', 'ino', 'uid', 'gid', 'mode'];
const fileFields = [...identityFields, 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const same = (left, right, fields) => fields.every(field => left[field] === right[field]);

function directoryAllowed(stat, uid, privateParent) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || ![0n, uid].includes(stat.uid)) return false;
  const mode = stat.mode & 0o7777n;
  if (privateParent) return stat.uid === uid && mode === 0o700n;
  // A root-owned sticky temporary directory cannot let another user replace an
  // existing owned private child. The credential's immediate parent is 0700.
  return (mode & 0o022n) === 0n || stat.uid === 0n && (mode & 0o1000n) !== 0n;
}
function fileAllowed(stat, uid) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid &&
    (stat.mode & 0o7777n) === 0o600n && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(maximumBytes);
}

/** Read only the verified descriptor. Metadata/path changes fail before any
 * result is returned; a final pathname is checked but is never reopened/read.
 * These POSIX checks do not attest external ACLs, mounts or root/same-UID trust. */
export async function privateProviderFile(filename) {
  const handles = [];
  let buffer;
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.normalize(filename) !== filename ||
        filename.includes('\0') || typeof process.getuid !== 'function' ||
        !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) throw unavailable();
    const uid = BigInt(process.getuid()), parent = path.dirname(filename), ancestors = [];
    for (let current = parent; ; current = path.dirname(current)) {
      ancestors.unshift(current);
      if (path.dirname(current) === current) break;
      if (ancestors.length > 128) throw unavailable();
    }
    const directories = [];
    for (const name of ancestors) {
      const before = await fs.lstat(name, { bigint: true });
      if (!directoryAllowed(before, uid, name === parent)) throw unavailable();
      const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      const opened = await handle.stat({ bigint: true });
      if (!directoryAllowed(opened, uid, name === parent) || !same(before, opened, identityFields)) throw unavailable();
      directories.push({ name, handle, opened });
    }
    const before = await fs.lstat(filename, { bigint: true });
    if (!fileAllowed(before, uid)) throw unavailable();
    // NONBLOCK also prevents an unexpected special-file substitution from
    // hanging open; fstat still rejects every nonregular descriptor.
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(handle);
    const opened = await handle.stat({ bigint: true });
    if (!fileAllowed(opened, uid) || !same(before, opened, fileFields)) throw unavailable();
    buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length !== Number(opened.size) || length > maximumBytes || !fileAllowed(after, uid) || !same(opened, after, fileFields)) throw unavailable();
    for (const directory of directories) {
      const current = await fs.lstat(directory.name, { bigint: true });
      const retained = await directory.handle.stat({ bigint: true });
      if (!directoryAllowed(current, uid, directory.name === parent) ||
          !directoryAllowed(retained, uid, directory.name === parent) ||
          !same(current, directory.opened, identityFields) || !same(retained, directory.opened, identityFields)) throw unavailable();
    }
    const current = await fs.lstat(filename, { bigint: true });
    const final = await handle.stat({ bigint: true });
    if (!fileAllowed(current, uid) || !fileAllowed(final, uid) ||
        !same(current, opened, fileFields) || !same(final, opened, fileFields)) throw unavailable();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch {
    // No filesystem path, raw provider material or underlying error is exposed.
    throw unavailable();
  } finally {
    buffer?.fill(0);
    const closed = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    if (closed.some(result => result.status === 'rejected')) throw unavailable();
  }
}
