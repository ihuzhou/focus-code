# Focus Code

[简体中文](./README.md) · **English**

Focus Code is a **code change review plugin for coding agents**. See which files your agent touched, exactly how each section changed, and the reasons it recorded, all in a local browser view.

## Quick start

```sh
npm install -g focus-code
focus-code install claude --global
focus-code show /path/to/repo
```

Replace `claude` with the client you use. Supported client names include `codex`, `pi`, `opencode`, `gemini`, `trae`, and `trae-cli`. Restart your client after installation. In Codex, use `/hooks` to review and trust the Focus Code hooks before using the integration.

To open the current project's history from **Claude Code or Pi**, enter `/focus-code show`. In **Codex**, send `$focus-code show` as its own message. Run `focus-code demo` to try the interface with sample changes.

Requires Node.js 22.13+ and Git on macOS or Linux. The terminal prints the browser address.

## Review code changes

- Follow agent edits in chronological order. Switch projects, branches, or sources, and search file paths and explanations.
- Inspect the actual line-by-line diff and toggle its surrounding context.
- Read the overall reason and the agent's explanation for each changed section. When a section has no explanation, Focus Code summarizes the added and removed lines. You can add your own note alongside the diff.

Your change history is stored locally.

## Browser and project settings

Run `focus-code show` from a Git project or pass a Git worktree path to open it directly. You can also run `focus-code watch` and use **添加工程** (Add project) in the browser to enter the absolute path to a Git worktree. Each worktree has its own history.

| Control | Options | Default and behavior |
| --- | --- | --- |
| **监测设置** (Tracking settings) → **全局默认** (Global default) | On or off | On. Applies to every project that inherits the global default, including newly discovered projects. |
| **监测设置** → Current project | Inherit the global default, always on, or always off | Inherit. A project override takes precedence over the global default and is stored by Git worktree root. |
| Project and branch selectors | Choose a project and all branches or a single branch | All branches. Records are filtered by the branch at capture time. The list includes local branches and branches with saved history. |
| Timeline source and search | Filter by client or workspace changes. Search file paths, reasons, or explanations. | All sources and an empty search query. These options work with the branch filter. |
| Diff context | Show or hide unchanged lines around a changed section | Shown by default. |

- To exclude one project, keep tracking on globally and set that project to always off.
- To track only selected projects, turn tracking off globally and set each chosen project to always on.

Pausing tracking also pauses workspace scanning and agent prompts for explanations. Existing history remains available for browsing, searching, and manual edits. Resuming uses the current files as a new baseline and records subsequent edits. Settings apply to the viewer and agents using the same data directory. Use the live viewer to change them.

## Command-line options

| Command | Options | Behavior |
| --- | --- | --- |
| `focus-code watch [repository]` | `--port <port>`, `--no-open` | Starts the tracking service and browser view. Without a path, it opens the current Git worktree when available. |
| `focus-code demo` | `--port <port>`, `--no-open` | Starts a viewer with sample changes. |
| `focus-code show [repository]` | `--no-open` | Opens the current or specified project's history. Reuses a running viewer for the same data directory or starts one on demand. |
| `focus-code install <client> --global` | `--global` | Installs the integration for the current user. Restart the client afterward. |
| `focus-code install <client> <repository>` | Git worktree path | Installs only for that project. Use `all` to install every supported project-level integration. |

`watch` and `demo` try `4317` first, then `4318`, then ask the OS for a free port. `--port 0` asks the OS for a free port immediately. Use `--port <1–65535>` to specify an addressable port. If your chosen port is in use, choose another port or omit the option for automatic selection. The viewer binds to `127.0.0.1` and prints its actual address. Use `--no-open` to start the service or print its link without launching a browser.

```sh
focus-code watch /path/to/repo --port 4500
focus-code watch --port 0 --no-open
focus-code show /path/to/repo --no-open
```

With neither `--global` nor a repository path, Claude Code, OpenCode, Gemini CLI, and TRAE Desktop install for the current user. Codex, Pi, and `all` use the current Git worktree. TRAE CLI uses a user-level plugin installation.

## Environment variables and data directory

| Variable | Used for | Default and precedence |
| --- | --- | --- |
| `FOCUS_HOME` | Full path to the Focus Code data directory | Takes precedence over `XDG_STATE_HOME`. |
| `XDG_STATE_HOME` | System state directory | With no `FOCUS_HOME`, uses `$XDG_STATE_HOME/focus-code`. With neither variable, uses `~/.local/state/focus-code/`. |
| `CLAUDE_CONFIG_DIR` | Claude Code user configuration | Defaults to `~/.claude`. Installs hooks in `settings.json` and the skill in `skills/focus-code/SKILL.md`. |
| `CODEX_HOME` | Codex user configuration | Defaults to `~/.codex`. Global hooks are installed in `hooks.json`. The viewer skill is installed in `~/.agents/skills/focus-code/`. |
| `PI_CODING_AGENT_DIR` | Pi user configuration | Defaults to `~/.pi/agent`. The global extension is installed in `extensions/focus-code.ts`. |
| `OPENCODE_CONFIG_DIR` | OpenCode user configuration | Takes precedence over `XDG_CONFIG_HOME`. The plugin is installed in `plugins/focus-code.js`. |
| `XDG_CONFIG_HOME` | System configuration directory for OpenCode | With no `OPENCODE_CONFIG_DIR`, uses `$XDG_CONFIG_HOME/opencode`. With neither variable, uses `~/.config/opencode`. |
| `GEMINI_CLI_HOME` | Home directory used by Gemini CLI | Defaults to `~`. The global integration is installed in `.gemini/settings.json` under that directory. |
| `TRAECLI_BIN` | TRAE CLI executable, as a path or command name | Searches `PATH` for `traex`, then `traecli`, then `trae-cli` by default. |
| `TRAE_PROJECT_DIR` | TRAE project directory | Provided by TRAE and used when the hook does not provide a working directory. |

