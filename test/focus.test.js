import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { install } from '../src/install.js';
import { Journal } from '../src/journal.js';
import { ProjectCatalog } from '../src/projects.js';
import { UntrackedPaths } from '../src/repository.js';
import { serve } from '../src/server.js';
import { TrackingSettings } from '../src/tracking.js';
import { addDiffSummaries, describeHunk } from '../web/diff-summary.js';
import { timeBounds } from '../web/time-range.js';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'focus-test-')));
  const root = join(dir, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const journal = new Journal(root, join(dir, 'state'));
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const write = (path, text) => writeFileSync(join(root, path), text);
  return { dir, root, journal, write };
}

test('an agent edit records its own delta and consumes its reason only after a write', t => {
  const { journal, write } = fixture(t);
  write('app.ts', 'const a = 1;\n');
  journal.poll();
  assert.equal(journal.list().stats.changes, 0);
  write('app.ts', 'const a = 2;\n');
  journal.setReason('codex', 's1', 'Prevent stale values');
  journal.startTool('codex', 's1', 'read-only-shell', 'Bash');
  assert.equal(journal.endTool('codex', 's1', 'read-only-shell'), null);
  journal.startTool('codex', 's1', 'apply', 'apply_patch');
  write('app.ts', 'const a = 3;\n');
  assert.equal(journal.poll(), null);
  assert.equal(journal.endTool('codex', 's1', 'apply'), 2);
  assert.equal(journal.endTool('codex', 's1', 'apply'), null);
  write('app.ts', 'const a = 4;\n');
  journal.poll();
  const entries = journal.list().changes;
  assert.deepEqual(entries.map(change => [change.source, change.reason]), [
    ['workspace', null], ['codex', 'Prevent stale values'], ['workspace', null],
  ]);
  assert.deepEqual(journal.patch(2, 0)[0].lines, ['-const a = 2;', '+const a = 3;']);
  assert.equal(journal.list({ source: 'codex', search: 'APP.TS' }).changes[0].id, 2);
  assert.equal(journal.list({ limit: 1 }).hasMore, true);
  assert.equal(journal.list({ before: 2 }).changes[0].id, 1);
});

test('parallel tools share a batch and overlapping sessions stay unattributed', t => {
  const { journal, write } = fixture(t);
  journal.poll();
  journal.setReason('pi', 's1', 'Create two files');
  journal.startTool('pi', 's1', 'a', 'write');
  journal.startTool('pi', 's1', 'b', 'write');
  write('a.ts', 'a\n');
  write('b.ts', 'b\n');
  assert.equal(journal.endTool('pi', 's1', 'a'), null);
  assert.equal(journal.endTool('pi', 's1', 'b'), 1);
  assert.equal(journal.detail(1).file_count, 2);
  assert.equal(journal.detail(1).reason_origin, 'agent');
  journal.setReason('pi', 's1', 'Pi reason');
  journal.startTool('pi', 's1', 'c', 'write');
  journal.startTool('claude', 's2', 'c', 'Edit');
  write('a.ts', 'both sessions\n');
  write('b.ts', 'both sessions\n');
  journal.endTool('claude', 's2', 'c');
  journal.endTool('pi', 's1', 'c');
  assert.equal(journal.detail(2).source, 'mixed');
  assert.equal(journal.detail(2).reason, null);
  journal.startTool('pi', 's1', 'd', 'write');
  write('a.ts', 'new unrelated edit\n');
  journal.endTool('pi', 's1', 'd');
  assert.equal(journal.detail(3).source, 'pi');
  assert.equal(journal.detail(3).reason, null);
});

test('workspace scans record deletions and binary changes and honor git ignore rules', t => {
  const { journal, root, dir, write } = fixture(t);
  write('.gitignore', '*.log\n');
  write('delete.txt', 'gone\n');
  journal.poll();
  write('secret.log', 'ignored\n');
  const outside = join(dir, 'outside');
  writeFileSync(outside, 'external content');
  symlinkSync(outside, join(root, 'pointer'));
  write('data.bin', Buffer.from([1, 0, 1]));
  unlinkSync(join(root, 'delete.txt'));
  journal.poll();
  const files = journal.detail(1).files;
  assert.deepEqual(files.map(item => [item.path, item.status, item.limitation]), [
    ['data.bin', 'added', 'binary'], ['delete.txt', 'deleted', null], ['pointer', 'added', null],
  ]);
  assert.equal(journal.patch(1, 2)[0].lines[0], `+${outside}`);
});

