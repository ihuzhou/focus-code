import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { structuredPatch } from 'diff';

const maxFileSize = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete gitEnv[name];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function repositoryRoot(cwd) {
  try {
    return realpathSync(git(cwd, 'rev-parse', '--show-toplevel').replace(/\r?\n$/, ''));
  } catch {
    return null;
  }
}

export function repositoryBranch(root) {
  try {
    const ref = git(root, 'symbolic-ref', '--quiet', 'HEAD').trim();
    return ref.replace(/^refs\/heads\//, '');
  } catch {
    return 'HEAD';
  }
}

export function repositoryBranches(root) {
  try {
    return git(root, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/').split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

export function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stamp(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function inside(root, path) {
  const local = relative(root, path);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function readEntry(path, stat, signature) {
  const mode = Number(stat.mode & 0o111n) ? '100755' : '100644';
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path, { encoding: 'buffer' });
    return { signature, mode: '120000', fingerprint: hash(target), text: target.toString('utf8'), limitation: null };
  }
  if (stat.size > maxFileSize) {
    return { signature, mode, fingerprint: signature, text: null, limitation: 'large' };
  }
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (stamp(fstatSync(file, { bigint: true })) !== signature) return undefined;
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(file, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length !== Number(stat.size) || stamp(fstatSync(file, { bigint: true })) !== signature) return undefined;
    const content = buffer.subarray(0, length);
    let text = null;
    if (!content.includes(0)) {
      try { text = utf8.decode(content); } catch { /* Non-UTF-8 file */ }
    }
    return { signature, mode, fingerprint: hash(content), text, limitation: text === null ? 'binary' : null };
  } finally {
    closeSync(file);
  }
}

export function scanFiles(root, previous, readPrevious, ownDirectory) {
  const paths = new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean));
  const ownRelative = relative(root, ownDirectory);
  if (inside(root, ownDirectory)) {
    for (const name of paths) {
      if (name.startsWith(`${ownRelative}${sep}`)) paths.delete(name);
    }
  }
  const directories = new Map();
  const updates = [];
  for (const name of previous.keys()) {
    if (!paths.has(name)) updates.push({ path: name, after: null });
  }
  for (const name of paths) {
    const path = join(root, name);
    if (!inside(root, path)) continue;
    const parent = dirname(path);
    try {
      if (!directories.has(parent)) directories.set(parent, realpathSync(parent) === parent);
      if (!directories.get(parent)) {
        if (previous.has(name)) updates.push({ path: name, after: null });
        continue;
      }
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        if (previous.has(name)) updates.push({ path: name, after: null });
        continue;
      }
      const signature = stamp(stat);
      if (previous.get(name) === signature) continue;
      const after = readEntry(path, stat, signature);
      if (after) updates.push({ path: name, after });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        if (previous.has(name)) updates.push({ path: name, after: null });
      } else if (!['EACCES', 'EPERM', 'ELOOP', 'ESTALE'].includes(error.code)) {
        throw error;
      }
    }
  }

  return updates.map(({ path, after }) => {
    const before = previous.has(path) ? readPrevious(path) : null;
    const change = before?.fingerprint !== after?.fingerprint || before?.mode !== after?.mode;
    return { path, before, after, change };
  });
}

export function fileDiff(path, before, after) {
  const status = before ? (after ? 'modified' : 'deleted') : 'added';
  let limitation = after?.limitation ?? before?.limitation ?? null;
  let hunks = [];
  let added = 0;
  let removed = 0;
  if (!limitation) {
    const patch = structuredPatch(path, path, before?.text ?? '', after?.text ?? '', '', '', { context: 3, timeout: 100 });
    hunks = patch?.hunks ?? [];
    if (!patch) limitation = 'complex';
    for (const { lines } of hunks) {
      for (const line of lines) {
        if (line.startsWith('+')) added++;
        if (line.startsWith('-')) removed++;
      }
    }
  }
  return { path, status, limitation, hunks, added, removed, oldMode: before?.mode ?? null, newMode: after?.mode ?? null };
}
