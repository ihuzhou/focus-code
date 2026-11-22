# Focus Code

在浏览器里查看多个 Git 工作树的变动时间线。每条记录包含变动时间、来源、分支、整体修改原因和逐文件 diff。每个文本 diff 代码段都有自己的说明栏。可以搜索文件或说明、按来源筛选，并编辑整体原因或某个代码段的说明。

## 快速开始

环境需要 Node.js 22.13 或更新版本，以及 Git。安装脚本与代理集成面向 macOS 和 Linux。

```sh
npm install -g focus-code
focus-code demo
```

会打开 `http://127.0.0.1:4317/`。演示包含两个临时 Git 工作树，可用顶部下拉框切换。按 `Ctrl+C` 结束服务。

## 接入自己的仓库

启动网页时可以指定要打开的 Git 工程。

```sh
focus-code watch /path/to/repo
```

也可以直接运行 `focus-code watch`，点网页的「添加工程」并填 Git 工作树的绝对路径。打开多个工程后，用顶部下拉框切换。旁边的分支下拉框可选择「所有分支」、当前工程的本地分支，或有历史记录的分支。筛选以每条变动记录保存时的分支为准，包括当前未检出的分支。工程列表会保存在本机，每个工程独立保留历史。服务会扫描启动时打开的工程，以及本次运行中添加或切换到的工程。可用 `--port 4318` 指定端口，或用 `--no-open` 手动打开浏览器。

### 全局安装

Claude Code、Codex、OpenCode、Gemini CLI、Pi、TRAE 桌面端和 TRAE CLI 支持全局安装。选择对应命令运行一次，随后重启客户端。

| 客户端 | 安装命令 | 默认配置位置 |
| --- | --- | --- |
| Claude Code | `focus-code install claude --global` | `~/.claude/settings.json` |
| Codex | `focus-code install codex --global` | `~/.codex/hooks.json`，在 `/hooks` 审阅并信任 Focus Code |
| OpenCode | `focus-code install opencode --global` | `~/.config/opencode/plugins/focus-code.js` |
| Gemini CLI | `focus-code install gemini --global` | `~/.gemini/settings.json` |
| Pi | `focus-code install pi --global` | `~/.pi/agent/extensions/focus-code.ts` |
| TRAE 桌面端 | `focus-code install trae --global` | `~/.trae/hooks.json`，已存在 `~/.trae-cn` 时也会写入该目录的 `hooks.json` |
| TRAE CLI | `focus-code install trae-cli --global` | 通过 `traex`、`traecli` 或 `trae-cli` 的插件命令安装 `focus-code@focus-code-local` |

安装器识别 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`OPENCODE_CONFIG_DIR`、`XDG_CONFIG_HOME`、`GEMINI_CLI_HOME` 和 `PI_CODING_AGENT_DIR`。在本地 Git 工作树中使用任一已接入的客户端，首次捕获到修改时，该工程会自动出现在 Focus Code 的顶部列表。网页关闭期间，插件也会把变动和代理提交的原因写入本机历史。运行 `focus-code watch` 即可查看。使用 Claude Code 或 Gemini CLI 打开新工程时，按客户端提示信任该工程。

#### 在客户端里打开记录页

安装或升级后启动一个新会话。Codex 需要先在 `/hooks` 审阅并信任 Focus Code。首次记录到一个会话在该工程的修改时，客户端会提示对应命令。

| 客户端 | 打开当前工程的时间线 |
| --- | --- |
| Claude Code | `/focus-code show` |
| Pi | `/focus-code show` |
| Codex | `$focus-code show`，作为单独一条消息发送 |

命令由本地扩展或 hook 执行。已有本机记录服务时会复用它，服务未运行时会启动一个。终端也可以用 `focus-code show /path/to/repo` 打开指定工程。

#### TRAE 启用步骤

- **桌面端**在「设置 → 钩子（Hooks）」选择「全局」，打开「已配置的钩子」，并选择「自动在本地运行」，让 hook 能写入 Focus Code 本机历史。按工程安装时选择「项目」配置。
- **TRAE CLI**需要支持插件和 `/hooks` 的 `traex` 或 `traecli` 版本。安装后在终端会话里打开 `/hooks` 审阅并信任 Focus Code。可设置 `TRAECLI_BIN` 指定 CLI 可执行文件。卸载使用客户端的插件管理命令移除 `focus-code@focus-code-local`。

