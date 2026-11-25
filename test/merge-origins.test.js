import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../src/journal.js';
import { MergeOrigins } from '../src/merge-origins.js';
import { serve } from '../src/server.js';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'focus-merge-')));
  const root = join(dir, 'repo');
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.com',
    '-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-qb', 'main', root]);
  const write = (path, text) => writeFileSync(join(root, path), text);
  write('result.txt', 'before merge\n');
  git('add', '.');
  git('commit', '-qm', 'Baseline');
  git('switch', '-c', 'incoming');
  write('result.txt', 'incoming change\n');
  git('commit', '-qam', 'Incoming code');
  git('switch', 'main');
  write('local.txt', 'only local\n');
  git('add', '.');
  git('commit', '-qm', 'Local code');
  const journal = new Journal(root, join(dir, 'state'));
  journal.poll();
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  git('merge', '--no-ff', '--no-commit', 'incoming');
  return { root, journal, git, write };
}

test('a recorded in-progress merge gets a MERGE annotation once confirmed without hiding the operation', async t => {
  const { journal, git, write } = fixture(t);
  const mergeId = journal.poll();
  const annotations = new MergeOrigins(journal);
  const rows = () => journal.list({ operations: true }).changes;
  assert.equal((await annotations.annotate(rows())).find(row => row.id === mergeId).merge_commit, undefined);
  git('commit', '-qm', 'Complete merge');
  const commit = git('rev-parse', 'HEAD');
  journal.poll();
  assert.equal((await annotations.annotate(rows())).find(row => row.id === mergeId).merge_commit, commit);
  write('result.txt', 'new local edit\n');
  const editId = journal.poll();

  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const response = await fetch(new URL('/api/operations?scope=current', address));
    assert.equal(response.status, 200);
    const list = await response.json();
    assert.equal(list.stats.changes, 2);
    assert.equal(list.changes.find(row => row.id === mergeId).merge_commit, commit);
    assert.equal(list.changes.find(row => row.id === editId).merge_commit, undefined);
    const diff = await fetch(new URL(`/api/changes/${mergeId}/files/0`, address)).then(reply => reply.json());
    assert.deepEqual(diff[0].lines, ['-before merge', '+incoming change']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('mixed local files and a different file revision are not classified as a merge', async t => {
  await t.test('an unrelated file in the same capture', async sub => {
    const { journal, git, write } = fixture(sub);
    write('local.txt', 'also changed locally\n');
    const id = journal.poll();
    git('commit', '-qm', 'Complete merge');
    const records = await new MergeOrigins(journal).annotate(journal.list({ operations: true }).changes);
    assert.equal(records.find(row => row.id === id).merge_commit, undefined);
  });
  await t.test('same path with a different resulting edit', async sub => {
    const { journal, git, write } = fixture(sub);
    write('result.txt', 'local edit recorded during merge\n');
    const id = journal.poll();
    git('commit', '-qm', 'Commit only the staged merge');
    const records = await new MergeOrigins(journal).annotate(journal.list({ operations: true }).changes);
    assert.equal(records.find(row => row.id === id).merge_commit, undefined);
  });
});
