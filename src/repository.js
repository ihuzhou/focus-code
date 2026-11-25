import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, rmSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { structuredPatch } from 'diff';
import { addDiffSummaries } from '../web/diff-summary.js';

const maxFileSize = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const execFileAsync = promisify(execFile);
const gitLimits = { timeout: 5000, maxBuffer: 32 * 1024 * 1024 };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete gitEnv[name];

function runGit(cwd, args, encoding) {
  return execFileSync('git', args, { ...gitLimits, cwd, env: gitEnv, encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd, ...args) {
  return runGit(cwd, args, 'utf8');
}

async function runGitAsync(cwd, args, env = gitEnv, { encoding = 'utf8', input } = {}) {
  const pending = execFileAsync('git', args, { ...gitLimits, cwd, env, encoding });
  if (input !== undefined) {
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(input);
  }
  return (await pending).stdout;
}

function gitAsync(cwd, ...args) {
  return runGitAsync(cwd, args);
}

export function repositoryRoot(cwd) {
  try {
    return realpathSync(git(cwd, 'rev-parse', '--show-toplevel').replace(/\r?\n$/, ''));
  } catch {
    return null;
  }
}

export async function nestedWorktrees(root, stateDirectory) {
  // Git's file listings omit ignored trees, which can contain independent repositories.
  // Search breadth-first with a fixed budget; do not descend into another worktree.
  const maxDirectories = 2048;
  const pending = [root];
  const worktrees = [];
  for (let i = 0; i < pending.length; i++) {
    const directory = pending[i];
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    if (directory !== root && entries.some(entry => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
      try {
        const top = await gitAsync(directory, 'rev-parse', '--show-toplevel');
        if (await realpath(top.replace(/\r?\n$/, '')) === directory) {
          worktrees.push(directory);
          continue;
        }
      } catch { /* Invalid .git marker; keep looking below this directory. */ }
    }
    for (const entry of entries) {
      if (pending.length >= maxDirectories) break;
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv') continue;
      const child = join(directory, entry.name);
      if (child !== stateDirectory) pending.push(child);
    }
  }
  return worktrees;
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

function missingEntry(path) {
  try { lstatSync(path); return false; }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code); }
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
    if (!paths.has(name)) updates.push({ path: name, after: null, missing: missingEntry(join(root, name)) });
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
        if (previous.has(name)) updates.push({ path: name, after: null, missing: true });
      } else if (!['EACCES', 'EPERM', 'ELOOP', 'ESTALE'].includes(error.code)) {
        throw error;
      }
    }
  }

  return updates.map(({ path, after, missing }) => {
    const before = previous.has(path) ? readPrevious(path) : null;
    const change = before?.fingerprint !== after?.fingerprint || before?.mode !== after?.mode;
    return { path, before, after, change, missing };
  });
}

export function repositoryHead(root, ref = 'HEAD') {
  try { return git(root, 'rev-parse', '--verify', '--quiet', ref).trim(); }
  catch (error) {
    if (error.status !== 1) throw error;
    return null;
  }
}

const rawDiffArgs = ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];

function parseRawDiff(output) {
  const raw = output.split('\0');
  const entries = new Map();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [mode, newMode, oid, newOid] = raw[i].slice(1).split(' ');
    if (mode === '160000' || newMode === '160000') continue;
    entries.set(raw[i + 1], {
      before: mode === '000000' ? null : { mode, oid },
      after: newMode === '000000' ? null : { mode: newMode, oid: newOid },
    });
  }
  return entries;
}

export function committedDiffPaths(root, base, head) {
  const from = base ?? git(root, 'hash-object', '-t', 'tree', '/dev/null').trim();
  return parseRawDiff(git(root, ...rawDiffArgs, from, head, '--'));
}

export async function mergeTip(root, branch) {
  const ref = branch === 'HEAD'
    ? await gitAsync(root, 'rev-parse', '--verify', '--quiet', 'HEAD')
    : await gitAsync(root, 'show-ref', '--verify', '--hash', `refs/heads/${branch}`);
  return ref.trim();
}

