import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const observed = new Set(['edit', 'write', 'bash', 'powershell', 'apply_patch', 'exec_command', 'codemode']);

type FocusFeedback = {
  systemMessage?: string;
  hookSpecificOutput?: { additionalContext?: string };
};

export default function (pi: ExtensionAPI) {
  const calls = new Set<string>();

  function observe(kind: string, ctx: ExtensionContext, tool?: string, id?: string, input?: unknown) {
    return new Promise<FocusFeedback | undefined>(resolve => {
      const process = execFile('node', ['--disable-warning=ExperimentalWarning', cli, 'hook', 'pi'], {
        cwd: ctx.cwd, timeout: 15000, maxBuffer: 64 * 1024,
      }, (error, stdout, stderr) => {
        const warning = stderr.trim() || error?.message;
        if (warning && ctx.hasUI) ctx.ui.notify(warning, 'warning');
        try { resolve(stdout ? JSON.parse(stdout) : undefined); }
        catch { resolve(undefined); }
      });
      process.stdin?.on('error', () => {});
      process.stdin?.end(JSON.stringify({
        hook_event_name: kind, cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId(),
        tool_name: tool, tool_use_id: id, tool_input: input,
      }));
    });
  }

  pi.registerCommand('focus-code', {
    description: '打开当前工程的 Focus Code 变动记录（/focus-code show）',
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== 'show') {
        ctx.ui.notify('用法：/focus-code show', 'info');
        return;
      }
      try {
        const result = await pi.exec('node', ['--disable-warning=ExperimentalWarning', cli, 'show'], { cwd: ctx.cwd, timeout: 30000 });
        if (result.code !== 0) {
          ctx.ui.notify(result.stderr.trim() || 'Focus Code 无法打开变动记录。', 'warning');
          return;
        }
        ctx.ui.notify(`Focus Code 变动记录 ${result.stdout.trim()}`, 'info');
      } catch (error) {
        ctx.ui.notify(`Focus Code: ${String(error)}`, 'warning');
      }
    },
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const text = (await observe('UserPromptSubmit', ctx))?.hookSpecificOutput?.additionalContext;
    if (text) event.systemPromptOptions.sections.focus_code = text;
    else delete event.systemPromptOptions.sections.focus_code;
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!observed.has(event.toolName)) return;
    calls.add(event.toolCallId);
    await observe('PreToolUse', ctx, event.toolName, event.toolCallId, event.input);
  });
  pi.on('tool_result', async (event, ctx) => {
    if (!calls.delete(event.toolCallId)) return;
    const kind = event.isError ? 'PostToolUseFailure' : 'PostToolUse';
    const feedback = await observe(kind, ctx, event.toolName, event.toolCallId, event.input);
    if (feedback?.systemMessage && ctx.hasUI) ctx.ui.notify(feedback.systemMessage, 'info');
    const text = feedback?.hookSpecificOutput?.additionalContext;
    if (text) return { content: [...event.content, { type: 'text', text }], structuredContent: event.structuredContent };
  });
  pi.on('tool_execution_end', async (event, ctx) => {
    if (calls.delete(event.toolCallId)) await observe('PostToolUse', ctx, event.toolName, event.toolCallId, event.args);
  });
  pi.on('agent_settled', async (_event, ctx) => { await observe('Stop', ctx); });
  pi.on('session_shutdown', async (_event, ctx) => { await observe('SessionEnd', ctx); });
}
