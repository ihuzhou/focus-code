import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { handleEvent } from '../src/agent.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const observed = new Set(['edit', 'write', 'bash', 'powershell', 'apply_patch', 'codemode']);

export default function (pi: ExtensionAPI) {
  const calls = new Set<string>();

  function observe(kind: string, ctx: ExtensionContext, tool?: string, id?: string, input?: unknown) {
    try {
      return handleEvent('pi', {
        hook_event_name: kind, cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId(),
        tool_name: tool, tool_use_id: id, tool_input: input,
      });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Focus Code: ${String(error)}`, 'warning');
    }
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

  pi.on('before_agent_start', (event, ctx) => {
    const text = observe('UserPromptSubmit', ctx)?.hookSpecificOutput?.additionalContext;
    if (text) event.systemPromptOptions.sections.focus_code = text;
    else delete event.systemPromptOptions.sections.focus_code;
  });
  pi.on('tool_call', (event, ctx) => {
    if (!observed.has(event.toolName)) return;
    calls.add(event.toolCallId);
    observe('PreToolUse', ctx, event.toolName, event.toolCallId, event.input);
  });
  pi.on('tool_result', (event, ctx) => {
    if (!calls.delete(event.toolCallId)) return;
    const kind = event.isError ? 'PostToolUseFailure' : 'PostToolUse';
    const feedback = observe(kind, ctx, event.toolName, event.toolCallId, event.input);
    if (feedback?.systemMessage && ctx.hasUI) ctx.ui.notify(feedback.systemMessage, 'info');
    const text = feedback?.hookSpecificOutput?.additionalContext;
    if (text) return { content: [...event.content, { type: 'text', text }], structuredContent: event.structuredContent };
  });
  pi.on('tool_execution_end', (event, ctx) => {
    if (calls.delete(event.toolCallId)) observe('PostToolUse', ctx, event.toolName, event.toolCallId);
  });
  pi.on('agent_settled', (_event, ctx) => { observe('Stop', ctx); });
  pi.on('session_shutdown', (_event, ctx) => { observe('SessionEnd', ctx); });
}
