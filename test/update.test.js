import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { create } from 'tar';
import { updateFocusCode } from '../src/update.js';

const registry = '--registry=https://registry.npmjs.org/';

async function fixture(t, { latest = '0.4.1', linked = false, packError } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'focus-update-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'package');
  const npmRoot = join(dir, 'node_modules');
  const installed = join(npmRoot, 'focus-code');
  const manifest = version => JSON.stringify({ name: 'focus-code', version });
  mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(npmRoot);
  writeFileSync(join(source, 'package.json'), manifest('0.4.0'));
  writeFileSync(join(source, 'src', 'cli.js'), '// registry\n');
  const archive = join(dir, 'focus-code-0.4.0.tgz');
  await create({ cwd: dir, file: archive, gzip: true, portable: true }, ['package']);
  if (linked) symlinkSync(source, installed, 'junction');
  else cpSync(source, installed, { recursive: true });
  const calls = [];
  const output = [];
  const npm = async (args, options) => {
    calls.push(args);
    if (args[0] === 'view') {
      assert.ok(args.includes(registry));
      return JSON.stringify(latest);
    }
    if (args[0] === 'root') return npmRoot;
    if (args[0] === 'pack') {
      assert.deepEqual(args.slice(1, 3), ['focus-code@0.4.0', registry]);
      assert.ok(args.includes('--ignore-scripts'));
      if (packError) throw packError;
      cpSync(archive, join(options.cwd, 'focus-code-0.4.0.tgz'));
      return JSON.stringify([{ name: 'focus-code', version: '0.4.0', filename: 'focus-code-0.4.0.tgz' }]);
    }
    assert.deepEqual(args, ['install', '--global', `focus-code@${latest}`, registry, '--ignore-scripts', '--no-audit', '--no-fund']);
    writeFileSync(join(installed, 'package.json'), manifest(latest));
  };
  const update = apply => updateFocusCode({ apply, directory: installed, npm, log: line => output.push(line) });
  return { installed, update, calls, output };
}

test('the CLI attempts an upgrade by default and checks only with --check', { skip: process.platform === 'win32' }, t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'focus-update-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npm'), [
    '#!/bin/sh',
    'case "$1" in',
    '  view) printf \'"%s"\\n\' 9.0.0 ;;',
    '  root) printf \'%s\\n\' "$FOCUS_TEST_NPM_ROOT" ;;',
    '  *) exit 99 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'update', ...args], {
    env: { ...process.env, PATH: dir + delimiter + process.env.PATH, FOCUS_TEST_NPM_ROOT: dir },
    encoding: 'utf8',
  });
  const check = run('--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /不会覆盖当前文件/);
  for (const args of [[], ['--apply']]) {
    const upgrade = run(...args);
    assert.equal(upgrade.status, 1);
    assert.match(upgrade.stderr, /不会覆盖当前文件/);
  }
});

test('checking verifies an official npm install without writing it; apply installs the exact newer release', async t => {
  const { update, calls, output } = await fixture(t);
  await update(false);
  assert.deepEqual(calls.map(args => args[0]), ['view', 'root', 'pack']);
  assert.match(output.join('\n'), /已安装版本：0\.4\.0.*最新版本?：0\.4\.1/s);
  assert.match(output.join('\n'), /公开 npm 全局安装/);
  assert.match(output.at(-1), /运行 focus-code update 可升级/);
  await update(true);
  assert.deepEqual(calls.map(args => args[0]), ['view', 'root', 'pack', 'view', 'root', 'pack', 'install']);
  assert.match(output.at(-1), /已升级到 0\.4\.1/);
});

test('a same-version local build is identified by file bytes and never overwritten', async t => {
  const { installed, update, calls, output } = await fixture(t);
  writeFileSync(join(installed, 'src', 'cli.js'), '// modified\n');
  await update(false);
  assert.match(output.join('\n'), /与公开 npm 同版本的文件不同/);
  await assert.rejects(update(true), /不会覆盖当前文件/);
  assert.ok(!calls.some(args => args[0] === 'install'));
});

test('an npm link and an unverified package are never overwritten', async t => {
  await t.test('link', async sub => {
    const { update, calls, output } = await fixture(sub, { linked: true });
    await assert.rejects(update(true), /不会覆盖当前文件/);
    assert.match(output.join('\n'), /本地源码、链接/);
    assert.deepEqual(calls.map(args => args[0]), ['view', 'root']);
  });
  await t.test('unverified package', async sub => {
    const { update, calls } = await fixture(sub, { packError: new Error('offline') });
    await assert.rejects(update(true), /不会覆盖当前文件/);
    assert.ok(!calls.some(args => args[0] === 'install'));
  });
});

test('applying never reinstalls the same version or downgrades a verified installation', async t => {
  for (const latest of ['0.4.0', '0.3.9']) {
    await t.test(latest, async sub => {
      const { update, calls, output } = await fixture(sub, { latest });
      await update(true);
      assert.match(output.at(-1), /没有比当前版本更新/);
      assert.ok(!calls.some(args => args[0] === 'install'));
    });
  }
});
