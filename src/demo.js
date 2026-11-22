import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from './journal.js';

function seedWorktree(root) {
  execFileSync('git', ['-C', root, 'add', '--all'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, '-c', 'user.name=Focus Code Demo', '-c', 'user.email=focus-code@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-qm', 'Demo baseline'], { stdio: 'ignore' });
}

export function makeDemo() {
  const scratch = mkdtempSync(join(tmpdir(), 'focus-code-'));
  const root = join(realpathSync(scratch), 'atlas-web');
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(join(root, 'tests'));
  const write = (path, text) => writeFileSync(join(root, path), text.trimStart());
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'feat/session-refresh');
  write('src/auth/session.ts', `
import { getToken, saveToken } from './token';
import { api } from '../api';

export async function refreshSession() {
  const token = getToken();
  if (!token) return null;

  const next = await api.refresh(token);
  saveToken(next);
  return next;
}
`);
  write('README.md', '# Atlas Web\n\nA workspace for the Atlas team.\n');
  seedWorktree(root);
  const journal = new Journal(root, join(scratch, 'data'));
  const now = Date.now();
  const previousDay = new Date(now);
  previousDay.setDate(previousDay.getDate() - 1);
  previousDay.setHours(16, 25, 0, 0);
  journal.poll(previousDay.getTime() - 60000);
  const edit = (minutes, source, tool, reason, apply) => {
    const time = now - minutes * 60000;
    const session = `${source}-demo`;
    if (reason) journal.setReason(source, session, reason, time);
    journal.startTool(source, session, `demo-${minutes}`, tool, time);
    apply();
    journal.endTool(source, session, `demo-${minutes}`, time);
  };
  write('README.md', '# Atlas Web\n\nA workspace for the Atlas team.\n\n## Development\n\nRun `npm test` after changing session behavior.\n');
  journal.poll(previousDay.getTime());
  edit(38, 'pi', 'write', '提取令牌存取逻辑，便于在测试里单独替换存储实现。', () => {
    write('src/auth/token.ts', `
export function getToken() {
  return localStorage.getItem('token');
}

export function saveToken(value: string) {
  localStorage.setItem('token', value);
}
`);
  });
  edit(24, 'claude', 'Bash', '补充空令牌场景的测试，确保退出登录之后不会发出刷新请求。', () => {
    write('tests/session.test.ts', `
import { describe, expect, it } from 'vitest';
import { refreshSession } from '../src/auth/session';

describe('refreshSession', () => {
  it('skips requests when no token is present', async () => {
    expect(await refreshSession()).toBeNull();
  });

  it('exposes the refresh function to the auth module', () => {
    expect(typeof refreshSession).toBe('function');
  });
});
`);
  });
  edit(4, 'codex', 'apply_patch', '合并并发的令牌刷新请求，避免较早发出的请求在稍后完成时覆盖新令牌。', () => {
    write('src/auth/session.ts', `
import { getToken, saveToken } from './token';
import { api } from '../api';

let inFlight: Promise<string> | undefined;

export async function refreshSession() {
  const token = getToken();
  if (!token) return null;

  inFlight ??= api.refresh(token).then(next => {
    saveToken(next);
    return next;
  }).finally(() => {
    inFlight = undefined;
  });

  return inFlight;
}
`);
    write('tests/session.test.ts', `
import { describe, expect, it, vi } from 'vitest';
import { refreshSession } from '../src/auth/session';
import { api } from '../src/api';

describe('refreshSession', () => {
  it('skips requests when no token is present', async () => {
    expect(await refreshSession()).toBeNull();
  });

  it('exposes the refresh function to the auth module', () => {
    expect(typeof refreshSession).toBe('function');
  });

  it('shares one refresh across concurrent callers', async () => {
    localStorage.setItem('token', 'old-token');
    const refresh = vi.spyOn(api, 'refresh').mockResolvedValue('new-token');
    expect(await Promise.all([refreshSession(), refreshSession()])).toEqual(['new-token', 'new-token']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
`);
  });
  journal.saveHunkNotes(2, [[0, 0, '把令牌读写放在独立模块，测试可以替换存储，刷新代码也不再依赖具体的浏览器 API。']], { source: 'pi', session: 'pi-demo' });
  journal.saveHunkNotes(3, [[0, 0, '覆盖无令牌时直接返回的路径，防止登出后的后台刷新发出无效请求。']], { source: 'claude', session: 'claude-demo' });
  const codex = { source: 'codex', session: 'codex-demo' };
  journal.saveHunkNotes(4, [[0, 0, '让并发调用共享同一个 Promise，避免旧请求覆盖新令牌。请求结束后清空它，让下一次刷新仍可正常发出。']], codex);
  const testHunks = journal.patch(4, 1);
  journal.saveHunkNotes(4, testHunks.map((_, index) => [1, index, testHunks.length > 1 && index === 0
    ? '引入 vi 和 API 模块，测试需要拦截刷新调用并统计请求次数。'
    : '用两个并发调用复现竞态，验证两者返回相同令牌且只发出一个请求。']), codex);

  const docs = join(realpathSync(scratch), 'atlas-docs');
  mkdirSync(docs);
  execFileSync('git', ['init', '-q', '-b', 'main', docs]);
  const docsJournal = new Journal(docs, join(scratch, 'data'));
  const docsTime = now - 45 * 60000;
  const overview = join(docs, 'README.md');
  writeFileSync(overview, '# Atlas Docs\n\nDevelopment guides and API references.\n');
  seedWorktree(docs);
  docsJournal.poll(docsTime);
  docsJournal.setReason('opencode', 'docs-demo', '补上本地预览命令，贡献者可以在提交前检查页面。', docsTime + 3000);
  docsJournal.startTool('opencode', 'docs-demo', 'preview', 'edit', docsTime + 4000);
  writeFileSync(overview, '# Atlas Docs\n\nDevelopment guides and API references.\n\nRun `npm run docs` to preview the site locally.\n');
  docsJournal.endTool('opencode', 'docs-demo', 'preview', docsTime + 5000);
  docsJournal.saveHunkNotes(1, [[0, 0, '补上本地预览命令，文档贡献者可以在提交前检查页面。']], { source: 'opencode', session: 'docs-demo' });
  docsJournal.setReason('gemini', 'docs-demo', '单独记录节点版本和启动步骤，便于新贡献者搭建文档环境。', now - 70000);
  docsJournal.startTool('gemini', 'docs-demo', null, 'write_file', now - 65000);
  writeFileSync(join(docs, 'CONTRIBUTING.md'), '# Contributing\n\nUse Node.js 22 or newer.\nRun `npm ci` before starting the docs server.\n');
  docsJournal.endTool('gemini', 'docs-demo', null, now - 60000, 'write_file');
  docsJournal.saveHunkNotes(2, [[0, 0, '明确 Node.js 版本并要求用锁文件安装依赖，让每位贡献者能复现同样的预览环境。']], { source: 'gemini', session: 'docs-demo' });
  docsJournal.setReason('trae', 'desktop-demo', '解释本地文档预览的端口，避免启动后还要去找访问地址。', now - 48000);
  docsJournal.startTool('trae', 'desktop-demo', 'preview-url', 'Edit', now - 45000);
  writeFileSync(overview, '# Atlas Docs\n\nDevelopment guides and API references.\n\nRun `npm run docs` and open `http://localhost:4321` to preview the site locally.\n');
  docsJournal.endTool('trae', 'desktop-demo', 'preview-url', now - 40000);
  docsJournal.saveHunkNotes(3, [[0, 0, '把默认预览地址紧跟在启动命令后，贡献者可以直接打开。']], { source: 'trae', session: 'desktop-demo' });
  execFileSync('git', ['-C', docs, 'switch', '-q', '-c', 'review/docs']);
  docsJournal.setReason('trae-cli', 'terminal-demo', '补充文档提交前的检查步骤，帮助贡献者发现失效链接。', now - 30000);
  docsJournal.startTool('trae-cli', 'terminal-demo', 'link-check', 'apply_patch', now - 28000);
  writeFileSync(join(docs, 'CONTRIBUTING.md'), '# Contributing\n\nUse Node.js 22 or newer.\nRun `npm ci` before starting the docs server.\nRun `npm run docs:check` to validate links before submitting.\n');
  docsJournal.endTool('trae-cli', 'terminal-demo', 'link-check', now - 25000);
  docsJournal.saveHunkNotes(4, [[0, 0, '把链接检查加入提交流程，在合并前发现指向旧页面的链接。']], { source: 'trae-cli', session: 'terminal-demo' });
  return { journal, demoProjects: [docsJournal], cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}
