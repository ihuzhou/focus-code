import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import semver from 'semver';
import { list } from 'tar';

const name = 'focus-code';
const registry = '--registry=https://registry.npmjs.org/';
const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

async function runNpm(args, { cwd = tmpdir(), timeout = 30_000 } = {}) {
  // The Windows npm shim needs a shell. These arguments are constants or validated version strings.
  const windows = process.platform === 'win32';
  const command = windows ? 'cmd.exe' : 'npm';
  const parameters = windows ? ['/d', '/c', 'npm.cmd', ...args] : args;
  const { stdout } = await exec(command, parameters, { cwd, timeout, encoding: 'utf8', windowsHide: true });
  return stdout.trim();
}

function validVersion(value) {
  return typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]*$/.test(value) && semver.valid(value) !== null;
}

async function readVersion(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name || !validVersion(manifest.version)) {
    throw new Error('无法识别当前 Focus Code 安装版本。');
  }
  return manifest.version;
}

async function archiveFiles(file) {
  const files = new Map();
  let unsupported = false;
  // Hash archive entries without extracting files or following any links from the archive.
  await list({ file, strict: true, onReadEntry(entry) {
    if (entry.type === 'Directory') return;
    const path = entry.path.slice('package/'.length);
    if (!entry.path.startsWith('package/') || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.') ||
        !['File', 'OldFile'].includes(entry.type) || files.has(path)) {
      unsupported = true;
      return;
    }
    const hash = createHash('sha256');
    const fileData = { size: entry.size };
    files.set(path, fileData);
    entry.on('data', bytes => hash.update(bytes));
    entry.on('end', () => { fileData.hash = hash.digest('hex'); });
  } });
  if (unsupported || !files.has('package.json') || !files.has('src/cli.js')) throw new Error('无法核验公开 npm 包的文件结构。');
  return files;
}

async function sameFiles(directory, expected, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!prefix && entry.name === 'node_modules' && entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const key = prefix + entry.name;
    if (entry.isDirectory()) {
      if (!await sameFiles(path, expected, `${key}/`)) return false;
    } else {
      const file = expected.get(key);
      if (!entry.isFile() || !file || (await lstat(path)).size !== file.size) return false;
      if (createHash('sha256').update(await readFile(path)).digest('hex') !== file.hash) return false;
      expected.delete(key);
    }
  }
  return true;
}

async function installationOrigin(directory, version, npm) {
  try {
    const globalRoot = await npm(['root', '--global']);
    if (!isAbsolute(globalRoot)) return 'unknown';
    const installed = join(globalRoot, name);
    const info = await lstat(installed).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isDirectory() || await realpath(installed) !== directory) return 'localPath';
  } catch {
    return 'unknown';
  }

  const scratch = await mkdtemp(join(tmpdir(), 'focus-update-'));
  try {
    let packed;
    try {
      packed = JSON.parse(await npm(['pack', `${name}@${version}`, registry, '--ignore-scripts', '--json'], { cwd: scratch }));
    } catch (error) {
      return /\b(?:ETARGET|E404)\b/.test(error.stderr ?? '') ? 'unpublished' : 'unknown';
    }
    const archive = packed?.[0];
    if (!archive || archive.name !== name || archive.version !== version || typeof archive.filename !== 'string' ||
        basename(archive.filename) !== archive.filename || !archive.filename.endsWith('.tgz')) return 'unknown';
    const expected = await archiveFiles(join(scratch, archive.filename));
    return await sameFiles(directory, expected) && !expected.size ? 'registry' : 'modified';
  } catch {
    return 'unknown';
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const origins = {
  registry: '公开 npm 全局安装（已核验发布包文件）',
  localPath: '本地源码、链接或非当前 npm 全局安装',
  unpublished: '本地构建（该版本未在公开 npm 发布）',
  modified: '本地构建或已修改（与公开 npm 同版本的文件不同）',
  unknown: '未能核验安装来源',
};

export async function updateFocusCode({ apply = false, directory = packageDirectory, npm = runNpm, log = console.log } = {}) {
  directory = await realpath(directory);
  const version = await readVersion(directory);
  log(`已安装版本：${version}`);
  let latest;
  try {
    latest = JSON.parse(await npm(['view', `${name}@latest`, 'version', registry, '--json', '--prefer-online']));
    if (!validVersion(latest)) throw new Error('invalid version');
  } catch {
    throw new Error('无法查询公开 npm 最新版本；未更改当前安装。');
  }
  log(`公开 npm 最新版：${latest}`);
  const origin = await installationOrigin(directory, version, npm);
  log(`安装来源：${origins[origin]}`);
  if (origin !== 'registry') {
    const message = '为保护本地构建或未核验的安装，更新命令不会覆盖当前文件。';
    if (apply) throw new Error(message);
    log(message);
    return;
  }
  if (!semver.gt(latest, version)) {
    log('没有比当前版本更新的公开版本。');
    return;
  }
  if (!apply) {
    log('运行 focus-code update 可升级；本次只检查，未安装。');
    return;
  }
  await npm(['install', '--global', `${name}@${latest}`, registry, '--ignore-scripts', '--no-audit', '--no-fund'], { timeout: 120_000 });
  if (await readVersion(directory) !== latest) throw new Error('npm 返回成功，但未能确认当前位置已升级。');
  log(`已升级到 ${latest}。请重启正在运行的网页服务和客户端，以加载新版本。`);
}