The viewer, agent process, and hooks need the same `FOCUS_HOME` or `XDG_STATE_HOME` setting. Each data directory has its own project list and history.

```sh
export FOCUS_HOME="$HOME/.local/state/focus-code-work"
focus-code watch /path/to/repo --no-open
```

| Entry in the data directory | Contents |
| --- | --- |
| `projects.sqlite` | Discovered projects and the local viewer address. |
| `tracking.sqlite` | Global tracking default and per-project overrides. |
| `<worktree-path-hash>/journal.sqlite` | File snapshots, diffs, reasons, and section-level explanations. |
| `integrations/trae-cli/` | Local plugin and marketplace files for TRAE CLI. |

## Client integrations

### Global installation

Run the command for your client once, then restart the client.

| Client | Installation | Default configuration path |
| --- | --- | --- |
| Claude Code | `focus-code install claude --global` | `~/.claude/settings.json` and `~/.claude/skills/focus-code/SKILL.md` |
| Codex | `focus-code install codex --global` | `~/.codex/hooks.json`. Review and trust the hooks in `/hooks`. |
| OpenCode | `focus-code install opencode --global` | `~/.config/opencode/plugins/focus-code.js` |
| Gemini CLI | `focus-code install gemini --global` | `~/.gemini/settings.json` |
| Pi | `focus-code install pi --global` | `~/.pi/agent/extensions/focus-code.ts` |
| TRAE Desktop | `focus-code install trae --global` | `~/.trae/hooks.json` and `~/.trae-cn/hooks.json` when `~/.trae-cn` exists |
| TRAE CLI | `focus-code install trae-cli --global` | Installs `focus-code@focus-code-local` through the TRAE CLI plugin manager. |

A worktree appears in the viewer after the integration captures its first change. Hooks can record edits and explanations while the viewer is closed. Follow your client's trust prompts when opening a new workspace in Claude Code or Gemini CLI.

### TRAE setup

- **Desktop**. In **Settings → Hooks**, select **Global**, enable **Configured Hooks**, and select **Run Automatically Locally** to allow hooks to write the local history. Select **Project** for a project-level installation.
- **CLI**. Use a `traex` or `traecli` version that supports plugins and `/hooks`. Review and trust Focus Code in `/hooks` after installation. You can set `TRAECLI_BIN` to point to your executable. Use the client plugin manager to uninstall `focus-code@focus-code-local`.

### Project-level installation

Replace `/path/to/repo` with the Git worktree your agent uses.

| Client | Installation | Project configuration |
| --- | --- | --- |
| Claude Code | `focus-code install claude /path/to/repo` | `.claude/settings.local.json` and `.claude/skills/focus-code/SKILL.md` |
| Codex | `focus-code install codex /path/to/repo` | `.codex/hooks.json`. Review and trust the hooks in `/hooks`. |
| Pi | `focus-code install pi /path/to/repo` | `.pi/extensions/focus-code.ts`. Follow Pi's project extension trust prompts. |
| OpenCode | `focus-code install opencode /path/to/repo` | `.opencode/plugins/focus-code.js` |
| Gemini CLI | `focus-code install gemini /path/to/repo` | `.gemini/settings.json` in a trusted worktree. |
| TRAE Desktop | `focus-code install trae /path/to/repo` | `.trae/hooks.json`. Enable the project hook configuration in **Settings → Hooks**. |

`focus-code install all /path/to/repo` installs all integrations listed in this table for that worktree.

### Upgrade and uninstall

Run `npm install -g focus-code@latest` to upgrade an npm installation. Restart the viewer and any active clients to load the new code. The installer merges existing JSON settings and can be run again. If Focus Code or Node moves to a different path, rerun the relevant installer and remove any Focus Code hooks that reference the previous path.

To remove an integration, remove the Focus Code hook entries that invoke `src/cli.js hook` and any generated Claude Code or Codex `focus-code` skill directories. For Pi or OpenCode, remove the generated extension entry. Use the TRAE CLI plugin manager for that client. Run `npm uninstall -g focus-code` to remove the command-line package. The data directory retains its history.

## How changes are recorded

- The first scan captures a worktree baseline. Later scans record changes to Git-tracked and non-ignored files, including executable-bit changes. The viewer polls open worktrees about every 1.5 seconds, so it can record manual saves as well as agent edits.
- The agent can submit a reason with `: # focus-reason: explain the goal of this edit`. After a captured edit, the hook gives the agent the changed section IDs. An agent can explain sections with `: # focus-explain: {"change":42,"notes":[[0,0,"Validate the input before it reaches the cache"]]}`. Each note contains the zero-based file index, zero-based section index, and explanation.
- Each diff section shows an agent explanation, a manual entry, or a summary generated from its added and removed lines. A manual entry takes precedence over later agent submissions.
- Overlapping tools in one session are grouped. Edits made by overlapping sessions are shown with an unknown source. Multiple changes inside a sampling interval can be grouped, and transient changes can be missed between samples.
- Built-in file edits in Claude Code, OpenCode, Gemini CLI, and TRAE are recorded in the worktree containing the edited file. Shell commands are tracked from the hook's working directory or the tool's explicit working directory. A shell command writing to another worktree requires that worktree to be monitored separately to capture the edit.
- Binary files and files larger than 256 KiB are recorded as metadata. Local SQLite databases hold the tracking state and history.

## Development

Run `npm ci` to install dependencies, `npm test` to test repository tracking and the viewer API, or `npm run demo` to start the demo from source. Use `node src/cli.js` for other commands from the source tree.
