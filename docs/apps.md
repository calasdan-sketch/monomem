# Which apps setup connects

`monomem setup` looks for the apps below, shows the exact lines it will change, asks before it writes, keeps a backup of
every file it changes, and `monomem setup --undo` puts each file back exactly. Each entry it writes names the app
(`MONOMEM_CLIENT=<app>`), so notes the app saves are labelled with it. To connect one app only: `monomem connect <app>`.

An app that is not installed is left alone, unless you name it with `monomem connect <app>`, which creates its file.

## The apps

| App | `connect` name | File setup changes | Checked against |
|---|---|---|---|
| Claude Code | `claude-code` | `~/.claude.json` (plus hooks in `~/.claude/settings.json`) | Claude Code docs |
| Claude Desktop | `claude-desktop` | `claude_desktop_config.json` in Claude's settings folder | Claude Desktop docs |
| Cursor | `cursor` | `~/.cursor/mcp.json` (plus a start-of-session hook in `~/.cursor/hooks.json`, below) | cursor.com/docs |
| Codex CLI | `codex` | `~/.codex/config.toml` (plus hooks in `~/.codex/hooks.json`) | developers.openai.com/codex |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` | geminicli.com/docs |
| Muse | `muse` | `~/.config/muse/settings.json` | Meta's Muse docs |
| VS Code (and GitHub Copilot in VS Code) | `vscode` | `Code/User/mcp.json` in VS Code's settings folder | code.visualstudio.com/docs |
| Zed | `zed` | Zed's `settings.json` (`context_servers`) | zed.dev/docs |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | docs.devin.ai, "Configuration Import" (Windsurf section) |
| Devin (Desktop and CLI) | `devin` | `~/.config/devin/mcp_config.json`; on Windows `%APPDATA%\devin\mcp_config.json` | docs.devin.ai/cli/extensibility/mcp/configuration |
| Kiro | `kiro` | `~/.kiro/settings/mcp.json` | kiro.dev/docs/mcp/configuration |
| Cline CLI | `cline` | `~/.cline/data/settings/cline_mcp_settings.json` (or `CLINE_MCP_SETTINGS_PATH`) | docs.cline.bot/mcp |
| GitHub Copilot CLI | `copilot-cli` | `~/.copilot/mcp-config.json` (entry `type: "local"`, `tools: ["*"]`) | docs.github.com, "Adding MCP servers for GitHub Copilot CLI" |
| Antigravity | `antigravity` | `~/.gemini/config/mcp_config.json` | antigravity.google/docs/mcp |
| Qwen Code | `qwen` | `~/.qwen/settings.json` | qwenlm.github.io/qwen-code-docs, MCP page |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` (or `.jsonc`), directly under `mcp` (OpenCode 1's place, which OpenCode 2 also reads); a file already in OpenCode 2's own form gets it under `mcp` then `servers`. The command is one list | opencode.ai/docs/config, /docs/mcp-servers and /docs/migrate-v1 (checked 2026-11-17) |
| Kilo Code (VS Code and CLI) | `kilo` | `~/.config/kilo/kilo.jsonc` (or `kilo.json`), under `mcp`; the command is one list, `enabled: true` | kilo.ai/docs, "Using MCP in Kilo Code" |

The last nine were checked against each app's own documentation on 2026-11-17. Apps change where they keep settings;
if one moves its file, setup will not find it until Monomem is updated. `monomem connect <app> --print` shows the
entry to paste by hand in the meantime.

Notes:

- Devin also reads the Windsurf, Cursor and Claude Code files by default. If one of those is connected, Devin already
  has Monomem; connecting Devin as well gives it a second copy of the same server, so pick one.
- Only Claude Code, Cursor and VS Code get a key-based connection written for them (`monomem connect <app> --restricted`).
  For the others, `connect --restricted` prints the block to paste.

## Not connected yet, and why

| App | Why setup does not write it |
|---|---|
| Cline (VS Code extension) | Its settings file is reached only from the Cline panel; the docs do not give its path. Use the panel's "Configure MCP Servers" and paste `monomem connect cline --print`. |
| Roo Code | Same: the global `mcp_settings.json` is opened from the Roo Code panel, and its path is not documented. Its project file `.roo/mcp.json` is per folder. |
| Continue | Its settings are YAML (`config.yaml`, or blocks in `.continue/mcpServers/` per workspace). Setup only edits JSON and TOML, so it does not guess at YAML. |
| Goose | Its settings are YAML too (`goose configure` adds an extension). |
| LM Studio | Its docs say to edit `mcp.json` from the app (Program tab, Install, Edit mcp.json) but do not give the file's path. |
| Amazon Q Developer | Its IDE docs call `~/.aws/amazonq/mcp.json` a legacy file and keep new servers in `default.json`; Kiro replaces the Q CLI. Use Kiro, or paste the entry by hand. |

## Apps installed later

While the server runs (`monomem start`), it looks once a day for these apps. It reads files only and never changes one.

- The first look only records what is already installed (setup and the Welcome screen offered those).
- An app installed after that, and not connected, shows in **Needs you** and in Settings with **Connect** and
  **Not this one**. Not this one hides it for good (you can still connect it from Settings).
- An app whose Monomem entry would not start (the program it names is gone, or it starts another Monomem version)
  shows **Repair**. Repair, like Connect, runs `monomem setup --only <app> --yes`, which keeps the backup and the exact
  undo (`monomem setup --undo`).

The result is kept in `app-detect.json` in the data folder. With the server stopped, nothing is checked; `monomem setup`
finds new apps by itself.

## Cursor: notes at the start of a session

Cursor documents a `sessionStart` hook (cursor.com/docs/hooks): a command in `~/.cursor/hooks.json` whose answer
`{"additional_context": "..."}` is added to the conversation's starting context. When you say yes to the start-of-session
hook, setup adds one:

```json
{ "version": 1, "hooks": { "sessionStart": [{ "command": "<monomem> hook cursor-session-start" }] } }
```

It shows the same recent notes Claude Code gets at session start, for the folder Cursor has open (`workspace_roots`).
Your other hooks stay as they are, and undo takes only this one out. When you move from the npm package to the download,
setup moves this hook to the download too (`monomem check` names a hook that still runs the npm copy). Cursor's other events (prompts, tool calls) are not
wired: Monomem's automatic memory records Claude Code, Codex, Gemini CLI and Muse sessions only. Cursor's cloud agents
do not read `~/.cursor/hooks.json` (Cursor's docs say so), so they get no notes from this hook.

## Claude Code `mcp_tool` hooks: checked, not used yet

Claude Code supports hooks of `type: "mcp_tool"`, which call a tool on an MCP server the session already runs
(code.claude.com/docs/en/hooks, checked 2026-11-17). Its docs also say these hooks are skipped at session launch
(`SessionStart` at startup or resume, and `Setup`), so the start-of-session notes must stay a command hook.

Monomem does not add one in this release. Every mid-session event it uses (prompt, tool use, stop, compaction) already has a
command hook. The only gain from `mcp_tool` would be speed: no new process per event. Getting it needs a hook-only
server tool that takes only hook-shaped input, writes only as capture, and returns nothing private. It also needs a live
check that Claude Code calls a tool that is not in the server's tool list. That work is planned, not done.
