import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal, journalPath } from '../src/journal.js';
import { rememberProject } from '../src/projects.js';
import { serve } from '../src/server.js';

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'focus-storage-test-')));
  const directory = join(home, 'state');
  const journals = [];
  t.after(() => {
    for (const journal of journals) journal.close();
    rmSync(home, { recursive: true, force: true });
  });
  function repo(name, initialize = true) {
    const root = join(home, name);
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const write = (path, text) => writeFileSync(join(root, path), text);
    const journal = initialize ? new Journal(root, directory) : null;
    if (journal) journals.push(journal);
    return { root, git, write, journal };
  }
  return { directory, repo };
}

async function viewer(journal, options, run) {
  const { server, address } = await serve(journal, { port: 0, open: false, ...options });
  try {
    const get = async path => {
      const response = await fetch(new URL(path, address));
      assert.equal(response.status, 200, path);
      return response.json();
    };
    const clear = (body, origin = address.origin) => fetch(new URL('/api/storage', address), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    });
    await run({ get, clear });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('a captured file deletion and the earlier edit remain separate, reviewable operations', async t => {
  const { directory, repo } = fixture(t);
  const { root, git, write, journal } = repo('timeline');
  write('tracked.js', 'baseline\n');
  git('add', '.');
  git('-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.test', 'commit', '--no-gpg-sign', '-qm', 'Baseline');
  journal.poll();
  write('tracked.js', 'edited\n');
  write('scratch.js', 'untracked\n');
  const edit = journal.poll();
  unlinkSync(join(root, 'tracked.js'));
  unlinkSync(join(root, 'scratch.js'));
  const deletion = journal.poll();
  await viewer(journal, { directory }, async ({ get }) => {
    const operations = await get('/api/operations?scope=current');
    assert.deepEqual(operations.changes.map(item => [item.id, item.deleted_count]), [[deletion, 2], [edit, 0]]);
    assert.deepEqual((await get(`/api/changes/${deletion}`)).files.map(item => [item.path, item.status]), [
      ['scratch.js', 'deleted'], ['tracked.js', 'deleted'],
    ]);
    assert.deepEqual((await get(`/api/changes/${deletion}/files/1`))[0].lines, ['-edited']);
    assert.deepEqual((await get(`/api/changes/${edit}/files/1`))[0].lines, ['-baseline', '+edited']);
    const timeline = await get('/api/timeline?scope=current');
    assert.deepEqual(timeline.changes.map(item => item.id), [deletion, edit]);
    assert.equal((await get('/api/current?scope=current')).changes[0].deleted_count, 1);
    write('scratch.js', 'recreated\n');
    const restored = journal.poll();
    const archive = await get('/api/operations?q=scratch.js');
    assert.deepEqual(archive.changes.map(item => item.id), [restored, deletion, edit]);
  });
});

test('storage counts saved batches and bytes, and clears only the requested scope', async t => {
  const { directory, repo } = fixture(t);
  const { root, git, write, journal } = repo('active');
  const other = repo('inactive');
  const orphan = repo('unregistered');
  const empty = repo('empty', false);
  const otherId = rememberProject(other.root, directory);
  const emptyId = rememberProject(empty.root, directory);
  const createRecord = ({ journal, write }) => {
    journal.poll();
    write('other.txt', 'kept on disk\n');
    return journal.poll();
  };
  createRecord(other);
  createRecord(orphan);
  journal.poll();
  write('keep.txt', 'keep on main\n');
  const main = journal.poll();
  git('switch', '-c', 'feature/with-slash');
  journal.poll();
  write('large.txt', `${'long recorded line '.repeat(9000)}\n`);
  const large = journal.poll();
  journal.saveHunkNotes(large, [[0, 0, 'A section note to remove']]);
  unlinkSync(join(root, 'large.txt'));
  const deletedFile = journal.poll();
  journal.db.prepare('INSERT INTO timeline_confirmed VALUES (?, 0)').run(large);
  journal.tracking.update({ defaultEnabled: false });
  await viewer(journal, { directory }, async ({ get, clear }) => {
    const stats = await get('/api/storage');
    const active = stats.projects.find(row => row.root === root);
    const journalFile = journalPath(root, directory);
    assert.equal(stats.records, 5);
    assert.equal(stats.bytes, stats.projects.reduce((bytes, row) => bytes + row.bytes, 0));
    assert.equal(active.bytes, ['', '-wal', '-shm'].reduce((bytes, suffix) => bytes + (statSync(journalFile + suffix, { throwIfNoEntry: false })?.size ?? 0), 0));
    assert.ok(active.bytes > 0);
    assert.deepEqual(active.branches, [{ branch: 'feature/with-slash', records: 2 }, { branch: 'main', records: 1 }]);
    assert.equal(stats.projects.find(row => row.id === emptyId).bytes, 0);
    assert.ok(!existsSync(journalPath(empty.root, directory)));
    assert.equal(stats.projects.find(row => row.root === null).records, 1);
    assert.equal((await clear({ scope: 'all' }, 'https://example.test')).status, 403);
    assert.equal((await clear({ scope: 'branch', project: active.id, branch: '' })).status, 400);
    assert.equal((await clear({ scope: 'project', project: '/invalid/path' })).status, 404);
    const cleared = await (await clear({ scope: 'branch', project: active.id, branch: 'feature/with-slash' })).json();
    assert.deepEqual(cleared, { deleted: 2, reclaimPending: false, failed: [] });
    assert.equal(journal.detail(large), null);
    assert.equal(journal.detail(deletedFile), null);
    assert.equal(journal.detail(main).files[0].path, 'keep.txt');
    assert.deepEqual(journal.db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const table of ['hunk_notes', 'timeline_after', 'timeline_pending', 'timeline_confirmed', 'timeline_deletions', 'files']) {
      assert.equal(journal.db.prepare(`SELECT count(*) count FROM ${table} WHERE change_id IN (?, ?)`).get(large, deletedFile).count, 0);
    }
    assert.ok((await get('/api/storage')).projects.find(row => row.id === active.id).bytes < active.bytes);
    assert.equal((await (await clear({ scope: 'project', project: otherId })).json()).deleted, 1);
    assert.equal(journal.list().stats.changes, 1);
    assert.equal((await (await clear({ scope: 'all' })).json()).deleted, 2);
    assert.equal((await get('/api/storage')).records, 0);
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'keep on main\n');
    assert.equal(readFileSync(join(other.root, 'other.txt'), 'utf8'), 'kept on disk\n');
    assert.equal(journal.tracking.get(root).enabled, false);
    assert.ok(!existsSync(journalPath(empty.root, directory)));
  });
  journal.tracking.update({ defaultEnabled: true });
  journal.poll();
  write('keep.txt', 'next edit\n');
  assert.ok(journal.poll() > deletedFile, 'do not reuse an erased review ID');
});

test('a demo viewer only inventories and clears demo history', async t => {
  const { directory, repo } = fixture(t);
  const demo = repo('demo');
  const real = repo('real');
  for (const { journal, write } of [demo, real]) {
    journal.poll();
    write('new.txt', 'recorded\n');
    journal.poll();
  }
  const realId = rememberProject(real.root, directory);
  await viewer(demo.journal, { directory, demo: true }, async ({ get, clear }) => {
    const { projects } = await get('/api/storage');
    assert.equal(projects.length, 1);
    assert.equal(projects[0].demo, true);
    assert.equal((await clear({ scope: 'project', project: realId })).status, 404);
    assert.equal((await (await clear({ scope: 'all' })).json()).deleted, 1);
    assert.equal(real.journal.list().stats.changes, 1);
  });
});
