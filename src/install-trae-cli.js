import { execFileSync } from 'node:child_process';
import { constants, accessSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { hookGroups, writeConfig } from './install.js';
import { stateDirectory } from './journal.js';

const marketplace = 'focus-code-local';
const plugin = 'focus-code';

function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (readFileSync(file, 'utf8') === text) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  writeConfig(file, text, 0o600);
}

function prepareTraeCliMarketplace(directory = stateDirectory()) {
  const root = join(directory, 'integrations', 'trae-cli');
  const packageRoot = join(root, 'plugins', plugin);
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  writeJson(join(packageRoot, '.codex-plugin', 'plugin.json'), {
    name: plugin,
    version,
    description: 'Record local Git changes and their explanations in Focus Code.',
    hooks: './hooks/hooks.json',
  });
  writeJson(join(packageRoot, 'hooks', 'hooks.json'), {
    hooks: Object.fromEntries(Object.entries(hookGroups('trae-cli')).map(([kind, group]) => [kind, [group]])),
  });
  writeJson(join(root, '.agents', 'plugins', 'marketplace.json'), {
    name: marketplace,
    interface: { displayName: 'Focus Code' },
    plugins: [{ name: plugin, source: { source: 'local', path: `./plugins/${plugin}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  });
  return root;
}

function findTraeCli() {
  const override = process.env.TRAECLI_BIN;
  const names = override ? [override] : ['traex', 'traecli', 'trae-cli'];
  for (const name of names) {
    const candidates = name.includes('/') ? [resolve(name)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(dir, name));
    for (const path of candidates) {
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, constants.X_OK);
        return path;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export function installTraeCli() {
  const root = prepareTraeCliMarketplace();
  const binary = findTraeCli();
  if (!binary) throw new Error(`找不到 TRAE CLI（traex / traecli）。已生成插件 ${root}。安装客户端后重试，或设置 TRAECLI_BIN 指定可执行文件。`);
  const help = execFileSync(binary, ['plugin', '--help'], { encoding: 'utf8', timeout: 10000 });
  const action = /^\s+install(?:\s|$)/m.test(help) ? 'install' : /^\s+add(?:\s|$)/m.test(help) ? 'add' : null;
  if (!action) throw new Error(`这个 TRAE CLI 版本没有插件安装命令。已生成插件 ${root}。`);
  execFileSync(binary, ['plugin', 'marketplace', 'add', root], { stdio: 'inherit', timeout: 45000 });
  execFileSync(binary, ['plugin', action, `${plugin}@${marketplace}`], { stdio: 'inherit', timeout: 45000 });
  return root;
}
