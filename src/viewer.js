import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { rememberedViewer, rememberProject } from './projects.js';
import { hash, repositoryRoot } from './repository.js';
import { stateDirectory } from './tracking.js';

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
export const viewerPorts = [4317, 4318];

export function viewerIdentity(directory) {
  return hash(realpathSync(directory));
}

export function openBrowser(url) {
  const [launcher, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const browser = spawn(launcher, args, { stdio: 'ignore', detached: true });
  browser.on('error', () => {});
  browser.unref();
}

async function findViewer(directory, identity) {
  const remembered = rememberedViewer(directory);
  const ports = [...new Set([remembered, ...viewerPorts].filter(Boolean))];
  const detected = await Promise.all(ports.map(async port => {
    const address = new URL(`http://127.0.0.1:${port}`);
    try {
      const response = await fetch(new URL('/api/status', address), { signal: AbortSignal.timeout(350), redirect: 'error' });
      if (response.ok) {
        const status = await response.json();
        if (!status.demo && status.app === 'focus-code' && status.state === identity) return address;
      }
    } catch { /* The port may be unused or serve another application. */ }
    return null;
  }));
  return detected.find(Boolean) ?? null;
}

async function startViewer(directory, identity) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'watch', '--no-open'], {
    stdio: 'ignore', detached: true,
  });
  let stopped = false;
  child.once('exit', () => { stopped = true; });
  child.once('error', () => { stopped = true; });
  child.unref();
  const deadline = Date.now() + 8000;
  do {
    const address = await findViewer(directory, identity);
    if (address) return address;
    if (stopped) throw new Error('无法启动 Focus Code 网页，请运行 focus-code watch 查看错误。');
    await pause(100);
  } while (Date.now() < deadline);
  child.kill();
  throw new Error('Focus Code 网页启动超时，请运行 focus-code watch 后再试。');
}

export async function showViewer(cwd = process.cwd(), { open = true } = {}) {
  const root = repositoryRoot(cwd);
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const project = root ? rememberProject(root, directory) : null;
  const identity = viewerIdentity(directory);
  const address = await findViewer(directory, identity) ?? await startViewer(directory, identity);
  if (project) address.searchParams.set('project', project);
  if (open) openBrowser(address.href);
  return address.href;
}