export async function firstParentMerges(root, head) {
  const log = await gitAsync(root, 'log', '--first-parent', '--max-count=512', '--format=%H %P', head, '--');
  const merges = new Map();
  for (const line of log.trim().split('\n')) {
    const [commit, base, otherParent] = line.trim().split(' ');
    if (otherParent) merges.set(base, { commit, base });
  }
  return merges;
}

export async function mergeDiffPaths(root, base, commit) {
  return parseRawDiff(await gitAsync(root, ...rawDiffArgs, base, commit, '--'));
}

export async function mergeBlobs(root, paths) {
  const ids = [...new Set([...paths.values()].flatMap(({ before, after }) => [before?.oid, after?.oid]).filter(Boolean))];
  const data = await runGitAsync(root, ['cat-file', '--batch'], gitEnv, { encoding: 'buffer', input: ids.join('\n') + '\n' });
  const blobs = new Map();
  let offset = 0;
  for (const id of ids) {
    const end = data.indexOf(10, offset);
    if (end === -1) return null;
    const [oid, kind, bytes] = data.toString('ascii', offset, end).split(' ');
    const size = Number(bytes);
    offset = end + 1;
    if (oid !== id || kind !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > maxFileSize || data[offset + size] !== 10) return null;
    const content = data.subarray(offset, offset + size);
    const text = decodeFile(content);
    if (text === null) return null;
    blobs.set(id, { text, fingerprint: hash(content) });
    offset += size + 1;
  }
  return blobs;
}

const untrackedArgs = ['ls-files', '-z', '--others', '--exclude-standard'];
const pathList = output => output.split('\0').filter(Boolean);

export class UntrackedPaths {
  constructor(root) {
    this.root = root;
  }

  async list() {
    try {
      const cached = await this.fromCache();
      if (cached !== null) return cached;
    } catch {
      // Git or the filesystem may not support writing an untracked cache.
      this.signature = null;
    }
    return pathList(await gitAsync(this.root, ...untrackedArgs));
  }

  async fromCache() {
    const { root } = this;
    const source = (await gitAsync(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).replace(/\r?\n$/, '');
    const signature = `${source}\0${stamp(await stat(source, { bigint: true }))}`;
    if (signature !== this.signature) {
      this.signature = null;
      if ((await gitAsync(root, 'rev-parse', '--shared-index-path')).trim()) return null;
      this.directory ??= await mkdtemp(join(tmpdir(), 'focus-index-'));
      this.index = join(this.directory, 'index');
      await copyFile(source, this.index);
      this.signature = signature;
    }
    // Only the private copy is writable by Git; the real staging index stays untouched.
    const env = { ...gitEnv, GIT_INDEX_FILE: this.index, GIT_OPTIONAL_LOCKS: '1' };
    const status = await runGitAsync(root, ['-c', 'core.untrackedCache=true', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false',
      'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--no-renames'], env);
    const loose = pathList(status).filter(line => line.startsWith('?? ')).map(line => line.slice(3));
    const directories = loose.filter(path => path.endsWith('/'));
    if (!directories.length) return loose;
    // Git caches the normal (collapsed) listing. Expand just the untracked directories.
    if (directories.reduce((size, path) => size + Buffer.byteLength(path) + 1, 0) > 64 * 1024) return null;
    const children = await gitAsync(root, '--literal-pathspecs', ...untrackedArgs, '--', ...directories);
    return loose.filter(path => !path.endsWith('/')).concat(pathList(children));
  }

  close() {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }
}

export async function worktreeDiffPaths(root, journalDirectory, head, untracked) {
  const [files, diff] = await Promise.all([
    head ? untracked.list() : gitAsync(root, ...untrackedArgs, '--cached').then(pathList),
    head ? gitAsync(root, ...rawDiffArgs, head, '--') : '',
  ]);
  const entries = new Map(files.map(path => [path, null]));
  for (const [path, { before }] of parseRawDiff(diff)) entries.set(path, before);
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