test('install preserves existing settings, and generated hooks bind reasons to the correct session', t => {
  const { dir, root, journal, write } = fixture(t);
  mkdirSync(join(root, '.claude'));
  write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
  const file = install(root, 'claude');
  install(root, 'claude');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(config.permissions.allow, ['Read']);
  assert.equal(config.hooks.Stop.length, 2);
  const hook = (kind, session, name, input) => {
    const command = config.hooks[kind][0].hooks[0].command;
    return execFileSync('/bin/sh', ['-c', command], {
      input: JSON.stringify({ cwd: root, session_id: session, tool_use_id: 'one', tool_name: name, tool_input: input, hook_event_name: kind }),
      env: { ...process.env, FOCUS_HOME: join(dir, 'state') }, encoding: 'utf8',
    });
  };
  assert.match(readFileSync(join(root, '.claude', 'skills', 'focus-code', 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  assert.equal(config.hooks.UserPromptExpansion[0].matcher, '^focus-code$');
  assert.match(JSON.parse(hook('UserPromptSubmit', 's1')).hookSpecificOutput.additionalContext, /focus-reason/);
  hook('PreToolUse', 's1', 'Bash', { command: ': # focus-reason: Keep the greeting consistent' });
  hook('PreToolUse', 's2', 'Write');
  write('greeting.txt', 'hi\n');
  hook('PostToolUse', 's2', 'Write');
  hook('PreToolUse', 's1', 'Edit');
  write('greeting.txt', 'hello\n');
  const post = JSON.parse(hook('PostToolUseFailure', 's1', 'Edit'));
  assert.match(post.hookSpecificOutput.additionalContext, /\[0, 0\] "greeting\.txt"/);
  assert.match(post.systemMessage, /\/focus-code show/);
  assert.equal(journal.detail(1).reason, null);
  assert.equal(journal.detail(2).reason, 'Keep the greeting consistent');
  const note = { command: ': # focus-explain: {"change":2,"notes":[[0,0,"Use the canonical greeting"]]}' };
  assert.match(hook('PostToolUse', 's2', 'Bash', note), /unknown change/);
  hook('PostToolUse', 's1', 'Bash', note);
  assert.equal(journal.patch(2, 0)[0].explanation, 'Use the canonical greeting');
  journal.saveHunkNotes(2, [[0, 0, 'Human correction']]);
  hook('PostToolUse', 's1', 'Bash', note);
  assert.equal(journal.patch(2, 0)[0].explanation, 'Human correction');
  hook('PreToolUse', 's1', 'Edit');
  write('greeting.txt', 'salutations\n');
  assert.equal(JSON.parse(hook('PostToolUse', 's1', 'Edit')).systemMessage, undefined);
});

test('one Claude user hook discovers independent worktrees and routes an external file edit by path', t => {
  const { dir, root } = fixture(t);
  const other = join(dir, 'another-repo');
  const profile = join(dir, 'claude-profile');
  const state = join(dir, 'isolated-state');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  mkdirSync(profile);
  const target = join(profile, 'custom.json');
  const settings = join(profile, 'settings.json');
  writeFileSync(target, JSON.stringify({ permissions: { allow: ['Read'] } }), { mode: 0o600 });
  symlinkSync(target, settings);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: profile, FOCUS_HOME: state };
  const cli = (args, cwd = dir) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(cli(['install', 'claude', '--global']).trim(), settings);
  assert.equal(cli(['install', 'claude']).trim(), settings);
  const cfg = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(cfg.permissions, { allow: ['Read'] });
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.equal(readlinkSync(settings), target);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(existsSync(join(root, '.claude')), false);
  assert.equal(existsSync(join(other, '.claude')), false);

  const hook = (kind, cwd, id, tool, input) => execFileSync('/bin/sh', ['-c', cfg.hooks[kind][0].hooks[0].command], {
    input: JSON.stringify({ cwd, session_id: 's1', tool_use_id: id, tool_name: tool, tool_input: input, hook_event_name: kind }),
    cwd, env, encoding: 'utf8',
  });
  const catalog = new ProjectCatalog(null, { directory: state });
  try {
    assert.match(hook('UserPromptSubmit', root), /focus-reason/);
    assert.deepEqual(catalog.list(), []);
    hook('PreToolUse', root, 'read-only', 'Bash', { command: 'git status' });
    hook('PostToolUse', root, 'read-only', 'Bash', { command: 'git status' });
    assert.deepEqual(catalog.list(), []);
    const mutate = (cwd, file, content) => {
      const input = { file_path: file };
      hook('PreToolUse', cwd, content, 'Write', input);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${content}\n`);
      return JSON.parse(hook('PostToolUse', cwd, content, 'Write', input)).hookSpecificOutput.additionalContext;
    };
    mutate(root, join(root, 'one.js'), 'first');
    const noteContext = mutate(root, join(other, 'new', 'two.js'), 'second');
    assert.equal(catalog.list().length, 2);
    const first = catalog.list().find(item => item.root === root);
    const second = catalog.list().find(item => item.root === other);
    assert.ok(first && second);
    assert.ok(noteContext.includes(second.id));
    const explanation = { change: 1, project: second.id, notes: [[0, 0, 'Explain across project boundaries']] };
    hook('PostToolUse', root, 'annotation', 'Bash', { command: `: # focus-explain: ${JSON.stringify(explanation)}` });
    assert.equal(catalog.get(first.id).journal.detail(1).files[0].path, 'one.js');
    assert.equal(catalog.get(second.id).journal.detail(1).files[0].path, 'new/two.js');
    assert.equal(catalog.get(first.id).journal.patch(1, 0)[0].explanation, undefined);
    assert.equal(catalog.get(second.id).journal.patch(1, 0)[0].explanation, 'Explain across project boundaries');
  } finally {
    catalog.close();
  }
});

test('Codex user-level installation preserves existing hooks and registers the Focus Code skill once', t => {
  const { dir, root } = fixture(t);
  const profile = join(dir, 'codex-profile');
  const user = join(dir, 'home');
  mkdirSync(profile);
  mkdirSync(user);
  const path = join(profile, 'hooks.json');
  const original = { matcher: '^Bash$', hooks: [{ type: 'command', command: 'true' }] };
  writeFileSync(path, JSON.stringify({ description: 'Existing hooks', hooks: { PreToolUse: [original] } }));
  const cli = () => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), 'install', 'codex', '--global'], {
    cwd: root, env: { ...process.env, HOME: user, CODEX_HOME: profile }, encoding: 'utf8',
  }).trim();
  assert.equal(cli(), path);
  const after = readFileSync(path, 'utf8');
  assert.equal(cli(), path);
  assert.equal(readFileSync(path, 'utf8'), after);
  const config = JSON.parse(after);
  assert.equal(config.description, 'Existing hooks');
  assert.deepEqual(config.hooks.PreToolUse[0], original);
  assert.match(config.hooks.UserPromptSubmit[0].hooks[0].command, /hook codex$/);
  assert.match(readFileSync(join(user, '.agents/skills/focus-code/SKILL.md'), 'utf8'), /\$focus-code show/);
  assert.match(readFileSync(join(user, '.agents/skills/focus-code/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
});

test('Gemini hooks pair simultaneous calls without IDs and preserve native context output', t => {
  const { dir, root, write } = fixture(t);
  const directory = join(dir, 'gemini-state');
  const env = { ...process.env, FOCUS_HOME: directory, GEMINI_CLI_HOME: join(dir, 'gemini-home') };
  const cli = (...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  const settings = cli('install', 'gemini', '--global').trim();
  cli('install', 'gemini', '--global');
  const hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks;
  assert.equal(hooks.BeforeTool.length, 1);
  assert.equal(hooks.BeforeTool[0].hooks[0].timeout, 15000);
  const hook = (kind, tool, input) => JSON.parse(execFileSync('/bin/sh', ['-c', hooks[kind][0].hooks[0].command], {
    input: JSON.stringify({ cwd: root, session_id: 'gemini-session', tool_name: tool, tool_input: input, hook_event_name: kind }),
    cwd: root, env, encoding: 'utf8',
  }));
  assert.equal(hook('BeforeAgent').hookSpecificOutput.hookEventName, 'BeforeAgent');
  hook('BeforeTool', 'run_shell_command', { command: ': # focus-reason: Document test states' });
  hook('BeforeTool', 'write_file', { file_path: join(root, 'first.js') });
  hook('BeforeTool', 'write_file', { file_path: join(root, 'second.js') });
  write('first.js', 'export const first = 1;\n');
  assert.deepEqual(hook('AfterTool', 'write_file', { file_path: join(root, 'first.js') }), {});
  write('second.js', 'export const second = 2;\n');
  const { hookSpecificOutput } = hook('AfterTool', 'write_file', { file_path: join(root, 'second.js') });
  assert.equal(hookSpecificOutput.hookEventName, 'AfterTool');
  assert.match(hookSpecificOutput.additionalContext, /\[0, 0\] "first\.js"/);
  assert.match(hookSpecificOutput.additionalContext, /\[1, 0\] "second\.js"/);
  const catalog = new ProjectCatalog(null, { directory });
  try {
    const journal = catalog.get().journal;
    assert.equal(journal.list({ source: 'gemini' }).changes.length, 1);
    assert.equal(journal.detail(1).reason, 'Document test states');
    assert.match(hook('AfterTool', 'run_shell_command', { command: ': # focus-explain: {"change":1,"notes":[[1,0,"Expose the second test state"]]}' }).hookSpecificOutput.additionalContext, /saved 1/);
    assert.equal(journal.patch(1, 1)[0].explanation, 'Expose the second test state');
  } finally {
    catalog.close();
  }
});

test('TRAE desktop hooks keep existing settings and record the active workspace with segment notes', t => {
  const { dir, root, write } = fixture(t);
  const directory = join(dir, 'trae-state');
  const profile = join(dir, 'trae-home');
  const china = join(profile, '.trae-cn');
  mkdirSync(china, { recursive: true });
  writeFileSync(join(china, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'true' }] }] } }));
  const env = { ...process.env, HOME: profile, FOCUS_HOME: directory, TRAE_PROJECT_DIR: root };
  const cli = (...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  cli('install', 'trae', '--global');
  cli('install', 'trae', '--global');
  const { version, hooks } = JSON.parse(readFileSync(join(china, 'hooks.json'), 'utf8'));
  assert.equal(version, 1);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.SessionStart[0].hooks[0].command, 'true');
  assert.equal(hooks.PreToolUse[0].matcher, '^(RunCommand|Write|Edit)$');
  assert.ok(existsSync(join(profile, '.trae', 'hooks.json')));
  const hook = (kind, tool, input) => execFileSync('/bin/sh', ['-c', hooks[kind][0].hooks[0].command], {
    input: JSON.stringify({ workspace_roots: [root], session_id: 'desktop-session', tool_use_id: tool, tool_name: tool, tool_input: input, hook_event_name: kind }),
    cwd: root, env, encoding: 'utf8',
  });
  assert.match(hook('UserPromptSubmit'), /focus-reason/);
  hook('PreToolUse', 'RunCommand', { command: ': # focus-reason: Keep the startup contract explicit' });
  hook('PreToolUse', 'Write', { path: 'startup.js' });
  write('startup.js', 'export const startup = true;\n');
  assert.match(hook('PostToolUse', 'Write', { path: 'startup.js' }), /startup\.js/);
  hook('PostToolUse', 'RunCommand', { command: ': # focus-explain: {"change":1,"notes":[[0,0,"Expose startup state for callers"]]}' });
  const catalog = new ProjectCatalog(null, { directory });
  try {
    const journal = catalog.get().journal;
    assert.equal(journal.list({ source: 'trae' }).changes[0].reason, 'Keep the startup contract explicit');
    assert.equal(journal.patch(1, 0)[0].explanation, 'Expose startup state for callers');
  } finally {
    catalog.close();
  }
});

