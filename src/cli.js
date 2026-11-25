#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { handleEvent } from './agent.js';
import { Journal } from './journal.js';
import { agents, codexSkillPath, globalAgents, install, installGlobal } from './install.js';
import { installTraeCli } from './install-trae-cli.js';
import { repositoryRoot } from './repository.js';
import { showViewer } from './viewer.js';

const usage = `Focus Code

  focus-code watch [仓库路径] [--port 端口] [--no-open]
  focus-code demo [--port 端口] [--no-open]
  focus-code show [仓库路径] [--no-open]
  focus-code update [--check | --apply]
  focus-code install <claude|opencode|gemini|trae> [--global | 仓库路径]
  focus-code install trae-cli [--global]
  focus-code install <codex|pi> [--global | 仓库路径]
  focus-code install all [仓库路径]

  update 默认升级公开 npm 安装，--check 只检查。
  Claude Code、OpenCode、Gemini CLI 和 TRAE 默认使用用户级设置。
  watch 不指定路径时，优先打开当前 Git 工作树。
  默认尝试 4317、4318，随后使用系统提供的空闲端口。`;

function requireRoot(path = process.cwd()) {
  const root = repositoryRoot(path);
  if (!root) throw new Error(`找不到 Git 工作树 ${path}`);
  return root;
}

const geminiEvents = new Map([
  ['BeforeAgent', 'UserPromptSubmit'], ['BeforeTool', 'PreToolUse'], ['AfterTool', 'PostToolUse'],
  ['AfterAgent', 'Stop'], ['SessionEnd', 'SessionEnd'],
]);

async function focusViewerMessage(cwd) {
  try {
    const url = await showViewer(cwd);
    return `Focus Code 变动记录 ${url}`;
  } catch (error) {
    return `Focus Code: ${error.message}`;
  }
}

async function expandFocusCommand(event) {
  if (event.expansion_type !== 'slash_command' || event.command_name !== 'focus-code') return undefined;
  const message = ['', 'show'].includes(event.command_args?.trim() ?? '')
    ? await focusViewerMessage(event.cwd) : '用法：/focus-code show';
  return { continue: false, stopReason: message };
}

function isCodexShow(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  const link = `[$focus-code](${codexSkillPath()})`;
  return /^\$focus-code(?:[\t ]+show)?$/.test(text) || text === link || text === `${link} show`;
}

async function main([command, ...args]) {
  if (command === 'hook') {
    const requested = args[0];
    if (!agents.includes(requested) && requested !== 'trae-cli') throw new Error('Unknown hook source');
    try {
      const event = JSON.parse(readFileSync(0, 'utf8'));
      // TRAE can also run Claude Code hook definitions from its compatibility settings.
      const source = requested === 'claude' && process.env.TRAE_PROJECT_DIR && Array.isArray(event.workspace_roots) ? 'trae' : requested;
      const kind = event.hook_event_name;
      if (source === 'gemini') event.hook_event_name = geminiEvents.get(kind);
      if ((source === 'trae' || source === 'trae-cli') && !event.cwd) {
        event.cwd = process.env.TRAE_PROJECT_DIR || event.workspace_roots?.[0] || process.cwd();
      }
      if (source === 'codex' && kind === 'UserPromptSubmit' && isCodexShow(event.prompt)) {
        const message = await focusViewerMessage(event.cwd);
        console.log(JSON.stringify({ continue: false, stopReason: message, systemMessage: message }));
        return;
      }
      const result = source === 'claude' && kind === 'UserPromptExpansion' ? await expandFocusCommand(event)
        : event.hook_event_name ? handleEvent(source, event) : undefined;
      if (source === 'gemini') {
        if (result) result.hookSpecificOutput.hookEventName = kind;
        console.log(JSON.stringify(result ?? {}));
      } else if (result) console.log(JSON.stringify(result));
    } catch (error) {
      console.error(`Focus Code: ${error.message}`);
      if (requested === 'gemini') console.log('{}');
    }
    return;
  }
  if (command === 'update') {
    if (args.length > 1 || ![undefined, '--check', '--apply'].includes(args[0])) {
      throw new Error('用法：focus-code update [--check | --apply]');
    }
    const { updateFocusCode } = await import('./update.js');
    await updateFocusCode({ apply: args[0] !== '--check' });
    return;
  }
  if (command === 'install') {
    const [source, path] = args;
    if (!source || args.length > 2) throw new Error(usage);
    if (source === 'trae-cli') {
      if (path && path !== '--global') throw new Error('TRAE CLI 请使用全局插件安装。');
      console.log(installTraeCli());
      return;
    }
    if (globalAgents.has(source) && (path === '--global' || (!path && source !== 'pi' && source !== 'codex'))) {
      console.log(installGlobal(source));
      return;
    }
    if (path?.startsWith('--')) throw new Error(usage);
    const root = requireRoot(path);
    for (const target of source === 'all' ? agents : [source]) console.log(install(root, target));
    return;
  }
  if (command === 'show') {
    const paths = args.filter(arg => arg !== '--no-open');
    if (paths.length > 1 || paths[0]?.startsWith('--')) throw new Error(usage);
    const cwd = paths.length ? requireRoot(paths[0]) : process.cwd();
    console.log(await showViewer(cwd, { open: !args.includes('--no-open') }));
    return;
  }
  if (command === 'watch' || command === 'demo') {
    const options = { demo: command === 'demo', open: true };
    let path;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--no-open') options.open = false;
      else if (arg === '--port' && /^\d+$/.test(args[index + 1] ?? '')) options.port = Number(args[++index]);
      else if (!arg.startsWith('-') && path === undefined && !options.demo) path = arg;
      else throw new Error(usage);
    }
    if (options.port > 65535) throw new Error('端口必须在 0 到 65535 之间。');
    const { serve } = await import('./server.js');
    const root = options.demo ? null : path === undefined ? repositoryRoot(process.cwd()) : requireRoot(path);
    const { journal, cleanup, demoProjects } = options.demo ? (await import('./demo.js')).makeDemo() : { journal: root ? new Journal(root) : null };
    try {
      const { server } = await serve(journal, { ...options, demoProjects });
      server.once('close', () => {
        journal?.close();
        cleanup?.();
      });
      process.once('SIGINT', () => server.close());
      process.once('SIGTERM', () => server.close());
    } catch (error) {
      journal?.close();
      cleanup?.();
      throw error;
    }
    return;
  }
  console.log(usage);
  if (command && !['help', '--help', '-h'].includes(command)) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`Focus Code: ${error.message}`);
  process.exitCode = 1;
}
