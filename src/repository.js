import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { structuredPatch } from 'diff';
import { addDiffSummaries } from '../web/diff-summary.js';

const maxFileSize = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete gitEnv[name];

function runGit(cwd, args, encoding) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding, timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd, ...args) {
  return runGit(cwd, args, 'utf8');
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

function decodeFile(content) {
  if (content.includes(0)) return null;
  try { return utf8.decode(content); }
  catch { return null; }
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
    const text = decodeFile(content);
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

export function worktreeDiffPaths(root, journalDirectory) {
  let head = false;
  try { git(root, 'rev-parse', '--verify', '--quiet', 'HEAD'); head = true; }
  catch (error) {
    if (error.status !== 1) throw error;
  }

  const extra = ['--others', '--exclude-standard'];
  if (!head) extra.unshift('--cached');
  const entries = new Map(git(root, 'ls-files', '-z', ...extra).split('\0').filter(Boolean).map(path => [path, null]));
  if (head) {
    const raw = git(root, 'diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD', '--').split('\0');
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const [mode, newMode, oid] = raw[i].slice(1).split(' ');
      if (mode === '160000' || newMode === '160000') continue;
      entries.set(raw[i + 1], mode === '000000' ? null : { mode, oid });
    }
  }
  const dataRoot = dirname(journalDirectory);
  const nestedState = dataRoot !== root && inside(root, dataRoot);
  const localState = new Set(['projects.sqlite', 'projects.sqlite-wal', 'projects.sqlite-shm', 'tracking.sqlite', 'tracking.sqlite-wal', 'tracking.sqlite-shm']);
  for (const path of entries.keys()) {
    const absolute = join(root, path);
    const focusData = inside(journalDirectory, absolute) || (nestedState && inside(dataRoot, absolute)) || (root === dataRoot && localState.has(path));
    if (!inside(root, absolute) || focusData) entries.delete(path);
  }
  return entries;
}

export function readHeadEntry(root, baseline) {
  if (!baseline) return null;
  const { mode, oid } = baseline;
  const size = Number(git(root, 'cat-file', '-s', oid).trim());
  if (size > maxFileSize) return { mode, fingerprint: oid, text: null, limitation: 'large' };
  const content = runGit(root, ['cat-file', 'blob', oid]);
  const text = decodeFile(content);
  return { mode, fingerprint: hash(content), text, limitation: text === null ? 'binary' : null };
}

export function readWorktreeEntry(root, name, previous = null) {
  const path = join(root, name);
  try {
    if (!inside(root, path) || realpathSync(dirname(path)) !== dirname(path)) return null;
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() && !stat.isSymbolicLink()) return null;
    const signature = stamp(stat);
    if (previous?.signature === signature) return previous;
    const entry = readEntry(path, stat, signature);
    return entry ? { ...entry, time: Number(stat.mtimeMs) } : previous;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    if (['EACCES', 'EPERM', 'ELOOP', 'ESTALE'].includes(error.code)) return previous;
    throw error;
  }
}

export function fileDiff(path, before, after) {
  const status = before ? (after ? 'modified' : 'deleted') : 'added';
  let limitation = after?.limitation ?? before?.limitation ?? null;
  let hunks = [];
  let added = 0;
  let removed = 0;
  if (!limitation) {
    const patch = structuredPatch(path, path, before?.text ?? '', after?.text ?? '', '', '', { context: 3, timeout: 100 });
    hunks = patch ? addDiffSummaries(patch.hunks, after?.text) : [];
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