test('TRAE CLI marketplace installs a separate native hook bundle via the client plugin commands', t => {
  const { dir, root, write } = fixture(t);
  const directory = join(dir, 'cli-state');
  const binary = join(dir, 'traex-stub');
  const log = join(dir, 'cli-log');
  writeFileSync(binary, `#!/bin/sh\nif [ "$2" = "--help" ]; then printf 'Commands:\\n  install   Install a plugin\\n'; else printf '%s\\n' "$*" >> "$FOCUS_TEST_CLI_LOG"; fi\n`, { mode: 0o700 });
  const env = { ...process.env, FOCUS_HOME: directory, TRAECLI_BIN: binary, FOCUS_TEST_CLI_LOG: log };
  const cli = (...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  const marketplace = cli('install', 'trae-cli', '--global').trim();
  assert.equal(readFileSync(log, 'utf8'), `plugin marketplace add ${marketplace}\nplugin install focus-code@focus-code-local\n`);
  const bundle = join(marketplace, 'plugins', 'focus-code');
  const manifest = JSON.parse(readFileSync(join(bundle, '.codex-plugin', 'plugin.json'), 'utf8'));
  const { hooks } = JSON.parse(readFileSync(join(bundle, manifest.hooks), 'utf8'));
  const hook = (kind, tool, input) => execFileSync('/bin/sh', ['-c', hooks[kind][0].hooks[0].command], {
    input: JSON.stringify({ cwd: root, session_id: 'terminal-session', tool_use_id: tool, tool_name: tool, tool_input: input, hook_event_name: kind }),
    cwd: root, env, encoding: 'utf8',
  });
  assert.match(hook('UserPromptSubmit'), /focus-reason/);
  hook('PreToolUse', 'Bash', { command: ': # focus-reason: Simplify the exported state' });
  hook('PreToolUse', 'apply_patch', { command: 'patch' });
  write('state.js', 'export const ready = true;\n');
  assert.match(hook('PostToolUse', 'apply_patch', { command: 'patch' }), /state\.js/);
  hook('PostToolUse', 'Bash', { command: ': # focus-explain: {"change":1,"notes":[[0,0,"Expose the ready state"]]}' });
  const catalog = new ProjectCatalog(null, { directory });
  try {
    const journal = catalog.get().journal;
    assert.equal(journal.list({ source: 'trae-cli' }).changes[0].reason, 'Simplify the exported state');
    assert.equal(journal.patch(1, 0)[0].explanation, 'Expose the ready state');
  } finally {
    catalog.close();
  }
});

test('code segments are independent, searchable and validated as a batch', t => {
  const { journal, write } = fixture(t);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  write('app.js', lines.join('\n') + '\n');
  journal.poll();
  journal.startTool('pi', 'session', 'call', 'edit');
  lines[1] = 'validate at entry';
  lines[17] = 'use the validated value';
  write('app.js', lines.join('\n') + '\n');
  const id = journal.endTool('pi', 'session', 'call');
  const actor = { source: 'pi', session: 'session' };
  assert.equal(journal.patch(id, 0).length, 2);
  assert.equal(journal.saveHunkNotes(id, [[0, 0, 'Reject malformed input'], [0, 7, 'Invalid segment']], actor), null);
  assert.equal(journal.patch(id, 0)[0].explanation, undefined);
  assert.equal(journal.saveHunkNotes(id, [[0, 0, 'Reject malformed input'], [0, 1, 'Reuse the validation result']], actor), 2);
  assert.deepEqual(journal.patch(id, 0).map(hunk => hunk.explanation), ['Reject malformed input', 'Reuse the validation result']);
  assert.equal(journal.list({ search: 'malformed' }).changes[0].id, id);
  journal.saveHunkNotes(id, [[0, 0, '']]);
  assert.equal(journal.patch(id, 0)[0].explanation, undefined);
  assert.equal(journal.patch(id, 0)[1].explanation, 'Reuse the validation result');
});

test('branch choices include local and historical branches and scope timeline filters and pagination', async t => {
  const { root, journal, write } = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.test', 'commit', '--allow-empty', '--no-gpg-sign', '-qm', 'Initial commit');
  git('branch', 'empty');
  git('branch', 'feature/review');
  journal.poll();
  write('same.js', 'main\n');
  journal.poll();
  git('switch', 'feature/review');
  journal.poll();
  journal.setReason('pi', 'session', 'Review call-site behavior');
  journal.startTool('pi', 'session', 'edit', 'write');
  write('same.js', 'feature\n');
  journal.endTool('pi', 'session', 'edit');
  write('only-feature.js', 'workspace change\n');
  journal.poll();
  git('switch', 'main');
  git('branch', '-D', 'feature/review');
  journal.poll();

  const feature = journal.list({ branch: 'feature/review', limit: 1 });
  assert.deepEqual(feature.repository.branches, ['empty', 'feature/review', 'main']);
  assert.equal(feature.repository.branch, 'main');
  assert.equal(feature.stats.changes, 2);
  assert.equal(feature.hasMore, true);
  const next = journal.list({ branch: 'feature/review', before: feature.changes[0].id, limit: 1 });
  assert.deepEqual(next.changes.map(change => change.branch), ['feature/review']);
  assert.equal(next.hasMore, false);
  assert.equal(journal.list({ branch: 'empty' }).stats.changes, 0);

  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const get = async params => fetch(new URL(`/api/changes?${new URLSearchParams(params)}`, address)).then(response => response.json());
    const filtered = await get({ branch: 'feature/review', source: 'pi', q: 'review call' });
    assert.equal(filtered.changes.length, 1);
    assert.equal(filtered.changes[0].branch, 'feature/review');
    assert.deepEqual((await get({ branch: 'main', source: 'pi', q: 'review call' })).changes, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('show reuses the local viewer for the same state and opens the current project URL', async t => {
  const { dir, root, journal } = fixture(t);
  const directory = join(dir, 'state');
  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), 'show', '--no-open'], {
      cwd: root, env: { ...process.env, FOCUS_HOME: directory }, timeout: 5000,
    });
    const link = new URL(stdout.trim());
    assert.equal(link.origin, address.origin);
    const projects = await fetch(new URL('/api/projects', link)).then(response => response.json());
    assert.equal(link.searchParams.get('project'), projects.selected);
    assert.equal(projects.projects[0].root, root);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('global and worktree switches gate hooks and polling and start a fresh baseline on resume', async t => {
  const { dir, root, journal, write } = fixture(t);
  const directory = join(dir, 'state');
  const other = join(dir, 'another-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  journal.poll();
  write('status.js', 'first\n');
  journal.poll();
  const initial = journal.detail(1);
  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const read = async path => fetch(new URL(path, address)).then(response => response.json());
    const post = (path, body) => fetch(new URL(path, address), {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: address.origin },
    });
    const primary = (await read('/api/projects')).selected;
    const settingsPath = `/api/tracking?project=${primary}`;
    const settings = () => read(settingsPath);
    const configure = async (path, body) => {
      const response = await post(path, body);
      assert.equal(response.status, 200);
      return response.json();
    };
    const hook = (kind, cwd = root, tool, input) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), 'hook', 'codex'], {
      input: JSON.stringify({ cwd, hook_event_name: kind, session_id: 'tracked-session', tool_use_id: 'write', tool_name: tool, tool_input: input }),
      env: { ...process.env, FOCUS_HOME: directory }, encoding: 'utf8',
    });
    assert.equal((await settings()).defaultEnabled, true);
    assert.match(hook('UserPromptSubmit'), /focus-reason/);
    journal.setReason('pi', 'pending', 'Old intent from before pause');
    journal.startTool('pi', 'pending', 'write', 'write');
    assert.equal((await configure(settingsPath, { mode: 'off' })).enabled, false);
    assert.equal(hook('UserPromptSubmit'), '');
    write('status.js', 'while disabled\n');
    assert.equal(journal.poll(), null);
    assert.equal(journal.endTool('pi', 'pending', 'write'), null);
    assert.deepEqual(journal.detail(1), initial);
    assert.equal((await configure(settingsPath, { mode: 'inherit' })).enabled, true);
    write('status.js', 'after enabling\n');
    journal.startTool('pi', 'pending', 'next', 'write');
    write('status.js', 'agent edit after enabling\n');
    journal.endTool('pi', 'pending', 'next');
    assert.deepEqual(journal.patch(2, 0)[0].lines, ['-while disabled', '+after enabling']);
    assert.equal(journal.detail(3).reason, null);

    const added = await post('/api/projects', { path: other }).then(response => response.json());
    const otherSettings = `/api/tracking?project=${added.selected}`;
    assert.equal((await configure(otherSettings, { defaultEnabled: false, mode: 'on' })).enabled, true);
    assert.equal((await settings()).enabled, false);
    assert.match(hook('UserPromptSubmit', other), /focus-reason/);
    assert.equal(hook('UserPromptSubmit'), '');
    assert.equal((await read(`/api/changes?project=${primary}`)).tracking.enabled, false);
    assert.equal((await post(settingsPath, { mode: 'invalid' })).status, 400);
    const onDisk = new TrackingSettings(directory);
    try { assert.equal(onDisk.get(other).mode, 'on'); }
    finally { onDisk.close(); }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('automatic viewer startup skips occupied default ports and reports an explicit conflict', async t => {
  const { journal } = fixture(t);
  const reserved = [];
  try {
    for (const port of [4317, 4318]) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', error => {
          if (error.code === 'EADDRINUSE') resolve();
          else reject(error);
        });
        server.listen(port, '127.0.0.1', () => { reserved.push(server); resolve(); });
      });
    }
    await assert.rejects(serve(journal, { port: 4317, open: false }), /端口 4317 已被占用/);
    const { server, address } = await serve(journal, { open: false });
    try {
      assert.ok(!['4317', '4318'].includes(address.port));
      const status = await fetch(new URL('/api/status', address)).then(response => response.json());
      assert.equal(status.app, 'focus-code');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await Promise.all(reserved.map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('diff summaries explain why a shared import is used across hunks', t => {
  const { journal, write } = fixture(t);
  const padding = prefix => Array.from({ length: 14 }, (_, index) => `const ${prefix}${index} = ${index};`).join('\n');
  const start = `const ready = true;\n${padding('first')}`;
  const end = `${padding('last')}\nfunction render(hunk) {\n  return hunk.explanation ?? describeHunk(hunk);\n}\n`;
  write('app.js', `${start}\nfunction describeHunk(hunk) {\n  return hunk.lines.join('');\n}\n${end}`);
  journal.poll();
  write('app.js', `import { describeHunk } from './diff-summary.js';\n\n${start}\n${end}`);
  journal.poll();
  const hunks = journal.patch(1, 0);
  assert.ok(hunks.length > 1);
  const explanation = describeHunk(hunks[0]);
  assert.match(explanation, /把 describeHunk 从本文件内的实现改为复用/);
  assert.match(explanation, /代码段缺少逐段说明时，页面仍可生成摘要/);
  assert.match(describeHunk(hunks[0], 'en'), /Reuses describeHunk from .\/diff-summary\.js/);
  assert.equal(journal.detail(1, { includeReasonEvidence: true }).reason_evidence.sample, explanation);
  const older = addDiffSummaries([
    { lines: ["+import { describeHunk } from './diff-summary.js';", '+'] },
    { lines: ['-function describeHunk(hunk) {', ' return hunk.explanation ?? describeHunk(hunk);'] },
  ]);
  assert.equal(describeHunk(older[0]), explanation);
  const archivedWithoutCalls = addDiffSummaries(hunks.map(({ summary, ...hunk }) => hunk));
  assert.match(describeHunk(archivedWithoutCalls[0]), /复用 .\/diff-summary\.js 中的同名函数/);
  assert.doesNotMatch(describeHunk(archivedWithoutCalls[0]), /缺少逐段说明/);
  const nullable = addDiffSummaries([{ lines: ['-return user.name;', '+return user?.name;'] }]);
  assert.match(describeHunk(nullable[0]), /避免访问属性时报错/);
  const unresolved = addDiffSummaries([{ lines: ["+import { format } from './text.js';"] }]);
  assert.equal(unresolved[0].summary, undefined);
});

test('post-edit hooks can recover an overall reason without overwriting explicit reasons', t => {
  const { dir, root, journal, write } = fixture(t);
  const hook = (kind, session, tool, input) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.js'), 'hook', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: kind, session_id: session, tool_use_id: 'edit', tool_name: tool, tool_input: input }),
    env: { ...process.env, FOCUS_HOME: join(dir, 'state') }, encoding: 'utf8',
  });
  hook('PreToolUse', 's1', 'apply_patch', {});
  write('session.js', 'const safe = token?.value;\n');
  const post = JSON.parse(hook('PostToolUse', 's1', 'apply_patch', {})).hookSpecificOutput.additionalContext;
  assert.match(post, /No overall reason was recorded/);
  assert.match(post, /"reason":/);
  const submit = (session, data) => hook('PostToolUse', session, 'Bash', { command: `: # focus-explain: ${JSON.stringify(data)}` });
  const reason = 'Handle a session lifecycle without a token';
  assert.match(submit('other-session', { change: 1, reason }), /unknown change/);
  assert.match(submit('s1', { change: 1, reason, notes: [[0, 99, 'Unknown hunk']] }), /unknown change/);
  assert.equal(journal.detail(1).reason, null);
  assert.match(submit('s1', { change: 1, reason }), /Overall reason recorded/);
  assert.equal(journal.detail(1).reason, reason);
  assert.equal(journal.detail(1).reason_origin, 'agent');
  journal.editReason(1, 'Document a verified reason instead');
  assert.match(submit('s1', { change: 1, reason, notes: [[0, 0, 'Optional chaining handles absent tokens']] }), /Existing overall reason retained/);
  assert.equal(journal.detail(1).reason, 'Document a verified reason instead');
  assert.equal(journal.patch(1, 0)[0].explanation, 'Optional chaining handles absent tokens');
  hook('PreToolUse', 's1', 'apply_patch', {});
  write('asset.bin', Buffer.from([0, 1, 2]));
  const binary = JSON.parse(hook('PostToolUse', 's1', 'apply_patch', {})).hookSpecificOutput.additionalContext;
  assert.match(binary, /Changed files: "asset.bin"/);
  assert.match(submit('s1', { change: 2, reason: 'Use this binary fixture in the test' }), /Overall reason recorded/);
});

