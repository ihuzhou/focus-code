import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../src/journal.js';
import { serve } from '../src/server.js';

async function withViewer(journal, directory, run) {
  const { server, address } = await serve(journal, { directory, port: 0, open: false });
  try {
    const get = path => fetch(new URL(path, address));
    const post = (path, body, origin = address.origin) => fetch(new URL(path, address), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    });
    return await run({ get, post });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function json(response) {
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  return body;
}

test('a branch archive travels to a new viewer with no checkout and preserves diff and reviewer notes', async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'focus-archive-test-')));
  const root = join(home, 'sender');
  const sender = join(home, 'sender-state');
  const receiver = join(home, 'receiver-state');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const journal = new Journal(root, sender);
  t.after(() => { journal.close(); rmSync(home, { force: true, recursive: true }); });
  const write = (path, text) => writeFileSync(join(root, path), text);
  write('unchanged.txt', 'baseline must not leave the sender\n');
  write('remove.js', 'const remove = true;\n');
  journal.poll();
  write('main.txt', 'only main\n');
  const main = journal.poll();
  execFileSync('git', ['switch', '-c', 'feature/share'], { cwd: root, stdio: 'ignore' });
  journal.poll();
  journal.startTool('pi', 'private-session-id', 'write', 'edit');
  unlinkSync(join(root, 'remove.js'));
  const deletion = journal.endTool('pi', 'private-session-id', 'write');
  assert.ok(journal.editReason(deletion, 'Remove unused code'));
  assert.equal(journal.saveHunkNotes(deletion, [[0, 0, 'Used nowhere']]), 1);

  const backup = await withViewer(journal, sender, async ({get, post}) => {
    const { selected: id } = await json(await get('/api/projects'));
    const params = new URLSearchParams({ project: id, branch: 'feature/share' });
    const response = await get(`/api/storage/backup?${params}`);
    assert.match(response.headers.get('content-disposition'), /attachment; filename="sender-feature-share\.focus-history\.json"/);
    const archive = await json(response);
    assert.equal(archive.version, 1);
    assert.equal(archive.name, 'sender');
    assert.equal(archive.records.length, 1);
    const packed = JSON.stringify(archive);
    for (const privateField of [root, 'baseline must not leave', 'private-session-id', 'only main']) assert.ok(!packed.includes(privateField));
    assert.equal((await get(`/api/storage/backup?project=${id}&branch=missing`)).status, 404);

    // Deduplication doesn't replace annotations already edited in the destination.
    journal.editReason(deletion, 'Local reason takes priority');
    const duplicate = await json(await post(`/api/storage/restore?target=${id}`, archive));
    assert.equal(duplicate.imported, 0);
    assert.equal(duplicate.skipped, 1);
    assert.equal(journal.detail(deletion).reason, 'Local reason takes priority');
    await json(await post('/api/storage', { scope: 'branch', project: id, branch: 'feature/share' }));
    assert.equal(journal.detail(deletion), null);
    const merge = await json(await post(`/api/storage/restore?target=${id}`, archive));
    assert.deepEqual([merge.id, merge.archived, merge.imported], [id, false, 1]);
    const history = await json(await get(`/api/operations?project=${id}&branch=feature%2Fshare`));
    assert.ok(history.changes[0].id > deletion);
    assert.equal(history.changes[0].reason, 'Remove unused code');
    assert.equal(journal.detail(main).files[0].path, 'main.txt');
    assert.equal(readFileSync(join(root, 'unchanged.txt'), 'utf8'), 'baseline must not leave the sender\n');
    return archive;
  });

  const restoredID = await withViewer(null, receiver, async ({get, post}) => {
    assert.deepEqual((await json(await get('/api/projects'))).projects, []);
    assert.equal((await post('/api/storage/restore', backup, 'https://example.test')).status, 403);
    const invalid = structuredClone(backup);
    invalid.records[0].files[0].path = '../outside';
    assert.equal((await post('/api/storage/restore', invalid)).status, 400);
    assert.deepEqual((await json(await get('/api/projects'))).projects, []);
    const restored = await json(await post('/api/storage/restore', backup));
    assert.equal(restored.archived, true);
    assert.equal(restored.imported, 1);
    const again = await json(await post('/api/storage/restore', backup));
    assert.deepEqual([again.id, again.imported, again.skipped], [restored.id, 0, 1]);
    const { changes, repository } = await json(await get(`/api/operations?scope=current&project=${restored.id}`));
    assert.deepEqual(repository, { root: null, name: 'sender', branch: null, branches: ['feature/share'] });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].deleted_count, 1);
    const diff = await json(await get(`/api/changes/${changes[0].id}/files/0?project=${restored.id}`));
    assert.deepEqual(diff[0].lines, ['-const remove = true;']);
    assert.equal(diff[0].explanation, 'Used nowhere');
    assert.equal((await json(await get(`/api/tracking?project=${restored.id}`))).editable, false);
    assert.equal((await json(await get('/api/storage'))).projects[0].records, 1);
    return restored.id;
  });
  await withViewer(null, receiver, async ({ get }) => {
    const { selected, projects } = await json(await get('/api/projects'));
    assert.deepEqual([selected, projects[0].archived], [restoredID, true]);
    assert.equal((await json(await get('/api/operations'))).changes[0].reason, 'Remove unused code');
  });
});