### 按工程安装

下表中的集成支持按工程安装。将 `/path/to/repo` 换成代理实际运行的 Git 工作树。

| 客户端 | 安装命令 | 启用方式 |
| --- | --- | --- |
| Claude Code | `focus-code install claude /path/to/repo` | 重新启动 Claude Code，让它读取目标工程的 `.claude/settings.local.json`。 |
| Codex | `focus-code install codex /path/to/repo` | 在受信任的工程里启动 Codex CLI，运行 `/hooks`，审阅并启用 `.codex/hooks.json` 中的 Focus Code hooks。 |
| Pi | `focus-code install pi /path/to/repo` | 重新启动 Pi，使用项目扩展信任提示加载 `.pi/extensions/focus-code.ts`。 |
| OpenCode | `focus-code install opencode /path/to/repo` | 重新启动 OpenCode，加载 `.opencode/plugins/focus-code.js`。 |
| Gemini CLI | `focus-code install gemini /path/to/repo` | 重新启动 Gemini CLI，在受信任的工程里加载 `.gemini/settings.json`。 |
| TRAE 桌面端 | `focus-code install trae /path/to/repo` | 在「设置 → 钩子」中启用「项目」配置，读取 `.trae/hooks.json`。 |

`focus-code install all /path/to/repo` 会为同一个工作树安装表里的全部集成。

安装器将 hook 合并到已有的 JSON 设置中。生成的配置引用本机 Focus Code 和 Node 的绝对路径。移动 Focus Code 后，重新安装并清理旧路径的 hook 条目。卸载时，在相应设置文件的 `hooks` 中删除调用 `src/cli.js hook` 的 Focus Code 条目，或删除生成的 Pi 或 OpenCode 扩展入口。

## 记录方式

- 第一次扫描把当前工作树作为基线。之后按快照差记录新增、修改、删除和可执行位变化，含 Git 已跟踪文件和非忽略的未跟踪文件。服务运行期间约每 1.5 秒扫描一次，也能记录手动保存。Agent hooks 可以在 GUI 关闭时持续记录工具边界上的变化。
- 代理可以用 `: # focus-reason: 这里写变动原因` 提交本次修改的整体原因。记录保存后，hook 会把代码段的定位发回代理。代理可逐段提交具体目的，例如 `: # focus-explain: {"change":42,"notes":[[0,0,"校验输入以防止空值进入缓存"]]}`。`notes` 的每一项包含文件序号、代码段序号和说明，两个序号都从 0 开始，由 hook 提供。
- 逐段说明显示在对应的 diff 上方，来源为「代理说明」「手动填写」或「差异摘要」。摘要由实际增删内容生成，只描述改了什么。旧记录、手动改动和代理未提交原因的代码段也会显示摘要。点击「补写原因」即可记录该段的目的，手动填写优先于后续代理提交。
- 同一会话的重叠工具调用合为一条记录。不同会话的工具调用重叠时，记录显示「来源不明」。在同一采样窗口内写入同一工作树的外部操作也可能被合并。未接入的工具或编辑器变动依靠工作区扫描。两次采样之间被覆盖或撤销的中间状态可能无法捕获。
- Claude Code、OpenCode、Gemini CLI 和 TRAE 的内置文件编辑工具按目标文件所在的 Git 工作树归档。Shell 命令按 hook 工作目录或工具显式指定的工作目录采样。如果一条命令写入另一个工作树，需要让 Focus Code 另行监测那个工作树才能捕获该变动。
- 二进制文件和大于 256 KiB 的文件在时间线中展示元数据。每个 Git worktree 有独立记录。
- 快照、diff 和原因保存于 `~/.local/state/focus-code/`，可用 `XDG_STATE_HOME` 或 `FOCUS_HOME` 改位置。更改路径时，GUI 和代理会话需要使用相同的环境变量。变动历史保存在本机 SQLite 中，GUI 只监听 `127.0.0.1`。

## 源码开发

在源码目录运行 `npm ci` 安装依赖，`npm test` 验证记录、归因、安装器及 HTTP 接口。可运行 `npm run demo` 查看演示，或用 `node src/cli.js` 调用其他命令。
