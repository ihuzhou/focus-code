import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const observed = new Set(['bash', 'edit', 'write', 'apply_patch', 'multiedit', 'batch']);

export async function createOpenCodePlugin({ directory, client }, node) {
  function observe(kind, session, tool, call, args) {
    return new Promise(resolve => {
      const command = execFile(node, ['--disable-warning=ExperimentalWarning', cli, 'hook', 'opencode'], {
        cwd: directory, timeout: 15000, maxBuffer: 64 * 1024,
      }, (error, stdout, stderr) => {
        if (error || stderr.trim()) {
          void client?.app?.log?.({ body: { service: 'focus-code', level: 'warn', message: stderr.trim() || error.message } })?.catch(() => {});
        }
        try { resolve(JSON.parse(stdout).hookSpecificOutput?.additionalContext); }
        catch { resolve(undefined); }
      });
      command.stdin?.on('error', () => {});
      command.stdin?.end(JSON.stringify({
        cwd: directory, hook_event_name: kind, session_id: session, tool_name: tool, tool_use_id: call, tool_input: args,
      }));
    });
  }

  const sessions = new Map();
  let previousGuidance;
  return {
    'experimental.chat.system.transform': async (input, output) => {
      const guidance = await observe('UserPromptSubmit', input.sessionID ?? 'focus-code-plugin');
      if (guidance) {
        previousGuidance = guidance;
        if (!output.system.includes(guidance)) output.system.push(guidance);
      } else if (previousGuidance) {
        output.system = output.system.filter(text => text !== previousGuidance);
      }
    },
    'tool.execute.before': async (input, output) => {
      if (!observed.has(input.tool)) return;
      if (!sessions.has(input.sessionID)) sessions.set(input.sessionID, new Map());
      sessions.get(input.sessionID).set(input.callID, output.args);
      await observe('PreToolUse', input.sessionID, input.tool, input.callID, output.args);
    },
    'tool.execute.after': async (input, output) => {
      if (!observed.has(input.tool)) return;
      const calls = sessions.get(input.sessionID);
      const args = input.args ?? calls?.get(input.callID);
      if (!calls?.delete(input.callID)) return;
      const text = await observe('PostToolUse', input.sessionID, input.tool, input.callID, args);
      if (text) output.output += `\n\n${text}`;
    },
    event: async ({ event }) => {
      if (event.type === 'message.part.updated') {
        const { part } = event.properties;
        if (part.type === 'tool' && part.state.status === 'error' && sessions.get(part.sessionID)?.delete(part.callID)) {
          await observe('PostToolUseFailure', part.sessionID, part.tool, part.callID, part.state.input);
        }
      }
      const session = event.properties?.sessionID;
      if (event.type === 'session.idle' || (event.type === 'session.status' && event.properties.status?.type === 'idle')) {
        if (sessions.delete(session)) await observe('Stop', session);
      }
    },
  };
}