test('HTTP history survives reloads and permits only same-origin reason edits', async t => {
  const { dir, root, journal, write } = fixture(t);
  journal.poll();
  write('app.js', 'export const ready = true;\n');
  journal.poll();
  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const detail = async language => fetch(new URL('/api/changes/1', address), {
      headers: language ? { 'Accept-Language': language } : undefined,
    }).then(response => response.json());
    const original = await detail();
    assert.deepEqual(original.reason_evidence, { position: 0, sample: '新增「export const ready = true;」。' });
    assert.deepEqual((await detail('en')).reason_evidence, { position: 0, sample: 'Added “export const ready = true;”.' });
    const missing = await fetch(new URL('/api/changes/999', address), { headers: { 'Accept-Language': 'en' } });
    assert.equal((await missing.json()).error, 'Change record not found.');
    journal.saveHunkNotes(1, [[0, 0, 'Expose the current readiness state']]);
    assert.deepEqual((await detail('en')).reason_evidence, { notes: ['Expose the current readiness state'] });
    const url = new URL('/api/changes/1/reason', address);
    const options = { method: 'POST', body: JSON.stringify({ reason: 'Document readiness' }), headers: { 'Content-Type': 'application/json' } };
    assert.equal((await fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://example.test' } })).status, 403);
    const edit = await fetch(url, { ...options, headers: { ...options.headers, Origin: address.origin } });
    assert.equal(edit.status, 200);
    const list = await fetch(new URL('/api/changes?q=readiness', address)).then(response => response.json());
    assert.equal(list.changes[0].reason_origin, 'user');
    assert.equal((await detail()).reason_evidence, undefined);
    const patch = await fetch(new URL('/api/changes/1/files/0', address)).then(response => response.json());
    assert.deepEqual(patch[0].lines, ['+export const ready = true;']);
    const reopened = new Journal(root, join(dir, 'state'));
    try {
      assert.equal(reopened.detail(1).reason, 'Document readiness');
    } finally {
      reopened.close();
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('current changes show Pi edits before completion and remove deleted or reverted content', async t => {
  const { root, journal, write } = fixture(t);
  write('app.js', 'const initial = true;\n');
  execFileSync('git', ['add', 'app.js'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.test', 'commit', '--no-gpg-sign', '-qm', 'Baseline'], { cwd: root });
  journal.poll();
  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const get = path => fetch(new URL(path, address)).then(response => response.json());
    assert.deepEqual((await get('/api/current')).changes, []);
    journal.setReason('pi', 'native-session', 'Expose a feature flag');
    journal.startTool('pi', 'native-session', 'call-1', 'edit');
    write('app.js', 'const initial = true;\nconst feature = true;\n');
    const live = await get('/api/current?source=pi');
    assert.equal(live.changes.length, 1);
    const change = live.changes[0];
    assert.equal(change.first_path, 'app.js');
    assert.equal(change.source, 'pi');
    assert.equal(change.reason, 'Expose a feature flag');
    assert.equal((await get('/api/changes?source=pi')).changes.length, 0);
    const patch = await get(`/api/current/${change.id}/files/0`);
    assert.ok(patch[0].lines.includes('+const feature = true;'));
    const record = journal.endTool('pi', 'native-session', 'call-1');
    assert.equal((await get('/api/current?source=pi')).changes[0].history_id, record);
    write('app.js', 'const initial = true;\n');
    assert.deepEqual((await get('/api/current')).changes, []);
    assert.equal((await get('/api/changes?source=pi')).changes.length, 1);
    write('new.js', 'const created = true;\n');
    const untracked = await get('/api/current');
    assert.equal(untracked.changes[0].first_path, 'new.js');
    execFileSync('git', ['add', 'new.js'], { cwd: root });
    unlinkSync(join(root, 'new.js'));
    assert.deepEqual((await get('/api/current')).changes, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('one timeline shows live edits once, hides rollbacks, and keeps only committed files', async t => {
  const { root, journal, write } = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const commit = () => git('-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.test', 'commit', '--no-gpg-sign', '-qm', 'Save edits');
  write('base.js', 'const baseline = true;\n');
  git('add', 'base.js');
  commit();
  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const get = path => fetch(new URL(path, address)).then(response => response.json());
    const timeline = async (query = '') => (await get(`/api/timeline${query}`)).changes;
    journal.startTool('pi', 'active', 'write', 'write');
    write('alpha.js', 'const saved = true;\n');
    write('scratch.js', 'const discarded = true;\n');
    const pending = await timeline('?source=pi');
    assert.equal(pending.length, 2);
    assert.ok(pending.every(card => card.uncommitted));
    const record = journal.endTool('pi', 'active', 'write');
    assert.equal((await timeline()).length, 2);
    assert.ok((await timeline()).every(card => card.history_id === record));
    unlinkSync(join(root, 'scratch.js'));
    assert.deepEqual((await timeline()).map(card => card.first_path), ['alpha.js']);
    git('add', 'alpha.js');
    commit();
    const published = await timeline('?source=pi');
    assert.deepEqual(published.map(card => [card.id, card.first_path, card.file_count, Boolean(card.uncommitted)]), [[record, 'alpha.js', 1, false]]);
    assert.deepEqual((await get(`/api/changes/${record}?timeline=1`)).files.map(file => file.path), ['alpha.js']);
    assert.deepEqual(await timeline('?q=scratch.js'), []);
    write('base.js', 'const rolledBack = true;\n');
    journal.poll();
    assert.equal((await timeline()).filter(card => card.uncommitted).length, 1);
    git('restore', 'base.js');
    assert.deepEqual((await timeline()).map(card => card.id), [record]);
    assert.equal((await get('/api/timeline?limit=1')).hasMore, false);
    write('base.js', 'const intermediate = true;\n');
    journal.poll();
    write('base.js', 'const final = true;\n');
    journal.poll();
    git('add', 'base.js');
    commit();
    const saved = await timeline();
    assert.equal(saved.length, 2);
    assert.ok(saved.every(card => !card.uncommitted));
    assert.ok((await get(`/api/changes/${saved[0].id}/files/0`))[0].lines.includes('+const final = true;'));

    git('switch', '-c', 'topic');
    write('topic.js', 'const topic = true;\n');
    const topic = await get('/api/timeline?scope=current');
    assert.equal(topic.repository.branch, 'topic');
    assert.ok(topic.repository.branches.includes('topic'));
    assert.deepEqual(topic.changes.map(card => [card.branch, card.first_path]), [['topic', 'topic.js']]);
    assert.deepEqual((await timeline('?branch=main')).map(card => card.id), saved.map(card => card.id));
    assert.equal((await timeline()).length, saved.length + 1);

    git('switch', '--detach');
    const detached = await get('/api/timeline?scope=current');
    assert.equal(detached.repository.branch, 'HEAD');
    assert.deepEqual(detached.changes.map(card => card.branch), ['HEAD']);

    journal.tracking.update({ root, mode: 'off' });
    git('switch', 'main');
    const paused = await get('/api/timeline?scope=current');
    assert.equal(paused.repository.branch, 'main');
    assert.equal(paused.tracking.enabled, false);
    assert.deepEqual(paused.changes.map(card => card.id), saved.map(card => card.id));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('date presets and custom ranges use local midnights and include the end day', () => {
  const day = (month, date) => +new Date(2026, month, date);
  const now = new Date(2026, 2, 8, 14, 30);
  assert.deepEqual(timeBounds({ period: 'all' }, now), {});
  assert.deepEqual(timeBounds({ period: 'today' }, now), { from: day(2, 8), until: day(2, 9) });
  assert.deepEqual(timeBounds({ period: 'yesterday' }, now), { from: day(2, 7), until: day(2, 8) });
  assert.deepEqual(timeBounds({ period: 'lastTwoDays' }, now), { from: day(2, 7), until: day(2, 9) });
  assert.deepEqual(timeBounds({ period: 'lastSevenDays' }, now), { from: day(2, 2), until: day(2, 9) });
  assert.deepEqual(timeBounds({ period: 'custom', start: '2026-03-08', end: '2026-03-08' }), { from: day(2, 8), until: day(2, 9) });
  assert.equal(timeBounds({ period: 'custom', start: '2026-03-09', end: '2026-03-08' }), null);
  assert.equal(timeBounds({ period: 'custom', start: '2026-02-30', end: '2026-03-08' }), null);
});

test('timeline time bounds filter committed and live entries before totals and pagination', async t => {
  const { root, journal, write } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  const from = Date.UTC(2026, 2, 8);
  const until = from + 10_000;
  journal.poll(from - 20_000);
  for (const [name, time] of [['old.js', from - 1], ['start.js', from], ['middle.js', from + 2000], ['end.js', until]]) {
    write(name, 'fixture\n');
    journal.poll(time);
  }
  git('add', '.');
  git('-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.test', 'commit', '--no-gpg-sign', '-qm', 'History');
  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    journal.startTool('pi', 'date-filter', 'edit', 'write');
    write('live.js', 'fixture\n');
    utimesSync(join(root, 'live.js'), (from + 3000) / 1000, (from + 3000) / 1000);
    const path = `/api/timeline?scope=current&from=${from}&until=${until}`;
    const get = suffix => fetch(new URL(path + suffix, address)).then(response => response.json());
    const first = await get('&limit=1');
    assert.equal(first.hasMore, true);
    assert.equal(first.stats.changes, 3);
    assert.deepEqual(first.changes.map(card => card.first_path), ['live.js', 'middle.js']);
    assert.deepEqual((await get('&source=pi')).changes.map(card => card.first_path), ['live.js']);
    assert.deepEqual((await get('')).changes.map(card => card.first_path), ['live.js', 'middle.js', 'start.js']);
    assert.deepEqual((await get('&q=old.js')).changes, []);
    assert.equal((await fetch(new URL('/api/timeline?from=bad', address))).status, 400);
    assert.equal((await fetch(new URL('/api/timeline?from=2&until=1', address))).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('demo tracking settings can be edited without changing real project settings', async t => {
  const { dir, journal } = fixture(t);
  const directory = join(dir, 'real-state');
  const { server, address } = await serve(journal, { port: 0, open: false, demo: true, directory });
  try {
    const projects = await fetch(new URL('/api/projects', address)).then(response => response.json());
    const url = new URL(`/api/tracking?project=${projects.selected}`, address);
    const original = await fetch(url).then(response => response.json());
    assert.equal((await fetch(new URL('/api/tracking', address)).then(response => response.json())).demo, true);
    assert.equal(original.editable, true);
    assert.equal(original.demo, true);
    const update = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: address.origin },
      body: JSON.stringify({ defaultEnabled: false, mode: 'off' }),
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).enabled, false);
    assert.equal(journal.tracking.get(journal.root).enabled, false);
    const real = new TrackingSettings(directory);
    try { assert.equal(real.get().defaultEnabled, true); }
    finally { real.close(); }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the untracked cache preserves Git ignores, literal directory names, and the real index', async t => {
  const { root, write } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  write('.gitignore', '*.tmp\n');
  git('add', '.gitignore');
  git('-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.test', 'commit', '--no-gpg-sign', '-qm', 'Initial');
  const index = join(root, '.git', 'index');
  const original = readFileSync(index);
  const paths = new UntrackedPaths(root);
  try {
    assert.deepEqual(await paths.list(), []);
    mkdirSync(join(root, 'new [dir]'));
    write('new [dir]/file.js', 'new\n');
    write('new [dir]/ignored.tmp', 'ignored\n');
    write('loose.js', 'new\n');
    assert.deepEqual((await paths.list()).sort(), ['loose.js', 'new [dir]/file.js']);
    write('.gitignore', '*.skip\n');
    assert.deepEqual((await paths.list()).sort(), ['loose.js', 'new [dir]/file.js', 'new [dir]/ignored.tmp']);
    assert.deepEqual(readFileSync(index), original);
    git('add', 'loose.js');
    const staged = readFileSync(index);
    unlinkSync(join(root, 'new [dir]/file.js'));
    assert.deepEqual(await paths.list(), ['new [dir]/ignored.tmp']);
    assert.deepEqual(readFileSync(index), staged);
    git('update-index', '--split-index');
    assert.deepEqual(await paths.list(), ['new [dir]/ignored.tmp']);
  } finally {
    paths.close();
  }
});

test('change details stay responsive while the background snapshot waits on the journal', async t => {
  const { root, journal, write } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  const commit = () => git('-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.test', 'commit', '--no-gpg-sign', '-qm', 'Save');
  write('base.js', 'before\n');
  git('add', 'base.js');
  commit();
  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const get = async path => {
      const response = await fetch(new URL(path, address));
      assert.equal(response.status, 200);
      return response.json();
    };
    write('first.js', 'untracked\n');
    write('second.js', 'untracked\n');
    const { changes } = await get('/api/timeline');
    assert.equal(changes.length, 2);
    write('base.js', 'after\n');
    git('add', 'base.js');
    commit();
    // Force the commit-triggered scan to wait for a writer, while read requests use cached diffs.
    journal.db.exec('BEGIN IMMEDIATE');
    let settled = false;
    const scan = get('/api/timeline').finally(() => { settled = true; });
    try {
      const [first, second] = await Promise.all(changes.map(change => get(`/api/current/${change.id}`)));
      assert.equal(first.id, changes[0].id);
      assert.equal(second.id, changes[1].id);
      assert.equal(settled, false);
    } finally {
      journal.db.exec('ROLLBACK');
      await scan;
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the viewer discovers ignored repositories and submodules as separate projects with live diffs', async t => {
  const { dir, root, journal, write } = fixture(t);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  const setup = (path, file) => {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, file), 'before\n');
    git(path, 'add', file);
    git(path, '-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.com', 'commit', '-qm', 'Initial');
  };
  const child = join(root, 'repos', 'group', 'child');
  const source = join(dir, 'source');
  const submodule = join(root, 'modules', 'widget');
  write('.gitignore', '/repos/\n/mirror\n');
  setup(child, 'child.txt');
  setup(source, 'module.txt');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'modules/widget');
  git(root, 'add', '.gitignore');
  git(root, '-c', 'user.name=Focus Test', '-c', 'user.email=focus@example.com', 'commit', '-qm', 'Initial');
  symlinkSync(source, join(root, 'mirror'));
  writeFileSync(join(child, 'child.txt'), 'after child\n');
  writeFileSync(join(submodule, 'module.txt'), 'after module\n');

  const { server, address } = await serve(journal, { port: 0, open: false });
  try {
    const get = async path => {
      const response = await fetch(new URL(path, address));
      assert.equal(response.status, 200);
      return response.json();
    };
    const { projects, selected } = await get('/api/projects');
    const ids = new Map(projects.map(project => [project.root, project.id]));
    assert.deepEqual(new Set(ids.keys()), new Set([root, child, submodule]));
    assert.equal(selected, ids.get(root));
    assert.deepEqual((await get(`/api/timeline?project=${selected}`)).changes, []);
    for (const [path, file, after] of [[child, 'child.txt', 'after child'], [submodule, 'module.txt', 'after module']]) {
      const project = ids.get(path);
      const { changes } = await get(`/api/timeline?project=${project}`);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].first_path, file);
      assert.equal(changes[0].uncommitted, true);
      const patch = await get(`/api/current/${changes[0].id}/files/0?project=${project}`);
      assert.deepEqual(patch[0].lines, ['-before', `+${after}`]);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP switching isolates journals with the same change IDs and remembers the projects', async t => {
  const { dir, root, journal, write } = fixture(t);
  const directory = join(dir, 'state');
  const other = join(dir, 'other');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  journal.poll();
  write('first.js', 'first\n');
  journal.poll();
  const first = await serve(journal, { port: 0, open: false });
  try {
    const get = async path => fetch(new URL(path, first.address)).then(response => response.json());
    const post = (path, body) => fetch(new URL(path, first.address), {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: first.address.origin },
    });
    const earlier = (await get('/api/projects')).selected;
    const invalid = await post('/api/projects', { path: dir });
    assert.equal(invalid.status, 400);
    const added = await post('/api/projects', { path: other }).then(response => response.json());
    assert.equal(added.projects.length, 2);
    assert.notEqual(earlier, added.selected);
    writeFileSync(join(other, 'second.js'), 'second\n');
    const secondJournal = new Journal(other, directory);
    try { secondJournal.poll(); } finally { secondJournal.close(); }
    assert.equal((await get(`/api/changes/1?project=${earlier}`)).files[0].path, 'first.js');
    assert.equal((await get(`/api/changes/1?project=${added.selected}`)).files[0].path, 'second.js');
    const reset = await post(`/api/changes/1/files/0/hunks/0/explanation?project=${added.selected}`, { explanation: 'Explain only this project' });
    assert.equal(reset.status, 200);
    assert.equal((await get(`/api/changes/1/files/0?project=${earlier}`))[0].explanation, undefined);
    assert.equal((await get(`/api/changes/1/files/0?project=${added.selected}`))[0].explanation, 'Explain only this project');
  } finally {
    await new Promise(resolve => first.server.close(resolve));
  }
  const reopened = await serve(null, { port: 0, open: false, directory });
  try {
    const list = await fetch(new URL('/api/projects', reopened.address)).then(response => response.json());
    assert.deepEqual(new Set(list.projects.map(project => project.root)), new Set([root, other]));
  } finally {
    await new Promise(resolve => reopened.server.close(resolve));
  }
});
